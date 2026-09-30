import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, Menu, clipboard, ipcMain, shell } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '1.1.0'), isPackaged: false, getPath: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: vi.fn(() => []) },
  clipboard: { writeText: vi.fn() }, dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() }, shell: { openExternal: vi.fn() }, ipcMain: { handle: vi.fn() },
  webContents: { fromId: vi.fn() },
}));
import { registerIpc } from './registerIpc';
import { createTrustedRendererPolicy } from '../security/trustedRenderer';
import { ipcChannels } from '../../shared/contracts/ipc';
import { DesktopConnectionRouter } from '../connections/DesktopConnectionRouter';
import { ConnectionProfileStore } from '../connections/ConnectionProfileStore';
import type { RemoteScope } from '../../shared/contracts/connections';

beforeEach(() => { vi.clearAllMocks(); });
function fixture(readCredential: (file: string) => Promise<string> = async () => { throw new Error('Synthetic credential unavailable'); }) {
  const renderer = path.resolve('private-test-renderer.html'), url = pathToFileURL(renderer).href;
  const frame = { url, isDestroyed: vi.fn(() => false) };
  const sender = { mainFrame: frame, isDestroyed: vi.fn(() => false), on: vi.fn(), getURL: () => url, send: vi.fn() };
  const owner = { isDestroyed: vi.fn(() => false), isMaximized: vi.fn(() => false), isMinimized: vi.fn(() => false),
    isFullScreen: vi.fn(() => false), minimize: vi.fn(), webContents: sender };
  vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(owner as never);
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([owner as never]);
  const profile = { id: randomUUID(), hostId: randomUUID(), label: 'Approved host', approved: true as const,
    baseUrl: 'http://127.0.0.1:49301', credentialRef: path.resolve('synthetic-private-client.key') };
  const eventConnect = vi.fn(async () => ({ clientId: randomUUID(), serverEpoch: randomUUID(), ticket: `ft1_${'t'.repeat(43)}` }));
  const connections = new DesktopConnectionRouter(new ConnectionProfileStore([profile], readCredential), {
    makeEvents: () => ({ connection: null, connect: eventConnect, subscribe: vi.fn(), close: vi.fn() }),
  }, { initialSelection: { kind: 'remote', profileId: profile.id } });
  const runtime = { getState: vi.fn(), getHydrationState: vi.fn(), openProject: vi.fn(), prompt: vi.fn(),
    setEventSink: vi.fn(), setGoalEventSink: vi.fn(), setTaskEventSink: vi.fn() };
  const projects = { prepareOpenPath: vi.fn(), prepareSelect: vi.fn(), selectFile: vi.fn(), revealCurrent: vi.fn() };
  const files = { setRoot: vi.fn(), open: vi.fn(), revealLink: vi.fn(), list: vi.fn() };
  const browser = { ensure: vi.fn(), current: vi.fn(), reset: vi.fn() };
  const terminal = { create: vi.fn(), setEventSink: vi.fn() };
  const updates = { check: vi.fn(async () => ({ status: 'current', message: 'Desktop is current.' })) };
  const commands = registerIpc({ runtime, connections, projects, files, git: {}, settings: {}, terminal,
    logs: { write: vi.fn() }, music: { setDurationSink: vi.fn() }, speech: { setEventSink: vi.fn(), setStreamSink: vi.fn() },
    hotkey: {}, updates, browser, attestations: {}, rendererPolicy: createTrustedRendererPolicy(renderer) } as never);
  const handlers = new Map(vi.mocked(ipcMain.handle).mock.calls.map(([channel, handler]) => [channel, handler]));
  const event = { sender, senderFrame: frame } as unknown as Electron.IpcMainInvokeEvent;
  const invoke = (channel: string, input: unknown = {}, customEvent = event): Promise<unknown> => Promise.resolve(handlers.get(channel)!(customEvent, input));
  return { connections, profile, eventConnect, runtime, projects, files, browser, terminal, updates, owner, sender, frame, commands, invoke, event };
}

describe('production registerIpc desktop remote routing', () => {
  it('prevents every local runtime/project/browser/file/terminal handler and launch opener while remote is selected', async () => {
    const f = fixture();
    for (const channel of [ipcChannels.runtimeGetState, ipcChannels.runtimePrompt, ipcChannels.projectOpenPath,
      ipcChannels.projectSelect, ipcChannels.projectSelectFile, ipcChannels.projectReveal, ipcChannels.filesOpen,
      ipcChannels.filesRevealLink, ipcChannels.filesList, ipcChannels.browserInitialize, ipcChannels.browserOpenLocalFile,
      ipcChannels.terminalCreate, ipcChannels.runtimeProviderLoginStart, ipcChannels.runtimeMonitorDashboard]) {
      await expect(f.invoke(channel)).rejects.toThrow(/local desktop/i);
    }
    await expect(f.commands.openProjectPath('/remote-looking-path')).rejects.toThrow(/local desktop/i);
    for (const spy of [f.runtime.getState, f.runtime.getHydrationState, f.runtime.openProject, f.runtime.prompt,
      f.projects.prepareOpenPath, f.projects.prepareSelect, f.projects.selectFile, f.projects.revealCurrent,
      f.files.setRoot, f.files.open, f.files.revealLink, f.files.list, f.browser.ensure, f.terminal.create]) expect(spy).not.toHaveBeenCalled();
    f.connections.close();
  });
  it('keeps native window/updater functional and does not fall back after failed main-owned authentication', async () => {
    const f = fixture();
    await expect(f.invoke(ipcChannels.connectionConnect, { generation: f.connections.state.generation })).resolves.toMatchObject({ kind: 'remote', status: 'error' });
    await expect(f.invoke(ipcChannels.windowControl, { action: 'minimize' })).resolves.toMatchObject({ minimized: false });
    expect(f.owner.minimize).toHaveBeenCalledOnce();
    await expect(f.invoke(ipcChannels.updatesCheck)).resolves.toMatchObject({ status: 'current' });
    expect(f.updates.check).toHaveBeenCalledOnce(); expect(f.eventConnect).not.toHaveBeenCalled();
    expect(f.runtime.openProject).not.toHaveBeenCalled(); expect(f.files.setRoot).not.toHaveBeenCalled();
    f.connections.close();
  });
  it('checks trusted main frame and strict named schemas before selecting/reading credentials', async () => {
    const reader = vi.fn(async () => `fc1_${'x'.repeat(43)}`), f = fixture(reader);
    await expect(f.invoke(ipcChannels.connectionConnect, { generation: 0 }, { ...f.event, senderFrame: { url: f.frame.url } } as never)).rejects.toThrow(/main frame/i);
    await expect(f.invoke(ipcChannels.connectionSelect, { kind: 'remote', profileId: f.profile.id, credentialRef: '/injected-owner.key' })).rejects.toThrow();
    expect(reader).not.toHaveBeenCalled(); expect(f.connections.isLocal).toBe(false);
    expect(await f.invoke(ipcChannels.connectionProfiles)).toEqual([{ id: f.profile.id, label: 'Approved host', hostId: f.profile.hostId }]);
    f.connections.close();
  });
  it('fences navigation during credential resolution before opening a remote socket', async () => {
    let release!: (key: string) => void;
    const f = fixture(() => new Promise<string>((resolve) => { release = resolve; }));
    const pending = f.invoke(ipcChannels.connectionConnect, { generation: 0 });
    const refused = expect(pending).rejects.toThrow(/document/i);
    const navigation = f.sender.on.mock.calls.find(([name]) => name === 'did-start-navigation')?.[1] as (value: { isMainFrame: boolean; isSameDocument: boolean }) => void;
    navigation({ isMainFrame: true, isSameDocument: false }); release(`fc1_${'x'.repeat(43)}`);
    await refused; expect(f.eventConnect).not.toHaveBeenCalled(); expect(f.runtime.openProject).not.toHaveBeenCalled();
    f.connections.close();
  });
  it('registers named renew/takeover/issue/confirm bridges with captured document guards and preserves original confirmation IDs', async () => {
    const f = fixture(), epoch = randomUUID(), sessionId = randomUUID();
    const scope: RemoteScope = { generation: 0, profileId: f.profile.id, hostId: f.profile.hostId, serverEpoch: epoch,
      workspaceId: randomUUID(), workspaceGeneration: 1, sessionId, selectionRevision: 2 };
    const lease = { generation: 7, expiresAt: 10000 }, read = vi.spyOn(f.connections, 'read').mockResolvedValue(lease);
    for (const channel of [ipcChannels.remoteRenew, ipcChannels.remoteTakeOver]) {
      await expect(f.invoke(channel, { scope })).resolves.toEqual(lease);
      const call = read.mock.calls.at(-1)!; expect(call[0]).toBe(0); expect(call[1]()).toBe(true); expect(call[2]).toBeTypeOf('function');
    }
    const challenge = { challengeId: randomUUID(), sessionId, oldLevel: 'edit', newLevel: 'full-access', expiresAt: 10000 };
    read.mockResolvedValue(challenge);
    await expect(f.invoke(ipcChannels.remoteIssuePermission, { scope, level: 'full-access' })).resolves.toEqual(challenge);
    const original = { requestId: `${epoch}.1000.${randomUUID()}`, status: 'outcome_unknown' as const, response: null };
    const confirm = vi.spyOn(f.connections, 'confirmPermission').mockResolvedValue(original);
    await expect(f.invoke(ipcChannels.remoteConfirmPermission, { scope, challengeId: challenge.challengeId })).resolves.toEqual(original);
    const call = confirm.mock.calls[0]!; expect(call[0]).toEqual(scope); expect(call[1]()).toBe(true); expect(call[2]).toBe(challenge.challengeId);
    await expect(f.invoke(ipcChannels.remoteConfirmPermission, { scope, challengeId: challenge.challengeId, requestId: 'renderer-chosen' })).rejects.toThrow();
    expect(confirm).toHaveBeenCalledOnce();
    const navigation = f.sender.on.mock.calls.find(([name]) => name === 'did-start-navigation')?.[1] as (value: { isMainFrame: boolean; isSameDocument: boolean }) => void;
    navigation({ isMainFrame: true, isSameDocument: false }); expect(call[1]()).toBe(false);
    expect(f.runtime.prompt).not.toHaveBeenCalled(); expect(f.runtime.openProject).not.toHaveBeenCalled(); f.connections.close();
  });
  it('refuses generic envelopes, caller identities, paths and authority at the real named operation boundary', async () => {
    const f = fixture(), scope: RemoteScope = { generation: 0, profileId: f.profile.id, hostId: f.profile.hostId,
      serverEpoch: randomUUID(), workspaceId: randomUUID(), workspaceGeneration: 1, sessionId: randomUUID(), selectionRevision: 2 };
    const mutate = vi.spyOn(f.connections, 'mutate');
    for (const operation of [{ method: 'terminal.manual', input: {} }, { method: 'task.clear', input: {}, requestId: 'caller-id' },
      { method: 'task.clear', input: { ticket: 'caller-ticket' } }, { method: 'task.clear', input: {}, owner: 'admin' }]) {
      await expect(f.invoke(ipcChannels.remoteApplyOperation, { scope, operation })).rejects.toThrow();
    }
    await expect(f.invoke(ipcChannels.remoteIssuePermission, { scope, level: 'full-access', credentialRef: '/owner.key' })).rejects.toThrow();
    expect(mutate).not.toHaveBeenCalled(); expect(f.runtime.prompt).not.toHaveBeenCalled(); expect(f.projects.prepareOpenPath).not.toHaveBeenCalled();
    f.connections.close();
  });
  it('captures the exact owning window and does not retain authority after that window is destroyed', async () => {
    const f = fixture(), scope: RemoteScope = { generation: 0, profileId: f.profile.id, hostId: f.profile.hostId,
      serverEpoch: randomUUID(), workspaceId: randomUUID(), workspaceGeneration: 1, sessionId: randomUUID(), selectionRevision: 2 };
    const read = vi.spyOn(f.connections, 'read').mockResolvedValue({ generation: 7, expiresAt: 10000 });
    await f.invoke(ipcChannels.remoteRenew, { scope }); const guard = read.mock.calls[0]![1]; expect(guard()).toBe(true);
    f.owner.isDestroyed.mockReturnValue(true); expect(guard()).toBe(false); f.connections.close();
  });
  it('fences delayed local browser menu callbacks across remote selection and local ABA without opening or emitting', async () => {
    const f = fixture(); await f.connections.select({ kind: 'local' });
    vi.mocked(Menu.buildFromTemplate).mockReturnValue({ popup: vi.fn() } as never);
    await f.invoke(ipcChannels.browserShowLinkContextMenu, { url: 'https://example.test/' });
    const items = vi.mocked(Menu.buildFromTemplate).mock.calls[0]![0];
    await f.connections.select({ kind: 'remote', profileId: f.profile.id });
    f.sender.send.mockClear();
    for (const item of items) item.click?.({} as never, undefined, {} as never);
    await f.connections.select({ kind: 'local' }); f.sender.send.mockClear();
    for (const item of items) item.click?.({} as never, undefined, {} as never);
    expect(f.sender.send).not.toHaveBeenCalled(); expect(shell.openExternal).not.toHaveBeenCalled(); expect(clipboard.writeText).not.toHaveBeenCalled();
    f.connections.close();
  });
  it('does not forward local runtime/Monitor events into the remote renderer stores', () => {
    const f = fixture();
    const sink = f.runtime.setEventSink.mock.calls[0]![0] as (events: unknown[]) => void;
    sink([{ type: 'run.started', runId: 'local-run', timestamp: 1 }]);
    expect(f.sender.send).not.toHaveBeenCalled(); expect(f.runtime.getState).not.toHaveBeenCalled(); f.connections.close();
  });
});
