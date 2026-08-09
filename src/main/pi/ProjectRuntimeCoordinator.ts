/**
 * Project-scoped runtime lifecycle coordinator for multi-folder Pi work.
 *
 * Owns one runtime context per open project, tracks the focused project, and
 * evicts idle contexts so background folders do not hold resources forever.
 *
 * Deliberately framework-agnostic: it knows nothing about the Pi SDK, Electron,
 * or React. All runtime creation/disposal and "is it busy" decisions are
 * injected, so the lifecycle rules (focus, idle eviction, concurrency cap) are
 * unit-testable without a live agent process. The main process wires the real
 * {@link PiRuntimeService} factory/disposer in via the hooks.
 */
export interface ProjectContext<R> {
  readonly projectPath: string;
  readonly projectName: string;
  readonly runtime: R;
  /** Epoch ms of the last user-driven or stream-driven activity. */
  lastActiveAt: number;
  /** Epoch ms when this context first became idle, or null while active. */
  idleSince: number | null;
}

export interface ProjectRuntimeCoordinatorHooks<R> {
  /** Create (or resurrect) a runtime bound to a project. Must be idempotent-safe per path. */
  createRuntime: (projectPath: string, projectName: string) => Promise<R>;
  /** Tear down a runtime and release its resources. */
  disposeRuntime: (runtime: R) => Promise<void>;
  /** True while the runtime has active work (streaming, subagents, goalmax). Idle eviction never disposes a busy runtime. */
  isBusy: (runtime: R) => boolean;
  /** Optional notification when a context is evicted (e.g. to drop renderer-side cached state). */
  onEvicted?: (projectPath: string) => void;
}

export interface ProjectRuntimeCoordinatorOptions {
  /** Idle grace period before an unfocused, non-busy context is evicted. Default 5 minutes. */
  idleTimeoutMs?: number;
  /** How often the idle sweep runs. Default 60 seconds. */
  sweepIntervalMs?: number;
  /** Hard cap on simultaneously live projects; oldest idle is evicted when exceeded. Default 8. */
  maxConcurrent?: number;
  /** Injected clock for deterministic tests. */
  now?: () => number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_MAX_CONCURRENT = 8;

/**
 * Coordinates live per-project runtimes. Thread-safe by contract: the main
 * process drives all calls from its single-writer IPC/event loop, so no internal
 * locking is required.
 */
export class ProjectRuntimeCoordinator<R> {
  private readonly entries = new Map<string, ProjectContext<R>>();
  private readonly order: string[] = []; // least-recently-touched first
  private focusedPath: string | null = null;
  private sweepHandle: ReturnType<typeof setInterval> | null = null;
  private readonly idleTimeoutMs: number;
  private readonly sweepIntervalMs: number;
  private readonly maxConcurrent: number;
  private readonly now: () => number;
  private readonly pendingAcquires = new Map<string, Promise<ProjectContext<R>>>();
  private readonly pendingCloses = new Map<string, Promise<void>>();
  private stopping = false;

  constructor(
    private readonly hooks: ProjectRuntimeCoordinatorHooks<R>,
    options: ProjectRuntimeCoordinatorOptions = {},
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.now = options.now ?? (() => Date.now());
  }

  /** Number of currently live project contexts. */
  get size(): number {
    return this.entries.size;
  }

  /** The currently focused project path, or null when nothing is focused. */
  get focusedProjectPath(): string | null {
    return this.focusedPath;
  }

  has(projectPath: string): boolean {
    return this.entries.has(projectPath);
  }

  /** Iterate every live context in least-recently-touched order. */
  forEach(handler: (projectPath: string, runtime: R) => void): void {
    for (const path of this.order) {
      const entry = this.entries.get(path);
      if (entry) handler(path, entry.runtime);
    }
  }

  get(projectPath: string): ProjectContext<R> | undefined {
    return this.entries.get(projectPath);
  }

  getFocused(): ProjectContext<R> | null {
    return this.focusedPath ? this.entries.get(this.focusedPath) ?? null : null;
  }

  /**
   * Ensure a live context exists for the project, mark it active, and focus it.
   * Returns the context. Reuses an existing context without recreating it.
   */
  async acquire(project: { path: string; name: string }): Promise<ProjectContext<R>> {
    if (this.stopping) throw new Error('Cannot acquire a project runtime while the coordinator is stopping.');
    const closing = this.pendingCloses.get(project.path);
    if (closing) await closing;
    if (this.stopping) throw new Error('Cannot acquire a project runtime while the coordinator is stopping.');
    const existing = this.entries.get(project.path);
    if (existing) {
      this.touch(project.path);
      this.focus(project.path);
      return existing;
    }
    const pending = this.pendingAcquires.get(project.path);
    if (pending) return pending;
    const acquisition = this.acquireFresh(project);
    this.pendingAcquires.set(project.path, acquisition);
    try {
      return await acquisition;
    } finally {
      if (this.pendingAcquires.get(project.path) === acquisition) this.pendingAcquires.delete(project.path);
    }
  }

  private async acquireFresh(project: { path: string; name: string }): Promise<ProjectContext<R>> {
    for (;;) {
      const inFlight = [...this.pendingAcquires.entries()]
        .filter(([path]) => path !== project.path)
        .map(([, pending]) => pending);
      if (this.entries.size + inFlight.length < this.maxConcurrent) break;
      const victim = this.order.find((path) => {
        if (path === this.focusedPath) return false;
        const entry = this.entries.get(path);
        return entry ? !this.hooks.isBusy(entry.runtime) : false;
      });
      if (victim !== undefined) {
        await this.close(victim);
        continue;
      }
      if (inFlight.length > 0) {
        await Promise.race(inFlight.map((pending) => pending.catch(() => undefined)));
        continue;
      }
      throw new Error(`Cannot open project ${project.path}: all ${this.maxConcurrent} runtime slots are busy or focused.`);
    }
    if (this.stopping) throw new Error('Cannot acquire a project runtime while the coordinator is stopping.');
    const runtime = await this.hooks.createRuntime(project.path, project.name);
    const now = this.now();
    const entry: ProjectContext<R> = {
      projectPath: project.path,
      projectName: project.name,
      runtime,
      lastActiveAt: now,
      idleSince: null,
    };
    this.entries.set(project.path, entry);
    this.order.push(project.path);
    this.focus(project.path);
    return entry;
  }

  /** Set the focused project. No-op if the project is not live. */
  focus(projectPath: string): void {
    if (this.entries.has(projectPath)) {
      this.focusedPath = projectPath;
      this.touch(projectPath);
    }
  }

  clearFocus(): void {
    this.focusedPath = null;
  }

  /** Mark a project's context as active now (called on any user/stream activity). Resets idle. */
  touch(projectPath: string): void {
    const entry = this.entries.get(projectPath);
    if (!entry) return;
    const now = this.now();
    entry.lastActiveAt = now;
    entry.idleSince = null;
    const index = this.order.indexOf(projectPath);
    if (index >= 0) this.order.splice(index, 1);
    this.order.push(projectPath);
  }

  /** Explicitly close and dispose a project's context (e.g. user "forgets" the folder). */
  async close(projectPath: string): Promise<void> {
    const existing = this.pendingCloses.get(projectPath);
    if (existing) return existing;
    const closing = this.closeOnce(projectPath);
    this.pendingCloses.set(projectPath, closing);
    try {
      await closing;
    } finally {
      if (this.pendingCloses.get(projectPath) === closing) this.pendingCloses.delete(projectPath);
    }
  }

  private async closeOnce(projectPath: string): Promise<void> {
    const pending = this.pendingAcquires.get(projectPath);
    if (pending) {
      try { await pending; } catch { return; }
    }
    await this.evict(projectPath);
    if (this.focusedPath === projectPath) this.focusedPath = null;
  }

  /** Begin the periodic idle sweep. Safe to call once at app start. */
  start(): void {
    if (this.sweepHandle !== null) return;
    this.sweepHandle = setInterval(() => {
      void this.sweepOnce().catch(() => undefined);
    }, this.sweepIntervalMs);
    // Node timers keep the process alive; unref so tests/quit don't hang on it.
    this.sweepHandle.unref?.();
  }

  /** Stop the sweep and dispose every live context. Use at shutdown. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.sweepHandle !== null) {
      clearInterval(this.sweepHandle);
      this.sweepHandle = null;
    }
    await Promise.allSettled([...this.pendingAcquires.values()]);
    await Promise.allSettled([...this.pendingCloses.values()]);
    const paths = [...this.entries.keys()];
    const results = await Promise.allSettled(paths.map((path) => this.close(path)));
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (this.entries.size === 0) this.focusedPath = null;
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Project runtime shutdown was incomplete.');
  }

  /**
   * One idle-eviction pass. Evicts contexts that are: not focused, not busy, and
   * idle for longer than the grace period. Also enforces the concurrency cap by
   * evicting the least-recently-touched non-busy, non-focused contexts.
   * Exposed for tests and on-demand reclamation.
   */
  async sweepOnce(): Promise<void> {
    const now = this.now();
    // 1. Time-based eviction.
    for (const path of [...this.entries.keys()]) {
      if (path === this.focusedPath) continue;
      const entry = this.entries.get(path);
      if (!entry) continue;
      if (this.hooks.isBusy(entry.runtime)) {
        entry.idleSince = null;
        continue;
      }
      if (entry.idleSince === null) entry.idleSince = entry.lastActiveAt;
      if (now - entry.idleSince >= this.idleTimeoutMs) await this.close(path);
    }
    // 2. Concurrency cap: evict oldest non-busy, non-focused contexts.
    while (this.entries.size > this.maxConcurrent) {
      const victim = this.order.find((path) => {
        if (path === this.focusedPath) return false;
        const entry = this.entries.get(path);
        return entry ? !this.hooks.isBusy(entry.runtime) : false;
      });
      if (victim === undefined) break;
      await this.close(victim);
    }
  }

  private async evict(projectPath: string): Promise<void> {
    const entry = this.entries.get(projectPath);
    if (!entry) return;
    // Keep the entry until disposal succeeds. A failed teardown remains
    // retryable and, importantly, cannot leave focus/sink wiring pointing at a
    // context that has already disappeared from the coordinator.
    await this.hooks.disposeRuntime(entry.runtime);
    this.entries.delete(projectPath);
    const index = this.order.indexOf(projectPath);
    if (index >= 0) this.order.splice(index, 1);
    if (this.focusedPath === projectPath) this.focusedPath = null;
    this.hooks.onEvicted?.(projectPath);
  }
}
