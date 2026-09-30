import { describe, expect, it } from 'vitest';
import { NetworkEventReplayGate, projectMonitorForNetwork, projectNetworkEvent } from '../../src/shared/protocol/diagnostics';
import { RedactedLog } from '../../src/server/logging/RedactedLog';
import type { MonitorDashboard } from '../../src/shared/contracts/monitorDashboard';

const sentinel = 'FAKE_OWNER_PROVIDER_SSH_PROMPT_SECRET_7654';
const id = '10000000-0000-4000-8000-000000000001';
const session = '20000000-0000-4000-8000-000000000002';

describe('SECRET-01 network diagnostics projections', () => {
  it('sends only fixed operation metadata, never prompt deltas or provider error bodies', () => {
    const origin = { workspaceId: id, workspaceGeneration: 1, sessionId: session };
    const projected = projectNetworkEvent({ version: 1, serverEpoch: id, streamId: session, sequence: 1, origin,
      event: { kind: 'pi', origin, event: { type: 'assistant.text', timestamp: 123, messageId: 'm1', delta: sentinel } } });
    expect(projected).toMatchObject({ category: 'pi', eventType: 'assistant.text', sequence: 1 });
    expect(JSON.stringify(projected)).not.toContain(sentinel);
    const replay = new NetworkEventReplayGate({ serverEpoch: id, streamId: session,
      workspaceId: id, workspaceGeneration: 1, sequence: 0 });
    expect(replay.accept(projected)).toEqual(projected);
    expect(replay.accept(projected)).toBeNull();
    expect(() => replay.accept({ ...projected, sequence: 3 })).toThrow('RESYNC_REQUIRED');
    const captured: string[] = [];
    new RedactedLog((line) => { captured.push(line); }).write({ method: 'command', requestId: null,
      workspaceId: id, code: 'INTERNAL_ERROR', durationMs: 5, count: 1 });
    expect(captured.join('')).not.toContain(sentinel);
    expect(captured.join('')).toContain('INTERNAL_ERROR');
  });
  it('keeps scoped ordered status rows but excludes arbitrary titles, details, host paths, refs and source IDs', async () => {
    const dashboard: MonitorDashboard = {
      projectPath: `/private/${sentinel}`, sessionId: session, checkedAt: 123, revision: 'rev1', overall: 'unknown',
      sources: { runs: 'unknown', teams: 'ready', tasks: 'unknown', activity: 'unknown' },
      sourceCheckedAt: { runs: null, teams: 123, tasks: null, activity: null },
      counts: { active: 1, attention: 1, runs: 1, teams: 0, tasks: 0, activity: 0 },
      section: 'runs', total: 1, offset: 0, limit: 10, unchanged: false,
      items: [{ id: sentinel, source: 'runs', state: 'attention', title: `Release check /private/${sentinel}/project`,
        detail: `Failed; api_key=${sentinel}; path /private/${sentinel}/project`, updatedAt: 123,
        ref: { kind: 'run', id: sentinel } }],
    };
    const result = await projectMonitorForNetwork(dashboard, { sessionId: session, selectionRevision: 7 });
    expect(result.sources.runs).toBe('unknown');
    expect(result).toMatchObject({ sessionId: session, selectionRevision: 7, revision: '7:rev1' });
    expect(result.items[0]).toMatchObject({ title: 'Run', state: 'attention' });
    expect(result.items[0]?.id).toMatch(/^[a-f0-9]{32}$/u);
    expect(result.items[0]).not.toHaveProperty('detail');
    expect(result.items[0]).not.toHaveProperty('ref');
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(JSON.stringify(result)).not.toContain('/private/');
    const repeated = await projectMonitorForNetwork(dashboard, { sessionId: session, selectionRevision: 7 });
    expect(repeated.items[0]?.id).toBe(result.items[0]?.id);
    const moved = await projectMonitorForNetwork({ ...dashboard, offset: 1 }, { sessionId: session, selectionRevision: 7 });
    expect(moved.items[0]?.id).not.toBe(result.items[0]?.id);
    const switched = await projectMonitorForNetwork(dashboard, { sessionId: session, selectionRevision: 8 });
    expect(switched.items[0]?.id).not.toBe(result.items[0]?.id);
  });
  it('preserves the source page order and safe source/state/action while withholding even plausible clean text', async () => {
    const rows: MonitorDashboard['items'] = [
      { id: 'run:1', source: 'runs', state: 'attention', title: 'Clean release', detail: 'Error', updatedAt: 9, ref: { kind: 'run', id: '1' } },
      { id: 'task:2', source: 'tasks', state: 'active', title: 'Write docs', detail: 'In progress', updatedAt: 8, ref: { kind: 'task', id: '2' } },
      { id: 'event:3', source: 'activity', state: 'normal', title: 'Review', detail: 'Normal', updatedAt: 7, ref: { kind: 'event', id: '3' } },
    ];
    const dashboard: MonitorDashboard = { projectPath: '/private', sessionId: session, checkedAt: 10, revision: 'page-rev', overall: 'unknown',
      sources: { runs: 'partial', teams: 'ready', tasks: 'ready', activity: 'ready' },
      sourceCheckedAt: { runs: 10, teams: 10, tasks: 10, activity: 10 },
      counts: { active: 1, attention: 1, runs: 1, teams: 0, tasks: 1, activity: 1 },
      section: 'overview', total: 3, offset: 0, limit: 10, unchanged: false, items: rows };
    const result = await projectMonitorForNetwork(dashboard, { sessionId: session, selectionRevision: 1 });
    expect(result.sources.runs).toBe('partial');
    expect(result.items.map(({ source, state, title, updatedAt }) => ({ source, state, title, updatedAt }))).toEqual([
      { source: 'runs', state: 'attention', title: 'Run', updatedAt: 9 },
      { source: 'tasks', state: 'active', title: 'Task', updatedAt: 8 },
      { source: 'activity', state: 'normal', title: 'Activity', updatedAt: 7 },
    ]);
    expect(new Set(result.items.map((item) => item.id)).size).toBe(3);
    expect(JSON.stringify(result)).not.toMatch(/Clean release|Write docs|Error|In progress|event:3|run:1|task:2/u);
    const unchanged = await projectMonitorForNetwork({ ...dashboard, unchanged: true, items: [] }, { sessionId: session, selectionRevision: 1 });
    expect(unchanged).toMatchObject({ unchanged: true, items: [], total: 3, sources: { runs: 'partial' } });
  });
});
