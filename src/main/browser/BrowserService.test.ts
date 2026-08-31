import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { BrowserAnnotationRepository } from './BrowserAnnotationRepository';
import { BrowserError } from './BrowserErrors';
import { BrowserService } from './BrowserService';
import type { LocalPageRegistry } from './LocalPageRegistry';

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

  it('lets humans enter loopback pages and popups while LAN popups still need a grant', async () => {
    const service = new BrowserService({ isDestroyed: () => false } as BrowserWindow, {
      canonicalProjectPath: process.cwd(),
    });
    const loopbackTab = { id: 'tab-1', humanNetworkOrigins: new Set<string>() };
    const lanTab = { id: 'tab-2', humanNetworkOrigins: new Set<string>() };
    const resolveNavigation = (service as unknown as {
      resolveNavigation(value: unknown, url: string, source: 'user' | 'page'): Promise<{ url: string }>;
    }).resolveNavigation.bind(service);

    // A clicked popup (page source) to the user's own machine just works.
    await expect(resolveNavigation(loopbackTab, 'http://127.0.0.1:4173/', 'page')).resolves.toMatchObject({
      url: 'http://127.0.0.1:4173/',
    });
    expect(loopbackTab.humanNetworkOrigins).toContain('http://127.0.0.1:4173');
    await expect(resolveNavigation(loopbackTab, 'http://localhost:8081/', 'user')).resolves.toMatchObject({
      url: 'http://localhost:8081/',
    });
    // Page-driven LAN navigation still requires an explicit grant.
    await expect(resolveNavigation(lanTab, 'http://192.168.1.10:8080/', 'page')).rejects.toThrow(/needs agent permission/u);
    await service.dispose();
  });

  it('approves a human main-frame navigation to a private origin instead of blocking it', () => {
    const service = new BrowserService({ isDestroyed: () => false } as BrowserWindow, {
      canonicalProjectPath: process.cwd(),
    });
    const prevented: string[] = [];
    const navigationBlocked = vi.fn();
    const humanNetworkOrigins = new Set<string>();
    const listeners = new Map<string, (event: { preventDefault(): void; url: string; isMainFrame: boolean }) => void>();
    const contents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((name: string, listener: (event: { preventDefault(): void; url: string; isMainFrame: boolean }) => void) => listeners.set(name, listener)),
      getURL: () => 'https://public.example/',
    };
    const configureNavigation = (service as unknown as { configureNavigation(tab: unknown): void }).configureNavigation;
    configureNavigation.call(service, { id: 'tab-1', humanNetworkOrigins, view: { webContents: contents } });
    (service as unknown as { navigationBlocked: (tabId: string, url: string, reason: string) => void }).navigationBlocked = navigationBlocked;

    const willFrameNavigate = listeners.get('will-frame-navigate')!;
    // Human clicks a link to a local dev server on the main frame.
    willFrameNavigate({ preventDefault: () => prevented.push('main'), url: 'http://localhost:8081/', isMainFrame: true });
    expect(prevented).toEqual([]);
    expect(navigationBlocked).not.toHaveBeenCalled();
    expect([...humanNetworkOrigins]).toEqual(['http://localhost:8081']);

    // A subframe (iframe) to a private origin stays guarded.
    willFrameNavigate({ preventDefault: () => prevented.push('sub'), url: 'http://localhost:9999/', isMainFrame: false });
    expect(prevented).toEqual(['sub']);
    expect(navigationBlocked).toHaveBeenCalledWith('tab-1', 'http://localhost:9999/', expect.stringMatching(/needs agent permission/u));
    expect(humanNetworkOrigins.has('http://localhost:9999')).toBe(false);

    // Cloud metadata stays hard-blocked even on the main frame.
    willFrameNavigate({ preventDefault: () => prevented.push('meta'), url: 'http://169.254.169.254/latest', isMainFrame: true });
    expect(prevented).toEqual(['sub', 'meta']);
    expect(humanNetworkOrigins.has('http://169.254.169.254')).toBe(false);
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

  it('numbers overlay markers like the composer queue, resetting after a send', async () => {
    const service = new BrowserService({ isDestroyed: () => false } as BrowserWindow, {
      canonicalProjectPath: process.cwd(),
    });
    const add = vi.fn(async () => undefined);
    const tabs = (service as unknown as { tabs: Map<string, unknown> }).tabs;
    tabs.set('tab-1', { annotationOverlay: { add, remove: vi.fn(async () => undefined) } });
    const labels = (id: string, createdAt: number) => service.annotations.save({
      id, tabId: 'tab-1', url: 'https://example.test/', origin: 'https://example.test',
      documentEpoch: 1, pageRevision: createdAt, kind: 'element',
      target: {
        frameId: 'frame-1', backendNodeId: createdAt, rectCssPx: { x: 1, y: 2, width: 30, height: 20 },
        rectNormalized: { x: 0, y: 0, width: 0.1, height: 0.1 }, locatorHints: {},
        fingerprint: { attributesHash: 'a', nearbyTextHash: 'b', ancestorHash: 'c' },
      },
      comment: '', semanticCoverage: 1, reattachConfidence: 1, createdAt,
    });
    const internals = service as unknown as {
      queueAnnotation: (id: string) => void;
      annotationLabel: (id: string) => number;
    };

    // Three annotations queued: browser markers must read 1, 2, 3 like the input box.
    labels('annotation-a', 1);
    labels('annotation-b', 2);
    labels('annotation-c', 3);
    internals.queueAnnotation('annotation-a');
    internals.queueAnnotation('annotation-b');
    internals.queueAnnotation('annotation-c');
    expect(internals.annotationLabel('annotation-a')).toBe(1);
    expect(internals.annotationLabel('annotation-b')).toBe(2);
    expect(internals.annotationLabel('annotation-c')).toBe(3);

    // Sending dismisses all queued markers; numbering restarts from 1.
    await service.dismissAnnotationOverlays(['annotation-a', 'annotation-b', 'annotation-c']);
    labels('annotation-d', 4);
    internals.queueAnnotation('annotation-d');
    labels('annotation-e', 5);
    internals.queueAnnotation('annotation-e');
    expect(internals.annotationLabel('annotation-d')).toBe(1);
    expect(internals.annotationLabel('annotation-e')).toBe(2);

    // Removing an attachment renumbers the remaining queue like the composer.
    service.removeAnnotation('annotation-d');
    expect(internals.annotationLabel('annotation-e')).toBe(1);

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

  it('persists local previews as their file address, never the capability token', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-local-preview-'));
    try {
      const entry = path.join(directory, 'index.html');
      await fs.writeFile(entry, '<!doctype html><title>preview</title>', { encoding: 'utf8' });
      const onNavigated = vi.fn();
      const service = new BrowserService({ isDestroyed: () => false } as BrowserWindow, {
        canonicalProjectPath: directory,
        onNavigated,
      });
      const localPages = (service as unknown as { localPages: LocalPageRegistry }).localPages;
      const location = await localPages.open('tab-1', entry, 'user');
      expect(location.displayUrl.startsWith('file://')).toBe(true);

      const listeners = new Map<string, (event: unknown, url: string) => void>();
      const contents = {
        setWindowOpenHandler: vi.fn(),
        on: vi.fn((name: string, listener: (event: unknown, url: string) => void) => listeners.set(name, listener)),
        getURL: () => location.internalUrl,
      };
      (service as unknown as { configureNavigation(tab: unknown): void }).configureNavigation.call(
        service,
        { id: 'tab-1', humanNetworkOrigins: new Set<string>(), view: { webContents: contents } },
      );

      // A committed local page persists its file:// display address.
      listeners.get('did-navigate')!(undefined, location.internalUrl);
      expect(onNavigated).toHaveBeenCalledExactlyOnceWith(location.displayUrl);

      // A stale capability token resolves to no display address; the internal
      // URL is not restorable and must never reach the history store.
      listeners.get('did-navigate')!(undefined, 'fate-local://deadtoken0000000000000000/index.html');
      expect(onNavigated).toHaveBeenCalledTimes(1);

      await service.dispose();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
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

describe('BrowserService device emulation and annotate mode', () => {
  it('re-arms the picker silently when Chromium drops an inspect wait, staying in annotate mode', async () => {
    vi.useFakeTimers();
    try {
      const events: Array<{ type: string; message?: string }> = [];
      const service = new BrowserService({ isDestroyed: () => false } as BrowserWindow, {
        canonicalProjectPath: process.cwd(),
        annotationOwner: () => ({ projectPath: 'C:/proj', sessionId: 'session-1' }),
      });
      service.setEventSink((event) => { events.push({ type: event.type, ...(event.type === 'annotation-error' ? { message: event.message } : {}) }); });
      const selectElement = vi.fn()
        .mockRejectedValueOnce(new BrowserError('UNSUPPORTED_ACTION', 'Timed out waiting for Overlay.inspectNodeRequested.', true))
        .mockImplementationOnce(() => new Promise<never>(() => undefined));
      const internals = service as unknown as { tabs: Map<string, unknown>; activeTabId: string | null };
      internals.tabs.set('browser-main', {
        id: 'browser-main',
        profileId: 'project',
        view: { webContents: { isDestroyed: () => false, getURL: () => 'https://example.test/', getTitle: () => '', isLoading: () => false, navigationHistory: { canGoBack: () => false, canGoForward: () => false } }, setVisible: vi.fn() },
        semanticAvailable: true,
        documentEpoch: 1,
        pageRevision: 1,
        annotationService: { selectElement },
        annotationOverlay: { add: vi.fn(async () => undefined) },
      });
      internals.activeTabId = 'browser-main';
      service.setVisible(true);

      service.setMode('annotate');
      await vi.advanceTimersByTimeAsync(0);
      expect(selectElement).toHaveBeenCalledTimes(1);

      // The benign timeout re-arms the picker instead of erroring or leaving annotate mode.
      await vi.advanceTimersByTimeAsync(500);
      expect(selectElement).toHaveBeenCalledTimes(2);
      expect(events.filter((event) => event.type === 'annotation-error')).toEqual([]);
      expect(service.getState().mode).toBe('annotate');

      service.setMode('agent');
      internals.tabs.delete('browser-main');
      await service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rests the picker after repeated benign failures instead of spinning forever', async () => {
    vi.useFakeTimers();
    try {
      const service = new BrowserService({ isDestroyed: () => false } as BrowserWindow, {
        canonicalProjectPath: process.cwd(),
        annotationOwner: () => ({ projectPath: 'C:/proj', sessionId: 'session-1' }),
      });
      service.setEventSink(() => undefined);
      const benign = () => Promise.reject(new BrowserError('UNSUPPORTED_ACTION', 'Timed out waiting for Overlay.inspectNodeRequested.', true));
      const selectElement = vi.fn(benign);
      const internals = service as unknown as { tabs: Map<string, unknown>; activeTabId: string | null };
      internals.tabs.set('browser-main', {
        id: 'browser-main',
        profileId: 'project',
        view: { webContents: { isDestroyed: () => false, getURL: () => 'https://example.test/', getTitle: () => '', isLoading: () => false, navigationHistory: { canGoBack: () => false, canGoForward: () => false } }, setVisible: vi.fn() },
        semanticAvailable: true,
        documentEpoch: 1,
        pageRevision: 1,
        annotationService: { selectElement },
        annotationOverlay: { add: vi.fn(async () => undefined) },
      });
      internals.activeTabId = 'browser-main';
      service.setVisible(true);

      service.setMode('annotate');
      // 1 initial attempt + 12 budgeted retries, 250ms apart, then it rests.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(selectElement).toHaveBeenCalledTimes(13);
      expect(service.getState().mode).toBe('annotate');

      service.setMode('agent');
      internals.tabs.delete('browser-main');
      await service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses an injected annotation repository so ids outlive service disposal', async () => {
    const shared = new BrowserAnnotationRepository();
    const service = new BrowserService({ isDestroyed: () => false } as BrowserWindow, {
      canonicalProjectPath: process.cwd(),
      annotations: shared,
    });
    const saved = service.annotations.save({
      id: 'annotation-shared', tabId: 'tab-1', url: 'https://example.test/', origin: 'https://example.test',
      documentEpoch: 1, pageRevision: 1, kind: 'element',
      target: {
        frameId: 'frame-1', backendNodeId: 1, rectCssPx: { x: 1, y: 2, width: 30, height: 20 },
        rectNormalized: { x: 0, y: 0, width: 0.1, height: 0.1 }, locatorHints: {},
        fingerprint: { attributesHash: 'a', nearbyTextHash: 'b', ancestorHash: 'c' },
      },
      comment: '', semanticCoverage: 1, reattachConfidence: 1, createdAt: 1,
    });
    expect(saved.id).toBe('annotation-shared');
    expect(service.annotations).toBe(shared);

    await service.dispose();

    // The next service built on the same store still resolves old draft ids.
    const reborn = new BrowserService({ isDestroyed: () => false } as BrowserWindow, {
      canonicalProjectPath: process.cwd(),
      annotations: shared,
    });
    await expect(reborn.resolveAnnotations(['annotation-shared'])).resolves.toHaveLength(1);
    await reborn.dispose();
  });
  interface FakeTabInternals {
    tabs: Map<string, { cdp: { send: ReturnType<typeof vi.fn> }; view?: unknown }>;
  }

  const serviceWithTab = () => {
    const service = new BrowserService({ isDestroyed: () => false } as BrowserWindow, {
      canonicalProjectPath: process.cwd(),
    });
    const send = vi.fn(async () => undefined);
    const internals = service as unknown as FakeTabInternals;
    internals.tabs.set('browser-main', {
      cdp: { send },
      view: {
        webContents: {
          isDestroyed: () => false,
          getURL: () => 'about:blank',
          getTitle: () => '',
          isLoading: () => false,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        },
      },
    });
    return { service, send, internals };
  };

  it('keeps agent control interactive while the annotate picker is armed', () => {
    const { service, internals } = serviceWithTab();
    service.setControlLevel('interact');
    service.setMode('annotate');
    expect(service.getState().mode).toBe('annotate');
    expect(service.getState().controlLevel).toBe('interact');
    service.setMode('agent');
    expect(service.getState().mode).toBe('agent');
    expect(service.getState().controlLevel).toBe('interact');
    internals.tabs.delete('browser-main');
  });

  it('emulates a phone viewport with touch input on every tab and clears it again', async () => {
    const { service, send, internals } = serviceWithTab();
    await service.setDeviceEmulation({ width: 390, height: 844, mobile: true, touch: true });
    expect(service.getState().deviceEmulation).toEqual({ width: 390, height: 844, mobile: true, touch: true });
    expect(send).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', {
      width: 0, height: 0, deviceScaleFactor: 0, mobile: true,
    });
    expect(send).toHaveBeenCalledWith('Emulation.setTouchEmulationEnabled', {
      enabled: true, maxTouchPoints: 5, configuration: 'mobile',
    });
    expect(send).toHaveBeenCalledWith('Emulation.setEmitTouchEventsForMouse', {
      enabled: true, configuration: 'mobile',
    });

    await service.setDeviceEmulation(null);
    expect(service.getState().deviceEmulation).toBeNull();
    expect(send).toHaveBeenCalledWith('Emulation.clearDeviceMetricsOverride', {});
    expect(send).toHaveBeenCalledWith('Emulation.setEmitTouchEventsForMouse', { enabled: false });
    expect(send).toHaveBeenCalledWith('Emulation.setTouchEmulationEnabled', { enabled: false });
    internals.tabs.delete('browser-main');
  });

  it('keeps device emulation across pane hides and the last-tab recreation gap', async () => {
    const { service, send, internals } = serviceWithTab();
    await service.setDeviceEmulation({ width: 390, height: 844, mobile: true, touch: true });
    service.setVisible(false);
    // Hiding the pane (or the unmount gap while the last tab is recreated)
    // must not silently drop the emulation the user armed.
    expect(service.getState().deviceEmulation).toEqual({ width: 390, height: 844, mobile: true, touch: true });
    expect(send).not.toHaveBeenCalledWith('Emulation.clearDeviceMetricsOverride', {});
    internals.tabs.delete('browser-main');
  });

  it('ignores CDP failures from tabs that are being torn down', async () => {
    const { service, internals } = serviceWithTab();
    internals.tabs.get('browser-main')!.cdp.send = vi.fn(async () => { throw new Error('CDP_UNAVAILABLE'); });
    await expect(service.setDeviceEmulation({ width: 390, height: 844, mobile: true, touch: true })).resolves.toBeUndefined();
    expect(service.getState().deviceEmulation).toEqual({ width: 390, height: 844, mobile: true, touch: true });
    internals.tabs.delete('browser-main');
  });
});
