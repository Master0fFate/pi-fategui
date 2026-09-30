import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeState } from '../../shared/contracts/ipc';
import { snapshotHeaderSchema } from '../../shared/protocol/snapshots';
import { selectAgentView, selectSessionView, useRuntimeStore, type BoundedSnapshot, type RegisteredWorkspace, type WorkspaceViewApi } from './runtimeStore';
import { useWebWorkspaceStore } from './webWorkspaceStore';

const workspace: RegisteredWorkspace = { workspaceId: '30000000-0000-4000-8000-000000000003', workspaceGeneration: 2, label: 'Temporary project' };
const other: RegisteredWorkspace = { ...workspace, workspaceId: '30000000-0000-4000-8000-000000000004', label: 'Other project' };
const desktop: RuntimeState = { status: 'ready', project: { path: '/temporary/project', name: 'Temporary project', trusted: true },
  sessionId: 'desktop-session', sessionFile: null, streaming: false, model: null, models: [], thinkingLevel: 'high',
  permissionLevel: 'edit', messages: [{ id: 'desktop-message', role: 'user', text: 'Local text', timestamp: 1 }], commands: [], error: null };
export function sharedSnapshot(scope = workspace): BoundedSnapshot {
  return { header: snapshotHeaderSchema.parse({ version: 1, snapshotId: '40000000-0000-4000-8000-000000000004',
    workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration, sessionId: '20000000-0000-4000-8000-000000000002',
    selectionRevision: 8, capturedAt: Date.now(), expiresAt: Date.now() + 60_000, serverEpoch: '10000000-0000-4000-8000-000000000001',
    eventCursor: 0, pageIds: ['50000000-0000-4000-8000-000000000005'],
    controls: { status: 'ready', streaming: true, activeSessionRunning: true, runningSessionCount: 1,
      permissionLevel: 'read-only', thinkingLevel: 'medium', model: null, pendingModel: null, pendingThinkingLevel: null,
      sessionOperation: false, queue: { steering: 1, followUp: 0, pending: 0, held: 0, recovered: 0 } },
    goal: null, taskRevision: null, tasks: [], agents: [{ id: 'bounded-agent', title: 'Agent', status: 'running' }],
    omissions: { history: true, media: true, clippedItems: 0, agentRows: true, taskRows: false,
      goalText: true, taskText: false, agentText: true, queueContents: true }, warnings: [] }),
    items: [{ id: 'wire-message', kind: 'message', role: 'assistant', text: 'Bounded host text', timestamp: 2, clipped: false, mediaOmitted: true }] };
}
function port(readSnapshot: WorkspaceViewApi['readSnapshot'] = async (scope) => sharedSnapshot(scope)): WorkspaceViewApi {
  return { isConnected: true, reconnectError: null, listWorkspaces: async () => [workspace, other], readSnapshot };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

beforeEach(() => { useRuntimeStore.getState().reset(); useRuntimeStore.getState().hydrateRuntime(desktop); });
afterEach(() => { useRuntimeStore.getState().reset(); vi.restoreAllMocks(); });

describe('shared bounded renderer state (no transport emulation)', () => {
  it('uses exactly one store for desktop and the compatibility browser name', async () => {
    expect(useWebWorkspaceStore).toBe(useRuntimeStore);
    expect(selectSessionView(useRuntimeStore.getState())).toMatchObject({ source: 'desktop', label: 'Temporary project',
      sessionId: 'desktop-session', permissionLevel: 'edit', thinkingLevel: 'high' });
    const original = useRuntimeStore.getState().runtime;
    const api = port();
    await useRuntimeStore.getState().initialize(api);
    await useRuntimeStore.getState().refresh(api);
    const state = useWebWorkspaceStore.getState();
    expect(selectSessionView(state)).toMatchObject({ source: 'network', sessionId: '20000000-0000-4000-8000-000000000002',
      permissionLevel: 'read-only', activeSessionRunning: true, confirmed: true });
    expect(selectAgentView(state)).toMatchObject({ source: 'network', partial: true, rows: [{ id: 'bounded-agent', status: 'running' }] });
    expect(state.runtime).toBe(original);
    expect(state.messageOrder).toEqual(['desktop-message']);
    expect(state.snapshot?.items[0]?.id).toBe('wire-message');
    // A network excerpt cannot silently become a desktop message or event.
    state.applyEvents([{ type: 'assistant.text', messageId: 'not-a-wire-event', delta: 'bad', timestamp: 3 }]);
    state.setRuntime({ ...desktop, sessionId: 'late-desktop-result' });
    expect(useRuntimeStore.getState().runtime).toBe(original);
    expect(useRuntimeStore.getState().messagesById['not-a-wire-event']).toBeUndefined();
  });

  it('discards an A-to-B-to-A late read even when workspace identity matches again', async () => {
    const response = deferred<BoundedSnapshot>();
    const api = port(() => response.promise);
    await useRuntimeStore.getState().initialize(api);
    const pending = useRuntimeStore.getState().refresh(api);
    useRuntimeStore.getState().select(other);
    useRuntimeStore.getState().select(workspace);
    response.resolve(sharedSnapshot());
    await pending;
    expect(useRuntimeStore.getState().snapshot).toBeNull();
    expect(useRuntimeStore.getState().phase).toBe('synchronizing');
  });

  it('keeps a completed connected idle view confirmed beyond page TTL despite renderer clock skew', async () => {
    const assembled = sharedSnapshot();
    const api = port(async () => ({ ...assembled, header: { ...assembled.header, capturedAt: 10_000, expiresAt: 70_000 } }));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await useRuntimeStore.getState().initialize(api);
    await useRuntimeStore.getState().refresh(api);
    const snapshot = useRuntimeStore.getState().snapshot;
    expect(selectSessionView(useRuntimeStore.getState()).confirmed).toBe(true);
    clock.mockReturnValue(2_000_000);
    expect(selectSessionView(useRuntimeStore.getState()).confirmed).toBe(true);
    expect(useRuntimeStore.getState().snapshot).toBe(snapshot);
    useRuntimeStore.getState().invalidate();
    expect(selectSessionView(useRuntimeStore.getState()).confirmed).toBe(false);
    expect(useRuntimeStore.getState().snapshot).toBe(snapshot);
  });

  it('retains stale confirmed data without labelling a disconnected run stopped', async () => {
    const api = port();
    await useRuntimeStore.getState().initialize(api);
    await useRuntimeStore.getState().refresh(api);
    const snapshot = useRuntimeStore.getState().snapshot;
    useRuntimeStore.getState().disconnect();
    expect(useRuntimeStore.getState().snapshot).toBe(snapshot);
    expect(selectSessionView(useRuntimeStore.getState())).toMatchObject({ activeSessionRunning: true, confirmed: false });
    expect(useRuntimeStore.getState().phase).toBe('disconnected');
  });

  it('rejects foreign views, invalid lifetimes and expired/incomplete assembly and fences a former adapter', async () => {
    const api = port(async () => sharedSnapshot(other));
    await useRuntimeStore.getState().initialize(api);
    await useRuntimeStore.getState().refresh(api);
    expect(useRuntimeStore.getState().phase).toBe('error');
    expect(useRuntimeStore.getState().snapshot).toBeNull();
    const expired = sharedSnapshot();
    const expiredPort = port(async () => ({ ...expired, header: { ...expired.header, expiresAt: 0 } }));
    await useRuntimeStore.getState().initialize(expiredPort);
    await useRuntimeStore.getState().refresh(expiredPort);
    expect(useRuntimeStore.getState().phase).toBe('error');
    expect(useRuntimeStore.getState().snapshot).toBeNull();
    // The adapter validates the host transaction while pages are assembled;
    // it must not resolve a partial or expired transaction as an acknowledged view.
    const incomplete = port(async () => { throw new Error('Snapshot expired before page assembly and replay acknowledgement.'); });
    await useRuntimeStore.getState().initialize(incomplete);
    await useRuntimeStore.getState().refresh(incomplete);
    expect(useRuntimeStore.getState().phase).toBe('error');
    expect(useRuntimeStore.getState().snapshot).toBeNull();
    expect(useRuntimeStore.getState().error).toContain('expired before page assembly');
    const pending = deferred<BoundedSnapshot>();
    const previous = port(() => pending.promise);
    await useRuntimeStore.getState().initialize(previous);
    const read = useRuntimeStore.getState().refresh(previous);
    useRuntimeStore.getState().reset();
    pending.resolve(sharedSnapshot());
    await read;
    expect(useRuntimeStore.getState().snapshot).toBeNull();
    expect(useRuntimeStore.getState().source).toBe('desktop');
  });
});
