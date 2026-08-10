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
      view: { webContents: { loadURL: vi.fn(async () => { throw aborted; }), getURL: () => 'https://example.test/' } },
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
