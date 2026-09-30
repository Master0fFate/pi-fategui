import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { JournaledMutationRequest } from '../../shared/protocol/envelopes';
import { mutationReceiptSchema, type CommandStatus, type MutationReceipt } from '../../shared/protocol/commandOutcomes';
import { ProtocolFault, errorCodeSchema, type ErrorCode } from '../../shared/protocol/errors';
import { MAX_CLOCK_SKEW_MS, MAX_REQUEST_AGE_MS, mutationIdentityMatches, mutationRequestIdSchema, uuidSchema, validateRequestClock } from '../../shared/protocol/requestIds';

import { hostOperationJournalMethods } from '../../shared/protocol/hostOperations';
const hex = z.string().regex(/^[a-f0-9]{64}$/u);
function receiptMatchesMethod(receipt: MutationReceipt, method: JournaledMutationRequest['method']): boolean {
  if (method === 'runtime.prompt') return receipt.kind === 'prompt';
  if (method === 'runtime.abort') return receipt.kind === 'abort';
  if (method === 'session.select') return receipt.kind === 'selection';
  if (method === 'permission.confirm') return receipt.kind === 'permission';
  return receipt.kind === 'operation' && receipt.operation === method;
}
function journalClock(request: JournaledMutationRequest, epoch: string, now: number) {
  const invalid = validateRequestClock(request, epoch, now);
  if (invalid) return invalid;
  return request.issuedAt < now - MAX_REQUEST_AGE_MS || request.issuedAt > now + MAX_CLOCK_SKEW_MS ? 'CLOCK_SKEW' as const : null;
}
const recordSchema = z.object({ version: z.literal(1), requestId: mutationRequestIdSchema, epoch: uuidSchema,
  issuedAt: z.number().int().nonnegative().safe(), workspaceId: uuidSchema, workspaceGeneration: z.number().int().nonnegative().safe(),
  principalId: uuidSchema, method: z.enum(hostOperationJournalMethods), digest: hex,
  sessionId: uuidSchema, state: z.enum(['reserved', 'admitted', 'settled', 'rejected', 'outcome_unknown']),
  receipt: mutationReceiptSchema.nullable(), rejectionCode: errorCodeSchema.nullable(), updatedAt: z.number().int().nonnegative().safe(),
}).strict().superRefine((record, context) => {
  const valid = mutationIdentityMatches({ requestId: record.requestId, serverEpoch: record.epoch, issuedAt: record.issuedAt })
    && record.updatedAt + MAX_CLOCK_SKEW_MS >= record.issuedAt
    && (record.state === 'settled') === (record.receipt !== null)
    && (record.state === 'rejected') === (record.rejectionCode !== null)
    && (!record.receipt || (record.receipt.requestId === record.requestId
      && (record.method === 'session.create' || record.receipt.sessionId === record.sessionId)
      && receiptMatchesMethod(record.receipt, record.method)
      && (record.receipt.kind !== 'permission' || record.receipt.workspaceId === record.workspaceId
        && record.receipt.workspaceGeneration === record.workspaceGeneration)));
  // Creation preserves the captured original session in the command record/digest.
  // Its truthful receipt names the NEW session; no other method gets that exception.
  if (!valid) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Inconsistent command record.' });
});
type RecordData = z.infer<typeof recordSchema>;
const MAX_RECORD_BYTES = 4096;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 10_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const clockSchema = z.object({ version: z.literal(1), epoch: uuidSchema, highWater: z.number().int().nonnegative().safe() }).strict();

function unavailable(): ProtocolFault { return new ProtocolFault('STORAGE_UNAVAILABLE'); }
/** The parsed protocol input is strict and normalized by Zod; its one-way digest is the only prompt evidence stored here. */
export function commandDigest(request: JournaledMutationRequest): string {
  return createHash('sha256').update(JSON.stringify([request.method, request.workspaceId, request.workspaceGeneration,
    request.method === 'permission.confirm' ? request.input.sessionId : request.expectedSessionId,
    request.selectionRevision, request.controlGeneration, request.input])).digest('hex');
}
/** Only a trusted effect owner may prove its effect was never entered. Never derive this from provider text/JSON. */
export class JournalRejected extends ProtocolFault {
  constructor(code: ErrorCode) {
    if (!errorCodeSchema.safeParse(code).success || code === 'OUTCOME_UNKNOWN' || code === 'INTERRUPT_FAILED') throw new ProtocolFault('OUTCOME_UNKNOWN');
    super(code);
  }
}
export interface CommandJournalOptions {
  /** Explicit private, profile-owned directory. Never infer HOME or a client-supplied path. */
  readonly root: string;
  readonly serverEpoch: string;
  readonly now?: () => number;
  readonly maxRecords?: number;
  readonly maxBytes?: number;
}
/** One writer per profile is required (the profile-owner lock is T26). Never use this class with two writers.
 * Atomic replace + file sync protect completed records; directory sync is attempted where supported.
 * Windows may not support directory fsync. Power-loss guarantees depend on the host filesystem.
 */
export class CommandJournal {
  private tail: Promise<void> = Promise.resolve();
  private readonly effectTails = new Map<string, Promise<void>>();
  private readonly inFlight = new Map<string, { principalId: string; digest: string; promise: Promise<MutationReceipt> }>();
  private readonly epoch: string;
  private readonly now: () => number;
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  constructor(private readonly options: CommandJournalOptions) {
    if (!path.isAbsolute(options.root)) throw new Error('Journal root must be an absolute host path');
    this.epoch = uuidSchema.parse(options.serverEpoch);
    this.now = options.now ?? Date.now;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1 || !Number.isSafeInteger(this.maxBytes)
      || this.maxBytes < MAX_RECORD_BYTES) throw new Error('Invalid journal quota');
  }
  private target(id: string): string { return path.join(this.options.root, `${createHash('sha256').update(id).digest('hex')}.json`); }
  private clockTarget(): string { return path.join(this.options.root, `clock-${createHash('sha256').update(this.epoch).digest('hex')}.json`); }
  private async advanceClock(now: number): Promise<void> {
    const target = this.clockTarget();
    let highWater = 0;
    try {
      const { text } = await this.boundedRead(target);
      const parsed = clockSchema.safeParse(JSON.parse(text));
      if (!parsed.success || parsed.data.epoch !== this.epoch) throw unavailable();
      highWater = parsed.data.highWater;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw unavailable(); }
    if (now < highWater) throw new ProtocolFault('CLOCK_SKEW');
    if (now > highWater) await this.writeText(target, JSON.stringify(clockSchema.parse({ version: 1, epoch: this.epoch, highWater: now })), false)
      .catch(() => { throw unavailable(); });
  }
  /** Per-workspace effect lane; a stop attempt never waits behind a prompt that it must stop. */
  private effectLane<T>(request: JournaledMutationRequest, perform: () => Promise<T>): Promise<T> {
    if (request.method === 'runtime.abort') return perform();
    const key = request.workspaceId;
    const pending = (this.effectTails.get(key) ?? Promise.resolve()).then(perform);
    const tail = pending.then(() => undefined, () => undefined);
    this.effectTails.set(key, tail);
    void tail.then(() => { if (this.effectTails.get(key) === tail) this.effectTails.delete(key); });
    return pending;
  }
  private async syncDirectory(): Promise<void> {
    try {
      const directory = await fs.open(this.options.root, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      // Node/Windows cannot open directories for fsync. Atomic rename remains the best available guarantee.
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  private async boundedRead(target: string): Promise<{ text: string; size: number }> {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES || stat.size < 1) throw unavailable();
    const handle = await fs.open(target, 'r');
    try {
      const live = await handle.stat();
      if (!live.isFile() || live.size > MAX_RECORD_BYTES || live.size < 1) throw unavailable();
      const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== live.size) throw unavailable();
      return { text: bytes.toString('utf8', 0, bytesRead), size: bytesRead };
    } finally { await handle.close(); }
  }
  private async read(id: string): Promise<RecordData | null> {
    const target = this.target(id);
    try {
      const { text } = await this.boundedRead(target);
      let parsed: ReturnType<typeof recordSchema.safeParse>;
      try { parsed = recordSchema.safeParse(JSON.parse(text)); } catch { throw unavailable(); }
      if (!parsed.success || parsed.data.requestId !== id) throw unavailable();
      return parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw unavailable();
    }
  }
  private async write(record: RecordData, exclusive: boolean): Promise<void> {
    await this.writeText(this.target(record.requestId), JSON.stringify(recordSchema.parse(record)), exclusive);
  }
  private async writeText(target: string, text: string, exclusive: boolean): Promise<void> {
    if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw unavailable();
    await fs.mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const file = await fs.open(temporary, 'wx', 0o600);
      try { await file.writeFile(text, 'utf8'); await file.sync(); } finally { await file.close(); }
      if (exclusive) {
        // Exclusive reservation: a second process cannot silently overwrite an existing command.
        await fs.link(temporary, target);
        await fs.rm(temporary);
      } else await fs.rename(temporary, target);
      await this.syncDirectory();
    } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
  }
  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  /** Read-only startup validation. A bad or full journal blocks readiness. */
  checkHealth(): Promise<void> {
    return this.queue(async () => {
      let stat;
      try { stat = await fs.lstat(this.options.root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw unavailable(); }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
      await this.capacity(this.now(), false);
    });
  }
  private async capacity(now: number, prune = true): Promise<void> {
    let entries: string[];
    try { entries = await fs.readdir(this.options.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw unavailable(); }
    if (entries.length > this.maxRecords * 2 + 64) throw unavailable();
    let count = 0, bytes = 0;
    for (const name of entries) {
      if (/^clock-[a-f0-9]{64}\.json$/u.test(name)) {
        const { text } = await this.boundedRead(path.join(this.options.root, name)).catch(() => { throw unavailable(); });
        let parsed: ReturnType<typeof clockSchema.safeParse>;
        try { parsed = clockSchema.safeParse(JSON.parse(text)); } catch { throw unavailable(); }
        if (!parsed.success || name !== `clock-${createHash('sha256').update(parsed.data.epoch).digest('hex')}.json`) throw unavailable();
        continue;
      }
      if (/^(?:clock-)?[a-f0-9]{64}\.json\.[0-9a-f-]{36}\.tmp$/u.test(name)) {
        const stat = await fs.lstat(path.join(this.options.root, name)).catch(() => { throw unavailable(); });
        if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw unavailable();
        count++; bytes += stat.size;
        continue;
      }
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) throw unavailable();
      const target = path.join(this.options.root, name);
      const { text, size } = await this.boundedRead(target).catch(() => { throw unavailable(); });
      let parsed: ReturnType<typeof recordSchema.safeParse>;
      try { parsed = recordSchema.safeParse(JSON.parse(text)); } catch { throw unavailable(); }
      if (!parsed.success || path.basename(this.target(parsed.data.requestId)) !== name) throw unavailable();
      if (prune && (parsed.data.state === 'settled' || parsed.data.state === 'rejected') && now - parsed.data.updatedAt > RETENTION_MS) {
        await fs.rm(target).catch(() => { throw unavailable(); });
        await this.syncDirectory().catch(() => { throw unavailable(); });
      } else { count++; bytes += size; }
    }
    if (count >= this.maxRecords || bytes + MAX_RECORD_BYTES > this.maxBytes) throw unavailable();
  }
  /** Host-local maintenance only. T26 must supply the exclusive profile-owner lock; never remove command records. */
  async quarantineOrphanTemps(confirmExclusiveOwner: () => boolean, quarantineRoot: string): Promise<number> {
    return this.queue(async () => {
      const journalRoot = path.resolve(this.options.root);
      const destination = path.resolve(quarantineRoot);
      if (confirmExclusiveOwner() !== true || this.inFlight.size > 0 || !path.isAbsolute(quarantineRoot)
        || destination === journalRoot || destination.startsWith(`${journalRoot}${path.sep}`)) throw unavailable();
      let names: string[];
      try { names = await fs.readdir(this.options.root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw unavailable(); }
      let removed = 0;
      for (const name of names) {
        if (!/^(?:clock-)?[a-f0-9]{64}\.json\.[0-9a-f-]{36}\.tmp$/u.test(name)) continue;
        const target = path.join(this.options.root, name);
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw unavailable();
        // Preserve even an incomplete crash tail for operator inspection; no command .json is removed.
        await fs.mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
        await fs.rename(target, path.join(quarantineRoot, `${name}.${randomUUID()}`)); removed++;
      }
      if (removed) await this.syncDirectory();
      return removed;
    });
  }
  /** Status is authorized by the caller's current authentication and workspace membership, not by old control. */
  async status(requestId: string, workspaceId: string, principalId: string): Promise<CommandStatus> {
    mutationRequestIdSchema.parse(requestId);
    uuidSchema.parse(workspaceId); uuidSchema.parse(principalId);
    return this.queue<CommandStatus>(async () => {
      const record = await this.read(requestId);
      if (!record) return { state: 'absent', receipt: null, rejectionCode: null };
      if (record.workspaceId !== workspaceId || record.principalId !== principalId) throw new ProtocolFault('FORBIDDEN');
      const active = this.inFlight.has(requestId);
      return { state: !active && (record.state === 'reserved' || record.state === 'admitted') ? 'outcome_unknown' : record.state,
        receipt: record.receipt, rejectionCode: record.rejectionCode };
    });
  }
  /** The caller must check current authority before entry; duplicates still require current auth/membership,
   * but must not require old selection/control. `effect` is called at most once per ID in this owner process.
   */
  execute(request: JournaledMutationRequest, principalId: string, effect: () => Promise<MutationReceipt>,
    preflight: () => void = () => undefined, enterEffect: () => void = () => undefined): Promise<MutationReceipt> {
    const time = this.now();
    if (!mutationIdentityMatches(request)) return Promise.reject(new ProtocolFault('INVALID_REQUEST'));
    const clock = journalClock(request, this.epoch, time);
    if (clock) return Promise.reject(new ProtocolFault(clock));
    const digest = commandDigest(request);
    const running = this.inFlight.get(request.requestId);
    if (running) return running.principalId === principalId && running.digest === digest
      ? running.promise : Promise.reject(new ProtocolFault('REQUEST_CONFLICT'));
    const promise = this.queue(async (): Promise<{ base: RecordData; receipt: MutationReceipt | null }> => {
      const admissionTime = this.now();
      const admissionClock = journalClock(request, this.epoch, admissionTime);
      if (admissionClock) throw new ProtocolFault(admissionClock);
      await this.advanceClock(admissionTime);
      const existing = await this.read(request.requestId);
      if (existing) {
        if (existing.principalId !== principalId || existing.workspaceId !== request.workspaceId || existing.workspaceGeneration !== request.workspaceGeneration
          || existing.method !== request.method || existing.digest !== digest) throw new ProtocolFault('REQUEST_CONFLICT');
        if (existing.state === 'settled' && existing.receipt) return { base: existing, receipt: existing.receipt };
        if (existing.state === 'rejected') throw new ProtocolFault(existing.rejectionCode ?? 'INTERNAL_ERROR');
        throw new ProtocolFault('OUTCOME_UNKNOWN');
      }
      preflight();
      await this.capacity(admissionTime);
      const base: RecordData = { version: 1, requestId: request.requestId, epoch: request.serverEpoch, issuedAt: request.issuedAt,
        workspaceId: request.workspaceId, workspaceGeneration: request.workspaceGeneration, principalId: uuidSchema.parse(principalId),
        method: request.method, sessionId: request.method === 'session.select' || request.method === 'permission.confirm' ? request.input.sessionId : request.expectedSessionId,
        digest, state: 'reserved', receipt: null, rejectionCode: null, updatedAt: admissionTime };
      try { await this.write(base, true); await this.write({ ...base, state: 'admitted' }, false); }
      catch { throw unavailable(); }
      return { base, receipt: null };
    }).then(({ base, receipt: saved }) => {
      if (saved) return saved;
      return this.effectLane(request, async () => {
      try {
        const effectClock = journalClock(request, this.epoch, this.now());
        if (effectClock) throw new ProtocolFault(effectClock);
        enterEffect();
      }
      catch (error) {
        const code: ErrorCode = error instanceof ProtocolFault ? error.code : 'INTERNAL_ERROR';
        try { await this.queue(() => this.write({ ...base, state: 'rejected', rejectionCode: code, updatedAt: this.now() }, false)); }
        catch { throw unavailable(); }
        throw new ProtocolFault(code);
      }
      let receipt: MutationReceipt;
      try {
        receipt = mutationReceiptSchema.parse(await effect());
        if (receipt.requestId !== request.requestId || !receiptMatchesMethod(receipt, request.method)
          || (request.method !== 'session.create' && receipt.sessionId !== base.sessionId)
          || request.method === 'permission.confirm' && (receipt.kind !== 'permission'
            || receipt.challengeId !== request.input.challengeId || receipt.workspaceId !== request.workspaceId
            || receipt.workspaceGeneration !== request.workspaceGeneration || receipt.selectionRevision !== request.selectionRevision
            || receipt.controlGeneration !== request.controlGeneration || receipt.oldLevel !== request.input.oldLevel
            || receipt.newLevel !== request.input.newLevel)) throw new ProtocolFault('OUTCOME_UNKNOWN');
      } catch (error) {
        if (error instanceof JournalRejected) {
          try { await this.queue(() => this.write({ ...base, state: 'rejected', rejectionCode: error.code, updatedAt: this.now() }, false)); }
          catch { throw new ProtocolFault('OUTCOME_UNKNOWN'); }
          throw error;
        }
        await this.queue(() => this.write({ ...base, state: 'outcome_unknown', updatedAt: this.now() }, false)).catch(() => undefined);
        throw new ProtocolFault('OUTCOME_UNKNOWN');
      }
      try { await this.queue(() => this.write({ ...base, state: 'settled', receipt, updatedAt: this.now() }, false)); }
      catch { throw new ProtocolFault('OUTCOME_UNKNOWN'); }
      return receipt;
      });
    });
    this.inFlight.set(request.requestId, { principalId, digest, promise });
    void promise.finally(() => { if (this.inFlight.get(request.requestId)?.promise === promise) this.inFlight.delete(request.requestId); }).catch(() => undefined);
    return promise;
  }
}
