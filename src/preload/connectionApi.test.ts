import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcChannels } from '../shared/contracts/ipc';
import type { DesktopConnectionState, RemoteScope } from '../shared/contracts/connections';

const electron = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: electron }));
import { piDesktopApi } from './api';

const hostId = randomUUID(), profileId = randomUUID(), epoch = randomUUID(), workspaceId = randomUUID();
const scope: RemoteScope = { generation: 3, profileId, hostId, serverEpoch: epoch, workspaceId, workspaceGeneration: 4,
  sessionId: randomUUID(), selectionRevision: 2 };
const state: DesktopConnectionState = { kind: 'remote', generation: 3, profile: { id: profileId, label: 'Remote host', hostId },
  serverEpoch: epoch, scope, status: 'observing', capabilities: ['workspace.monitor'], controlGeneration: null,
  permissionLevel: 'edit', lastConfirmedStatus: 'running', lastConfirmedAt: 1, pending: [], outcomeStorage: 'ready', message: 'ready' };
beforeEach(() => { electron.invoke.mockReset(); electron.on.mockReset(); electron.removeListener.mockReset(); });

describe('T43 named native connection preload', () => {
  it('exports real named selection/connect/disconnect methods in the production bridge without credential inputs', async () => {
    electron.invoke.mockResolvedValue(state);
    await piDesktopApi.selectConnectionProfile({ kind: 'remote', profileId });
    await piDesktopApi.connectConnection(3); await piDesktopApi.disconnectConnection(3);
    expect(electron.invoke.mock.calls).toEqual([
      [ipcChannels.connectionSelect, { kind: 'remote', profileId }],
      [ipcChannels.connectionConnect, { generation: 3 }], [ipcChannels.connectionDisconnect, { generation: 3 }],
    ]);
    expect(piDesktopApi).not.toHaveProperty('invoke'); expect(piDesktopApi).not.toHaveProperty('request');
    expect(piDesktopApi).not.toHaveProperty('fetch'); expect(piDesktopApi).not.toHaveProperty('credential');
  });
  it('rejects renderer-supplied profile/config paths, owner credentials, endpoint, and authority before invoking main', async () => {
    for (const extra of [{ credentialRef: '/private.key' }, { baseUrl: 'http://remote' }, { key: 'owner-secret' }, { role: 'admin' }]) {
      await expect(piDesktopApi.selectConnectionProfile({ kind: 'remote', profileId, ...extra })).rejects.toThrow();
    }
    await expect(piDesktopApi.remoteReadMonitor({ ...scope, projectPath: '/server' } as RemoteScope)).rejects.toThrow();
    expect(electron.invoke).not.toHaveBeenCalled();
  });
  it('rejects leaked key/config/ticket output rather than silently exposing main-private data', async () => {
    electron.invoke.mockResolvedValueOnce([{ id: profileId, hostId, label: 'Remote host', credentialRef: '/private.key' }]);
    await expect(piDesktopApi.listConnectionProfiles()).rejects.toThrow();
    electron.invoke.mockResolvedValueOnce({ ...state, credential: `fc1_${'x'.repeat(43)}` });
    await expect(piDesktopApi.getConnectionState()).rejects.toThrow();
    electron.invoke.mockResolvedValueOnce({ ...state, clientTicket: 'ticket' });
    await expect(piDesktopApi.getConnectionState()).rejects.toThrow();
  });
  it('preserves the original mutation ID for an uncertain outcome and never sends a second request', async () => {
    const requestId = `${epoch}.1000.${randomUUID()}`;
    electron.invoke.mockResolvedValueOnce({ requestId, status: 'outcome_unknown', response: null });
    await expect(piDesktopApi.remoteSendPrompt(scope, 'Synthetic prompt')).resolves.toEqual({ requestId, status: 'outcome_unknown', response: null });
    expect(electron.invoke).toHaveBeenCalledOnce();
    expect(electron.invoke).toHaveBeenCalledWith(ipcChannels.remotePrompt, { scope, input: { text: 'Synthetic prompt' } });
  });
  it('exposes only scoped named renew/takeover/permission bridges and preserves original confirmation identity', async () => {
    const lease = { generation: 7, expiresAt: 10000 }, challengeId = randomUUID();
    electron.invoke.mockResolvedValueOnce(lease).mockResolvedValueOnce(lease).mockResolvedValueOnce({ challengeId,
      sessionId: scope.sessionId, oldLevel: 'edit', newLevel: 'full-access', expiresAt: 10000 });
    await expect(piDesktopApi.remoteRenewControl(scope)).resolves.toEqual(lease);
    await expect(piDesktopApi.remoteTakeOverControl(scope)).resolves.toEqual(lease);
    await piDesktopApi.remoteIssuePermission(scope, 'full-access');
    const requestId = `${epoch}.1001.${randomUUID()}`;
    electron.invoke.mockResolvedValueOnce({ requestId, status: 'outcome_unknown', response: null });
    await expect(piDesktopApi.remoteConfirmPermission(scope, challengeId)).resolves.toEqual({ requestId, status: 'outcome_unknown', response: null });
    expect(electron.invoke.mock.calls).toEqual([[ipcChannels.remoteRenew, { scope }], [ipcChannels.remoteTakeOver, { scope }],
      [ipcChannels.remoteIssuePermission, { scope, level: 'full-access' }], [ipcChannels.remoteConfirmPermission, { scope, challengeId }]]);
    electron.invoke.mockClear();
    await expect(piDesktopApi.remoteRenewControl({ ...scope, controlGeneration: 900 } as RemoteScope)).rejects.toThrow();
    await expect(piDesktopApi.remoteTakeOverControl({ ...scope, owner: 'admin' } as RemoteScope)).rejects.toThrow();
    expect(electron.invoke).not.toHaveBeenCalled();
  });
  it('validates bounded durable permission status while keeping its original request ID in the named payload', async () => {
    const requestId = `${epoch}.1002.${randomUUID()}`, receipt = { kind: 'permission', requestId, durability: 'journaled', outcome: 'applied',
      challengeId: randomUUID(), workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration,
      sessionId: scope.sessionId, selectionRevision: scope.selectionRevision, controlGeneration: 7, oldLevel: 'edit', newLevel: 'full-access' };
    electron.invoke.mockResolvedValueOnce({ state: 'settled', receipt, rejectionCode: null });
    await expect(piDesktopApi.remoteReviewCommand(scope, requestId)).resolves.toMatchObject({ state: 'settled', receipt });
    expect(electron.invoke).toHaveBeenCalledWith(ipcChannels.remoteCommandStatus, { scope, requestId });
    electron.invoke.mockResolvedValueOnce({ state: 'settled', receipt: { ...receipt, ticket: 'private' }, rejectionCode: null });
    await expect(piDesktopApi.remoteReviewCommand(scope, requestId)).rejects.toThrow();
  });
  it('uses the scoped Monitor DTO and refuses a full RuntimeState in place of bounded remote snapshot data', async () => {
    electron.invoke.mockResolvedValueOnce({ status: 'ready', project: { path: '/local', name: 'Local', trusted: true },
      sessionId: randomUUID(), sessionFile: null, streaming: false, model: null, models: [], thinkingLevel: 'edit', messages: [], error: null });
    await expect(piDesktopApi.remoteReadSnapshot(3, { workspaceId, workspaceGeneration: 4, label: 'Workspace' })).rejects.toThrow();
    expect(electron.invoke).toHaveBeenCalledWith(ipcChannels.remoteSnapshot, { generation: 3, workspace: { workspaceId, workspaceGeneration: 4, label: 'Workspace' } });
  });
  it('validates state-change events and removes the exact listener on teardown', () => {
    const listener = vi.fn(), stop = piDesktopApi.onConnectionState(listener);
    const handler = electron.on.mock.calls[0]![1] as (event: unknown, value: unknown) => void;
    handler({}, state); expect(listener).toHaveBeenCalledWith(state);
    listener.mockClear(); expect(() => handler({}, { ...state, bearer: 'raw-key' })).not.toThrow();
    expect(listener).not.toHaveBeenCalled(); stop(); expect(electron.removeListener).toHaveBeenCalledWith(ipcChannels.connectionChanged, handler);
  });
});
