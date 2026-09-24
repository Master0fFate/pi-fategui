import { createHash } from 'node:crypto';
import { DefinitionJournal, type DefinitionSnapshot } from './DefinitionJournal';
import { consumeApproval, type ApprovalBinding, type Permission } from './RoutinePolicy';

export interface ApprovalContext {
  binding: Omit<ApprovalBinding, 'actionDigest'>;
  trusted: boolean;
  permission: Permission;
}
interface Pending {
  snapshot: DefinitionSnapshot;
  resolve: () => void;
  reject: (error: Error) => void;
}

function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** An approval resumes only the suspended, snapshotted call in this process. */
export class ApprovalGate {
  private readonly pending = new Map<string, Pending>();
  constructor(
    private readonly journal: DefinitionJournal,
    private readonly context: () => ApprovalContext,
    private readonly attention: (id: string, snapshot: DefinitionSnapshot) => void | Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly decided?: (id: string, status: 'denied' | 'expired') => void | Promise<void>,
  ) {}

  async execute<I, T>(id: string, tool: string, input: I, effect: (approvedInput: Readonly<I>) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const context = this.context();
    if (!context.trusted || context.permission === 'read-only') throw new Error('Effect is not authorized by live project trust and permission.');
    const approvedInput = freeze(JSON.parse(JSON.stringify(input)) as I);
    const action = JSON.stringify({ tool, input: approvedInput });
    const actionDigest = createHash('sha256').update(action).digest('hex');
    const binding: ApprovalBinding = { ...context.binding, actionDigest };
    const createdAt = this.now();
    const snapshot = await this.journal.save(id, null, { metadata: { kind: 'approval-proof', ...binding, status: 'needs-attention', createdAt, expiresAt: createdAt + 300_000 }, body: action });
    await new Promise<void>((resolve, reject) => {
      const pending: Pending = { snapshot, resolve: () => { cleanup(); resolve(); }, reject: (error) => { cleanup(); reject(error); } };
      const abort = () => pending.reject(new Error('Approval wait was aborted; no effect was executed.'));
      const timer = setTimeout(() => { void this.deny(id, 'expired'); }, 300_000);
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pending.delete(id);
      };
      this.pending.set(id, pending);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else {
        try { void Promise.resolve(this.attention(id, snapshot)).catch((error: unknown) => pending.reject(error instanceof Error ? error : new Error(String(error)))); }
        catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))); }
      }
    });
    signal?.throwIfAborted();
    const live = this.context();
    consumeApproval({ ...binding, approvedAt: createdAt, expiresAt: createdAt + 300_000, consumed: false }, { ...live.binding, actionDigest }, this.now(), live.trusted, live.permission);
    // The durable consumed record is the admission point: crashes cannot replay it.
    return effect(approvedInput);
  }

  async approve(id: string, expected: DefinitionSnapshot, beforeResume?: () => Promise<void>): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending || pending.snapshot.digest !== expected.digest || pending.snapshot.revision !== expected.revision) throw new Error('No matching live suspended action. Restarted or changed actions cannot be replayed.');
    const source = pending.snapshot.metadata;
    const binding: ApprovalBinding = {
      runId: String(source.runId), actionDigest: String(source.actionDigest), projectPath: String(source.projectPath),
      definitionRevision: Number(source.definitionRevision), taskRevision: Number(source.taskRevision), permissionRevision: Number(source.permissionRevision),
    };
    const live = this.context();
    consumeApproval({ ...binding, approvedAt: Number(source.createdAt), expiresAt: Number(source.expiresAt), consumed: false }, { ...live.binding, actionDigest: binding.actionDigest }, this.now(), live.trusted, live.permission);
    await this.journal.save(id, expected, { metadata: { ...source, status: 'consumed', consumedAt: this.now() }, body: pending.snapshot.body });
    // Recheck after asynchronous persistence; a lost permission never resumes the effect.
    try {
      await beforeResume?.();
      const latest = this.context();
      consumeApproval({ ...binding, approvedAt: Number(source.createdAt), expiresAt: Number(source.expiresAt), consumed: false }, { ...latest.binding, actionDigest: binding.actionDigest }, this.now(), latest.trusted, latest.permission);
      pending.resolve();
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async deny(id: string, status: 'denied' | 'expired' = 'denied'): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) return;
    try {
      await this.journal.save(id, pending.snapshot, { metadata: { ...pending.snapshot.metadata, status, finishedAt: this.now() }, body: pending.snapshot.body });
      await this.decided?.(id, status);
      pending.reject(new Error(`Approval ${status}; no effect was executed.`));
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
