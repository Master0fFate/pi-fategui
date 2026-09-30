import { describe, expect, it, vi } from 'vitest';
import { buildMonitorDashboard } from './MonitorDashboard';
import { createMonitorDashboardTool, MONITOR_DASHBOARD_TOOL_NAME } from './MonitorDashboardTool';

const base = { projectPath: '/trusted', sessionId: 'root', runs: [], runsAvailable: true,
  sessionAvailable: true, teams: [], tasks: null, goal: null, now: 1000 } as const;

describe('read_monitor_dashboard', () => {
  it('uses the calling root session and exposes a small default overview', async () => {
    const read = vi.fn(async (query, sessionId: string) => {
      expect(sessionId).toBe('root');
      return buildMonitorDashboard(base, query);
    });
    const tool = createMonitorDashboardTool(read);
    expect(tool.name).toBe(MONITOR_DASHBOARD_TOOL_NAME);
    const result = await tool.execute('call', {}, undefined, undefined, { sessionManager: { getSessionId: () => 'root' } } as never);
    expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining('Dashboard: normal') })]);
    expect(result.details).toMatchObject({ section: 'overview', counts: { attention: 0 } });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('passes paging and revision checks to the one shared reader', async () => {
    const read = vi.fn(async (query) => buildMonitorDashboard(base, query));
    const tool = createMonitorDashboardTool(read);
    const ctx = { sessionManager: { getSessionId: () => 'root' } } as never;
    const first = await tool.execute('call', { section: 'teams', offset: 2, limit: 5 }, undefined, undefined, ctx);
    const revision = (first.details as { revision: string }).revision;
    const second = await tool.execute('call', { section: 'teams', offset: 2, limit: 5, sinceRevision: revision }, undefined, undefined, ctx);
    expect(read).toHaveBeenCalledWith({ section: 'teams', offset: 2, limit: 5 }, 'root');
    expect(second.details).toMatchObject({ unchanged: true, items: [] });
  });
});
