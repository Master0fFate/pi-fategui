import { DurableStorageCloseUncertainError } from '../../../core/durable/OwnedDurableStorage';
import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc, ROOT_CONVERSATION_ID, type Cursor, type DocumentId, type Harness, type JsonObject, type Storage, type ToolExecutionApi } from '@earendil-works/pi-durable';

/** Policy evidence, not a second task scheduler. Native Pi owns every task and receipt. */
export type NativeExecutionFenceState = {
  state: 'idle' | 'active' | 'UNKNOWN';
  reason?: string;
  taskIds?: number[];
  submissionIds?: number[];
};
export const NativeExecutionFenceDoc = defineDoc<NativeExecutionFenceState>({
  kind: 'fate.execution.fence', scope: 'session', version: 1, initial: () => ({ state: 'idle' }),
});

export class NativeExecutionUnknownError extends Error {
  readonly code = 'NATIVE_EXECUTION_UNKNOWN';
  constructor(message = 'The previous native execution has an unknown outcome. Review its evidence and submit an explicitly reviewed new request in a new session.') {
    super(message);
    this.name = 'NativeExecutionUnknownError';
  }
}

/** Only trusted host policy may use this before entering an effectful implementation. */
export class NativeEffectNotStartedError extends Error {
  readonly code = 'NATIVE_EFFECT_NOT_STARTED';
  constructor(message: string) { super(message); this.name = 'NativeEffectNotStartedError'; }
}

/**
 * Called under the profile's exclusive owner, BEFORE Harness.open can reconcile tasks.
 * Only this bootstrap phase writes Storage directly; afterwards Harness is the sole writer.
 * A lost process while active is intentionally conservative: even replay-safe tasks cannot
 * establish exactly-once effects or authorize another model request.
 */
export async function inspectNativeExecutionBeforeOpen(storage: Storage, context: Context, cwd: string): Promise<void> {
  const address = { kind: NativeExecutionFenceDoc.definition.kind, scope: { kind: 'session' as const } };
  const record = await storage.findDocument(address, 'current', context);
  const stored = record === undefined ? undefined : await storage.document(record.id, 'current', context);
  const state = stored?.value as NativeExecutionFenceState | undefined;
  if (record !== undefined && (stored === undefined || stored.version !== 1 || !['idle', 'active', 'UNKNOWN'].includes(state?.state ?? ''))) {
    throw new NativeExecutionUnknownError('Native execution fence is unreadable or from an unsupported version; execution is blocked.');
  }
  const taskIds: number[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanTasks({}, 256, cursor, context);
    taskIds.push(...page.items.filter((task) => task.state.status !== 'terminal').map((task) => task.id));
    cursor = page.next;
  } while (cursor !== undefined);
  const submissionIds: number[] = [];
  for (const status of ['queued', 'placed'] as const) {
    cursor = undefined;
    do {
      const page = await storage.scanSubmissions({ status }, 256, cursor, context);
      submissionIds.push(...page.items.map((submission) => submission.id));
      cursor = page.next;
    } while (cursor !== undefined);
  }
  if (state?.state === 'UNKNOWN') throw new NativeExecutionUnknownError(state.reason);
  if (state?.state === 'active' || taskIds.length > 0 || submissionIds.length > 0) {
    const value: NativeExecutionFenceState = { state: 'UNKNOWN', reason: 'Execution was interrupted before a quiescent durable receipt. Historical UNKNOWN is retained; automatic replay is prohibited.', taskIds, submissionIds };
    await storage.commit([record === undefined
      ? { type: 'document.create', record: { ...address, id: await storage.mintId<DocumentId>() }, content: { kind: 'base', version: 1, value } }
      : { type: 'document.change', id: record.id, content: { kind: 'base', version: 1, value } }], context);
    throw new NativeExecutionUnknownError(value.reason);
  }
  if (record !== undefined && await storage.conversation(ROOT_CONVERSATION_ID, context)) {
    const agentRecord = await storage.findDocument({ kind: 'pi.agent', scope: { kind: 'conversation', conversationId: ROOT_CONVERSATION_ID } }, 'current', context);
    const agent = agentRecord === undefined ? undefined : await storage.document(agentRecord.id, 'current', context);
    if (agent?.value.cwd !== cwd) throw new Error('Native session checkout does not match the host capability binding; no execution was opened.');
  }
  if (record === undefined) {
    if ((await storage.scanConversations({}, 1, undefined, context)).items.length > 0) {
      throw new NativeExecutionUnknownError('This store was not created by the Fate native adapter. Explicit migration review is required; legacy JSONL sessions are not imported or rewritten.');
    }
    await storage.commit([{ type: 'document.create', record: { ...address, id: await storage.mintId<DocumentId>() }, content: { kind: 'base', version: 1, value: { state: 'idle' } } }], context);
  }
}

export class NativeExecutionFence {
  #unknown: NativeExecutionUnknownError | undefined;
  #sealed = false;
  #harness: Harness | undefined;
  readonly #unknownSignal = new AbortController();
  constructor(readonly assertOwnership: () => Promise<void>) {}
  bind(harness: Harness): void { this.#harness = harness; }
  seal(): void { this.#sealed = true; }
  assertKnown(): void { if (this.#unknown) throw this.#unknown; if (this.#sealed) throw new Error('Native execution is closed.'); }
  async assertAdmission(): Promise<void> {
    this.assertKnown();
    try { await this.assertOwnership(); }
    catch (error) { this.poison('The profile owner was lost; no new execution is permitted.'); throw error; }
    this.assertKnown();
  }
  poison(reason: string): void {
    this.#unknown ??= new NativeExecutionUnknownError(reason);
    this.#unknownSignal.abort(this.#unknown);
  }
  /** A poisoned storage line may never settle native waits. Fence-aware observation
   * rejects promptly without pretending the task itself reached a terminal state. */
  async observeOutcome<T>(operation: () => Promise<T>): Promise<T> {
    this.assertKnown();
    const signal = this.#unknownSignal.signal;
    let rejectFence!: (reason: unknown) => void;
    const failed = new Promise<never>((_, reject) => { rejectFence = reject; });
    const abort = () => rejectFence(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    try { return await Promise.race([operation(), failed]); }
    finally { signal.removeEventListener('abort', abort); }
  }
  /** Any commit failure may have committed; do not retry it or claim non-admission. */
  guardStorage(storage: Storage): Storage {
    return new Proxy(storage, { get: (target, property) => {
      const value: unknown = Reflect.get(target, property, target);
      if (property === 'commit') return async (...args: Parameters<Storage['commit']>) => {
        try { return await target.commit(...args); }
        catch (error) { this.poison('A native storage commit has an unknown outcome; the execution is fenced.'); throw error; }
      };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
  async beforeAdmission(): Promise<void> {
    await this.assertAdmission();
    await this.#harness!.commit(async (tx) => {
      const doc = await tx.doc(NativeExecutionFenceDoc);
      if (doc.state === 'UNKNOWN') { this.poison(doc.reason ?? 'Native execution is UNKNOWN.'); this.assertKnown(); }
      doc.state = 'active';
    }, BACKGROUND_CONTEXT);
    this.assertKnown();
  }
  async markIdle(): Promise<void> {
    await this.assertAdmission();
    const live = await this.#harness!.inspect(BACKGROUND_CONTEXT);
    if (live.tasks.length || live.submissions.length) return;
    await this.#harness!.commit(async (tx) => {
      const doc = await tx.doc(NativeExecutionFenceDoc);
      if (doc.state !== 'UNKNOWN') doc.state = 'idle';
    }, BACKGROUND_CONTEXT);
  }
  async recordUnknown(reason: string, api?: Pick<ToolExecutionApi, 'commit'>): Promise<void> {
    this.poison(reason); // Stop concurrent model/tool admission BEFORE waiting for persistence.
    const commit = api?.commit.bind(api) ?? this.#harness!.commit.bind(this.#harness!);
    await commit(async (tx) => {
      const doc = await tx.doc(NativeExecutionFenceDoc);
      doc.state = 'UNKNOWN';
      doc.reason ??= reason;
    }, BACKGROUND_CONTEXT);
  }
  async state(): Promise<Readonly<NativeExecutionFenceState> | undefined> {
    await this.assertOwnership();
    return this.#harness!.snapshot(NativeExecutionFenceDoc, BACKGROUND_CONTEXT);
  }
}

/** Reject lossy JSON conversion rather than silently dropping UI/effect evidence. */
export function assertNativeJson(value: unknown): asserts value is JsonObject {
  const seen = new Set<object>();
  const visit = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || item === undefined || seen.has(item)) throw new TypeError('Native evidence must be finite, acyclic JSON.');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new TypeError('Native evidence must use plain JSON objects.');
    seen.add(item);
    for (const value of Object.values(item)) visit(value);
    seen.delete(item);
  };
  visit(value);
}

/** Cleanup uncertainty must reach the host that owns the profile lock. */
export async function failWithNativeCleanup(error: unknown, cleanup: () => Promise<void>): Promise<never> {
  try { await cleanup(); }
  catch (closeError) { throw new DurableStorageCloseUncertainError([error, closeError], 'Native execution failed and cleanup is unconfirmed; retain the owner for review.'); }
  throw error;
}
