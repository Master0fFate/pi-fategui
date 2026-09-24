import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const MAX_BYTES = 1024 * 1024;
const idPattern = /^[a-zA-Z0-9_-]{1,80}$/u;
const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export interface DefinitionDraft {
  metadata: Record<string, unknown>;
  body: string;
}
export interface DefinitionSnapshot extends DefinitionDraft {
  revision: number;
  digest: string;
}
interface Head { revision: number; digest: string; file: string }
interface LockOptions { recoverDeadWriter?: boolean }

// JSON is the deliberately supported YAML subset; unknown fields survive UI edits.
export function encodeDefinition(draft: DefinitionDraft): string {
  const source = `---\n${JSON.stringify(draft.metadata, null, 2)}\n---\n${draft.body}`;
  if (Buffer.byteLength(source) > MAX_BYTES) throw new Error('Definition exceeds 1 MiB.');
  return source;
}
export function decodeDefinition(source: string): DefinitionDraft {
  if (Buffer.byteLength(source) > MAX_BYTES || !source.startsWith('---\n')) throw new Error('Unsupported definition envelope. Original data was preserved.');
  const boundary = source.indexOf('\n---\n', 4);
  if (boundary < 0) throw new Error('Definition has no closing frontmatter delimiter.');
  const metadata: unknown = JSON.parse(source.slice(4, boundary));
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Frontmatter must be a JSON object.');
  return { metadata: metadata as Record<string, unknown>, body: source.slice(boundary + 5) };
}

/** Append-only definition versions; user-authored Markdown is never replaced. */
export class DefinitionJournal {
  constructor(private readonly root: string, private readonly stateHistoryLimit?: number, private readonly anchor = root) {}

  private async directory(id?: string): Promise<string> {
    if (id !== undefined && !idPattern.test(id)) throw new Error('Invalid definition identity.');
    // The configured app-data anchor is trusted; every managed descendant is not.
    // Canonicalizing its parent also permits OS aliases such as macOS /var -> /private/var.
    const anchor = path.resolve(this.anchor);
    await fs.mkdir(anchor, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(anchor)).isSymbolicLink()) throw new Error('Linked definition directory is not allowed.');
    const relative = path.relative(anchor, path.resolve(this.root));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Store is outside its app-data anchor.');
    let current = await fs.realpath(anchor);
    for (const part of relative.split(path.sep).filter(Boolean).concat(id === undefined ? [] : [id])) {
      current = path.join(current, part);
      await fs.mkdir(current, { mode: 0o700 }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked definition directory is not allowed.');
    }
    return current;
  }

  private async readFile(file: string): Promise<string> {
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES) throw new Error('Unsafe or oversized definition file.');
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error('Definition changed during open.');
      const bytes = Buffer.alloc(opened.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat();
      const named = await fs.lstat(file);
      if (offset !== opened.size || after.mtimeMs !== opened.mtimeMs || named.ino !== opened.ino || named.dev !== opened.dev || named.isSymbolicLink()) throw new Error('Definition changed during read.');
      return bytes.subarray(0, offset).toString('utf8');
    } finally { await handle.close(); }
  }

  private async readHead(directory: string): Promise<Head | null> {
    let source: string;
    try { source = await this.readFile(path.join(directory, 'head.json')); }
    catch (error) { if (missing(error)) return null; throw error; }
    const head = JSON.parse(source) as Head;
    if (!Number.isSafeInteger(head.revision) || head.revision < 1 || !/^[a-f0-9]{64}$/u.test(head.digest) || head.file !== `${head.revision}-${head.digest}.md`) throw new Error('Corrupt definition head. Original data was preserved.');
    return head;
  }

  private async snapshot(directory: string): Promise<DefinitionSnapshot | null> {
    const head = await this.readHead(directory);
    if (!head) return null;
    const source = await this.readFile(path.join(directory, head.file));
    // External edits are visible, but a save requires the exact bytes last read.
    return { ...decodeDefinition(source), revision: head.revision, digest: digest(source) };
  }

  async ids(limit = 1000): Promise<string[]> {
    const entries = await fs.readdir(await this.directory(), { withFileTypes: true });
    if (entries.length > limit) throw new Error('Store exceeds its item limit. Original records were preserved.');
    return entries.map((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !idPattern.test(entry.name)) throw new Error('Unsafe store entry. Original records were preserved.');
      return entry.name;
    });
  }

  async read(id: string): Promise<DefinitionSnapshot | null> {
    if (!idPattern.test(id)) throw new Error('Invalid definition identity.');
    const directory = path.join(await this.directory(), id);
    const stat = await fs.lstat(directory).catch((error: unknown) => { if (missing(error)) return null; throw error; });
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked definition directory is not allowed.');
    return this.snapshot(directory);
  }

  private async recoverDeadWriterLock(lock: string): Promise<boolean> {
    const source = await this.readFile(lock).catch(() => null);
    if (!source) return false;
    let owner: { pid?: unknown; host?: unknown };
    try { owner = JSON.parse(source) as { pid?: unknown; host?: unknown }; }
    catch { return false; }
    if (owner.host !== os.hostname() || typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
    try { process.kill(owner.pid, 0); return false; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
    }
    if (await this.readFile(lock).catch(() => null) !== source) return false;
    await fs.unlink(lock).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    return true;
  }

  async withLock<T>(id: string, operation: () => Promise<T>, options: LockOptions = {}): Promise<T> {
    const lock = path.join(await this.directory(id), 'writer.lock');
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try { handle = await fs.open(lock, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !options.recoverDeadWriter || !await this.recoverDeadWriterLock(lock)) throw error;
      return this.withLock(id, operation, options);
    }
    const owner = JSON.stringify({ token: randomUUID(), pid: process.pid, host: os.hostname() });
    try { await handle.writeFile(owner); await handle.sync(); return await operation(); }
    finally {
      await handle.close();
      if (await this.readFile(lock).catch(() => null) === owner) await fs.unlink(lock);
    }
  }

  async recoveryCandidates(id: string): Promise<Array<{ file: string; digest: string; valid: boolean }>> {
    const directory = await this.directory(id);
    const files = (await fs.readdir(directory)).filter((file) => /^\d+-[a-f0-9]{64}\.md$/u.test(file));
    if (files.length > 1000) throw new Error('Too many recovery candidates; manual recovery required.');
    const results = [];
    for (const file of files.sort()) {
      const source = await this.readFile(path.join(directory, file));
      let valid = true;
      try { decodeDefinition(source); } catch { valid = false; }
      results.push({ file, digest: digest(source), valid });
    }
    return results;
  }

  async recoverWriterLock(id: string, expectedDigest: string): Promise<void> {
    const lock = path.join(await this.directory(id), 'writer.lock');
    const source = await this.readFile(lock);
    if (digest(source) !== expectedDigest) throw new Error('Writer lock changed since preview.');
    const owner = JSON.parse(source) as { pid?: unknown; host?: unknown };
    if (owner.host !== os.hostname() || typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Cannot prove writer death.');
    try { process.kill(owner.pid, 0); throw new Error('Writer is still alive.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    if (await this.readFile(lock) !== source) throw new Error('Writer lock changed during recovery.');
    await fs.unlink(lock);
  }

  async recoverHead(id: string, expectedHeadDigest: string, candidate: { file: string; digest: string }): Promise<void> {
    const directory = await this.directory(id);
    if (!/^\d+-[a-f0-9]{64}\.md$/u.test(candidate.file)) throw new Error('Invalid recovery candidate.');
    const lock = path.join(directory, 'writer.lock');
    const owner = await fs.open(lock, 'wx', 0o600);
    const ownerRecord = JSON.stringify({ token: randomUUID(), pid: process.pid, host: os.hostname() });
    const temp = path.join(directory, `${randomUUID()}.tmp`);
    try {
      await owner.writeFile(ownerRecord);
      const headPath = path.join(directory, 'head.json');
      const oldHead = await this.readFile(headPath);
      if (digest(oldHead) !== expectedHeadDigest) throw new Error('Recovery head changed since preview.');
      const source = await this.readFile(path.join(directory, candidate.file));
      if (digest(source) !== candidate.digest) throw new Error('Recovery candidate changed since preview.');
      const decoded = decodeDefinition(source);
      const candidates = await this.recoveryCandidates(id);
      const revision = Math.max(0, ...candidates.map((item) => Number(item.file.split('-')[0]))) + 1;
      if (!Number.isSafeInteger(revision)) throw new Error('Recovery revision overflow.');
      const restoredSource = typeof decoded.metadata.revision === 'number'
        ? encodeDefinition({ metadata: { ...decoded.metadata, revision }, body: decoded.body }) : source;
      const restoredDigest = digest(restoredSource);
      const file = `${revision}-${restoredDigest}.md`;
      const restored = await fs.open(path.join(directory, file), 'wx', 0o600);
      try { await restored.writeFile(restoredSource); await restored.sync(); } finally { await restored.close(); }
      const backup = path.join(directory, `head-backup-${expectedHeadDigest}.json`);
      try {
        const handle = await fs.open(backup, 'wx', 0o600);
        try { await handle.writeFile(oldHead); await handle.sync(); } finally { await handle.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await this.readFile(backup) !== oldHead) throw error;
      }
      const next = await fs.open(temp, 'wx', 0o600);
      try { await next.writeFile(JSON.stringify({ revision, digest: restoredDigest, file })); await next.sync(); } finally { await next.close(); }
      if (await this.readFile(headPath) !== oldHead || digest(await this.readFile(path.join(directory, candidate.file))) !== candidate.digest) throw new Error('Recovery source changed; all versions were preserved.');
      await fs.rename(temp, headPath);
    } finally {
      await owner.close();
      await fs.unlink(temp).catch((error: unknown) => { if (!missing(error)) throw error; });
      if (await this.readFile(lock).catch(() => null) === ownerRecord) await fs.unlink(lock);
    }
  }

  async save(id: string, expected: Pick<DefinitionSnapshot, 'revision' | 'digest'> | null, draft: DefinitionDraft): Promise<DefinitionSnapshot> {
    const directory = await this.directory(id);
    const lock = path.join(directory, 'writer.lock');
    // No age-based lock stealing: a sleeping writer may still own its transaction.
    const owner = await fs.open(lock, 'wx', 0o600).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Definition is locked; retry or recover after proving the writer stopped.');
      throw error;
    });
    const token = randomUUID();
    const ownerRecord = JSON.stringify({ token, pid: process.pid, host: os.hostname() });
    let temp: string | null = null;
    try {
      await owner.writeFile(ownerRecord);
      const current = await this.snapshot(directory);
      if (current?.revision !== expected?.revision || current?.digest !== expected?.digest) throw new Error('Definition conflict. Reload before saving.');
      const source = encodeDefinition(draft);
      const next = { revision: (current?.revision ?? 0) + 1, digest: digest(source) };
      const file = `${next.revision}-${next.digest}.md`;
      const version = await fs.open(path.join(directory, file), 'wx', 0o600);
      try { await version.writeFile(source); await version.sync(); } finally { await version.close(); }
      const checked = await this.snapshot(directory);
      if (checked?.revision !== current?.revision || checked?.digest !== current?.digest) throw new Error('Definition conflict. Both versions were preserved.');
      temp = path.join(directory, `${token}.tmp`);
      const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ ...next, file })); await handle.sync(); } finally { await handle.close(); }
      // Only the managed head is replaced. An external editor's old Markdown bytes remain intact.
      await fs.rename(temp, path.join(directory, 'head.json'));
      if (process.platform !== 'win32') {
        const parent = await fs.open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
      if (this.stateHistoryLimit !== undefined) {
        const oldestKept = next.revision - Math.max(2, this.stateHistoryLimit) + 1;
        for (const candidate of await fs.readdir(directory)) {
          const match = /^(\d+)-([a-f0-9]{64})\.md$/u.exec(candidate);
          if (!match || Number(match[1]) >= oldestKept) continue;
          const target = path.join(directory, candidate);
          // Only prune verified app-owned state revisions, never externally changed bytes.
          const previous = await this.readFile(target).catch(() => null);
          if (previous !== null && digest(previous) === match[2]) await fs.unlink(target).catch(() => undefined);
        }
      }
      return { ...decodeDefinition(source), ...next };
    } finally {
      await owner.close();
      if (temp) await fs.unlink(temp).catch((error: unknown) => { if (!missing(error)) throw error; });
      if (await this.readFile(lock).catch(() => null) === ownerRecord) await fs.unlink(lock);
    }
  }
}
