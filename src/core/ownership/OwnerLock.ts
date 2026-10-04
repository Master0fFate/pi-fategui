import { randomUUID, createHash } from 'node:crypto';
import { promises as fs, readFileSync, readlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Advisory locks cooperate only with other Fate v2 processes. A lock is never taken from an owner
 * that may still run, and never on a heartbeat or an age. It is recovered only when the operating
 * system itself reports that the recorded owner process no longer exists on this host.
 */
export interface OwnerRecord {
  version: 1;
  resource: string;
  host: string;
  pid: number;
  startedAt: number;
  startIdentity: string;
  token: string;
  /** A record without it is never recovered automatically. */
  platform?: string;
  /** Linux: tells another machine, a restarted host, another PID namespace and a reused PID from the owner. */
  linux?: LinuxProcessIdentity;
}

interface LinuxProcessIdentity { machineId: string; bootId: string; pidNamespace: string; startTicks: string }

const TOKEN_PATTERN = String.raw`[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}`;
const RECORD_NAME = new RegExp(`^owner-(${TOKEN_PATTERN})\\.json$`, 'u');
/** Written beside the record when a stopped owner must still be reviewed by an operator. */
const REVIEW_FILE = 'review-required.json';
const MAX_RECORD_BYTES = 4096;

const startIdentity = randomUUID();
const startedAt = Date.now();

export class OwnershipConflict extends Error {
  constructor(readonly lockPath: string, readonly diagnostic: string) {
    super(`Owner already in use (${lockPath}). ${diagnostic} A lock is recovered automatically only when its owner process no longer exists on this host. Stop all possible owners before explicit operator recovery; never remove this lock based on a heartbeat or its age.`);
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

/**
 * The record file of one owner. Its name carries the owner's token, so a late judgement about a
 * stopped owner can never address the record of the owner that came after it.
 */
export function ownerRecordPath(lockPath: string, token: string): string {
  return path.join(lockPath, `owner-${token}.json`);
}

/** The single owner record in a lock directory, or null. For diagnostics and tests. */
export async function findOwnerRecord(lockPath: string): Promise<string | null> {
  const names = (await fs.readdir(lockPath)).filter((name) => RECORD_NAME.test(name));
  return names.length === 1 ? path.join(lockPath, names[0]!) : null;
}

async function privateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    throw new Error(`Ownership directory must be a private regular directory: ${directory}`);
  }
}

/** The PID that /proc reports and the kernel start time: stable for a process, different for a later process with the same PID. */
function linuxProcess(pid: number | 'self'): { pid: string; startTicks: string } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name may contain spaces and parentheses; the fields before and after it do not.
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return ticks && /^\d+$/u.test(ticks) ? { pid: stat.slice(0, stat.indexOf(' ')), startTicks: ticks } : null;
  } catch { return null; }
}

let linuxSelf: LinuxProcessIdentity | null | undefined;
function linuxIdentity(): LinuxProcessIdentity | null {
  if (linuxSelf !== undefined) return linuxSelf;
  try {
    const self = linuxProcess('self');
    // Some container images and distributions have no machine identity. It is needed only to
    // tell a restart of this host from another machine.
    let machineId = '';
    try { machineId = readFileSync('/etc/machine-id', 'utf8').trim(); } catch { /* None on this host. */ }
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const pidNamespace = readlinkSync('/proc/self/ns/pid');
    // A /proc that belongs to another PID namespace describes other processes. No judgement from it.
    linuxSelf = self && self.pid === String(process.pid) && bootId && pidNamespace
      ? { machineId, bootId, pidNamespace, startTicks: self.startTicks } : null;
  } catch { linuxSelf = null; }
  return linuxSelf;
}

/** True only when the operating system reports that no process has this PID. */
function noSuchProcess(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

function parseRecord(content: string): OwnerRecord | null {
  let value: unknown;
  try { value = JSON.parse(content); } catch { return null; }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Partial<OwnerRecord>;
  if (record.version !== 1 || typeof record.host !== 'string' || typeof record.platform !== 'string' || typeof record.token !== 'string'
    || typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0) return null;
  if (record.linux !== undefined) {
    const linux = record.linux as Partial<LinuxProcessIdentity> | null;
    if (!linux || typeof linux.machineId !== 'string' || typeof linux.bootId !== 'string' || typeof linux.pidNamespace !== 'string'
      || typeof linux.startTicks !== 'string') return null;
  }
  return record as OwnerRecord;
}

/**
 * Proof that the recorded owner no longer exists. A record from another host or platform, an
 * unreadable record, and a PID that any process holds (a reused PID included, except on Linux
 * where the kernel start time tells them apart) all leave the owner standing.
 */
function ownerHasStopped(record: OwnerRecord): boolean {
  if (record.host !== os.hostname() || record.platform !== process.platform) return false;
  if (process.platform !== 'linux') return noSuchProcess(record.pid);
  const here = linuxIdentity();
  // An owner in another PID namespace (a container) can run without being visible here.
  if (!here || !record.linux || record.linux.pidNamespace !== here.pidNamespace) return false;
  // Another boot identity is a restart of this host, where no earlier process survives, only
  // when the machine is provably the same. Another machine with the same name stays untouched.
  if (record.linux.bootId !== here.bootId) return here.machineId !== '' && record.linux.machineId === here.machineId;
  const current = linuxProcess(record.pid);
  return current === null ? noSuchProcess(record.pid) : current.startTicks !== record.linux.startTicks;
}

/**
 * Remove one entry of a stopped owner's lock. Only the start that holds the recovery claim calls
 * this, so a short wait is safe: on Windows a scanner or a reader can hold a file or a
 * just-emptied directory open for a moment, and a pending deletion makes a directory look
 * non-empty.
 */
async function removeClaimed(remove: () => Promise<void>): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try { await remove(); return true; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return true;
      if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES' && code !== 'ENOTEMPTY') || attempt >= 9) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/**
 * Remove the lock of an owner that provably stopped (a crash, a forced kill, a power loss).
 * Returns true when the caller may try to take the lock again.
 *
 * The lock directory must hold exactly one record. A review marker, an unknown entry or a missing
 * record stays with an operator. The one step that only one start can take is a hard link to that
 * record. It must be a creation: on Windows two overlapping deletions or renames of one file can
 * both report success, and a creation cannot. The record name carries the stopped owner's token,
 * so the link fails for a second start and fails once that record is gone: however late a
 * judgement is acted on, it cannot touch a later owner. Only the start that holds the link
 * removes the record and then the directory. A filesystem without hard links recovers nothing.
 */
async function recoverStoppedOwner(lockPath: string): Promise<boolean> {
  let entries: string[];
  try {
    const stat = await fs.lstat(lockPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    entries = await fs.readdir(lockPath);
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; } // Released in the meantime.
  const name = entries[0];
  const token = entries.length === 1 && name !== undefined ? RECORD_NAME.exec(name)?.[1] : undefined;
  if (name === undefined || token === undefined) return false;
  const file = path.join(lockPath, name);
  let content: string;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return false;
    content = await fs.readFile(file, 'utf8');
  } catch { return false; }
  const record = parseRecord(content);
  if (!record || record.token !== token || !ownerHasStopped(record)) return false;
  const claim = path.join(lockPath, `recovering-${token}`);
  try { await fs.link(file, claim); } catch { return false; } // Another start holds it, or the record is gone.
  // The record goes before the claim: while either exists, no other start can pass the step above.
  if (!await removeClaimed(() => fs.unlink(file))) { await fs.unlink(claim).catch(() => undefined); return false; }
  if (!await removeClaimed(() => fs.unlink(claim))) return false;
  return removeClaimed(() => fs.rmdir(lockPath));
}

async function diagnostic(lockPath: string): Promise<string> {
  try {
    const stat = await fs.lstat(lockPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 'Lock entry is not a regular directory; inspect it manually.';
    const file = await findOwnerRecord(lockPath);
    if (!file) return 'Owner record is absent or unreadable; treat ownership as uncertain.';
    const content = await fs.readFile(file, 'utf8');
    if (content.length > MAX_RECORD_BYTES) return 'Owner record is oversized; inspect it manually.';
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

  /** The record file of this owner. */
  get recordPath(): string { return ownerRecordPath(this.lockPath, this.record.token); }

  static async acquire(namespace: string, kind: string, resource: string): Promise<OwnerLock> {
    if (!path.isAbsolute(namespace) || !path.isAbsolute(resource) || !/^[a-z-]+$/u.test(kind)) throw new Error('Ownership requires absolute host paths and a fixed lock kind.');
    await privateDirectory(namespace);
    const lockPath = path.join(namespace, `${kind}-${lockName(path.normalize(resource))}.lock`);
    for (let recovered = false; ; recovered = true) {
      try { await fs.mkdir(lockPath, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // One recovery for each acquisition. A second conflict is a running or uncertain owner.
        if (recovered || !await recoverStoppedOwner(lockPath)) throw new OwnershipConflict(lockPath, await diagnostic(lockPath));
      }
    }
    const linux = process.platform === 'linux' ? linuxIdentity() : null;
    const record: OwnerRecord = { version: 1, resource: path.normalize(resource), host: os.hostname(), pid: process.pid, startedAt, startIdentity, token: randomUUID(),
      platform: process.platform, ...(linux ? { linux } : {}) };
    try {
      const handle = await fs.open(ownerRecordPath(lockPath, record.token), 'wx', 0o600);
      // Durable at once: a power loss must not leave a record that nobody can read.
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      // A failed record write is uncertain: leave the exclusive directory for operator review.
      throw new AggregateError([error], `Ownership record write failed at ${lockPath}; inspect before recovery.`);
    }
    return new OwnerLock(lockPath, record);
  }

  /**
   * Keep this lock for an operator even after this process stops. Use it only when a later start
   * could harm data (a storage close that could not be confirmed), not for an ordinary failed stop:
   * that case must stay recoverable, or a forced quit locks the profile for good.
   */
  async requireOperatorReview(): Promise<void> {
    if (this.released) return;
    const marker = path.join(this.lockPath, REVIEW_FILE);
    try { await fs.writeFile(marker, JSON.stringify({ version: 1, token: this.record.token, at: Date.now(), record: this.record }), { mode: 0o600 }); }
    catch (error) {
      // A full or failing disk is a likely cause of the unconfirmed close. A rename needs no new
      // data block, and a record under another name is not recovered either.
      try { await fs.rename(this.recordPath, marker); } catch { throw error; }
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    let value: unknown;
    try { value = JSON.parse(await fs.readFile(this.recordPath, 'utf8')); }
    catch { throw new Error(`Cannot verify owner token at ${this.lockPath}; ownership retained for operator review.`); }
    if (typeof value !== 'object' || value === null || (value as OwnerRecord).token !== this.record.token) {
      throw new Error(`Owner token changed at ${this.lockPath}; refusing to release another owner.`);
    }
    // A lock marked for operator review is never released by code, this owner included.
    try { await fs.lstat(path.join(this.lockPath, REVIEW_FILE)); throw new Error(`Owner lock at ${this.lockPath} is retained for operator review.`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Cooperating processes never replace a held directory. Operators must stop owners before recovery.
    await fs.unlink(this.recordPath);
    await fs.rmdir(this.lockPath);
    this.released = true;
  }
}
