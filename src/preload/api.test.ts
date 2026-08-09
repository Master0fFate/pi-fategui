import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcChannels } from '../shared/contracts/ipc';

const electron = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcRenderer: electron,
}));

import { piDesktopApi } from './api';

describe('preload desktop bridge', () => {
  beforeEach(() => {
    electron.invoke.mockReset();
    electron.on.mockReset();
    electron.removeListener.mockReset();
  });

  it('validates structured provenance before runtime events reach the renderer', () => {
    const listener = vi.fn();
    const unsubscribe = piDesktopApi.onEvents(listener);
    const handler = electron.on.mock.calls.find(([channel]) => channel === ipcChannels.runtimeEvents)?.[1] as ((event: unknown, payload: unknown) => void);
    const valid = [{ type: 'tool.started', toolCallId: 'tool-1', name: 'edit', input: '{}', timestamp: 1, provenance: { actor: { kind: 'root' }, affectedPaths: [{ path: 'src/app.ts', operation: 'edit' }] } }];
    handler({}, valid);
    expect(listener).toHaveBeenCalledWith(valid);
    expect(() => handler({}, [{ ...valid[0], provenance: { actor: { kind: 'root' }, affectedPaths: [{ path: '../secret', operation: 'edit' }] } }])).toThrow();
    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledWith(ipcChannels.runtimeEvents, handler);
  });

  it('validates GoalMax events on the isolated bridge', () => {
    const listener = vi.fn();
    const unsubscribe = piDesktopApi.onGoalMaxEvents(listener);
    const handler = electron.on.mock.calls.find(([channel]) => channel === ipcChannels.runtimeGoalMaxEvents)?.[1] as ((event: unknown, payload: unknown) => void);
    const valid = [{ type: 'goalmax.cleared', projectPath: '/project', sessionId: 's1', goalId: 'goal-1', timestamp: 1 }];
    handler({}, valid);
    expect(listener).toHaveBeenCalledWith(valid);
    expect(() => handler({}, [{ ...valid[0], goalId: '' }])).toThrow();
    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledWith(ipcChannels.runtimeGoalMaxEvents, handler);
  });

  it('writes bounded plain text through the clipboard IPC channel', async () => {
    electron.invoke.mockResolvedValueOnce({ written: true });

    await piDesktopApi.writeClipboardText('Copied response');

    expect(electron.invoke).toHaveBeenCalledWith(ipcChannels.clipboardWriteText, { text: 'Copied response' });
  });

  it('routes link context actions through the validated browser bridge', async () => {
    electron.invoke.mockResolvedValueOnce({ shown: true });

    await expect(piDesktopApi.showBrowserLinkContextMenu('localhost:4173/preview')).resolves.toBeUndefined();
    expect(electron.invoke).toHaveBeenCalledWith(ipcChannels.browserShowLinkContextMenu, { url: 'http://localhost:4173/preview' });

    const listener = vi.fn();
    const unsubscribe = piDesktopApi.onBrowserLinkOpen(listener);
    const handler = electron.on.mock.calls.find(([channel]) => channel === ipcChannels.browserOpenLink)?.[1] as ((event: unknown, payload: unknown) => void);
    handler({}, 'https://example.test/docs');
    expect(listener).toHaveBeenCalledWith('https://example.test/docs');
    expect(() => handler({}, 'javascript:alert(1)')).toThrow();
    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledWith(ipcChannels.browserOpenLink, handler);
  });

  it('rejects malformed clipboard responses instead of reporting false success', async () => {
    electron.invoke.mockResolvedValueOnce({ written: false });

    await expect(piDesktopApi.writeClipboardText('Copied response')).rejects.toThrow();
  });

  it('validates project automation mutations on both sides of the isolated bridge', async () => {
    const definition = {
      id: '00000000-0000-4000-8000-000000000001', projectPath: '/project', name: 'Review auth', prompt: 'Review auth changes.',
      permissionLevel: 'read-only', createdAt: 1, updatedAt: 1, lastLaunchedAt: null, lastLaunchOutcome: null, launchCount: 0,
    };
    electron.invoke.mockResolvedValueOnce(definition);

    await expect(piDesktopApi.createAutomation({ name: '  Review auth  ', prompt: '  Review auth changes.  ', permissionLevel: 'read-only' })).resolves.toEqual(definition);
    expect(electron.invoke).toHaveBeenCalledWith(ipcChannels.automationsCreate, {
      name: 'Review auth', prompt: 'Review auth changes.', permissionLevel: 'read-only',
    });

    const state = {
      status: 'ready', project: { path: '/project', name: 'project', trusted: true }, sessionId: 's2', sessionFile: '/sessions/s2.jsonl',
      streaming: false, model: null, models: [], thinkingLevel: 'medium', permissionLevel: 'read-only', messages: [], error: null,
    };
    electron.invoke.mockResolvedValueOnce({ state, automation: definition });
    await expect(piDesktopApi.prepareAutomationSession(definition.id)).resolves.toEqual({ state, automation: definition });
    expect(electron.invoke).toHaveBeenLastCalledWith(ipcChannels.automationsPrepareSession, { id: definition.id });

    electron.invoke.mockResolvedValueOnce([{ ...definition, permissionLevel: 'full-access' }]);
    await expect(piDesktopApi.listAutomations()).rejects.toThrow();
  });

  it('checks for updates through the pathless typed IPC channel', async () => {
    electron.invoke.mockResolvedValueOnce({
      status: 'available',
      message: 'Update available. Click to download.',
      installedVersion: '1.9.0',
      productionVersion: '1.10.0',
    });

    await expect(piDesktopApi.checkForUpdates()).resolves.toMatchObject({ status: 'available' });
    expect(electron.invoke).toHaveBeenCalledWith(ipcChannels.updatesCheck, {});
  });

  it('opens downloads only after validating main-process confirmation', async () => {
    electron.invoke.mockResolvedValueOnce({ opened: true });
    await expect(piDesktopApi.openUpdateDownload()).resolves.toBeUndefined();
    expect(electron.invoke).toHaveBeenCalledWith(ipcChannels.updatesOpenDownload, {});

    electron.invoke.mockResolvedValueOnce({ opened: false });
    await expect(piDesktopApi.openUpdateDownload()).rejects.toThrow();
  });

  it('opens a known project by path without a file dialog', async () => {
    const state = {
      status: 'ready', project: { path: '/project', name: 'project', trusted: true }, sessionId: 's2', sessionFile: '/sessions/s2.jsonl',
      streaming: false, model: null, models: [], thinkingLevel: 'medium', permissionLevel: 'read-only', messages: [], error: null,
    };
    electron.invoke.mockResolvedValueOnce(state);

    await expect(piDesktopApi.openProject('/project')).resolves.toMatchObject({ project: { path: '/project' } });
    expect(electron.invoke).toHaveBeenCalledWith(ipcChannels.projectOpenPath, { projectPath: '/project' });

    electron.invoke.mockResolvedValueOnce({ ...state, status: 'not-a-status' });
    await expect(piDesktopApi.openProject('/project')).rejects.toThrow();
  });

  it('focuses a known project path without forcing a runtime spawn in the preload contract', async () => {
    const state = {
      status: 'disconnected', project: { path: '/other', name: 'other', trusted: true }, sessionId: null, sessionFile: null,
      streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], error: null,
    };
    electron.invoke.mockResolvedValueOnce(state);
    await expect(piDesktopApi.focusProject('/other')).resolves.toMatchObject({ project: { path: '/other' }, status: 'disconnected' });
    expect(electron.invoke).toHaveBeenCalledWith(ipcChannels.projectFocusPath, { projectPath: '/other' });
  });

  it('closes a background project runtime before the renderer forgets it', async () => {
    electron.invoke.mockResolvedValueOnce(undefined);
    await expect(piDesktopApi.closeProjectRuntime('/other')).resolves.toBeUndefined();
    expect(electron.invoke).toHaveBeenCalledWith(ipcChannels.projectCloseRuntime, { projectPath: '/other' });
  });

  it('reveals a validated project path through the isolated bridge', async () => {
    electron.invoke.mockResolvedValueOnce({ opened: true });
    await expect(piDesktopApi.revealProjectPath('/other')).resolves.toEqual({ opened: true });
    expect(electron.invoke).toHaveBeenCalledWith(ipcChannels.projectRevealPath, { projectPath: '/other' });

    electron.invoke.mockResolvedValueOnce({ opened: false });
    await expect(piDesktopApi.revealProjectPath('/other')).rejects.toThrow();
  });

  it('lists another folder’s sessions from disk through the validated bridge', async () => {
    const sessions = [{
      id: 's1', title: 'First', firstMessage: 'hello', path: '/sessions/s1.jsonl',
      createdAt: '2024-01-01T00:00:00.000Z', modifiedAt: '2024-01-02T00:00:00.000Z', messageCount: 3, active: false,
    }];
    electron.invoke.mockResolvedValueOnce(sessions);

    await expect(piDesktopApi.listProjectSessions('/other', 'first')).resolves.toEqual(sessions);
    expect(electron.invoke).toHaveBeenCalledWith(ipcChannels.projectListSessions, { projectPath: '/other', query: 'first' });

    electron.invoke.mockResolvedValueOnce([{ ...sessions[0], messageCount: 'lots' }]);
    await expect(piDesktopApi.listProjectSessions('/other')).rejects.toThrow();
  });
});
