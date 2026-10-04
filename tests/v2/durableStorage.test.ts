import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createSession, defineDoc, type Storage } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { NodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { OwnerLock, canonicalFuturePath } from '../../src/core/ownership/OwnerLock';
import { DurableStorageCloseUncertainError, openOwnedDurableStorage } from '../../src/core/durable/OwnedDurableStorage';

const Counter = defineDoc<{ count: number; delivery: string }>({ kind: 'fate.test.barrier', version: 1, scope: 'session', initial: () => ({ count: 0, delivery: 'unknown' }), checkpointWhen: () => true });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-durable-storage-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'data'); await fs.mkdir(dataRoot, { mode: 0o700 });
  const profileOwner = await OwnerLock.acquire(path.join(root, 'locks'), 'profile', await canonicalFuturePath(dataRoot));
  cleanups.push(() => profileOwner.release());
  const storages: Storage[] = [];
  cleanups.push(async () => { for (const storage of storages) await storage.close(BACKGROUND_CONTEXT); });
  const open = async (filename = 'barrier.sqlite') => {
    const owned = await openOwnedDurableStorage({ dataRoot, profileOwner, filename }); storages.push(owned.storage); return owned;
  };
  return { root, dataRoot, profileOwner, open };
}

function barrier() {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), release: () => resolve() };
}

describe('owned native Pi Durable SQLite', () => {
  it.each(['revision', 'entry', 'creation', 'retirement'] as const)('rejects regressed next_seq below persisted %s ordering without changing the corrupt database', async (kind) => {
    const { open } = await fixture(); const owned = await open();
    const session = createSession(owned.storage);
    await session.commit(async (tx) => { (await tx.doc(Counter)).count = 1; }, BACKGROUND_CONTEXT);
    await session.commit(async (tx) => { (await tx.doc(Counter)).count = 2; }, BACKGROUND_CONTEXT);
    await session.close(BACKGROUND_CONTEXT);
    const db = new DatabaseSync(owned.filename);
    if (kind === 'entry') {
      db.prepare('INSERT INTO entries(id, conversation_id, head, commit_seq, record) VALUES(100, 1, NULL, 20, ?)').run(JSON.stringify({ id: 100, conversationId: 1, kind: 'test' }));
      db.exec("UPDATE durable_metadata SET next_id='101'");
    } else if (kind === 'creation') {
      db.exec("UPDATE documents SET created_at=20, record=json_set(record,'$.createdAt',20)");
    } else if (kind === 'retirement') {
      db.exec("UPDATE documents SET retired_at=20, record=json_set(record,'$.retiredAt',20)");
    }
    db.exec('UPDATE durable_metadata SET next_seq=1'); db.close();
    const before = await fs.readFile(owned.filename);
    await expect(open()).rejects.toThrow(/allocation metadata is corrupt/u);
    expect(await fs.readFile(owned.filename)).toEqual(before);
  });

  it('preserves a typed close-uncertainty signal even when upstream initialization suppresses the first close failure', async () => {
    const { open, profileOwner } = await fixture();
    const originalClose = NodeSqliteDatabase.prototype.close;
    let calls = 0;
    let noOpRetryCalls = 0;
    // Physically close the synthetic handle before injecting an uncertain outcome,
    // so the test can safely clean its fixture without leaving an actual writer.
    const close = vi.spyOn(NodeSqliteDatabase.prototype, 'close').mockImplementation(async function (this: NodeSqliteDatabase) {
      calls++;
      let checkpointFailure: unknown;
      // The native adapter closes the handle in finally even when its checkpoint
      // reports a locked empty-schema statement during this initialization probe.
      try { await originalClose.call(this); } catch (error) { checkpointFailure = error; }
      if (calls === 1) throw new Error('Synthetic first close outcome is uncertain', { cause: checkpointFailure });
    });
    const initialize = vi.spyOn(SqliteStorage, 'open').mockImplementation(async (database) => {
      try { await database.close(); } catch { /* Matches upstream migration-error cleanup behavior. */ }
      // Explicitly model the adapter's already-closed no-op on a later cleanup
      // attempt: that no-op must not erase the first uncertain close result.
      database.close = async () => { noOpRetryCalls++; };
      throw new Error('Synthetic storage initialization failure');
    });
    try {
      const error = await open().then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(DurableStorageCloseUncertainError);
      expect((error as AggregateError).errors.map(String)).toEqual([
        'Error: Synthetic storage initialization failure', 'Error: Synthetic first close outcome is uncertain',
      ]);
      expect(calls).toBe(1);
      expect(noOpRetryCalls).toBe(1);
      expect(JSON.parse(await fs.readFile(profileOwner.recordPath, 'utf8')).token).toBe(profileOwner.record.token);
      await expect(open()).rejects.toThrow(/already has an open writer/u);
    } finally { initialize.mockRestore(); close.mockRestore(); }
  });

  it('never publishes dirty draft state before the actual FULL commit completes', async () => {
    const { open } = await fixture(); const owned = await open();
    const admitted = barrier(); const release = barrier(); let block = false;
    const wrapped = new Proxy(owned.storage, { get(target, name) {
      if (name === 'commit') return async (...args: Parameters<Storage['commit']>) => {
        if (block) { admitted.release(); await release.promise; }
        return target.commit(...args);
      };
      return Reflect.get(target, name);
    } });
    const session = createSession(wrapped);
    await session.commit(async (tx) => { (await tx.doc(Counter)).count = 1; }, BACKGROUND_CONTEXT);
    const observer = await session.documentState(Counter, BACKGROUND_CONTEXT);
    const publications: number[] = [];
    const stop = session.subscribeCommits((publication) => publications.push(publication.seq));
    block = true;
    const pending = session.commit(async (tx) => { (await tx.doc(Counter)).count = 2; }, BACKGROUND_CONTEXT);
    await admitted.promise;
    expect((await session.snapshot(Counter, BACKGROUND_CONTEXT))?.count).toBe(1);
    expect(observer?.value?.count).toBe(1);
    expect(publications).toEqual([]);
    const before = new DatabaseSync(owned.filename, { readOnly: true });
    expect(JSON.parse(String(before.prepare('SELECT content FROM document_revisions').get()?.content)).count).toBe(1); before.close();
    release.release(); await pending;
    expect((await session.snapshot(Counter, BACKGROUND_CONTEXT))?.count).toBe(2);
    expect(publications).toHaveLength(1);
    stop(); await session.close(BACKGROUND_CONTEXT);
  });

  it('retains prior observer state on transaction rollback and fences all poisoned reads/writes', async () => {
    const { open } = await fixture(); const owned = await open();
    const session = createSession(owned.storage);
    await session.commit(async (tx) => { (await tx.doc(Counter)).count = 1; }, BACKGROUND_CONTEXT);
    const observed = await session.documentState(Counter, BACKGROUND_CONTEXT);
    const publications: number[] = [];
    session.subscribeCommits((publication) => publications.push(publication.seq));
    const db = new DatabaseSync(owned.filename);
    db.exec("CREATE TRIGGER reject_revision BEFORE INSERT ON document_revisions BEGIN SELECT RAISE(ABORT, 'synthetic failed commit'); END"); db.close();
    await expect(session.commit(async (tx) => { (await tx.doc(Counter)).count = 99; }, BACKGROUND_CONTEXT)).rejects.toThrow(/failed commit/u);
    expect(observed?.value?.count).toBe(1);
    expect(publications).toEqual([]);
    await expect(session.snapshot(Counter, BACKGROUND_CONTEXT)).rejects.toThrow(/poisoned/u);
    await expect(session.commit(async (tx) => { (await tx.doc(Counter)).count = 100; }, BACKGROUND_CONTEXT)).rejects.toThrow(/poisoned/u);
    await session.close(BACKGROUND_CONTEXT);
    const reopened = createSession((await open()).storage);
    expect((await reopened.snapshot(Counter, BACKGROUND_CONTEXT))?.count).toBe(1);
    await reopened.close(BACKGROUND_CONTEXT);
  });

  it('preserves an uncertain committed result across reopen instead of exposing, replaying, or discarding it', async () => {
    const { open } = await fixture(); const owned = await open(); let uncertain = false;
    const wrapped = new Proxy(owned.storage, { get(target, name) {
      if (name === 'commit') return async (...args: Parameters<Storage['commit']>) => {
        const seq = await target.commit(...args);
        if (uncertain) throw new Error('Synthetic connection loss after commit');
        return seq;
      };
      return Reflect.get(target, name);
    } });
    const session = createSession(wrapped);
    await session.commit(async (tx) => { (await tx.doc(Counter)).count = 1; }, BACKGROUND_CONTEXT);
    const observed = await session.documentState(Counter, BACKGROUND_CONTEXT);
    uncertain = true;
    await expect(session.commit(async (tx) => { (await tx.doc(Counter)).count = 2; }, BACKGROUND_CONTEXT)).rejects.toThrow(/after commit/u);
    expect(observed?.value?.count).toBe(1);
    await expect(session.snapshot(Counter, BACKGROUND_CONTEXT)).rejects.toThrow(/poisoned/u);
    await session.close(BACKGROUND_CONTEXT);
    const reopened = createSession((await open()).storage);
    expect(await reopened.snapshot(Counter, BACKGROUND_CONTEXT)).toEqual({ count: 2, delivery: 'unknown' });
    await reopened.close(BACKGROUND_CONTEXT);
  });

  it('survives process termination after an acknowledged native FULL commit and rolls back an uncommitted WAL transaction', async () => {
    const { open, profileOwner } = await fixture();
    const owned = await open('crash.sqlite');
    await owned.storage.close(BACKGROUND_CONTEXT);
    const runAndKill = async (uncommitted: boolean): Promise<void> => {
      const script = `
        import { readFileSync } from 'node:fs';
        import { DatabaseSync } from 'node:sqlite';
        import { NodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
        import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
        import { createSession, defineDoc } from '@earendil-works/pi-durable';
        import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
        if (JSON.parse(readFileSync(${JSON.stringify(profileOwner.recordPath)}, 'utf8')).token !== ${JSON.stringify(profileOwner.record.token)}) throw new Error('owner mismatch');
        const connection = new DatabaseSync(${JSON.stringify(owned.filename)});
        connection.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0');
        if (connection.prepare('PRAGMA synchronous').get().synchronous !== 2) throw new Error('not FULL');
        if (${uncommitted}) {
          connection.exec('BEGIN IMMEDIATE');
          connection.prepare('UPDATE document_revisions SET content = ?').run('{"count":999,"delivery":"unknown"}');
        } else {
          const storage = await SqliteStorage.open(new NodeSqliteDatabase(connection));
          const session = createSession(storage);
          const token = defineDoc({ kind:'fate.test.barrier',version:1,scope:'session',initial:()=>({count:0,delivery:'unknown'}),checkpointWhen:()=>true });
          await session.commit(async tx => { (await tx.doc(token)).count=7; }, BACKGROUND_CONTEXT);
        }
        process.stdout.write('READY\\n');
        setInterval(() => {}, 1000);
      `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let output = ''; let errors = '';
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
      const ready = new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (data: Buffer) => { output += data.toString(); if (output.includes('READY\n')) resolve(); });
        child.stderr.on('data', (data: Buffer) => { errors += data.toString(); });
        child.once('exit', () => { if (!output.includes('READY\n')) reject(new Error(`Synthetic writer exited before readiness: ${errors}`)); });
      });
      try { await ready; child.kill('SIGKILL'); const result = await exited; expect(result.signal ?? result.code).not.toBe(0); }
      finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
    };
    await runAndKill(false);
    let session = createSession((await open('crash.sqlite')).storage);
    expect(await session.snapshot(Counter, BACKGROUND_CONTEXT)).toEqual({ count: 7, delivery: 'unknown' });
    await session.close(BACKGROUND_CONTEXT);
    await runAndKill(true);
    session = createSession((await open('crash.sqlite')).storage);
    expect(await session.snapshot(Counter, BACKGROUND_CONTEXT)).toEqual({ count: 7, delivery: 'unknown' });
    await session.close(BACKGROUND_CONTEXT);
  });

  it('rejects released ownership, escaped filenames, hardlinks, and overlapping in-process writers', async () => {
    const { root, dataRoot, profileOwner, open } = await fixture();
    const owned = await open();
    await expect(open()).rejects.toThrow(/already has an open writer/u);
    await expect(openOwnedDurableStorage({ dataRoot, profileOwner, filename: '../escape.sqlite' })).rejects.toThrow(/safe database name/u);
    await owned.storage.close(BACKGROUND_CONTEXT);
    await fs.link(owned.filename, path.join(root, 'hardlink.sqlite'));
    await expect(open()).rejects.toThrow(/private regular file/u);
    await fs.unlink(path.join(root, 'hardlink.sqlite'));
    await profileOwner.release();
    await expect(open()).rejects.toThrow();
  });
});
