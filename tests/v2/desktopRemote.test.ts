import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionProfileStore, type ApprovedConnectionProfile } from '../../src/main/connections/ConnectionProfileStore';
import { ConnectionSelectionStore } from '../../src/main/connections/ConnectionSelectionStore';
import { RemoteOutcomeStore } from '../../src/main/connections/RemoteOutcomeStore';
import { DesktopConnectionRouter } from '../../src/main/connections/DesktopConnectionRouter';
import { requestEnvelopeSchema, responseEnvelopeSchema, type WireRequest } from '../../src/shared/protocol/envelopes';
import { methodCatalog, type WireResultOf } from '../../src/shared/protocol/methods';
import { safeError } from '../../src/shared/protocol/errors';
import { networkEventSchema, type NetworkEvent } from '../../src/shared/protocol/diagnostics';
import type { SnapshotPage } from '../../src/shared/protocol/snapshots';
import { pendingRemoteOutcomeSchema, type RemoteScope, type DesktopConnectionApi, type DesktopConnectionState,
  type RemoteSnapshot, type RemoteMutation } from '../../src/shared/contracts/connections';
import { permissionReceiptSchema, type CommandStatus } from '../../src/shared/protocol/commandOutcomes';
import { RemoteDesktopFateApi } from '../../src/renderer/platform/RemoteDesktopFateApi';
import type { EventConnectionInfo } from '../../src/client/EventTransport';
import type { NativeEvents } from '../../src/main/connections/NativeEventTransport';
import type { RemoteClientOptions } from '../../src/main/connections/RemoteCoreClient';

const credential = `fc1_${'t'.repeat(43)}`; // Synthetic. Never reads a user/provider store.
const hostId = randomUUID(), epoch = randomUUID(), originalSessionId = randomUUID();
const workspace = { workspaceId: randomUUID(), workspaceGeneration: 3, label: 'Remote workspace' };
const streamId = randomUUID(), pageId = randomUUID(), snapshotId = randomUUID();
const privateSentinel = path.resolve('private-client-reference-SENTINEL.key');
async function privateRoot(): Promise<string> {
  const parent = process.env.FATE_V2_TEST_ROOT;
  if (!parent || !path.isAbsolute(parent)) throw new Error('Run through the private isolated V2 test runner.');
  // The runner verifies the Windows root DACL and cleans only its own private tree.
  return mkdtemp(path.join(parent, 'desktop-remote-'));
}
const storedMetadata = z.object({ version: z.literal(1), outcomes: z.array(pendingRemoteOutcomeSchema) }).strict();

/** Node guard forbids ALL outbound sockets/fetch, including loopback. Inject bounded transport
 * ports, never bypass that guard. Exercise the real HttpCommandTransport, schemas and private
 * filesystem journal. NativeEventTransport.test.ts checks the actual upgrade/hello builder. */
async function fakeHost(options: { refuse?: boolean; differentHost?: boolean; incompatible?: boolean; losePrompt?: boolean;
  loseSelection?: boolean; loseGrant?: boolean; delayedMonitor?: boolean; echoSecret?: boolean;
  noJournal?: boolean; pauseFirstWrite?: boolean; clockOffset?: number; snapshotTtl?: number; durableGrant?: boolean; rejectGrant?: boolean;
  controlBeforeAck?: boolean; pauseControl?: 'control.claim' | 'control.renew' | 'control.takeover'; leaseMs?: number } = {}) {
  const requests: WireRequest[] = [], headers: Array<{ url: string; authorization: string | null; origin: string | null; cookie: string | null }> = [];
  const root = await privateRoot(), outcomeFile = path.join(root, 'outcomes.json'), outcomes = new RemoteOutcomeStore(outcomeFile);
  await outcomes.load(); // Real private storage, not a no-op or production fallback.
  let written!: () => void, resume!: () => void, pause = options.pauseFirstWrite === true;
  const firstWritten = new Promise<void>((resolve) => { written = resolve; }), resumed = new Promise<void>((resolve) => { resume = resolve; });
  const saveOutcomes = async (values: readonly z.infer<typeof pendingRemoteOutcomeSchema>[]) => {
    await outcomes.save(values);
    if (pause) { pause = false; written(); await resumed; }
  };
  const beforeSend: z.infer<typeof pendingRemoteOutcomeSchema>[] = [];
  let sessionId: string = originalSessionId;
  let selectionRevision = 4, permission: 'read-only' | 'edit' | 'full-access' = 'edit';
  let promptEffects = 0, grantEffects = 0, selectionEffects = 0, sequence = 0, controlGeneration = 2, ticket = '';
  let eventSink: (event: NetworkEvent) => void = () => undefined;
  let deferredMonitor: { request: WireRequest; resolve(response: Response): void } | null = null;
  let entered!: () => void, controlEnteredResolve!: () => void;
  const monitorEntered = new Promise<void>((resolve) => { entered = resolve; });
  const controlEntered = new Promise<void>((resolve) => { controlEnteredResolve = resolve; });
  let deferredControl: { request: WireRequest; result: WireResultOf<'control.claim'>; resolve(response: Response): void } | null = null;
  const permissionJournal = new Map<string, CommandStatus>();
  let reviewedStatus: CommandStatus | null = null;
  let statusBinding: { requestId?: string; serverEpoch?: string; scope?: { workspaceId: string; workspaceGeneration: number } } | null = null;
  let statusAuthenticationFailure: 401 | 403 | null = null;
  const hostNow = () => Date.now() + (options.clockOffset ?? 0);
  const emitControl = (generation: number) => eventSink(networkEventSchema.parse({ version: 1, serverEpoch: epoch, streamId, sequence: ++sequence,
    origin: { workspaceId: workspace.workspaceId, workspaceGeneration: 3, sessionId: null },
    category: 'control', eventType: 'control.changed', controlGeneration: generation }));
  const snapshot = (): SnapshotPage => ({ version: 1, snapshotId, pageId, index: 0, nextPageId: null,
    items: [{ kind: 'message', id: 'bounded-row', role: 'assistant', text: options.echoSecret
      ? `${credential} ${privateSentinel} ${ticket}` : 'Remote bounded view', timestamp: 1, clipped: false, mediaOmitted: true }],
    header: { version: 1, snapshotId, capturedAt: hostNow(), expiresAt: hostNow() + (options.snapshotTtl ?? 60_000),
      workspaceId: workspace.workspaceId, workspaceGeneration: 3, serverEpoch: epoch, sessionId, selectionRevision, eventCursor: sequence,
      eventStream: { serverEpoch: epoch, streamId, workspaceId: workspace.workspaceId, workspaceGeneration: 3, sequence },
      pageIds: [pageId], controls: { status: 'ready', streaming: true, activeSessionRunning: true, runningSessionCount: 1,
        permissionLevel: permission, thinkingLevel: 'medium', model: null, pendingModel: null, pendingThinkingLevel: null,
        sessionOperation: false, queue: { steering: 0, followUp: 0, pending: 0, held: 0, recovered: 0 } },
      goal: null, taskRevision: null, tasks: [], agents: [], omissions: { history: true, media: true, clippedItems: 0,
        agentRows: false, taskRows: false, goalText: false, taskText: false, agentText: false, queueContents: true }, warnings: [] } });
  const monitor = (): WireResultOf<'workspace.monitor'> => ({ sessionId, selectionRevision, revision: `${selectionRevision}:monitor`, checkedAt: hostNow(),
    overall: 'unknown', sources: { runs: 'unknown', teams: 'ready', tasks: 'ready', activity: 'ready' },
    sourceCheckedAt: { runs: null, teams: 1, tasks: 1, activity: 1 },
    counts: { active: 1, attention: 0, runs: 1, teams: 0, tasks: 0, activity: 0 }, section: 'overview', total: 1,
    offset: 0, limit: 10, unchanged: false, items: [{ id: 'a'.repeat(32), source: 'runs', state: 'active', title: 'Runs', updatedAt: 1 }] });
  const reply = (request: WireRequest, result: unknown): Response => new Response(JSON.stringify(responseEnvelopeSchema.parse({
    protocol: 1, ok: true, requestId: request.requestId, serverEpoch: epoch,
    scope: request.method === 'host.info' || request.method === 'workspace.list' ? null
      : { workspaceId: workspace.workspaceId, workspaceGeneration: 3 },
    ...(request.method === 'command.status' ? statusBinding ?? {} : {}), method: request.method, result,
  })), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const send: typeof fetch = async (input, init) => {
    const requestHeaders = new Headers(init?.headers);
    headers.push({ url: String(input), authorization: requestHeaders.get('Authorization'), origin: requestHeaders.get('Origin'), cookie: requestHeaders.get('Cookie') });
    expect(init?.credentials).toBe('omit'); expect(init?.redirect).toBe('error'); expect(init?.cache).toBe('no-store');
    if (options.refuse || requestHeaders.get('Authorization') !== `Bearer ${credential}`) return new Response('{}', { status: 401 });
    const command = requestEnvelopeSchema.parse(JSON.parse(String(init?.body)) as unknown); requests.push(command);
    if (methodCatalog[command.method].mutation === 'runtime' || methodCatalog[command.method].mutation === 'selection'
      || command.method === 'permission.confirm') {
      // Assert original metadata exists on disk BEFORE the fake host observes an effect.
      const saved = storedMetadata.parse(JSON.parse(await readFile(outcomeFile, 'utf8')) as unknown);
      const original = saved.outcomes.find((item) => item.requestId === command.requestId);
      expect(original).toMatchObject({ requestId: command.requestId, method: command.method, status: 'sending' });
      beforeSend.push(pendingRemoteOutcomeSchema.parse(original));
    }
    switch (command.method) {
      case 'host.info': {
        const info: WireResultOf<'host.info'> = { hostId: options.differentHost ? randomUUID() : hostId, hostName: 'Synthetic approved host',
          takeoverAllowed: true, protocol: 1, serverEpoch: epoch, serverTime: hostNow(), appVersion: '1.1.0',
          capabilities: ['host.info', 'workspace.list', 'workspace.snapshot', 'workspace.monitor', 'workspace.control',
            'permission.approve', 'runtime.prompt', 'runtime.abort', 'session.select', 'file.read', 'goal.read', 'task.read'], networkDispatchEnabled: true };
        if (options.incompatible) return new Response(JSON.stringify({ ...info, protocol: 2 }), { status: 200 });
        return reply(command, info);
      }
      case 'workspace.list': return reply(command, { workspaces: [workspace] });
      case 'workspace.snapshot': return reply(command, snapshot());
      case 'workspace.monitor':
        if (options.delayedMonitor) { entered(); return new Promise<Response>((resolve) => { deferredMonitor = { request: command, resolve }; }); }
        return reply(command, monitor());
      case 'goal.get': return reply(command, { sessionId, selectionRevision, goal: null });
      case 'task.list': return reply(command, { sessionId, selectionRevision, list: null });
      case 'control.claim': case 'control.renew': case 'control.takeover': {
        const result = { generation: controlGeneration, expiresAt: hostNow() + (options.leaseMs ?? 30_000) };
        if (options.controlBeforeAck) emitControl(controlGeneration);
        if (options.pauseControl === command.method) {
          controlEnteredResolve(); return new Promise<Response>((resolve) => { deferredControl = { request: command, result, resolve }; });
        }
        return reply(command, result);
      }
      case 'control.release': return reply(command, { generation: controlGeneration, expiresAt: null });
      case 'file.list': return reply(command, { directoryId: command.input.directoryId, entries: [], truncated: false });
      case 'runtime.prompt':
        promptEffects++;
        if (options.losePrompt) throw new Error('Synthetic response loss.');
        return reply(command, { kind: 'prompt', requestId: command.requestId, durability: 'journaled', outcome: 'accepted', sessionId,
          runId: randomUUID(), viewRevision: selectionRevision });
      case 'session.create': case 'session.select':
        selectionEffects++; sessionId = command.method === 'session.select' ? command.input.sessionId : randomUUID(); selectionRevision++;
        if (options.loseSelection) throw new Error('Synthetic selection response loss.');
        return reply(command, command.method === 'session.create'
          ? { kind: 'operation', operation: command.method, requestId: command.requestId, durability: 'journaled', outcome: 'applied', sessionId, viewRevision: selectionRevision }
          : { kind: 'selection', requestId: command.requestId, durability: 'journaled', outcome: 'selected', sessionId, selectionRevision, viewRevision: selectionRevision });
      case 'permission.issue': return reply(command, { challengeId: randomUUID(), sessionId, oldLevel: permission,
        newLevel: command.input.newLevel, expiresAt: hostNow() + 30_000 });
      case 'permission.confirm':
        if (options.rejectGrant) {
          permissionJournal.set(command.requestId, { state: 'rejected', receipt: null, rejectionCode: 'CONTROL_REQUIRED' });
          if (options.loseGrant) throw new Error('Synthetic pre-admission rejection response loss.');
          return new Response(JSON.stringify(responseEnvelopeSchema.parse({ protocol: 1, ok: false, requestId: command.requestId,
            serverEpoch: epoch, scope: { workspaceId: workspace.workspaceId, workspaceGeneration: 3 }, execution: 'not-started',
            operationId: null, error: safeError('CONTROL_REQUIRED') })), { status: 409 });
        }
        permission = command.input.newLevel; grantEffects++;
        if (options.durableGrant) permissionJournal.set(command.requestId, { state: 'settled', rejectionCode: null,
          receipt: permissionReceiptSchema.parse({ kind: 'permission', requestId: command.requestId, durability: 'journaled', outcome: 'applied',
            challengeId: command.input.challengeId, workspaceId: command.workspaceId, workspaceGeneration: command.workspaceGeneration,
            sessionId: command.input.sessionId, selectionRevision: command.selectionRevision, controlGeneration: command.controlGeneration,
            oldLevel: command.input.oldLevel, newLevel: command.input.newLevel }) });
        if (options.loseGrant) throw new Error('Synthetic grant response loss.');
        return reply(command, { applied: true, sessionId, level: permission });
      case 'command.status':
        if (statusAuthenticationFailure !== null) return new Response('{}', { status: statusAuthenticationFailure });
        return reply(command, reviewedStatus ?? permissionJournal.get(command.input.requestId)
          ?? { state: 'absent', receipt: null, rejectionCode: null });
      default: return new Response(JSON.stringify({ protocol: 1, ok: false, requestId: command.requestId, serverEpoch: epoch,
        scope: null, execution: 'not-started', operationId: null, error: safeError('UNSUPPORTED_CAPABILITY') }), { status: 400 });
    }
  };
  const profile: ApprovedConnectionProfile = { id: randomUUID(), label: 'Approved remote', hostId, approved: true,
    baseUrl: 'http://127.0.0.1:49331', credentialRef: privateSentinel };
  const readCredential = vi.fn(async () => credential);
  const profiles = new ConnectionProfileStore([profile], readCredential);
  const clientOptions: RemoteClientOptions = {
    send, outcomeStorage: !options.noJournal, ...(!options.noJournal ? { saveOutcomes } : {}),
    makeEvents: (onEvent) => {
      eventSink = onEvent; let connection: EventConnectionInfo | null = null;
      const events: NativeEvents = { get connection() { return connection; },
        connect: async () => {
          if (options.refuse) throw new Error('Synthetic authentication denied.');
          ticket = `ft1_${randomBytes(32).toString('base64url')}`;
          connection = { clientId: randomUUID(), serverEpoch: epoch, ticket }; return connection;
        },
        subscribe: async (_workspaceId, _generation, cursor) => ({ ...cursor }), close: () => { connection = null; } };
      return events;
    },
  };
  let router = new DesktopConnectionRouter(profiles, clientOptions);
  const selectAndConnect = async () => { const selected = await router.select({ kind: 'remote', profileId: profile.id });
    return router.connect({ generation: selected.generation }, () => true); };
  const refresh = async (): Promise<RemoteScope> => {
    const state = router.state;
    await router.read(state.generation, () => true, (client) => client.listWorkspaces());
    const view = await router.read(state.generation, () => true, (client) => client.readSnapshot(workspace)); return view.scope;
  };
  const scope = async () => { expect((await selectAndConnect()).status).toBe('observing'); return refresh(); };
  return { get router() { return router; }, profile, headers, requests, outcomes, outcomeFile, beforeSend, readCredential, selectAndConnect, scope, refresh, monitorEntered,
    restart: async (legacy = false) => {
      router.close();
      const initialOutcomes = await outcomes.load();
      if (legacy) for (const item of initialOutcomes) if (item.permission) {
        delete item.permission.challengeId; delete item.permission.controlGeneration;
      }
      router = new DesktopConnectionRouter(profiles, clientOptions, {
        initialSelection: { kind: 'remote', profileId: profile.id }, initialOutcomes,
      });
      await router.connect({ generation: router.state.generation }, () => true); return refresh();
    },
    firstWritten, resumeWrite: resume, controlEntered, emitControl,
    setReviewStatus: (value: CommandStatus | null) => { reviewedStatus = value; },
    setStatusBinding: (value: typeof statusBinding) => { statusBinding = value; },
    setStatusAuthenticationFailure: (value: 401 | 403 | null) => { statusAuthenticationFailure = value; },
    changeSession: () => { sessionId = randomUUID(); selectionRevision++; },
    finishControl: () => { if (deferredControl) deferredControl.resolve(reply(deferredControl.request, deferredControl.result)); },
    finishMonitor: () => { if (deferredMonitor) deferredMonitor.resolve(reply(deferredMonitor.request, monitor())); },
    emit: (eventType: string) => eventSink(networkEventSchema.parse({ version: 1, serverEpoch: epoch, streamId, sequence: ++sequence,
      origin: { workspaceId: workspace.workspaceId, workspaceGeneration: 3, sessionId: eventType === 'control.changed' ? null : sessionId },
      category: eventType === 'control.changed' ? 'control' : 'pi', eventType,
      ...(eventType === 'control.changed' ? { controlGeneration: ++controlGeneration } : {}) })), 
    effects: () => ({ prompts: promptEffects, grants: grantEffects, selections: selectionEffects }), close: () => router.close() };
}

function expectOriginalStatusRequests(host: Awaited<ReturnType<typeof fakeHost>>, scope: RemoteScope, requestId: string, count: number): void {
  const queries = host.requests.filter((request) => request.method === 'command.status');
  expect(queries).toHaveLength(count);
  for (const query of queries) {
    expect(query).toMatchObject({ method: 'command.status', serverEpoch: scope.serverEpoch,
      workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration, input: { requestId } });
    expect(query.requestId).not.toBe(requestId); // Fresh read envelope, unchanged ORIGINAL effect ID.
    expect(query).not.toHaveProperty('expectedSessionId'); expect(query).not.toHaveProperty('selectionRevision');
    expect(query).not.toHaveProperty('controlGeneration');
  }
  expect(host.headers.every((item) => item.authorization === `Bearer ${credential}` && !item.origin && !item.cookie)).toBe(true);
}

// Keep the real private-file writes/fsync/DACL probes. These integration cases
// inherit vitest.v2.config.ts's platform budget (90s Windows, 30s elsewhere),
// rather than overriding Windows's existing ACL allowance with 30s per case.
describe('T43 main-owned sole desktop remote target under the outbound guard', () => {
  it('uses real main command/schema projections and never exposes credentials/references/tickets in public DTOs', async () => {
    const host = await fakeHost({ echoSecret: true });
    try {
      expect(host.router.listProfiles()).toEqual([{ id: host.profile.id, label: 'Approved remote', hostId }]);
      const scope = await host.scope(), view = await host.router.read(scope.generation, () => true, (client) => client.monitor(scope, {}));
      expect(view.dashboard.items[0]?.title).toBe('Runs');
      expect(view.scope).toMatchObject({ generation: scope.generation, profileId: host.profile.id, hostId, serverEpoch: epoch, sessionId: originalSessionId });
      expect(host.readCredential).toHaveBeenCalledWith(privateSentinel);
      expect(host.headers.every((item) => item.authorization === `Bearer ${credential}` && !item.origin && !item.cookie)).toBe(true);
      expect(host.headers.every((item) => !item.url.includes(credential))).toBe(true);
      const snapshotView = await host.router.read(scope.generation, () => true, (client) => client.readSnapshot(workspace));
      expect(snapshotView.items[0]?.text).toBe('[private] [private] [private]');
      expect(host.router.state.lastConfirmedAt).toBe(snapshotView.header.capturedAt);
      const serialized = JSON.stringify({ state: host.router.state, profiles: host.router.listProfiles(), view, snapshotView });
      expect(serialized).not.toContain(credential); expect(serialized).not.toContain(privateSentinel); expect(serialized).not.toContain('ft1_');
      expect(host.requests.find((request) => request.method === 'workspace.monitor')).toMatchObject({ expectedSessionId: originalSessionId, selectionRevision: 4 });
      await host.router.read(scope.generation, () => true, (client) => client.read(scope, 'file.list', { directoryId: null, limit: 200 }));
      expect(host.requests.at(-1)).not.toHaveProperty('expectedSessionId');
    } finally { host.close(); }
  });
  it.each(['auth', 'identity', 'protocol'] as const)('keeps failed %s remote with no local runtime/project/file fallback', async (failure) => {
    const host = await fakeHost({ refuse: failure === 'auth', differentHost: failure === 'identity', incompatible: failure === 'protocol' });
    try {
      const runtimeFactory = vi.fn(), openProject = vi.fn(), fileWrite = vi.fn(), state = await host.selectAndConnect();
      expect(state.kind).toBe('remote'); expect(state.status).toBe(failure === 'auth' ? 'error' : 'incompatible');
      await expect(host.router.routeLegacy('runtime:prompt', runtimeFactory)).rejects.toThrow();
      await expect(host.router.local(openProject)).rejects.toThrow(); await expect(host.router.routeLegacy('files:open', fileWrite)).rejects.toThrow();
      expect(runtimeFactory).not.toHaveBeenCalled(); expect(openProject).not.toHaveBeenCalled(); expect(fileWrite).not.toHaveBeenCalled();
    } finally { host.close(); }
  });
  it('rejects late old-host Monitor data after explicit local selection', async () => {
    const host = await fakeHost({ delayedMonitor: true });
    try {
      const scope = await host.scope(), paint = vi.fn();
      const pending = host.router.read(scope.generation, () => true, (client) => client.monitor(scope, {})).then(paint);
      const refused = expect(pending).rejects.toThrow(); await host.monitorEntered;
      await host.router.select({ kind: 'local' }); expect(host.router.state).toMatchObject({ kind: 'local', scope: null });
      host.finishMonitor(); await refused; expect(paint).not.toHaveBeenCalled();
      expect(host.requests.filter((request) => request.method === 'workspace.monitor')).toHaveLength(1);
    } finally { host.close(); }
  });
  it('allows native window/updater but refuses every local workspace/browser/terminal/provider operation remotely', async () => {
    const host = await fakeHost();
    try {
      await host.scope();
      for (const channel of ['browser:initialize', 'browser:open-local-file', 'files:reveal-link', 'project:select', 'project:open-path',
        'git:operation', 'terminal:create', 'runtime:provider-login:start', 'mcp:probe']) {
        const action = vi.fn(); await expect(host.router.routeLegacy(channel, action)).rejects.toThrow(); expect(action).not.toHaveBeenCalled();
      }
      for (const channel of ['window:control', 'updates:check']) {
        const action = vi.fn(() => 'native'); expect(await host.router.routeLegacy(channel, action)).toBe('native'); expect(action).toHaveBeenCalledOnce();
      }
    } finally { host.close(); }
  });
  it('records the original ID BEFORE an effect and reviews absence without replay or treating it as not executed', async () => {
    const host = await fakeHost({ losePrompt: true });
    try {
      const scope = await host.scope(); await host.router.read(scope.generation, () => true, (client) => client.claim(scope));
      const outcome = await host.router.mutate(scope, () => true, 'runtime.prompt', { text: 'Synthetic prompt context' });
      expect(outcome.status).toBe('outcome_unknown'); expect(host.effects().prompts).toBe(1);
      expect(host.beforeSend[0]).toMatchObject({ requestId: outcome.requestId, method: 'runtime.prompt', status: 'sending', scope });
      expect(host.router.state.pending[0]).toMatchObject({ requestId: outcome.requestId, method: 'runtime.prompt', status: 'outcome_unknown' });
      host.router.disconnect({ generation: scope.generation }); expect(host.router.state.kind).toBe('remote');
      expect(host.router.state.controlGeneration).toBeNull(); expect(host.router.state.lastConfirmedStatus).toBe('running');
      await host.router.connect({ generation: host.router.state.generation }, () => true);
      const refreshed = await host.refresh();
      const status = await host.router.read(refreshed.generation, () => true, (client) => client.review(refreshed, outcome.requestId));
      expect(status.state).toBe('absent'); expect(host.router.state.pending[0]?.status).toBe('outcome_unknown');
      expectOriginalStatusRequests(host, scope, outcome.requestId, 2);
      await host.router.read(refreshed.generation, () => true, (client) => client.claim(refreshed));
      await expect(host.router.mutate(refreshed, () => true, 'runtime.prompt', { text: 'Do not resend' })).rejects.toThrow(/original uncertain/i);
      expect(host.requests.filter((request) => request.method === 'runtime.prompt')).toHaveLength(1);
      expect((await host.outcomes.load())[0]?.requestId).toBe(outcome.requestId);
      const saved = await readFile(host.outcomeFile, 'utf8');
      for (const secret of [credential, privateSentinel, 'ft1_', 'Synthetic prompt context', 'Do not resend']) expect(saved).not.toContain(secret);
    } finally { host.close(); }
  });
  it.each(['session.create', 'session.select'] as const)('reviews original %s after selection changes, without retarget/replay', async (method) => {
    const host = await fakeHost({ loseSelection: true });
    try {
      const scope = await host.scope(); await host.router.read(scope.generation, () => true, (client) => client.claim(scope));
      const outcome = await host.router.mutate(scope, () => true, method, method === 'session.select' ? { sessionId: randomUUID() } : {});
      expect(outcome.status).toBe('outcome_unknown');
      const refreshed = await host.refresh(); expect(refreshed.sessionId).not.toBe(scope.sessionId);
      await host.router.read(refreshed.generation, () => true, (client) => client.review(refreshed, outcome.requestId));
      expect(host.router.state.pending[0]).toMatchObject({ requestId: outcome.requestId, method, sessionId: scope.sessionId, scope });
      expect(host.requests.at(-1)).toMatchObject({ method: 'command.status', input: { requestId: outcome.requestId } });
      expect(host.requests.at(-1)).not.toHaveProperty('expectedSessionId'); expect(host.effects().selections).toBe(1);
      if (method === 'session.select') {
        const target = host.requests.find((request) => request.method === 'session.select')!;
        expect(host.router.state.pending[0]).toHaveProperty('targetSessionId', target.method === 'session.select' ? target.input.sessionId : undefined);
        host.setReviewStatus({ state: 'settled', rejectionCode: null, receipt: permissionReceiptSchema.parse({ kind: 'permission',
          requestId: outcome.requestId, durability: 'journaled', outcome: 'applied', challengeId: randomUUID(),
          workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration, sessionId: scope.sessionId,
          selectionRevision: scope.selectionRevision, controlGeneration: 2, oldLevel: 'edit', newLevel: 'full-access' }) });
        await expect(host.router.read(refreshed.generation, () => true, (client) => client.review(refreshed, outcome.requestId))).rejects.toThrow();
        expect(host.router.state.pending[0]?.status).toBe('outcome_unknown');
      }
    } finally { host.close(); }
  });
  it('queries the original permission confirmation ID but absence/current permission never settles or resubmits it', async () => {
    const host = await fakeHost({ loseGrant: true });
    try {
      const scope = await host.scope(); await host.router.read(scope.generation, () => true, (client) => client.claim(scope));
      const challenge = await host.router.read(scope.generation, () => true, (client) => client.issuePermission(scope, 'full-access'));
      const outcome = await host.router.confirmPermission(scope, () => true, challenge.challengeId);
      expect(outcome.status).toBe('outcome_unknown'); expect(host.effects().grants).toBe(1);
      const refreshed = await host.refresh();
      const result = await host.router.read(refreshed.generation, () => true, (client) => client.review(refreshed, outcome.requestId));
      expect(result).toEqual({ state: 'outcome_unknown', receipt: null, rejectionCode: null });
      const pending = host.router.state.pending[0];
      expect(pending).toMatchObject({ requestId: outcome.requestId, method: 'permission.confirm', status: 'outcome_unknown', scope,
        permission: { oldLevel: 'edit', newLevel: 'full-access', challengeId: challenge.challengeId, controlGeneration: 2,
          observed: { sessionId: scope.sessionId, level: 'full-access' } } });
      expect(pending?.permission?.observed?.capturedAt).toBe(host.router.state.lastConfirmedAt);
      expect(host.requests.filter((request) => request.method === 'command.status')).toHaveLength(1);
      expect(host.requests.at(-1)).toMatchObject({ method: 'command.status', input: { requestId: outcome.requestId } });
      expect(host.requests.at(-1)).not.toHaveProperty('expectedSessionId');
      await expect(host.router.confirmPermission(refreshed, () => true, challenge.challengeId)).rejects.toThrow(/original uncertain/i);
      expect(host.requests.filter((request) => request.method === 'permission.confirm')).toHaveLength(1);
      expect((await host.outcomes.load())[0]?.status).toBe('outcome_unknown');
    } finally { host.close(); }
  });
  it('settles a lost permission ACK after native restart only from its durable original admission tuple, not the current session', async () => {
    const host = await fakeHost({ loseGrant: true, durableGrant: true });
    try {
      const scope = await host.scope(); await host.router.read(scope.generation, () => true, (client) => client.claim(scope));
      const challenge = await host.router.read(scope.generation, () => true, (client) => client.issuePermission(scope, 'full-access'));
      const outcome = await host.router.confirmPermission(scope, () => true, challenge.challengeId);
      expect(outcome.status).toBe('outcome_unknown');
      expect(host.beforeSend[0]?.permission).toMatchObject({ challengeId: challenge.challengeId, controlGeneration: 2 });
      host.changeSession(); const refreshed = await host.restart(); expect(refreshed.sessionId).not.toBe(scope.sessionId);
      const result = await host.router.read(refreshed.generation, () => true, (client) => client.review(refreshed, outcome.requestId));
      expect(result).toMatchObject({ state: 'settled', receipt: { kind: 'permission', requestId: outcome.requestId,
        sessionId: scope.sessionId, workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration,
        selectionRevision: scope.selectionRevision, challengeId: challenge.challengeId, controlGeneration: 2 } });
      expect((await host.outcomes.load())[0]).toMatchObject({ requestId: outcome.requestId, method: 'permission.confirm', scope, status: 'confirmed' });
      expect(host.requests.at(-1)).toMatchObject({ method: 'command.status', input: { requestId: outcome.requestId } });
      expect(host.requests.filter((request) => request.method === 'permission.confirm')).toHaveLength(1); expect(host.effects().grants).toBe(1);
      expectOriginalStatusRequests(host, scope, outcome.requestId, 1);
    } finally { host.close(); }
  });
  it('retains unknown legacy permission records lacking the original challenge/control tuple even with a durable matching receipt', async () => {
    const host = await fakeHost({ loseGrant: true, durableGrant: true });
    try {
      const scope = await host.scope(); await host.router.read(scope.generation, () => true, (client) => client.claim(scope));
      const challenge = await host.router.read(scope.generation, () => true, (client) => client.issuePermission(scope, 'full-access'));
      const outcome = await host.router.confirmPermission(scope, () => true, challenge.challengeId), refreshed = await host.restart(true);
      await expect(host.router.read(refreshed.generation, () => true, (client) => client.review(refreshed, outcome.requestId)))
        .resolves.toEqual({ state: 'outcome_unknown', receipt: null, rejectionCode: null });
      expect((await host.outcomes.load())[0]?.status).toBe('outcome_unknown'); expect(host.effects().grants).toBe(1);
      expectOriginalStatusRequests(host, scope, outcome.requestId, 1);
      expect(host.requests.filter((request) => request.method === 'permission.confirm')).toHaveLength(1);
    } finally { host.close(); }
  });
  it('settles a new complete permission tuple only from authenticated exact-ID scoped durable rejection, without granting or replay', async () => {
    const host = await fakeHost({ rejectGrant: true, loseGrant: true });
    try {
      const scope = await host.scope(); await host.router.read(scope.generation, () => true, (client) => client.claim(scope));
      const challenge = await host.router.read(scope.generation, () => true, (client) => client.issuePermission(scope, 'full-access'));
      const outcome = await host.router.confirmPermission(scope, () => true, challenge.challengeId);
      expect(outcome.status).toBe('outcome_unknown'); expect(host.effects().grants).toBe(0);
      expect(host.beforeSend[0]).toMatchObject({ requestId: outcome.requestId, method: 'permission.confirm', scope,
        permission: { challengeId: challenge.challengeId, controlGeneration: 2, oldLevel: 'edit', newLevel: 'full-access' } });
      host.changeSession(); const refreshed = await host.restart();
      for (const binding of [{ requestId: randomUUID() }, { serverEpoch: randomUUID() },
        { scope: { workspaceId: randomUUID(), workspaceGeneration: 3 } },
        { scope: { workspaceId: workspace.workspaceId, workspaceGeneration: 4 } }]) {
        host.setStatusBinding(binding);
        await expect(host.router.read(refreshed.generation, () => true, (client) => client.review(refreshed, outcome.requestId))).rejects.toThrow();
        expect(host.router.state.pending[0]?.status).toBe('outcome_unknown');
      }
      host.setStatusBinding(null);
      host.setReviewStatus({ state: 'rejected', receipt: null, rejectionCode: null });
      await expect(host.router.read(refreshed.generation, () => true, (client) => client.review(refreshed, outcome.requestId))).rejects.toThrow();
      expect(host.router.state.pending[0]?.status).toBe('outcome_unknown'); host.setReviewStatus(null);
      await expect(host.router.read(refreshed.generation, () => true, (client) => client.review(refreshed, outcome.requestId)))
        .resolves.toEqual({ state: 'rejected', receipt: null, rejectionCode: 'CONTROL_REQUIRED' });
      expect((await host.outcomes.load())[0]).toMatchObject({ requestId: outcome.requestId, method: 'permission.confirm', scope, status: 'not-started',
        permission: { challengeId: challenge.challengeId, controlGeneration: 2 } });
      expect(host.requests.at(-1)).toMatchObject({ method: 'command.status', workspaceId: scope.workspaceId,
        workspaceGeneration: scope.workspaceGeneration, input: { requestId: outcome.requestId } });
      expect(host.requests.at(-1)).not.toHaveProperty('expectedSessionId');
      expect(host.requests.filter((request) => request.method === 'permission.confirm')).toHaveLength(1);
      expect(host.effects().grants).toBe(0);
      expectOriginalStatusRequests(host, scope, outcome.requestId, 6);
    } finally { host.close(); }
  });
  it('keeps a legacy incomplete permission tuple unknown on durable rejection and never grants or replays it', async () => {
    const host = await fakeHost({ rejectGrant: true, loseGrant: true });
    try {
      const scope = await host.scope(); await host.router.read(scope.generation, () => true, (client) => client.claim(scope));
      const challenge = await host.router.read(scope.generation, () => true, (client) => client.issuePermission(scope, 'full-access'));
      const outcome = await host.router.confirmPermission(scope, () => true, challenge.challengeId), refreshed = await host.restart(true);
      await expect(host.router.read(refreshed.generation, () => true, (client) => client.review(refreshed, outcome.requestId)))
        .resolves.toEqual({ state: 'outcome_unknown', receipt: null, rejectionCode: null });
      const saved = (await host.outcomes.load())[0]!;
      expect(saved).toMatchObject({ requestId: outcome.requestId, method: 'permission.confirm', scope, status: 'outcome_unknown' });
      expect(saved.permission).not.toHaveProperty('challengeId'); expect(saved.permission).not.toHaveProperty('controlGeneration');
      await expect(host.router.confirmPermission(refreshed, () => true, challenge.challengeId)).rejects.toThrow(/original uncertain/i);
      expect(host.requests.at(-1)).toMatchObject({ method: 'command.status', input: { requestId: outcome.requestId } });
      expect(host.requests.filter((request) => request.method === 'permission.confirm')).toHaveLength(1); expect(host.effects().grants).toBe(0);
      expectOriginalStatusRequests(host, scope, outcome.requestId, 1);
    } finally { host.close(); }
  });
  it('rejects wrong-method and mismatched grant receipts without clearing the original review or replaying confirmation', async () => {
    const host = await fakeHost({ loseGrant: true });
    try {
      const scope = await host.scope(); await host.router.read(scope.generation, () => true, (client) => client.claim(scope));
      const challenge = await host.router.read(scope.generation, () => true, (client) => client.issuePermission(scope, 'full-access'));
      const outcome = await host.router.confirmPermission(scope, () => true, challenge.challengeId), refreshed = await host.refresh();
      const receipt = permissionReceiptSchema.parse({ kind: 'permission', requestId: outcome.requestId, durability: 'journaled', outcome: 'applied',
        challengeId: challenge.challengeId, workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration,
        sessionId: scope.sessionId, selectionRevision: scope.selectionRevision, controlGeneration: 2, oldLevel: 'edit', newLevel: 'full-access' });
      for (const wrong of [
        { ...receipt, requestId: `${epoch}.1001.${randomUUID()}` }, { ...receipt, workspaceId: randomUUID() },
        { ...receipt, workspaceGeneration: scope.workspaceGeneration + 1 }, { ...receipt, sessionId: randomUUID() },
        { ...receipt, selectionRevision: scope.selectionRevision! + 1 }, { ...receipt, challengeId: randomUUID() },
        { ...receipt, controlGeneration: 3 }, { ...receipt, oldLevel: 'read-only' as const }, { ...receipt, newLevel: 'edit' as const },
        { kind: 'selection' as const, requestId: outcome.requestId, durability: 'journaled' as const, outcome: 'selected' as const,
          sessionId: scope.sessionId!, selectionRevision: scope.selectionRevision!, viewRevision: 5 },
      ]) {
        host.setReviewStatus({ state: 'settled', receipt: wrong, rejectionCode: null });
        await expect(host.router.read(refreshed.generation, () => true, (client) => client.review(refreshed, outcome.requestId))).rejects.toThrow();
        expect(host.router.state.pending[0]).toMatchObject({ requestId: outcome.requestId, method: 'permission.confirm', status: 'outcome_unknown' });
      }
      for (const state of ['absent', 'reserved', 'admitted', 'outcome_unknown'] as const) {
        host.setReviewStatus({ state, receipt: null, rejectionCode: null });
        await expect(host.router.read(refreshed.generation, () => true, (client) => client.review(refreshed, outcome.requestId)))
          .resolves.toEqual({ state: 'outcome_unknown', receipt: null, rejectionCode: null });
        expect((await host.outcomes.load())[0]?.status).toBe('outcome_unknown');
      }
      expect(host.effects().grants).toBe(1); expect(host.requests.filter((request) => request.method === 'permission.confirm')).toHaveLength(1);
      expectOriginalStatusRequests(host, scope, outcome.requestId, 14);
    } finally { host.close(); }
  });
  it('keeps the original permission tuple unknown on denied status authentication, without replay or a local fallback', async () => {
    const host = await fakeHost({ loseGrant: true, durableGrant: true });
    try {
      const scope = await host.scope(); await host.router.read(scope.generation, () => true, (client) => client.claim(scope));
      const challenge = await host.router.read(scope.generation, () => true, (client) => client.issuePermission(scope, 'full-access'));
      const outcome = await host.router.confirmPermission(scope, () => true, challenge.challengeId);
      expect(outcome.status).toBe('outcome_unknown');
      const refreshed = await host.refresh();
      for (const code of [401, 403] as const) {
        host.setStatusAuthenticationFailure(code);
        await expect(host.router.read(refreshed.generation, () => true, (client) => client.review(refreshed, outcome.requestId))).rejects.toThrow();
        expect(host.router.state.pending[0]).toMatchObject({ requestId: outcome.requestId, method: 'permission.confirm', scope,
          status: 'outcome_unknown', permission: { challengeId: challenge.challengeId, controlGeneration: 2 } });
      }
      expect((await host.outcomes.load())[0]?.status).toBe('outcome_unknown');
      await expect(host.router.confirmPermission(refreshed, () => true, challenge.challengeId)).rejects.toThrow(/original uncertain/i);
      const localPrompt = vi.fn(); await expect(host.router.routeLegacy('runtime:prompt', localPrompt)).rejects.toThrow();
      expect(localPrompt).not.toHaveBeenCalled(); expect(host.router.state.kind).toBe('remote');
      expect(host.requests.filter((request) => request.method === 'permission.confirm')).toHaveLength(1); expect(host.effects().grants).toBe(1);
      expectOriginalStatusRequests(host, scope, outcome.requestId, 2);
    } finally { host.close(); }
  });
  it('checks the recorded method and session on non-permission status too, never interpreting a grant receipt as selection', async () => {
    const host = await fakeHost({ losePrompt: true });
    try {
      const scope = await host.scope(); await host.router.read(scope.generation, () => true, (client) => client.claim(scope));
      const outcome = await host.router.mutate(scope, () => true, 'runtime.prompt', { text: 'Original only' }), refreshed = await host.refresh();
      const receipt = { kind: 'prompt' as const, requestId: outcome.requestId, durability: 'journaled' as const,
        outcome: 'accepted' as const, sessionId: scope.sessionId!, runId: randomUUID(), viewRevision: 4 };
      for (const wrong of [{ ...receipt, sessionId: randomUUID() },
        permissionReceiptSchema.parse({ kind: 'permission', requestId: outcome.requestId, durability: 'journaled', outcome: 'applied',
          challengeId: randomUUID(), workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration,
          sessionId: scope.sessionId, selectionRevision: scope.selectionRevision, controlGeneration: 2, oldLevel: 'edit', newLevel: 'full-access' })]) {
        host.setReviewStatus({ state: 'settled', receipt: wrong, rejectionCode: null });
        await expect(host.router.read(refreshed.generation, () => true, (client) => client.review(refreshed, outcome.requestId))).rejects.toThrow();
        expect(host.router.state.pending[0]?.status).toBe('outcome_unknown');
      }
      host.setReviewStatus({ state: 'settled', receipt, rejectionCode: null });
      await host.router.read(refreshed.generation, () => true, (client) => client.review(refreshed, outcome.requestId));
      expect((await host.outcomes.load())[0]?.status).toBe('confirmed'); expect(host.effects().prompts).toBe(1);
    } finally { host.close(); }
  });
  it('rechecks permission confirmation document after durable recording and preserves its unsent original ID', async () => {
    const host = await fakeHost({ pauseFirstWrite: true });
    try {
      const scope = await host.scope(); await host.router.read(scope.generation, () => true, (client) => client.claim(scope));
      const challenge = await host.router.read(scope.generation, () => true, (client) => client.issuePermission(scope, 'full-access'));
      let trusted = true;
      const pending = host.router.confirmPermission(scope, () => trusted, challenge.challengeId);
      await host.firstWritten; const original = (await host.outcomes.load())[0]!;
      trusted = false; host.resumeWrite();
      await expect(pending).resolves.toEqual({ requestId: original.requestId, status: 'not-started', response: null });
      expect(original).toMatchObject({ method: 'permission.confirm', scope, permission: { challengeId: challenge.challengeId, controlGeneration: 2 } });
      expect(host.effects().grants).toBe(0); expect((await host.outcomes.load())[0]?.status).toBe('not-started');
    } finally { host.resumeWrite(); host.close(); }
  });
  it('rechecks captured document and selected target after durable pre-send recording, without executing or losing the original ID', async () => {
    const host = await fakeHost({ pauseFirstWrite: true });
    try {
      const scope = await host.scope(); await host.router.read(scope.generation, () => true, (client) => client.claim(scope));
      let trusted = true;
      const pending = host.router.mutate(scope, () => trusted, 'runtime.prompt', { text: 'Never send after navigation' });
      await host.firstWritten; const originalId = (await host.outcomes.load())[0]!.requestId;
      trusted = false; await host.router.select({ kind: 'local' }); host.resumeWrite();
      await expect(pending).resolves.toMatchObject({ requestId: originalId, status: 'not-started', response: null });
      expect(host.effects().prompts).toBe(0); expect(host.beforeSend).toEqual([]);
      expect((await host.outcomes.load())[0]).toMatchObject({ requestId: originalId, method: 'runtime.prompt', scope, status: 'not-started' });
      expect(host.router.state.kind).toBe('local');
    } finally { host.resumeWrite(); host.close(); }
  });
  it('remains mutation-blocked without a real recovery journal while scoped observations still work', async () => {
    const host = await fakeHost({ noJournal: true });
    try {
      const scope = await host.scope(); expect(host.router.state.outcomeStorage).toBe('blocked');
      await host.router.read(scope.generation, () => true, (client) => client.claim(scope));
      await expect(host.router.mutate(scope, () => true, 'runtime.prompt', { text: 'No journal, no effect' })).rejects.toThrow('STORAGE_UNAVAILABLE');
      expect(host.effects().prompts).toBe(0); expect(host.router.state.pending).toEqual([]);
    } finally { host.close(); }
  });
  it('does not continuously expire an assembled view and uses actual calibrated capture time', async () => {
    const host = await fakeHost({ clockOffset: 120_000, snapshotTtl: 40 });
    try {
      const scope = await host.scope(), capturedAt = host.router.state.lastConfirmedAt!;
      expect(capturedAt).toBeGreaterThan(Date.now() + 100_000);
      await new Promise((resolve) => setTimeout(resolve, 70));
      await expect(host.router.read(scope.generation, () => true, (client) => client.read(scope, 'goal.get', {}))).resolves.toMatchObject({ sessionId: scope.sessionId });
      expect(host.router.state.lastConfirmedAt).toBe(capturedAt);
    } finally { host.close(); }
  });
  it('preserves a lease across ordinary metadata, but notices actual control loss even after the header invalidates', async () => {
    const host = await fakeHost();
    try {
      const scope = await host.scope(); await host.router.read(scope.generation, () => true, (client) => client.claim(scope));
      host.emit('task.updated'); expect(host.router.state.controlGeneration).toBe(2); expect(host.router.state.scope?.sessionId).toBeNull();
      host.emit('control.changed'); expect(host.router.state.controlGeneration).toBeNull();
    } finally { host.close(); }
  });
  it('accepts its own control event before claim ACK and renews the actual main-owned generation', async () => {
    const host = await fakeHost({ controlBeforeAck: true });
    try {
      const scope = await host.scope();
      await expect(host.router.read(scope.generation, () => true, (client) => client.claim(scope))).resolves.toMatchObject({ generation: 2 });
      host.emitControl(2); expect(host.router.state.controlGeneration).toBe(2);
      await expect(host.router.read(scope.generation, () => true, (client) => client.leaseAction(scope, 'control.renew'))).resolves.toMatchObject({ generation: 2 });
      expect(host.requests.at(-1)).toMatchObject({ method: 'control.renew', input: { generation: 2 } });
      await host.router.read(scope.generation, () => true, (client) => client.leaseAction(scope, 'control.takeover'));
      expect(host.requests.at(-1)).toMatchObject({ method: 'control.takeover', input: {} }); expect(host.router.state.controlGeneration).toBe(2);
    } finally { host.close(); }
  });
  it.each(['control.claim', 'control.renew', 'control.takeover'] as const)('rejects a competing newer generation before delayed %s ACK', async (method) => {
    const host = await fakeHost({ pauseControl: method, controlBeforeAck: true });
    try {
      const scope = await host.scope();
      if (method !== 'control.claim') await host.router.read(scope.generation, () => true, (client) => client.claim(scope));
      const pending = host.router.read(scope.generation, () => true, (client) => client.leaseAction(scope, method));
      const refused = expect(pending).rejects.toThrow(); await host.controlEntered;
      host.emitControl(3); host.finishControl(); await refused;
      expect(host.router.state.controlGeneration).toBeNull();
      expect(host.requests.filter((request) => request.method === method)).toHaveLength(1);
    } finally { host.finishControl(); host.close(); }
  });
  it('does not install a delayed control lease after the captured initiating document changes', async () => {
    const host = await fakeHost({ pauseControl: 'control.claim' });
    try {
      const scope = await host.scope(); let trusted = true;
      const pending = host.router.read(scope.generation, () => trusted, (client) => client.claim(scope, () => trusted));
      const refused = expect(pending).rejects.toThrow(); await host.controlEntered;
      trusted = false; host.finishControl(); await refused; expect(host.router.state.controlGeneration).toBeNull();
      expect(host.requests.filter((request) => request.method === 'control.claim')).toHaveLength(1);
    } finally { host.finishControl(); host.close(); }
  });
  it('notifies lease expiry without claiming or renewing automatically', async () => {
    const host = await fakeHost({ leaseMs: 60 });
    try {
      const scope = await host.scope(); await host.router.read(scope.generation, () => true, (client) => client.claim(scope));
      const expired = new Promise<void>((resolve) => {
        const stop = host.router.subscribe((state) => { if (state.controlGeneration === null) { stop(); resolve(); } });
      });
      await expired; expect(host.router.state.controlGeneration).toBeNull();
      expect(host.requests.filter((request) => ['control.claim', 'control.renew', 'control.takeover'].includes(request.method))).toHaveLength(1);
    } finally { host.close(); }
  });
  it('rejects a late renewal ACK after the captured lease-expiry notification', async () => {
    const host = await fakeHost({ leaseMs: 80, pauseControl: 'control.renew' });
    try {
      const scope = await host.scope(); await host.router.read(scope.generation, () => true, (client) => client.claim(scope));
      const expired = new Promise<void>((resolve) => {
        const stop = host.router.subscribe((state) => { if (state.controlGeneration === null) { stop(); resolve(); } });
      });
      const pending = host.router.read(scope.generation, () => true, (client) => client.leaseAction(scope, 'control.renew'));
      const refused = expect(pending).rejects.toThrow(); await host.controlEntered; await expired;
      host.finishControl(); await refused; expect(host.router.state.controlGeneration).toBeNull();
      expect(host.requests.filter((request) => request.method === 'control.claim')).toHaveLength(1);
      expect(host.requests.filter((request) => request.method === 'control.renew')).toHaveLength(1);
    } finally { host.finishControl(); host.close(); }
  });
  it('refuses host changes during a pinned local handler and restores local only on explicit selection', async () => {
    const host = await fakeHost(); let release!: () => void;
    try {
      const pending = host.router.local(() => new Promise<void>((resolve) => { release = resolve; }));
      await expect(host.router.select({ kind: 'remote', profileId: host.profile.id })).rejects.toThrow(/pending local/i);
      release(); await pending; expect(host.router.isLocal).toBe(true);
    } finally { host.close(); }
    const persist = vi.fn(async () => undefined), router = new DesktopConnectionRouter(new ConnectionProfileStore(), {}, {
      initialSelection: { kind: 'remote', profileId: randomUUID() }, persistSelection: persist });
    try {
      const restore = vi.fn(); await expect(router.local(restore)).rejects.toThrow(); expect(restore).not.toHaveBeenCalled();
      expect(router.state).toMatchObject({ kind: 'remote', status: 'error', profile: null });
      await router.select({ kind: 'local' }); await router.local(restore); expect(persist).toHaveBeenCalledWith({ kind: 'local' }); expect(restore).toHaveBeenCalledOnce();
    } finally { router.close(); }
  });
  it('persists only validated original target/outcome metadata and loads interrupted sending as unknown', async () => {
    const root = await privateRoot(), selection = new ConnectionSelectionStore(path.join(root, 'target.json'));
    await selection.save({ kind: 'remote', profileId: randomUUID() }); expect((await selection.load()).kind).toBe('remote');
    const outcomes = new RemoteOutcomeStore(path.join(root, 'outcomes.json'));
    const record = pendingRemoteOutcomeSchema.parse({ scope: { generation: 9, profileId: randomUUID(), hostId, serverEpoch: epoch,
      workspaceId: workspace.workspaceId, workspaceGeneration: 3, sessionId: originalSessionId, selectionRevision: 4 },
      requestId: `${epoch}.1000.${randomUUID()}`, method: 'runtime.prompt', sessionId: originalSessionId, selectionRevision: 4, status: 'sending' });
    await outcomes.save([record]); expect((await outcomes.load())[0]).toMatchObject({ requestId: record.requestId, method: record.method, status: 'outcome_unknown', scope: record.scope });
    const serialized = await readFile(path.join(root, 'outcomes.json'), 'utf8');
    for (const secret of [credential, privateSentinel, 'ft1_', 'Synthetic prompt context']) expect(serialized).not.toContain(secret);
    expect(() => outcomes.save([{ ...record, text: 'Never store body' } as never])).toThrow();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function rendererSnapshot(scope: RemoteScope): RemoteSnapshot {
  const id = randomUUID();
  return { scope, items: [], header: { version: 1, snapshotId: id, capturedAt: 1000, expiresAt: 61000,
    workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration, serverEpoch: scope.serverEpoch,
    sessionId: scope.sessionId, ...(scope.selectionRevision !== null ? { selectionRevision: scope.selectionRevision } : {}),
    eventCursor: 0, eventStream: { serverEpoch: scope.serverEpoch, streamId: randomUUID(), workspaceId: scope.workspaceId,
      workspaceGeneration: scope.workspaceGeneration, sequence: 0 }, pageIds: [randomUUID()],
    controls: { status: 'ready', streaming: false, activeSessionRunning: false, runningSessionCount: 0, permissionLevel: 'edit',
      thinkingLevel: 'medium', model: null, pendingModel: null, pendingThinkingLevel: null, sessionOperation: false,
      queue: { steering: 0, followUp: 0, pending: 0, held: 0, recovered: 0 } }, goal: null, taskRevision: null, tasks: [], agents: [],
    omissions: { history: true, media: true, clippedItems: 0, agentRows: false, taskRows: false, goalText: false,
      taskText: false, agentText: false, queueContents: true }, warnings: [] } };
}
function rendererFixture() {
  const scope: RemoteScope = { generation: 4, profileId: randomUUID(), hostId, serverEpoch: epoch,
    workspaceId: workspace.workspaceId, workspaceGeneration: workspace.workspaceGeneration, sessionId: originalSessionId, selectionRevision: 4 };
  let state: DesktopConnectionState = { kind: 'remote', generation: 4, profile: { id: scope.profileId, hostId, label: 'Approved host' },
    serverEpoch: epoch, scope, hostName: 'Approved host', serverTime: 1000, takeoverAllowed: true, status: 'observing',
    capabilities: ['workspace.control', 'workspace.snapshot', 'permission.approve', 'runtime.prompt'], controlGeneration: null,
    permissionLevel: 'edit', lastConfirmedStatus: 'idle', lastConfirmedAt: 1000, pending: [], outcomeStorage: 'ready', message: 'ready' };
  let listener: ((value: DesktopConnectionState) => void) | null = null;
  const emit = (value: DesktopConnectionState) => { state = value; listener?.(value); };
  const unsubscribe = vi.fn(() => { listener = null; });
  // Only the named ports exercised here are injected; no renderer fetch or main authority fields.
  const bridge = {
    getConnectionState: vi.fn(async () => state),
    onConnectionState: vi.fn((value: (state: DesktopConnectionState) => void) => { listener = value; return unsubscribe; }),
    remoteReadSnapshot: vi.fn(async (_generation: number, target: typeof workspace) => {
      const binding = { ...scope, workspaceId: target.workspaceId, workspaceGeneration: target.workspaceGeneration };
      emit({ ...state, scope: binding }); return rendererSnapshot(binding);
    }),
    remoteListWorkspaces: vi.fn(async () => [workspace]),
    remoteClaimControl: vi.fn(async () => { emit({ ...state, status: 'controlling', controlGeneration: 7 }); return { generation: 7, expiresAt: 10000 }; }),
    remoteRenewControl: vi.fn(async () => ({ generation: 7, expiresAt: 20000 })),
    remoteTakeOverControl: vi.fn(async () => ({ generation: 7, expiresAt: 20000 })),
    remoteReleaseControl: vi.fn(async () => { emit({ ...state, status: 'observing', controlGeneration: null }); }),
    remoteIssuePermission: vi.fn(async () => ({ challengeId: randomUUID(), sessionId: originalSessionId,
      oldLevel: 'edit' as const, newLevel: 'full-access' as const, expiresAt: 10000 })),
    remoteConfirmPermission: vi.fn(async () => ({ requestId: `${epoch}.1000.${randomUUID()}`, status: 'outcome_unknown' as const, response: null })),
    remoteSendPrompt: vi.fn(async () => ({ requestId: `${epoch}.1000.${randomUUID()}`, status: 'outcome_unknown' as const, response: null })),
    connectConnection: vi.fn(async () => ({ ...state, generation: state.generation + 1 })),
    disconnectConnection: vi.fn(async () => ({ ...state, generation: state.generation + 1, status: 'disconnected' as const, scope: null })),
  } as unknown as DesktopConnectionApi;
  const api = new RemoteDesktopFateApi(bridge);
  return { api, bridge, scope, emit, unsubscribe, get state() { return state; } };
}

describe('T43 native remote facade revision and lifecycle fences', () => {
  it('keeps the first newer event when an old initialize read resolves later', async () => {
    const f = rendererFixture(), old = deferred<DesktopConnectionState>();
    vi.mocked(f.bridge.getConnectionState).mockReturnValueOnce(old.promise);
    const initializing = f.api.initialize(), newer = { ...f.state, generation: 5, scope: { ...f.scope, generation: 5 }, controlGeneration: 7 };
    f.emit(newer); old.resolve({ ...f.state, kind: 'local', generation: 0, profile: null, scope: null, serverEpoch: null, message: 'local' });
    await expect(initializing).resolves.toMatchObject({ kind: 'remote', generation: 5, controlGeneration: 7 });
    expect(f.api.hostId).toBe(hostId); expect(f.api.isConnected).toBe(true); f.api.close();
  });
  it('supersedes an older concurrent initialize even when its reply resolves first, then accepts the newer authoritative scope', async () => {
    const f = rendererFixture(); await f.api.initialize();
    const old = deferred<DesktopConnectionState>(), latest = deferred<DesktopConnectionState>();
    vi.mocked(f.bridge.getConnectionState).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const first = f.api.initialize(), second = f.api.initialize();
    old.resolve({ ...f.state, generation: 5, scope: { ...f.scope, generation: 5, selectionRevision: 5 } });
    await expect(first).resolves.toMatchObject({ generation: 4, scope: f.scope });
    const newerScope = { ...f.scope, generation: 6, sessionId: randomUUID(), selectionRevision: 9 };
    latest.resolve({ ...f.state, generation: 6, scope: newerScope, status: 'controlling', controlGeneration: 7 });
    await expect(second).resolves.toMatchObject({ generation: 6, scope: newerScope, controlGeneration: 7 });
    vi.mocked(f.bridge.remoteReadSnapshot).mockResolvedValueOnce(rendererSnapshot(newerScope));
    await f.api.readSnapshot(workspace); expect(f.api.control).toBe(7);
    expect(f.bridge.remoteReadSnapshot).toHaveBeenCalledWith(6, workspace); f.api.close();
  });
  it('fences an outstanding initialize as soon as disconnect starts, without requiring an intervening event', async () => {
    const f = rendererFixture(); await f.api.initialize();
    const old = deferred<DesktopConnectionState>(), disconnected = deferred<DesktopConnectionState>();
    vi.mocked(f.bridge.getConnectionState).mockReturnValueOnce(old.promise);
    vi.mocked(f.bridge.disconnectConnection).mockReturnValueOnce(disconnected.promise);
    const reading = f.api.initialize(), disconnecting = f.api.disconnect();
    old.resolve({ ...f.state, scope: { ...f.scope, selectionRevision: 5 }, controlGeneration: 7 });
    await expect(reading).resolves.toMatchObject({ generation: 4, scope: f.scope, controlGeneration: null });
    disconnected.resolve({ ...f.state, generation: 5, status: 'disconnected', scope: null, controlGeneration: null, message: 'disconnected' });
    await disconnecting; expect(f.api.isConnected).toBe(false); expect(f.api.hostId).toBe(hostId); f.api.close();
  });
  it('does not revive a closed lifecycle from a delayed initialize read', async () => {
    const f = rendererFixture(), old = deferred<DesktopConnectionState>();
    vi.mocked(f.bridge.getConnectionState).mockReturnValueOnce(old.promise);
    const initializing = f.api.initialize(), refused = expect(initializing).rejects.toThrow(/lifecycle/i);
    f.api.close(); old.resolve(f.state); await refused;
    expect(f.api.isConnected).toBe(false); expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
  it('ignores an old subscription callback after close, even if delivered after a new initialize', async () => {
    const f = rendererFixture(); await f.api.initialize();
    const oldListener = vi.mocked(f.bridge.onConnectionState).mock.calls[0]![0];
    f.api.close(); await f.api.initialize();
    oldListener({ ...f.state, generation: 99, kind: 'local', profile: null, scope: null, serverEpoch: null, message: 'local' });
    expect(f.api.isConnected).toBe(true); expect(f.api.hostId).toBe(hostId); f.api.close();
  });
  it('preserves the original unknown ID for a mutation resolving after close and reinitialize of the same binding', async () => {
    const f = rendererFixture(), reply = deferred<RemoteMutation>(); await f.api.initialize(); await f.api.readSnapshot(workspace);
    vi.mocked(f.bridge.remoteSendPrompt).mockReturnValueOnce(reply.promise);
    const requestId = `${epoch}.1000.${randomUUID()}`, pending = f.api.sendPrompt(workspace, 'Original draft');
    const refused = expect(pending).rejects.toMatchObject({ name: 'UnconfirmedCommand', requestId });
    f.api.close(); await f.api.initialize(); await f.api.readSnapshot(workspace);
    reply.resolve({ requestId, status: 'confirmed', response: responseEnvelopeSchema.parse({ protocol: 1, ok: true,
      requestId, serverEpoch: epoch, scope: { workspaceId: workspace.workspaceId, workspaceGeneration: 3 }, method: 'runtime.prompt',
      result: { kind: 'prompt', requestId, durability: 'journaled', outcome: 'accepted', sessionId: originalSessionId, runId: randomUUID(), viewRevision: 4 } }) });
    await refused; expect(f.bridge.remoteSendPrompt).toHaveBeenCalledOnce(); f.api.close();
  });
  it.each(['connect', 'disconnect'] as const)('never overwrites an intervening same-generation event with a delayed %s reply', async (action) => {
    const f = rendererFixture(), reply = deferred<DesktopConnectionState>(); await f.api.initialize();
    vi.mocked(action === 'connect' ? f.bridge.connectConnection : f.bridge.disconnectConnection).mockReturnValueOnce(reply.promise);
    const pending = f.api[action](); f.emit({ ...f.state, status: 'disconnected', scope: null, message: 'disconnected' });
    reply.resolve({ ...f.state, generation: 5, scope: { ...f.scope, generation: 5 }, status: 'observing', message: 'ready' });
    await pending; expect(f.api.isConnected).toBe(false); expect(f.api.hostId).toBe(hostId); f.api.close();
  });
  it.each(['workspace', 'session-ABA'] as const)('rejects the older delayed snapshot after newer same-host %s selection', async (change) => {
    const f = rendererFixture(), first = deferred<RemoteSnapshot>(), second = deferred<RemoteSnapshot>(); await f.api.initialize();
    vi.mocked(f.bridge.remoteReadSnapshot).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const old = f.api.readSnapshot(workspace), refused = expect(old).rejects.toThrow(/changed/i);
    const nextWorkspace = change === 'workspace' ? { ...workspace, workspaceId: randomUUID(), label: 'Other workspace' } : workspace;
    const nextScope = { ...f.scope, workspaceId: nextWorkspace.workspaceId,
      selectionRevision: change === 'session-ABA' ? f.scope.selectionRevision! + 2 : f.scope.selectionRevision };
    const newer = f.api.readSnapshot(nextWorkspace); f.emit({ ...f.state, scope: nextScope }); second.resolve(rendererSnapshot(nextScope)); await newer;
    first.resolve(rendererSnapshot(f.scope)); await refused;
    expect(f.api.workspace).toEqual(nextWorkspace);
    await expect(f.api.claimControl(nextWorkspace)).resolves.toMatchObject({ generation: 7 });
    expect(f.bridge.remoteClaimControl).toHaveBeenCalledWith(nextScope); f.api.close();
  });
  it('fences a delayed snapshot invalidated by metadata even while its own read is assembling', async () => {
    const f = rendererFixture(), snapshot = deferred<RemoteSnapshot>(); await f.api.initialize();
    vi.mocked(f.bridge.remoteReadSnapshot).mockReturnValueOnce(snapshot.promise);
    const pending = f.api.readSnapshot(workspace), refused = expect(pending).rejects.toThrow(/changed/i);
    f.emit({ ...f.state, scope: { ...f.scope, sessionId: null, selectionRevision: null }, message: 'refresh-required' });
    snapshot.resolve(rendererSnapshot(f.scope)); await refused; expect(f.api.workspace).toBeNull(); f.api.close();
  });
  it('accepts affirmative control results across their own authority notifications and uses all four named bridges', async () => {
    const f = rendererFixture(); await f.api.initialize(); await f.api.readSnapshot(workspace);
    const listener = vi.fn(), stop = f.api.onInvalidate(listener);
    await expect(f.api.claimControl(workspace)).resolves.toMatchObject({ generation: 7 }); expect(listener).toHaveBeenCalled();
    await f.api.renewControl(workspace); await f.api.takeOverControl(workspace);
    expect(f.bridge.remoteRenewControl).toHaveBeenCalledWith(f.scope); expect(f.bridge.remoteTakeOverControl).toHaveBeenCalledWith(f.scope);
    const challenge = await f.api.requestPermissionApproval(workspace, { sessionId: originalSessionId, action: 'runtime.setPermission', oldLevel: 'edit', newLevel: 'full-access' });
    await expect(f.api.respondPermissionApproval(workspace, { sessionId: originalSessionId, action: 'runtime.setPermission',
      oldLevel: 'edit', newLevel: 'full-access', challengeId: challenge.challengeId })).rejects.toMatchObject({ name: 'UnconfirmedCommand' });
    expect(f.bridge.remoteIssuePermission).toHaveBeenCalledWith(f.scope, 'full-access');
    expect(f.bridge.remoteConfirmPermission).toHaveBeenCalledWith(f.scope, challenge.challengeId);
    await f.api.releaseControl(workspace); expect(f.api.control).toBeNull(); stop(); f.api.close();
  });
  it('does not move calibrated host time backwards on a delayed same-epoch state update', async () => {
    const f = rendererFixture(); await f.api.initialize(); const before = f.api.estimatedHostTime;
    f.emit({ ...f.state, serverTime: 900 }); expect(f.api.estimatedHostTime).toBeGreaterThanOrEqual(before); f.api.close();
  });
  it('keeps original pending method/session/scope through a current-session mismatch and cannot dismiss unknown status', async () => {
    const f = rendererFixture(), requestId = `${epoch}.1000.${randomUUID()}`;
    f.emit({ ...f.state, pending: [{ scope: f.scope, requestId, method: 'permission.confirm', sessionId: originalSessionId,
      selectionRevision: 4, status: 'outcome_unknown', permission: { oldLevel: 'edit', newLevel: 'full-access',
        challengeId: randomUUID(), controlGeneration: 7, observed: null } }] });
    await f.api.initialize();
    const pending = f.api.pendingPromptReview(workspace, randomUUID());
    expect(pending).toMatchObject({ kind: 'blocked', reason: 'mismatch', value: { requestId, method: 'permission.confirm',
      sessionId: originalSessionId, hostId, serverEpoch: epoch, workspaceId: workspace.workspaceId, workspaceGeneration: 3 } });
    f.api.clearPendingPromptReview(); expect(f.api.pendingPromptReview(workspace, originalSessionId)).toMatchObject({ kind: 'match', value: { requestId } });
    f.api.close();
  });
});
