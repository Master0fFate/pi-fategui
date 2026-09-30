import { createHash } from 'node:crypto';
import type { AgentRun } from '../../../shared/contracts/agents';
import type { GoalMaxState } from '../../../shared/contracts/goalmaxxing';
import type { AgentTeam } from '../../../shared/contracts/multiAgent';
import type { TaskList } from '../../../shared/contracts/tasks';
import { monitorDashboardSchema, monitorReadInputSchema, type MonitorDashboard, type MonitorItem, type MonitorReadInput } from '../../../shared/contracts/monitorDashboard';

export interface MonitorRunsSource { runs: AgentRun[]; names: Record<string, string>; checkedAt: number; partial: boolean }

export interface MonitorInputs {
  projectPath: string;
  sessionId: string | null;
  runs: readonly AgentRun[] | null;
  runNames?: Readonly<Record<string, string>>;
  runsCheckedAt?: number | null;
  runsPartial?: boolean;
  teams: readonly AgentTeam[] | null;
  tasks: TaskList | null;
  goal: GoalMaxState | null;
  /** A failed read is unknown, distinct from an empty list. */
  runsAvailable: boolean;
  sessionAvailable: boolean;
  /** False means the task repository has not completed its bind/read. */
  tasksAvailable?: boolean;
  runtimeError?: string | null;
  rootActivity?: readonly { id: string; title: string; detail: string; state: 'normal' | 'attention'; timestamp: number }[];
  now?: number;
}

const short = (value: string | null | undefined, length = 500) => (value ?? '').replace(/\s+/gu, ' ').trim().slice(0, length);
const stableId = (source: string, ...parts: string[]) => `${source}:${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`;
const LONG_WITHOUT_UPDATE_MS = 15 * 60_000;
const rank = (item: MonitorItem) => item.state === 'attention' ? 0 : item.state === 'active' ? 1 : 2;
const sortItems = (items: MonitorItem[]) => items.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));

/** Pure, bounded projection. Never include prompts, approvals, transcripts, tool arguments or secrets. */
export function buildMonitorDashboard(raw: MonitorInputs, query: MonitorReadInput = {}): MonitorDashboard {
  const input = monitorReadInputSchema.parse(query);
  const now = raw.now ?? Date.now();
  const runs: MonitorItem[] = raw.runs?.map((run) => ({
    id: `run:${run.id}`, source: 'runs',
    state: run.status === 'failed' || run.status === 'needs-attention' || run.status === 'running' && run.startedAt !== null && now - run.startedAt >= LONG_WITHOUT_UPDATE_MS ? 'attention'
      : run.status === 'running' || run.status === 'queued' ? 'active' : 'normal',
    title: short(raw.runNames?.[run.id] ?? `Run ${run.id.slice(0, 24)}`, 200),
    detail: run.status === 'running' && run.startedAt !== null && now - run.startedAt >= LONG_WITHOUT_UPDATE_MS
      ? 'Running over 15 minutes; inspect before intervening.' : short(run.error || run.resultSummary || run.status),
    updatedAt: run.finishedAt ?? run.startedAt ?? run.scheduledFor,
    ref: { kind: 'run', id: run.id },
  })) ?? [];
  const teams: MonitorItem[] = (raw.teams ?? []).flatMap((team) => team.nodes.filter((node) => node.depth > 0).map((node): MonitorItem => ({
    id: stableId('team', team.id, node.id), source: 'teams',
    state: node.status === 'failed' || node.status === 'interrupted' || Boolean(node.lastError) || node.status === 'active' && now - node.updatedAt >= LONG_WITHOUT_UPDATE_MS ? 'attention'
      : node.status === 'active' || node.status === 'creating' || node.status === 'closing' ? 'active' : 'normal',
    title: short(`${team.name} / ${node.path}`, 200), detail: node.status === 'active' && now - node.updatedAt >= LONG_WITHOUT_UPDATE_MS
      ? 'No state update for 15 minutes; inspect before intervening.' : short(node.lastError ?? node.status),
    updatedAt: node.updatedAt,
    ref: { kind: 'team-node', id: node.id, teamId: team.id },
  })));
  const tasks: MonitorItem[] = (raw.tasks?.tasks ?? []).map((task): MonitorItem => ({
    id: `task:${task.id}`, source: 'tasks',
    state: task.status === 'blocked' ? 'attention' : task.status === 'in-progress' ? 'active' : 'normal',
    title: short(task.title, 200), detail: short(task.detail || task.status), updatedAt: task.updatedAt,
    ref: { kind: 'task', id: task.id },
  }));
  if (!raw.tasks && raw.goal) {
    for (const criterion of raw.goal.criteria) tasks.push({
      id: `task:${criterion.id}`, source: 'tasks',
      state: criterion.status === 'failed' ? 'attention' : criterion.status === 'active' ? 'active' : 'normal',
      title: short(criterion.title, 200), detail: short(criterion.description), updatedAt: criterion.updatedAt,
      ref: { kind: 'task', id: criterion.id },
    });
  }
  const activity: MonitorItem[] = (raw.rootActivity ?? []).map((event): MonitorItem => ({
    id: `event:${event.id}`, source: 'activity', state: event.state,
    title: short(event.title, 200), detail: short(event.detail), updatedAt: event.timestamp,
    ref: { kind: 'event', id: event.id },
  }));
  activity.push(...(raw.teams ?? []).flatMap((team) => team.timeline.slice(-40).map((event): MonitorItem => ({
    id: stableId('event', team.id, event.id), source: 'activity', state: event.type === 'error' ? 'attention' : 'normal',
    title: short(`${team.name} · ${event.type}`, 200), detail: short(event.summary), updatedAt: event.timestamp,
    ref: { kind: 'event', id: event.id, teamId: team.id },
  }))));
  if (raw.runtimeError) activity.push({ id: 'event:runtime-error', source: 'activity', state: 'attention', title: 'Runtime error', detail: short(raw.runtimeError), updatedAt: now, ref: { kind: 'event', id: 'runtime-error' } });
  // Keep the most recent run outcomes in Activity without loading their saved sessions.
  for (const run of (raw.runs ?? []).slice(0, 20)) {
    if (run.status !== 'failed' && run.status !== 'needs-attention' && run.status !== 'succeeded') continue;
    activity.push({ id: `event:run:${run.id}`, source: 'activity', state: run.status === 'succeeded' ? 'normal' : 'attention',
      title: `Run ${run.status}`, detail: short(run.error ?? run.resultSummary), updatedAt: run.finishedAt ?? run.startedAt ?? run.scheduledFor,
      ref: { kind: 'run', id: run.id },
    });
  }
  const sections = { runs: sortItems(runs), teams: sortItems(teams), tasks: sortItems(tasks), activity: sortItems(activity) };
  const sources = {
    runs: raw.runsAvailable ? raw.runsPartial ? 'partial' as const : 'ready' as const : 'unknown' as const,
    teams: raw.sessionAvailable && raw.teams ? 'ready' as const : 'unknown' as const,
    tasks: raw.sessionAvailable && raw.tasksAvailable !== false ? 'ready' as const : 'unknown' as const,
    activity: raw.sessionAvailable ? 'ready' as const : 'unknown' as const,
  };
  // Activity repeats run/team failures; status counts only primary work rows.
  const work = [...runs, ...teams, ...tasks];
  const sourceCheckedAt = { runs: raw.runsAvailable ? raw.runsCheckedAt ?? now : null,
    teams: sources.teams === 'ready' ? now : null, tasks: sources.tasks === 'ready' ? now : null,
    activity: sources.activity === 'ready' ? now : null };
  const counts = { active: work.filter((item) => item.state === 'active').length,
    attention: work.filter((item) => item.state === 'attention').length + activity.filter((item) => item.state === 'attention' && item.ref.kind === 'event').length,
    runs: runs.length, teams: teams.length, tasks: tasks.length, activity: activity.length };
  const overall = counts.attention > 0 ? 'attention'
    : Object.values(sources).some((status) => status !== 'ready') ? 'unknown'
    : counts.active > 0 ? 'active' : 'normal';
  const overview = sortItems([...work.filter((item) => item.state !== 'normal'), ...activity.filter((item) => item.state === 'attention' && item.ref.kind === 'event')]);
  const available = input.section === 'overview' ? overview : sections[input.section];
  // Revisions are per view: an overview revision cannot hide a newly requested detail page.
  const revision = createHash('sha256').update(JSON.stringify({ sources,
    counts: input.section === 'overview' ? counts : undefined,
    section: input.section, total: available.length, offset: input.offset, limit: input.limit,
    items: available.slice(input.offset, input.offset + input.limit),
  })).digest('hex').slice(0, 32);
  const unchanged = input.sinceRevision === revision;
  return monitorDashboardSchema.parse({ projectPath: raw.projectPath, sessionId: raw.sessionId, checkedAt: now,
    revision, overall, sources, sourceCheckedAt, counts, section: input.section, total: available.length,
    offset: input.offset, limit: input.limit, unchanged, items: unchanged ? [] : available.slice(input.offset, input.offset + input.limit),
  });
}
