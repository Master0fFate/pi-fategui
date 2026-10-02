import { constants, promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { assertPrivateWindowsAcl } from './WindowsPrivateAcl';

export const MIGRATION_MAX_FILES = 10_000;
export const MIGRATION_MAX_JSON_BYTES = 64 * 1024 * 1024;
export const MIGRATION_MAX_RECORD_BYTES = 16 * 1024 * 1024;
export interface MigrationFile {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly device: string;
  readonly inode: string;
  readonly modified: number;
}
export const migrationHash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
export function overlaps(left: string, right: string): boolean { return contains(left, right) || contains(right, left); }
export async function exists(target: string): Promise<boolean> {
  try { await fs.lstat(target); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Resolve nothing through links, including existing ancestors of a missing path. Never creates a path. */
export async function assertMigrationPath(target: string, allowMissing = false): Promise<void> {
  if (!path.isAbsolute(target) || path.normalize(target) !== target || /[\u0000\r\n]/u.test(target)) throw new Error('Migration paths must be normalized absolute local paths.');
  if (process.platform === 'win32' && target.startsWith('\\\\')) throw new Error('Migration requires local storage.');
  let current = path.parse(target).root;
  const segments = target.slice(current.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]!);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || index < segments.length - 1 && !stat.isDirectory()) throw new Error('Migration refuses symbolic links and non-directory ancestors.');
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}
export async function assertPrivateMigrationPath(target: string, directory: boolean): Promise<void> {
  await assertMigrationPath(target);
  const stat = await fs.lstat(target);
  if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
    || process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('Migration storage must be private, regular and unaliased.');
  await assertPrivateWindowsAcl(target);
}
export async function privateMigrationDirectory(target: string): Promise<void> {
  await assertMigrationPath(target, true);
  await fs.mkdir(target, { mode: 0o700 });
  await assertPrivateMigrationPath(target, true);
  await syncMigrationDirectory(path.dirname(target));
}
export async function syncMigrationDirectory(target: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fs.open(target, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
export async function writeMigrationRecord(target: string, value: unknown): Promise<void> {
  await assertPrivateMigrationPath(path.dirname(target), true);
  if (await exists(target)) await assertPrivateMigrationPath(target, false);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Migration manifest exceeds its bound.');
  const temp = `${target}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temp, target); await syncMigrationDirectory(path.dirname(target));
}
export async function readMigrationJson(target: string, maximum = MIGRATION_MAX_JSON_BYTES): Promise<unknown> {
  await assertPrivateMigrationPath(target, false);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) throw new Error('Migration record is empty or oversized.');
    const bytes = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    if (length !== stat.size) throw new Error('Migration source changed while reading.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown;
  } finally { await handle.close(); }
}

/** Fixed-size reads; transcript size never determines memory allocation. Callback retains at most one record. */
export async function fingerprintMigrationFile(target: string, name: string, onLine?: (value: unknown) => void): Promise<MigrationFile> {
  await assertPrivateMigrationPath(target, false);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 8 * 1024 ** 3) throw new Error('Migration source file exceeds its supported bound.');
    const hash = createHash('sha256'); const buffer = Buffer.alloc(64 * 1024); let total = 0; let pending = Buffer.alloc(0);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
      total += bytesRead; const chunk = buffer.subarray(0, bytesRead); hash.update(chunk);
      if (onLine) {
        let start = 0;
        for (let index = 0; index < chunk.length; index++) if (chunk[index] === 10) {
          const segment = chunk.subarray(start, index);
          if (pending.length + segment.length > MIGRATION_MAX_RECORD_BYTES) throw new Error('Migration JSONL record is oversized.');
          const line = pending.length ? Buffer.concat([pending, segment]) : segment;
          if (!line.length) throw new Error('Migration JSONL contains an empty record.');
          onLine(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)) as unknown);
          pending = Buffer.alloc(0); start = index + 1;
        }
        if (start < chunk.length) {
          if (pending.length + chunk.length - start > MIGRATION_MAX_RECORD_BYTES) throw new Error('Migration JSONL record is oversized.');
          pending = Buffer.concat([pending, chunk.subarray(start)]);
        }
      }
    }
    if (pending.length) throw new Error('Migration JSONL has an incomplete final record; preserve it for review.');
    const after = await handle.stat(); const current = await fs.lstat(target);
    if (total !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()) throw new Error('Migration source changed while reading.');
    return { name, bytes: total, sha256: hash.digest('hex'), device: String(before.dev), inode: String(before.ino), modified: before.mtimeMs };
  } finally { await handle.close(); }
}
export async function listMigrationFiles(root: string, optional = false): Promise<string[]> {
  if (optional && !await exists(root)) return [];
  await assertPrivateMigrationPath(root, true);
  const files: string[] = []; let count = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 12) throw new Error('Migration namespace nesting exceeds its bound.');
    const entries = await fs.opendir(directory);
    for await (const entry of entries) {
      if (++count > MIGRATION_MAX_FILES) throw new Error('Migration namespace exceeds its entry bound.');
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) { await assertPrivateMigrationPath(target, true); await visit(target, depth + 1); }
      else if (entry.isFile()) { await assertPrivateMigrationPath(target, false); files.push(target); }
      else throw new Error('Migration namespace contains a symbolic link or special file.');
    }
  };
  await visit(root, 0); return files.sort();
}
