import { describe, expect, it, vi } from 'vitest';
import type { BrowserService } from '../browser/BrowserService';
import { BrowserRuntimeBridge } from './BrowserRuntimeBridge';

function serviceFixture() {
  let leaseOwner: string | null = null;
  const service = {
    beginTask: vi.fn(),
    endTask: vi.fn(),
    cancelAnnotationSelection: vi.fn(),
    revokeSessionControl: vi.fn(),
    resolveAnnotations: vi.fn(async () => []),
    setControlLevel: vi.fn(),
    setSessionFullAccess: vi.fn(),
    setMode: vi.fn(),
    createUserTab: vi.fn(async () => 'tab-2'),
    navigate: vi.fn(async () => undefined),
    activateTab: vi.fn(),
    closeTab: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => ({ tabId: 'tab-2', serialized: 'page', url: 'https://example.test/new', revision: 1 })),
    ensureTab: vi.fn(async () => undefined),
    getState: vi.fn(() => ({
      activeTabId: 'browser-main', visible: false, viewBlocked: false, sessionFullAccess: false, controlLevel: 'off' as const,
      tabs: [{
        id: 'browser-main', profileId: 'project', url: 'https://example.test/', title: 'Example', loading: false,
        canGoBack: false, canGoForward: false, documentEpoch: 1, semanticAvailable: true,
      }],
      grants: [],
    })),
    lease: {
      getState: vi.fn(() => leaseOwner ? { ownerSessionId: leaseOwner, acquiredAt: 1 } : null),
      acquire: vi.fn((owner: string) => { leaseOwner = owner; return { ownerSessionId: owner, acquiredAt: 1 }; }),
      release: vi.fn((owner: string) => {
        if (leaseOwner !== owner) return false;
        leaseOwner = null;
        return true;
      }),
      assertOwner: vi.fn((owner: string) => {
        if (leaseOwner !== owner) throw new Error('wrong owner');
      }),
    },
    annotations: { resolve: vi.fn(() => []) },
  };
  return service as unknown as BrowserService;
}

describe('BrowserRuntimeBridge', () => {
  it('binds the live browser lease to the selected root and transfers it on root changes', async () => {
    const service = serviceFixture();
    const bridge = new BrowserRuntimeBridge(() => service);

    bridge.setActiveRoot({ projectPath: '/project', sessionId: 'root-a' });
    expect(bridge.currentRoot()).toEqual({ projectPath: '/project', sessionId: 'root-a' });
    expect(service.beginTask).toHaveBeenCalledWith('root-a');
    expect(service.lease.acquire).toHaveBeenCalledWith('root-a');

    await expect(bridge.tabs({ sessionId: 'child-session' })).rejects.toThrow(/does not own/u);
    await expect(bridge.tabs({ sessionId: 'root-a' })).resolves.toEqual([
      expect.objectContaining({ id: 'browser-main', active: true }),
    ]);

    bridge.setActiveRoot({ projectPath: '/project', sessionId: 'root-b' });
    expect(service.cancelAnnotationSelection).toHaveBeenCalledOnce();
    expect(service.lease.release).toHaveBeenCalledWith('root-a');
    expect(service.endTask).toHaveBeenCalledTimes(1);
    expect(service.lease.acquire).toHaveBeenCalledWith('root-b');
  });

  it('ignores roots and disposal clears from background projects', () => {
    const service = serviceFixture();
    const bridge = new BrowserRuntimeBridge(() => service);
    bridge.setFocusedProjectPath('/a');
    bridge.setActiveRoot({ projectPath: '/a', sessionId: 'root-a' });
    bridge.setActiveRoot({ projectPath: '/b', sessionId: 'root-b' });
    expect(bridge.currentRoot()).toEqual({ projectPath: '/a', sessionId: 'root-a' });
    bridge.clearActiveRoot('/b');
    expect(bridge.currentRoot()).toEqual({ projectPath: '/a', sessionId: 'root-a' });
    bridge.clearActiveRoot('/a');
    expect(bridge.currentRoot()).toBeNull();
  });

  it('does not let background disposal clear the focused browser root', () => {
    const service = serviceFixture();
    const bridge = new BrowserRuntimeBridge(() => service);
    bridge.setFocusedProjectPath('/foreground');
    bridge.setActiveRoot({ projectPath: '/foreground', sessionId: 'root' });
    bridge.clearActiveRoot('/background');
    expect(bridge.currentRoot()).toEqual({ projectPath: '/foreground', sessionId: 'root' });
  });

  it('fails closed while no trusted project browser service exists', async () => {
    const bridge = new BrowserRuntimeBridge(() => null);
    bridge.setActiveRoot({ projectPath: '/project', sessionId: 'root' });
    await expect(bridge.tabs({ sessionId: 'root' })).rejects.toThrow(/Open the Browser workspace/u);
  });

  it('starts the built-in browser when tools run before the workspace is opened', async () => {
    const service = serviceFixture();
    let currentService: BrowserService | null = null;
    const ensure = vi.fn(async () => {
      currentService = service;
      return service;
    });
    const bridge = new BrowserRuntimeBridge(() => currentService, ensure);
    bridge.setActiveRoot({ projectPath: '/project', sessionId: 'root' });
    await expect(bridge.tabs({ sessionId: 'root' })).resolves.toEqual([
      expect.objectContaining({ id: 'browser-main', active: true }),
    ]);
    expect(ensure).toHaveBeenCalledOnce();
    expect(service.setControlLevel).toHaveBeenCalledWith('interact');
  });

  it('does not reclaim the browser after the active root changes during startup', async () => {
    const service = serviceFixture();
    let currentService: BrowserService | null = null;
    let resolveEnsure!: (service: BrowserService) => void;
    const ensure = vi.fn(() => new Promise<BrowserService>((resolve) => { resolveEnsure = resolve; }));
    const bridge = new BrowserRuntimeBridge(() => currentService, ensure);
    bridge.setActiveRoot({ projectPath: '/project', sessionId: 'root-a' });

    const pending = bridge.tabs({ sessionId: 'root-a' });
    bridge.setActiveRoot({ projectPath: '/project', sessionId: 'root-b' });
    currentService = service;
    resolveEnsure(service);

    await expect(pending).rejects.toThrow(/does not own/u);
    expect(service.beginTask).not.toHaveBeenCalled();
    expect(service.lease.acquire).not.toHaveBeenCalledWith('root-a');
  });

  it('keeps independent browser services for concurrently running sessions', async () => {
    const first = serviceFixture();
    const second = serviceFixture();
    const sessions = new Map([['root-a', first], ['root-b', second]]);
    const bridge = new BrowserRuntimeBridge(
      () => null,
      undefined,
      (root) => sessions.get(root.sessionId) ?? null,
    );
    bridge.registerSession({ projectPath: '/project', sessionId: 'root-a' });
    bridge.registerSession({ projectPath: '/project', sessionId: 'root-b' });
    bridge.setActiveRoot({ projectPath: '/project', sessionId: 'root-a' });
    await bridge.navigate({ sessionId: 'root-a', url: 'https://one.test/', reason: 'check' });
    bridge.setActiveRoot({ projectPath: '/project', sessionId: 'root-b' });
    await bridge.navigate({ sessionId: 'root-b', url: 'https://two.test/', reason: 'check' });
    await bridge.tabs({ sessionId: 'root-a' });
    expect(first.navigate).toHaveBeenCalledWith('browser-main', 'https://one.test/', 'agent', undefined);
    expect(second.navigate).toHaveBeenCalledWith('browser-main', 'https://two.test/', 'agent', undefined);
    expect(first.navigate).not.toHaveBeenCalledWith('browser-main', 'https://two.test/', 'agent', undefined);
    expect(first.endTask).not.toHaveBeenCalled();
    await expect(bridge.tabs({ sessionId: 'unknown' })).rejects.toThrow(/does not own/u);
    bridge.revokeSession({ projectPath: '/project', sessionId: 'root-a' });
    await expect(bridge.tabs({ sessionId: 'root-a' })).rejects.toThrow(/does not own/u);
    expect(second.endTask).not.toHaveBeenCalled();
  });

  it('never borrows the focused session’s full-access browser authority', async () => {
    const first = serviceFixture();
    const second = serviceFixture();
    const sessions = new Map([['root-a', first], ['root-b', second]]);
    const bridge = new BrowserRuntimeBridge(() => null, undefined, (root) => sessions.get(root.sessionId) ?? null);
    bridge.registerSession({ projectPath: '/project', sessionId: 'root-a' }, 'full-access');
    bridge.registerSession({ projectPath: '/project', sessionId: 'root-b' }, 'read-only');
    bridge.setActiveRoot({ projectPath: '/project', sessionId: 'root-a' });
    await bridge.tabs({ sessionId: 'root-b' });
    expect(second.setSessionFullAccess).toHaveBeenLastCalledWith(false);
    bridge.registerSession({ projectPath: '/project', sessionId: 'root-a' }, 'read-only');
    expect(first.setSessionFullAccess).toHaveBeenLastCalledWith(false);
  });

  it('does not return another session’s annotations even when ids are known', async () => {
    const first = serviceFixture();
    const second = serviceFixture();
    vi.mocked(first.resolveAnnotations).mockResolvedValue([{ id: 'private' }] as never);
    const sessions = new Map([['root-a', first], ['root-b', second]]);
    const bridge = new BrowserRuntimeBridge(() => null, undefined, (root) => sessions.get(root.sessionId) ?? null);
    bridge.registerSession({ projectPath: '/project', sessionId: 'root-a' });
    bridge.registerSession({ projectPath: '/project', sessionId: 'root-b' });
    expect(await bridge.resolveAnnotations(['private'], 'root-b')).toEqual([]);
    expect(second.resolveAnnotations).toHaveBeenCalledWith(['private']);
    expect(first.resolveAnnotations).not.toHaveBeenCalled();
  });

  it('does not return page data when a session is revoked during capture', async () => {
    const service = serviceFixture();
    let finish!: (value: unknown) => void;
    vi.mocked(service.snapshot).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }) as never);
    const bridge = new BrowserRuntimeBridge(() => null, undefined, (root) => root.sessionId === 'root-a' ? service : null);
    bridge.registerSession({ projectPath: '/project', sessionId: 'root-a' });
    const pending = bridge.snapshot({ sessionId: 'root-a', mode: 'content' });
    await vi.waitFor(() => expect(service.snapshot).toHaveBeenCalledOnce());
    bridge.revokeSession({ projectPath: '/project', sessionId: 'root-a' });
    finish({ serialized: 'private content' });
    await expect(pending).rejects.toThrow(/does not own/u);
  });

  it('shares only a bounded read-only excerpt when a live source session is explicitly tagged', async () => {
    const source = serviceFixture();
    vi.mocked(source.snapshot).mockResolvedValue({ serialized: 'Source page text', url: 'https://example.test/?token=private' } as never);
    const bridge = new BrowserRuntimeBridge(() => null, undefined, (root) => root.sessionId === 'source' ? source : null);
    bridge.registerSession({ projectPath: '/project', sessionId: 'source' });
    expect(await bridge.readTaggedBrowserContext({ projectPath: '/project', sessionId: 'source' }))
      .toContain('Source page text');
    expect(source.snapshot).toHaveBeenCalledWith('browser-main', { mode: 'content' });
    expect(source.navigate).not.toHaveBeenCalled();
    expect(await bridge.readTaggedBrowserContext({ projectPath: '/project', sessionId: 'stranger' })).toBeNull();
  });

  it('opens a new tab for the owning root session', async () => {
    const service = serviceFixture();
    vi.mocked(service.getState).mockReturnValue({
      activeTabId: 'tab-2', visible: false, viewBlocked: false, sessionFullAccess: true, controlLevel: 'interact',
      mode: 'agent', deviceEmulation: null,
      tabs: [{
        id: 'tab-2', profileId: 'project', url: 'https://example.test/new', title: 'New', loading: false,
        canGoBack: false, canGoForward: false, documentEpoch: 1, semanticAvailable: true,
      }],
      grants: [],
    });
    const bridge = new BrowserRuntimeBridge(() => service);
    bridge.setActiveRoot({ projectPath: '/project', sessionId: 'root-a' });
    await expect(bridge.createTab({ sessionId: 'root-a', url: 'https://example.test/new' })).resolves.toMatchObject({
      tabId: 'tab-2',
    });
    expect(service.createUserTab).toHaveBeenCalledWith('about:blank');
    expect(service.navigate).toHaveBeenCalledWith('tab-2', 'https://example.test/new', 'agent', undefined);
  });

  it('closes a new tab when its agent navigation is blocked', async () => {
    const service = serviceFixture();
    vi.mocked(service.navigate).mockRejectedValueOnce(new Error('The browser navigation was not confirmed.'));
    const bridge = new BrowserRuntimeBridge(() => service);
    bridge.setActiveRoot({ projectPath: '/project', sessionId: 'root-a' });

    await expect(bridge.createTab({ sessionId: 'root-a', url: 'https://blocked.example/' }))
      .rejects.toThrow(/not confirmed/u);
    expect(service.createUserTab).toHaveBeenCalledWith('about:blank');
    expect(service.navigate).toHaveBeenCalledWith('tab-2', 'https://blocked.example/', 'agent', undefined);
    expect(service.closeTab).toHaveBeenCalledWith('tab-2');
  });
});
