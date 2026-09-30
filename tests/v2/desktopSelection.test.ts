import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopConnectionApi, DesktopConnectionState } from '../../src/shared/contracts/connections';
import { unsupportedWebFateMethods } from '../../src/client/WebFateApi';
import { RemoteDesktopFateApi } from '../../src/renderer/platform/RemoteDesktopFateApi';
import { getDesktopConnectionState, getWebApiOptional, initializeDesktopConnections, installFateApi, resetFateApi } from '../../src/renderer/platform/api';

function state(kind: 'local' | 'remote', generation: number): DesktopConnectionState {
  return { kind, generation, profile: kind === 'local' ? null : { id: randomUUID(), hostId: randomUUID(), label: 'Approved host' },
    serverEpoch: null, scope: null, status: 'disconnected', capabilities: [], controlGeneration: null,
    permissionLevel: null, lastConfirmedStatus: 'unknown', lastConfirmedAt: null, pending: [],
    outcomeStorage: 'ready', message: kind === 'local' ? 'local' : 'selected' };
}
function fixture(read: () => Promise<DesktopConnectionState>) {
  const listeners = new Set<(state: DesktopConnectionState) => void>();
  const unavailable = async () => { throw new Error('No effect in this selection fixture'); };
  const bridge: DesktopConnectionApi = {
    listConnectionProfiles: async () => [], getConnectionState: read,
    onConnectionState: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    selectConnectionProfile: unavailable, connectConnection: unavailable, disconnectConnection: unavailable,
    remoteListWorkspaces: unavailable, remoteReadSnapshot: unavailable, remoteReadMonitor: unavailable,
    remoteReadGoal: unavailable, remoteReadTasks: unavailable, remoteReadGitStatus: unavailable,
    remoteReadGitHistory: unavailable, remoteReadSessions: unavailable, remoteReadModels: unavailable,
    remoteReadQueue: unavailable, remoteReadTeams: unavailable, remoteReadAgents: unavailable,
    remoteReadGitDiff: unavailable, remoteReadGitCombinedDiff: unavailable, remoteReadGitCommitDetails: unavailable,
    remoteReadMonitorDetail: unavailable, remoteUploadText: unavailable, remoteCancelText: unavailable,
    remoteApplyOperation: unavailable, remoteListFiles: unavailable, remotePreviewText: unavailable,
    remoteClaimControl: unavailable, remoteRenewControl: unavailable, remoteTakeOverControl: unavailable,
    remoteReleaseControl: unavailable, remoteIssuePermission: unavailable, remoteConfirmPermission: unavailable,
    remoteSendPrompt: unavailable, remoteAbort: unavailable, remoteSelectSession: unavailable, remoteReviewCommand: unavailable,
  };
  const remote = new RemoteDesktopFateApi(bridge);
  installFateApi({ ...unsupportedWebFateMethods(), connections: bridge, remote });
  return { remote, publish: (value: DesktopConnectionState) => { for (const listener of [...listeners]) listener(value); } };
}

afterEach(resetFateApi);
describe('desktop renderer selection initialization fences', () => {
  it('keeps an unconfirmed persisted selection fail-closed on the remote presentation path', async () => {
    const read = vi.fn(async () => { throw new Error('Private profile store unavailable'); });
    const host = fixture(read);
    expect(getWebApiOptional()).toBe(host.remote);
    await expect(initializeDesktopConnections()).rejects.toThrow(/Local execution was not selected/);
    expect(getDesktopConnectionState()).toBeNull();
    expect(getWebApiOptional()).toBe(host.remote);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('does not replace an explicit new host event with a delayed old local initialization', async () => {
    let resolve!: (value: DesktopConnectionState) => void;
    const host = fixture(() => new Promise<DesktopConnectionState>((done) => { resolve = done; }));
    const initializing = initializeDesktopConnections();
    const selected = state('remote', 2);
    host.publish(selected);
    resolve(state('local', 1));
    await initializing;
    expect(getDesktopConnectionState()).toEqual(selected);
    expect(getWebApiOptional()).toBe(host.remote);
    expect(host.remote.origin).toBe(`fate-native://${selected.profile!.hostId}`);
  });

  it('does not clear a newer selection when an old initial read fails', async () => {
    let reject!: (reason: Error) => void;
    const host = fixture(() => new Promise<DesktopConnectionState>((_done, fail) => { reject = fail; }));
    const initializing = initializeDesktopConnections();
    const selected = state('remote', 3);
    host.publish(selected);
    reject(new Error('Old selection response failed'));
    await initializing;
    expect(getDesktopConnectionState()).toEqual(selected);
    expect(getWebApiOptional()).toBe(host.remote);
  });

  it('allows local presentation only after a current explicit local selection is confirmed', async () => {
    const local = state('local', 4);
    fixture(async () => local);
    await initializeDesktopConnections();
    expect(getDesktopConnectionState()).toEqual(local);
    expect(getWebApiOptional()).toBeUndefined();
  });
});
