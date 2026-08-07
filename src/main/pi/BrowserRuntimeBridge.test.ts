import { describe, expect, it, vi } from 'vitest';
import type { BrowserService } from '../browser/BrowserService';
import { BrowserRuntimeBridge } from './BrowserRuntimeBridge';

function serviceFixture() {
  let leaseOwner: string | null = null;
  const service = {
    beginTask: vi.fn(),
    endTask: vi.fn(),
    cancelAnnotationSelection: vi.fn(),
    ensureTab: vi.fn(async () => undefined),
    getState: vi.fn(() => ({
      activeTabId: 'browser-main', visible: false, viewBlocked: false, sessionFullAccess: false, paused: true, controlLevel: 'off' as const,
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

  it('fails closed while no trusted project browser service exists', async () => {
    const bridge = new BrowserRuntimeBridge(() => null);
    bridge.setActiveRoot({ projectPath: '/project', sessionId: 'root' });
    await expect(bridge.tabs({ sessionId: 'root' })).rejects.toThrow(/Open the Browser workspace/u);
  });
});
