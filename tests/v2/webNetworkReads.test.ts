import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiSessionRepository } from '../../src/main/pi/PiSessionRepository';
afterEach(() => vi.restoreAllMocks());
import { createAuthenticatedServerContext } from '../../src/core/dispatch/RequestContext';
import type { FateCore } from '../../src/core/FateCore';
import type { WorkspaceHandle } from '../../src/core/workspaces/WorkspaceHandle';
import type { CommandJournal } from '../../src/core/commands/CommandJournal';
import type { ClientTickets } from '../../src/server/auth/ClientTickets';
import { createNetworkDispatcher } from '../../src/server/http/NetworkDispatcher';
import { requestEnvelopeSchema, responseEnvelopeSchema } from '../../src/shared/protocol/envelopes';
import { SNAPSHOT_PAGE_BYTES } from '../../src/shared/protocol/snapshots';

const epoch = '10000000-0000-4000-8000-000000000001';
const workspaceId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000003';
const principalId = '40000000-0000-4000-8000-000000000004';
const clientId = '50000000-0000-4000-8000-000000000005';
const requestId = '60000000-0000-4000-8000-000000000006';
const root = path.resolve('t39-private-host-root');
const sentinel = 'FAKE_MONITOR_SECRET_0987123';
const initialTime = 1_800_000_000_000;
const identity = createAuthenticatedServerContext({ principalId, clientId, expiresAt: initialTime + 3600_000 }, null);
const foreign = createAuthenticatedServerContext({ principalId, clientId: '70000000-0000-4000-8000-000000000007', expiresAt: initialTime + 3600_000 }, null);
const read = (method: string, input: object = {}) => ({ protocol: 1, requestId, serverEpoch: epoch,
  issuedAt: initialTime, method, workspaceId, workspaceGeneration: 3,
  ...(['workspace.monitor', 'session.history'].includes(method) ? { expectedSessionId: sessionId, selectionRevision: 9 } : {}), input });
const dashboard = (section: 'overview' | 'runs' = 'runs', offset = 0, sinceRevision?: string) => ({
  projectPath: root, sessionId, checkedAt: initialTime, revision: 'reviewed-page-revision', overall: 'unknown' as const,
  sources: { runs: 'partial' as const, teams: 'ready' as const, tasks: 'unknown' as const, activity: 'unknown' as const },
  sourceCheckedAt: { runs: initialTime, teams: initialTime, tasks: null, activity: null },
  counts: { active: 1, attention: 1, runs: 26, teams: 0, tasks: 0, activity: 0 }, section, total: 26, offset, limit: 25,
  unchanged: sinceRevision === 'reviewed-page-revision', items: sinceRevision === 'reviewed-page-revision' ? [] : [{
    id: sentinel, source: 'runs' as const, state: 'attention' as const, title: 'Release check', detail: 'Run failed safely',
    updatedAt: initialTime, ref: { kind: 'run' as const, id: sentinel },
  }],
});

function fixture(messageCount = 1) {
  let now = initialTime;
  let allowed = true;
  let generation = 3;
  let selectionRevision = 9;
  let selected: string | null = sessionId;
  let snapshotReady = true;
  let messages: Array<{ id: string; role: 'assistant' | 'user'; text: string; timestamp: number }> =
    Array.from({ length: messageCount }, (_, index) => ({
      id: `message-${index}`, role: 'assistant', text: 'x'.repeat(4096), timestamp: index,
    }));
  let finishMonitor: (() => void) | null = null;
  let awaitMonitor = false;
  const pendingMonitor = new Promise<void>((resolve) => { finishMonitor = resolve; });
  const runtimeState = () => ({ status: 'ready' as const, project: { path: root, name: 'Project', trusted: true },
    sessionId: selected, sessionFile: null, streaming: false, model: null, models: [], thinkingLevel: 'medium' as const,
    permissionLevel: 'read-only' as const, messages, commands: [], error: null });
  const monitor = vi.fn(async (query: { section: 'overview' | 'runs'; offset: number; limit: number; sinceRevision?: string }) => {
    if (awaitMonitor) await pendingMonitor;
    return dashboard(query.section, query.offset, query.sinceRevision);
  });
  const runtime = { getState: runtimeState, captureSnapshotView: () => ({ state: runtimeState(), goal: null, tasks: [],
    goalReady: snapshotReady, tasksReady: snapshotReady }), flushSnapshotEvents: vi.fn(), getMonitorDashboard: monitor };
  const handle = { root, id: workspaceId, generation: 3, runtime, files: { getRoot: () => root },
    admission: { snapshot: () => ({ selectedSessionId: selected, selectionRevision }) } } as unknown as WorkspaceHandle;
  const core = { paths: { sessionsRoot: path.join(root, 'sessions') }, workspaces: { resolve: (_context: unknown, id: string, expected: number) => {
    if (!allowed || id !== workspaceId || expected !== generation || generation !== handle.generation) throw new Error('Not current');
    return handle;
  } }, runtime: { workspaceOrigin: (candidate: string) => candidate === root ? { workspaceId, workspaceGeneration: generation } : null,
    peekWorkspace: (candidate: string) => candidate === root ? handle.runtime : null },
  events: { position: () => ({ serverEpoch: epoch, workspaceId, workspaceGeneration: generation,
    streamId: '80000000-0000-4000-8000-000000000008', sequence: 0 }) },
  sessionPermissions: { assertHealthy: () => undefined } } as unknown as FateCore;
  const tickets = { isLive: (context: unknown) => allowed && (context === identity || context === foreign),
    isMember: (context: unknown, candidate: string) => allowed && candidate === root && (context === identity || context === foreign),
    verify: (ticket: string) => { if (ticket !== 'server-issued-ticket' || !allowed) throw new Error('Invalid ticket'); return identity; },
  } as unknown as ClientTickets;
  const journal = {} as CommandJournal;
  const service = createNetworkDispatcher({ core, tickets, journal, serverEpoch: epoch, registeredRoots: [root],
    hostId: principalId, appVersion: '1.1.0', now: () => now });
  const dispatch = (request: object, context = identity) => service.dispatcher.dispatchJson(JSON.stringify(request), context);
  return { service, dispatch, monitor, runtime, revoke: () => { allowed = false; },
    replace: () => { generation++; }, switchAwayAndBack: () => { selected = sessionId; selectionRevision += 2; },
    blockMonitor: () => { awaitMonitor = true; }, releaseMonitor: () => { finishMonitor?.(); },
    expire: () => { now += 61_000; }, notReady: () => { snapshotReady = false; },
    clearSelection: () => { selected = null; selectionRevision++; },
    changeMessages: () => { messages = [{ id: 'new', role: 'user', text: 'new', timestamp: now }]; } };
}

describe('T39 bounded authenticated workspace reads', () => {
  it('serves bounded saved history through the production handler, fencing cursors by client and selection', async () => {
    const history = vi.spyOn(PiSessionRepository.prototype, 'readHistoryPage').mockImplementation(async (_root, _session, offset = 0) => ({
      items: [{ kind: 'message', id: `saved-${offset}`, role: 'user', text: 'saved text', timestamp: 1, clipped: false, mediaOmitted: false }],
      nextOffset: offset === 0 ? 1 : null, stamp: 'stable-file', mediaOmitted: false, oversizedItems: 0,
    }));
    const f = fixture();
    const first = await f.dispatch(read('session.history'));
    expect(first).toMatchObject({ ok: true, method: 'session.history', result: { sessionId, items: [{ text: 'saved text' }] } });
    if (!first.ok || first.method !== 'session.history' || !first.result.nextPageId) throw new Error('Expected saved history cursor');
    const next = read('session.history', { pageId: first.result.nextPageId });
    expect(await f.dispatch(next, foreign)).toMatchObject({ ok: false, error: { code: 'RESYNC_REQUIRED' } });
    expect(await f.dispatch(next)).toMatchObject({ ok: true, result: { nextPageId: null, items: [{ id: 'saved-1' }] } });
    expect(await f.dispatch(next)).toMatchObject({ ok: false, error: { code: 'RESYNC_REQUIRED' } });
    expect(history).toHaveBeenCalledTimes(2);
    expect(history).toHaveBeenCalledWith(root, sessionId, 1, 'stable-file');
    expect(JSON.stringify(first)).not.toContain(root);
    f.switchAwayAndBack();
    expect(await f.dispatch(read('session.history'))).toMatchObject({ ok: false, error: { code: 'STALE_SESSION' } });
  });
  it('does not deliver saved history after selection changes during its disk read', async () => {
    const f = fixture();
    vi.spyOn(PiSessionRepository.prototype, 'readHistoryPage').mockImplementation(async () => {
      f.switchAwayAndBack();
      return { items: [], nextOffset: null, stamp: 'stable', mediaOmitted: false, oversizedItems: 0 };
    });
    expect(await f.dispatch(read('session.history'))).toMatchObject({ ok: false, error: { code: 'STALE_SESSION' } });
    expect(requestEnvelopeSchema.safeParse(read('session.history', { pageId: '../private' })).success).toBe(false);
    expect(requestEnvelopeSchema.safeParse(read('session.history', { projectPath: root })).success).toBe(false);
  });
  it('accepts only named scoped schemas, not a caller path, owner, session or unchecked output', () => {
    for (const [method, input] of [['workspace.snapshot', {}], ['workspace.snapshotPage', { pageId: requestId }],
      ['workspace.monitor', { section: 'runs', offset: 25, limit: 25, sinceRevision: 'old' }]] as const) {
      expect(requestEnvelopeSchema.safeParse(read(method, input)).success).toBe(true);
      expect(requestEnvelopeSchema.safeParse({ ...read(method, input), projectPath: root }).success).toBe(false);
      expect(requestEnvelopeSchema.safeParse(read(method, { ...input, ownerId: principalId })).success).toBe(false);
    }
    expect(requestEnvelopeSchema.safeParse({ ...read('workspace.snapshot'), workspaceGeneration: undefined }).success).toBe(false);
    expect(requestEnvelopeSchema.safeParse(read('workspace.monitor', { section: 'runs', offset: 0, limit: 101 })).success).toBe(false);
    expect(requestEnvelopeSchema.safeParse(read('workspace.snapshotPage', { pageId: '../private' })).success).toBe(false);
  });

  it('requires a server-issued client ticket at the command route, not a client ID in JSON', async () => {
    const f = fixture();
    const principal = { kind: 'client', principalId, clientId, workspaceRoots: [root], expiresAt: initialTime + 3600_000 } as const;
    const body = JSON.stringify(read('workspace.monitor', { section: 'runs', offset: 0, limit: 25 }));
    await expect(f.service.onCommand(body, principal, 'forged-ticket', null)).rejects.toThrow('Invalid ticket');
    expect(await f.service.onCommand(body, principal, 'server-issued-ticket', null)).toMatchObject({ ok: true, method: 'workspace.monitor' });
    expect(await f.dispatch({ ...read('workspace.monitor'), clientId })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });

  it('captures immutable bounded snapshot pages with a high-water and keeps raw runtime/path off wire', async () => {
    const f = fixture(350);
    const captured = await f.dispatch(read('workspace.snapshot'));
    expect(captured).toMatchObject({ ok: true, method: 'workspace.snapshot', result: { version: 1, index: 0,
      header: { sessionId, workspaceId, eventStream: { workspaceId, sequence: 0 } } } });
    if (!captured.ok || captured.method !== 'workspace.snapshot') throw new Error('Expected snapshot');
    expect(JSON.stringify(captured.result).length).toBeLessThanOrEqual(SNAPSHOT_PAGE_BYTES);
    const pageId = captured.result.nextPageId;
    expect(pageId).not.toBeNull();
    f.changeMessages();
    const next = await f.dispatch(read('workspace.snapshotPage', { pageId }));
    expect(next).toMatchObject({ ok: true, method: 'workspace.snapshotPage', result: { snapshotId: captured.result.snapshotId, index: 1 } });
    expect(JSON.stringify(next)).not.toContain(root);
    expect(JSON.stringify(next)).not.toContain('new');
    expect(responseEnvelopeSchema.safeParse(next).success).toBe(true);
    expect(f.runtime.flushSnapshotEvents).toHaveBeenCalled();
  });

  it('returns explicit not-ready and denies a foreign workspace before reading private state', async () => {
    const f = fixture();
    f.notReady();
    expect(await f.dispatch(read('workspace.snapshot'))).toMatchObject({ ok: false, error: { code: 'SNAPSHOT_NOT_READY' } });
    f.clearSelection();
    expect(await f.dispatch(read('workspace.monitor'))).toMatchObject({ ok: false, error: { code: 'STALE_SESSION' } });
    const other = { ...read('workspace.snapshot'), workspaceId: '90000000-0000-4000-8000-000000000009' };
    expect(await f.dispatch(other)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(f.monitor).not.toHaveBeenCalled();
  });

  it('binds pages to client and current selection, and expires instead of returning another client or session', async () => {
    for (const change of ['foreign', 'selection', 'expiry', 'generation'] as const) {
      const f = fixture(350);
      const capture = await f.dispatch(read('workspace.snapshot'));
      if (!capture.ok || capture.method !== 'workspace.snapshot' || !capture.result.nextPageId) throw new Error('Expected next page');
      if (change === 'selection') f.switchAwayAndBack();
      if (change === 'expiry') f.expire();
      if (change === 'generation') f.replace();
      const page = await f.dispatch(read('workspace.snapshotPage', { pageId: capture.result.nextPageId }), change === 'foreign' ? foreign : identity);
      expect(page.ok).toBe(false);
      expect(JSON.stringify(page)).not.toContain('xxxx');
    }
  });

  it('uses the scoped Monitor projection with bounded rows, page status, and selection-bound revision', async () => {
    const f = fixture();
    const response = await f.dispatch(read('workspace.monitor', { section: 'runs', offset: 25, limit: 25 }));
    expect(response).toMatchObject({ ok: true, method: 'workspace.monitor', result: { section: 'runs', offset: 25, total: 26,
      sessionId, selectionRevision: 9, revision: '9:reviewed-page-revision',
      sources: { runs: 'partial', tasks: 'unknown' }, items: [{ title: 'Run', state: 'attention' }] } });
    expect(JSON.stringify(response)).not.toContain('Release check');
    expect(JSON.stringify(response)).not.toContain('Run failed safely');
    expect(f.monitor).toHaveBeenCalledWith({ section: 'runs', offset: 25, limit: 25 });
    expect(JSON.stringify(response)).not.toContain(sentinel);
    expect(JSON.stringify(response)).not.toContain(root);
    expect(responseEnvelopeSchema.safeParse(response).success).toBe(true);
    const unchanged = await f.dispatch(read('workspace.monitor', { section: 'runs', offset: 25, limit: 25, sinceRevision: '9:reviewed-page-revision' }));
    expect(unchanged).toMatchObject({ ok: true, result: { unchanged: true, sessionId, selectionRevision: 9, items: [] } });
  });

  it('rejects a monitor read whose snapshot selection changed before dispatch', async () => {
    const f = fixture();
    f.switchAwayAndBack();
    const response = await f.dispatch(read('workspace.monitor', { section: 'runs', offset: 0, limit: 25 }));
    expect(response).toMatchObject({ ok: false, error: { code: 'STALE_SESSION' } });
    expect(f.monitor).not.toHaveBeenCalled();
  });

  it('refuses a dashboard from a different host project without exposing its private row', async () => {
    const f = fixture();
    f.monitor.mockResolvedValueOnce({ ...dashboard(), projectPath: path.resolve('foreign-host-project') });
    const result = await f.dispatch(read('workspace.monitor', { section: 'runs', offset: 0, limit: 25 }));
    expect(result).toMatchObject({ ok: false, error: { code: 'STALE_SESSION' } });
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it('drops a pending Monitor result on ticket loss, replacement, or A→B→A selection', async () => {
    for (const change of ['revoke', 'replace', 'switchAwayAndBack'] as const) {
      const f = fixture();
      f.blockMonitor();
      const result = f.dispatch(read('workspace.monitor', { section: 'runs', offset: 0, limit: 25 }));
      await vi.waitFor(() => expect(f.monitor).toHaveBeenCalledOnce());
      f[change]();
      f.releaseMonitor();
      const resolved = await result;
      expect(resolved.ok).toBe(false);
      expect(JSON.stringify(resolved)).not.toContain(sentinel);
    }
  });
});
