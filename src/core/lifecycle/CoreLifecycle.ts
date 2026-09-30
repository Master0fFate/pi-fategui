export interface CoreClientResources {
  /** Transport-owned subscriptions only. A client cannot own the core. */
  readonly disposeSubscriptions?: () => void | Promise<void>;
  /** Transport-issued control leases only. */
  readonly releaseControlLeases?: () => void | Promise<void>;
  /** Temporary client-side snapshot/capture state only. */
  readonly disposeSnapshots?: () => void | Promise<void>;
  /** Terminals created exclusively for this client. */
  readonly disposeTerminals?: () => void | Promise<void>;
}

export interface CoreClient {
  readonly id: symbol;
}

export type CoreShutdownResult =
  | { readonly status: 'settled' }
  | { readonly status: 'incomplete'; readonly reason: 'timeout' | 'failed' };

export interface CoreLifecycleOptions {
  /** A finite host grace period. The process owner decides what to do on an incomplete result. */
  readonly shutdownBudgetMs?: number;
  /** Synchronous fence: reject new admissions before any async cleanup begins. */
  readonly beginShutdown: () => void;
  /** Requests cancellation, waits for true settlement, then flushes authoritative state. */
  readonly shutdown: () => Promise<void>;
}

const DEFAULT_SHUTDOWN_BUDGET_MS = 4_000;

/**
 * Owns only the distinction between a transport client and the host core.
 * Client cleanup never observes or changes core ownership. Core shutdown is
 * fenced first, bounded for the caller, and never fabricates settlement.
 */
export class CoreLifecycle {
  private readonly clients = new Map<CoreClient, { resources: CoreClientResources; cleanup: Promise<void> | null }>();
  private readonly shutdownBudgetMs: number;
  private shutdownResult: Promise<CoreShutdownResult> | null = null;
  private shutdownSettlement: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly options: CoreLifecycleOptions) {
    this.shutdownBudgetMs = options.shutdownBudgetMs ?? DEFAULT_SHUTDOWN_BUDGET_MS;
    if (!Number.isSafeInteger(this.shutdownBudgetMs) || this.shutdownBudgetMs < 1 || this.shutdownBudgetMs > 60_000) {
      throw new Error('A finite core shutdown budget between 1ms and 60s is required.');
    }
  }

  get isStopping(): boolean { return this.stopping; }

  /** Register client-owned resources. The returned opaque handle grants no core authority. */
  createClient(resources: CoreClientResources = {}): CoreClient {
    const client = Object.freeze({ id: Symbol('fate-client') });
    if (this.stopping) throw new Error('The core is shutting down; new clients are not admitted.');
    this.clients.set(client, { resources, cleanup: null });
    return client;
  }

  /** Idempotently discard only the named client's transport state. */
  disposeClient(client: CoreClient): Promise<void> {
    const entry = this.clients.get(client);
    if (!entry) return Promise.resolve();
    if (!entry.cleanup) {
      entry.cleanup = this.runClientCleanup(entry.resources);
      void entry.cleanup.then(() => this.clients.delete(client), () => undefined);
    }
    return entry.cleanup;
  }

  /** Host admission points call this before beginning a new mutation or continuation. */
  assertAdmission(): void {
    if (this.stopping) throw new Error('The core is shutting down; new admissions are closed.');
  }

  /**
   * Starts exactly one shutdown. An incomplete result means the caller's grace
   * period ended or cleanup failed; it is deliberately not a clean shutdown.
   */
  shutdownCore(): Promise<CoreShutdownResult> {
    if (this.shutdownResult) return this.shutdownResult;
    this.stopping = true;
    let fenceFailed = false;
    let fenceFailure: unknown;
    try { this.options.beginShutdown(); } catch (error) { fenceFailed = true; fenceFailure = error; }
    // A failing fence is not a reason to abandon cancellation. Retain its
    // failure in the final result even if subsequent cleanup succeeds.
    this.shutdownSettlement = Promise.resolve().then(async () => {
      const clients = [...this.clients.keys()].map((client) => this.disposeClient(client));
      const results = await Promise.allSettled([Promise.resolve().then(() => this.options.shutdown()), ...clients]);
      const failures = [...(fenceFailed ? [fenceFailure] : []),
        ...results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])];
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Core or client shutdown was incomplete.');
    });
    void this.shutdownSettlement.catch(() => undefined);
    this.shutdownResult = this.awaitBudget(this.shutdownSettlement);
    return this.shutdownResult;
  }

  /** Actual cleanup, which can outlive the graceful wait budget. */
  settled(): Promise<void> | null { return this.shutdownSettlement; }

  private async runClientCleanup(resources: CoreClientResources): Promise<void> {
    // Invoke each callback separately: a synchronous throw must not skip the others.
    const callbacks = [
      () => resources.disposeSubscriptions?.(), () => resources.releaseControlLeases?.(),
      () => resources.disposeSnapshots?.(), () => resources.disposeTerminals?.(),
    ];
    const results = await Promise.allSettled(callbacks.map(async (invoke) => invoke()));
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Client cleanup was incomplete.');
  }

  private async awaitBudget(settlement: Promise<void>): Promise<CoreShutdownResult> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        settlement.then((): CoreShutdownResult => ({ status: 'settled' }), (): CoreShutdownResult => ({ status: 'incomplete', reason: 'failed' })),
        new Promise<CoreShutdownResult>((resolve) => {
          timer = setTimeout(() => resolve({ status: 'incomplete', reason: 'timeout' }), this.shutdownBudgetMs);
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}
