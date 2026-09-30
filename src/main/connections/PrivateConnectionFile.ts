import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { assertPrivateWindowsAcl } from '../../core/storage/WindowsPrivateAcl';

const unavailable = () => new Error('Private desktop connection state is unavailable.');
/** Main-owned typed stores call these helpers. No renderer path reaches them. */
export async function readPrivateConnectionJson(file: string, maxBytes: number): Promise<unknown | undefined> {
  if (!path.isAbsolute(file) || path.normalize(file) !== file) throw unavailable();
  let before;
  try { before = await fs.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw unavailable(); }
  try {
    const parent = await fs.lstat(path.dirname(file));
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maxBytes
      || !parent.isDirectory() || parent.isSymbolicLink()
      || process.platform !== 'win32' && ((parent.mode | before.mode) & 0o077) !== 0) throw unavailable();
    await assertPrivateWindowsAcl(path.dirname(file)); await assertPrivateWindowsAcl(file);
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const live = await handle.stat();
      if (!live.isFile() || live.size !== before.size || live.ino !== before.ino || live.dev !== before.dev) throw unavailable();
      const bytes = Buffer.alloc(maxBytes + 1), read = await handle.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead !== before.size) throw unavailable();
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, read.bytesRead))) as unknown;
    } finally { await handle.close(); }
  } catch { throw unavailable(); }
}
export async function writePrivateConnectionJson(file: string, value: unknown, maxBytes: number,
  live: () => boolean = () => true): Promise<void> {
  if (!live()) throw unavailable();
  if (!path.isAbsolute(file) || path.normalize(file) !== file) throw unavailable();
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw unavailable();
  const parent = path.dirname(file), temporary = path.join(parent, `.connection-${randomUUID()}.tmp`);
  try {
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = await fs.lstat(parent);
    if (!directory.isDirectory() || directory.isSymbolicLink() || process.platform !== 'win32' && (directory.mode & 0o077) !== 0) throw unavailable();
    await assertPrivateWindowsAcl(parent);
    let existing;
    try { existing = await fs.lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw unavailable(); }
    if (existing && (!existing.isFile() || existing.isSymbolicLink()
      || process.platform !== 'win32' && (existing.mode & 0o077) !== 0)) throw unavailable();
    if (existing) await assertPrivateWindowsAcl(file);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await assertPrivateWindowsAcl(temporary);
    if (!live()) throw unavailable();
    await fs.rename(temporary, file);
    if (process.platform !== 'win32') {
      const dir = await fs.open(parent, 'r'); try { await dir.sync(); } finally { await dir.close(); }
    }
  } catch { throw unavailable(); }
  finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
}
