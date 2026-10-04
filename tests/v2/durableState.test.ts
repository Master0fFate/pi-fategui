import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { OwnerLock, canonicalFuturePath } from '../../src/core/ownership/OwnerLock';
import { openFateDurableStore, verifyCompletedDurableImport, durableSessionKey, durableImportDigest, type FateDurableStore, type DurableSessionImport } from '../../src/core/durable/FateDurableStore';
import { DurableStorageCloseUncertainError } from '../../src/core/durable/OwnedDurableStorage';
import type { TaskList } from '../../src/shared/contracts/tasks';
import type { GoalMaxState } from '../../src/shared/contracts/goalmaxxing';
import type { QueuedMessage } from '../../src/shared/contracts/ipc';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation(); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-durable-state-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'data');
  await fs.mkdir(dataRoot, { mode: 0o700 });
  const profileOwner = await OwnerLock.acquire(path.join(root, 'locks'), 'profile', await canonicalFuturePath(dataRoot));
  cleanup.push(() => profileOwner.release());
  const stores: FateDurableStore[] = [];
  cleanup.push(async () => { for (const store of stores) await store.close(); });
  const open = async (options: Partial<Parameters<typeof openFateDurableStore>[0]> = {}) => {
    const store = await openFateDurableStore({ dataRoot, profileOwner, ...options });
    stores.push(store);
    return store;
  };
  return { root, dataRoot, profileOwner, open };
}
function message(text = 'Investigate the regression'): QueuedMessage { return { id: randomUUID(), text, behavior: 'followUp', createdAt: 10 }; }
function tasks(revision = 1): TaskList {
  return { schemaVersion: 1, projectPath: '/project', sessionId: 'session', revision, goalId: null, tasks: [], currentTaskId: null, updatedAt: 10 };
}
function goal(revision = 1): GoalMaxState {
  return {
    schemaVersion: 2, id: 'goal', sessionId: 'session', projectPath: '/project', revision,
    objective: 'Ship the feature', originalBriefRef: null, originalBriefHash: null, status: 'active', phase: 'implementation', executionState: 'idle',
    verificationLevel: 'normal', agentStrategy: 'auto',
    criteria: [{ id: 'criterion', title: 'Ship', description: 'Ship', required: true, status: 'pending', evidenceIds: [], ownerNodeIds: [], updatedAt: 10 }],
    budget: { tokenLimit: null, timeLimitMs: null, source: null }, permission: { permissionLevel: 'edit', projectTrusted: true, revision: 1, resolvedAt: 10 },
    progress: { meaningfulTurnCount: 0, noProgressTurnCount: 0, repeatedFailureCount: 0, planningOnlyTurnCount: 0, changedFileCount: 0, baselineWorkspaceFingerprint: 'a', latestWorkspaceFingerprint: 'a', latestEvidenceAt: null, latestMeaningfulProgressAt: null, lastFailureFingerprint: null },
    evidence: [], continuation: { pending: true, attempt: 1, lastScheduledAt: 10, lastSettledAt: null, reason: 'interrupted' }, steering: [], childAssignments: [],
    tokensUsed: 0, tokenBaseline: 0, elapsedMs: 0, timeline: [], createdAt: 10, updatedAt: 10, startedAt: 10, completedAt: null, blockedReason: null, failure: null,
  };
}
function snapshot(): DurableSessionImport { return { projectPath: '/project', sessionId: 'session', queues: [{ instanceSlot: 1, messages: [message()] }], tasks: tasks(7), goal: goal(3), briefs: {}, archives: [{ state: { ...goal(2), id: 'older-goal' }, briefs: {} }] }; }

describe('native durable state repositories', () => {
  it('reports startup cleanup uncertainty as a typed ownership-retention requirement', async () => {
    const { open, profileOwner } = await fixture();
    const store = await open(); await store.close();
    const db = new DatabaseSync(store.filename);
    db.prepare('UPDATE document_revisions SET version = 99 WHERE document_id IN (SELECT id FROM documents WHERE kind = ?)').run(JSON.stringify('fate.state.profile')); db.close();
    const originalClose = SqliteStorage.prototype.close;
    const close = vi.spyOn(SqliteStorage.prototype, 'close').mockImplementation(async function (this: SqliteStorage, context) {
      await originalClose.call(this, context);
      throw new Error('Synthetic startup close outcome is uncertain');
    });
    try {
      const error = await open().then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(DurableStorageCloseUncertainError);
      expect((error as AggregateError).errors.map(String).join('\n')).toMatch(/newer version.*\n.*startup close outcome/u);
      expect(JSON.parse(await fs.readFile(profileOwner.recordPath, 'utf8')).token).toBe(profileOwner.record.token);
    } finally { close.mockRestore(); }
  });

  it('commits through actual SQLite WAL/FULL and reopens exact queue, tasks, and uncertain goal state without native execution records', async () => {
    const { open } = await fixture();
    const first = await open();
    expect(first.diagnostics).toMatchObject({ journalMode: 'wal', synchronous: 2 });
    const draft = { ...message(), requestedModel: { provider: 'fixture', id: 'model' }, requestedThinkingLevel: 'high' as const, images: [{ data: 'YQ==', mimeType: 'image/png' as const, name: 'synthetic.png' }] };
    await first.createQueue(2).save('/project', 'session', [draft]);
    await first.createTasks().save(tasks(), null);
    await first.createGoals().save(goal(), null);
    const copy = await first.createQueue(2).load('/project', 'session');
    copy[0]!.text = 'MUTATED OUTSIDE';
    expect(await first.createQueue(2).load('/project', 'session')).toEqual([draft]);
    await first.close();
    const second = await open();
    expect(await second.createQueue(2).load('/project', 'session')).toEqual([draft]);
    expect(await second.createQueue(1).load('/project', 'session')).toEqual([]);
    expect(await second.createTasks().load('/project', 'session')).toEqual(tasks());
    expect(await second.createGoals().load('/project', 'session')).toEqual(goal());
    const db = new DatabaseSync(second.filename, { readOnly: true });
    try {
      for (const table of ['tasks', 'conversations', 'entries', 'submissions']) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0);
      expect(db.prepare('SELECT count(*) AS n FROM documents').get()?.n).toBe(4);
    } finally { db.close(); }
  });

  it('serializes independent adapters, compare-and-swap, replacement, deletion, and reads', async () => {
    const store = await (await fixture()).open();
    const a = store.createTasks(); const b = store.createTasks();
    await Promise.all([a.save(tasks(), null), b.save(tasks(2), 1), a.save(tasks(3), 2)]);
    const revisions = await Promise.allSettled([a.save(tasks(4), 3), b.save(tasks(4), 3)]);
    expect(revisions.map((value) => value.status)).toEqual(['fulfilled', 'rejected']);
    expect(await a.load('/project', 'session')).toMatchObject({ revision: 4 });
    const queue = store.createQueue();
    await Promise.all([queue.save('/project', 'session', [message()]), queue.save('/project', 'session', []), queue.deleteSession('/project', 'session')]);
    expect(await queue.load('/project', 'session')).toEqual([]);
    const write = queue.save('/project', 'session', [message('ordered')]);
    const read = queue.load('/project', 'session');
    await write;
    expect((await read)[0]?.text).toBe('ordered');
    await Promise.all([a.deleteSession('/project', 'session'), a.save(tasks(), null)]);
    expect(await a.loadHealth('/project', 'session')).toMatchObject({ state: 'ok', list: { revision: 1 } });
  });

  it('seals late operations while draining already admitted writes and rejects duplicate writers', async () => {
    const { open } = await fixture();
    const store = await open();
    await expect(open()).rejects.toThrow(/already has an open writer/u);
    const queue = store.createQueue();
    const write = queue.save('/project', 'session', [message('before-close')]);
    const close = store.close();
    expect(store.close()).toBe(close);
    await expect(queue.save('/project', 'session', [message('too-late')])).rejects.toThrow(/closed/u);
    await Promise.all([write, close]);
    expect((await (await open()).createQueue().load('/project', 'session'))[0]?.text).toBe('before-close');
  });

  it('keeps the last committed snapshot after an actual SQLite transaction failure and fences poisoned memory', async () => {
    const { open } = await fixture();
    const store = await open();
    await store.createTasks().save(tasks(), null);
    const db = new DatabaseSync(store.filename);
    db.exec("CREATE TRIGGER synthetic_disk_failure BEFORE INSERT ON document_revisions BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END");
    db.close();
    await expect(store.createTasks().save(tasks(2), 1)).rejects.toThrow(/synthetic disk failure/u);
    await expect(store.createTasks().load('/project', 'session')).rejects.toThrow(/poisoned/u);
    await store.close();
    const repair = new DatabaseSync(store.filename); repair.exec('DROP TRIGGER synthetic_disk_failure'); repair.close();
    const reopened = await open();
    expect(await reopened.createTasks().load('/project', 'session')).toEqual(tasks());
    await reopened.createTasks().save(tasks(2), 1);
  });

  it('fails closed on unsupported document schema and corrupt values rather than publishing empty state', async () => {
    const { open } = await fixture();
    let store = await open();
    await store.createTasks().save(tasks(), null);
    await store.close();
    let db = new DatabaseSync(store.filename);
    db.prepare("UPDATE document_revisions SET version = 99 WHERE document_id IN (SELECT id FROM documents WHERE kind = ?)").run(JSON.stringify('fate.state.tasks'));
    db.close();
    store = await open();
    await expect(store.createTasks().load('/project', 'session')).rejects.toThrow(/newer version/u);
    await expect(store.createTasks().save(tasks(2), 1)).rejects.toThrow(/newer version/u);
    expect(await store.createTasks().loadHealth('/project', 'session')).toEqual({ state: 'invalid' });
    await store.close();
    db = new DatabaseSync(store.filename);
    db.prepare("UPDATE document_revisions SET version = 1, content = ? WHERE document_id IN (SELECT id FROM documents WHERE kind = ?)").run('{"schemaVersion":1,"projectPath":"/project","sessionId":"session","state":{"broken":true}}', JSON.stringify('fate.state.tasks'));
    db.close();
    store = await open();
    await expect(store.createTasks().load('/project', 'session')).rejects.toThrow();
    await expect(store.createTasks().save(tasks(), null)).rejects.toThrow();
  });

  it('rejects incompatible SQLite schema and corruption without replacing the database', async () => {
    const { open } = await fixture();
    const store = await open(); await store.close();
    const db = new DatabaseSync(store.filename); db.exec('UPDATE durable_schema SET version = 900'); db.close();
    const before = await fs.readFile(store.filename);
    await expect(open()).rejects.toThrow(/schema version/u);
    expect(await fs.readFile(store.filename)).toEqual(before);
    await fs.writeFile(store.filename, 'corrupt synthetic sqlite');
    await expect(open()).rejects.toThrow();
    expect(await fs.readFile(store.filename, 'utf8')).toBe('corrupt synthetic sqlite');
  });

  it('enforces count and serialized UTF-8 limits before replacing committed state', async () => {
    const store = await (await fixture()).open();
    const queue = store.createQueue();
    await queue.save('/project', 'session', [message('keep')]);
    expect(() => queue.save('/project', 'session', Array.from({ length: 101 }, () => message()))).toThrow();
    await store.createTasks().save(tasks(), null);
    const oversized = { ...tasks(2), tasks: Array.from({ length: 200 }, (_, index) => ({ id: `task-${index}`, title: 'Task', detail: '界'.repeat(2000), status: 'todo' as const, required: true, source: 'user' as const, goalId: null, goalCriterionId: null, order: index, verified: false, verifiedAt: null, createdAt: 10, updatedAt: 10 })) };
    expect(() => store.createTasks().save(oversized, 1)).toThrow(/size limit/u);
    await store.createGoals().save(goal(), null);
    const oversizedGoal = { ...goal(2), evidence: Array.from({ length: 200 }, (_, index) => ({ id: `e-${index}`, kind: 'test' as const, title: 'Check', summary: '界'.repeat(8000), output: '界'.repeat(8000), criterionIds: [], source: 'runtime' as const, timestamp: 10, current: true })) };
    expect(() => store.createGoals().save(oversizedGoal, 1)).toThrow(/size limit/u);
    await expect(store.createGoals().saveBrief('/project', 'session', 'goal', 'x'.repeat(200001))).rejects.toThrow(/size limit/u);
    expect((await queue.load('/project', 'session'))[0]?.text).toBe('keep');
    expect(await store.createTasks().load('/project', 'session')).toEqual(tasks());
    expect(await store.createGoals().load('/project', 'session')).toEqual(goal());
  });

  it('rejects an aggregate attachment queue beyond 64 MiB before admission', async () => {
    const store = await (await fixture()).open();
    const queue = store.createQueue();
    const kept = message('keep'); await queue.save('/project', 'session', [kept]);
    const images = [{ name: 'synthetic-a.png', mimeType: 'image/png' as const, data: 'a'.repeat(10_000_000) }, { name: 'synthetic-b.png', mimeType: 'image/png' as const, data: 'b'.repeat(8_000_000) }];
    expect(() => queue.save('/project', 'session', Array.from({ length: 4 }, () => ({ ...message(), images })))).toThrow(/size limit/u);
    expect(await queue.load('/project', 'session')).toEqual([kept]);
  });

  it('rejects missing source briefs and handles repeated deletion of absent state', async () => {
    const store = await (await fixture()).open();
    const goals = store.createGoals();
    await expect(goals.save({ ...goal(), originalBriefRef: 'brief-abcd-abcd.txt', originalBriefHash: 'a'.repeat(64) }, null)).rejects.toThrow(/missing/u);
    expect(await goals.load('/project', 'session')).toBeNull();
    await goals.deleteSession('/project', 'session');
    await goals.deleteSession('/project', 'session');
    await store.createTasks().deleteSession('/project', 'session');
    await store.createQueue().deleteSession('/project', 'session');
    expect(await goals.load('/project', 'session')).toBeNull();
  });

  it('atomically archives current goal and briefs, keeps prior history, and removes it only on explicit session deletion', async () => {
    const { open } = await fixture();
    let store = await open();
    const brief = await store.createGoals().saveBrief('/project', 'session', 'goal', 'Synthetic source brief');
    const state = { ...goal(), originalBriefRef: brief.ref, originalBriefHash: brief.hash };
    await store.createGoals().save(state, null);
    await expect(store.createGoals().archiveAndClear({ ...state, revision: 2 })).rejects.toThrow(/changed before/u);
    await store.createGoals().archiveAndClear(state);
    expect(await store.createGoals().load('/project', 'session')).toBeNull();
    await store.close(); store = await open();
    const db = new DatabaseSync(store.filename, { readOnly: true });
    try {
      const row = db.prepare('SELECT content FROM document_revisions WHERE document_id IN (SELECT id FROM documents WHERE kind = ?)').get(JSON.stringify('fate.state.goal-archive'));
      expect(JSON.parse(String(row?.content))).toMatchObject({ state, briefs: { [brief.ref]: 'Synthetic source brief' } });
    } finally { db.close(); }
    await store.createGoals().deleteSession('/project', 'session');
    expect(await store.createGoals().load('/project', 'session')).toBeNull();
  });

  it('does not clear a current goal when the atomic archival commit fails', async () => {
    const { open } = await fixture(); const store = await open();
    await store.createGoals().save(goal(), null);
    const db = new DatabaseSync(store.filename);
    db.exec("CREATE TRIGGER reject_archive BEFORE INSERT ON documents WHEN NEW.kind = '\"fate.state.goal-archive\"' BEGIN SELECT RAISE(ABORT, 'archive disk failure'); END"); db.close();
    await expect(store.createGoals().archiveAndClear(goal())).rejects.toThrow(/archive disk failure/u);
    await store.close();
    const reopened = await open();
    expect(await reopened.createGoals().load('/project', 'session')).toEqual(goal());
  });

  it('does not corrupt the archive index if a goal identity and revision are reused', async () => {
    const store = await (await fixture()).open(); const goals = store.createGoals();
    await goals.save(goal(), null); await goals.archiveAndClear(goal());
    await goals.save(goal(), null);
    await expect(goals.archiveAndClear(goal())).rejects.toThrow(/already retained/u);
    expect(await goals.load('/project', 'session')).toEqual(goal());
  });

  it('requires a real matching profile owner and fences cached reads after ownership changes', async () => {
    const { root, dataRoot, profileOwner, open } = await fixture();
    const store = await open();
    await store.createTasks().save(tasks(), null);
    const ownerFile = profileOwner.recordPath;
    const original = await fs.readFile(ownerFile, 'utf8');
    await fs.writeFile(ownerFile, JSON.stringify({ ...profileOwner.record, token: 'different' }));
    try {
      await expect(store.createTasks().load('/project', 'session')).rejects.toThrow(/ownership changed/u);
      await expect(store.createTasks().save(tasks(2), 1)).rejects.toThrow(/ownership changed/u);
      await expect(openFateDurableStore({ dataRoot, profileOwner })).rejects.toThrow(/ownership changed/u);
    } finally { await fs.writeFile(ownerFile, original); }
    const otherRoot = path.join(root, 'other'); await fs.mkdir(otherRoot, { mode: 0o700 });
    await expect(openFateDurableStore({ dataRoot: otherRoot, profileOwner })).rejects.toThrow(/outside its profile/u);
    await expect(OwnerLock.acquire(path.join(root, 'locks'), 'profile', await canonicalFuturePath(dataRoot))).rejects.toThrow(/Owner already in use/u);
  });

  it('detects existing legacy state without touching it and permits genuinely empty legacy directories', async () => {
    const { dataRoot, open } = await fixture();
    const legacy = path.join(dataRoot, 'tasks', 'v1'); await fs.mkdir(legacy, { recursive: true });
    const file = path.join(legacy, 'unchanged.json'); await fs.writeFile(file, '{legacy synthetic}');
    await expect(open()).rejects.toThrow(/explicit validated migration/u);
    expect(await fs.readFile(file, 'utf8')).toBe('{legacy synthetic}');
    await expect(fs.stat(path.join(dataRoot, 'durable'))).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.rm(file);
    await (await open()).close();
  });

  it('rejects unsafe legacy links and private storage links instead of following them', async () => {
    const { root, dataRoot, open } = await fixture();
    await fs.mkdir(path.join(dataRoot, 'tasks'));
    await fs.symlink(root, path.join(dataRoot, 'tasks', 'v1'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(open()).rejects.toThrow(/unsafe link/u);
    await fs.unlink(path.join(dataRoot, 'tasks', 'v1'));
    await fs.symlink(root, path.join(dataRoot, 'durable'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(open()).rejects.toThrow(/private directory/u);
  });
});

describe('explicit native durable import', () => {
  it.each(['pending', 'ready'] as const)('verifies actual imported payloads even with an intact %s plan and ledger', async (phase) => {
    const { dataRoot, profileOwner, open } = await fixture(); const source = snapshot();
    const plan = { requestId: `changed-${phase}`, sourceDigest: 'a'.repeat(64), sessions: [{ key: durableSessionKey(source.projectPath, source.sessionId), digest: durableImportDigest(source) }] };
    const store = await open({ mode: 'import', importPlan: plan });
    await store.importSessionSnapshot(plan.requestId, source);
    if (phase === 'ready') await store.finishImport({ requestId: plan.requestId, sourceDigest: plan.sourceDigest, expectedSessions: 1 });
    await store.close();
    const db = new DatabaseSync(store.filename);
    const row = db.prepare('SELECT content FROM document_revisions WHERE document_id IN (SELECT id FROM documents WHERE kind = ?)').get(JSON.stringify('fate.state.queue'));
    const changed = JSON.parse(String(row?.content)); changed.messages[0].text = 'Valid but unplanned changed draft';
    db.prepare('UPDATE document_revisions SET content = ? WHERE document_id IN (SELECT id FROM documents WHERE kind = ?)').run(JSON.stringify(changed), JSON.stringify('fate.state.queue')); db.close();
    await expect(verifyCompletedDurableImport({ dataRoot, profileOwner, importPlan: plan, snapshots: [source] })).rejects.toThrow(/payload digest mismatch/u);
    if (phase === 'pending') {
      const resumed = await open({ mode: 'import', importPlan: plan });
      await expect(resumed.importSessionSnapshot(plan.requestId, source)).rejects.toThrow(/payload digest mismatch/u);
    }
  });

  it.each(['tasks', 'goal', 'goal-archive'] as const)('verifies native imported %s content rather than trusting completion metadata', async (kind) => {
    const { dataRoot, profileOwner, open } = await fixture(); const source = snapshot();
    const plan = { requestId: `changed-${kind}`, sourceDigest: 'a'.repeat(64), sessions: [{ key: durableSessionKey(source.projectPath, source.sessionId), digest: durableImportDigest(source) }] };
    const store = await open({ mode: 'import', importPlan: plan });
    await store.importSessionSnapshot(plan.requestId, source); await store.finishImport({ requestId: plan.requestId, sourceDigest: plan.sourceDigest, expectedSessions: 1 }); await store.close();
    const db = new DatabaseSync(store.filename);
    const row = db.prepare('SELECT content FROM document_revisions WHERE document_id IN (SELECT id FROM documents WHERE kind = ?)').get(JSON.stringify(`fate.state.${kind}`));
    const changed = JSON.parse(String(row?.content)); changed.state.updatedAt += 1;
    db.prepare('UPDATE document_revisions SET content = ? WHERE document_id IN (SELECT id FROM documents WHERE kind = ?)').run(JSON.stringify(changed), JSON.stringify(`fate.state.${kind}`)); db.close();
    await expect(verifyCompletedDurableImport({ dataRoot, profileOwner, importPlan: plan, snapshots: [source] })).rejects.toThrow(/payload digest mismatch/u);
  });

  it('reports verification close uncertainty with the same typed ownership-retention signal', async () => {
    const { open, dataRoot, profileOwner } = await fixture(); const source = snapshot();
    const plan = { requestId: 'verification-close', sourceDigest: 'a'.repeat(64), sessions: [{ key: durableSessionKey(source.projectPath, source.sessionId), digest: durableImportDigest(source) }] };
    const store = await open({ mode: 'import', importPlan: plan });
    await store.importSessionSnapshot(plan.requestId, source);
    await store.finishImport({ requestId: plan.requestId, sourceDigest: plan.sourceDigest, expectedSessions: 1 }); await store.close();
    const originalClose = SqliteStorage.prototype.close;
    const close = vi.spyOn(SqliteStorage.prototype, 'close').mockImplementation(async function (this: SqliteStorage, context) {
      await originalClose.call(this, context); throw new Error('Synthetic verification close outcome is uncertain');
    });
    try { await expect(verifyCompletedDurableImport({ dataRoot, profileOwner, importPlan: plan, snapshots: [source] })).rejects.toBeInstanceOf(DurableStorageCloseUncertainError); }
    finally { close.mockRestore(); }
  });

  it('refuses to overwrite retained state when an import ledger is missing', async () => {
    const { open } = await fixture(); const source = snapshot();
    const plan = { requestId: 'damaged-ledger', sourceDigest: 'a'.repeat(64), sessions: [{ key: durableSessionKey(source.projectPath, source.sessionId), digest: durableImportDigest(source) }] };
    let store = await open({ mode: 'import', importPlan: plan });
    await store.importSessionSnapshot(plan.requestId, source); await store.close();
    const db = new DatabaseSync(store.filename);
    const row = db.prepare('SELECT content FROM document_revisions WHERE document_id IN (SELECT id FROM documents WHERE kind = ?)').get(JSON.stringify('fate.state.profile'));
    const broken = JSON.parse(String(row?.content)); broken.completed = {};
    db.prepare('UPDATE document_revisions SET content = ? WHERE document_id IN (SELECT id FROM documents WHERE kind = ?)').run(JSON.stringify(broken), JSON.stringify('fate.state.profile')); db.close();
    store = await open({ mode: 'import', importPlan: plan });
    await expect(store.importSessionSnapshot(plan.requestId, source)).rejects.toThrow(/unaccounted existing/u);
    await expect(store.finishImport({ requestId: plan.requestId, sourceDigest: plan.sourceDigest, expectedSessions: 1 })).rejects.toThrow(/incomplete/u);
  });

  it('verifies completed staging after finish-before-activation interruption without reopening import writes', async () => {
    const { dataRoot, profileOwner, open } = await fixture(); const source = snapshot();
    const plan = { requestId: 'finished-staging', sourceDigest: 'a'.repeat(64), sessions: [{ key: durableSessionKey(source.projectPath, source.sessionId), digest: durableImportDigest(source) }] };
    const store = await open({ mode: 'import', importPlan: plan });
    await store.close();
    await expect(verifyCompletedDurableImport({ dataRoot, profileOwner, importPlan: plan, snapshots: [source] })).resolves.toBe(false);
    const resumed = await open({ mode: 'import', importPlan: plan });
    await resumed.importSessionSnapshot(plan.requestId, source);
    await resumed.finishImport({ requestId: plan.requestId, sourceDigest: plan.sourceDigest, expectedSessions: 1 });
    await resumed.close();
    await expect(verifyCompletedDurableImport({ dataRoot, profileOwner, importPlan: plan, snapshots: [source] })).resolves.toBe(true);
    await expect(verifyCompletedDurableImport({ dataRoot, profileOwner, importPlan: { ...plan, sourceDigest: 'b'.repeat(64) }, snapshots: [source] })).rejects.toThrow(/exact validated plan/u);
    await expect(open({ mode: 'import', importPlan: plan })).rejects.toThrow(/already active/u);
    expect(await (await open()).createTasks().load('/project', 'session')).toEqual(source.tasks);
  });

  it('binds complete plan/digest, survives interrupted import, and imports archives without executing uncertain state', async () => {
    const { dataRoot, open } = await fixture();
    const source = snapshot(); const another = { ...snapshot(), sessionId: 'second', tasks: null, goal: null, archives: [] };
    const plan = { requestId: 'synthetic-import', sourceDigest: 'a'.repeat(64), sessions: [source, another].map((item) => ({ key: durableSessionKey(item.projectPath, item.sessionId), digest: durableImportDigest(item) })) };
    let store = await open({ mode: 'import', importPlan: plan });
    await expect(store.createQueue().load('/project', 'session')).rejects.toThrow(/must finish/u);
    await expect(store.importSessionSnapshot('wrong', source)).rejects.toThrow(/does not own/u);
    await expect(store.importSessionSnapshot(plan.requestId, { ...source, tasks: tasks(8) })).rejects.toThrow(/validated plan/u);
    expect(await store.importSessionSnapshot(plan.requestId, source)).toBe('imported');
    await expect(store.finishImport({ requestId: plan.requestId, sourceDigest: plan.sourceDigest, expectedSessions: 2 })).rejects.toThrow(/incomplete/u);
    await store.close();
    await expect(open()).rejects.toThrow(/import is incomplete/u);
    await expect(open({ mode: 'import', importPlan: { ...plan, sourceDigest: 'b'.repeat(64) } })).rejects.toThrow(/exact validated plan/u);
    store = await open({ mode: 'import', importPlan: plan });
    expect(await store.importSessionSnapshot(plan.requestId, source)).toBe('already-imported');
    expect(await store.importSessionSnapshot(plan.requestId, another)).toBe('imported');
    await expect(store.finishImport({ requestId: plan.requestId, sourceDigest: 'b'.repeat(64), expectedSessions: 2 })).rejects.toThrow(/incomplete/u);
    await store.finishImport({ requestId: plan.requestId, sourceDigest: plan.sourceDigest, expectedSessions: 2 });
    expect(await store.createTasks().load('/project', 'session')).toEqual(source.tasks);
    expect(await store.createGoals().load('/project', 'session')).toEqual(source.goal);
    expect(await store.createQueue().load('/project', 'session')).toEqual(source.queues[0]!.messages);
    await store.close();
    // Preserved legacy files must not trigger an accidental reimport after activation.
    const legacy = path.join(dataRoot, 'tasks', 'v1'); await fs.mkdir(legacy, { recursive: true }); await fs.writeFile(path.join(legacy, 'retained.json'), 'kept');
    store = await open();
    expect(await store.createTasks().load('/project', 'session')).toEqual(source.tasks);
    const db = new DatabaseSync(store.filename, { readOnly: true });
    try {
      expect(db.prepare('SELECT count(*) AS n FROM tasks').get()?.n).toBe(0);
      expect(db.prepare('SELECT count(*) AS n FROM documents WHERE kind = ?').get(JSON.stringify('fate.state.goal-archive'))?.n).toBe(1);
    } finally { db.close(); }
  });

  it('rolls back import ledger and all state together on write failure', async () => {
    const { open } = await fixture(); const source = snapshot();
    const plan = { requestId: 'failure-import', sourceDigest: 'a'.repeat(64), sessions: [{ key: durableSessionKey(source.projectPath, source.sessionId), digest: durableImportDigest(source) }] };
    let store = await open({ mode: 'import', importPlan: plan });
    let db = new DatabaseSync(store.filename);
    db.exec("CREATE TRIGGER reject_import BEFORE INSERT ON documents WHEN NEW.kind = '\"fate.state.goal\"' BEGIN SELECT RAISE(ABORT, 'import disk failure'); END"); db.close();
    await expect(store.importSessionSnapshot(plan.requestId, source)).rejects.toThrow(/import disk failure/u);
    await store.close();
    db = new DatabaseSync(store.filename); db.exec('DROP TRIGGER reject_import');
    expect(db.prepare('SELECT count(*) AS n FROM documents').get()?.n).toBe(1); db.close();
    store = await open({ mode: 'import', importPlan: plan });
    expect(await store.importSessionSnapshot(plan.requestId, source)).toBe('imported');
    await store.finishImport({ requestId: plan.requestId, sourceDigest: plan.sourceDigest, expectedSessions: 1 });
  });
});
