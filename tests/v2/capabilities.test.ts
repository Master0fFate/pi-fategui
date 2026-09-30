import { describe, expect, it, vi } from 'vitest';
import { clientCapabilitySchema, hostCapabilitySchema, intersectCapabilities, desktopClientCapabilities, desktopHostCapabilities, supportsHostOperation, supportsWorkspaceOperation } from '../../src/shared/protocol/capabilities';
import { ProtocolFault } from '../../src/shared/protocol/errors';
import { CoreIpcAdapter } from '../../src/main/ipc/CoreIpcAdapter';
import { Dispatcher, type HandlerMap } from '../../src/core/dispatch/Dispatcher';
import { createLocalIpcContext } from '../../src/core/dispatch/RequestContext';

const absent = { monitor: false, nativeBrowser: false, microphone: false, hotkeys: false, updater: false, ambientAudio: false, manualTerminal: false, localFileOpen: false, clipboardText: false };
// The real desktop runtime has hundreds of methods; these fixtures exercise only
// the named Monitor seam and never construct Electron or a provider runtime.
function monitorAdapter(owner: object, registry: object, host?: ConstructorParameters<typeof CoreIpcAdapter>[4]) {
  return new CoreIpcAdapter(owner as ConstructorParameters<typeof CoreIpcAdapter>[0],
    registry as ConstructorParameters<typeof CoreIpcAdapter>[1], () => true, undefined, host);
}
const emptyDashboard = {
  projectPath: '/project', sessionId: null, checkedAt: 1, revision: 'rev', overall: 'normal' as const,
  sources: { runs: 'ready' as const, teams: 'ready' as const, tasks: 'ready' as const, activity: 'ready' as const },
  sourceCheckedAt: { runs: 1, teams: 1, tasks: 1, activity: 1 },
  counts: { active: 0, attention: 0, runs: 0, teams: 0, tasks: 0, activity: 0 },
  section: 'overview' as const, total: 0, offset: 0, limit: 10, unchanged: false, items: [],
};

describe('T21 capability policy', () => {
  it('rejects unexpected fields and unknown operations, and requires versioned host identity', () => {
    expect(hostCapabilitySchema.safeParse({ ...desktopHostCapabilities, token: 'secret' }).success).toBe(false);
    expect(hostCapabilitySchema.safeParse({ ...desktopHostCapabilities, supported: { ...absent, script: true } }).success).toBe(false);
    expect(clientCapabilitySchema.safeParse({ ...desktopClientCapabilities, version: 2 }).success).toBe(false);
  });
  it('intersects host and client support, independent of permission or trust', () => {
    const available = intersectCapabilities({ ...desktopHostCapabilities, supported: { ...desktopHostCapabilities.supported, monitor: false, nativeBrowser: false } }, desktopClientCapabilities);
    expect(available.monitor).toBe(false);
    expect(available.nativeBrowser).toBe(false);
    expect(available.microphone).toBe(true);
    expect(intersectCapabilities(desktopHostCapabilities, { version: 1, supported: absent })).toEqual(absent);
    expect(supportsHostOperation(desktopHostCapabilities, 'monitor')).toBe(true);
    expect(supportsHostOperation({ ...desktopHostCapabilities, supported: { ...desktopHostCapabilities.supported, monitor: false } }, 'monitor')).toBe(false);
  });
  it('refuses a false per-workspace operation in the backend before a handler runs, even if permission is true', async () => {
    const workspaceId = '20000000-0000-4000-8000-000000000002';
    const fileId = '50000000-0000-4000-8000-000000000005';
    const host = { ...desktopHostCapabilities, workspaces: [{ workspaceId, label: 'Project', supported: { monitor: false, operations: [] } }] };
    const preview = vi.fn(() => ({ fileId, content: 'must not be read', truncated: false }));
    const handlers = { 'file.previewText': preview } as unknown as HandlerMap;
    const epoch = desktopHostCapabilities.serverEpoch;
    const dispatcher = new Dispatcher({ serverEpoch: epoch, handlers, now: () => 1000, resolvers: {
      authenticate: () => true, isMember: () => true,
      workspace: () => ({ workspaceId, generation: 1, selectedSessionId: null, selectionRevision: 0, handle: {} }),
      hasCapability: (_identity, operation, workspace) => workspace !== null && supportsWorkspaceOperation(host, workspace.workspaceId, operation),
      hasPermission: () => true,
    } });
    const identity = createLocalIpcContext({ clientId: '60000000-0000-4000-8000-000000000006', principalId: '70000000-0000-4000-8000-000000000007', expiresAt: 2000 });
    const result = await dispatcher.dispatchJson(JSON.stringify({ protocol: 1, requestId: '40000000-0000-4000-8000-000000000004', serverEpoch: epoch,
      issuedAt: 1000, method: 'file.previewText', workspaceId, workspaceGeneration: 1, input: { fileId, maxBytes: 1000 } }), identity);
    expect(result).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_CAPABILITY' }, execution: 'not-started' });
    expect(preview).not.toHaveBeenCalled();
  });
  it('rejects a false registered Monitor before a disconnected healthy-empty read, but keeps true and local reads', async () => {
    const workspaceId = '20000000-0000-4000-8000-000000000002';
    const registered = (monitor: boolean) => ({ ...desktopHostCapabilities, workspaces: [{
      workspaceId, label: 'Project', supported: { monitor, operations: [] },
    }] });
    const read = vi.fn(async () => emptyDashboard);
    const router = { getState: vi.fn(() => ({ project: null })), getMonitorDashboard: read };
    const owner = { asRouter: vi.fn(() => router), peekWorkspace: vi.fn(), workspaceOrigin: vi.fn(), workspaceSelectionRevision: vi.fn() };
    const registry = { registerHostPath: vi.fn(), resolve: vi.fn() };
    const blocked = monitorAdapter(owner, registry, registered(false));
    await expect(blocked.monitor({})).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(owner.asRouter).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    const enabled = monitorAdapter(owner, registry, registered(true));
    expect(await enabled.monitor({})).toMatchObject({ overall: 'normal', items: [] });
    expect(read).toHaveBeenCalledOnce();
    const local = monitorAdapter(owner, registry);
    expect(await local.monitor({})).toMatchObject({ overall: 'normal', items: [] });
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('rejects a false selected workspace even if a different registered workspace supports Monitor', async () => {
    const selectedId = '20000000-0000-4000-8000-000000000002';
    const otherId = '30000000-0000-4000-8000-000000000003';
    const read = vi.fn(async () => emptyDashboard);
    const router = { getState: vi.fn(() => ({ project: { path: '/selected', trusted: false }, sessionId: null })), getMonitorDashboard: read };
    const owner = { asRouter: vi.fn(() => router), peekWorkspace: vi.fn(), workspaceOrigin: vi.fn(() => ({ workspaceId: selectedId, workspaceGeneration: 1 })), workspaceSelectionRevision: vi.fn() };
    const registry = { registerHostPath: vi.fn(), resolve: vi.fn() };
    const host = { ...desktopHostCapabilities, workspaces: [
      { workspaceId: selectedId, label: 'Selected', supported: { monitor: false, operations: [] } },
      { workspaceId: otherId, label: 'Other', supported: { monitor: true, operations: [] } },
    ] };
    const adapter = monitorAdapter(owner, registry, host);
    await expect(adapter.monitor({})).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(read).not.toHaveBeenCalled();
    expect(registry.registerHostPath).not.toHaveBeenCalled();
  });
  it('keeps a true registered Monitor read for a trusted selected workspace', async () => {
    const workspaceId = '20000000-0000-4000-8000-000000000002';
    const root = '/project';
    const selectedSessionId = 'session';
    const read = vi.fn(async () => ({ ...emptyDashboard, sessionId: selectedSessionId }));
    const selected = { getState: () => ({ project: { path: root, trusted: true }, sessionId: selectedSessionId }), getMonitorDashboard: read };
    const handle = { id: workspaceId, root, generation: 1, runtime: selected,
      admission: { snapshot: () => ({ selectedSessionId, selectionRevision: 0 }) } };
    const owner = { asRouter: () => selected, peekWorkspace: () => selected,
      workspaceOrigin: () => ({ workspaceId, workspaceGeneration: 1 }), workspaceSelectionRevision: () => 0 };
    const registry = { registerHostPath: vi.fn(async () => handle), resolve: () => handle };
    const host = { ...desktopHostCapabilities, workspaces: [{ workspaceId, label: 'Project', supported: { monitor: true, operations: [] } }] };
    const adapter = monitorAdapter(owner, registry, host);
    expect(await adapter.monitor({})).toMatchObject({ projectPath: root, sessionId: selectedSessionId, overall: 'normal' });
    expect(read).toHaveBeenCalledOnce();
    expect(registry.registerHostPath).toHaveBeenCalledOnce();
  });
  it('refuses a disabled backend monitor read instead of returning an empty dashboard', async () => {
    const owner = { asRouter: vi.fn(), peekWorkspace: vi.fn(), workspaceOrigin: vi.fn(), workspaceSelectionRevision: vi.fn() };
    const registry = { registerHostPath: vi.fn(), resolve: vi.fn() };
    const adapter = new CoreIpcAdapter(owner, registry, () => true, undefined, { ...desktopHostCapabilities, supported: { ...desktopHostCapabilities.supported, monitor: false } });
    await expect(adapter.forInvocation(() => true).monitor({})).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(owner.asRouter).not.toHaveBeenCalled();
    expect(registry.registerHostPath).not.toHaveBeenCalled();
    expect(new ProtocolFault('UNSUPPORTED_CAPABILITY').code).toBe('UNSUPPORTED_CAPABILITY');
  });
});
