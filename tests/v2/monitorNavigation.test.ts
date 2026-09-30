import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAuthenticatedServerContext } from '../../src/core/dispatch/RequestContext';
import type { FateCore } from '../../src/core/FateCore';
import type { WorkspaceHandle } from '../../src/core/workspaces/WorkspaceHandle';
import type { CommandJournal } from '../../src/core/commands/CommandJournal';
import type { ClientTickets } from '../../src/server/auth/ClientTickets';
import { createNetworkDispatcher } from '../../src/server/http/NetworkDispatcher';
import { responseEnvelopeSchema } from '../../src/shared/protocol/envelopes';
import type { MonitorDashboard, MonitorItem } from '../../src/shared/contracts/monitorDashboard';
const epoch = '10000000-0000-4000-8000-000000000001';
const workspaceId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000003';
const principalId = '40000000-0000-4000-8000-000000000004';
const clientId = '50000000-0000-4000-8000-000000000005';
const requestId = '60000000-0000-4000-8000-000000000006';
const root = path.resolve('monitor-private-root');
const sentinel = 'FAKE_PROVIDER_SECRET_TITLE_AND_DETAIL';
const initial = 1_800_000_000_000;
function fixture(kind: 'run' | 'task' = 'run') {
  let now = initial;
  let revision = 9;
  let live = true;
  let available = true;
  let delay = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const row: MonitorItem = { id: `private:${sentinel}`, source: kind === 'run' ? 'runs' : 'tasks', state: 'attention',
    title: sentinel, detail: sentinel, updatedAt: initial, ref: { kind, id: kind === 'task' ? 'task-1' : sentinel } };
  const monitor = vi.fn(async (query: { section: MonitorDashboard['section']; offset: number; limit: number }) => {
    if (delay) await gate;
    return { projectPath: root, sessionId, checkedAt: now, revision: 'source-revision', overall: 'unknown' as const,
      sources: { runs: 'partial' as const, teams: 'ready' as const, tasks: 'ready' as const, activity: 'unknown' as const },
      sourceCheckedAt: { runs: now, teams: now, tasks: now, activity: null },
      counts: { active: 0, attention: 1, runs: kind === 'run' ? 1 : 0, teams: 0, tasks: kind === 'task' ? 1 : 0, activity: 0 },
      section: query.section, total: 100, offset: query.offset, limit: query.limit, unchanged: false, items: available ? [row] : [] };
  });
  const runtime = { getState: () => ({ sessionId, project: { path: root, trusted: true }, permissionLevel: 'read-only' }),
    getMonitorDashboard: monitor,
    getTaskList: async () => ({ projectPath: root, sessionId, tasks: [{ id: 'task-1', title: 'Scoped project task', detail: 'Explicit bounded project detail' }] }) };
  const handle = { id: workspaceId, generation: 3, root, runtime, files: { getRoot: () => root },
    admission: { snapshot: () => ({ selectedSessionId: sessionId, selectionRevision: revision }) } } as unknown as WorkspaceHandle;
  const core = { workspaces: { resolve: () => handle }, runtime: { workspaceOrigin: () => ({ workspaceId, workspaceGeneration: 3 }),
    peekWorkspace: () => runtime }, sessionPermissions: { assertHealthy: () => undefined } } as unknown as FateCore;
  const tickets = { isLive: () => live, isMember: (_context: unknown, candidate: string) => live && candidate === root } as unknown as ClientTickets;
  const service = createNetworkDispatcher({ core, tickets, journal: {} as CommandJournal, serverEpoch: epoch, registeredRoots: [root],
    hostId: principalId, appVersion: '1.0.0', now: () => now });
  const identity = createAuthenticatedServerContext({ principalId, clientId, expiresAt: initial + 3600_000 }, null);
  const foreign = createAuthenticatedServerContext({ principalId, clientId: '70000000-0000-4000-8000-000000000007', expiresAt: initial + 3600_000 }, null);
  const read = (method: string, input: object) => ({ protocol: 1, requestId, serverEpoch: epoch, issuedAt: now, method,
    workspaceId, workspaceGeneration: 3, expectedSessionId: sessionId, selectionRevision: revision, input });
  const dispatch = (request: object, owner = identity) => service.dispatcher.dispatchJson(JSON.stringify(request), owner);
  const page = async (offset = 0) => {
    const response = await dispatch(read('workspace.monitor', { section: kind === 'run' ? 'runs' : 'tasks', offset, limit: 25 }));
    if (!response.ok || response.method !== 'workspace.monitor') throw new Error('Expected Monitor');
    return response.result;
  };
  return { page, read, dispatch, foreign, monitor, expire: () => { now += 60_001; },
    switchAwayAndBack: () => { revision += 2; }, revoke: () => { live = false; },
    removeSource: () => { available = false; }, hold: () => { delay = true; }, release };
}

describe('T39 authoritative Monitor navigation with private provider text', () => {
  it('issues the same opaque actual-source identity across page positions, preserving unknown/partial while redacting private title/detail/ref', async () => {
    const f = fixture();
    const first = await f.page();
    const moved = await f.page(25);
    expect(first.items[0]?.id).toBe(moved.items[0]?.id);
    expect(first.items[0]).toMatchObject({ title: 'Run', navigation: { kind: 'run', expiresAt: initial + 60_000 } });
    expect(first.sources).toMatchObject({ runs: 'partial', activity: 'unknown' });
    expect(first.overall).toBe('unknown');
    expect(JSON.stringify(first)).not.toContain(sentinel);
    const id = first.items[0]!.id;
    const detail = await f.dispatch(f.read('workspace.monitorDetail', { id }));
    expect(detail).toMatchObject({ ok: true, method: 'workspace.monitorDetail', result: { id, kind: 'run', title: 'Run', redacted: true } });
    expect(responseEnvelopeSchema.safeParse(detail).success).toBe(true);
    expect(JSON.stringify(detail)).not.toContain(sentinel);
    expect(JSON.stringify(detail)).not.toContain(root);
    expect(f.monitor).toHaveBeenCalledTimes(4); // Two pages, source lookup, then the final authoritative confirmation.
  });
  it('allows explicit bounded project task detail only for the host-issued actual task identity', async () => {
    const f = fixture('task');
    const page = await f.page();
    expect(JSON.stringify(page)).not.toContain('Scoped project task');
    const id = page.items[0]!.id;
    const detail = await f.dispatch(f.read('workspace.monitorDetail', { id }));
    expect(detail).toMatchObject({ ok: true, result: { id, kind: 'task', redacted: false, title: 'Scoped project task',
      detail: 'Explicit bounded project detail', target: { kind: 'task', taskId: 'task-1' } } });
    expect(await f.dispatch(f.read('workspace.monitorDetail', { id: '0'.repeat(32) }))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
  it('denies cross-client IDs, expiry, selection A→B→A, and removed source rather than guessing an ordinal', async () => {
    for (const change of ['foreign', 'expiry', 'selection', 'removed'] as const) {
      const f = fixture();
      const id = (await f.page()).items[0]!.id;
      if (change === 'expiry') f.expire();
      if (change === 'selection') f.switchAwayAndBack();
      if (change === 'removed') f.removeSource();
      expect(await f.dispatch(f.read('workspace.monitorDetail', { id }), change === 'foreign' ? f.foreign : undefined)).toMatchObject({ ok: false });
    }
  });
  it('refuses a navigation token that expires while its authoritative source read is pending', async () => {
    const f = fixture();
    const id = (await f.page()).items[0]!.id;
    f.hold();
    const pending = f.dispatch(f.read('workspace.monitorDetail', { id }));
    await vi.waitFor(() => expect(f.monitor).toHaveBeenCalledTimes(2));
    f.expire(); f.release();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });
  it('rechecks ticket/selection after the authoritative source read and never releases pending private detail on revoke', async () => {
    const f = fixture();
    const id = (await f.page()).items[0]!.id;
    f.hold();
    const pending = f.dispatch(f.read('workspace.monitorDetail', { id }));
    await vi.waitFor(() => expect(f.monitor).toHaveBeenCalledTimes(2));
    f.revoke(); f.release();
    const result = await pending;
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });
});
