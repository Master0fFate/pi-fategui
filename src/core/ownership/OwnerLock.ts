import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Advisory locks cooperate only with other Fate v2 processes. No PID/heartbeat auto-recovery. */
export interface OwnerRecord {
  version: 1;
  resource: string;
  host: string;
  pid: number;
  startedAt: number;
  startIdentity: string;
  token: string;
}

const startIdentity = randomUUID();
const startedAt = Date.now();

export class OwnershipConflict extends Error {
  constructor(readonly lockPath: string, readonly diagnostic: string) {
    super(`Owner already in use (${lockPath}). ${diagnostic} Stop all possible owners before explicit operator recovery; never remove this lock based only on a PID or heartbeat.`);
  }
}

export async function canonicalFuturePath(target: string): Promise<string> {
  let cursor = path.resolve(target);
  const suffix: string[] = [];
  for (;;) {
    try { return path.join(await fs.realpath(cursor), ...suffix.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export function lockName(resource: string): string {
  return createHash('sha256').update(process.platform === 'win32' ? resource.toLowerCase() : resource).digest('hex');
}

async function privateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    throw new Error(`Ownership directory must be a private regular directory: ${directory}`);
  }
}

async function diagnostic(lockPath: string): Promise<string> {
  try {
    const stat = await fs.lstat(lockPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 'Lock entry is not a regular directory; inspect it manually.';
    const content = await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8');
    if (content.length > 4096) return 'Owner record is oversized; inspect it manually.';
    const record: unknown = JSON.parse(content);
    if (typeof record === 'object' && record !== null && 'version' in record && 'host' in record && 'pid' in record && 'startedAt' in record) {
      const owner = record as Record<string, unknown>;
      return `Recorded owner: version=${String(owner.version).slice(0, 16)}, host=${String(owner.host).slice(0, 128)}, pid=${String(owner.pid).slice(0, 32)}, startedAt=${String(owner.startedAt).slice(0, 32)}. This is diagnostic evidence, not proof of liveness.`;
    }
  } catch { /* An incomplete record remains an uncertain owner. */ }
  return 'Owner record is absent or unreadable; treat ownership as uncertain.';
}

export class OwnerLock {
  private released = false;
  private constructor(readonly lockPath: string, readonly record: OwnerRecord) {}

  static async acquire(namespace: string, kind: string, resource: string): Promise<OwnerLock> {
    if (!path.isAbsolute(namespace) || !path.isAbsolute(resource) || !/^[a-z-]+$/u.test(kind)) throw new Error('Ownership requires absolute host paths and a fixed lock kind.');
    await privateDirectory(namespace);
    const lockPath = path.join(namespace, `${kind}-${lockName(path.normalize(resource))}.lock`);
    try { await fs.mkdir(lockPath, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new OwnershipConflict(lockPath, await diagnostic(lockPath));
      throw error;
    }
    const record: OwnerRecord = { version: 1, resource: path.normalize(resource), host: os.hostname(), pid: process.pid, startedAt, startIdentity, token: randomUUID() };
    try {
      await fs.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      // A failed record write is uncertain: leave the exclusive directory for operator review.
      throw new AggregateError([error], `Ownership record write failed at ${lockPath}; inspect before recovery.`);
    }
    return new OwnerLock(lockPath, record);
  }

  async release(): Promise<void> {
    if (this.released) return;
    let value: unknown;
    try { value = JSON.parse(await fs.readFile(path.join(this.lockPath, 'owner.json'), 'utf8')); }
    catch { throw new Error(`Cannot verify owner token at ${this.lockPath}; ownership retained for operator review.`); }
    if (typeof value !== 'object' || value === null || (value as OwnerRecord).token !== this.record.token) {
      throw new Error(`Owner token changed at ${this.lockPath}; refusing to release another owner.`);
    }
    // Cooperating processes never replace a held directory. Operators must stop owners before recovery.
    await fs.unlink(path.join(this.lockPath, 'owner.json'));
    await fs.rmdir(this.lockPath);
    this.released = true;
  }
}
