import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Storage } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { OwnerLock, canonicalFuturePath } from '../ownership/OwnerLock';
import { assertPrivateWindowsAcl, assertPrivateWindowsAcls, withPrivateWindowsAclScope } from '../storage/WindowsPrivateAcl';

export interface OwnedDurableStorageOptions {
  readonly dataRoot: string;
  /** Borrowed from the host. This factory never acquires or releases ownership. */
  readonly profileOwner: OwnerLock;
  /** A host-generated basename, never a renderer/network supplied path. */
  readonly filename: string;
}

export interface OwnedDurableStorage {
  readonly storage: Storage;
  readonly filename: string;
  readonly diagnostics: { readonly journalMode: 'wal'; readonly synchronous: 2; readonly sqliteVersion: string };
  /** Also call before accessing Session/Harness caches or admitting external effects. */
  assertOwnership(): Promise<void>;
}

/** Startup failed without confirmed backend closure: the host must retain ownership. */
export class DurableStorageCloseUncertainError extends AggregateError {
  constructor(errors: Iterable<unknown>, message: string) {
    super(errors, message);
    this.name = 'DurableStorageCloseUncertainError';
  }
}

// In addition to the profile lock, reject two Sessions with independent ID caches
// in one cooperating process. This is not a replacement for the profile lock.
const openFiles = new Set<string>();

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function privatePath(target: string, directory: boolean, checkAcl = true): Promise<void> {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
    || process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`Native durable storage requires a private ${directory ? 'directory' : 'regular file'}: ${target}`);
  }
  if (checkAcl) await assertPrivateWindowsAcl(target);
}

async function syncDirectory(target: string): Promise<void> {
  // Windows' SQLite VFS owns the filesystem barriers; Node cannot fsync directories there.
  if (process.platform === 'win32') return;
  const handle = await fs.open(target, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * Native Pi Durable SQLite with a verified WAL/FULL barrier. Upstream's convenience
 * opener uses NORMAL, so deliberately compose its public database adapter instead.
 * A successful commit is an SQLite FULL transaction, not a JSONL flush or rename.
 */
export async function openOwnedDurableStorage(options: OwnedDurableStorageOptions): Promise<OwnedDurableStorage> {
  // Startup checks are one finite operation. Keep each live ACL read, but do
  // not pay for a new PowerShell process at every open stage. No worker/ACL
  // result is retained by the returned store; later admissions still read the
  // actual profile owner entry/token through assertOwnership below.
  let acquired: OwnedDurableStorage | undefined;
  try {
    return await withPrivateWindowsAclScope(async () => {
      acquired = await openOwnedDurableStorageWithinScope(options);
      return acquired;
    });
  } catch (error) {
    // Scope finalization can fail after SQLite opened successfully. Settle that
    // backend before the host can release its borrowed profile ownership.
    if (acquired) {
      try { await acquired.storage.close(BACKGROUND_CONTEXT); }
      catch (closeError) {
        throw new DurableStorageCloseUncertainError([error, closeError], 'Native durable ACL scope finalization failed and close is uncertain; retain profile ownership.');
      }
    }
    throw error;
  }
}

async function openOwnedDurableStorageWithinScope(options: OwnedDurableStorageOptions): Promise<OwnedDurableStorage> {
  if (!(options.profileOwner instanceof OwnerLock) || !path.isAbsolute(options.dataRoot)
    || !/^[a-z0-9][a-z0-9_-]{0,100}\.sqlite$/u.test(options.filename)) {
    throw new Error('Native durable storage requires a profile owner, absolute data root, and safe database name.');
  }
  const root = await canonicalFuturePath(options.dataRoot);
  const resource = await canonicalFuturePath(options.profileOwner.record.resource);
  if (!inside(resource, root) || !path.basename(options.profileOwner.lockPath).startsWith('profile-')) {
    throw new Error('Native durable storage is outside its profile ownership.');
  }
  const assertOwnership = async (): Promise<void> => {
    // Validate the DACL once at open, and the real owner entry/token on every
    // admission. A PowerShell process for every native document read/commit
    // would put model streaming on a subprocess-per-record critical path.
    await privatePath(options.profileOwner.lockPath, true, false);
    const ownerPath = path.join(options.profileOwner.lockPath, 'owner.json');
    await privatePath(ownerPath, false, false);
    const stat = await fs.stat(ownerPath);
    if (stat.size > 4096) throw new Error('Native durable profile owner record is invalid.');
    const record: unknown = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
    if (!record || typeof record !== 'object' || !('token' in record) || !('resource' in record)
      || record.token !== options.profileOwner.record.token || record.resource !== options.profileOwner.record.resource) {
      throw new Error('Native durable profile ownership changed; admission is fenced.');
    }
  };
  await assertOwnership();
  await privatePath(root, true, false);
  await assertPrivateWindowsAcls([options.profileOwner.lockPath, path.join(options.profileOwner.lockPath, 'owner.json'), root]);

  // Resolve capability before creating any new state. Electron/Node builds without
  // node:sqlite fail explicitly rather than quietly falling back to weaker storage.
  let sqlite: typeof import('node:sqlite');
  let adapterModule: typeof import('@earendil-works/pi-durable/storage/sqlite/node');
  try {
    sqlite = await import('node:sqlite');
    adapterModule = await import('@earendil-works/pi-durable/storage/sqlite/node');
    if (typeof sqlite.DatabaseSync !== 'function' || typeof (Promise as unknown as { withResolvers?: unknown }).withResolvers !== 'function') throw new Error('Required native runtime APIs are absent.');
  } catch (cause) {
    throw new Error('Native Pi Durable requires a compatible Node runtime with node:sqlite (Node 22.19+); startup is fenced.', { cause });
  }

  const directory = path.join(root, 'durable', 'v1');
  const filename = path.join(directory, options.filename);
  const key = process.platform === 'win32' ? filename.toLowerCase() : filename;
  if (openFiles.has(key)) throw new Error('Native durable database already has an open writer in this process.');
  openFiles.add(key);
  let database: InstanceType<typeof adapterModule.NodeSqliteDatabase> | undefined;
  let raw: Storage | undefined;
  let databaseCloseFailure: { error: unknown } | undefined;
  // SqliteStorage.open tries to close on migration failure but intentionally
  // suppresses close errors. Remember that uncertainty even if a later close
  // becomes an adapter no-op; the host must not release its profile owner.
  class OwnedDatabase extends adapterModule.NodeSqliteDatabase {
    override async close(): Promise<void> {
      try { await super.close(); }
      catch (error) { databaseCloseFailure = { error }; throw error; }
    }
  }
  try {
    const existingDirectories: string[] = [];
    for (const target of [path.dirname(directory), directory]) {
      try { await privatePath(target, true, false); existingDirectories.push(target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // Validate every existing ancestor before creating anything beneath it.
        await assertPrivateWindowsAcls(existingDirectories); existingDirectories.length = 0;
        await fs.mkdir(target, { mode: 0o700 });
        await privatePath(target, true);
        await syncDirectory(path.dirname(target));
      }
    }
    await assertPrivateWindowsAcls(existingDirectories);
    const existingFiles: string[] = [];
    for (const suffix of ['', '-wal', '-shm']) {
      const target = `${filename}${suffix}`;
      try { await privatePath(target, false, false); existingFiles.push(target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await assertPrivateWindowsAcls(existingFiles);
    try {
      const created = await fs.open(filename, 'wx', 0o600);
      try { await created.sync(); } finally { await created.close(); }
      await syncDirectory(directory);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await privatePath(filename, false);
    await assertOwnership();
    database = new OwnedDatabase(new sqlite.DatabaseSync(filename));
    await database.exec('PRAGMA busy_timeout = 5000');
    const integrity = await database.all<{ quick_check: string }>('PRAGMA quick_check');
    if (integrity.length !== 1 || integrity[0]?.quick_check !== 'ok') throw new Error('Native durable SQLite integrity check failed; preserve the database for recovery.');
    const tables = await database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
    if (tables.length > 0) {
      const expected = new Set(['durable_schema', 'durable_metadata', 'record_ids', 'conversations', 'entries', 'tasks', 'submissions', 'documents', 'document_revisions']);
      if (tables.length !== expected.size || tables.some((table) => !expected.has(table.name))) throw new Error('Native durable SQLite schema mismatch; no migration was performed.');
      const schema = await database.get<{ version: number }>('SELECT version FROM durable_schema WHERE singleton = 1');
      if (schema?.version !== 1) throw new Error('Native durable SQLite schema version is unsupported; no migration was performed.');
      const metadata = await database.all<{ next_id: string; next_seq: number }>('SELECT next_id, next_seq FROM durable_metadata');
      const nextId = Number(metadata[0]?.next_id);
      const nextSeq = metadata[0]?.next_seq;
      const maximum = await database.get<{ id: number | null }>(`SELECT max(id) AS id FROM (
        SELECT id FROM record_ids UNION ALL SELECT id FROM conversations UNION ALL SELECT id FROM entries
        UNION ALL SELECT id FROM tasks UNION ALL SELECT id FROM submissions UNION ALL SELECT id FROM documents
      )`);
      // Pi stamps sequence numbers in several tables. A positive next_seq alone
      // is not sufficient: current-only snapshots can otherwise overwrite using
      // an already committed sequence and silently regress durable ordering.
      const sequence = await database.get<{ seq: number | null }>(`SELECT max(seq) AS seq FROM (
        SELECT seq FROM document_revisions UNION ALL SELECT commit_seq AS seq FROM entries
        UNION ALL SELECT created_at AS seq FROM documents UNION ALL SELECT retired_at AS seq FROM documents
      )`);
      const invalidSequence = await database.get<{ count: number }>(`SELECT count(*) AS count FROM (
        SELECT seq FROM document_revisions WHERE seq < 1
        UNION ALL SELECT commit_seq FROM entries WHERE commit_seq < 1
        UNION ALL SELECT created_at FROM documents WHERE created_at < 1 OR retired_at < created_at
          OR json_extract(record, '$.createdAt') IS NOT created_at
          OR json_extract(record, '$.retiredAt') IS NOT retired_at
      )`);
      if (metadata.length !== 1 || !Number.isSafeInteger(nextId) || nextId < 2 || String(nextId) !== metadata[0]?.next_id
        || !Number.isSafeInteger(nextSeq) || nextSeq! < 1 || nextId <= (maximum?.id ?? 1)
        || nextSeq! <= (sequence?.seq ?? 0) || invalidSequence?.count !== 0) {
        throw new Error('Native durable SQLite allocation metadata is corrupt; admission is fenced.');
      }
    }
    await database.exec('PRAGMA journal_mode = WAL');
    await database.exec('PRAGMA synchronous = FULL');
    await database.exec('PRAGMA wal_autocheckpoint = 1000');
    const journal = await database.get<{ journal_mode: string }>('PRAGMA journal_mode');
    const synchronous = await database.get<{ synchronous: number }>('PRAGMA synchronous');
    const version = await database.get<{ version: string }>('SELECT sqlite_version() AS version');
    if (journal?.journal_mode !== 'wal' || synchronous?.synchronous !== 2 || !version?.version) {
      throw new Error('Native durable SQLite WAL/FULL could not be verified; admission is fenced.');
    }
    raw = await SqliteStorage.open(database);
    await syncDirectory(directory);
    const opened = raw;
    let closing: Promise<void> | undefined;
    const admitted = new Set<Promise<unknown>>();
    const storage = new Proxy(opened, {
      get(target, property) {
        if (property === 'close') return () => closing ??= (async () => {
          await Promise.allSettled([...admitted]);
          await opened.close(BACKGROUND_CONTEXT);
          openFiles.delete(key);
        })();
        const method: unknown = Reflect.get(target, property);
        if (typeof method !== 'function') return method;
        return (...args: unknown[]) => {
          if (closing) return Promise.reject(new Error('Native durable storage is closed.'));
          const result = assertOwnership().then(() => Reflect.apply(method, target, args));
          admitted.add(result);
          void result.then(() => admitted.delete(result), () => admitted.delete(result));
          return result;
        };
      },
    });
    return { storage, filename, diagnostics: { journalMode: 'wal', synchronous: 2, sqliteVersion: version.version }, assertOwnership };
  } catch (error) {
    try {
      if (raw) await raw.close(BACKGROUND_CONTEXT);
      else await database?.close();
      if (databaseCloseFailure) throw databaseCloseFailure.error;
      openFiles.delete(key);
    } catch (closeError) {
      throw new DurableStorageCloseUncertainError([error, closeError], 'Native durable initialization failed and close is uncertain; retain profile ownership.');
    }
    throw error;
  }
}
