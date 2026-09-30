import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceEventHub } from '../../src/core/events/WorkspaceEventHub';
import { ScopedDomainEvents } from '../../src/core/events/ScopedDomainEvents';
import { WorkspaceAdmissionQueue } from '../../src/core/workspaces/WorkspaceAdmissionQueue';
import { CommandJournal } from '../../src/core/commands/CommandJournal';
import { createMutationIdentity } from '../../src/shared/protocol/requestIds';
import { createAuthenticatedServerContext } from '../../src/core/dispatch/RequestContext';
import type { FateCore } from '../../src/core/FateCore';
import type { WorkspaceHandle } from '../../src/core/workspaces/WorkspaceHandle';
import type { ClientTickets } from '../../src/server/auth/ClientTickets';
import { createNetworkDispatcher } from '../../src/server/http/NetworkDispatcher';
import { requestEnvelopeSchema, responseEnvelopeSchema } from '../../src/shared/protocol/envelopes';
import { operationMethodSchema } from '../../src/shared/protocol/hostOperations';

const epoch = '10000000-0000-4000-8000-000000000001';
const workspaceId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000003';
const principalId = '40000000-0000-4000-8000-000000000004';
const clientId = '50000000-0000-4000-8000-000000000005';
const requestId = '60000000-0000-4000-8000-000000000006';
const now = 1_800_000_000_000;
const root = path.resolve('host-catalog-private');
const identity = createAuthenticatedServerContext({ principalId, clientId, expiresAt: now + 60_000 }, null);
const request = (method: string, extra: object = {}) => ({ protocol: 1, requestId, serverEpoch: epoch, issuedAt: now,
  workspaceId, workspaceGeneration: 3, expectedSessionId: sessionId, selectionRevision: 9, method, input: {}, ...extra });

function fixture() {
  let member = true;
  let selected = sessionId;
  let revision = 9;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  let hold = false;
  const goal = vi.fn(async () => {
    if (hold) await gate;
    return { schemaVersion: 2, sessionId, projectPath: root, id: 'goal-1', revision: 1, objective: 'Ship',
      originalBriefRef: '/private/brief', originalBriefHash: 'a'.repeat(64), status: 'active', phase: 'planning', executionState: 'idle',
      verificationLevel: 'normal', agentStrategy: 'off', criteria: [{ id: 'criterion-1', title: 'Check', description: 'Proof',
        required: true, status: 'pending', evidenceIds: [], ownerNodeIds: [], updatedAt: now }],
      budget: { tokenLimit: null, timeLimitMs: null, source: null },
      permission: { permissionLevel: 'read-only', projectTrusted: true, revision: 1, resolvedAt: now },
      progress: { meaningfulTurnCount: 0, noProgressTurnCount: 0, repeatedFailureCount: 0, planningOnlyTurnCount: 0,
        changedFileCount: 0, baselineWorkspaceFingerprint: '', latestWorkspaceFingerprint: '', latestEvidenceAt: null,
        latestMeaningfulProgressAt: null, lastFailureFingerprint: null },
      evidence: [], continuation: { pending: false, attempt: 0, lastScheduledAt: null, lastSettledAt: null, reason: null },
      steering: [{ id: 'steer-1', text: '😀'.repeat(800), behavior: 'steer', timestamp: now, revision: 1 }],
      childAssignments: [], tokensUsed: 0, tokenBaseline: 0, elapsedMs: 0, timeline: [],
      createdAt: now, updatedAt: now, startedAt: now, completedAt: null, blockedReason: null, failure: null }; 
  });
  const tasks = vi.fn(async () => ({ sessionId, projectPath: root, schemaVersion: 1, revision: 2, goalId: null,
    tasks: [{ id: 'task-1', title: 'Real task', detail: 'Do it', status: 'todo', required: true, source: 'user',
      goalId: null, goalCriterionId: null, order: 0, verified: false, verifiedAt: null, createdAt: now, updatedAt: now }],
    currentTaskId: 'task-1', updatedAt: now }));
  const state = () => ({ sessionId: selected, project: { path: root, trusted: true }, permissionLevel: 'read-only',
    models: [{ provider: 'fake', id: 'model', name: 'Fake model', reasoning: false, contextWindow: 1000 }],
    queue: { items: [{ id: requestId, text: 'Explicit scoped queue text', behavior: 'followUp', createdAt: now,
      images: [{ data: 'PRIVATE_MEDIA', mimeType: 'image/png', name: 'private.png' }] }] },
    agentTeams: [], subagents: [], providerLogin: { message: 'PRIVATE_PROVIDER_ERROR' } });
  const runtime = { getState: state, getGoalMax: goal, getTaskList: tasks };
  const status = vi.fn(async () => ({ repository: true, branch: 'main', upstream: 'private-upstream', pushTarget: 'private-remote',
    ahead: 0, behind: 0, changes: [], additions: 0, deletions: 0, truncated: false }));
  const history = vi.fn(async () => ({ head: null, commits: [], truncated: false }));
  const diff = vi.fn(async (file: string) => ({ path: file, state: 'image', imageData: 'PRIVATE_MEDIA', mimeType: 'image/png', language: 'plaintext', openable: true }));
  const handle = { id: workspaceId, generation: 3, root, runtime, git: { status, history, diff },
    files: { getRoot: () => root, assertBoundRootIdentity: async () => undefined, confinePath: async (file: string) => file },
    admission: { snapshot: () => ({ selectedSessionId: selected, selectionRevision: revision }) } } as unknown as WorkspaceHandle;
  const core = { events: new WorkspaceEventHub(new ScopedDomainEvents(), epoch),
    workspaces: { resolve: () => { if (!member) throw new Error('No member'); return handle; } },
    runtime: { workspaceOrigin: (candidate: string) => candidate === root ? { workspaceId, workspaceGeneration: 3 } : null,
      peekWorkspace: () => runtime }, sessionPermissions: { assertHealthy: () => undefined } } as unknown as FateCore;
  const tickets = { isLive: () => true, isMember: () => member } as unknown as ClientTickets;
  const service = createNetworkDispatcher({ core, tickets, journal: {} as CommandJournal, serverEpoch: epoch,
    registeredRoots: [root], hostId: principalId, appVersion: '1.0.0', now: () => now });
  return { dispatch: (value: object) => service.dispatcher.dispatchJson(JSON.stringify(value), identity),
    goal, tasks, status, history, revoke: () => { member = false; },
    switchSelection: () => { revision++; }, hold: () => { hold = true; }, release: () => finish(),
    foreign: () => { selected = '70000000-0000-4000-8000-000000000007'; } };
}

const temporaryRoots: string[] = [];
afterEach(async () => { for (const directory of temporaryRoots.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 3 }); });
async function mutationFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'fate-host-mutation-'));
  temporaryRoots.push(directory);
  let allowed = true;
  const model = { provider: 'fake', id: 'model', name: 'Fake', reasoning: false, contextWindow: 1000 };
  const state = () => ({ status: 'ready' as const, project: { path: directory, name: 'Fake project', trusted: true },
    sessionId, sessionFile: null, model, models: [model], thinkingLevel: 'medium' as const, permissionLevel: 'edit' as const,
    streaming: false, messages: [], error: null, eventCursor: 2, agentTeams: [] });
  const setModel = vi.fn(async () => state());
  const runtime = { getState: state, setModel };
  const admission = new WorkspaceAdmissionQueue(runtime, 3);
  const handle = { id: workspaceId, generation: 3, root: directory, runtime, admission,
    files: { getRoot: () => directory } } as unknown as WorkspaceHandle;
  const core = { events: new WorkspaceEventHub(new ScopedDomainEvents(), epoch),
    workspaces: { resolve: () => handle }, runtime: { workspaceOrigin: () => ({ workspaceId, workspaceGeneration: 3 }),
    peekWorkspace: () => runtime }, sessionPermissions: { assertHealthy: () => undefined } } as unknown as FateCore;
  const tickets = { isLive: () => allowed, isMember: () => allowed } as unknown as ClientTickets;
  const journal = new CommandJournal({ root: path.join(directory, 'journal'), serverEpoch: epoch, now: () => now });
  const service = createNetworkDispatcher({ core, tickets, journal, registeredRoots: [directory], serverEpoch: epoch,
    hostId: principalId, appVersion: '1.0.0', now: () => now });
  const dispatch = (value: object) => service.dispatcher.dispatchJson(JSON.stringify(value), identity);
  const claim = await dispatch({ protocol: 1, requestId, serverEpoch: epoch, issuedAt: now, workspaceId, workspaceGeneration: 3, method: 'control.claim', input: {} });
  if (!claim.ok || claim.method !== 'control.claim') throw new Error('Expected a scoped control claim');
  const mutation = { protocol: 1, ...createMutationIdentity(epoch, now), workspaceId, workspaceGeneration: 3,
    expectedSessionId: sessionId, selectionRevision: 0, controlGeneration: claim.result.generation, method: 'runtime.setModel', input: { provider: 'fake', id: 'model' } };
  return { dispatch, mutation, setModel, admission, revoke: () => { allowed = false; } };
}

describe('T39 host catalog reads', () => {
  it('journals model configuration with a truthful operation receipt, original-ID duplicate suppression and status', async () => {
    const f = await mutationFixture();
    const receipt = await f.dispatch(f.mutation);
    expect(receipt).toMatchObject({ ok: true, method: 'runtime.setModel', result: { kind: 'operation', operation: 'runtime.setModel',
      durability: 'journaled', outcome: 'applied', requestId: f.mutation.requestId, sessionId } });
    expect(responseEnvelopeSchema.safeParse(receipt).success).toBe(true);
    expect(await f.dispatch(f.mutation)).toEqual(receipt);
    expect(f.setModel).toHaveBeenCalledOnce();
    expect(await f.dispatch({ protocol: 1, requestId, serverEpoch: epoch, issuedAt: now, workspaceId, workspaceGeneration: 3,
      method: 'command.status', input: { requestId: f.mutation.requestId } })).toMatchObject({ ok: true, result: { state: 'settled', receipt: { operation: 'runtime.setModel' } } });
    f.revoke();
    expect(await f.dispatch(f.mutation)).toMatchObject({ ok: false });
    expect(f.setModel).toHaveBeenCalledOnce();
  });
  it('requires current control/selection for configuration and preserves an unknown original outcome without replay', async () => {
    const f = await mutationFixture();
    expect(await f.dispatch({ ...f.mutation, controlGeneration: 999 })).toMatchObject({ ok: false, error: { code: 'CONTROL_REQUIRED' } });
    expect(f.setModel).not.toHaveBeenCalled();
    const g = await mutationFixture();
    g.setModel.mockRejectedValueOnce(new Error('FAKE_PRIVATE_PROVIDER_ERROR'));
    const unknown = await g.dispatch(g.mutation);
    expect(unknown).toMatchObject({ ok: false, execution: 'unknown', error: { code: 'OUTCOME_UNKNOWN' } });
    expect(JSON.stringify(unknown)).not.toContain('FAKE_PRIVATE_PROVIDER_ERROR');
    expect(await g.dispatch(g.mutation)).toMatchObject({ ok: false, execution: 'unknown' });
    expect(g.setModel).toHaveBeenCalledOnce();
    expect(await g.dispatch({ protocol: 1, requestId, serverEpoch: epoch, issuedAt: now, workspaceId, workspaceGeneration: 3,
      method: 'command.status', input: { requestId: g.mutation.requestId } })).toMatchObject({ ok: true, result: { state: 'outcome_unknown' } });
  });

  it('admits only exact session-bound named envelopes and never path inputs', () => {
    for (const method of ['goal.get', 'task.list', 'git.status', 'git.history']) {
      expect(requestEnvelopeSchema.safeParse(request(method)).success).toBe(true);
      expect(requestEnvelopeSchema.safeParse(request(method, { path: root })).success).toBe(false);
      expect(requestEnvelopeSchema.safeParse(request(method, { input: { root } })).success).toBe(false);
      expect(requestEnvelopeSchema.safeParse(request(method, { selectionRevision: undefined })).success).toBe(false);
    }
    expect(requestEnvelopeSchema.safeParse(request('git.diff')).success).toBe(false);
    expect(requestEnvelopeSchema.safeParse(request('task.update')).success).toBe(false);
  });

  it('covers the required named matrix with exact schemas, rejecting generic invoke, host authority, unsafe native Git and unchecked integration', () => {
    const samples = [
      ['session.list', {}], ['runtime.models', {}], ['runtime.queueRead', {}], ['team.read', {}], ['agent.read', {}],
      ['git.diff', { path: 'src/file.ts' }], ['git.combinedDiff', {}], ['git.commitDetails', { hash: 'a'.repeat(40) }],
      ['session.create', {}], ['runtime.setModel', { provider: 'fake', id: 'model' }], ['runtime.setThinking', { level: 'medium' }],
      ['runtime.queue', { id: requestId, action: 'cancel' }], ['goal.create', { objective: 'Scoped objective' }],
      ['goal.control', { action: 'verify' }], ['goal.update', { expectedRevision: 1, objective: 'Changed' }], ['goal.clear', {}],
      ['goal.editSteering', { steeringId: 'steer-1', text: 'Revise' }], ['goal.removeSteering', { steeringId: 'steer-1' }],
      ['task.create', { title: 'New task' }], ['task.update', { id: 'task-1', status: 'done' }],
      ['task.reorder', { orderedIds: ['task-1'] }], ['task.delete', { id: 'task-1' }], ['task.clear', {}],
      ['agent.control', { action: 'cancel', target: 'child' }], ['team.control', { action: 'createTeam' }],
      ['agent.workspace', { teamId: 'team-1', target: 'node-1', operation: 'integrate', strategy: 'ff-only', expectedSourceHead: 'a'.repeat(40), expectedTargetHead: 'b'.repeat(40) }],
    ] as const;
    for (const [method, input] of samples) {
      const extra = operationMethodSchema.safeParse(method).success
        ? { input, requestId: `${epoch}.${now}.${requestId}`, controlGeneration: 1 } : { input };
      const value = request(method, extra);
      expect(requestEnvelopeSchema.safeParse(value).success, method).toBe(true);
      expect(requestEnvelopeSchema.safeParse({ ...value, ownerId: principalId }).success, method).toBe(false);
      expect(requestEnvelopeSchema.safeParse({ ...value, projectPath: root }).success, method).toBe(false);
      expect(requestEnvelopeSchema.safeParse({ ...value, input: { ...input, capability: 'full-access' } }).success, method).toBe(false);
    }
    for (const method of ['invoke', 'runtime.invoke', 'git.revert', 'git.commit', 'git.push', 'git.worktreeCleanup']) {
      expect(requestEnvelopeSchema.safeParse(request(method)).success).toBe(false);
    }
    expect(requestEnvelopeSchema.safeParse(request('agent.workspace', { requestId: `${epoch}.${now}.${requestId}`, controlGeneration: 1,
      input: { teamId: 'team-1', target: 'node-1', operation: 'integrate' } })).success).toBe(false);
    expect(requestEnvelopeSchema.safeParse(request('team.control', { requestId: `${epoch}.${now}.${requestId}`, controlGeneration: 1,
      input: { action: 'createTeam', operationId: 'caller-effect-key' } })).success).toBe(false);
  });

  it('reads model/queue/agent projections and text-only diff without provider errors, media or fabricated RuntimeState', async () => {
    const f = fixture();
    for (const method of ['runtime.models', 'runtime.queueRead', 'team.read', 'agent.read']) {
      const response = await f.dispatch(request(method));
      expect(response).toMatchObject({ ok: true, method });
      expect(responseEnvelopeSchema.safeParse(response).success).toBe(true);
      expect(JSON.stringify(response)).not.toContain('PRIVATE_PROVIDER_ERROR');
      expect(JSON.stringify(response)).not.toContain('PRIVATE_MEDIA');
      expect(JSON.stringify(response)).not.toContain(root);
    }
    expect(await f.dispatch(request('runtime.queueRead'))).toMatchObject({ ok: true, result: { items: [{ mediaOmitted: true, text: 'Explicit scoped queue text' }] } });
    expect(await f.dispatch(request('git.diff', { input: { path: 'image.png' } }))).toMatchObject({ ok: true,
      result: { path: 'image.png', state: 'binary', mediaOmitted: true } });
  });

  it('projects clipped steering as a UTF-8 bounded string with an explicit omission flag', async () => {
    const f = fixture();
    const response = await f.dispatch(request('goal.get'));
    expect(response).toMatchObject({ ok: true, method: 'goal.get', result: { goal: {
      steering: [{ text: '😀'.repeat(512), textClipped: true }], steeringTruncated: true,
    } } });
    expect(responseEnvelopeSchema.safeParse(response).success).toBe(true);
  });
  it('reads real scoped GoalMax/tasks/Git through host handles, without host paths or private Git remote fields', async () => {
    const f = fixture();
    for (const method of ['goal.get', 'task.list', 'git.status', 'git.history']) {
      const result = await f.dispatch(request(method));
      expect(result).toMatchObject({ ok: true, method });
      expect(responseEnvelopeSchema.safeParse(result).success).toBe(true);
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain('private-');
    }
    expect(f.goal).toHaveBeenCalledOnce();
    expect(f.tasks).toHaveBeenCalledOnce();
    expect(f.status).toHaveBeenCalledOnce();
    expect(f.history).toHaveBeenCalledOnce();
    expect(await f.dispatch(request('task.list'))).toMatchObject({ ok: true, result: { list: { tasks: [{ verified: false }] } } });
  });

  it('rejects stale selection and revoked membership before handler; drops a pending result on revocation', async () => {
    const f = fixture();
    f.switchSelection();
    expect(await f.dispatch(request('goal.get'))).toMatchObject({ ok: false, error: { code: 'STALE_SESSION' } });
    expect(f.goal).not.toHaveBeenCalled();
    const g = fixture();
    g.revoke();
    expect(await g.dispatch(request('git.status'))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(g.status).not.toHaveBeenCalled();
    const h = fixture();
    h.hold();
    const pending = h.dispatch(request('goal.get'));
    await vi.waitFor(() => expect(h.goal).toHaveBeenCalledOnce());
    h.revoke(); h.release();
    expect(await pending).toMatchObject({ ok: false });
    const s = fixture();
    s.foreign();
    expect(await s.dispatch(request('task.list'))).toMatchObject({ ok: false, error: { code: 'STALE_SESSION' } });
    expect(s.tasks).not.toHaveBeenCalled();
  });
});
