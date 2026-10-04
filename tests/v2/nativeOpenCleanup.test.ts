import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Storage } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { NodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createFateCore } from '../../src/core/createFateCore';
import { FatePaths } from '../../src/core/FatePaths';
import { DurableStorageCloseUncertainError, openOwnedDurableStorage, type OwnedDurableStorage } from '../../src/core/durable/OwnedDurableStorage';
import { OwnerLock, OwnershipConflict, canonicalFuturePath } from '../../src/core/ownership/OwnerLock';
import * as windowsAcl from '../../src/core/storage/WindowsPrivateAcl';
import { FakePiSdkAdapter } from './helpers/fakePi';
import { privateTestRoot } from './helpers/isolatedEnvironment';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

type Outcome<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };

async function fixture() {
  const root = await fs.mkdtemp(path.join(privateTestRoot(), 'native-open-cleanup-'));
  const paths = new FatePaths({ dataRoot: path.join(root, 'profile', 'data'), piAgentDir: path.join(root, 'profile', 'pi'),
    sessionsRoot: path.join(root, 'profile', 'pi', 'sessions'), attachmentRoot: path.join(root, 'attachments'),
    lockRoot: path.join(root, 'locks'), profileId: 'native-open-cleanup', profileKind: 'server' });
  await fs.mkdir(paths.dataRoot, { recursive: true, mode: 0o700 });
  const resource = await canonicalFuturePath(path.dirname(paths.dataRoot));
  const adapter = new FakePiSdkAdapter();
  const createRuntime = vi.fn(() => { throw new Error('Runtime must not be constructed after failed native acquisition.'); });
  const owners: OwnerLock[] = [];
  const storages = new Set<Storage>();
  const databases = new Set<DatabaseSync>();
  const pending: Promise<unknown>[] = [];
  const gates: ReturnType<typeof barrier>[] = [];
  const expectedCloseFailures = new Set<unknown>();
  const events: string[] = [];
  const originalAcquire = OwnerLock.acquire;
  const originalRelease = OwnerLock.prototype.release;
  const originalExec = DatabaseSync.prototype.exec;
  const originalNativeClose = DatabaseSync.prototype.close;
  const originalAdapterClose = NodeSqliteDatabase.prototype.close;
  const originalScope = windowsAcl.withPrivateWindowsAclScope;
  const acquire = vi.spyOn(OwnerLock, 'acquire').mockImplementation(async (...args) => {
    const owner = await originalAcquire(...args); owners.push(owner); return owner;
  });
  const release = vi.spyOn(OwnerLock.prototype, 'release').mockImplementation(async function (this: OwnerLock) {
    events.push('owner-release'); await originalRelease.call(this);
  });
  // Keep the real constructor, SQL, migrations, WAL/FULL configuration and close.
  // Remember every native handle so even a regressed leaking implementation can
  // be cleaned safely without deleting a database whose closure is unconfirmed.
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    databases.add(this); return originalExec.call(this, sql);
  });
  const nativeClose = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function (this: DatabaseSync) {
    originalNativeClose.call(this); events.push('native-close');
  });
  const adapterClose = vi.spyOn(NodeSqliteDatabase.prototype, 'close');
  const storageClose = vi.spyOn(SqliteStorage.prototype, 'close');
  const open = async (profileOwner: OwnerLock, filename = 'state.sqlite') => {
    const owned = await openOwnedDurableStorage({ dataRoot: paths.dataRoot, profileOwner, filename });
    storages.add(owned.storage); return owned;
  };
  const observe = <T>(operation: Promise<T>) => {
    let settled = false;
    const outcome = operation.then<Outcome<T>, Outcome<T>>(
      (value) => { settled = true; return { status: 'fulfilled', value }; },
      (reason: unknown) => { settled = true; return { status: 'rejected', reason }; },
    );
    pending.push(outcome);
    return { outcome, settled: () => settled };
  };
  return {
    paths, resource, owners, databases, events, acquire, release, nativeClose, adapterClose, storageClose,
    originalAdapterClose, expectedCloseFailures, adapter, createRuntime, open, observe,
    acquireProfile: () => OwnerLock.acquire(paths.lockRoot, 'profile', resource),
    startCore: () => createFateCore({ paths, adapter, createRuntime, statePersistence: 'native-durable' }),
    gate: () => { const gate = barrier(); gates.push(gate); return gate; },
    failFinalizationOnce(error: Error, afterAcquisition?: (owned: OwnedDurableStorage) => void) {
      let armed = true;
      return vi.spyOn(windowsAcl, 'withPrivateWindowsAclScope').mockImplementation(async (operation) => {
        // Synthetic scope-finalization seam, NOT a failing PowerShell process.
        // The real scope and all live ACL/path checks run normally first. The
        // existing windowsAclScope.test.ts cases exercise the transport protocol.
        const result = await originalScope(operation);
        // Other finite operations (startup workflow inspection, for example) use
        // the same scope helper. Fail only the first storage acquisition.
        const acquired = Boolean(result && typeof result === 'object' && 'storage' in result && 'assertOwnership' in result);
        if (!armed || !acquired) return result;
        armed = false;
        const owned = result as OwnedDurableStorage;
        storages.add(owned.storage);
        afterAcquisition?.(owned);
        throw error;
      });
    },
    async cleanup() {
      const failures: unknown[] = [];
      try {
        for (const gate of gates) gate.release();
        await Promise.all(pending);
        adapterClose.mockRestore();
        for (const storage of storages) {
          try { await storage.close(BACKGROUND_CONTEXT); }
          catch (error) { if (!expectedCloseFailures.has(error)) failures.push(error); }
        }
        // Test-only recovery of a deliberately failed/memoized close or a leaked
        // acquisition under regression. No more startup work is outstanding.
        for (const database of databases) if (database.isOpen) originalNativeClose.call(database);
        if ([...databases].some((database) => database.isOpen)) throw new Error('Unconfirmed native close: preserve fixture and owner.');
        // Release only captured real owners, using their unchanged token check.
        for (const owner of [...owners].reverse()) await owner.release();
        await adapter.dispose();
        const remaining = await fs.readdir(paths.lockRoot).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return []; throw error;
        });
        if (remaining.length) throw new Error('Unexpected retained owner: preserve fixture.');
        await fs.rm(root, { recursive: true, force: true });
        if (failures.length) throw new AggregateError(failures, 'Unexpected native test cleanup failure.');
      } finally { vi.restoreAllMocks(); }
    },
  };
}

async function assertOwnerHeld(owner: OwnerLock) {
  const record = JSON.parse(await fs.readFile(path.join(owner.lockPath, 'owner.json'), 'utf8'));
  expect(record.token).toBe(owner.record.token);
  expect(record.resource).toBe(owner.record.resource);
}

async function awaitCloseOrFailure(entered: Promise<void>, outcome: Promise<Outcome<unknown>>) {
  // A regression must fail promptly, rather than hang waiting for a close the
  // broken wrapper never requested. Both paths remain joined by fixture cleanup.
  await Promise.race([entered, outcome.then(() => { throw new Error('Startup settled before the actual database close barrier.'); })]);
}

describe('native acquisition cleanup after synthetic ACL scope-finalization failure', () => {
  it('keeps a successful real SQLite acquisition live and never takes over its borrowed owner', async () => {
    const f = await fixture();
    try {
      const owner = await f.acquireProfile();
      const owned = await f.open(owner);
      expect(owned.diagnostics).toMatchObject({ journalMode: 'wal', synchronous: 2 });
      expect(f.databases.size).toBe(1);
      const database = [...f.databases][0]!;
      expect(database.isOpen).toBe(true);
      expect(database.prepare('SELECT version FROM durable_schema WHERE singleton = 1').all()[0]?.version).toBe(1);
      expect(f.nativeClose).not.toHaveBeenCalled();
      expect(f.acquire).toHaveBeenCalledTimes(1);
      expect(f.release).not.toHaveBeenCalled();
      await owned.storage.close(BACKGROUND_CONTEXT);
      expect(database.isOpen).toBe(false);
      expect(f.nativeClose).toHaveBeenCalledOnce();
      await assertOwnerHeld(owner);
      expect(f.release).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it('preserves pre-acquisition validation failures without attempting a nonexistent backend close', async () => {
    const f = await fixture();
    try {
      const owner = await f.acquireProfile();
      f.failFinalizationOnce(new Error('Unreachable synthetic scope-finalization failure'));
      await expect(f.open(owner, '../escape.sqlite')).rejects.toThrow('safe database name');
      expect(f.databases.size).toBe(0);
      expect(f.storageClose).not.toHaveBeenCalled();
      expect(f.adapterClose).not.toHaveBeenCalled();
      expect(f.acquire).toHaveBeenCalledTimes(1);
      expect(f.release).not.toHaveBeenCalled();
      await assertOwnerHeld(owner);
    } finally { await f.cleanup(); }
  });

  it('closes the acquired real storage with BACKGROUND_CONTEXT before rejecting the original scope error, then permits reopen', async () => {
    const f = await fixture();
    try {
      const owner = await f.acquireProfile();
      const scopeError = new Error('Synthetic ACL scope-finalization failure after acquisition');
      let acquired: OwnedDurableStorage | undefined;
      f.failFinalizationOnce(scopeError, (owned) => {
        acquired = owned;
        expect(f.databases.size).toBe(1);
        const database = [...f.databases][0]!;
        expect(database.isOpen).toBe(true);
        expect(database.prepare('PRAGMA journal_mode').all()[0]?.journal_mode).toBe('wal');
        expect(database.prepare('PRAGMA synchronous').all()[0]?.synchronous).toBe(2);
      });
      await expect(f.open(owner)).rejects.toBe(scopeError);
      expect(acquired).toBeDefined();
      const database = [...f.databases][0]!;
      expect(database.isOpen).toBe(false);
      expect(f.storageClose).toHaveBeenCalledExactlyOnceWith(BACKGROUND_CONTEXT);
      expect(f.nativeClose).toHaveBeenCalledOnce();
      expect(f.acquire).toHaveBeenCalledTimes(1);
      expect(f.release).not.toHaveBeenCalled();
      await assertOwnerHeld(owner);
      const reopened = await f.open(owner);
      expect(reopened.filename).toBe(acquired!.filename);
      expect(f.databases.size).toBe(2);
      await reopened.storage.scanDocuments({ scope: { kind: 'session' }, at: 'current' }, 1, undefined, BACKGROUND_CONTEXT);
      await reopened.storage.close(BACKGROUND_CONTEXT);
      expect([...f.databases].every((handle) => !handle.isOpen)).toBe(true);
    } finally { await f.cleanup(); }
  });

  it('holds actual core rejection and profile release behind real database closure, refusing overlapping opens and owners', async () => {
    const f = await fixture();
    const entered = f.gate(), resume = f.gate();
    try {
      const scopeError = new Error('Synthetic finalization failure with a held native close');
      f.failFinalizationOnce(scopeError);
      f.adapterClose.mockImplementationOnce(async function (this: NodeSqliteDatabase) {
        entered.release(); await resume.promise; await f.originalAdapterClose.call(this);
      });
      const startup = f.observe(f.startCore());
      await awaitCloseOrFailure(entered.promise, startup.outcome);
      const owner = f.owners[0]!;
      expect(f.databases.size).toBe(1);
      const database = [...f.databases][0]!;
      expect(database.isOpen).toBe(true);
      expect(database.prepare('SELECT version FROM durable_schema WHERE singleton = 1').all()[0]?.version).toBe(1);
      expect(startup.settled()).toBe(false);
      expect(f.nativeClose).not.toHaveBeenCalled();
      expect(f.release).not.toHaveBeenCalled();
      await assertOwnerHeld(owner);
      await expect(f.acquireProfile()).rejects.toBeInstanceOf(OwnershipConflict);
      await expect(f.open(owner)).rejects.toThrow('already has an open writer');
      expect(startup.settled()).toBe(false);
      expect(database.isOpen).toBe(true);
      expect(f.release).not.toHaveBeenCalled();
      resume.release();
      expect(await startup.outcome).toEqual({ status: 'rejected', reason: scopeError });
      expect(database.isOpen).toBe(false);
      expect(f.events).toEqual(['native-close', 'owner-release']);
      expect(f.createRuntime).not.toHaveBeenCalled();
      expect(f.adapter.invocations).toEqual([]);
      expect(await fs.readdir(f.paths.lockRoot)).toEqual([]);
      const nextOwner = await f.acquireProfile();
      const reopened = await f.open(nextOwner);
      await reopened.storage.close(BACKGROUND_CONTEXT);
      await nextOwner.release();
    } finally { await f.cleanup(); }
  });

  it('propagates both failures as typed uncertainty to the actual core and retains a real owner until explicit confirmed-close cleanup', async () => {
    const f = await fixture();
    try {
      const scopeError = new Error('Synthetic ACL scope-finalization failure');
      const closeError = new Error('Synthetic adapter close failure before native DatabaseSync.close');
      f.expectedCloseFailures.add(closeError);
      let failedDatabase: NodeSqliteDatabase | undefined;
      f.adapterClose.mockImplementationOnce(async function (this: NodeSqliteDatabase) { failedDatabase = this; throw closeError; });
      f.failFinalizationOnce(scopeError);
      const startup = await f.observe(f.startCore()).outcome;
      expect(startup.status).toBe('rejected');
      if (startup.status !== 'rejected') throw new Error('Failed native acquisition unexpectedly started a core.');
      expect(startup.reason).toBeInstanceOf(AggregateError);
      expect((startup.reason as Error).message).toContain('cleanup was incomplete');
      const uncertain = (startup.reason as AggregateError).errors[0];
      expect(uncertain).toBeInstanceOf(DurableStorageCloseUncertainError);
      expect((uncertain as AggregateError).errors).toHaveLength(2);
      expect((uncertain as AggregateError).errors[0]).toBe(scopeError);
      expect((uncertain as AggregateError).errors[1]).toBe(closeError);
      expect(f.storageClose).toHaveBeenCalledExactlyOnceWith(BACKGROUND_CONTEXT);
      expect(f.databases.size).toBe(1);
      const database = [...f.databases][0]!;
      expect(database.isOpen).toBe(true);
      expect(f.nativeClose).not.toHaveBeenCalled();
      expect(f.release).not.toHaveBeenCalled();
      expect(f.createRuntime).not.toHaveBeenCalled();
      expect(f.adapter.invocations).toEqual([]);
      const owner = f.owners[0]!;
      await assertOwnerHeld(owner);
      await expect(f.acquireProfile()).rejects.toBeInstanceOf(OwnershipConflict);
      await expect(f.startCore()).rejects.toBeInstanceOf(OwnershipConflict);
      await expect(f.open(owner)).rejects.toThrow('already has an open writer');
      expect(f.release).not.toHaveBeenCalled();
      // Explicit synthetic recovery, not production lock recovery: first run the
      // real adapter checkpoint/close and observe the real handle become closed.
      expect(failedDatabase).toBeDefined();
      await f.originalAdapterClose.call(failedDatabase!);
      expect(f.nativeClose).toHaveBeenCalledOnce();
      expect(database.isOpen).toBe(false);
      // The uncertain proxy still conservatively fences this filename. Neither
      // physical closure nor a failed startup automatically releases ownership.
      await expect(f.open(owner)).rejects.toThrow('already has an open writer');
      await assertOwnerHeld(owner);
      expect(f.release).not.toHaveBeenCalled();
      await owner.release();
      const nextOwner = await f.acquireProfile();
      await nextOwner.release();
      expect(await fs.readdir(f.paths.lockRoot)).toEqual([]);
    } finally { await f.cleanup(); }
  });
});
