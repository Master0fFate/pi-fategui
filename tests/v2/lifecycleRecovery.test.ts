import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '@earendil-works/pi-coding-agent';
import { PiSessionRepository } from '../../src/main/pi/PiSessionRepository';
import { createTeamRuntime, projectTeam } from '../../src/main/pi/multi-agent/AgentTeamStore';
import { inspectAgentTeamChildStorage, safeDirectoryKey } from '../../src/main/pi/multi-agent/AgentTeamHistory';
import { WorkspaceAdmissionQueue } from '../../src/core/workspaces/WorkspaceAdmissionQueue';
import { createFateCore } from '../../src/core/createFateCore';
import { FatePaths } from '../../src/core/FatePaths';
import { CoreIpcAdapter } from '../../src/main/ipc/CoreIpcAdapter';
import { FakePiSdkAdapter } from './helpers/fakePi';
import { createLocalIpcContext } from '../../src/core/dispatch/RequestContext';
import { readGoalReviewCheckout, type CheckoutFacts } from '../../src/core/recovery/GoalReviewFacts';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { TaskRepository } from '../../src/main/pi/tasks/TaskRepository';
import { InMemoryGoalMaxRepository } from '../../src/main/pi/goalmaxxing/GoalMaxRepository';
import { InMemorySessionQueueRepository } from '../../src/main/pi/SessionQueueRepository';
import { LifecycleRepository, type LifecycleReference } from '../../src/core/recovery/LifecycleRepository';
import { RecoveryCoordinator, type RecoverySources } from '../../src/core/recovery/RecoveryCoordinator';
import type { AgentTeam } from '../../src/shared/contracts/multiAgent';
import { goalMaxStateSchema } from '../../src/shared/contracts/goalmaxxing';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-lifecycle-')); roots.push(root);
  const project = path.join(root, 'project'); await fs.mkdir(project);
  const sessionsRoot = path.join(root, 'pi', 'sessions');
  const directory = path.join(sessionsRoot, `--${path.resolve(project).replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`);
  await fs.mkdir(directory, { recursive: true });
  const sessionId = 'session-1'; const target = path.join(directory, 'session.jsonl');
  const header = { type: 'session', id: sessionId, version: 3, cwd: path.resolve(project), timestamp: new Date(0).toISOString() };
  const save = async (entries: unknown[], ending = '\n') => fs.writeFile(target, [header, ...entries].map((entry) => JSON.stringify(entry)).join('\n') + ending);
  await save([]);
  const info: SessionInfo = { path: target, id: sessionId, cwd: project, created: new Date(0), modified: new Date(0), messageCount: 0, firstMessage: '', allMessagesText: '' };
  const sessions = new PiSessionRepository({ list: async () => [info], rename: () => undefined }, sessionsRoot);
  const team = projectTeam(createTeamRuntime(sessionId, project, { provider: 'fake', id: 'fake', name: 'Fake', reasoning: false, contextWindow: 1000 }, 'low', 'edit'));
  const event = (id: string, parentId: string | null, state: AgentTeam | null, sequence: number) => ({
    type: 'custom', id, parentId, timestamp: new Date(0).toISOString(), customType: 'fate-agent-team-event',
    data: { kind: 'fate-agent-team-event', version: 1, teamId: team.id, sequence, timestamp: 0,
      type: state ? 'team.updated' : 'team.deleted', payload: state ? { team: state } : {} },
  });
  const reference: LifecycleReference = { projectPath: project, sessionId, teamId: team.id, taskId: 'task-1' };
  const repository = new LifecycleRepository(path.join(root, 'profile', 'lifecycle'));
  const goals = new InMemoryGoalMaxRepository(); const queue = new InMemorySessionQueueRepository();
  const taskRepo = new TaskRepository({ write: () => undefined }, path.join(root, 'profile', 'tasks'));
  const sources: RecoverySources = {
    readSession: async () => Boolean(await sessions.resolve(project, sessionId)),
    readTeams: () => sessions.readColdTeams(project, sessionId), goals, queue,
    readTasks: (p, s) => taskRepo.loadHealth(p, s),
    commandStatus: async () => ({ state: 'absent', receipt: null, rejectionCode: null }),
    validateWorktree: async () => undefined,
    teamStorageRoots: [path.join(root, 'profile', 'agent-teams')],
  };
  return { root, project, sessions, sessionId, target, team, event, save, reference, repository, sources, taskRepo, queue };
}

async function registeredCore(root: string, project: string, goals = new InMemoryGoalMaxRepository()) {
  const adapter = new FakePiSdkAdapter();
  let registeredId: string | null = null;
  const core = await createFateCore({ adapter,
    paths: new FatePaths({ dataRoot: path.join(root, 'profile'), piAgentDir: path.join(root, 'pi'),
      sessionsRoot: path.join(root, 'pi', 'sessions'), attachmentRoot: path.join(root, 'attachments'),
      lockRoot: path.join(root, 'locks'), profileId: 'test' }),
    persistence: { createGoals: () => goals },
    workspaceRegistration: { isRegistered: (canonical) => canonical === project },
    workspaceMembership: (_identity, id) => id === registeredId });
  await core.runtime.openProject({ path: project, name: path.basename(project), trusted: true });
  const handle = await core.workspaces!.registerHostPath(project);
  registeredId = handle.id;
  return { core, adapter, handle, ipc: new CoreIpcAdapter(core.runtime, core.workspaces!, () => true),
    dispose: async () => { await core.dispose(); await adapter.dispose(); } };
}

describe('T28 bounded cold recovery', () => {
  it('captures current private checkout facts without certifying saved evidence', async () => {
    const f = await fixture();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.project, stdio: 'pipe' });
    git('init'); git('config', 'user.email', 'fake@example.invalid'); git('config', 'user.name', 'Fake');
    await fs.writeFile(path.join(f.project, 'file.txt'), 'before'); git('add', '--', 'file.txt'); git('commit', '-m', 'Initial');
    const sentinel = path.join(f.root, 'fsmonitor-sentinel');
    const monitor = path.join(f.root, 'fsmonitor.sh');
    await fs.writeFile(monitor, `#!/bin/sh\nprintf touched > '${sentinel.replace(/\\/gu, '/')}'\n`);
    await fs.chmod(monitor, 0o755);
    git('config', 'core.fsmonitor', monitor);
    const before = await readGoalReviewCheckout(f.project);
    await expect(fs.stat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.writeFile(path.join(f.project, 'file.txt'), 'after');
    await expect(readGoalReviewCheckout(f.project)).rejects.toThrow('dirty');
    git('config', 'core.fsmonitor', 'false');
    git('add', '--', 'file.txt'); git('commit', '-m', 'Changed');
    git('config', 'core.fsmonitor', monitor);
    const committed = await readGoalReviewCheckout(f.project);
    expect(committed.head).not.toBe(before.head);
    expect(committed.clean).toBe(true);
    await expect(fs.stat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('disables an untrusted attribute clean filter before clean or dirty checkout review', async () => {
    const f = await fixture();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.project, stdio: 'pipe' });
    git('init'); git('config', 'user.email', 'fake@example.invalid'); git('config', 'user.name', 'Fake');
    await fs.writeFile(path.join(f.project, '.gitattributes'), 'file.txt filter=reviewspy\n');
    await fs.writeFile(path.join(f.project, 'file.txt'), 'before\n');
    git('add', '--', '.gitattributes', 'file.txt'); git('commit', '-m', 'Initial');
    const sentinel = path.join(f.root, 'filter-sentinel');
    const filter = path.join(f.root, 'clean-filter.sh');
    await fs.writeFile(filter, `#!/bin/sh\nprintf touched > '${sentinel.replace(/\\/gu, '/')}'\ncat\n`);
    await fs.chmod(filter, 0o755);
    git('config', 'filter.reviewspy.clean', `sh "${filter.replace(/\\/gu, '/')}"`);
    git('config', 'filter.reviewspy.required', 'true');
    expect((await readGoalReviewCheckout(f.project)).clean).toBe(true);
    await expect(fs.stat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.writeFile(path.join(f.project, 'file.txt'), 'after\n');
    await expect(readGoalReviewCheckout(f.project)).rejects.toThrow('dirty');
    await expect(fs.stat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
    // Positive control is confined to this private fixture: Git's attribute conversion runs the filter.
    git('hash-object', '--path=file.txt', 'file.txt');
    expect(await fs.readFile(sentinel, 'utf8')).toBe('touched');
    await fs.rm(sentinel);
    await expect(readGoalReviewCheckout(f.project)).rejects.toThrow('dirty');
    await expect(fs.stat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('reads the SDK-selected parent branch, not an earlier fork; a tombstone wins', async () => {
    const f = await fixture();
    await f.save([f.event('a', null, f.team, 1), f.event('b', 'a', null, 2),
      { type: 'message', id: 'fork', parentId: 'a', timestamp: new Date(0).toISOString(), message: { role: 'user', content: 'different branch' } }]);
    expect((await f.sessions.readColdTeams(f.project, f.sessionId))).toMatchObject({ state: 'ok' });
    const fork = await f.sessions.readColdTeams(f.project, f.sessionId);
    expect(fork.state === 'ok' && fork.teams.get(f.team.id)?.id).toBe(f.team.id);
    await f.save([f.event('a', null, f.team, 1), f.event('b', 'a', null, 2)]);
    const deleted = await f.sessions.readColdTeams(f.project, f.sessionId);
    expect(deleted.state === 'ok' && deleted.teams.get(f.team.id)).toBeNull();
    // Team's real coordinator writes equal-sequence snapshots; newest wins.
    await f.save([f.event('a', null, f.team, 2), f.event('b', 'a', null, 2)]);
    const equalDeleted = await f.sessions.readColdTeams(f.project, f.sessionId);
    expect(equalDeleted.state === 'ok' && equalDeleted.teams.get(f.team.id)).toBeNull();
    await f.save([f.event('a', null, null, 2), f.event('b', 'a', f.team, 2)]);
    const equalUpdated = await f.sessions.readColdTeams(f.project, f.sessionId);
    expect(equalUpdated.state === 'ok' && equalUpdated.teams.get(f.team.id)?.id).toBe(f.team.id);
  });
  it('bounds private Pi directory enumeration and refuses uncertain catalog identity', async () => {
    const f = await fixture();
    const directory = path.dirname(f.target);
    await fs.rename(f.target, path.join(directory, '000-session.jsonl'));
    for (let offset = 0; offset < 10_001; offset += 64) {
      await Promise.all(Array.from({ length: Math.min(64, 10_001 - offset) }, (_, index) =>
        fs.writeFile(path.join(directory, `noise-${offset + index}.txt`), '')));
    }
    const real = new PiSessionRepository(undefined, path.join(f.root, 'pi', 'sessions'));
    expect((await real.list(f.project, null)).some((item) => item.id === f.sessionId)).toBe(true);
    expect(await real.readColdTeams(f.project, f.sessionId)).toMatchObject({ state: 'unknown', reason: 'oversized' });
  }, 15_000);
  it('separates incomplete tail from corrupt interior, and bounds oversized transcripts', async () => {
    const f = await fixture(); await f.save([f.event('a', null, f.team, 1)]);
    await fs.appendFile(f.target, '{"type":"custom"');
    expect(await f.sessions.readColdTeams(f.project, f.sessionId)).toMatchObject({ state: 'unknown', reason: 'partial-tail' });
    await f.save([f.event('a', null, f.team, 1)]);
    await fs.appendFile(f.target, '{garbage}\n');
    expect(await f.sessions.readColdTeams(f.project, f.sessionId)).toMatchObject({ state: 'unknown', reason: 'corrupt' });
    await f.save([]); await fs.appendFile(f.target, 'x'.repeat(8 * 1024 * 1024));
    expect(await f.sessions.readColdTeams(f.project, f.sessionId)).toMatchObject({ state: 'unknown', reason: 'oversized' });
  });
  it('stores only references at each save boundary, with no message or credentials', async () => {
    const f = await fixture();
    const ref = { projectPath: f.project, sessionId: f.sessionId, requestId: 'request-1', workspaceId: 'workspace-1', principalId: 'principal-1' };
    for (const status of ['running', 'interrupted', 'unknown'] as const) {
      await f.repository.append(ref, status, true);
      const reopened = new LifecycleRepository(path.join(f.root, 'profile', 'lifecycle'));
      expect((await reopened.read()).records.at(-1)?.status).toBe(status);
    }
    const hostile = Object.assign({}, ref, { prompt: 'private-prompt-sentinel', credential: 'private-token-sentinel' });
    await expect(f.repository.append(hostile, 'running'))
      .rejects.toThrow();
    const bytes = await fs.readFile(path.join(f.root, 'profile', 'lifecycle', 'status-v1.jsonl'), 'utf8');
    expect(bytes).not.toContain('private-prompt-sentinel');
    expect(bytes).not.toContain('private-token-sentinel');
    const quota = new LifecycleRepository(path.join(f.root, 'profile', 'tiny'), 4096, 1);
    await quota.append(ref, 'running');
    await expect(quota.append(ref, 'interrupted')).rejects.toThrow('STORAGE_UNAVAILABLE');
  });
  it('retains complete index facts under partial tail, refuses further append and reports interior corruption', async () => {
    const f = await fixture(); const first = await f.repository.append(f.reference, 'running');
    const file = path.join(f.root, 'profile', 'lifecycle', 'status-v1.jsonl');
    await fs.appendFile(file, '{incomplete');
    expect(await f.repository.read()).toEqual({ records: [first], health: 'partial-tail' });
    await expect(f.repository.append(f.reference, 'completed')).rejects.toThrow('STORAGE_UNAVAILABLE');
    const recovery = await new RecoveryCoordinator(f.repository, f.sources).recover();
    expect(recovery).toMatchObject({ admissionsAllowed: false, storageHealth: 'partial-tail' });
    await fs.writeFile(file, '{bad}\n' + JSON.stringify(first) + '\n');
    expect((await f.repository.read()).health).toBe('corrupt-interior');
  });
  it('does not trust stale completion against Team task state, changed branch, or missing worktree', async () => {
    const f = await fixture();
    const rootNode = f.team.nodes[0]!;
    const team: AgentTeam = { ...f.team, tasks: [{ id: 'task-1', teamId: f.team.id, assigneeNodeId: rootNode.id,
      requesterNodeId: rootNode.id, inputEnvelopeId: 'env-1', summary: 'task', status: 'running', createdAt: 0 }] };
    await f.save([f.event('a', null, team, 1)]);
    await f.repository.append(f.reference, 'completed');
    const coordinator = new RecoveryCoordinator(f.repository, f.sources);
    expect((await coordinator.recover()).records[0]?.status).toBe('unknown');
    await f.save([f.event('a', null, { ...team, tasks: [{ ...team.tasks[0]!, status: 'completed' }] }, 2)]);
    expect((await coordinator.recover()).records[0]?.status).toBe('completed');
    const worktree = { path: path.join(f.root, 'missing'), parentPath: f.project, branch: 'fate/test', baseCommit: 'a'.repeat(40), commonDirectory: path.join(f.root, '.git') };
    await f.repository.append({ ...f.reference, nodeId: rootNode.id, worktree }, 'completed');
    expect((await coordinator.recover()).records.at(-1)?.status).toBe('unknown');
    const changedBranch: AgentTeam = { ...team, nodes: team.nodes.map((node) => node.id === rootNode.id ? {
      ...node, workspace: { mode: 'worktree', state: 'ready', ...worktree, branch: 'other-branch' },
    } : node) };
    await f.save([f.event('a', null, changedBranch, 1)]);
    expect((await coordinator.recover()).records.at(-1)?.status).toBe('unknown');
    await f.save([f.event('a', null, team, 1), f.event('b', 'a', null, 2)]);
    expect((await coordinator.recover()).records[0]?.status).toBe('unknown');
  });
  it('cannot certify Team child completion from unreadable child directory or transcript', async () => {
    const f = await fixture();
    const rootNode = f.team.nodes[0]!;
    const child = { ...rootNode, id: 'child-1', parentNodeId: rootNode.id, path: '/root/child', handle: 'child', depth: 1 };
    const team = { ...f.team, nodes: [{ ...rootNode, childIds: [child.id] }, child] };
    const base = path.join(f.root, 'profile', 'agent-teams');
    const dir = path.join(base, safeDirectoryKey(f.sessionId), safeDirectoryKey(team.id), safeDirectoryKey(child.id));
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.writeFile(dir, 'not a directory');
    expect(await inspectAgentTeamChildStorage(team, [base])).toBe('unknown');
    await fs.rm(dir); await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'child.jsonl'), '{broken}\n');
    expect(await inspectAgentTeamChildStorage(team, [base])).toBe('unknown');
    await fs.rm(path.join(dir, 'child.jsonl'));
    const valid = path.join(dir, '2025-01-01_child-session.jsonl');
    const header = (id: string, cwd = f.project) => JSON.stringify({ type: 'session', id, cwd, version: 3, timestamp: new Date(0).toISOString() }) + '\n';
    await fs.writeFile(valid, header('unrelated'));
    expect(await inspectAgentTeamChildStorage(team, [base])).toBe('unknown');
    await fs.writeFile(valid, header('child-session'));
    expect(await inspectAgentTeamChildStorage(team, [base])).toBe('ok');
    await fs.writeFile(valid, header('child-session') + JSON.stringify({ type: 'message', id: 'orphan', parentId: 'missing' }) + '\n');
    expect(await inspectAgentTeamChildStorage(team, [base])).toBe('unknown');
    await fs.writeFile(valid, header('child-session', path.join(f.root, 'wrong-cwd')));
    expect(await inspectAgentTeamChildStorage(team, [base])).toBe('unknown');
    await fs.writeFile(valid, header('child-session'));
    const selected = path.join(dir, 'z_selected.jsonl');
    await fs.writeFile(selected, '{broken}\n');
    expect(await inspectAgentTeamChildStorage(team, [base])).toBe('unknown');
    await fs.rm(selected); await fs.rm(valid);
    for (let index = 0; index < 257; index += 32) await Promise.all(Array.from({ length: Math.min(32, 257 - index) }, (_, step) =>
      fs.writeFile(path.join(dir, `other-${index + step}.txt`), '')));
    expect(await inspectAgentTeamChildStorage(team, [base])).toBe('unknown');
  });
  it('does not certify saved GoalMax completion without live evidence verification', async () => {
    const f = await fixture(); await f.save([]);
    await f.repository.append({ projectPath: f.project, sessionId: f.sessionId, goalId: 'goal-1' }, 'completed');
    const fakeGoal = goalMaxStateSchema.parse({ schemaVersion: 2, id: 'goal-1', sessionId: f.sessionId, projectPath: f.project,
      revision: 1, objective: 'Fake completed goal', originalBriefRef: null, originalBriefHash: null,
      status: 'completed', phase: 'verification', executionState: 'idle', verificationLevel: 'normal', agentStrategy: 'off',
      criteria: [{ id: 'criterion-1', title: 'Done', description: 'Done', required: false, status: 'waived', evidenceIds: [], ownerNodeIds: [], updatedAt: 1 }],
      budget: { tokenLimit: null, timeLimitMs: null, source: null }, permission: { permissionLevel: 'edit', projectTrusted: true, revision: 1, resolvedAt: 1 },
      progress: { meaningfulTurnCount: 0, noProgressTurnCount: 0, repeatedFailureCount: 0, planningOnlyTurnCount: 0, changedFileCount: 0,
        baselineWorkspaceFingerprint: 'before', latestWorkspaceFingerprint: 'before', latestEvidenceAt: null, latestMeaningfulProgressAt: null, lastFailureFingerprint: null },
      evidence: [], continuation: { pending: false, attempt: 0, lastScheduledAt: null, lastSettledAt: null, reason: null },
      steering: [], childAssignments: [], tokensUsed: 0, tokenBaseline: 0, elapsedMs: 0, timeline: [], createdAt: 1, updatedAt: 1,
      startedAt: 1, completedAt: 1, blockedReason: null, failure: null });
    await fs.writeFile(path.join(f.project, 'changed-after-goal.txt'), 'changed');
    let goal = fakeGoal;
    let facts: CheckoutFacts = { root: f.project, commonDirectory: path.join(f.root, '.git'), head: 'a'.repeat(40), branch: 'main', clean: true };
    const principal = '20000000-0000-4000-8000-000000000001';
    const workspace = '30000000-0000-4000-8000-000000000001';
    const identity = createLocalIpcContext({ principalId: principal, clientId: '40000000-0000-4000-8000-000000000001', expiresAt: Date.now() + 60_000 });
    const control = { command: { workspaceGeneration: 1, expectedSessionId: f.sessionId, selectionRevision: 0, controlGeneration: 2 },
      authorize: () => ({ currentGeneration: 1, controlGeneration: 2, permission: true, principalId: principal }) };
    let authorized = identity;
    const sources: RecoverySources = { ...f.sources, goals: { load: async () => goal }, readCheckoutFacts: async () => facts,
      resolveReview: (caller, id, generation, session, lease) => {
        if (caller !== authorized || caller.principalId !== authorized.principalId || id !== workspace || generation !== 1 || session !== f.sessionId
          || lease && (lease.command.controlGeneration !== lease.authorize().controlGeneration || lease.authorize().principalId !== caller.principalId))
          throw new Error('FORBIDDEN: wrong principal, control, or session.');
        return { projectPath: f.project, principalId: caller.principalId };
      } };
    const legacyHash = createHash('sha256').update(JSON.stringify([f.project, f.sessionId, goal.id, 1, facts])).digest('hex');
    const legacyFile = path.join(f.root, 'profile', 'lifecycle', `review-${legacyHash}.json`);
    await fs.writeFile(legacyFile, JSON.stringify({ version: 1, outcome: 'unknown-reviewed', projectPath: f.project,
      sessionId: f.sessionId, goalId: goal.id, goalRevision: 1, principalId: principal, checkout: facts, at: 1 }) + '\n');
    const coordinator = new RecoveryCoordinator(f.repository, sources);
    expect((await coordinator.recover()).records[0]?.status).toBe('unknown');
    expect(() => coordinator.assertAdmission(f.project, f.sessionId)).toThrow('RECOVERY_REVIEW_REQUIRED');
    expect(() => coordinator.assertAdmission(path.join(f.root, 'unrelated'), 'other')).not.toThrow();
    const other = createLocalIpcContext({ principalId: '50000000-0000-4000-8000-000000000001', clientId: '60000000-0000-4000-8000-000000000001', expiresAt: Date.now() + 60_000 });
    await expect(coordinator.inspectGoalReview(other, workspace, 1, f.sessionId, goal.id)).rejects.toThrow('FORBIDDEN');
    await expect(coordinator.inspectGoalReview(identity, workspace, 1, 'wrong-session', goal.id)).rejects.toThrow('FORBIDDEN');
    const preview = await coordinator.inspectGoalReview(identity, workspace, 1, f.sessionId, goal.id);
    await expect(coordinator.acknowledgeGoalReview(identity, workspace, 1, f.sessionId, goal.id, 1, facts,
      { ...control, command: { ...control.command, controlGeneration: 9 } })).rejects.toThrow('FORBIDDEN');
    expect(preview).toMatchObject({ outcome: 'UNKNOWN', revision: 1, checkout: facts });
    facts = { ...facts, head: 'c'.repeat(40) };
    await expect(coordinator.acknowledgeGoalReview(identity, workspace, 1, f.sessionId, goal.id, 1, preview.checkout, control)).rejects.toThrow('Checkout changed');
    expect(() => coordinator.assertAdmission(f.project, f.sessionId)).toThrow('RECOVERY_REVIEW_REQUIRED');
    facts = preview.checkout;
    await coordinator.acknowledgeGoalReview(identity, workspace, 1, f.sessionId, goal.id, 1, preview.checkout, control);
    expect(() => coordinator.assertAdmission(f.project, f.sessionId, principal)).not.toThrow();
    expect((await fs.stat(legacyFile)).isFile()).toBe(true); // Historical v1 stays intact but never authorizes.
    expect(() => coordinator.assertAdmission(f.project, f.sessionId, other.principalId)).toThrow('another principal');
    const restarted = new RecoveryCoordinator(f.repository, sources);
    expect((await restarted.recover()).records[0]?.status).toBe('unknown');
    expect(() => restarted.assertAdmission(f.project, f.sessionId, principal)).not.toThrow();
    expect(() => restarted.assertAdmission(f.project, f.sessionId, other.principalId)).toThrow('another principal');
    authorized = other;
    const otherControl = { ...control, authorize: () => ({ ...control.authorize(), principalId: other.principalId }) };
    const originalSave = f.repository.saveGoalReview.bind(f.repository);
    const staged = vi.spyOn(f.repository, 'saveGoalReview').mockImplementation(async (input) => {
      const saved = await originalSave(input);
      if (input.stage === 'prepared') facts = { ...facts, head: 'd'.repeat(40) };
      return saved;
    });
    await expect(restarted.acknowledgeGoalReview(other, workspace, 1, f.sessionId, goal.id, 1, preview.checkout, otherControl))
      .rejects.toThrow('prepared review is not authoritative');
    staged.mockRestore(); facts = preview.checkout;
    expect(await f.repository.readGoalReview(f.project, f.sessionId, goal.id, 1, facts))
      .toMatchObject({ stage: 'prepared', principalId: other.principalId });
    expect(() => restarted.assertAdmission(f.project, f.sessionId, principal)).toThrow('RECOVERY_REVIEW_REQUIRED');
    expect(() => restarted.assertAdmission(f.project, f.sessionId, other.principalId)).toThrow('RECOVERY_REVIEW_REQUIRED');
    expect((await restarted.recover()).records[0]?.status).toBe('unknown');
    const reopened = new RecoveryCoordinator(f.repository, sources);
    expect((await reopened.recover()).records[0]?.status).toBe('unknown');
    expect(() => reopened.assertAdmission(f.project, f.sessionId, principal)).toThrow('RECOVERY_REVIEW_REQUIRED');
    expect(() => reopened.assertAdmission(f.project, f.sessionId, other.principalId)).toThrow('RECOVERY_REVIEW_REQUIRED');
    const fresh = await reopened.inspectGoalReview(other, workspace, 1, f.sessionId, goal.id);
    await reopened.acknowledgeGoalReview(other, workspace, 1, f.sessionId, goal.id, fresh.revision, fresh.checkout, otherControl);
    expect(() => reopened.assertAdmission(f.project, f.sessionId, other.principalId)).not.toThrow();
    expect(() => reopened.assertAdmission(f.project, f.sessionId, principal)).toThrow('another principal');
    authorized = identity;
    const uncertainSave = vi.spyOn(f.repository, 'saveGoalReview').mockImplementation(async (input) => {
      const saved = await originalSave(input);
      if (input.stage === 'prepared') throw new Error('Injected failure after prepared publication.');
      return saved;
    });
    await expect(reopened.acknowledgeGoalReview(identity, workspace, 1, f.sessionId, goal.id, 1, preview.checkout, control))
      .rejects.toThrow('Injected failure after prepared publication.');
    uncertainSave.mockRestore();
    expect(() => reopened.assertAdmission(f.project, f.sessionId, principal)).toThrow('RECOVERY_REVIEW_REQUIRED');
    expect(() => reopened.assertAdmission(f.project, f.sessionId, other.principalId)).toThrow('RECOVERY_REVIEW_REQUIRED');
    const afterUncertainSave = new RecoveryCoordinator(f.repository, sources);
    expect((await afterUncertainSave.recover()).records[0]?.status).toBe('unknown');
    expect(() => afterUncertainSave.assertAdmission(f.project, f.sessionId, principal)).toThrow('RECOVERY_REVIEW_REQUIRED');
    expect(() => afterUncertainSave.assertAdmission(f.project, f.sessionId, other.principalId)).toThrow('RECOVERY_REVIEW_REQUIRED');
    facts = { ...facts, branch: 'changed-branch' };
    const drifted = new RecoveryCoordinator(f.repository, sources);
    await drifted.recover();
    expect(() => drifted.assertAdmission(f.project, f.sessionId)).toThrow('RECOVERY_REVIEW_REQUIRED');
    facts = preview.checkout;
    goal = { ...goal, revision: 2 };
    const revised = new RecoveryCoordinator(f.repository, sources);
    await revised.recover();
    expect(() => revised.assertAdmission(f.project, f.sessionId)).toThrow('RECOVERY_REVIEW_REQUIRED');
    const reviewHash = createHash('sha256').update(JSON.stringify([f.project, f.sessionId, goal.id, 2, facts])).digest('hex');
    const blockedFile = path.join(f.root, 'profile', 'lifecycle', `review-v2-${reviewHash}.json`);
    await fs.mkdir(blockedFile);
    await expect(revised.acknowledgeGoalReview(identity, workspace, 1, f.sessionId, goal.id, 2, facts, control)).rejects.toThrow('STORAGE_UNAVAILABLE');
    expect(() => revised.assertAdmission(f.project, f.sessionId)).toThrow('RECOVERY_REVIEW_REQUIRED');
    await fs.rm(blockedFile, { recursive: true, force: true });
    await f.repository.append({ projectPath: f.project, sessionId: f.sessionId, requestId: 'uncertain-command', workspaceId: workspace, principalId: principal }, 'unknown');
    await revised.recover();
    await expect(revised.acknowledgeGoalReview(identity, workspace, 1, f.sessionId, goal.id, 2, facts, control)).rejects.toThrow('another uncertain execution');
    expect(() => revised.assertAdmission(f.project, f.sessionId)).toThrow('RECOVERY_REVIEW_REQUIRED');
  });
  it('requires a fresh local-adapter principal to explicitly re-review UNKNOWN after owner restart', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-review-restart-')); roots.push(root);
    const project = path.join(root, 'project'); await fs.mkdir(project);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: project, stdio: 'pipe' });
    git('init'); git('config', 'user.email', 'fake@example.invalid'); git('config', 'user.name', 'Fake');
    await fs.writeFile(path.join(project, 'file.txt'), 'clean\n'); git('add', '--', 'file.txt'); git('commit', '-m', 'Private goal');
    const goals = new InMemoryGoalMaxRepository();
    const first = await registeredCore(root, project, goals);
    let firstPrincipal = '';
    let sessionId = '';
    const goalId = 'completed-goal';
    try {
      sessionId = first.handle.runtime.getState(false).sessionId!;
      // The fake SDK keeps its session in memory. Supply only a private cold
      // transcript header so the real recovery reader can resolve the owner.
      const directory = path.join(root, 'pi', 'sessions', `--${path.resolve(project).replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, `2025-01-01_${sessionId}.jsonl`), JSON.stringify({
        type: 'session', id: sessionId, version: 3, cwd: project, timestamp: new Date(0).toISOString(),
      }) + '\n');
      const goal = goalMaxStateSchema.parse({ schemaVersion: 2, id: goalId, sessionId, projectPath: project,
        revision: 1, objective: 'Private completed outcome', originalBriefRef: null, originalBriefHash: null,
        status: 'completed', phase: 'verification', executionState: 'idle', verificationLevel: 'normal', agentStrategy: 'off',
        criteria: [{ id: 'criterion-1', title: 'Done', description: 'Done', required: false, status: 'waived', evidenceIds: [], ownerNodeIds: [], updatedAt: 1 }],
        budget: { tokenLimit: null, timeLimitMs: null, source: null }, permission: { permissionLevel: 'edit', projectTrusted: true, revision: 1, resolvedAt: 1 },
        progress: { meaningfulTurnCount: 0, noProgressTurnCount: 0, repeatedFailureCount: 0, planningOnlyTurnCount: 0, changedFileCount: 0,
          baselineWorkspaceFingerprint: 'before', latestWorkspaceFingerprint: 'before', latestEvidenceAt: null, latestMeaningfulProgressAt: null, lastFailureFingerprint: null },
        evidence: [], continuation: { pending: false, attempt: 0, lastScheduledAt: null, lastSettledAt: null, reason: null },
        steering: [], childAssignments: [], tokensUsed: 0, tokenBaseline: 0, elapsedMs: 0, timeline: [], createdAt: 1, updatedAt: 1,
        startedAt: 1, completedAt: 1, blockedReason: null, failure: null });
      await goals.save(goal, null);
      await first.core.recovery.flush();
      await first.core.recovery.repository.append({ projectPath: project, sessionId, goalId }, 'completed');
      expect((await first.core.recovery.recover()).records.at(-1)?.status).toBe('unknown');
      firstPrincipal = await first.ipc.scoped(async ({ identity, handle, command, authorize }) => {
        const preview = await first.core.recovery.inspectGoalReview(identity, handle.id, handle.generation, sessionId, goalId);
        expect(preview.outcome).toBe('UNKNOWN');
        await first.core.recovery.acknowledgeGoalReview(identity, handle.id, handle.generation, sessionId, goalId,
          preview.revision, preview.checkout, { command, authorize });
        return identity.principalId;
      });
      expect(() => first.core.recovery.assertAdmission(project, sessionId, firstPrincipal)).not.toThrow();
    } finally { await first.dispose(); }
    const second = await registeredCore(root, project, goals);
    try {
      expect(second.handle.runtime.getState(false).sessionId).toBe(sessionId);
      expect(second.core.recovered.records.at(-1)?.status).toBe('unknown');
      await second.ipc.scoped(async ({ identity, handle, command, authorize }) => {
        expect(identity.principalId).not.toBe(firstPrincipal);
        expect(() => second.core.recovery.assertAdmission(project, sessionId, identity.principalId)).toThrow('RECOVERY_REVIEW_REQUIRED');
        const preview = await second.core.recovery.inspectGoalReview(identity, handle.id, handle.generation, sessionId, goalId);
        await expect(second.core.recovery.acknowledgeGoalReview(identity, handle.id, handle.generation, sessionId, goalId,
          preview.revision, { ...preview.checkout, branch: 'unseen-branch' }, { command, authorize })).rejects.toThrow('Checkout changed');
        expect(() => second.core.recovery.assertAdmission(project, sessionId, identity.principalId)).toThrow('RECOVERY_REVIEW_REQUIRED');
        await second.core.recovery.acknowledgeGoalReview(identity, handle.id, handle.generation, sessionId, goalId,
          preview.revision, preview.checkout, { command, authorize });
        expect(() => second.core.recovery.assertAdmission(project, sessionId, identity.principalId)).not.toThrow();
        expect(() => second.core.recovery.assertAdmission(project, sessionId, firstPrincipal)).toThrow('RECOVERY_REVIEW_REQUIRED');
        expect((await second.core.recovery.recover()).records.at(-1)?.status).toBe('unknown');
        expect(() => second.core.recovery.assertAdmission(project, sessionId, identity.principalId)).not.toThrow();
        expect(() => second.core.recovery.assertAdmission(project, sessionId, firstPrincipal)).toThrow('RECOVERY_REVIEW_REQUIRED');
      });
      expect(second.adapter.invocations.filter((item) => item.kind === 'prompt')).toHaveLength(0);
      expect((await second.core.recovery.repository.read()).records.filter((item) => item.reference.goalId === goalId)).toHaveLength(1);
    } finally { await second.dispose(); }
  });
  it('fences registered queue while checkpoint is pending or failed, but allows abort', async () => {
    const f = await fixture(); const coordinator = new RecoveryCoordinator(f.repository, f.sources);
    const runtime = { getState: () => ({ sessionId: f.sessionId }) };
    const admission = new WorkspaceAdmissionQueue(runtime, 1, (sessionId) => coordinator.assertAdmission(f.project, sessionId));
    const command = { workspaceGeneration: 1, expectedSessionId: f.sessionId, selectionRevision: 0, controlGeneration: 1 };
    const authorize = () => ({ currentGeneration: 1, controlGeneration: 1, permission: true });
    const effect = vi.fn(async () => 'effect');
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const first = admission.run(command, authorize, async () => { entered(); await held; return 'first'; });
    await started;
    const waiting = admission.run(command, authorize, effect);
    const target = path.join(f.root, 'profile', 'lifecycle', 'status-v1.jsonl');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, '{broken}\n');
    const recording = coordinator.record({ projectPath: f.project, sessionId: f.sessionId }, 'running');
    await expect(admission.run(command, authorize, effect)).rejects.toThrow('STORAGE_UNAVAILABLE');
    release(); await first;
    await expect(waiting).rejects.toThrow('STORAGE_UNAVAILABLE');
    await recording;
    await expect(admission.run(command, authorize, effect)).rejects.toThrow('STORAGE_UNAVAILABLE');
    expect(await admission.run(command, authorize, effect, false, true)).toBe('effect');
    expect(effect).toHaveBeenCalledOnce();
  });
  it('keeps the real registered desktop abort and monitor path open across pending and failed checkpoints', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-ipc-recovery-')); roots.push(root);
    const project = path.join(root, 'project'); await fs.mkdir(project);
    const owner = await registeredCore(root, project);
    let release: () => void = () => undefined;
    try {
      const sessionId = owner.handle.runtime.getState(false).sessionId!;
      const abort = vi.spyOn(owner.handle.runtime, 'abort');
      const repository = owner.core.recovery.repository;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const storage = vi.spyOn(repository, 'append').mockImplementationOnce(async () => { await gate; return undefined as never; });
      const pending = owner.core.recovery.record({ projectPath: project, sessionId }, 'running');
      expect(owner.core.recovery.admissionsAllowed).toBe(false);
      expect((await owner.ipc.monitor({ section: 'runs', limit: 1 })).sessionId).toBe(sessionId);
      await owner.ipc.abort({});
      await expect(owner.ipc.prompt({ text: 'No new work during a checkpoint.' })).rejects.toThrow('STORAGE_UNAVAILABLE');
      release(); await pending;
      storage.mockImplementationOnce(async () => { throw new Error('Private storage fault.'); });
      await owner.core.recovery.record({ projectPath: project, sessionId }, 'failed');
      expect(() => owner.core.recovery.assertAdmission()).toThrow('STORAGE_UNAVAILABLE');
      expect((await owner.ipc.monitor({ section: 'runs', limit: 1 })).sessionId).toBe(sessionId);
      await owner.ipc.abort({});
      await expect(owner.ipc.prompt({ text: 'No new work after a fault.' })).rejects.toThrow('STORAGE_UNAVAILABLE');
      expect(abort).toHaveBeenCalledTimes(2);
      expect(owner.adapter.invocations.filter((item) => item.kind === 'prompt')).toHaveLength(0);
      storage.mockRestore();
    } finally { release(); vi.spyOn(owner.core.recovery, 'flush').mockResolvedValue(); await owner.dispose(); }
  });
  it('reads each authoritative session once per recovery pass even with many lifecycle references', async () => {
    const f = await fixture(); await f.save([f.event('a', null, f.team, 1)]);
    for (let index = 0; index < 30; index++) await f.repository.append({ projectPath: f.project, sessionId: f.sessionId, teamId: f.team.id, nodeId: `node-${index}` }, 'running');
    const readSession = vi.fn(f.sources.readSession);
    const readTeams = vi.fn(f.sources.readTeams);
    const readTasks = vi.fn(f.sources.readTasks);
    const loadGoal = vi.fn((project: string, session: string) => f.sources.goals.load(project, session));
    const loadQueue = vi.fn((project: string, session: string) => f.sources.queue.load(project, session));
    const sources: RecoverySources = { ...f.sources, readSession, readTeams, readTasks,
      goals: { load: loadGoal }, queue: { load: loadQueue } };
    await new RecoveryCoordinator(f.repository, sources).recover();
    expect(readSession).toHaveBeenCalledOnce(); expect(readTeams).toHaveBeenCalledOnce();
    expect(readTasks).toHaveBeenCalledOnce(); expect(loadGoal).toHaveBeenCalledOnce(); expect(loadQueue).toHaveBeenCalledOnce();
  });
  it('saves only semantic status edges, and a failed checkpoint blocks admissions', async () => {
    const f = await fixture(); const coordinator = new RecoveryCoordinator(f.repository, f.sources);
    const origin = { workspaceId: 'workspace-1', workspaceGeneration: 1, sessionId: f.sessionId };
    coordinator.observe({ kind: 'pi', origin, event: { type: 'run.started', runId: 'run-1', timestamp: 1 } }, f.project);
    coordinator.observe({ kind: 'pi', origin, event: { type: 'run.started', runId: 'run-1', timestamp: 2 } }, f.project);
    await coordinator.flush();
    expect((await f.repository.read()).records).toHaveLength(1);
    const bad = new RecoveryCoordinator(new LifecycleRepository(path.join(f.root, 'not-a-directory')), f.sources);
    await fs.writeFile(path.join(f.root, 'not-a-directory'), 'blocked');
    bad.observe({ kind: 'pi', origin, event: { type: 'run.started', runId: 'run-1', timestamp: 1 } }, f.project);
    await expect(bad.flush()).rejects.toThrow('STORAGE_UNAVAILABLE');
    expect(() => bad.assertAdmission()).toThrow('STORAGE_UNAVAILABLE');
  });
  it('keeps interrupted and drafts visible without replay; distinguishes missing from invalid task and failed storage', async () => {
    const f = await fixture(); await f.save([]);
    await f.repository.append({ projectPath: f.project, sessionId: f.sessionId }, 'running');
    const execute = vi.fn(); const sources = { ...f.sources, validateWorktree: async () => { execute(); } };
    let recovered = await new RecoveryCoordinator(f.repository, sources).recover();
    expect(recovered.records[0]?.status).toBe('interrupted'); expect(execute).not.toHaveBeenCalled();
    await f.repository.append({ projectPath: f.project, sessionId: f.sessionId }, 'draft');
    recovered = await new RecoveryCoordinator(f.repository, sources).recover();
    expect(recovered.records[0]?.status).toBe('review');
    expect(await f.taskRepo.loadHealth(f.project, f.sessionId)).toEqual({ state: 'absent' });
    // A corrupt authoritative task is not absence. Desktop load still returns null.
    const bad = path.join(f.root, 'profile', 'tasks');
    const { createHash } = await import('node:crypto');
    const key = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
    const canonicalProject = process.platform === 'win32' ? path.resolve(f.project).toLowerCase() : path.resolve(f.project);
    const target = path.join(bad, key(canonicalProject), key(f.sessionId), 'current.json');
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, '{bad');
    expect(await f.taskRepo.loadHealth(f.project, f.sessionId)).toEqual({ state: 'invalid' });
    expect(await f.taskRepo.load(f.project, f.sessionId)).toBeNull();
    expect((await new RecoveryCoordinator(f.repository, sources).recover()).records[0]?.status).toBe('review');
    await f.queue.save(f.project, f.sessionId, [{ id: '00000000-0000-4000-8000-000000000001', behavior: 'followUp', text: 'private-draft-sentinel', createdAt: 1 }]);
    expect((await new RecoveryCoordinator(f.repository, sources).recover()).records[0]?.status).toBe('review');
    expect((await fs.readFile(path.join(f.root, 'profile', 'lifecycle', 'status-v1.jsonl'), 'utf8'))).not.toContain('private-draft-sentinel');
    const failed = new LifecycleRepository(path.join(f.root, 'profile', 'bad'));
    await fs.writeFile(path.join(f.root, 'profile', 'bad'), 'not a directory');
    await expect(failed.append({ projectPath: f.project, sessionId: f.sessionId }, 'running')).rejects.toThrow('STORAGE_UNAVAILABLE');
    expect((await new RecoveryCoordinator(failed, sources).recover()).admissionsAllowed).toBe(false);
  });
});
