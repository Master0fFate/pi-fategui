// Independent adversarial probes for the eight-file DISABLED T10/T11 preparation.
// Two tests intentionally fail while post-handler read binding changes remain unguarded.
import { describe, expect, it, vi } from 'vitest';
import { Dispatcher, type AdmissionFence, type DispatchResolvers, type HandlerMap, type ResourceBinding, type WorkspaceBinding } from '../../src/core/dispatch/Dispatcher';
import { createAuthenticatedServerContext, createLocalIpcContext } from '../../src/core/dispatch/RequestContext';
import { decodeRequestJson } from '../../src/shared/protocol/envelopes';
import { createMutationIdentity } from '../../src/shared/protocol/requestIds';

const epoch = '10000000-0000-4000-8000-000000000001';
const workspaceId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000003';
const fileId = '40000000-0000-4000-8000-000000000004';
const principalId = '50000000-0000-4000-8000-000000000005';
const clientId = '60000000-0000-4000-8000-000000000006';
const requestId = '70000000-0000-4000-8000-000000000007';
const now = 1_800_000_000_000;
const preview = () => ({ protocol: 1, method: 'file.previewText', requestId, serverEpoch: epoch, issuedAt: now,
  workspaceId, workspaceGeneration: 3, input: { fileId, maxBytes: 1_024 } });
const abort = () => ({ protocol: 1, ...createMutationIdentity(epoch, now), method: 'runtime.abort',
  workspaceId, workspaceGeneration: 3, expectedSessionId: sessionId, selectionRevision: 8, controlGeneration: 5, input: {} });
const prompt = () => ({ ...abort(), method: 'runtime.prompt', input: { text: 'Synthetic only.' } });

function fixture(admissionFence?: AdmissionFence) {
  let resolveEntered!: () => void;
  let resolveGate!: () => void;
  const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
  const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
  const state: { workspace: WorkspaceBinding; resource: ResourceBinding; readonly: boolean } = {
    workspace: { workspaceId, generation: 3, selectedSessionId: sessionId, selectionRevision: 8, handle: {} },
    resource: { resourceId: fileId, kind: 'file', workspaceId, workspaceGeneration: 3, handle: {} },
    readonly: false,
  };
  const handlers = {
    'host.info': vi.fn<HandlerMap['host.info']>((_input, context) => ({ hostId: principalId, protocol: 1,
      serverEpoch: epoch, serverTime: context.serverTime, appVersion: '2.0.0', capabilities: [], networkDispatchEnabled: false })),
    'workspace.list': vi.fn<HandlerMap['workspace.list']>(() => ({ workspaces: [] })),
    'file.list': vi.fn<HandlerMap['file.list']>(() => ({ directoryId: null, entries: [], truncated: false })),
    'file.previewText': vi.fn<HandlerMap['file.previewText']>(async () => {
      resolveEntered();
      await gate;
      return { fileId, content: 'previously-private-fixture', truncated: false };
    }),
    'runtime.prompt': vi.fn<HandlerMap['runtime.prompt']>(() => ({ accepted: false, runId: fileId, sessionId, viewRevision: 9 })),
    'runtime.abort': vi.fn<HandlerMap['runtime.abort']>(() => ({ aborted: true, sessionId, viewRevision: 9 })),
    'session.select': vi.fn<HandlerMap['session.select']>(() => ({ sessionId, selectionRevision: 8, viewRevision: 9 })),
  } satisfies HandlerMap;
  const resolvers: DispatchResolvers = {
    authenticate: () => true,
    isMember: (_identity, id) => id === workspaceId,
    workspace: () => state.workspace,
    hasCapability: () => true,
    hasControl: () => true,
    hasPermission: (_identity, _workspace, action) => !state.readonly || action === 'read' || action === 'abort',
    session: (_identity, workspace, id) => ({ sessionId: id, workspaceId: workspace.workspaceId,
      workspaceGeneration: workspace.generation, handle: {} }),
    resource: (_identity, _workspace, id, kind) => id === fileId && kind === 'file' ? state.resource : null,
  };
  const dispatcher = new Dispatcher({ serverEpoch: epoch, handlers, resolvers, now: () => now,
    ...(admissionFence ? { admissionFence } : {}) });
  const identity = createLocalIpcContext({ principalId, clientId, expiresAt: now + 60_000 });
  const dispatch = (request: unknown) => dispatcher.dispatchJson(JSON.stringify(request), identity);
  return { state, handlers, dispatch, dispatcher, entered, release: resolveGate };
}

describe('independent protocol preparation probes', () => {
  it.each(['workspace handle', 'resource handle'] as const)('withholds a read after %s is replaced under same generation and ID', async (changed) => {
    const f = fixture();
    const pending = f.dispatch(preview());
    await f.entered;
    if (changed === 'workspace handle') f.state.workspace = { ...f.state.workspace, handle: {} };
    else f.state.resource = { ...f.state.resource, handle: {} };
    f.release();
    const result = await pending;
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain('previously-private-fixture');
  });

  it('retains fixed safe errors and enforces UTF-8 command/output bounds without exposing fixture data', async () => {
    const f = fixture();
    const secret = 'synthetic-secret-sentinel';
    f.handlers['host.info'].mockImplementationOnce(() => { throw new Error(secret); });
    const hostRequest = { protocol: 1, method: 'host.info', requestId, serverEpoch: epoch, issuedAt: now, input: {} };
    const thrown = await f.dispatch(hostRequest);
    expect(thrown).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'The operation could not be completed safely.' } });
    expect(JSON.stringify(thrown)).not.toContain(secret);
    expect(decodeRequestJson(JSON.stringify({ ...preview(), unknown: 'é'.repeat(600_000) })))
      .toMatchObject({ ok: false, code: 'INVALID_REQUEST', requestId: null });
    f.handlers['file.previewText'].mockResolvedValueOnce({ fileId, content: 'é'.repeat(6), truncated: false });
    const oversized = await f.dispatch({ ...preview(), input: { fileId, maxBytes: 10 } });
    expect(oversized).toMatchObject({ ok: false, error: { code: 'RESULT_TOO_LARGE' } });
    expect(JSON.stringify(oversized)).not.toContain('é');
  });

  it('rejects actual server contexts even if local fake grants every capability', async () => {
    const f = fixture();
    const identity = createAuthenticatedServerContext({ principalId, clientId, expiresAt: now + 60_000 }, 'http://127.0.0.1:5173');
    const host = { protocol: 1, method: 'host.info', requestId, serverEpoch: epoch, issuedAt: now, input: {} };
    for (const request of [host, abort()]) {
      const result = await f.dispatcher.dispatchJson(JSON.stringify(request), identity);
      expect(result).toMatchObject({ ok: false, error: { code: 'DISPATCH_DISABLED' } });
    }
    expect(f.handlers['host.info']).not.toHaveBeenCalled();
    expect(f.handlers['runtime.abort']).not.toHaveBeenCalled();
  });

  it('rechecks permission after a queued admission fence before entering the prompt handler', async () => {
    let releaseFence!: () => void;
    let signalFenceEntered!: () => void;
    const waiting = new Promise<void>((resolve) => { releaseFence = resolve; });
    const entered = new Promise<void>((resolve) => { signalFenceEntered = resolve; });
    const release = vi.fn();
    const f = fixture({ enter: async () => { signalFenceEntered(); await waiting; return { release }; } });
    const pending = f.dispatch(prompt());
    await entered;
    f.state.readonly = true;
    releaseFence();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' }, execution: 'not-started' });
    expect(f.handlers['runtime.prompt']).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('documents that a read-only controller cannot prompt, but storage outage blocks abort too', async () => {
    const f = fixture();
    f.state.readonly = true;
    expect(await f.dispatch(prompt())).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' }, execution: 'not-started' });
    expect(await f.dispatch(abort())).toMatchObject({ ok: false, error: { code: 'STORAGE_UNAVAILABLE' }, execution: 'not-started' });
    expect(f.handlers['runtime.prompt']).not.toHaveBeenCalled();
    expect(f.handlers['runtime.abort']).not.toHaveBeenCalled();
  });
});
