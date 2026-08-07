import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { BrowserService } from './BrowserService';
import { BrowserHost } from './BrowserHost';

const project = { path: '/project', name: 'project', trusted: true };
const owner = { isDestroyed: () => false, webContents: { id: 7 } } as unknown as BrowserWindow;

function fixture(tabs: Array<{ id: string }>) {
  const syncService = vi.fn();
  const currentRoot = vi.fn(() => ({ projectPath: project.path, sessionId: 'session-1' }));
  const ensureTab = vi.fn(async () => undefined);
  const setSessionFullAccess = vi.fn();
  const service = { getState: () => ({ tabs }), ensureTab, setSessionFullAccess } as unknown as BrowserService;
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
