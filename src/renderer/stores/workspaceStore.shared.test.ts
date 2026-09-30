import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRuntimeStore, type BoundedSnapshot, type RegisteredWorkspace, type WorkspaceViewApi } from './runtimeStore';
import { selectFileRows, useWorkspaceStore, type HostFileApi } from './workspaceStore';
import type { WireResultOf } from '../../shared/protocol/methods';

const scope: RegisteredWorkspace = { workspaceId: '30000000-0000-4000-8000-000000000003', workspaceGeneration: 2, label: 'Temporary project' };
const firstFile = '60000000-0000-4000-8000-000000000006';
const secondFile = '60000000-0000-4000-8000-000000000007';
const directory = '60000000-0000-4000-8000-000000000008';
function snapshot(): BoundedSnapshot {
  return { header: { version: 1, snapshotId: '40000000-0000-4000-8000-000000000004', workspaceId: scope.workspaceId,
    workspaceGeneration: scope.workspaceGeneration, sessionId: '20000000-0000-4000-8000-000000000002', selectionRevision: 1,
    capturedAt: Date.now(), expiresAt: Date.now() + 60_000, serverEpoch: '10000000-0000-4000-8000-000000000001',
    eventCursor: 0, pageIds: ['50000000-0000-4000-8000-000000000005'], controls: { status: 'ready', streaming: false,
      activeSessionRunning: false, runningSessionCount: 0, permissionLevel: 'read-only', thinkingLevel: 'medium', model: null,
      pendingModel: null, pendingThinkingLevel: null, sessionOperation: false, queue: { steering: 0, followUp: 0, pending: 0, held: 0, recovered: 0 } },
    goal: null, taskRevision: null, tasks: [], agents: [], omissions: { history: false, media: false, clippedItems: 0,
      agentRows: false, taskRows: false, goalText: false, taskText: false, agentText: false, queueContents: false }, warnings: [] }, items: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}
function files(): HostFileApi {
  return { isConnected: true, supports: () => true,
    listFiles: vi.fn(async (_workspace: RegisteredWorkspace, directoryId: string | null) => ({ directoryId, truncated: false,
      entries: directoryId === null ? [{ resourceId: firstFile, kind: 'file' as const, name: 'first.txt' },
        { resourceId: secondFile, kind: 'file' as const, name: 'second.txt' },
        { resourceId: directory, kind: 'directory' as const, name: 'src' }] : [] })),
    previewText: vi.fn(async (_workspace: RegisteredWorkspace, fileId: string) => ({ fileId, content: 'Temporary text', truncated: false })) };
}
beforeEach(async () => {
  useRuntimeStore.getState().reset();
  useWorkspaceStore.getState().resetHostFiles();
  const api: WorkspaceViewApi = { isConnected: true, reconnectError: null, listWorkspaces: async () => [scope], readSnapshot: async () => snapshot() };
  await useRuntimeStore.getState().initialize(api);
  await useRuntimeStore.getState().refresh(api);
});
afterEach(() => { useWorkspaceStore.getState().resetHostFiles(); useRuntimeStore.getState().reset(); vi.restoreAllMocks(); });

describe('shared workspace file references', () => {
  it('uses one row shape but never treats host resource IDs as desktop paths', async () => {
    useWorkspaceStore.setState({ directories: { '': [{ name: 'local.txt', path: 'local.txt', kind: 'file', symlink: false }] }, expanded: new Set(), query: '' });
    expect(selectFileRows(useWorkspaceStore.getState(), 'desktop')[0]?.reference).toEqual({ kind: 'desktop-path', path: 'local.txt' });
    const api = files();
    await useWorkspaceStore.getState().initializeHostFiles(api);
    const rows = selectFileRows(useWorkspaceStore.getState(), 'network');
    expect(rows[0]?.reference).toEqual({ kind: 'host-resource', resourceId: firstFile });
    await useWorkspaceStore.getState().activateHostFile(api, rows[0]!);
    expect(useWorkspaceStore.getState().hostFiles.preview?.fileId).toBe(firstFile);
    expect(useWorkspaceStore.getState().directories['']?.[0]?.path).toBe('local.txt');
  });

  it('keeps connected idle file rows and reads after transaction TTL, until actual invalidation', async () => {
    const api = files();
    await useWorkspaceStore.getState().initializeHostFiles(api);
    const before = selectFileRows(useWorkspaceStore.getState(), 'network');
    const completed = useRuntimeStore.getState().snapshot!;
    vi.spyOn(Date, 'now').mockReturnValue(completed.header.expiresAt + 3_600_000);
    expect(selectFileRows(useWorkspaceStore.getState(), 'network')).toEqual(before);
    await useWorkspaceStore.getState().activateHostFile(api, before[0]!);
    expect(useWorkspaceStore.getState().hostFiles.preview?.fileId).toBe(firstFile);
    useRuntimeStore.getState().invalidate();
    expect(selectFileRows(useWorkspaceStore.getState(), 'network')).toEqual([]);
    await useWorkspaceStore.getState().activateHostFile(api, before[1]!);
    expect(api.previewText).toHaveBeenCalledTimes(1);
  });

  it('keeps only the last selected preview when responses finish out of order', async () => {
    const first = deferred<WireResultOf<'file.previewText'>>();
    const second = deferred<WireResultOf<'file.previewText'>>();
    const base = files();
    const api: HostFileApi = { ...base, previewText: (_workspace, fileId) => fileId === firstFile ? first.promise : second.promise };
    await useWorkspaceStore.getState().initializeHostFiles(api);
    const rows = selectFileRows(useWorkspaceStore.getState(), 'network');
    const older = useWorkspaceStore.getState().activateHostFile(api, rows[0]!);
    const newer = useWorkspaceStore.getState().activateHostFile(api, rows[1]!);
    second.resolve({ fileId: secondFile, content: 'Newer', truncated: true }); await newer;
    first.resolve({ fileId: firstFile, content: 'Older', truncated: false }); await older;
    expect(useWorkspaceStore.getState().hostFiles.preview).toEqual({ fileId: secondFile, content: 'Newer', truncated: true });
  });

  it('discards late directory results and hides old resource rows at invalidation', async () => {
    const response = deferred<WireResultOf<'file.list'>>();
    const base = files();
    const api: HostFileApi = { ...base, listFiles: (workspace, directoryId) => directoryId ? response.promise : base.listFiles(workspace, null) };
    await useWorkspaceStore.getState().initializeHostFiles(api);
    const row = selectFileRows(useWorkspaceStore.getState(), 'network').find((entry) => entry.id === directory)!;
    const read = useWorkspaceStore.getState().activateHostFile(api, row);
    useRuntimeStore.getState().invalidate();
    expect(selectFileRows(useWorkspaceStore.getState(), 'network')).toEqual([]);
    response.resolve({ directoryId: directory, entries: [{ resourceId: '60000000-0000-4000-8000-000000000009', kind: 'file', name: 'late.txt' }], truncated: false });
    await read;
    expect(useWorkspaceStore.getState().hostFiles.directories[directory]).toBeUndefined();
  });
});
