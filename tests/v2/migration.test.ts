import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { FatePaths } from '../../src/core/FatePaths';
import { MigrationService } from '../../src/core/storage/MigrationService';
import { OwnerLock } from '../../src/core/ownership/OwnerLock';
import { hostCheckoutLockRoot } from '../../src/core/ownership/CheckoutOwnership';
import { openFateDurableStore } from '../../src/core/durable/FateDurableStore';
import { fingerprintMigrationFile } from '../../src/core/storage/MigrationFiles';
import type { GoalMaxState } from '../../src/shared/contracts/goalmaxxing';
import { createTeamRuntime, projectTeam } from '../../src/main/pi/multi-agent/AgentTeamStore';
import { createFateCore } from '../../src/core/createFateCore';
import { SessionQueueRepository } from '../../src/main/pi/SessionQueueRepository';
import { FakePiSdkAdapter } from './helpers/fakePi';
import type { QueuedMessage } from '../../src/shared/contracts/ipc';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture(sessionId = randomUUID()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-migration-')); roots.push(root);
  const dataRoot = path.join(root, 'profile');
  const project = path.join(root, 'project');
  const backupRoot = path.join(root, 'backups');
  const paths = new FatePaths({ dataRoot, piAgentDir: path.join(root, 'pi'), sessionsRoot: path.join(root, 'pi', 'sessions'),
    lockRoot: path.join(root, 'locks'), attachmentRoot: path.join(root, 'attachments'), profileId: 'test', profileKind: 'desktop' });
  for (const target of [dataRoot, project, backupRoot]) await fs.mkdir(target, { mode: 0o700 });
  const directory = path.join(paths.sessionsRoot, `--${project.replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const transcript = path.join(directory, `fixture_${sessionId}.jsonl`);
  await fs.writeFile(transcript, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: project, timestamp: new Date(0).toISOString() }) + '\n', { mode: 0o600 });
  const queueDir = path.join(dataRoot, 'session-queues', 'v1', 'instance-0');
  await fs.mkdir(queueDir, { recursive: true, mode: 0o700 });
  const queueFile = path.join(queueDir, `${hash(`${project}\0${sessionId}`)}.json`);
  await fs.writeFile(queueFile, JSON.stringify({ version: 1, projectPath: project, sessionId,
    messages: [{ id: randomUUID(), behavior: 'followUp', text: 'Do not replay this draft', createdAt: 0 }] }), { mode: 0o600 });
  const service = new MigrationService({ paths, backupRoot, sourceVersion: '1.1.0', targetVersion: '2.0.0' });
  return { root, paths, project, sessionId, transcript, queueFile, backupRoot, service };
}
async function addGoal(f: Awaited<ReturnType<typeof fixture>>) {
  const brief = 'The complete original source brief'; const briefHash = hash(brief); const briefRef = `brief-${hash('goal').slice(0, 16)}-${briefHash.slice(0, 16)}.txt`;
  const goal: GoalMaxState = { schemaVersion: 2, id: 'goal', sessionId: f.sessionId, projectPath: f.project, revision: 1,
    objective: 'Complete the work', originalBriefRef: briefRef, originalBriefHash: briefHash, status: 'active', phase: 'implementation',
    executionState: 'running-root', verificationLevel: 'normal', agentStrategy: 'auto',
    criteria: [{ id: 'criterion', title: 'Check work', description: '', required: true, status: 'active', evidenceIds: [], ownerNodeIds: [], updatedAt: 0 }],
    budget: { tokenLimit: null, timeLimitMs: null, source: null }, permission: { permissionLevel: 'full-access', projectTrusted: true, revision: 1, resolvedAt: 0 },
    progress: { meaningfulTurnCount: 0, noProgressTurnCount: 0, repeatedFailureCount: 0, planningOnlyTurnCount: 0, changedFileCount: 0,
      baselineWorkspaceFingerprint: 'original', latestWorkspaceFingerprint: 'original', latestEvidenceAt: null, latestMeaningfulProgressAt: null, lastFailureFingerprint: null },
    evidence: [], continuation: { pending: true, attempt: 1, lastScheduledAt: 0, lastSettledAt: null, reason: null }, steering: [], childAssignments: [],
    tokensUsed: 0, tokenBaseline: 0, elapsedMs: 0, timeline: [], createdAt: 0, updatedAt: 0, startedAt: 0, completedAt: null, blockedReason: null, failure: null };
  const dir = path.join(f.paths.dataRoot, 'goalmaxxing', 'v1', hash(f.project).slice(0, 32), hash(f.sessionId).slice(0, 32));
  await fs.mkdir(path.join(dir, 'archive'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dir, 'current.json'), JSON.stringify(goal), { mode: 0o600 });
  await fs.writeFile(path.join(dir, briefRef), brief, { mode: 0o600 });
  const archived = { ...goal, id: 'old-goal', status: 'cancelled' };
  await fs.writeFile(path.join(dir, 'archive', `${hash(archived.id).slice(0, 24)}-1.json`), JSON.stringify(archived), { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'archive', briefRef), brief, { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'events.jsonl'), JSON.stringify({ goalId: goal.id, revision: 1, status: 'active', timestamp: 0 }) + '\n', { mode: 0o600 });
  const taskDir = path.join(f.paths.dataRoot, 'tasks', 'v1', hash(f.project).slice(0, 32), hash(f.sessionId).slice(0, 32));
  await fs.mkdir(taskDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(taskDir, 'current.json'), JSON.stringify({ schemaVersion: 1, projectPath: f.project, sessionId: f.sessionId,
    revision: 1, goalId: null, currentTaskId: 'task', updatedAt: 0, tasks: [{ id: 'task', title: 'Inspect', detail: '', status: 'in-progress',
      required: true, source: 'user', goalId: null, goalCriterionId: null, order: 0, verified: true, verifiedAt: 0, createdAt: 0, updatedAt: 0 }] }), { mode: 0o600 });
  return { goal, dir, briefRef, brief };
}
describe('explicit native state migration', () => {
  it('dry run is observational and does not create an owner, backup or destination', async () => {
    const f = await fixture(); const before = await fs.readdir(f.paths.dataRoot);
    const report = await f.service.dryRun();
    expect(report.errors).toEqual([]); expect(report.plan?.sessions).toHaveLength(1);
    expect(await fs.readdir(f.paths.dataRoot)).toEqual(before);
    expect(await fs.readdir(f.backupRoot)).toEqual([]);
    await expect(fs.stat(f.paths.lockRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('uses real native storage, preserves all source/archives/briefs and imports no execution or authority', async () => {
    const f = await fixture(); const g = await addGoal(f);
    await fs.writeFile(path.join(f.paths.dataRoot, 'auth.json'), '{"fixture":"excluded"}', { mode: 0o600 });
    await fs.writeFile(path.join(f.paths.dataRoot, 'session-permissions.json'), '{"fixture":"excluded-grant"}', { mode: 0o600 });
    const original = await fs.readFile(f.transcript); const queue = await fs.readFile(f.queueFile);
    const report = await f.service.dryRun(); expect(report.errors).toEqual([]); const plan = report.plan!;
    expect(plan.files).toHaveLength(7);
    const result = await f.service.apply(plan); expect(result.status).toBe('activated');
    expect(await fs.readFile(f.transcript)).toEqual(original); expect(await fs.readFile(f.queueFile)).toEqual(queue);
    expect(await fs.readFile(path.join(result.backup, path.relative(f.paths.dataRoot, g.dir), 'archive', g.briefRef), 'utf8')).toBe(g.brief);
    await expect(fs.stat(path.join(result.backup, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(result.backup, 'session-permissions.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(path.join(f.paths.dataRoot, 'durable', 'v1', 'state.sqlite'), { readOnly: true });
    try {
      expect(database.prepare('SELECT count(*) AS count FROM tasks').get()?.count).toBe(0);
      expect(database.prepare('SELECT count(*) AS count FROM submissions').get()?.count).toBe(0);
    } finally { database.close(); }
    const owner = await OwnerLock.acquire(f.paths.lockRoot, 'profile', f.paths.dataRoot);
    try {
      const store = await openFateDurableStore({ dataRoot: f.paths.dataRoot, profileOwner: owner });
      try {
        expect((await store.createQueue(1).load(f.project, f.sessionId))[0]?.text).toBe('Do not replay this draft');
        expect(await store.createQueue(0).load(f.project, f.sessionId)).toEqual([]);
        const state = await store.createGoals().load(f.project, f.sessionId);
        expect(state).toMatchObject({ status: 'paused', executionState: 'idle', continuation: { pending: false }, permission: { permissionLevel: 'read-only', projectTrusted: false } });
        expect(state?.blockedReason).toContain('UNKNOWN');
        expect((await store.createTasks().load(f.project, f.sessionId))?.tasks[0]).toMatchObject({ status: 'blocked', verified: false });
      } finally { await store.close(); }
    } finally { await owner.release(); }
  });
  it('maps legacy slot 0 into the actual core primary recovered queue, preserving complete drafts and other slots', async () => {
    // The deterministic provider-only test adapter resumes this identity; core,
    // runtime, queue recovery and native persistence are the production paths.
    const f = await fixture('00000000-0000-4000-8000-000000000001');
    const draft: QueuedMessage = { id: randomUUID(), behavior: 'steer', text: 'Review this original draft', createdAt: 2,
      requestedModel: { provider: 'v2-fake', id: 'v2-deterministic' }, requestedThinkingLevel: 'off',
      images: [{ data: 'c3ludGhldGlj', mimeType: 'image/png', name: 'synthetic.png' }],
      sessionReferences: [{ id: f.sessionId, projectPath: f.project, title: 'Saved reference' }],
      learning: { binding: { projectKey: hash(f.project), sessionId: f.sessionId, runtimeGeneration: 7, scope: 'project' },
        pins: [{ lessonId: randomUUID(), revisionId: randomUUID() }], excluded: [randomUUID()] } };
    const primary: QueuedMessage = { id: randomUUID(), behavior: 'followUp', text: 'Slot one follows slot zero', createdAt: 1 };
    const secondary: QueuedMessage = { id: randomUUID(), behavior: 'followUp', text: 'Slot two is unchanged', createdAt: 0 };
    for (const [slot, messages] of [[0, [draft]], [1, [primary]], [2, [secondary]]] as const) {
      await new SessionQueueRepository(path.join(f.paths.dataRoot, 'session-queues', 'v1'), slot).save(f.project, f.sessionId, messages);
    }
    const plan = (await f.service.dryRun()).plan!;
    const originals = await Promise.all(plan.files.map((file) => fs.readFile(path.join(f.paths.dataRoot, file.name))));
    const result = await f.service.apply(plan);
    for (let index = 0; index < plan.files.length; index++) {
      expect(await fs.readFile(path.join(f.paths.dataRoot, plan.files[index]!.name))).toEqual(originals[index]);
      expect(await fs.readFile(path.join(result.backup, plan.files[index]!.name))).toEqual(originals[index]);
    }
    const adapter = new FakePiSdkAdapter();
    const core = await createFateCore({ paths: f.paths, adapter });
    try {
      expect(core.statePersistence).toBe('native-durable');
      const state = await core.runtime.openProject({ path: f.project, name: 'Synthetic migration', trusted: true });
      expect(state.sessionId).toBe(f.sessionId);
      if (!state.queue) throw new Error('Actual core did not publish its recovered queue.');
      expect(state.queue.recovered).toEqual([draft, primary]);
      expect(state.queue.items).toEqual([]); expect(state.queue.followUp).toBe(0); expect(state.queue.steering).toBe(0);
      expect(adapter.invocations.filter((event) => ['prompt', 'tool', 'providerBlocked'].includes(event.kind))).toEqual([]);
    } finally { await core.dispose(); await adapter.dispose(); }
    const owner = await OwnerLock.acquire(f.paths.lockRoot, 'profile', f.paths.dataRoot);
    try {
      const store = await openFateDurableStore({ dataRoot: f.paths.dataRoot, profileOwner: owner });
      try { expect(await store.createQueue(2).load(f.project, f.sessionId)).toEqual([secondary]); }
      finally { await store.close(); }
    } finally { await owner.release(); }
  });
  it.each(['identical', 'different'] as const)('refuses %s duplicate draft UUIDs across slots 0 and 1 without writes', async (kind) => {
    const f = await fixture(); const original = await fs.readFile(f.queueFile);
    const draft = JSON.parse(original.toString()).messages[0] as QueuedMessage;
    await new SessionQueueRepository(path.join(f.paths.dataRoot, 'session-queues', 'v1'), 1).save(f.project, f.sessionId,
      [{ ...draft, ...(kind === 'different' ? { text: 'different content' } : {}) }]);
    const report = await f.service.dryRun(); expect(report.plan).toBeNull(); expect(report.errors.join(' ')).toContain('colliding draft IDs');
    expect(await fs.readFile(f.queueFile)).toEqual(original); expect(await fs.readdir(f.backupRoot)).toEqual([]);
    await expect(fs.stat(f.paths.lockRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses merged primary queues above 100 drafts or 64 MiB including attachments', async () => {
    const f = await fixture();
    const drafts = (count: number): QueuedMessage[] => Array.from({ length: count }, () => ({ id: randomUUID(), text: 'review', behavior: 'followUp', createdAt: 0 }));
    const queue = (slot: number) => new SessionQueueRepository(path.join(f.paths.dataRoot, 'session-queues', 'v1'), slot);
    await queue(0).save(f.project, f.sessionId, drafts(51)); await queue(1).save(f.project, f.sessionId, drafts(50));
    expect((await f.service.dryRun()).errors.join(' ')).toContain('exceeds 100 drafts');
    const messages = drafts(2).map((draft) => ({ ...draft, images: [{ data: 'x'.repeat(8_500_000), mimeType: 'image/png' as const, name: 'a.png' },
      { data: 'y'.repeat(8_500_000), mimeType: 'image/png' as const, name: 'b.png' }] }));
    await queue(0).save(f.project, f.sessionId, messages);
    await queue(1).save(f.project, f.sessionId, messages.map((draft) => ({ ...draft, id: randomUUID() })));
    const report = await f.service.dryRun(); expect(report.plan).toBeNull(); expect(report.errors.join(' ')).toContain('Merged primary queue exceeds its size limit');
    expect(await fs.readdir(f.backupRoot)).toEqual([]);
  });
  it.each(['staged', 'import-finished'] as const)('refuses modified native payload after %s interruption and retains any original seal', async (phase) => {
    const f = await fixture(); const plan = (await f.service.dryRun()).plan!;
    const interrupted = new MigrationService({ paths: f.paths, backupRoot: f.backupRoot, sourceVersion: '1.1.0', targetVersion: '2.0.0',
      checkpoint: (at) => { if (at === phase) throw new Error('injected interruption'); } });
    await expect(interrupted.apply(plan)).rejects.toThrow('injected interruption');
    const staging = path.join(f.paths.dataRoot, 'migrations', plan.id);
    const seal = phase === 'staged' ? await fs.readFile(path.join(staging, 'ready.json')) : null;
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(path.join(staging, 'durable', 'v1', 'state.sqlite'));
    try {
      const row = database.prepare('SELECT content FROM document_revisions WHERE document_id IN (SELECT id FROM documents WHERE kind = ?)').get(JSON.stringify('fate.state.queue'));
      const queue = JSON.parse(String(row?.content)); queue.messages[0].text = 'Modified outside the approved import';
      database.prepare('UPDATE document_revisions SET content = ? WHERE document_id IN (SELECT id FROM documents WHERE kind = ?)').run(JSON.stringify(queue), JSON.stringify('fate.state.queue'));
    } finally { database.close(); }
    await expect(f.service.apply(plan)).rejects.toThrow(/changed|digest|mismatch|corrupt/i);
    await expect(fs.stat(path.join(f.paths.dataRoot, 'durable'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (seal) expect(await fs.readFile(path.join(staging, 'ready.json'))).toEqual(seal);
    else await expect(fs.stat(path.join(staging, 'ready.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses candidate changes made after sealing immediately before activation', async () => {
    const f = await fixture(); const plan = (await f.service.dryRun()).plan!;
    const interrupted = new MigrationService({ paths: f.paths, backupRoot: f.backupRoot, sourceVersion: '1.1.0', targetVersion: '2.0.0',
      checkpoint: async (at) => { if (at === 'before-activation') await fs.writeFile(path.join(f.paths.dataRoot, 'migrations', plan.id, 'durable', 'unexpected.json'), '{}', { mode: 0o600 }); } });
    await expect(interrupted.apply(plan)).rejects.toThrow('changed before activation');
    await expect(fs.stat(path.join(f.paths.dataRoot, 'durable'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses active or uncertain ownership without deleting another owner record', async () => {
    const f = await fixture(); const plan = (await f.service.dryRun()).plan!;
    const owner = await OwnerLock.acquire(f.paths.lockRoot, 'profile', f.paths.dataRoot);
    try {
      expect((await f.service.dryRun()).errors.join(' ')).toContain('ownership is uncertain');
      await expect(f.service.apply(plan)).rejects.toThrow('Owner already in use');
      expect(JSON.parse(await fs.readFile(path.join(owner.lockPath, 'owner.json'), 'utf8')).token).toBe(owner.record.token);
    } finally { await owner.release(); }
  });
  it('rejects changed source and cross-host plans before backup or staging', async () => {
    const f = await fixture(); const plan = (await f.service.dryRun()).plan!;
    await expect(f.service.apply({ ...plan, host: 'a-different-host' })).rejects.toThrow('another host');
    await fs.appendFile(f.queueFile, ' ');
    await expect(f.service.apply(plan)).rejects.toThrow('source changed');
    expect(await fs.readdir(f.backupRoot)).toEqual([]);
    await expect(fs.stat(path.join(f.paths.dataRoot, 'durable'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('locks referenced checkouts and rejects a modified count manifest', async () => {
    const f = await fixture(); const plan = (await f.service.dryRun()).plan!;
    await expect(f.service.apply({ ...plan, sessions: [] })).rejects.toThrow('source changed');
    const lock = await OwnerLock.acquire(hostCheckoutLockRoot(), 'checkout', f.project);
    try {
      expect((await f.service.dryRun()).errors.join(' ')).toContain('referenced checkout');
      await expect(f.service.apply(plan)).rejects.toThrow('Owner already in use');
    } finally { await lock.release(); }
  });
  it('rechecks source after backup/staging immediately before activation', async () => {
    const f = await fixture(); const plan = (await f.service.dryRun()).plan!;
    const changed = new MigrationService({ paths: f.paths, backupRoot: f.backupRoot, sourceVersion: '1.1.0', targetVersion: '2.0.0',
      checkpoint: async (at) => { if (at === 'before-activation') await fs.appendFile(f.queueFile, ' '); } });
    await expect(changed.apply(plan)).rejects.toThrow('source changed');
    await expect(fs.stat(path.join(f.paths.dataRoot, 'durable'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.stat(path.join(f.paths.dataRoot, 'migrations', plan.id, 'durable', 'v1', 'state.sqlite'))).toBeDefined();
  });
  it('reports a truncated original transcript and preserves its incomplete tail', async () => {
    const f = await fixture(); await fs.appendFile(f.transcript, '{"type":"message"');
    const original = await fs.readFile(f.transcript);
    expect((await f.service.dryRun()).errors.join(' ')).toContain('incomplete final record');
    expect(await fs.readFile(f.transcript)).toEqual(original);
  });
  it('refuses dangling GoalMax task item and criterion references', async () => {
    const f = await fixture(); await addGoal(f);
    const target = path.join(f.paths.dataRoot, 'tasks', 'v1', hash(f.project).slice(0, 32), hash(f.sessionId).slice(0, 32), 'current.json');
    const task = JSON.parse(await fs.readFile(target, 'utf8'));
    task.tasks[0].source = 'goalmax'; task.tasks[0].goalId = 'missing-goal'; task.tasks[0].goalCriterionId = 'criterion';
    await fs.writeFile(target, JSON.stringify(task));
    expect((await f.service.dryRun()).errors.join(' ')).toContain('absent goal or criterion');
    task.tasks[0].goalId = 'goal'; task.tasks[0].goalCriterionId = 'missing-criterion'; await fs.writeFile(target, JSON.stringify(task));
    expect((await f.service.dryRun()).errors.join(' ')).toContain('absent goal or criterion');
  });
  it('checks retained worktrees without resurrecting removed workspaces from old Team history', async () => {
    const f = await fixture();
    const team = projectTeam(createTeamRuntime(f.sessionId, f.project, { provider: 'fake', id: 'fake', name: 'Fake', reasoning: false, contextWindow: 1000 }, 'low', 'edit'));
    team.nodes[0]!.workspace = { mode: 'worktree', path: path.join(f.root, 'missing-worktree'), parentPath: f.project,
      commonDirectory: path.join(f.project, '.git'), branch: 'child', baseCommit: 'a'.repeat(40), state: 'ready' };
    const event = (id: string, parentId: string | null, sequence: number) => JSON.stringify({ type: 'custom', id, parentId,
      timestamp: new Date(0).toISOString(), customType: 'fate-agent-team-event', data: { kind: 'fate-agent-team-event', version: 1,
        teamId: team.id, sequence, timestamp: 0, type: 'team.updated', payload: { team } } }) + '\n';
    await fs.appendFile(f.transcript, event('entry-1', null, 1));
    expect((await f.service.dryRun()).errors.join(' ')).toContain('workspaces');
    team.nodes[0]!.workspace!.state = 'removed';
    await fs.appendFile(f.transcript, event('entry-2', 'entry-1', 2));
    expect((await f.service.dryRun()).errors).toEqual([]);
  });
  it('refuses corrupt, unsupported, oversized and absent-reference records without rewriting them', async () => {
    const f = await fixture(); const saved = await fs.readFile(f.queueFile);
    await fs.writeFile(f.queueFile, '{broken'); expect((await f.service.dryRun()).errors.join(' ')).toContain('session-queues');
    await fs.writeFile(f.queueFile, saved); const doc = JSON.parse(saved.toString()); doc.version = 99;
    await fs.writeFile(f.queueFile, JSON.stringify(doc)); expect((await f.service.dryRun()).plan).toBeNull();
    await fs.writeFile(f.queueFile, saved); await fs.truncate(f.queueFile, 64 * 1024 * 1024 + 1);
    expect((await f.service.dryRun()).errors.join(' ')).toContain('oversized');
    await fs.writeFile(f.queueFile, saved); await fs.rm(f.transcript);
    expect((await f.service.dryRun()).errors.join(' ')).toContain('no original session transcript');
  });
  it('rejects symbolic links, backup overlap, nonprivate backup and missing project identities', async () => {
    const f = await fixture(); const options = { paths: f.paths, sourceVersion: '1.1.0', targetVersion: '2.0.0' };
    expect((await new MigrationService({ ...options, backupRoot: f.paths.dataRoot }).dryRun()).errors.join(' ')).toContain('overlaps');
    await fs.chmod(f.backupRoot, 0o755); expect((await f.service.dryRun()).errors.join(' ')).toContain('private'); await fs.chmod(f.backupRoot, 0o700);
    const link = path.join(f.root, 'backup-link'); await fs.symlink(f.backupRoot, link);
    expect((await new MigrationService({ ...options, backupRoot: link }).dryRun()).errors.join(' ')).toContain('symbolic');
    await fs.rmdir(f.project); expect((await f.service.dryRun()).plan).toBeNull();
  });
  it.each(['session-imported', 'import-finished', 'staged', 'before-activation', 'activated'] as const)('recovers safely after %s interruption with the original plan', async (phase) => {
    const f = await fixture(); const plan = (await f.service.dryRun()).plan!;
    const interrupted = new MigrationService({ paths: f.paths, backupRoot: f.backupRoot, sourceVersion: '1.1.0', targetVersion: '2.0.0',
      checkpoint: (at) => { if (at === phase) throw new Error('injected interruption'); } });
    await expect(interrupted.apply(plan)).rejects.toThrow('injected interruption');
    expect((await f.service.apply(plan)).importedSessions).toBe(1);
    expect((await fs.readdir(f.backupRoot))).toEqual([plan.id]);
  });
  it('fences activation if the held profile owner token changes', async () => {
    const f = await fixture(); const plan = (await f.service.dryRun()).plan!;
    const changed = new MigrationService({ paths: f.paths, backupRoot: f.backupRoot, sourceVersion: '1.1.0', targetVersion: '2.0.0',
      checkpoint: async (at) => {
        if (at !== 'before-activation') return;
        const name = (await fs.readdir(f.paths.lockRoot)).find((item) => item.startsWith('profile-'))!;
        const ownerFile = path.join(f.paths.lockRoot, name, 'owner.json');
        const owner = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
        await fs.writeFile(ownerFile, JSON.stringify({ ...owner, token: randomUUID() }));
      } });
    await expect(changed.apply(plan)).rejects.toThrow(/owner/i);
    await expect(fs.stat(path.join(f.paths.dataRoot, 'durable'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(f.paths.lockRoot)).some((name) => name.startsWith('profile-'))).toBe(true);
  });
  it('rollback is matched-version, owner-exclusive, non-destructive and idempotent', async () => {
    const f = await fixture(); const plan = (await f.service.dryRun()).plan!;
    const original = await fs.readFile(f.queueFile); await f.service.apply(plan);
    await expect(f.service.rollback(plan, '1.0.0')).rejects.toThrow('exact original');
    const owner = await OwnerLock.acquire(f.paths.lockRoot, 'profile', f.paths.dataRoot);
    try { await expect(f.service.rollback(plan, '1.1.0')).rejects.toThrow('Owner already in use'); } finally { await owner.release(); }
    const result = await f.service.rollback(plan, '1.1.0');
    expect(await fs.readFile(f.queueFile)).toEqual(original); expect(await fs.stat(path.join(result.retainedNative, 'v1', 'state.sqlite'))).toBeDefined();
    await expect(fs.stat(path.join(f.paths.dataRoot, 'durable'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.service.rollback(plan, '1.1.0')).toEqual(result);
  });
  it('refuses rollback after candidate, backup or authoritative source changes', async () => {
    const f = await fixture(); const plan = (await f.service.dryRun()).plan!; await f.service.apply(plan);
    const candidate = path.join(f.paths.dataRoot, 'durable', 'extra.json'); await fs.writeFile(candidate, '{}', { mode: 0o600 });
    await expect(f.service.rollback(plan, '1.1.0')).rejects.toThrow('Candidate changed'); await fs.rm(candidate);
    const backupFile = path.join(f.backupRoot, plan.id, path.relative(f.paths.dataRoot, f.queueFile)); await fs.appendFile(backupFile, ' ');
    await expect(f.service.rollback(plan, '1.1.0')).rejects.toThrow('Backup contents');
  });
  it('streams a 900 MB original session with bounded records and leaves its bytes unchanged', async () => {
    const f = await fixture(); const line = JSON.stringify({ type: 'custom', data: 'x'.repeat(969) }) + '\n';
    const batch = line.repeat(1000); const handle = await fs.open(f.transcript, 'a');
    try { for (let index = 0; index < Math.ceil(900_000_000 / Buffer.byteLength(batch)); index++) await handle.write(batch); } finally { await handle.close(); }
    const before = await fingerprintMigrationFile(f.transcript, f.transcript);
    expect(before.bytes).toBeGreaterThanOrEqual(900_000_000);
    const report = await f.service.dryRun(); expect(report.errors).toEqual([]);
    expect(report.plan?.references.find((item) => item.name === f.transcript)?.sha256).toBe(before.sha256);
    expect((await fs.stat(f.transcript)).size).toBe(before.bytes);
  }, 60_000);
});
