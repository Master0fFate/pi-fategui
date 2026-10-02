import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { ProjectState } from '../../shared/contracts/ipc';
import path from 'node:path';
import { BrowserError } from './BrowserErrors';
import { BrowserService } from './BrowserService';
import { BrowserHost } from './BrowserHost';
import type { BrowserHistoryRepository } from './BrowserHistoryRepository';

const project = { path: '/project', name: 'project', trusted: true };
const owner = { isDestroyed: () => false, webContents: { id: 7 } } as unknown as BrowserWindow;
const hostKey = (sessionId: string) => JSON.stringify([
  process.platform === 'win32' ? path.normalize(path.resolve(project.path)).toLocaleLowerCase('en-US') : path.normalize(path.resolve(project.path)),
  sessionId,
]);

type Root = { projectPath: string; sessionId: string } | null;
function fixture(permissionBySession?: Record<string, 'read-only' | 'full-access'>) {
  let root: Root = { projectPath: project.path, sessionId: 'session-1' };
  const emit = vi.fn();
  const syncService = vi.fn();
  const history = { loadSession: vi.fn(async () => null), save: vi.fn(async () => undefined) };
  const host = new BrowserHost({
    currentProject: () => project,
    currentPermissionLevel: () => 'full-access',
    ...(permissionBySession ? { sessionPermissionLevel: (_path: string, sessionId: string) => permissionBySession[sessionId] ?? 'read-only' } : {}),
    bridge: { currentRoot: () => root, syncService },
    emit,
    command: vi.fn(),
    history: history as unknown as BrowserHistoryRepository,
  });
  const attach = (sessionId: string, tabs: Array<{ id: string }> = [{ id: 'browser-main' }]) => {
    const service = {
      getState: () => ({ tabs }), ensureTab: vi.fn(async () => undefined), setSessionFullAccess: vi.fn(),
      setViewBlocked: vi.fn(), isVisibilityRequested: vi.fn(() => true), setVisible: vi.fn(),
      dispose: vi.fn(async () => undefined),
      lease: { getState: () => ({ ownerSessionId: sessionId }) },
    } as unknown as BrowserService;
    const entry = { service, owner, projectPath: project.path, sessionId, ready: true };
    const key = hostKey(sessionId);
    (host as unknown as { services: Map<string, unknown> }).services.set(key, entry);
    return { entry, service };
  };
  return { host, attach, emit, history, syncService, setRoot: (next: Root) => { root = next; } };
}

// These tests exercise state/lease logic, not native Chromium creation.
vi.mock('electron', () => ({
  app: { getPath: () => { throw new Error('Native app paths are outside this unit fixture.'); } },
  dialog: { showSaveDialog: () => { throw new Error('Native dialogs are outside this unit fixture.'); } },
  WebContentsView: class { constructor() { throw new Error('Native views are outside this unit fixture.'); } },
}));

describe('BrowserHost session isolation', () => {
  it('returns only the foreground service to UI and looks up background sessions explicitly', async () => {
    const { host, attach, setRoot } = fixture();
    const first = attach('session-1');
    const second = attach('session-2');
    expect(host.current(owner)).toBe(first.service);
    expect(host.currentForSession('/project', 'session-2')).toBe(second.service);
    expect(host.currentForSession('/project', 'session-3')).toBeNull();
    expect(host.currentForSession('/other', 'session-1')).toBeNull();
    setRoot({ projectPath: '/project', sessionId: 'session-2' });
    expect(host.current(owner)).toBe(second.service);
    expect(first.service.setViewBlocked).toHaveBeenCalledWith('inactive-session', true);
    expect(first.service.setSessionFullAccess).toHaveBeenCalledWith(false);
    expect(second.service.setViewBlocked).toHaveBeenCalledWith('inactive-session', false);
    expect(second.service.setVisible).toHaveBeenCalledWith(true);
    expect(first.service.dispose).not.toHaveBeenCalled();
    expect(second.service.dispose).not.toHaveBeenCalled();
    await host.reset();
    expect(first.service.dispose).toHaveBeenCalledOnce();
    expect(second.service.dispose).toHaveBeenCalledOnce();
  });

  it('uses each session authority for background actions, not focused UI authority', () => {
    const { host, attach } = fixture({ 'session-1': 'read-only', 'session-2': 'full-access' });
    const first = attach('session-1');
    const second = attach('session-2');
    host.current(owner);
    expect(first.service.setSessionFullAccess).toHaveBeenCalledWith(false);
    expect(host.currentForSession('/project', 'session-2')).toBe(second.service);
    expect(second.service.setSessionFullAccess).toHaveBeenCalledWith(true);
    expect(host.current(owner)).toBe(first.service);
  });

  it('never returns a stale foreground service when root becomes unavailable', () => {
    const { host, attach, setRoot } = fixture();
    const first = attach('session-1');
    expect(host.current(owner)).toBe(first.service);
    setRoot(null);
    expect(host.current(owner)).toBeNull();
    expect(first.service.setViewBlocked).toHaveBeenCalledWith('inactive-session', true);
  });

  it('hides the old native view immediately and clears its UI state when the root changes', () => {
    const { host, attach, setRoot, emit } = fixture();
    const first = attach('session-1');
    host.current(owner);
    setRoot({ projectPath: '/project', sessionId: 'session-2' });
    host.onRootChanged();
    expect(first.service.setViewBlocked).toHaveBeenCalledWith('inactive-session', true);
    expect(emit).toHaveBeenLastCalledWith(owner, expect.objectContaining({
      type: 'state', state: expect.objectContaining({ tabs: [], grants: [], activeTabId: null }),
    }));
  });

  it('keeps a running background project browser without exposing it to foreground UI', async () => {
    const activeRoot = { projectPath: project.path, sessionId: 'session-1' };
    const host = new BrowserHost({
      currentProject: () => project,
      bridge: {
        currentRoot: () => activeRoot,
        syncService: vi.fn(),
        permissionForSession: (root) => root.sessionId === 'session-1' || root.sessionId === 'session-2' && root.projectPath === '/other'
          ? 'full-access' : null,
      },
      emit: vi.fn(), command: vi.fn(),
    });
    const ensureTab = vi.spyOn(BrowserService.prototype, 'ensureTab').mockResolvedValue(undefined);
    try {
      const foreground = await host.ensure(owner);
      const background = await host.ensureForSession(owner, '/other', 'session-2');
      expect(background).not.toBe(foreground);
      expect(host.current(owner)).toBe(foreground);
      expect(host.currentForSession('/other', 'session-2')).toBe(background);
      expect(background.getState().viewBlocked).toBe(true);
      expect(host.currentForSession('/other', 'not-registered')).toBeNull();
      await host.reset();
    } finally {
      ensureTab.mockRestore();
    }
  });

  it('retains annotations after reset only for the same project and session', async () => {
    const { host } = fixture();
    const internals = host as unknown as { annotationStoreFor(path: string, sessionId: string): unknown; annotationStores: Map<string, unknown> };
    const first = internals.annotationStoreFor('/project', 'session-1');
    expect(internals.annotationStoreFor('/project/', 'session-1')).toBe(first);
    expect(internals.annotationStoreFor('/project', 'session-2')).not.toBe(first);
    expect(internals.annotationStoreFor('/other', 'session-1')).not.toBe(first);
    await host.reset();
    expect(internals.annotationStoreFor('/project', 'session-1')).toBe(first);
    expect(internals.annotationStores.size).toBe(3);
  });

  it('waits for a session startup even after its first tab is exposed', async () => {
    const { host, attach, syncService } = fixture();
    const { service } = attach('session-1');
    let finish!: (service: BrowserService) => void;
    const startup = new Promise<BrowserService>((resolve) => { finish = resolve; });
    Object.assign(host, { ensuring: { ownerId: owner.webContents.id, key: hostKey('session-1'), promise: startup } });
    const returned = vi.fn();
    const pending = host.ensure(owner).then(returned);
    await Promise.resolve();
    expect(returned).not.toHaveBeenCalled();
    expect(syncService).not.toHaveBeenCalled();
    finish(service);
    await pending;
    expect(returned).toHaveBeenCalledWith(service);
  });

  it('opens the default tab only when its session has no managed tabs', async () => {
    const { host, attach, syncService } = fixture();
    const { service } = attach('session-1', []);
    await expect(host.ensure(owner)).resolves.toBe(service);
    expect(service.ensureTab).toHaveBeenCalledOnce();
    expect(service.setSessionFullAccess).toHaveBeenCalledWith(true);
    expect(syncService).toHaveBeenCalled();
  });

  it('rejects stale confirmation replies after a focus switch', () => {
    const { host, attach, setRoot, emit } = fixture();
    const first = attach('session-1');
    const second = attach('session-2');
    host.current(owner);
    const resolve = vi.fn();
    Object.assign(host, { pending: {
      confirmation: { id: 'confirm-1', tabId: 'browser-main', action: {}, documentEpoch: 0, expiresAt: Date.now() + 10000 },
      entry: first.entry, timer: setTimeout(() => undefined, 10000), resolve,
    } });
    setRoot({ projectPath: '/project', sessionId: 'session-2' });
    expect(host.current(owner)).toBe(second.service);
    expect(resolve).toHaveBeenCalledWith(false);
    expect(host.respondToConfirmation(owner, 'confirm-1', true)).toBe(false);
    expect(emit).toHaveBeenCalledWith(owner, expect.objectContaining({ type: 'confirmation-cleared', approved: false }));
  });

  it('forgets a dead local preview in its own session only', async () => {
    const { host, history } = fixture();
    const service = { ensureTab: vi.fn()
      .mockRejectedValueOnce(new BrowserError('INVALID_URL', 'Missing file.'))
      .mockResolvedValue(undefined) } as unknown as BrowserService;
    await (host as unknown as { ensureServiceTab(service: BrowserService, project: ProjectState, sessionId: string): Promise<void> })
      .ensureServiceTab(service, project, 'session-2');
    expect(history.save).toHaveBeenCalledWith('/project', null, 'session-2');
    expect(service.ensureTab).toHaveBeenNthCalledWith(2, 'browser-main', 'about:blank');
  });

  it('starts a background service blocked, with its own identity and history', async () => {
    const { host, history, attach } = fixture();
    const first = attach('session-1');
    host.current(owner);
    const ensureTab = vi.spyOn(BrowserService.prototype, 'ensureTab').mockResolvedValue(undefined);
    try {
      const background = await host.ensureForSession(owner, '/project', 'session-2');
      expect(background).not.toBe(first.service);
      expect(host.current(owner)).toBe(first.service);
      expect(host.currentForSession('/project', 'session-2')).toBe(background);
      expect(background.getState().viewBlocked).toBe(true);
      expect(history.loadSession).toHaveBeenCalledWith('/project', 'session-2');
      (background as unknown as { options: { onTabsChanged(tabs: string[], index: number): void } })
        .options.onTabsChanged(['https://only-second.example/'], 0);
      expect(history.save).toHaveBeenCalledWith('/project', {
        tabs: ['https://only-second.example/'], activeIndex: 0,
      }, 'session-2');
      expect(ensureTab).toHaveBeenCalled();
      await host.reset();
    } finally {
      ensureTab.mockRestore();
    }
  });
});
