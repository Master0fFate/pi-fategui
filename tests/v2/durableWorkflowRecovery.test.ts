import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createSession, defineDoc, defineTask } from '@earendil-works/pi-durable';
import { OwnerLock, canonicalFuturePath } from '../../src/core/ownership/OwnerLock';
import { openOwnedDurableStorage } from '../../src/core/durable/OwnedDurableStorage';
import { inspectOwnedNativeWorkflowRecovery } from '../../src/core/recovery/NativeWorkflowRecovery';

const Identity = defineDoc({ kind: 'fate.workflow.identity', scope: 'session', version: 1, initial: () => ({ workflowId: '', parentSessionId: '', cwd: '' }) });
const Fence = defineDoc<{ state: 'idle' | 'active' | 'UNKNOWN' }>({ kind: 'fate.execution.fence', scope: 'session', version: 1, initial: () => ({ state: 'idle' }), checkpointWhen: () => false });
const NeverRun = defineTask<{ id: string }, { phase: 'pending' }, null>({ name: 'fixture.never-run', version: 1, initial: () => ({ phase: 'pending' }), phases: { pending: async () => { throw new Error('The recovery scanner must never invoke a task.'); } }, abort: async () => { throw new Error('The recovery scanner must never abort a task.'); } });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-workflow-recovery-')); cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'data'); const cwd = path.join(root, 'project');
  await fs.mkdir(dataRoot, { mode: 0o700 }); await fs.mkdir(cwd, { mode: 0o700 });
  const profileOwner = await OwnerLock.acquire(path.join(root, 'locks'), 'profile', await canonicalFuturePath(dataRoot)); cleanups.push(() => profileOwner.release());
  const create = async (options: { fence?: 'idle' | 'active' | 'UNKNOWN'; task?: 'pending' | 'terminal'; submission?: boolean; missingIdentity?: boolean; historicalUnknown?: boolean; retireFence?: boolean } = {}) => {
    const identity = { workflowId: randomUUID(), parentSessionId: randomUUID(), cwd };
    const filename = `workflow-${hash(`${cwd}\0${identity.parentSessionId}\0${identity.workflowId}`)}.sqlite`;
    const owned = await openOwnedDurableStorage({ dataRoot, profileOwner, filename });
    const session = createSession(owned.storage);
    try {
      await session.commit(async (tx) => {
        if (!options.missingIdentity) Object.assign(await tx.doc(Identity), identity);
        (await tx.doc(Fence)).state = options.fence ?? 'idle';
        if (options.task || options.submission) {
          const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
          if (options.task) await tx.createTask(NeverRun, { id: 'synthetic' }, { ownership: { kind: 'conversation' }, conversationId: conversation.id });
          if (options.submission) await tx.createSubmission({ type: 'input', conversationId: conversation.id, requestId: 'synthetic', status: 'queued' });
        }
      }, BACKGROUND_CONTEXT);
      if (options.historicalUnknown) {
        await session.commit(async (tx) => { (await tx.doc(Fence)).state = 'UNKNOWN'; }, BACKGROUND_CONTEXT);
        await session.commit(async (tx) => { (await tx.doc(Fence)).state = 'idle'; }, BACKGROUND_CONTEXT);
      }
      if (options.retireFence) {
        await session.commit((tx) => tx.retireDoc(Fence), BACKGROUND_CONTEXT);
        await session.commit(async (tx) => { await tx.doc(Fence); }, BACKGROUND_CONTEXT);
      }
    } finally { await session.close(BACKGROUND_CONTEXT); }
    if (options.task === 'terminal') {
      const db = new DatabaseSync(owned.filename);
      const row = db.prepare('SELECT id, record FROM tasks LIMIT 1').get()!;
      const task = JSON.parse(String(row.record)); task.state = { status: 'terminal', outcome: { status: 'completed', result: null } };
      db.prepare("UPDATE tasks SET status='terminal', record=? WHERE id=?").run(JSON.stringify(task), Number(row.id)); db.close();
    }
    return { filename: owned.filename, identity };
  };
  const inspect = (maxFiles = 32) => inspectOwnedNativeWorkflowRecovery({ dataRoot, profileOwner, maxFiles });
  const fingerprints = async () => {
    const directory = path.join(dataRoot, 'durable', 'v1');
    const files = (await fs.readdir(directory)).sort();
    return Object.fromEntries(await Promise.all(files.map(async (name) => [name, hash(await fs.readFile(path.join(directory, name)))])));
  };
  return { root, dataRoot, cwd, profileOwner, create, inspect, fingerprints };
}

describe('read-only owned workflow startup recovery', () => {
  it('issues only SELECT statements and has no sidecars even while the read-only connection is open', async () => {
    const f = await fixture(); const saved = await f.create(); const directory = path.dirname(saved.filename);
    const before = readdirSync(directory).sort(); const sql: string[] = [];
    const prepare = DatabaseSync.prototype.prepare;
    const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, statement: string) {
      sql.push(statement); expect(statement.trim()).toMatch(/^SELECT\b/u);
      expect(readdirSync(directory).sort()).toEqual(before);
      return prepare.call(this, statement);
    });
    try { expect(await f.inspect()).toEqual({ blocked: [], uncertainProfile: false }); expect(sql.length).toBeGreaterThan(5); }
    finally { spy.mockRestore(); }
    expect(readdirSync(directory).sort()).toEqual(before);
  });

  it('accepts genuinely absent or idle terminal history without changing any database bytes or creating sidecars', async () => {
    const f = await fixture(); expect(await f.inspect()).toEqual({ blocked: [], uncertainProfile: false });
    await f.create({ task: 'terminal' }); await f.create();
    const before = await f.fingerprints();
    expect(await f.inspect()).toEqual({ blocked: [], uncertainProfile: false });
    expect(await f.fingerprints()).toEqual(before);
    expect(Object.keys(before).every((name) => name.endsWith('.sqlite'))).toBe(true);
  });

  it.each(['active', 'UNKNOWN'] as const)('blocks retained %s and binds the exact workflow parent even when a caller proposes a new workflow ID', async (state) => {
    const f = await fixture(); const saved = await f.create({ fence: state }); const before = await f.fingerprints();
    const result = await f.inspect();
    expect(result.uncertainProfile).toBe(false);
    expect(result.blocked).toEqual([expect.objectContaining({ filename: saved.filename, ...saved.identity })]);
    expect(await f.fingerprints()).toEqual(before);
  });

  it('blocks native pending tasks and queued submissions despite an idle fence without reconciling them', async () => {
    const f = await fixture(); const task = await f.create({ task: 'pending' }); const submission = await f.create({ submission: true }); const before = await f.fingerprints();
    const result = await f.inspect();
    expect(result.blocked.find((row) => row.filename === task.filename)?.reason).toMatch(/nonterminal/u);
    expect(result.blocked.find((row) => row.filename === submission.filename)?.reason).toMatch(/unsettled/u);
    expect(await f.fingerprints()).toEqual(before);
  });

  it('does not launder retained UNKNOWN deltas or retired fence incarnations through a latest idle state', async () => {
    const f = await fixture(); await f.create({ historicalUnknown: true }); await f.create({ retireFence: true }); const before = await f.fingerprints();
    const result = await f.inspect();
    expect(result.blocked).toHaveLength(2);
    expect(result.blocked.some((row) => row.reason.includes('retained UNKNOWN'))).toBe(true);
    expect(result.blocked.some((row) => row.reason.includes('retired'))).toBe(true);
    expect(await f.fingerprints()).toEqual(before);
  });

  it('fences the whole profile for missing or filename-mismatched workflow identity', async () => {
    const f = await fixture(); await f.create({ missingIdentity: true }); const saved = await f.create();
    const db = new DatabaseSync(saved.filename);
    db.prepare("UPDATE document_revisions SET content=json_set(content,'$.workflowId','different') WHERE document_id IN (SELECT id FROM documents WHERE kind=?)").run(JSON.stringify('fate.workflow.identity')); db.close();
    const before = await f.fingerprints(); const result = await f.inspect();
    expect(result.uncertainProfile).toBe(true); expect(result.blocked).toHaveLength(2);
    expect(result.blocked.every((row) => row.workflowId === undefined)).toBe(true);
    expect(await f.fingerprints()).toEqual(before);
  });

  it('does not open, checkpoint, change or remove existing WAL/SHM sidecars', async () => {
    const f = await fixture(); const saved = await f.create();
    const db = new DatabaseSync(saved.filename); db.exec('BEGIN IMMEDIATE; UPDATE durable_metadata SET next_seq=next_seq+1');
    try {
      const before = await f.fingerprints(); expect(Object.keys(before).some((name) => name.endsWith('-wal'))).toBe(true);
      const result = await f.inspect(); expect(result.uncertainProfile).toBe(true); expect(result.blocked[0]?.reason).toMatch(/sidecars/u);
      expect(await f.fingerprints()).toEqual(before);
    } finally { db.exec('ROLLBACK'); db.close(); }
  });

  it('refuses regressed allocation/schema metadata, malformed records and excessive inventory', async () => {
    const f = await fixture(); const saved = await f.create();
    let db = new DatabaseSync(saved.filename); db.exec('UPDATE durable_metadata SET next_seq=1'); db.close();
    let before = await f.fingerprints(); expect((await f.inspect()).blocked[0]?.reason).toMatch(/allocation metadata/u); expect(await f.fingerprints()).toEqual(before);
    db = new DatabaseSync(saved.filename); db.exec('UPDATE durable_schema SET version=2'); db.close();
    before = await f.fingerprints(); expect((await f.inspect()).blocked[0]?.reason).toMatch(/schema version/u); expect(await f.fingerprints()).toEqual(before);
    await f.create(); expect((await f.inspect(1)).blocked[0]?.reason).toMatch(/inventory exceeds its quota/u);
  });

  it('refuses links, malformed names, oversized files and denied ownership without executing anything', async () => {
    const f = await fixture(); const saved = await f.create(); const directory = path.dirname(saved.filename);
    const link = path.join(directory, `workflow-${'a'.repeat(64)}.sqlite`); await fs.symlink(saved.filename, link);
    expect((await f.inspect()).uncertainProfile).toBe(true); await fs.unlink(link);
    await fs.writeFile(path.join(directory, 'workflow-ambiguous.sqlite'), 'not a database', { mode: 0o600 });
    expect((await f.inspect()).blocked.some((row) => row.reason.includes('ambiguous'))).toBe(true); await fs.unlink(path.join(directory, 'workflow-ambiguous.sqlite'));
    const oversized = path.join(directory, `workflow-${'b'.repeat(64)}.sqlite`); await fs.writeFile(oversized, '', { mode: 0o600 }); await fs.truncate(oversized, 256 * 1024 * 1024 + 1);
    expect((await f.inspect()).blocked.some((row) => row.reason.includes('quota'))).toBe(true); await fs.unlink(oversized);
    const ownerFile = path.join(f.profileOwner.lockPath, 'owner.json'); const original = await fs.readFile(ownerFile, 'utf8');
    await fs.writeFile(ownerFile, JSON.stringify({ ...f.profileOwner.record, token: randomUUID() }));
    try { await expect(f.inspect()).rejects.toThrow(/ownership was lost/u); }
    finally { await fs.writeFile(ownerFile, original); }
  });
});
