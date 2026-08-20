import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { BrowserService } from './BrowserService';

describe('BrowserService visibility safety', () => {
  it('stays fully available and hidden-state free when the native browser is hidden', async () => {
    const service = new BrowserService({ isDestroyed: () => false } as BrowserWindow, {
      canonicalProjectPath: process.cwd(),
    });

    service.setVisible(true);
    expect(service.getState().visible).toBe(true);

    service.setVisible(false);

    // Hiding the view never pauses agent control; the agent stays available.
    expect(service.getState()).toMatchObject({ visible: false, viewBlocked: false });
    await service.dispose();
  });

  it('does not treat a page-opened private URL as an explicit human navigation', async () => {
    const service = new BrowserService({ isDestroyed: () => false } as BrowserWindow, {
      canonicalProjectPath: process.cwd(),
    });
    const tab = { id: 'tab-1', humanNetworkOrigins: new Set<string>() };
    const resolveNavigation = (service as unknown as {
      resolveNavigation(value: unknown, url: string, source: 'user' | 'page'): Promise<{ url: string }>;
    }).resolveNavigation.bind(service);

    await expect(resolveNavigation(tab, 'http://127.0.0.1:4173/', 'page')).rejects.toThrow(/explicit origin grant/u);
    await expect(resolveNavigation(tab, 'http://127.0.0.1:4173/', 'user')).resolves.toMatchObject({
      url: 'http://127.0.0.1:4173/',
    });
    expect(tab.humanNetworkOrigins).toContain('http://127.0.0.1:4173');
    await service.dispose();
  });

  it('carries an explicit private-network grant across CONNECT scheme ambiguity for the same authority', async () => {
    const service = new BrowserService({ isDestroyed: () => false } as BrowserWindow, {
      canonicalProjectPath: process.cwd(),
    });
    service.beginTask('run-1');
    service.setOriginGrant({
      origin: 'http://127.0.0.1:4173', read: true, interact: true, scope: 'task', allowPrivateNetwork: true,
    });

    const allowed = (service as unknown as { allowsPrivateNetworkAuthority(origin: string): boolean })
      .allowsPrivateNetworkAuthority('https://127.0.0.1:4173');

    expect(allowed).toBe(true);
    await service.dispose();
  });

  it('treats Electron ERR_ABORTED as superseded user navigation instead of a stopped Pi run', async () => {
    const service = new BrowserService({ isDestroyed: () => false } as BrowserWindow, {
      canonicalProjectPath: process.cwd(),
    });
    const aborted = Object.assign(new Error("ERR_ABORTED (-3) loading 'https://example.test/'"), { code: 'ERR_ABORTED', errno: -3 });
    const tab = {
      id: 'tab-1',
      humanNetworkOrigins: new Set<string>(),
      view: { webContents: { loadURL: vi.fn(async () => { throw aborted; }), getURL: () => 'https://example.test/', isDestroyed: () => false } },
    };
    const tabs = (service as unknown as { tabs: Map<string, unknown> }).tabs;
    tabs.set(tab.id, tab);

    await expect(service.navigate(tab.id, 'https://example.test/', 'user')).resolves.toBeUndefined();

    tabs.delete(tab.id);
    await service.dispose();
  });

  it('dismisses sent annotation markers without deleting queued annotation context', async () => {
    const service = new BrowserService({ isDestroyed: () => false } as BrowserWindow, {
      canonicalProjectPath: process.cwd(),
    });
    const annotation = service.annotations.save({
      id: 'annotation-1', tabId: 'tab-1', url: 'https://example.test/', origin: 'https://example.test',
      documentEpoch: 1, pageRevision: 1, kind: 'element',
      target: {
        frameId: 'frame-1', backendNodeId: 7, rectCssPx: { x: 1, y: 2, width: 30, height: 20 },
        rectNormalized: { x: 0, y: 0, width: 0.1, height: 0.1 }, locatorHints: {},
        fingerprint: { attributesHash: 'a', nearbyTextHash: 'b', ancestorHash: 'c' },
      },
      comment: '', semanticCoverage: 1, reattachConfidence: 1, createdAt: 1,
    });
    const remove = vi.fn(async () => undefined);
    const tabs = (service as unknown as { tabs: Map<string, unknown> }).tabs;
    tabs.set('tab-1', { annotationOverlay: { remove } });

    await service.dismissAnnotationOverlays([annotation.id]);

    expect(remove).toHaveBeenCalledWith(annotation.id);
    expect(service.annotations.get(annotation.id)).toEqual(annotation);
    tabs.delete('tab-1');
    await service.dispose();
  });

  it('closes tab resources without touching a destroyed owner window', async () => {
    const owner = {
      isDestroyed: () => true,
      get contentView() { throw new Error('destroyed owner accessed'); },
    } as unknown as BrowserWindow;
    const service = new BrowserService(owner, { canonicalProjectPath: process.cwd() });
    const disposeCdp = vi.fn(async () => undefined);
    const closeContents = vi.fn();
    const tab = {
      id: 'tab-1',
      cdp: { dispose: disposeCdp },
      view: { webContents: { isDestroyed: () => false, close: closeContents } },
    };

    await (service as unknown as { destroyTab(value: unknown): Promise<void> }).destroyTab(tab);

    expect(disposeCdp).toHaveBeenCalledOnce();
    expect(closeContents).toHaveBeenCalledOnce();
    await service.dispose();
  });

  it('reopens the main tab at the remembered restore URL when no explicit address is given', async () => {
    const service = new BrowserService({ isDestroyed: () => false } as BrowserWindow, {
      canonicalProjectPath: process.cwd(),
      restoreUrl: 'http://localhost:3000/app',
    });
    const createTab = vi.spyOn(service, 'createTab').mockResolvedValue(undefined);

    await service.ensureTab('browser-main');
    expect(createTab).toHaveBeenLastCalledWith('browser-main', 'project', 'http://localhost:3000/app');

    // An explicit address always wins over the remembered page.
    await service.ensureTab('browser-main', 'https://example.com');
    expect(createTab).toHaveBeenLastCalledWith('browser-main', 'project', 'https://example.com');

    createTab.mockRestore();
    await service.dispose();
  });

  it('falls back to the home page when no restore URL is configured', async () => {
    const service = new BrowserService({ isDestroyed: () => false } as BrowserWindow, {
      canonicalProjectPath: process.cwd(),
    });
    const createTab = vi.spyOn(service, 'createTab').mockResolvedValue(undefined);

    await service.ensureTab('browser-main');
    expect(createTab).toHaveBeenLastCalledWith('browser-main', 'project', 'about:blank');

    createTab.mockRestore();
    await service.dispose();
  });
});

describe('BrowserService disposal hardening', () => {
  it('never surfaces "did not dispose cleanly" when every disposal step races Chromium teardown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const owner = {
      isDestroyed: () => false,
      contentView: { removeChildView: vi.fn(() => { throw new Error('Object has been destroyed.'); }) },
    } as unknown as BrowserWindow;
    const service = new BrowserService(owner, { canonicalProjectPath: process.cwd() });
    const tab = {
      id: 'tab-1',
      cdp: { dispose: vi.fn(async () => { throw new Error('Object has been destroyed.'); }) },
      view: { webContents: { isDestroyed: () => false, close: vi.fn(() => { throw new Error('Object has been destroyed.'); }), destroy: vi.fn() } },
    };
    const tabs = (service as unknown as { tabs: Map<string, unknown> }).tabs;
    tabs.set('tab-1', tab);

    await expect(
      (service as unknown as { destroyTab(value: unknown): Promise<void> }).destroyTab(tab),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    tabs.delete('tab-1');
    await service.dispose();
    warn.mockRestore();
  });

  it('force-closes a tab whose renderer ignores close()', async () => {
    vi.useFakeTimers();
    try {
      const service = new BrowserService({ isDestroyed: () => true } as unknown as BrowserWindow, {
        canonicalProjectPath: process.cwd(),
      });
      const forcedClose = vi.fn();
      const tab = {
        id: 'tab-1',
        cdp: { dispose: vi.fn(async () => undefined) },
        view: { webContents: { isDestroyed: () => false, close: vi.fn().mockImplementation((_opts?: unknown) => {
          if (typeof _opts === 'object') forcedClose();
        }) } },
      };

      await (service as unknown as { destroyTab(value: unknown): Promise<void> }).destroyTab(tab);
      expect(forcedClose).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(forcedClose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not throw from the close reaper when webContents is already gone', async () => {
    vi.useFakeTimers();
    try {
      const service = new BrowserService({ isDestroyed: () => true } as unknown as BrowserWindow, {
        canonicalProjectPath: process.cwd(),
      });
      const tab = {
        id: 'tab-1',
        cdp: { dispose: vi.fn(async () => undefined) },
        view: { webContents: undefined },
      };

      await expect(
        (service as unknown as { destroyTab(value: unknown): Promise<void> }).destroyTab(tab),
      ).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(10_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the captured webContents after detach drops the view getter', async () => {
    const captured = { isDestroyed: () => false, close: vi.fn() };
    let detached = false;
    const owner = {
      isDestroyed: () => false,
      contentView: { removeChildView: vi.fn(() => { detached = true; }) },
    } as unknown as BrowserWindow;
    const service = new BrowserService(owner, { canonicalProjectPath: process.cwd() });
    const tab = {
      id: 'tab-1',
      cdp: { dispose: vi.fn(async () => undefined) },
      view: {
        get webContents() { return detached ? undefined : captured; },
      },
    };

    await (service as unknown as { destroyTab(value: unknown): Promise<void> }).destroyTab(tab);

    expect(captured.close).toHaveBeenCalledOnce();
    await service.dispose();
  });

  it('reports inert state when a tab view has already dropped webContents', () => {
    const service = new BrowserService({ isDestroyed: () => false } as BrowserWindow, {
      canonicalProjectPath: process.cwd(),
    });
    const tabs = (service as unknown as { tabs: Map<string, unknown> }).tabs;
    tabs.set('tab-gone', {
      id: 'tab-gone',
      profileId: 'project',
      view: { webContents: undefined },
      documentEpoch: 1,
      semanticAvailable: true,
    });

    expect(service.getState().tabs).toEqual([
      expect.objectContaining({ id: 'tab-gone', title: '', semanticAvailable: false }),
    ]);
    tabs.delete('tab-gone');
  });

  it('still removes a closed tab from state when disposal steps fail', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = new BrowserService({ isDestroyed: () => false } as BrowserWindow, {
      canonicalProjectPath: process.cwd(),
    });
    const createTab = vi.spyOn(service, 'createTab').mockResolvedValue(undefined);
    const tabs = (service as unknown as { tabs: Map<string, unknown> }).tabs;
    tabs.set('tab-doomed', {
      id: 'tab-doomed',
      cdp: { dispose: vi.fn(async () => { throw new Error('Object has been destroyed.'); }) },
      view: { webContents: { isDestroyed: () => true, close: vi.fn() } },
    });

    await expect(service.closeTab('tab-doomed')).resolves.toBeUndefined();

    // The dead entry must not strand in the map poisoning later state reads.
    // createTab is mocked, so no real main-tab entry appears — only that the
    // doomed tab is gone and closeTab resolved cleanly.
    expect(service.getState().tabs.map((entry) => entry.id)).toEqual([]);
    createTab.mockRestore();
    await service.dispose();
  });

  it('dispose() completes without throwing when sessions and the proxy are already gone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = new BrowserService({ isDestroyed: () => false } as BrowserWindow, {
      canonicalProjectPath: process.cwd(),
    });
    const failingSession = {
      removeListener: vi.fn(() => { throw new Error('Object has been destroyed.'); }),
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      webRequest: { onBeforeRequest: vi.fn() },
      setProxy: vi.fn(async () => { throw new Error('Network service is gone.'); }),
    };
    (service as unknown as { configuredSessions: Map<object, { download: unknown }> }).configuredSessions.set(
      failingSession,
      { download: vi.fn() },
    );
    (service as unknown as { networkProxy: { dispose(): void } }).networkProxy = {
      dispose: () => { throw new Error('Proxy socket already closed.'); },
    };

    await expect(service.dispose()).resolves.toBeUndefined();
    expect(service.getState().tabs).toEqual([]);
  });

  it('reports an inert tab entry while a destroyed tab emits its last lifecycle event', () => {
    const service = new BrowserService({ isDestroyed: () => false } as BrowserWindow, {
      canonicalProjectPath: process.cwd(),
    });
    const tabs = (service as unknown as { tabs: Map<string, unknown> }).tabs;
    tabs.set('tab-dying', {
      id: 'tab-dying',
      profileId: 'project',
      view: {
        webContents: {
          isDestroyed: () => true,
          getTitle: () => { throw new Error('Object has been destroyed.'); },
          getURL: () => { throw new Error('Object has been destroyed.'); },
        },
      },
      documentEpoch: 3,
      semanticAvailable: true,
    });

    const entry = service.getState().tabs.find((candidate) => candidate.id === 'tab-dying');
    expect(entry).toMatchObject({ id: 'tab-dying', title: '', semanticAvailable: false });

    tabs.delete('tab-dying');
    void service.dispose();
  });
});
