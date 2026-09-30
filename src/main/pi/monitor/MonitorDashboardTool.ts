import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { MonitorDashboard, MonitorReadInput } from '../../../shared/contracts/monitorDashboard';

export const MONITOR_DASHBOARD_TOOL_NAME = 'read_monitor_dashboard';

/** All displayed rows are available by section and offset. No screenshot or transcript parsing. */
export function createMonitorDashboardTool(read: (input: MonitorReadInput, sessionId: string) => Promise<MonitorDashboard>): ToolDefinition {
  return defineTool({
    name: MONITOR_DASHBOARD_TOOL_NAME,
    label: 'Read monitoring dashboard',
    promptSnippet: 'Check the unified monitoring dashboard before opening detailed logs or calling individual status tools',
    description: 'Read the current monitoring dashboard for this trusted project and root session. Default overview lists work needing attention or currently active. Use section=runs, teams, tasks, or activity with offset/limit to read every retained dashboard row; use sinceRevision for a cheap unchanged check. Investigate source failures and flagged rows with detailed tools. This tool does not approve, stop, or resume work.',
    parameters: Type.Object({
      section: Type.Optional(Type.Union(['overview', 'runs', 'teams', 'tasks', 'activity'].map((value) => Type.Literal(value)))),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      sinceRevision: Type.Optional(Type.String({ maxLength: 64 })),
    }, { additionalProperties: false }),
    executionMode: 'parallel',
    execute: async (_id, params, _signal, _update, ctx) => {
      const dashboard = await read(params, ctx.sessionManager.getSessionId());
      const sources = (Object.keys(dashboard.sources) as Array<keyof typeof dashboard.sources>).map((name) => {
        const checkedAt = dashboard.sourceCheckedAt[name];
        return `${name}=${dashboard.sources[name]}${checkedAt === null ? '' : `@${new Date(checkedAt).toISOString()}`}`;
      });
      const lines = [
        `Dashboard: ${dashboard.overall} | checked ${new Date(dashboard.checkedAt).toISOString()} | revision ${dashboard.revision}`,
        `Project: ${dashboard.projectPath} | session: ${dashboard.sessionId ?? 'none'}`,
        `Work: ${dashboard.counts.attention} attention, ${dashboard.counts.active} active | runs ${dashboard.counts.runs}, teams ${dashboard.counts.teams}, tasks ${dashboard.counts.tasks}, activity ${dashboard.counts.activity}`,
        `Sources: ${sources.join(', ')}`,
        `${dashboard.section}: ${dashboard.unchanged ? 'unchanged' : `${dashboard.offset}-${Math.min(dashboard.offset + dashboard.items.length, dashboard.total)} of ${dashboard.total}`}`,
      ];
      for (const item of dashboard.items) lines.push(`- [${item.state}] ${item.title}${item.detail ? ` · ${item.detail}` : ''} | ${item.ref.kind}:${item.ref.id}${item.ref.teamId ? ` team:${item.ref.teamId}` : ''}`);
      if (!dashboard.unchanged && dashboard.offset + dashboard.items.length < dashboard.total) lines.push(`Next page: section=${dashboard.section}, offset=${dashboard.offset + dashboard.items.length}`);
      return { content: [{ type: 'text' as const, text: lines.join('\n') }], details: dashboard };
    },
  });
}
