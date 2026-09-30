import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { Dispatcher, productionNetworkDispatchEnabled, type AdmissionFence, type DispatchResolvers, type HandlerMap, type WorkspaceBinding } from '../../src/core/dispatch/Dispatcher';
import { createAuthenticatedServerContext, createLocalIpcContext, isAdapterCreatedContext, type RequestContext } from '../../src/core/dispatch/RequestContext';
import { responseEnvelopeSchema, type ProtocolResponse } from '../../src/shared/protocol/envelopes';
import { ProtocolFault, type ErrorCode } from '../../src/shared/protocol/errors';
import { createMutationIdentity, MAX_REQUEST_AGE_MS } from '../../src/shared/protocol/requestIds';

const epoch = '10000000-0000-4000-8000-000000000001';
const workspaceId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000003';
const otherId = '40000000-0000-4000-8000-000000000004';
const fileId = '50000000-0000-4000-8000-000000000005';
const clientId = '60000000-0000-4000-8000-000000000006';
const principalId = '70000000-0000-4000-8000-000000000007';
const now = 1_800_000_000_000;
const identity = () => createLocalIpcContext({ clientId, principalId, expiresAt: now + 48 * 60 * 60 * 1000 });
const readRequest = (method = 'host.info', input = {}) => ({ protocol: 1, requestId: otherId, serverEpoch: epoch, issuedAt: now, method, input });
const fileRequest = () => ({ ...readRequest('file.list', { directoryId: null, limit: 10 }), workspaceId, workspaceGeneration: 3 });
const previewRequest = (maxBytes = 1000) => ({ ...readRequest('file.previewText', { fileId, maxBytes }), workspaceId, workspaceGeneration: 3 });
const mutationRequest = (method = 'runtime.prompt', input = { text: 'Synthetic fixture only.' }) => ({
  protocol: 1, ...createMutationIdentity(epoch, now), method, workspaceId, workspaceGeneration: 3,
  expectedSessionId: sessionId, selectionRevision: 8, controlGeneration: 5, input,
});
const abortRequest = () => ({ ...mutationRequest(), method: 'runtime.abort', input: {} });
const selectRequest = () => ({ ...mutationRequest(), method: 'session.select', input: { sessionId: otherId } });
function assertFailure(result: ProtocolResponse, code: ErrorCode, execution = 'not-started') {
  expect(result).toMatchObject({ ok: false, error: { code }, execution });
  expect(responseEnvelopeSchema.safeParse(result).success).toBe(true);
}
function fixture() {
  const context = identity();
  const workspaceHandle = {};
  const sessionHandle = {};
  const resourceHandle = {};
  const workspace: WorkspaceBinding = { workspaceId, generation: 3, selectedSessionId: sessionId, selectionRevision: 8, handle: workspaceHandle };
  const state = { authenticated: true, member: true, capable: true, control: true, permitted: true,
    workspaceExists: true, sessionExists: true, resourceExists: true, now, workspace };
  const handlers = {
    'host.info': vi.fn<HandlerMap['host.info']>((_input, ctx) => ({ hostId: principalId, protocol: 1, serverEpoch: ctx.serverEpoch,
      serverTime: ctx.serverTime, appVersion: '2.0.0-preparation', capabilities: ['host.info'], networkDispatchEnabled: false })),
    'workspace.list': vi.fn<HandlerMap['workspace.list']>(() => ({ workspaces: [{ workspaceId, workspaceGeneration: 3, label: 'Fixture' }] })),
    'file.list': vi.fn<HandlerMap['file.list']>((input) => ({ directoryId: input.directoryId, entries: [{ resourceId: fileId, name: 'fixture.txt', kind: 'file' }], truncated: false })),
    'file.previewText': vi.fn<HandlerMap['file.previewText']>(() => ({ fileId, content: 'Synthetic text.', truncated: false })),
    'runtime.prompt': vi.fn<HandlerMap['runtime.prompt']>(() => ({ accepted: true, runId: otherId, sessionId, viewRevision: 9 })),
    'runtime.abort': vi.fn<HandlerMap['runtime.abort']>(() => ({ aborted: true, sessionId, viewRevision: 9 })),
    'session.select': vi.fn<HandlerMap['session.select']>((input) => ({ sessionId: input.sessionId, selectionRevision: 9, viewRevision: 10 })),
  } satisfies HandlerMap;
  const resolvers: DispatchResolvers = {
    authenticate: () => state.authenticated,
    isMember: (_ctx, id) => state.member && id === workspaceId,
    workspace: (_ctx, id) => state.workspaceExists && id === workspaceId ? state.workspace : null,
    hasCapability: () => state.capable,
    hasControl: (_ctx, _ws, generation) => state.control && generation === 5,
    hasPermission: () => state.permitted,
    session: (_ctx, ws, id) => state.sessionExists ? { sessionId: id, workspaceId: ws.workspaceId, workspaceGeneration: ws.generation, handle: sessionHandle } : null,
    resource: (_ctx, ws, id, kind) => state.resourceExists ? { resourceId: id, kind, workspaceId: ws.workspaceId, workspaceGeneration: ws.generation, handle: resourceHandle } : null,
  };
  const release = vi.fn();
  const enter = vi.fn<AdmissionFence['enter']>(async () => ({ release }));
  const options = { serverEpoch: epoch, handlers, resolvers, admissionFence: { enter }, now: () => state.now };
  const dispatcher = new Dispatcher(options);
  const dispatch = (request: unknown, ctx = context) => dispatcher.dispatchJson(JSON.stringify(request), ctx);
  return { state, handlers, resolvers, options, dispatcher, dispatch, context, enter, release, workspaceHandle, sessionHandle, resourceHandle };
}
function expectNoHandler(f: ReturnType<typeof fixture>) {
  for (const handler of Object.values(f.handlers)) expect(handler).not.toHaveBeenCalled();
}
function barrier() {
  let release: () => void = () => { throw new Error('uninitialized barrier'); };
  const pending = new Promise<void>((resolve) => { release = resolve; });
  return { pending, release };
}

describe('authorized dispatcher preparation', () => {
  it('denies by default even with a valid adapter-created context', async () => {
    const f = fixture();
    const dispatcher = new Dispatcher({ serverEpoch: epoch, handlers: f.handlers, now: () => now });
    assertFailure(await dispatcher.dispatchJson(JSON.stringify(readRequest()), f.context), 'UNAUTHENTICATED');
    expectNoHandler(f);
  });

  it('authenticates separately from immutable context constructors, rejecting JSON/copies', async () => {
    const f = fixture();
    expect(Object.isFrozen(f.context)).toBe(true);
    expect(isAdapterCreatedContext(f.context)).toBe(true);
    expect(isAdapterCreatedContext(JSON.parse(JSON.stringify(f.context)))).toBe(false);
    expect(isAdapterCreatedContext({ ...f.context })).toBe(false);
    // Simulate an untyped adapter violating the TS boundary. The runtime identity check must still reject it.
    const response: ProtocolResponse = await Reflect.apply(f.dispatcher.dispatchJson, f.dispatcher, [JSON.stringify(readRequest()), { ...f.context }]);
    assertFailure(response, 'UNAUTHENTICATED');
    f.state.authenticated = false;
    assertFailure(await f.dispatch(readRequest()), 'UNAUTHENTICATED');
    expectNoHandler(f);
    expectTypeOf<DispatchResolvers['authenticate']>().returns.toEqualTypeOf<boolean>();
    expectTypeOf<DispatchResolvers['workspace']>().returns.toEqualTypeOf<WorkspaceBinding | null>();
  });

  it('validates adapter identities at runtime without accepting authority fields', () => {
    const claims = { principalId, clientId, expiresAt: now + 10 };
    expect(() => createLocalIpcContext({ ...claims, principalId: '/host/path' })).toThrow();
    expect(() => createLocalIpcContext({ ...claims, expiresAt: Number.NaN })).toThrow();
    expect(() => Reflect.apply(createLocalIpcContext, undefined, [{ ...claims, role: 'owner' }])).toThrow();
    expect(() => createAuthenticatedServerContext(claims, 'not-an-origin')).toThrow();
  });

  it('keeps generic dispatcher network access off unless the trusted composition opts in', async () => {
    const f = fixture();
    expect(productionNetworkDispatchEnabled).toBe(true);
    for (const origin of [null, 'http://127.0.0.1:5173']) {
      const server = createAuthenticatedServerContext({ principalId, clientId, expiresAt: now + 1000 }, origin);
      for (const request of [readRequest(), fileRequest(), mutationRequest(), abortRequest(), selectRequest()]) {
        assertFailure(await f.dispatch(request, server), 'DISPATCH_DISABLED');
      }
    }
    expectNoHandler(f);
    expect(f.enter).not.toHaveBeenCalled();
  });

  it.each(['principalId', 'clientId', 'role', 'ownerId', 'permission', 'workspacePath', 'path', 'capability'])('rejects forged %s before any handler or fence', async (field) => {
    const f = fixture();
    for (const request of [{ ...mutationRequest(), [field]: 'forged' }, { ...mutationRequest(), input: { text: 'x', [field]: 'forged' } }]) {
      assertFailure(await f.dispatch(request), 'INVALID_REQUEST');
    }
    expectNoHandler(f);
    expect(f.enter).not.toHaveBeenCalled();
  });

  it.each(['constructor', '__proto__', 'runtime.getState', 'setPermissionLevel'])('cannot fall through to service property %s', async (method) => {
    const f = fixture();
    assertFailure(await f.dispatch(readRequest(method)), 'INVALID_REQUEST');
    expectNoHandler(f);
  });

  it.each([
    ['authenticated', 'UNAUTHENTICATED'], ['member', 'FORBIDDEN'], ['capable', 'UNSUPPORTED_CAPABILITY'],
    ['control', 'CONTROL_REQUIRED'], ['permitted', 'PERMISSION_REQUIRED'], ['workspaceExists', 'UNKNOWN_WORKSPACE'],
    ['sessionExists', 'STALE_SESSION'],
  ] as const)('denies %s without invoking mutations', async (key, code) => {
    const f = fixture();
    f.state[key] = false;
    assertFailure(await f.dispatch(mutationRequest()), code);
    expectNoHandler(f);
    expect(f.enter).not.toHaveBeenCalled();
  });

  it('fails closed when each resolver is independently omitted', async () => {
    const f = fixture();
    const cases = [
      ['authenticate', 'UNAUTHENTICATED'], ['isMember', 'FORBIDDEN'], ['workspace', 'UNKNOWN_WORKSPACE'],
      ['hasCapability', 'UNSUPPORTED_CAPABILITY'], ['hasControl', 'CONTROL_REQUIRED'], ['hasPermission', 'PERMISSION_REQUIRED'],
      ['session', 'STALE_SESSION'], ['resource', 'FORBIDDEN'],
    ] as const;
    for (const [name, code] of cases) {
      const { [name]: omitted, ...resolvers } = f.resolvers;
      expect(omitted).toBeDefined();
      const dispatcher = new Dispatcher({ ...f.options, resolvers });
      assertFailure(await dispatcher.dispatchJson(JSON.stringify(name === 'resource' ? fileRequest() : mutationRequest()), f.context), code);
    }
    expectNoHandler(f);
  });

  it.each(['generation', 'revision', 'selection', 'identity', 'handle'] as const)('rejects malformed trusted workspace %s data at runtime', async (invalid) => {
    const f = fixture();
    if (invalid === 'generation') f.state.workspace = { ...f.state.workspace, generation: Number.NaN };
    if (invalid === 'revision') f.state.workspace = { ...f.state.workspace, selectionRevision: -1 };
    if (invalid === 'selection') f.state.workspace = { ...f.state.workspace, selectedSessionId: '/private/session/path' };
    if (invalid === 'identity') f.state.workspace = { ...f.state.workspace, workspaceId: otherId };
    if (invalid === 'handle') Reflect.deleteProperty(f.state.workspace, 'handle');
    assertFailure(await f.dispatch(mutationRequest()), 'INTERNAL_ERROR');
    expectNoHandler(f);
  });

  it('does not treat a JavaScript resolver Promise or other truthy value as authority', async () => {
    const f = fixture();
    const dispatcher: Dispatcher = Reflect.construct(Dispatcher, [{ ...f.options, resolvers: { ...f.resolvers, hasControl: () => Promise.resolve(true) } }]);
    assertFailure(await dispatcher.dispatchJson(JSON.stringify(mutationRequest()), f.context), 'CONTROL_REQUIRED');
    expectNoHandler(f);
  });

  it('keeps read/control/permission policies distinct and binds the actual workspace/resource handle', async () => {
    const f = fixture();
    f.state.control = false;
    expect(await f.dispatch(fileRequest())).toMatchObject({ ok: true, scope: { workspaceId, workspaceGeneration: 3 } });
    expect(await f.dispatch(previewRequest())).toMatchObject({ ok: true });
    expect(f.handlers['file.list'].mock.calls[0]?.[1]).toMatchObject({ kind: 'resource', workspace: { handle: f.workspaceHandle }, resource: { handle: f.resourceHandle } });
    expect(f.enter).not.toHaveBeenCalled();
    assertFailure(await f.dispatch(mutationRequest()), 'CONTROL_REQUIRED');
    f.state.permitted = false;
    assertFailure(await f.dispatch(fileRequest()), 'PERMISSION_REQUIRED');
  });

  it('does not disclose an unauthorized workspace from workspace.list', async () => {
    const f = fixture();
    f.handlers['workspace.list'].mockReturnValue({ workspaces: [{ workspaceId: otherId, workspaceGeneration: 1, label: 'Private-fixture-name' }] });
    const result = await f.dispatch(readRequest('workspace.list'));
    assertFailure(result, 'FORBIDDEN');
    expect(JSON.stringify(result)).not.toContain('Private-fixture-name');
  });

  it('rejects guessed or revoked resource IDs without reading a file', async () => {
    const f = fixture();
    f.state.resourceExists = false;
    assertFailure(await f.dispatch(previewRequest()), 'FORBIDDEN');
    assertFailure(await f.dispatch(fileRequest()), 'FORBIDDEN');
    expectNoHandler(f);
  });

  it('requires workspace generation for reads and current selection/control generations for mutations', async () => {
    const f = fixture();
    assertFailure(await f.dispatch({ ...fileRequest(), workspaceGeneration: 2 }), 'STALE_WORKSPACE');
    assertFailure(await f.dispatch({ ...mutationRequest(), expectedSessionId: otherId }), 'STALE_SESSION');
    assertFailure(await f.dispatch({ ...mutationRequest(), selectionRevision: 7 }), 'STALE_SESSION');
    assertFailure(await f.dispatch({ ...mutationRequest(), controlGeneration: 4 }), 'CONTROL_REQUIRED');
    expectNoHandler(f);
  });

  it('rejects cross-workspace or replaced session/resource bindings', async () => {
    const f = fixture();
    const resolvers: DispatchResolvers = { ...f.resolvers,
      session: () => ({ sessionId, workspaceId: otherId, workspaceGeneration: 3, handle: {} }),
      resource: () => ({ resourceId: null, kind: 'directory', workspaceId, workspaceGeneration: 2, handle: {} }),
    };
    const dispatcher = new Dispatcher({ ...f.options, resolvers });
    assertFailure(await dispatcher.dispatchJson(JSON.stringify(mutationRequest()), f.context), 'STALE_SESSION');
    assertFailure(await dispatcher.dispatchJson(JSON.stringify(fileRequest()), f.context), 'FORBIDDEN');
    expectNoHandler(f);
  });

  it.each(['selection', 'control', 'permission', 'membership', 'auth', 'generation', 'clock', 'expiry'] as const)('rechecks %s after queued admission, immediately before execution', async (change) => {
    const f = fixture();
    const queued = barrier();
    f.enter.mockImplementationOnce(async () => { await queued.pending; return { release: f.release }; });
    const ctx = change === 'expiry' ? createLocalIpcContext({ principalId, clientId, expiresAt: now + 10 }) : f.context;
    const pending = f.dispatch(mutationRequest(), ctx);
    expect(f.enter).toHaveBeenCalledOnce();
    expectNoHandler(f);
    let code: ErrorCode;
    switch (change) {
      case 'selection': f.state.workspace = { ...f.state.workspace, selectedSessionId: otherId, selectionRevision: 9 }; code = 'STALE_SESSION'; break;
      case 'control': f.state.control = false; code = 'CONTROL_REQUIRED'; break;
      case 'permission': f.state.permitted = false; code = 'PERMISSION_REQUIRED'; break;
      case 'membership': f.state.member = false; code = 'FORBIDDEN'; break;
      case 'auth': f.state.authenticated = false; code = 'UNAUTHENTICATED'; break;
      case 'generation': f.state.workspace = { ...f.state.workspace, generation: 4 }; code = 'STALE_WORKSPACE'; break;
      case 'clock': f.state.now += MAX_REQUEST_AGE_MS + 1; code = 'CLOCK_SKEW'; break;
      case 'expiry': f.state.now += 10; code = 'UNAUTHENTICATED'; break;
    }
    queued.release();
    assertFailure(await pending, code);
    expectNoHandler(f);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('denies default/missing admission, refusal and a failed fence without success stubs', async () => {
    const f = fixture();
    const { admissionFence: omitted, ...withoutFence } = f.options;
    expect(omitted).toBeDefined();
    assertFailure(await new Dispatcher(withoutFence).dispatchJson(JSON.stringify(mutationRequest()), f.context), 'STORAGE_UNAVAILABLE');
    f.enter.mockResolvedValueOnce(null);
    assertFailure(await f.dispatch(mutationRequest()), 'BUSY');
    f.enter.mockRejectedValueOnce(new ProtocolFault('REQUEST_CONFLICT'));
    assertFailure(await f.dispatch(mutationRequest()), 'REQUEST_CONFLICT');
    f.enter.mockRejectedValueOnce(new Error('provider-secret-sentinel'));
    const failedFence = await f.dispatch(mutationRequest());
    assertFailure(failedFence, 'STORAGE_UNAVAILABLE');
    expect(JSON.stringify(failedFence)).not.toContain('provider-secret-sentinel');
    expectNoHandler(f);
  });

  it('projects genuine supplied domain results to compact non-durable receipts', async () => {
    const f = fixture();
    const prompt = mutationRequest();
    const promptResult = await f.dispatch(prompt);
    expect(promptResult).toMatchObject({ ok: true, requestId: prompt.requestId, method: 'runtime.prompt', result: {
      kind: 'prompt', requestId: prompt.requestId, durability: 'not-journaled', outcome: 'accepted', runId: otherId, sessionId, viewRevision: 9,
    } });
    expect(f.handlers['runtime.prompt'].mock.calls[0]?.[1].session.handle).toBe(f.sessionHandle);
    expect(f.handlers['runtime.prompt'].mock.calls[0]?.[1].workspace.handle).toBe(f.workspaceHandle);
    expect(f.handlers['runtime.prompt']).toHaveBeenCalledOnce();
    expect(await f.dispatch(abortRequest())).toMatchObject({ ok: true, result: { outcome: 'abort-reported', durability: 'not-journaled' } });
    expect(await f.dispatch(selectRequest())).toMatchObject({ ok: true, result: { outcome: 'selected', selectionRevision: 9, sessionId: otherId } });
    expect(f.release).toHaveBeenCalledTimes(3);
  });

  it('does not turn not-accepted/no-abort results into accepted/stopped claims', async () => {
    const f = fixture();
    f.handlers['runtime.prompt'].mockReturnValue({ accepted: false, runId: otherId, sessionId, viewRevision: 9 });
    f.handlers['runtime.abort'].mockReturnValue({ aborted: false, sessionId, viewRevision: 9 });
    expect(await f.dispatch(mutationRequest())).toMatchObject({ ok: true, result: { outcome: 'not-accepted' } });
    expect(await f.dispatch(abortRequest())).toMatchObject({ ok: true, result: { outcome: 'nothing-to-abort' } });
  });

  it('selects only a resolved target session, with an explicit nullable current selection', async () => {
    const f = fixture();
    f.state.workspace = { ...f.state.workspace, selectedSessionId: null };
    const request = { ...selectRequest(), expectedSessionId: null };
    expect(await f.dispatch(request)).toMatchObject({ ok: true });
    expect(f.handlers['session.select'].mock.calls[0]?.[1].session.sessionId).toBe(otherId);
    f.state.sessionExists = false;
    assertFailure(await f.dispatch(request), 'STALE_SESSION');
    expect(f.handlers['session.select']).toHaveBeenCalledOnce();
  });

  it('accepts an unchanged revision only for an already-selected target, never for an uncommitted selection change', async () => {
    const f = fixture();
    f.handlers['session.select'].mockImplementation((input) => ({ sessionId: input.sessionId, selectionRevision: 8, viewRevision: 10 }));
    const sameTarget = { ...selectRequest(), input: { sessionId } };
    expect(await f.dispatch(sameTarget)).toMatchObject({ ok: true, result: { sessionId, selectionRevision: 8 } });
    assertFailure(await f.dispatch(selectRequest()), 'INTERNAL_ERROR', 'unknown');
  });

  it('keeps exact identities through the fence and never automatically retries an uncertain mutation', async () => {
    const f = fixture();
    const request = mutationRequest();
    f.handlers['runtime.prompt'].mockRejectedValue(new Error('synthetic provider failure'));
    const first = await f.dispatch(request);
    assertFailure(first, 'OUTCOME_UNKNOWN', 'unknown');
    expect(first).toMatchObject({ requestId: request.requestId, operationId: request.requestId });
    expect(f.handlers['runtime.prompt']).toHaveBeenCalledOnce();
    // A caller-controlled retry keeps the original ID/time. The injected fence is NOT a journal or deduplicator.
    await f.dispatch(request);
    expect(f.enter.mock.calls.map(([entry]) => entry.requestId)).toEqual([request.requestId, request.requestId]);
    expect(f.enter.mock.calls.map(([entry]) => entry.issuedAt)).toEqual([request.issuedAt, request.issuedAt]);
    expect(Object.isFrozen(f.enter.mock.calls[0]?.[0])).toBe(true);
    expect(Object.isFrozen(f.enter.mock.calls[0]?.[0].input)).toBe(true);
  });

  it.each(['throw', 'extra-output', 'wrong-session'] as const)('returns only safe correlated errors for mutation %s after possible effects', async (mode) => {
    const f = fixture();
    const request = mutationRequest();
    const sentinel = 'provider-secret-sentinel C:\\private\\auth.json stack headers';
    if (mode === 'throw') f.handlers['runtime.prompt'].mockRejectedValue(new Error(sentinel));
    if (mode === 'extra-output') {
      const invalid = { accepted: true, runId: otherId, sessionId, viewRevision: 9, rawProviderSecret: sentinel };
      f.handlers['runtime.prompt'].mockReturnValue(invalid);
    }
    if (mode === 'wrong-session') f.handlers['runtime.prompt'].mockReturnValue({ accepted: true, runId: otherId, sessionId: otherId, viewRevision: 9 });
    const result = await f.dispatch(request);
    assertFailure(result, mode === 'throw' ? 'OUTCOME_UNKNOWN' : 'INTERNAL_ERROR', 'unknown');
    expect(result).toMatchObject({ requestId: request.requestId, operationId: request.requestId });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('does not translate a transport-like abort/timeout into canceled/stopped success', async () => {
    const f = fixture();
    const request = abortRequest();
    f.handlers['runtime.abort'].mockRejectedValue(new DOMException('Timeout provider-secret-sentinel', 'AbortError'));
    const result = await f.dispatch(request);
    assertFailure(result, 'OUTCOME_UNKNOWN', 'unknown');
    expect(result).toMatchObject({ requestId: request.requestId, operationId: request.requestId });
    expect(JSON.stringify(result)).not.toContain('provider-secret-sentinel');
  });

  it('rejects unbounded, pathful, secret-bearing and wrong-identity read results', async () => {
    const f = fixture();
    const invalid = { fileId, content: 'ok', truncated: false, path: 'C:\\provider-secret-sentinel\\auth.json' };
    f.handlers['file.previewText'].mockReturnValueOnce(invalid);
    const result = await f.dispatch(previewRequest());
    assertFailure(result, 'INTERNAL_ERROR');
    expect(JSON.stringify(result)).not.toContain('provider-secret-sentinel');
    f.handlers['file.previewText'].mockReturnValueOnce({ fileId: otherId, content: 'ok', truncated: false });
    assertFailure(await f.dispatch(previewRequest()), 'INTERNAL_ERROR');
    f.handlers['file.previewText'].mockReturnValueOnce({ fileId, content: 'é'.repeat(6), truncated: false });
    assertFailure(await f.dispatch(previewRequest(10)), 'RESULT_TOO_LARGE');
    f.handlers['file.previewText'].mockReturnValueOnce({ fileId, content: '界'.repeat(32_768), truncated: false });
    assertFailure(await f.dispatch(previewRequest(32_768)), 'RESULT_TOO_LARGE');
  });

  it('rejects extra raw state from a host handler and sanitizes thrown read errors', async () => {
    const f = fixture();
    const invalid = { workspaces: [], runtimeState: { providerToken: 'provider-secret-sentinel' } };
    f.handlers['workspace.list'].mockReturnValueOnce(invalid);
    assertFailure(await f.dispatch(readRequest('workspace.list')), 'INTERNAL_ERROR');
    f.handlers['host.info'].mockRejectedValueOnce(new Error('provider-secret-sentinel'));
    const result = await f.dispatch(readRequest());
    assertFailure(result, 'INTERNAL_ERROR');
    expect(result).toMatchObject({ requestId: otherId });
    expect(JSON.stringify(result)).not.toContain('provider-secret-sentinel');
  });

  it('withholds read data when membership changes while the trusted handler awaits', async () => {
    const f = fixture();
    const pendingRead = barrier();
    f.handlers['file.previewText'].mockImplementationOnce(async () => {
      await pendingRead.pending;
      return { fileId, content: 'private-fixture-content', truncated: false };
    });
    const pending = f.dispatch(previewRequest());
    f.state.member = false;
    pendingRead.release();
    const result = await pending;
    assertFailure(result, 'FORBIDDEN');
    expect(JSON.stringify(result)).not.toContain('private-fixture-content');
  });
});
