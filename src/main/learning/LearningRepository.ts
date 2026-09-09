import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { LEARNING_LIMITS, learningSnapshotSchema, type LearningScope, type LearningSnapshot } from '../../shared/contracts/learning';
import { fateDataRoot } from '../pi/FateProviderStorage';
import { PiDesktopError } from '../pi/errors';

export const learningDigest = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const projectLearningKey = (canonicalRoot: string): string => learningDigest(path.normalize(canonicalRoot));
export function learningError(message: string): never {
  throw new PiDesktopError({ code: 'INVALID_REQUEST', message: `Memory Learning: ${message}`, retryable: true });
}
export interface LearningStoreIdentity { scope: LearningScope; projectKey: string; canonicalRoot: string | null }
export const learningIdentity = (root: string, scope: LearningScope): LearningStoreIdentity => scope === 'global'
  ? { scope, projectKey: 'global', canonicalRoot: null }
  : { scope, projectKey: projectLearningKey(root), canonicalRoot: root };
export const emptyLearningSnapshot = (identity: LearningStoreIdentity): LearningSnapshot => ({
  schemaVersion: 1, ...identity, epoch: randomUUID(), revision: 0, mode: 'manual',
  lessons: [], revisions: [], drafts: [], evidence: [], manifests: [], generationUsage: [],
});
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export async function readLearningFile(file: string, maximum: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) learningError('Unsafe or oversized local file. Original data was preserved.');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maximum) learningError('Local file changed during validation.');
    const buffer = Buffer.alloc(Math.min(maximum + 1, opened.size + 1));
    let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, offset, Math.min(64 * 1024, buffer.length - offset), offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    signal?.throwIfAborted();
    const after = await handle.stat();
    const target = await fs.lstat(file);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || offset !== opened.size || !target.isFile() || target.isSymbolicLink() || target.ino !== opened.ino || target.dev !== opened.dev) learningError('Local file changed during reading.');
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}

export function validateLearningSnapshot(value: unknown, identity: LearningStoreIdentity): LearningSnapshot {
  const state = learningSnapshotSchema.parse(value);
  if (state.scope !== identity.scope || state.projectKey !== identity.projectKey || state.canonicalRoot !== identity.canonicalRoot) learningError('Store identity mismatch. Original data was preserved.');
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (![state.lessons, state.revisions, state.drafts, state.evidence].every((rows) => unique(rows.map((row) => row.id)))) learningError('Duplicate store identities.');
  for (const evidence of state.evidence) {
    const { digest, ...data } = evidence;
    if (learningDigest(data) !== digest) learningError('Evidence integrity mismatch.');
  }
  for (const revision of state.revisions) {
    if ((revision.content.kind === 'user-profile' && identity.scope !== 'global') || (revision.content.kind === 'project-brief' && identity.scope !== 'project')) learningError('Core memory scope mismatch.');
    if (!state.lessons.some((lesson) => lesson.id === revision.lessonId) || learningDigest({ content: revision.content, evidenceIds: revision.evidenceIds }) !== revision.contentDigest) learningError('Revision integrity mismatch.');
  }
  for (const lesson of state.lessons) {
    if (!state.revisions.some((revision) => revision.id === lesson.activeRevisionId && revision.lessonId === lesson.id) || state.revisions.filter((revision) => revision.lessonId === lesson.id).length > LEARNING_LIMITS.revisions) learningError('Invalid active revision or revision limit reached.');
  }
  for (const draft of state.drafts) {
    if (learningDigest({ content: draft.content, evidenceIds: draft.evidenceIds }) !== draft.digest) learningError('Draft integrity mismatch.');
  }
  return state;
}

export class LearningRepository {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly emptyEpochs = new Map<string, string>();
  constructor(private readonly dataRoot = fateDataRoot()) {}

  async flush(): Promise<void> { await Promise.all(this.queues.values()); }

  snapshotPath(identity: LearningStoreIdentity): string { return path.join(this.directory(identity), 'current.json'); }

  directory(identity: LearningStoreIdentity): string {
    return path.join(this.dataRoot, 'learning', 'v1', identity.scope === 'global' ? 'global' : `projects/${identity.projectKey}`);
  }

  private async ensureDirectory(identity: LearningStoreIdentity): Promise<string> {
    await fs.mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    const root = await fs.realpath(this.dataRoot);
    const parts = ['learning', 'v1', ...(identity.scope === 'global' ? ['global'] : ['projects', identity.projectKey])];
    let directory = root;
    for (const part of parts) {
      directory = path.join(directory, part);
      await fs.mkdir(directory, { mode: 0o700 }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || path.normalize(await fs.realpath(directory)) !== path.normalize(directory)) learningError('Unsafe store directory.');
    }
    return directory;
  }

  async read(identity: LearningStoreIdentity): Promise<LearningSnapshot> {
    const directory = await this.ensureDirectory(identity);
    try {
      const bytes = await readLearningFile(path.join(directory, 'current.json'), LEARNING_LIMITS.snapshotBytes);
      return validateLearningSnapshot(JSON.parse(bytes.toString('utf8')), identity);
    } catch (error) {
      if (!isMissing(error)) learningError('Store is corrupt, oversized, unsafe, or uses an unsupported version. Writes and attachment are unavailable; original bytes are intact.');
      const snapshot = emptyLearningSnapshot(identity);
      const epoch = this.emptyEpochs.get(directory) ?? snapshot.epoch;
      this.emptyEpochs.set(directory, epoch);
      return { ...snapshot, epoch };
    }
  }

  async recoveryDigest(identity: LearningStoreIdentity): Promise<string | null> {
    try { return learningDigest((await readLearningFile(path.join(await this.ensureDirectory(identity), 'current.json'), LEARNING_LIMITS.snapshotBytes)).toString('utf8')); }
    catch { return null; }
  }

  async lockDigest(identity: LearningStoreIdentity): Promise<string | null> {
    try { return learningDigest((await readLearningFile(path.join(await this.ensureDirectory(identity), 'writer.lock', 'owner.json'), 1024)).toString('utf8')); }
    catch { return null; }
  }

  private async locked<T>(identity: LearningStoreIdentity, operation: (directory: string) => Promise<T>): Promise<T> {
    const directory = await this.ensureDirectory(identity);
    const lock = path.join(directory, 'writer.lock');
    try { await fs.mkdir(lock, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') learningError('Store is locked by another writer. Retry, or explicitly recover after that process has stopped.'); throw error; }
    const owner = JSON.stringify({ pid: process.pid, host: os.hostname(), token: randomUUID() });
    try {
      await fs.writeFile(path.join(lock, 'owner.json'), owner, { flag: 'wx', mode: 0o600 });
      return await operation(directory);
    } finally {
      // Only remove our own lock, never one swapped in by a different process.
      const current = await readLearningFile(path.join(lock, 'owner.json'), 1024).catch(() => null);
      if (current?.toString('utf8') === owner) {
        await fs.unlink(path.join(lock, 'owner.json'));
        await fs.rmdir(lock);
      }
    }
  }

  private serialize<T>(identity: LearningStoreIdentity, operation: () => Promise<T>): Promise<T> {
    const key = this.directory(identity);
    const result = (this.queues.get(key) ?? Promise.resolve()).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.queues.set(key, settled);
    void settled.then(() => { if (this.queues.get(key) === settled) this.queues.delete(key); });
    return result;
  }

  async mutate(identity: LearningStoreIdentity, expected: { epoch: string; revision: number } | null, mutate: (state: LearningSnapshot, companions: LearningSnapshot[]) => void | Promise<void>, companion?: LearningStoreIdentity): Promise<LearningSnapshot> {
    const transaction = () => this.locked(identity, async (directory) => {
      const current = await this.read(identity);
      const extra = companion ? await this.read(companion).catch(() => null) : null;
      if (expected && (current.revision !== expected.revision || current.epoch !== expected.epoch)) learningError('The store changed. Refresh and review the current revision before trying again.');
      const next = structuredClone(current);
      await mutate(next, extra ? [extra] : []);
      next.revision += 1;
      next.manifests = next.manifests.filter((item) => item.createdAt >= Date.now() - LEARNING_LIMITS.retentionMs).slice(-LEARNING_LIMITS.manifests);
      next.generationUsage = next.generationUsage.slice(-100);
      const validated = validateLearningSnapshot(next, identity);
      await this.replace(directory, validated);
      this.emptyEpochs.delete(directory);
      return validated;
    });
    return this.serialize(identity, () => companion ? this.locked(companion, transaction) : transaction());
  }

  private async replace(directory: string, next: LearningSnapshot): Promise<void> {
    const bytes = Buffer.from(`${JSON.stringify(next)}\n`, 'utf8');
    if (bytes.byteLength > LEARNING_LIMITS.snapshotBytes) learningError('Store is full. Delete items before saving; approved revisions are never silently pruned.');
    const target = path.join(directory, 'current.json');
    const temp = path.join(directory, `snapshot-${process.pid}-${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      const stat = await fs.lstat(target).catch((error: unknown) => { if (isMissing(error)) return null; throw error; });
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) learningError('Unsafe snapshot target.');
      if (path.normalize(await fs.realpath(directory)) !== path.normalize(directory)) learningError('Store directory changed before writing.');
      await fs.rename(temp, target);
      if (process.platform !== 'win32') {
        const parent = await fs.open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally { await fs.unlink(temp).catch((error: unknown) => { if (!isMissing(error)) throw error; }); }
  }

  async resetCorrupt(identity: LearningStoreIdentity, expectedDigest: string): Promise<void> {
    await this.serialize(identity, () => this.locked(identity, async (directory) => {
      if (await this.recoveryDigest(identity) !== expectedDigest) learningError('Recovery preview changed. Refresh before resetting.');
      await this.replace(directory, emptyLearningSnapshot(identity));
    }));
  }

  async recoverLock(identity: LearningStoreIdentity, expectedDigest: string): Promise<void> {
    const directory = await this.ensureDirectory(identity);
    const lock = path.join(directory, 'writer.lock');
    const stat = await fs.lstat(lock);
    if (!stat.isDirectory() || stat.isSymbolicLink()) learningError('Unsafe lock; manual recovery is required.');
    const bytes = await readLearningFile(path.join(lock, 'owner.json'), 1024);
    if (learningDigest(bytes.toString('utf8')) !== expectedDigest) learningError('Lock ownership changed. Refresh before recovery.');
    const owner = JSON.parse(bytes.toString('utf8')) as { pid?: unknown; host?: unknown };
    if (owner.host !== os.hostname() || typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) learningError('Owner death cannot be established. Leave the lock intact and recover manually.');
    try { process.kill(owner.pid, 0); learningError('Writer is still alive. Its lock cannot be recovered.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    if (await this.lockDigest(identity) !== expectedDigest) learningError('Lock ownership changed.');
    await fs.unlink(path.join(lock, 'owner.json'));
    await fs.rmdir(lock);
  }
}
