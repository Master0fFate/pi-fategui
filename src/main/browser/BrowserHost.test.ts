import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { BrowserError } from './BrowserErrors';
import type { BrowserService } from './BrowserService';
import { BrowserHost, type BrowserHostOptions } from './BrowserHost';
import type { BrowserHistoryRepository } from './BrowserHistoryRepository';

const project = { path: '/project', name: 'project', trusted: true };
const owner = { isDestroyed: () => false, webContents: { id: 7 } } as unknown as BrowserWindow;

function fixture(tabs: Array<{ id: string }>) {
  const syncService = vi.fn();
  const currentRoot = vi.fn(() => ({ projectPath: project.path, sessionId: 'session-1' }));
  const ensureTab = vi.fn(async () => undefined);
  const setSessionFullAccess = vi.fn();
  const service = { getState: () => ({ tabs }), ensureTab, setSessionFullAccess, dispose: vi.fn(async () => undefined) } as unknown as BrowserService;
  const host = new BrowserHost({
    currentProject: () => project,
    currentPermissionLevel: () => 'full-access',
    bridge: { currentRoot, syncService },
    emit: vi.fn(),
    command: vi.fn(),
  });
  Object.assign(host as unknown as Record<string, unknown>, {
    service,
    owner,
    projectPath: project.path,
  });
  return { host, service, ensureTab, setSessionFullAccess, syncService };
}

describe('BrowserHost tab lifecycle', () => {
  it('keeps one persistent annotation store per project across service resets', async () => {
    const { host } = fixture([{ id: 'tab-1' }]);
    const internals = host as unknown as { annotationStoreFor(path: string): unknown; annotationStores: Map<string, unknown>; reset(): Promise<void> };

    const first = internals.annotationStoreFor('/project');
    const again = internals.annotationStoreFor('/project');
    expect(again).toBe(first);
    // Path normalization must not fork stores for the same folder.
    expect(internals.annotationStoreFor('/project/')).toBe(first);

    await host.reset();
    expect(internals.annotationStoreFor('/project')).toBe(first);
    expect(internals.annotationStores.size).toBe(1);

    // A different project gets its own store.
    expect(internals.annotationStoreFor('/other')).not.toBe(first);
    expect(internals.annotationStores.size).toBe(2);
  });

  it('does not resurrect the default tab when another managed tab remains', async () => {
    const { host, service, ensureTab, syncService } = fixture([{ id: 'tab-user-created' }]);

    await expect(host.ensure(owner)).resolves.toBe(service);

    expect(ensureTab).not.toHaveBeenCalled();
    expect(syncService).toHaveBeenCalledOnce();
  });

  it('creates the default tab only when the service has no managed tabs', async () => {
    const { host, ensureTab } = fixture([]);

    await host.ensure(owner);

    expect(ensureTab).toHaveBeenCalledOnce();
  });

  it('synchronizes selected-session Full access before returning the browser', async () => {
    const { host, setSessionFullAccess } = fixture([{ id: 'tab-1' }]);

    await host.ensure(owner);

    expect(setSessionFullAccess).toHaveBeenCalledWith(true);
  });
});

describe('BrowserHost restore hardening', () => {
  function restoreFixture(ensureTab: BrowserService['ensureTab']) {
    const history = { load: vi.fn(async () => null), save: vi.fn(async () => undefined) };
    const service = {
      getState: () => ({ tabs: [] }),
      ensureTab,
      setSessionFullAccess: vi.fn(),
      dispose: vi.fn(async () => undefined),
    } as unknown as BrowserService;
    const host = new BrowserHost({
      currentProject: () => project,
      currentPermissionLevel: () => 'full-access',
      bridge: { currentRoot: vi.fn(() => ({ projectPath: project.path, sessionId: 'session-1' })), syncService: vi.fn() },
      emit: vi.fn(),
      command: vi.fn(),
      history: history as unknown as BrowserHistoryRepository,
    });
    return { host, service, history };
  }

  it('forgets a remembered local preview whose file no longer exists', async () => {
    const ensureTab = vi.fn()
      .mockRejectedValueOnce(new BrowserError('INVALID_URL', 'That local file does not exist or cannot be opened.'))
      .mockResolvedValue(undefined);
    const { host, service, history } = restoreFixture(ensureTab as unknown as BrowserService['ensureTab']);

    await (host as unknown as { ensureServiceTab(service: BrowserService, project: { path: string }): Promise<void> })
      .ensureServiceTab(service, project);

    expect(history.save).toHaveBeenCalledTimes(1);
    expect(history.save).toHaveBeenCalledWith(project.path, null);
    expect(ensureTab).toHaveBeenNthCalledWith(1);
    expect(ensureTab).toHaveBeenNthCalledWith(2, 'browser-main', 'about:blank');
  });

  it('propagates failures that are not dead remembered pages', async () => {
    const ensureTab = vi.fn().mockRejectedValue(new BrowserError('ACTION_BLOCKED', 'Browser tab browser-main already exists.'));
    const { host, service, history } = restoreFixture(ensureTab as unknown as BrowserService['ensureTab']);

    await expect((host as unknown as { ensureServiceTab(service: BrowserService, project: { path: string }): Promise<void> })
      .ensureServiceTab(service, project)).rejects.toThrow(/already exists/u);
    expect(history.save).not.toHaveBeenCalled();
    expect(ensureTab).toHaveBeenCalledTimes(1);
  });

  it('keeps the remembered entry when the first restore attempt succeeds', async () => {
    const ensureTab = vi.fn().mockResolvedValue(undefined);
    const { host, service, history } = restoreFixture(ensureTab as unknown as BrowserService['ensureTab']);

    await (host as unknown as { ensureServiceTab(service: BrowserService, project: { path: string }): Promise<void> })
      .ensureServiceTab(service, project);

    expect(history.save).not.toHaveBeenCalled();
    expect(ensureTab).toHaveBeenCalledTimes(1);
    expect(ensureTab).toHaveBeenCalledWith();
  });
});
