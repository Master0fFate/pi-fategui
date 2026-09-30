import { createHash, randomUUID } from 'node:crypto';
import { checkoutFactsSchema, type CheckoutFacts } from './GoalReviewFacts';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const id = z.string().min(1).max(500).regex(/^[^\x00-\x1f\x7f]+$/u);
const referenceSchema = z.object({
  projectPath: id, sessionId: id,
  workspaceId: id.optional(), teamId: id.optional(), nodeId: id.optional(), goalId: id.optional(), taskId: id.optional(),
  requestId: id.optional(), principalId: id.optional(), runId: id.optional(),
  worktree: z.object({ path: id, parentPath: id, branch: id, baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u), commonDirectory: id }).strict().optional(),
}).strict();
const recordSchema = z.object({
  version: z.literal(1), id, reference: referenceSchema, status: z.enum(['running', 'paused', 'draft', 'interrupted', 'unknown', 'completed', 'failed']),
  checkpoint: z.boolean(), at: z.number().int().nonnegative().safe(),
}).strict();
export type LifecycleRecord = z.infer<typeof recordSchema>;
export type LifecycleReference = LifecycleRecord['reference'];
export type LifecycleStatus = LifecycleRecord['status'];
export type LifecycleRead = { records: LifecycleRecord[]; health: 'ok' | 'partial-tail' | 'corrupt-interior' | 'unavailable' | 'quota' };
// R1 ACKs from unaccepted candidates are not authorization. The v2 filename
// keeps them intact for inspection, but recovery reads only v2 staged ACKs.
const reviewAckSchema = z.object({ version: z.literal(2), outcome: z.literal('unknown-reviewed'),
  stage: z.enum(['prepared', 'committed']),
  projectPath: id, sessionId: id, goalId: id, goalRevision: z.number().int().positive().safe(),
  principalId: id, checkout: checkoutFactsSchema, at: z.number().int().nonnegative().safe(),
}).strict();
export type GoalReviewAck = z.infer<typeof reviewAckSchema>;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 512;
const MAX_LINE = 4096;

/** Single profile owner only. A projection, not a Team/Goal/Pi event log. Never repair
 * an uncertain file automatically. Complete lines survive a partial tail; corrupt
 * interior is a separate operator error. No conversation, draft text or key fields. */
export class LifecycleRepository {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly root: string, private readonly maxBytes = MAX_BYTES, private readonly maxRecords = MAX_RECORDS) {
    if (!path.isAbsolute(root) || !Number.isSafeInteger(maxBytes) || maxBytes < MAX_LINE
      || maxBytes > MAX_BYTES || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS) throw new Error('Invalid lifecycle storage bounds.');
  }
  private get file(): string { return path.join(this.root, 'status-v1.jsonl'); }
  private reviewFile(projectPath: string, sessionId: string, goalId: string, revision: number, checkout: CheckoutFacts): string {
    const hash = createHash('sha256').update(JSON.stringify([projectPath, sessionId, goalId, revision, checkout])).digest('hex');
    return path.join(this.root, `review-v2-${hash}.json`);
  }
  async readGoalReview(projectPath: string, sessionId: string, goalId: string, revision: number, checkout: CheckoutFacts): Promise<GoalReviewAck | null> {
    await this.tail;
    return this.readReviewFile(projectPath, sessionId, goalId, revision, checkout);
  }
  private async readReviewFile(projectPath: string, sessionId: string, goalId: string, revision: number,
    checkout: CheckoutFacts): Promise<GoalReviewAck | null> {
    const target = this.reviewFile(projectPath, sessionId, goalId, revision, checkout);
    try {
      const item = await fs.lstat(target);
      if (!item.isFile() || item.size > MAX_LINE || item.size < 1) throw new Error('Invalid review acknowledgement.');
      const file = await fs.open(target, 'r');
      try {
        const bytes = Buffer.alloc(MAX_LINE + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== item.size || (await file.stat()).size !== item.size) throw new Error('Review acknowledgement changed during read.');
        const ack = reviewAckSchema.parse(JSON.parse(bytes.toString('utf8', 0, bytesRead)));
        if (ack.projectPath !== projectPath || ack.sessionId !== sessionId || ack.goalId !== goalId || ack.goalRevision !== revision
          || JSON.stringify(ack.checkout) !== JSON.stringify(checkoutFactsSchema.parse(checkout))) throw new Error('Review acknowledgement identity mismatch.');
        return ack;
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('STORAGE_UNAVAILABLE: saved recovery review is invalid or unavailable.', { cause: error });
    }
  }
  async saveGoalReview(input: Omit<GoalReviewAck, 'version' | 'outcome' | 'at'> & { checkout: CheckoutFacts }): Promise<GoalReviewAck> {
    const result = this.tail.then(async () => {
      if ((await this.inspect()).health !== 'ok') throw new Error('STORAGE_UNAVAILABLE: lifecycle index needs operator review.');
      const ack = reviewAckSchema.parse({ ...input, version: 2, outcome: 'unknown-reviewed', at: Date.now() });
      const text = `${JSON.stringify(ack)}\n`;
      if (Buffer.byteLength(text) > MAX_LINE) throw new Error('STORAGE_UNAVAILABLE: recovery review exceeds its size limit.');
      const target = this.reviewFile(ack.projectPath, ack.sessionId, ack.goalId, ack.goalRevision, ack.checkout);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        if (ack.stage === 'committed') {
          const prepared = await this.readReviewFile(ack.projectPath, ack.sessionId, ack.goalId, ack.goalRevision, ack.checkout);
          if (!prepared || prepared.stage !== 'prepared' || prepared.principalId !== ack.principalId)
            throw new Error('A matching prepared review must precede commit.');
        }
        await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
        const directory = await fs.opendir(this.root);
        let count = 0, visited = 0;
        for await (const entry of directory) {
          if (++visited > this.maxRecords * 2 + 64) throw new Error('Review directory exceeds its scan limit.');
          if (entry.name.startsWith('review-') && entry.name.endsWith('.json') && ++count > this.maxRecords) throw new Error('Review quota reached.');
        }
        if (count >= this.maxRecords && !(await fs.lstat(target).then((item) => item.isFile(), () => false))) throw new Error('Review quota reached.');
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
        const syncDirectory = async () => {
          try {
            const dir = await fs.open(this.root, 'r');
            try { await dir.sync(); } finally { await dir.close(); }
          } catch (error) {
            if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          }
        };
        // Preparation must survive a restart before the final checks begin.
        // Commit has no fallible work after publication: power loss may leave
        // committed or revert it to the already durable prepared state.
        if (ack.stage === 'committed') await syncDirectory();
        await fs.rename(temporary, target);
        if (ack.stage === 'prepared') await syncDirectory();
        return ack;
      } catch (error) { throw new Error('STORAGE_UNAVAILABLE: recovery review could not be saved.', { cause: error }); }
      finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  private async inspect(): Promise<LifecycleRead> {
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      const item = await fs.lstat(this.file);
      if (!item.isFile()) return { records: [], health: 'unavailable' };
      handle = await fs.open(this.file, 'r');
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { records: [], health: 'unavailable' };
      try {
        const root = await fs.lstat(this.root);
        return { records: [], health: root.isDirectory() ? 'ok' : 'unavailable' };
      } catch (rootError) {
        return { records: [], health: (rootError as NodeJS.ErrnoException).code === 'ENOENT' ? 'ok' : 'unavailable' };
      }
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > this.maxBytes) return { records: [], health: 'quota' };
      const data = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read(data, 0, data.length, 0);
      if (bytesRead !== stat.size || (await handle.stat()).size !== stat.size) return { records: [], health: 'unavailable' };
      const bytes = data.subarray(0, bytesRead);
      const last = bytes.lastIndexOf(10);
      const partial = bytesRead > 0 && last !== bytesRead - 1;
      const complete = last === -1 ? Buffer.alloc(0) : bytes.subarray(0, last + 1);
      const records: LifecycleRecord[] = [];
      for (const line of complete.toString('utf8').split('\n').slice(0, -1)) {
        if (!line || Buffer.byteLength(line) > MAX_LINE || records.length >= this.maxRecords) return { records, health: 'corrupt-interior' };
        try { records.push(recordSchema.parse(JSON.parse(line))); }
        catch { return { records, health: 'corrupt-interior' }; }
      }
      if (partial && bytesRead - last - 1 > MAX_LINE) return { records, health: 'corrupt-interior' };
      return { records, health: partial ? 'partial-tail' : 'ok' };
    } catch { return { records: [], health: 'unavailable' }; }
    finally { await handle.close(); }
  }
  async read(): Promise<LifecycleRead> { await this.tail; return this.inspect(); }
  /** Refuse all writes after any failed health check. The caller must surface the
   * returned read health and block new admissions, not silently drop a checkpoint. */
  append(reference: LifecycleReference, status: LifecycleStatus, checkpoint = false, at = Date.now()): Promise<LifecycleRecord> {
    const result = this.tail.then(async () => {
      const record = recordSchema.parse({ version: 1, id: randomUUID(), reference, status, checkpoint, at });
      const line = `${JSON.stringify(record)}\n`;
      const bytes = Buffer.byteLength(line);
      if (bytes > MAX_LINE) throw new Error('STORAGE_UNAVAILABLE: lifecycle record exceeds its limit.');
      const current = await this.inspect();
      if (current.health !== 'ok' || current.records.length >= this.maxRecords) throw new Error(`STORAGE_UNAVAILABLE: lifecycle ${current.health === 'ok' ? 'quota' : current.health}.`);
      const existing = current.records.findLast((item) => item.reference.projectPath === reference.projectPath && item.reference.sessionId === reference.sessionId
        && item.reference.runId === reference.runId && item.reference.teamId === reference.teamId && item.reference.taskId === reference.taskId && item.reference.requestId === reference.requestId);
      if (existing && ['completed', 'failed'].includes(existing.status) && status === 'running') throw new Error('A settled lifecycle reference cannot restart; use a new execution identity.');
      const stat = await fs.stat(this.file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if ((stat?.size ?? 0) + bytes > this.maxBytes) throw new Error('STORAGE_UNAVAILABLE: lifecycle quota.');
      try {
        await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
        const handle = await fs.open(this.file, 'a', 0o600);
        try { await handle.writeFile(line, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
      } catch { throw new Error('STORAGE_UNAVAILABLE: lifecycle write failed; prior records retained.'); }
      return record;
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
