import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CommandJournal } from '../../../src/core/commands/CommandJournal';
import type { RequestContext } from '../../../src/core/dispatch/RequestContext';
import { ScopedDomainEvents } from '../../../src/core/events/ScopedDomainEvents';
import { WorkspaceEventHub } from '../../../src/core/events/WorkspaceEventHub';
import type { FateCore } from '../../../src/core/FateCore';
import { WorkspaceAdmissionQueue } from '../../../src/core/workspaces/WorkspaceAdmissionQueue';
import type { WorkspaceHandle } from '../../../src/core/workspaces/WorkspaceHandle';
import { CoreIpcAdapter } from '../../../src/main/ipc/CoreIpcAdapter';
import type { PermissionLevel, PromptAcceptance, RuntimeState } from '../../../src/shared/contracts/ipc';
import type { MonitorDashboard } from '../../../src/shared/contracts/monitorDashboard';
import type { FailureResponse, ProtocolResponse } from '../../../src/shared/protocol/envelopes';
import { createMutationIdentity } from '../../../src/shared/protocol/requestIds';
import type { AuthService, ClientPrincipal } from '../../../src/server/auth/AuthService';
import { ClientTickets } from '../../../src/server/auth/ClientTickets';
import { createNetworkDispatcher } from '../../../src/server/http/NetworkDispatcher';
import { privateTestRoot } from './isolatedEnvironment';
import {
  parityIds, parityMonitorResult, parityPrivateDetail, paritySentinels, parityTime,
  type ParityCase, type ParityMethod, type ParityTransport,
} from '../fixtures/commonAdapterParityCases';

export interface ParityCall {
  method: ParityMethod;
  workspaceId: string;
  sessionId: string;
  input: object;
}
export type ParityInvocation =
  | { ok: true; value: unknown; request?: Record<string, unknown>; response?: ProtocolResponse }
  | { ok: false; error: unknown; request?: Record<string, unknown>; response?: FailureResponse };

/** Production transport/dispatcher/tickets/control/journal/queue; ONLY the captured
 * runtime, registry and pre-authenticated principal source are deterministic ports.
 * No adapter, dispatcher, handler, ticket verification or journal result is mocked.
 * This is an HTTP COMMAND-ROUTE fixture, not a loopback listener/WebSocket/Electron E2E. */
export async function createCommonAdapterParityHarness(mode: ParityTransport, testCase: Partial<Pick<ParityCase, 'setup' | 'method'>> = {}) {
  const scratch = await mkdtemp(path.join(privateTestRoot(), 'common-adapter-parity-'));
  const root = path.join(scratch, 'workspace-a');
  const otherRoot = path.join(scratch, 'workspace-b');
  let events: WorkspaceEventHub | undefined;
  let tickets: ClientTickets | undefined;
  try {
    await mkdir(root, { mode: 0o700 });
    await mkdir(otherRoot, { mode: 0o700 });
    await writeFile(path.join(root, 'sentinel.txt'), paritySentinels.a);
    await writeFile(path.join(otherRoot, 'sentinel.txt'), paritySentinels.b);
    const setup = testCase.setup ?? 'normal';
    let trustedSender = true, documentCurrent = true, member = true, projectTrusted = true;
    let selected: string = parityIds.session;
    let hostRevision = 0;
    let generation = 3;
    let permissionLevel: PermissionLevel = 'edit';
    let permissionHealthy = true;
    let running = setup !== 'abort-idle';
    let afterEffect: (() => void) | undefined;
    const calls: ParityCall[] = [];
    const effects: ParityCall[] = [];
    const nativeFailure = new Error(parityPrivateDetail);
    const record = (method: ParityMethod, input: object): ParityCall => {
      const call = { method, workspaceId: parityIds.workspace, sessionId: selected, input: { ...input } };
      calls.push(call);
      return call;
    };
    const getState = (): RuntimeState => ({
      status: 'ready', project: { path: root, name: 'Synthetic parity A', trusted: projectTrusted },
      sessionId: selected, sessionFile: null, streaming: false, activeSessionRunning: running,
      model: null, models: [], thinkingLevel: 'off', permissionLevel, messages: [],
      error: null, eventCursor: effects.length, sessionOperation: false,
      sessions: [parityIds.session, parityIds.nextSession].map((id) => ({
        id, title: 'Synthetic parity session', firstMessage: '', path: path.join(root, `${id}.jsonl`),
        createdAt: '2026-01-01T00:00:00.000Z', modifiedAt: '2026-01-01T00:00:00.000Z',
        messageCount: 0, active: id === selected,
      })),
    });
    const observe = (id: string) => {
      if (selected !== id) { selected = id; hostRevision++; }
      admission.observeSelection(id);
    };
    const runtime = {
      getState,
      prompt: async (...args: Parameters<WorkspaceHandle['runtime']['prompt']>): Promise<PromptAcceptance> => {
        const [input, , , , assertAdmission] = args;
        const call = record('runtime.prompt', input);
        // Network preparation supplies its real SDK-seam recheck. Do not replace it
        // with a test callback that simply grants admission.
        if (mode === 'http' && !assertAdmission) throw new Error('Missing production network runtime admission fence');
        assertAdmission?.();
        if (setup === 'prompt-declined') return { accepted: false, runId: parityIds.run };
        await writeFile(path.join(root, 'sentinel.txt'), `applied:${input.text}\n`);
        effects.push(call);
        running = true;
        afterEffect?.();
        // Deliberate malformed domain-port outputs: the REAL adapters must reject
        // them after the observable write; no fake successful response is supplied.
        if (setup === 'invalid-prompt-result') return { accepted: 'invalid', runId: parityIds.run } as unknown as PromptAcceptance;
        return { accepted: true, runId: setup === 'oversized-prompt-result' ? parityPrivateDetail.repeat(200) : parityIds.run };
      },
      abort: async () => {
        const call = record('runtime.abort', {});
        if (setup === 'abort-throws') throw nativeFailure;
        const aborted = running;
        if (aborted) { running = false; effects.push(call); afterEffect?.(); }
        return { aborted };
      },
      switchSession: async (id: string) => {
        const call = record('session.select', { sessionId: id });
        if (id !== parityIds.session && id !== parityIds.nextSession) throw new Error('Unknown synthetic session');
        observe(id);
        effects.push(call);
        afterEffect?.();
        return getState();
      },
      getMonitorDashboard: async (...args: Parameters<WorkspaceHandle['runtime']['getMonitorDashboard']>): Promise<MonitorDashboard> => {
        if (args.length !== 1) throw new Error('Named Monitor must not require an agent-tool live root slot');
        record('workspace.monitor', args[0] ?? {});
        const result: MonitorDashboard = {
          ...parityMonitorResult, overall: 'unknown', section: 'tasks',
          sources: { runs: 'partial', teams: 'unknown', tasks: 'ready', activity: 'unknown' },
          projectPath: root, sessionId: selected, revision: 'synthetic-page-revision',
          items: [{ id: 'private-task-id', source: 'tasks', state: 'attention', title: parityPrivateDetail,
            detail: `${root}: ${parityPrivateDetail}`, updatedAt: parityTime, ref: { kind: 'task', id: 'private-task-id' } }],
        };
        if (setup === 'monitor-selection-race') observe(parityIds.nextSession);
        if (setup === 'monitor-generation-race') replaceGeneration();
        if (setup === 'invalid-monitor-result') return { ...result, counts: { ...result.counts, tasks: -1 } };
        return result;
      },
    } satisfies Pick<WorkspaceHandle['runtime'], 'getState' | 'prompt' | 'abort' | 'switchSession' | 'getMonitorDashboard'>;
    let admission = new WorkspaceAdmissionQueue(runtime, generation);
    const makeHandle = () => ({ id: parityIds.workspace, generation, root, runtime,
      files: { getRoot: () => root }, admission }) as unknown as WorkspaceHandle;
    let handle = makeHandle();
    function replaceGeneration() {
      generation++;
      admission = new WorkspaceAdmissionQueue(runtime, generation);
      handle = makeHandle();
    }
    let captureChanged = false;
    const changeAfterCapture = () => {
      if (captureChanged) return;
      captureChanged = true;
      if (setup === 'changed-generation') replaceGeneration();
      if (setup === 'changed-selection' || setup === 'selection-aba') observe(parityIds.nextSession);
      if (setup === 'selection-aba') observe(parityIds.session);
    };
    events = new WorkspaceEventHub(new ScopedDomainEvents(), parityIds.epoch);
    // The HTTP server is the authority for this already-authenticated synthetic
    // principal. Test JSON never supplies it. Auth-store, Host/Origin and cookie/CSRF
    // integration are intentionally left to the existing network suites.
    const principal: ClientPrincipal = { kind: 'client', principalId: parityIds.principal, clientId: parityIds.principal,
      workspaceRoots: [root], expiresAt: parityTime + 60_000 };
    const revocationsOnly = { subscribeRevocations: () => () => undefined } as unknown as AuthService;
    tickets = new ClientTickets(revocationsOnly, () => parityTime);
    const liveTickets = tickets;
    let connectionId: string = parityIds.connection;
    let ticket = liveTickets.issue(principal, connectionId, parityIds.epoch, null);
    const registry = {
      registerHostPath: async (requestedRoot: string) => {
        if (requestedRoot !== root) throw new Error('Not a host registration');
        const captured = handle;
        changeAfterCapture();
        return captured;
      },
      resolve: (identity: RequestContext, id: string, expectedGeneration: number) => {
        if (!member || id !== parityIds.workspace || expectedGeneration !== generation
          || identity.adapter === 'authenticated-server' && !liveTickets.isMember(identity, root)) throw new Error('No membership');
        return handle;
      },
    };
    const owner = {
      asRouter: () => runtime,
      workspaceOrigin: (requestedRoot: string) => requestedRoot === root ? { workspaceId: parityIds.workspace, workspaceGeneration: generation } : null,
      workspaceSelectionRevision: (requestedRoot: string) => requestedRoot === root ? hostRevision : null,
      peekWorkspace: (requestedRoot: string) => requestedRoot === root ? runtime : null,
    };
    // Only the narrow domain ports are synthetic; the adapters and their gates are not.
    const ipc = new CoreIpcAdapter(owner as unknown as ConstructorParameters<typeof CoreIpcAdapter>[0], registry, () => trustedSender)
      .forInvocation(() => documentCurrent);
    const journal = new CommandJournal({ root: path.join(scratch, 'command-journal'), serverEpoch: parityIds.epoch, now: () => parityTime });
    const core = { events, workspaces: registry, runtime: owner, sessionPermissions: { assertHealthy: () => {
      if (!permissionHealthy) throw new Error('Synthetic permission store unavailable');
    } } } as unknown as FateCore;
    const network = createNetworkDispatcher({ core, tickets: liveTickets, journal, serverEpoch: parityIds.epoch,
      registeredRoots: [root], hostId: parityIds.principal, appVersion: '1.1.0', now: () => parityTime });
    let controlGeneration = 1;
    const readEnvelope = (method: string, input: object) => ({ protocol: 1, requestId: randomUUID(),
      serverEpoch: parityIds.epoch, issuedAt: parityTime, method, input,
      workspaceId: parityIds.workspace, workspaceGeneration: generation });
    const envelope = (method: ParityMethod, input: object): Record<string, unknown> => ({
      ...readEnvelope(method, input), ...(method === 'workspace.monitor' ? {} : createMutationIdentity(parityIds.epoch, parityTime)),
      expectedSessionId: selected, selectionRevision: admission.snapshot().selectionRevision,
      ...(method === 'workspace.monitor' ? {} : { controlGeneration }),
    });
    const send = (value: unknown, suppliedTicket = ticket, suppliedPrincipal = principal, origin: string | null = null) =>
      network.onCommand(JSON.stringify(value), suppliedPrincipal, suppliedTicket, origin);
    const claim = async () => {
      const response = await send(readEnvelope('control.claim', {}));
      if (!response.ok || response.method !== 'control.claim') throw new Error('Production control claim failed');
      controlGeneration = response.result.generation;
      return response;
    };
    // Shared Monitor rows deliberately remain network observers: reading must not
    // require a control lease or silently acquire one as part of the test setup.
    if (mode === 'http' && setup !== 'no-authority' && testCase.method !== 'workspace.monitor') await claim();
    // Arrange refusals only after the normal, explicit server-owned control setup.
    if (setup === 'untrusted-project') projectTrusted = false;
    if (setup === 'no-authority') trustedSender = false;
    if (setup === 'no-membership') member = false;
    if (setup === 'revoked-invocation') { documentCurrent = false; liveTickets.revokeConnection(connectionId); }
    const invoke = async (method: ParityMethod, input: object): Promise<ParityInvocation> => {
      if (mode === 'ipc') {
        try {
          const value = method === 'runtime.prompt' ? await ipc.prompt(input)
            : method === 'runtime.abort' ? await ipc.abort(input)
              : method === 'session.select' ? await ipc.select(input) : await ipc.monitor(input);
          return { ok: true, value };
        } catch (error) { return { ok: false, error }; }
      }
      const request = envelope(method, input);
      changeAfterCapture();
      try {
        const response = await send(request);
        return response.ok ? { ok: true, value: response.result, response, request }
          : { ok: false, error: response.error, response, request };
      } catch (error) { return { ok: false, error, request }; }
    };
    return {
      mode, root, otherRoot, journal, principal, network, nativeFailure, invoke, send, envelope, readEnvelope, claim,
      calls, effects,
      selection: () => admission.snapshot(),
      ticket: () => ticket,
      afterEffect: (hook: () => void) => { afterEffect = hook; },
      setPermission: (level: PermissionLevel) => { permissionLevel = level; },
      blockPermissionStore: () => { permissionHealthy = false; },
      disconnect: () => { liveTickets.revokeConnection(connectionId); network.onDisconnect(connectionId); },
      reconnect: () => {
        connectionId = randomUUID();
        ticket = liveTickets.issue(principal, connectionId, parityIds.epoch, null);
      },
      snapshot: async () => ({
        a: await readFile(path.join(root, 'sentinel.txt'), 'utf8'),
        b: await readFile(path.join(otherRoot, 'sentinel.txt'), 'utf8'),
        running, workspaceGeneration: generation, ...admission.snapshot(), calls: [...calls], effects: [...effects],
      }),
      dispose: async () => {
        await admission.settled();
        network.onDisconnect(connectionId);
        liveTickets.close();
        events!.dispose();
        await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
      },
    };
  } catch (error) {
    tickets?.close();
    events?.dispose();
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  }
}
export type CommonAdapterParityHarness = Awaited<ReturnType<typeof createCommonAdapterParityHarness>>;
