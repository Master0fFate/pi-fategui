import { describe, expect, it, vi } from 'vitest';
import type { BrowserService } from '../browser/BrowserService';
import { BrowserRuntimeBridge } from './BrowserRuntimeBridge';

function serviceFixture() {
  let leaseOwner: string | null = null;
  const service = {
    beginTask: vi.fn(),
    endTask: vi.fn(),
    cancelAnnotationSelection: vi.fn(),
    setControlLevel: vi.fn(),
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
