import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandJournal } from '../../src/core/commands/CommandJournal';
import { Dispatcher, type DispatchResolvers, type HandlerMap } from '../../src/core/dispatch/Dispatcher';
import { createAuthenticatedServerContext, createLocalIpcContext } from '../../src/core/dispatch/RequestContext';
import { WorkspaceControl, CONTROL_LEASE_MS } from '../../src/core/security/WorkspaceControl';
import { ApprovalChallenges, APPROVAL_CHALLENGE_MS, type ApprovalTarget } from '../../src/core/security/ApprovalChallenges';
import { WorkspaceAdmissionQueue } from '../../src/core/workspaces/WorkspaceAdmissionQueue';
import { ScopedDomainEvents } from '../../src/core/events/ScopedDomainEvents';
import { WorkspaceEventHub } from '../../src/core/events/WorkspaceEventHub';
import type { FateCore } from '../../src/core/FateCore';
import type { WorkspaceHandle } from '../../src/core/workspaces/WorkspaceHandle';
import type { ClientTickets } from '../../src/server/auth/ClientTickets';
import { createNetworkDispatcher } from '../../src/server/http/NetworkDispatcher';
import { createMutationIdentity } from '../../src/shared/protocol/requestIds';
import { requestEnvelopeSchema } from '../../src/shared/protocol/envelopes';

const epoch = '10000000-0000-4000-8000-000000000001';
const workspaceId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000003';
const principalId = '40000000-0000-4000-8000-000000000004';
const clientA = '50000000-0000-4000-8000-000000000005';
const clientB = '60000000-0000-4000-8000-000000000006';
const runId = '70000000-0000-4000-8000-000000000007';
const at = 1_800_000_000_000;
const root = path.resolve('control-integration-root');
const scratch: string[] = [];
const hubs: WorkspaceEventHub[] = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) hub.dispose();
  await Promise.all(scratch.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
const identity = (clientId: string) => createAuthenticatedServerContext({ principalId, clientId, expiresAt: at + 120_000 }, null);
const command = (method: string, input: object, workspaceGeneration = 3) => ({ protocol: 1, method, input,
  workspaceId, workspaceGeneration, requestId: crypto.randomUUID(), serverEpoch: epoch, issuedAt: at });

function networkFixture(mayTakeOver?: () => boolean, journal?: CommandJournal) {
  let now = at, storageOpen = true, effects = 0;
  let beforeSdk: () => void = () => undefined, afterSdk: () => void = () => undefined;
  const a = identity(clientA), b = identity(clientB);
  const live = new Set([a, b]);
  const events = new WorkspaceEventHub(new ScopedDomainEvents(), epoch); hubs.push(events);
  const prompt = vi.fn<WorkspaceHandle['runtime']['prompt']>(async (_input, _expand, _prepared, _replayed, assertAdmission) => {
    beforeSdk();
    if (!assertAdmission) throw new Error('The captured runtime admission guard is required.');
    assertAdmission(); effects++; afterSdk();
    return { accepted: true, runId };
  });
  const runtime = { prompt, getState: () => ({ status: 'ready' as const,
    project: { path: root, name: 'Synthetic control workspace', trusted: true }, sessionId, sessionFile: null,
    streaming: false, model: null, models: [], thinkingLevel: 'medium' as const, permissionLevel: 'edit' as const,
    messages: [], error: null, sessionOperation: false, eventCursor: 0 }) } satisfies Pick<WorkspaceHandle['runtime'], 'getState' | 'prompt'>;
  const admission = new WorkspaceAdmissionQueue(runtime, 3, () => {
    if (!storageOpen) throw new Error('STORAGE_UNAVAILABLE: a required lifecycle checkpoint is pending.');
  });
  const handle = { id: workspaceId, generation: 3, root, runtime, files: { getRoot: () => root }, admission } as unknown as WorkspaceHandle;
  const tickets = { isLive: (context: unknown) => live.has(context as typeof a),
    isMember: (context: unknown, requestedRoot: string) => live.has(context as typeof a) && requestedRoot === root } as unknown as ClientTickets;
  const core = { events, workspaces: { resolve: (context: unknown, id: string, generation: number) => {
    if (!live.has(context as typeof a) || id !== workspaceId || generation !== 3) throw new Error('Not a member.');
    return handle;
  } }, runtime: { workspaceOrigin: () => ({ workspaceId, workspaceGeneration: 3 }), peekWorkspace: () => handle.runtime },
  sessionPermissions: { assertHealthy: () => undefined } } as unknown as FateCore;
  const service = createNetworkDispatcher({ core, tickets, journal: journal ?? {} as CommandJournal, serverEpoch: epoch,
    registeredRoots: [root], hostId: principalId, appVersion: '2.0.0', now: () => now,
    ...(mayTakeOver ? { mayTakeOver } : {}) });
  return { a, b, service, live, events, prompt, effects: () => effects, blockStorage: () => { storageOpen = false; },
    beforeSdk: (hook: () => void) => { beforeSdk = hook; }, afterSdk: (hook: () => void) => { afterSdk = hook; },
    setNow: (value: number) => { now = value; },
    send: (context: typeof a, method: string, input: object = {}) => service.dispatcher.dispatchJson(JSON.stringify(command(method, input)), context) };
}

async function promptFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'control-prompt-journal-')); scratch.push(directory);
  const journal = new CommandJournal({ root: path.join(directory, 'journal'), serverEpoch: epoch, now: () => at });
  const f = networkFixture(() => true, journal);
  expect(await f.send(f.a, 'control.claim')).toMatchObject({ ok: true, result: { generation: 1 } });
  const original = requestEnvelopeSchema.parse({ ...command('runtime.prompt', { text: 'One captured turn only.' }),
    ...createMutationIdentity(epoch, at), expectedSessionId: sessionId, selectionRevision: 0, controlGeneration: 1 });
  const dispatch = (request = original, context = f.a) => f.service.dispatcher.dispatchJson(JSON.stringify(request), context);
  const status = (context = f.a) => f.send(context, 'command.status', { requestId: original.requestId });
  return { ...f, journal, original, dispatch, status };
}

describe('T36 network control composition', () => {
  it('binds claims to ticket identities, rejects observers and client-supplied authority, and fences renew/release', async () => {
    const f = networkFixture();
    const [first, rival] = await Promise.all([f.send(f.a, 'control.claim'), f.send(f.b, 'control.claim')]);
    expect(first).toMatchObject({ ok: true, method: 'control.claim', result: { generation: 1, expiresAt: at + CONTROL_LEASE_MS } });
    expect(rival).toMatchObject({ ok: false, error: { code: 'CONTROL_REQUIRED' } });
    expect(await f.send(f.b, 'control.takeover')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await f.send(f.b, 'control.renew', { generation: 1 })).toMatchObject({ ok: false, error: { code: 'CONTROL_REQUIRED' } });
    expect(await f.send(f.a, 'control.renew', { generation: 1 })).toMatchObject({ ok: true, result: { generation: 1 } });
    expect(await f.send(f.a, 'control.release', { generation: 2 })).toMatchObject({ ok: false, error: { code: 'CONTROL_REQUIRED' } });
    expect(await f.send(f.a, 'control.release', { generation: 1 })).toMatchObject({ ok: true, result: { generation: 2, expiresAt: null } });
    expect(await f.send(f.b, 'control.claim')).toMatchObject({ ok: true, result: { generation: 3 } });
    const forged = { ...command('control.release', { generation: 3 }), clientId: clientB };
    expect(await f.service.dispatcher.dispatchJson(JSON.stringify(forged), f.a)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    const local = createLocalIpcContext({ principalId, clientId: clientB, expiresAt: at + 120_000 });
    expect(await f.service.dispatcher.dispatchJson(JSON.stringify(command('control.claim', {})), local))
      .toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
  });

  it('revokes the actual socket identity on disconnect; an expired lease cannot be renewed', async () => {
    const f = networkFixture();
    const eventScope = { principalId, clientId: clientB, workspaceId, workspaceGeneration: 3,
      serverEpoch: epoch, sessionId, projectPath: root };
    const changes = f.events.subscribe(eventScope);
    expect(await f.send(f.a, 'control.claim')).toMatchObject({ ok: true, result: { generation: 1 } });
    f.service.onDisconnect(clientB); // An observer cannot revoke the controller.
    expect(f.events.position(eventScope).sequence).toBe(1);
    f.live.delete(f.a);
    expect(() => f.service.onDisconnect(clientA)).not.toThrow();
    expect(changes.drain()).toMatchObject([
      { origin: { workspaceId, workspaceGeneration: 3, sessionId }, event: { kind: 'control', event: { generation: 1 } } },
      { origin: { workspaceId, workspaceGeneration: 3, sessionId }, event: { kind: 'control', event: { generation: 2 } } },
    ]);
    f.service.onDisconnect(clientA); // Trusted cleanup is idempotent, not another transition.
    expect(f.events.position(eventScope).sequence).toBe(2);
    expect(await f.send(f.a, 'control.renew', { generation: 1 })).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    expect(await f.send(f.b, 'control.claim')).toMatchObject({ ok: true, result: { generation: 3 } });
    f.setNow(at + CONTROL_LEASE_MS);
    expect(await f.send(f.b, 'control.renew', { generation: 3 })).toMatchObject({ ok: false, error: { code: 'CONTROL_REQUIRED' } });
    f.live.add(f.a);
    expect(await f.send(f.a, 'control.claim')).toMatchObject({ ok: true, result: { generation: 5 } });
  });

  it('permits takeover only under trusted host policy, without calling a runtime abort', async () => {
    let approved = false;
    const f = networkFixture(() => approved);
    expect(await f.send(f.a, 'control.claim')).toMatchObject({ ok: true, result: { generation: 1 } });
    expect(await f.send(f.b, 'control.takeover')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    approved = true;
    expect(await f.send(f.b, 'control.takeover')).toMatchObject({ ok: true, result: { generation: 2 } });
    expect(await f.send(f.a, 'control.release', { generation: 1 })).toMatchObject({ ok: false, error: { code: 'CONTROL_REQUIRED' } });
    expect(await f.send(f.b, 'permission.confirm', { confirmed: true, newLevel: 'full-access' }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });
});

describe('T36 production network prompt admission versus outcome delivery', () => {
  it('journals the accepted original ID while its lifecycle checkpoint blocks NEW admissions, without replaying a duplicate', async () => {
    const f = await promptFixture();
    f.afterSdk(f.blockStorage);
    const accepted = await f.dispatch();
    expect(accepted).toMatchObject({ ok: true, requestId: f.original.requestId, scope: { workspaceId, workspaceGeneration: 3 },
      result: { kind: 'prompt', requestId: f.original.requestId, durability: 'journaled', outcome: 'accepted', sessionId, runId } });
    expect(await f.dispatch()).toEqual(accepted);
    expect(await f.status()).toMatchObject({ ok: true, result: { state: 'settled', receipt: { requestId: f.original.requestId, sessionId, runId } } });
    const next = requestEnvelopeSchema.parse({ ...f.original, ...createMutationIdentity(epoch, at) });
    expect(await f.dispatch(next)).toMatchObject({ ok: false, execution: 'not-started', operationId: null });
    expect(await f.journal.status(next.requestId, workspaceId, principalId)).toMatchObject({ state: 'rejected', receipt: null });
    expect(f.effects()).toBe(1); expect(f.prompt).toHaveBeenCalledOnce();
  });

  it('preserves an admitted receipt across a subsequent control transfer, but fences a new action from the old controller', async () => {
    const f = await promptFixture();
    f.afterSdk(() => { f.service.control.takeover(f.b, workspaceId); });
    const accepted = await f.dispatch();
    expect(accepted).toMatchObject({ ok: true, result: { requestId: f.original.requestId, outcome: 'accepted', sessionId, runId } });
    expect(await f.dispatch()).toEqual(accepted);
    expect(await f.dispatch(requestEnvelopeSchema.parse({ ...f.original, ...createMutationIdentity(epoch, at) })))
      .toMatchObject({ ok: false, execution: 'not-started', error: { code: 'CONTROL_REQUIRED' } });
    expect(f.effects()).toBe(1); expect(f.prompt).toHaveBeenCalledOnce();
  });

  it('rechecks control at the runtime SDK seam after asynchronous preparation; an uncertain runtime failure is not replayed', async () => {
    const f = await promptFixture();
    f.beforeSdk(() => { f.service.control.takeover(f.b, workspaceId); });
    expect(await f.dispatch()).toMatchObject({ ok: false, requestId: f.original.requestId,
      execution: 'unknown', operationId: f.original.requestId, error: { code: 'OUTCOME_UNKNOWN' } });
    expect(await f.status(f.b)).toMatchObject({ ok: true, result: { state: 'outcome_unknown', receipt: null } });
    expect(await f.dispatch()).toMatchObject({ ok: false, execution: 'unknown' });
    expect(f.effects()).toBe(0); expect(f.prompt).toHaveBeenCalledOnce();
  });

  it('fails closed on lost authentication after acceptance while retaining the durable original receipt for authorized status review', async () => {
    const f = await promptFixture();
    f.afterSdk(() => { f.live.delete(f.a); });
    expect(await f.dispatch()).toMatchObject({ ok: false, requestId: f.original.requestId, execution: 'unknown',
      operationId: f.original.requestId, error: { code: 'UNAUTHENTICATED' } });
    expect(await f.status()).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    expect(await f.status(f.b)).toMatchObject({ ok: true, result: { state: 'settled', receipt: { requestId: f.original.requestId, sessionId, runId } } });
    expect(await f.dispatch()).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    expect(f.effects()).toBe(1); expect(f.prompt).toHaveBeenCalledOnce();
  });

  it('retains an SDK exception as unknown under its original ID and never executes that ID again', async () => {
    const f = await promptFixture();
    f.afterSdk(() => { throw new Error('Synthetic private SDK outcome failure.'); });
    const unknown = await f.dispatch();
    expect(unknown).toMatchObject({ ok: false, requestId: f.original.requestId, execution: 'unknown',
      operationId: f.original.requestId, error: { code: 'OUTCOME_UNKNOWN' } });
    expect(JSON.stringify(unknown)).not.toContain('Synthetic private SDK outcome failure.');
    expect(await f.status()).toMatchObject({ ok: true, result: { state: 'outcome_unknown', receipt: null } });
    expect(await f.dispatch()).toMatchObject({ ok: false, execution: 'unknown' });
    expect(f.effects()).toBe(1); expect(f.prompt).toHaveBeenCalledOnce();
  });
});

describe('T36 single-use atomic runtime permission confirmation', () => {
  it('rejects expired, replayed, wrong-generation and above-cap nonces before admitting a grant', async () => {
    let now = at;
    let level: 'read-only' | 'edit' | 'full-access' = 'read-only';
    let cap: 'edit' | 'full-access' = 'edit';
    const a = identity(clientA);
    const control = new WorkspaceControl({ now: () => now, isMember: () => true });
    const generation = control.claim(a, workspaceId).generation;
    const target: ApprovalTarget = { workspaceId, sessionId, action: 'runtime.setPermission',
      oldLevel: 'read-only', newLevel: 'edit', controlGeneration: generation, selectionRevision: 0 };
    const atomicGrant = vi.fn(async (_context: unknown, current: ApprovalTarget) => { level = current.newLevel; });
    const approvals = new ApprovalChallenges({ now: () => now,
      mayApprove: (context, value) => control.hasControl(context, workspaceId, value.controlGeneration ?? -1),
      readState: () => ({ trusted: true, storageHealthy: true, currentLevel: level, hostMaximum: cap }), atomicGrant });
    const expired = approvals.issue(a, target);
    now += APPROVAL_CHALLENGE_MS;
    await expect(approvals.consume(a, expired.id, target)).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
    expect(level).toBe('read-only');
    expect(atomicGrant).not.toHaveBeenCalled();
    // Renew control after expiry, then bind a new nonce to the fresh generation.
    const next = control.claim(a, workspaceId).generation;
    const fresh = { ...target, controlGeneration: next };
    cap = 'full-access';
    const aboveCap = approvals.issue(a, { ...fresh, newLevel: 'full-access' });
    cap = 'edit';
    await expect(approvals.consume(a, aboveCap.id, { ...fresh, newLevel: 'full-access' }))
      .rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
    await expect(approvals.consume(a, approvals.issue(a, fresh).id, { ...fresh, controlGeneration: generation }))
      .rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
    const challenge = approvals.issue(a, fresh);
    await approvals.consume(a, challenge.id, fresh);
    expect(level).toBe('edit');
    await expect(approvals.consume(a, challenge.id, fresh)).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
    expect(atomicGrant).toHaveBeenCalledOnce();
  });

  it('does not activate after a failed atomic persistence and cannot replay its nonce', async () => {
    const a = identity(clientA);
    const control = new WorkspaceControl({ now: () => at, isMember: () => true });
    const generation = control.claim(a, workspaceId).generation;
    const target: ApprovalTarget = { workspaceId, sessionId, action: 'runtime.setPermission',
      oldLevel: 'read-only', newLevel: 'edit', controlGeneration: generation, selectionRevision: 0 };
    const active = false;
    const approvals = new ApprovalChallenges({ now: () => at,
      mayApprove: (context, value) => control.hasControl(context, workspaceId, value.controlGeneration ?? -1),
      readState: () => ({ trusted: true, storageHealthy: true, currentLevel: active ? 'edit' : 'read-only', hostMaximum: 'edit' }),
      atomicGrant: async () => { throw new Error('Synthetic storage failure.'); } });
    const nonce = approvals.issue(a, target);
    await expect(approvals.consume(a, nonce.id, target)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(active).toBe(false);
    await expect(approvals.consume(a, nonce.id, target)).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
  });

  it('continues an already-admitted durable grant after takeover, but not an unadmitted nonce', async () => {
    const a = identity(clientA), b = identity(clientB);
    const control = new WorkspaceControl({ now: () => at, isMember: () => true, mayTakeOver: () => true });
    const generation = control.claim(a, workspaceId).generation;
    const target: ApprovalTarget = { workspaceId, sessionId, action: 'runtime.setPermission',
      oldLevel: 'read-only', newLevel: 'edit', controlGeneration: generation, selectionRevision: 0 };
    let level: 'read-only' | 'edit' = 'read-only';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const approvals = new ApprovalChallenges({ now: () => at,
      mayApprove: (context, value) => control.hasControl(context, workspaceId, value.controlGeneration ?? -1),
      readState: () => ({ trusted: true, storageHealthy: true, currentLevel: level, hostMaximum: 'edit' }),
      atomicGrant: async () => { await gate; level = 'edit'; } });
    const admitted = approvals.issue(a, target), pending = approvals.issue(a, target);
    let admissionCount = 0;
    const running = approvals.consume(a, admitted.id, target, () => { admissionCount++; });
    expect(admissionCount).toBe(1);
    control.takeover(b, workspaceId);
    approvals.revokeClient(a);
    await expect(approvals.consume(a, pending.id, target)).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
    release(); await running;
    expect(level).toBe('edit');
    expect(admissionCount).toBe(1);
  });
});

describe('T36 isolated durable queue-head fence (not a production enable switch)', () => {
  it('retains an active run, but rejects a journal-admitted queued prompt after control transfer', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'control-journal-')); scratch.push(directory);
    const a = identity(clientA), b = identity(clientB);
    const control = new WorkspaceControl({ now: () => at, isMember: () => true, mayTakeOver: () => true });
    control.claim(a, workspaceId);
    const runtime = { getState: (_include: false) => ({ sessionId }) };
    const queue = new WorkspaceAdmissionQueue(runtime, 3);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const prompt = vi.fn(async (_input: unknown, context: Parameters<HandlerMap['runtime.prompt']>[1]) => {
      const command = { workspaceGeneration: 3, expectedSessionId: sessionId, selectionRevision: 0, controlGeneration: context.controlGeneration };
      return queue.run(command, () => ({ currentGeneration: 3, permission: true,
        controlGeneration: control.hasControl(context.identity, workspaceId, command.controlGeneration) ? command.controlGeneration : null }),
      async () => { entered(); await gate; return { accepted: true, runId, sessionId, viewRevision: 1 }; });
    });
    const handlers: HandlerMap = {
      'host.info': (_input, context) => ({ hostId: principalId, protocol: 1, serverEpoch: epoch,
        serverTime: context.serverTime, appVersion: '2.0.0', capabilities: [], networkDispatchEnabled: false }),
      'workspace.list': () => ({ workspaces: [] }),
      'file.list': (input) => ({ directoryId: input.directoryId, entries: [], truncated: false }),
      'file.previewText': (input) => ({ fileId: input.fileId, content: '', truncated: false }),
      'runtime.prompt': prompt,
      'runtime.abort': () => ({ aborted: false, sessionId, viewRevision: 1 }),
      'session.select': (input) => ({ sessionId: input.sessionId, selectionRevision: 1, viewRevision: 1 }),
    };
    const workspaceHandle = {}, sessionHandle = {};
    const resolvers: DispatchResolvers = {
      authenticate: () => true, isMember: () => true,
      workspace: () => ({ workspaceId, generation: 3, selectedSessionId: sessionId, selectionRevision: 0, handle: workspaceHandle }),
      hasCapability: () => true,
      hasControl: (context, _workspace, generation) => control.hasControl(context, workspaceId, generation),
      hasPermission: () => true,
      session: (_context, _workspace, id) => ({ sessionId: id, workspaceId, workspaceGeneration: 3, handle: sessionHandle }),
      resource: () => null,
    };
    const journal = new CommandJournal({ root: path.join(directory, 'journal'), serverEpoch: epoch, now: () => at });
    const isolatedApprovals = new ApprovalChallenges({ now: () => at, mayApprove: () => false,
      readState: () => ({ trusted: false, storageHealthy: false, currentLevel: 'read-only', hostMaximum: 'edit' }),
      atomicGrant: async () => { throw new Error('Synthetic approvals are not exposed.'); } });
    const dispatcher = new Dispatcher({ serverEpoch: epoch, handlers, resolvers, commandJournal: journal,
      workspaceControl: control, approvalChallenges: isolatedApprovals,
      networkReadsEnabled: true, networkMutationsEnabled: true, now: () => at });
    const request = () => ({ protocol: 1, ...createMutationIdentity(epoch, at), method: 'runtime.prompt', input: { text: 'synthetic' },
      workspaceId, workspaceGeneration: 3, expectedSessionId: sessionId, selectionRevision: 0, controlGeneration: 1 });
    const firstRequest = request(), secondRequest = request();
    const first = dispatcher.dispatchJson(JSON.stringify(firstRequest), a);
    await started;
    const second = dispatcher.dispatchJson(JSON.stringify(secondRequest), a);
    await vi.waitFor(async () => expect((await journal.status(secondRequest.requestId, workspaceId, principalId)).state).toBe('admitted'));
    control.takeover(b, workspaceId);
    release();
    expect(await first).toMatchObject({ ok: true, result: { kind: 'prompt', outcome: 'accepted', runId } });
    expect(await second).toMatchObject({ ok: false, error: { code: 'CONTROL_REQUIRED' }, execution: 'not-started' });
    expect(prompt).toHaveBeenCalledOnce();
    expect(await journal.status(secondRequest.requestId, workspaceId, principalId))
      .toMatchObject({ state: 'rejected', rejectionCode: 'CONTROL_REQUIRED' });
  });
});
