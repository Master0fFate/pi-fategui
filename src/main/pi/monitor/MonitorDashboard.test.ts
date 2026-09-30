import { describe, expect, it } from 'vitest';
import type { AgentRun } from '../../../shared/contracts/agents';
import type { AgentTeam } from '../../../shared/contracts/multiAgent';
import type { TaskList } from '../../../shared/contracts/tasks';
import { buildMonitorDashboard, type MonitorInputs } from './MonitorDashboard';

const run = (id: string, status: AgentRun['status']): AgentRun => ({
  id, status, startedAt: 100, finishedAt: status === 'failed' ? 200 : null, scheduledFor: 90,
  error: status === 'failed' ? 'Worker failed' : null, resultSummary: '', approvals: [{ action: 'PRIVATE APPROVAL' }],
} as unknown as AgentRun);
const inputs = (patch: Partial<MonitorInputs> = {}): MonitorInputs => ({
  projectPath: '/trusted', sessionId: 'root', runs: [run('a', 'running'), run('b', 'failed')],
  runsAvailable: true, sessionAvailable: true, teams: [], tasks: null, goal: null, now: 1000, ...patch,
});

describe('monitor dashboard projection', () => {
  it('keeps a failed source unknown instead of reporting healthy', () => {
    const dashboard = buildMonitorDashboard(inputs({ runs: null, runsAvailable: false }));
    expect(dashboard.overall).toBe('unknown');
    expect(dashboard.sources.runs).toBe('unknown');
    expect(dashboard.counts.runs).toBe(0);
  });

  it('keeps retained rows visible but marks capped run history partial', () => {
    const dashboard = buildMonitorDashboard(inputs({ runsPartial: true }));
    expect(dashboard.sources.runs).toBe('partial');
    expect(dashboard.items.length).toBeGreaterThan(0);
  });

  it('lists active and failed work first and exposes all retained rows by page', () => {
    const first = buildMonitorDashboard(inputs(), { section: 'runs', limit: 1 });
    expect(first.overall).toBe('attention');
    expect(first.total).toBe(2);
    expect(first.items[0]?.ref).toEqual({ kind: 'run', id: 'b' });
    const next = buildMonitorDashboard(inputs(), { section: 'runs', offset: 1, limit: 1 });
    expect(next.items[0]?.ref.id).toBe('a');
    expect(next.revision).not.toBe(first.revision);
    expect(buildMonitorDashboard(inputs(), { section: 'runs', offset: 1, sinceRevision: first.revision }).unchanged).toBe(false);
    expect(JSON.stringify(first)).not.toContain('PRIVATE APPROVAL');
  });

  it('marks long-running work for investigation without claiming it failed', () => {
    const dashboard = buildMonitorDashboard(inputs({ runs: [run('a', 'running')], now: 20 * 60_000 }));
    expect(dashboard.overall).toBe('attention');
    expect(dashboard.items[0]?.detail).toContain('inspect before intervening');
    expect(dashboard.items[0]?.ref).toEqual({ kind: 'run', id: 'a' });
  });

  it('returns an unchanged marker without dropping health or source state', () => {
    const first = buildMonitorDashboard(inputs());
    const next = buildMonitorDashboard(inputs({ now: 2000 }), { sinceRevision: first.revision });
    expect(next.unchanged).toBe(true);
    expect(next.items).toEqual([]);
    expect(next.checkedAt).toBe(2000);
    expect(next.counts).toEqual(first.counts);
    expect(buildMonitorDashboard(inputs({ runs: [run('a', 'succeeded')] }), { sinceRevision: first.revision }).unchanged).toBe(false);
  });

  it('keeps combined team/event keys bounded without losing full drill-down references', () => {
    const teamId = 't'.repeat(200);
    const nodeId = 'n'.repeat(200);
    const teams = [{ id: teamId, name: 'Team', nodes: [{ id: nodeId, depth: 1, path: '/root/worker', status: 'active', updatedAt: 99 }],
      timeline: [{ id: 'e'.repeat(200), type: 'error', summary: 'Failed', timestamp: 98 }] }] as unknown as AgentTeam[];
    const dashboard = buildMonitorDashboard(inputs({ runs: [], teams }), { section: 'teams' });
    expect(dashboard.items[0]?.id.length).toBeLessThan(250);
    expect(dashboard.items[0]?.ref).toEqual({ kind: 'team-node', id: nodeId, teamId });
    expect(buildMonitorDashboard(inputs({ runs: [], teams }), { section: 'activity' }).items[0]?.id.length).toBeLessThan(250);
  });

  it('surfaces a failed root tool in the overview even when work is otherwise normal', () => {
    const dashboard = buildMonitorDashboard(inputs({ runs: [], rootActivity: [{ id: 'failure', title: 'Tool bash', detail: 'Failed', state: 'attention', timestamp: 77 }] }));
    expect(dashboard.overall).toBe('attention');
    expect(dashboard.items[0]?.title).toBe('Tool bash');
  });

  it('combines team and task warnings without loading transcript data', () => {
    const teams = [{ id: 'team', name: 'Team', nodes: [{ id: 'node', depth: 1, path: '/root/worker', status: 'interrupted', updatedAt: 99, lastError: 'Timed out' }], timeline: [] }] as unknown as AgentTeam[];
    const tasks = { tasks: [{ id: 'task', title: 'Review', detail: 'Blocked by test', status: 'blocked', updatedAt: 88 }] } as unknown as TaskList;
    const dashboard = buildMonitorDashboard(inputs({ runs: [], teams, tasks }));
    expect(dashboard.counts.attention).toBe(2);
    expect(dashboard.items.map((item) => item.ref.kind)).toEqual(['team-node', 'task']);
  });
});
