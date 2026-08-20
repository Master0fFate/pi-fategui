import type {
  GitChange,
  RuntimeMessage,
  RuntimeState,
  RuntimeTool,
  SubagentRun,
  SubagentWorkflow,
} from '../../../shared/contracts/ipc';
import type { AgentTeam, AgentTeamTimelineEvent } from '../../../shared/contracts/multiAgent';
import type { AffectedPath, ToolProvenance } from '../../../shared/contracts/provenance';

export const FLIGHT_RECORDER_LIMIT = 256;
const ROOT_SOURCE_LIMIT = 256;
const LEGACY_RUN_LIMIT = 32;
const ORIGIN_LIMIT = 8;

export type FlightDeckTarget =
  | { kind: 'agent'; runId: string }
  | { kind: 'team-node'; teamId: string; nodeId: string; taskId?: string }
  | { kind: 'task'; teamId: string; taskId: string; nodeId?: string }
  | { kind: 'tool'; toolCallId: string }
  | { kind: 'message'; messageId: string; timelineId?: string }
  | { kind: 'error'; timelineId: string }
  | { kind: 'file'; path: string };

export interface PulseInput {
  runtime: Pick<RuntimeState, 'queue' | 'contextUsage' | 'sessionOperation' | 'status' | 'error' | 'project' | 'streaming' | 'activeSessionRunning'>;
  tools: readonly RuntimeTool[];
  subagents: readonly SubagentRun[];
  workflows: readonly SubagentWorkflow[];
  teams: readonly AgentTeam[];
  changedFiles: number | null;
}

export type PulseTone = 'neutral' | 'active' | 'attention' | 'success';
export interface ActivityPulseState {
  label: string;
  tone: PulseTone;
  evidence: string[];
  context: string;
}

const testToolNames = new Set(['test', 'tests', 'vitest', 'jest', 'pytest', 'go-test', 'cargo-test']);
const activeSubagentStatuses = new Set<SubagentRun['status']>(['running']);

export function selectActivityPulse(input: PulseInput): ActivityPulseState {
  const { runtime } = input;
  const runningTools = input.tools.filter((tool) => tool.status === 'running');
  const runningAgents = input.subagents.filter((run) => !run.workflowId && activeSubagentStatuses.has(run.status));
  const blockedAgents = input.subagents.filter((run) => !run.workflowId && run.status === 'blocked');
  const queuedAgents = input.subagents.filter((run) => !run.workflowId && run.status === 'queued');
  const runningWorkflowNodes = input.workflows.reduce((count, workflow) => count + workflow.nodes.filter((node) => node.status === 'running').length, 0);
  const queuedWorkflowNodes = input.workflows.reduce((count, workflow) => count + workflow.nodes.filter((node) => node.status === 'pending').length, 0);
  const teamTurns = input.teams.reduce((count, team) => count + team.activeTurns, 0);
  const teamWriter = input.teams.some((team) => team.activeTurns > 0 && team.writerNodeId);
  const waitingTeamTasks = input.teams.reduce((count, team) => count + team.tasks.filter((task) => task.status === 'waiting-for-children').length, 0);
  const queuedTeamTasks = input.teams.reduce((count, team) => count + team.tasks.filter((task) => task.status === 'queued').length, 0);
  const queueCount = (runtime.queue?.steering ?? 0) + (runtime.queue?.followUp ?? 0);
  const activeAgents = runningAgents.length + runningWorkflowNodes + teamTurns;
  const queued = queuedAgents.length + queuedWorkflowNodes + queuedTeamTasks + queueCount;
  const evidence: string[] = [];
  if (runningTools.length) evidence.push(`${runningTools.length} ${runningTools.length === 1 ? 'tool' : 'tools'}`);
  if (activeAgents) evidence.push(`${activeAgents} active`);
  if (queued) evidence.push(`${queued} queued`);
  if (input.changedFiles) evidence.push(`${input.changedFiles} changed`);
  const context = runtime.contextUsage?.percent == null
    ? 'Context unavailable'
    : `${runtime.contextUsage.estimated ? '~' : ''}${runtime.contextUsage.percent.toFixed(1)}% context`;

  if (runtime.sessionOperation) return { label: 'Changing session', tone: 'active', evidence, context };
  if (runtime.status === 'auth-required') return { label: 'Authentication required', tone: 'attention', evidence, context };
  if (runtime.status === 'error' || runtime.error) return { label: 'Runtime needs attention', tone: 'attention', evidence, context };
  if (runtime.status === 'disconnected' && runtime.project) return { label: 'No agent running — pick a session', tone: 'neutral', evidence, context };
  if (!runtime.project) return { label: runtime.status === 'initializing' ? 'Starting' : 'No project open', tone: 'neutral', evidence, context };
  if (runtime.status === 'initializing') return { label: 'Starting', tone: 'active', evidence, context };
  if (runningTools.some((tool) => testToolNames.has(tool.name.toLocaleLowerCase()))) return { label: 'Testing', tone: 'active', evidence, context };
  const editingTool = runningTools.find((tool) => tool.name === 'edit' || tool.name === 'write');
  const editedPath = editingTool?.provenance?.affectedPaths.find((reference) => reference.operation === 'edit' || reference.operation === 'write')?.path;
  if (editingTool) return { label: editedPath ? `Editing ${editedPath}` : 'Editing', tone: 'active', evidence, context };
  const writerNode = input.teams.flatMap((team) => team.nodes).find((node) => input.teams.some((team) => team.writerNodeId === node.id));
  if (teamWriter) return { label: writerNode ? `${writerNode.displayName} is writing` : 'Writer active', tone: 'active', evidence, context };
  if (runtime.streaming || runtime.activeSessionRunning || runningTools.length > 0 || activeAgents > 0) return { label: 'Thinking', tone: 'active', evidence, context };
  if (blockedAgents.length > 0 || waitingTeamTasks > 0) {
    const blockedActor = blockedAgents[0]?.displayName ?? blockedAgents[0]?.handle ?? blockedAgents[0]?.role;
    const waitingTask = input.teams.flatMap((team) => team.tasks.map((task) => ({ team, task }))).find(({ task }) => task.status === 'waiting-for-children');
    const waitingNode = waitingTask?.team.nodes.find((node) => node.id === waitingTask.task.assigneeNodeId);
    const actor = blockedActor ?? waitingNode?.displayName;
    return { label: actor ? `Waiting on ${actor}` : 'Waiting', tone: 'attention', evidence: [`${blockedAgents.length + waitingTeamTasks} blocked`, ...evidence], context };
  }
  if (queued > 0) return { label: 'Queued', tone: 'neutral', evidence, context };
  return { label: 'Ready', tone: 'success', evidence, context };
}

interface TimelineEntry {
  id: string;
  kind: 'message' | 'reasoning' | 'tool' | 'error' | 'compaction';
  timestamp: number;
  messageId?: string;
  toolCallId?: string;
  error?: { message: string };
  phase?: string;
}

export interface RecorderSources {
  timelineOrder: readonly string[];
  timelineById: Record<string, TimelineEntry | undefined>;
  messagesById: Record<string, RuntimeMessage | undefined>;
  reasoningByMessageId?: Record<string, string | undefined>;
  visibleTimelineIds?: ReadonlySet<string>;
  toolsById: Record<string, RuntimeTool | undefined>;
  subagents: readonly SubagentRun[];
  teams: readonly AgentTeam[];
}

export interface FlightRecorderRow {
  id: string;
  source: 'root' | 'legacy' | 'team';
  sourceRank: number;
  sourceIndex: number;
  timestamp: number;
  kind: 'tool' | 'message' | 'error' | 'run' | 'task' | 'envelope' | 'lifecycle';
  title: string;
  detail: string;
  target?: FlightDeckTarget;
  provenance?: ToolProvenance;
}

export interface FlightRecorderProjection {
  rows: FlightRecorderRow[];
  omitted: boolean;
}

function rootRecorderRows(sources: RecorderSources): { rows: FlightRecorderRow[]; omitted: boolean } {
  const selectedIds = sources.timelineOrder.slice(-ROOT_SOURCE_LIMIT);
  const rows = selectedIds.flatMap((id, sourceIndex): FlightRecorderRow[] => {
    const entry = sources.timelineById[id];
    if (!entry || entry.kind === 'compaction') return [];
    if (entry.kind === 'tool' && entry.toolCallId) {
      const tool = sources.toolsById[entry.toolCallId];
      if (!tool) return [];
      return [{
        id: `root:${id}`,
        source: 'root', sourceRank: 0, sourceIndex, timestamp: entry.timestamp,
        kind: 'tool', title: tool.name, detail: tool.status === 'running' ? 'Root tool running' : tool.status === 'error' ? 'Root tool failed' : 'Root tool completed',
        target: { kind: 'tool', toolCallId: tool.id },
        ...(tool.provenance ? { provenance: tool.provenance } : {}),
      }];
    }
    if ((entry.kind === 'message' || entry.kind === 'reasoning') && entry.messageId) {
      const message = sources.messagesById[entry.messageId];
      if (message?.role === 'tool') return [];
      const retained = Boolean(
        message
        && sources.visibleTimelineIds?.has(id)
        && (entry.kind !== 'reasoning' || sources.reasoningByMessageId?.[entry.messageId]),
      );
      return [{
        id: `root:${id}`,
        source: 'root', sourceRank: 0, sourceIndex, timestamp: entry.timestamp,
        kind: message?.error ? 'error' : 'message',
        title: entry.kind === 'reasoning'
          ? 'Assistant reasoning'
          : message?.error ? 'Message failed' : `${message?.role === 'assistant' ? 'Assistant' : message?.role === 'user' ? 'User' : message?.role === 'system' ? 'System' : 'Conversation'} message`,
        detail: retained ? 'Root conversation event' : 'Root conversation target is no longer retained',
        ...(retained ? { target: { kind: 'message' as const, messageId: entry.messageId, ...(entry.kind === 'reasoning' ? { timelineId: id } : {}) } } : {}),
      }];
    }
    if (entry.kind === 'error') {
      const retained = Boolean(sources.visibleTimelineIds?.has(id));
      return [{
        id: `root:${id}`,
        source: 'root', sourceRank: 0, sourceIndex, timestamp: entry.timestamp,
        kind: 'error', title: 'Runtime error', detail: retained ? 'Runtime error retained' : 'Runtime error target is no longer retained',
        ...(retained ? { target: { kind: 'error' as const, timelineId: id } } : {}),
      }];
    }
    return [];
  });
  return { rows, omitted: sources.timelineOrder.length > selectedIds.length };
}

function legacyRecorderRows(sources: RecorderSources): { rows: FlightRecorderRow[]; omitted: boolean } {
  const orderedRuns = [...sources.subagents].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const runs = orderedRuns.slice(-LEGACY_RUN_LIMIT);
  const rows: FlightRecorderRow[] = [];
  let sourceIndex = 0;
  for (const run of runs) {
    rows.push({
      id: `legacy:run:${run.id}`, source: 'legacy', sourceRank: 1, sourceIndex: sourceIndex++, timestamp: run.createdAt,
      kind: 'run', title: run.displayName ?? run.handle ?? run.role, detail: `Legacy agent ${run.status}`, target: { kind: 'agent', runId: run.id },
    });
    for (const message of run.messages) {
      rows.push({
        id: `legacy:${run.id}:message:${message.id}`, source: 'legacy', sourceRank: 1, sourceIndex: sourceIndex++, timestamp: message.timestamp,
        kind: message.error ? 'error' : 'message', title: message.error ? 'Agent message failed' : 'Agent message', detail: run.displayName ?? run.handle ?? run.role,
        target: { kind: 'agent', runId: run.id },
      });
    }
    for (const tool of run.tools) {
      rows.push({
        id: `legacy:${run.id}:tool:${tool.id}`, source: 'legacy', sourceRank: 1, sourceIndex: sourceIndex++, timestamp: tool.startedAt,
        kind: 'tool', title: tool.name, detail: `Agent tool ${tool.status} · opens agent run`, target: { kind: 'agent', runId: run.id },
        ...(tool.provenance ? { provenance: tool.provenance } : {}),
      });
    }
  }
  return {
    rows,
    omitted: orderedRuns.length > runs.length || runs.some((run) => run.transcriptTruncated || run.omittedActivity > 0),
  };
}

function teamEventKind(event: AgentTeamTimelineEvent): FlightRecorderRow['kind'] {
  if (event.type.startsWith('tool.')) return 'tool';
  if (event.type === 'message.completed') return 'message';
  if (event.type === 'error') return 'error';
  if (event.type.startsWith('task.')) return 'task';
  if (event.type.startsWith('envelope.')) return 'envelope';
  return 'lifecycle';
}

function teamTarget(team: AgentTeam, event: AgentTeamTimelineEvent): FlightDeckTarget | undefined {
  if (event.nodeId) return { kind: 'team-node', teamId: team.id, nodeId: event.nodeId, ...(event.taskId ? { taskId: event.taskId } : {}) };
  if (event.taskId) return { kind: 'task', teamId: team.id, taskId: event.taskId };
  return undefined;
}

function teamRecorderRows(sources: RecorderSources): { rows: FlightRecorderRow[]; omitted: boolean } {
  const rows: FlightRecorderRow[] = [];
  let sourceIndex = 0;
  // A team-only timeline longer than its visible limit must report omission even
  // when no other source overflows: those events were dropped before merging.
  let omitted = false;
  for (const team of sources.teams) {
    if (team.timeline.length > FLIGHT_RECORDER_LIMIT) omitted = true;
    for (const event of team.timeline.slice(-FLIGHT_RECORDER_LIMIT)) {
      rows.push({
        id: `team:${team.id}:${event.id}`,
        source: 'team', sourceRank: 2, sourceIndex: sourceIndex++, timestamp: event.timestamp,
        kind: teamEventKind(event), title: event.toolName ?? event.type, detail: event.summary,
        ...(teamTarget(team, event) ? { target: teamTarget(team, event)! } : {}),
        ...(event.provenance ? { provenance: event.provenance } : {}),
      });
    }
  }
  return { rows, omitted };
}

export function selectFlightRecorder(sources: RecorderSources): FlightRecorderProjection {
  const root = rootRecorderRows(sources);
  const legacy = legacyRecorderRows(sources);
  const team = teamRecorderRows(sources);
  const merged = [...root.rows, ...legacy.rows, ...team.rows].sort((left, right) =>
    left.timestamp - right.timestamp
    || left.sourceRank - right.sourceRank
    || left.sourceIndex - right.sourceIndex
    || left.id.localeCompare(right.id));
  return {
    rows: merged.slice(-FLIGHT_RECORDER_LIMIT),
    omitted: root.omitted || legacy.omitted || team.omitted || merged.length > FLIGHT_RECORDER_LIMIT,
  };
}

export interface ChangeOrigin {
  id: string;
  actorLabel: string;
  toolName: string;
  timestamp: number;
  provenance: ToolProvenance;
  target: FlightDeckTarget;
}

function originForTool(tool: RuntimeTool, fallbackTarget: FlightDeckTarget): ChangeOrigin | null {
  if (!tool.provenance) return null;
  const actor = tool.provenance.actor;
  return {
    id: `${actor.kind}:${tool.id}`,
    actorLabel: actor.kind === 'root' ? 'Main agent' : actor.kind === 'legacy' ? `Agent ${actor.runId}` : `Team agent ${actor.nodeId}`,
    toolName: tool.name,
    timestamp: tool.startedAt,
    provenance: tool.provenance,
    target: fallbackTarget,
  };
}

function provenanceTouches(provenance: ToolProvenance, change: GitChange): boolean {
  return provenance.affectedPaths.some((reference) => reference.operation !== 'read' && (reference.path === change.path || reference.path === change.oldPath));
}

function originActorKey(origin: ChangeOrigin): string {
  const actor = origin.provenance.actor;
  if (actor.kind === 'root') return 'root';
  if (actor.kind === 'legacy') return `legacy:${actor.runId}`;
  return `team:${actor.nodeId}`;
}

/** Related activity is not causal proof. Multiple distinct actors on one path are ambiguous. */
export function writerConflictState(origins: readonly ChangeOrigin[]): 'none' | 'single' | 'ambiguous' {
  const actors = new Set(origins.map(originActorKey));
  if (actors.size === 0) return 'none';
  if (actors.size === 1) return 'single';
  return 'ambiguous';
}

export function selectChangeOrigins(change: GitChange | undefined, sources: RecorderSources): ChangeOrigin[] {
  if (!change) return [];
  const candidates: ChangeOrigin[] = [];
  for (const id of sources.timelineOrder.slice(-ROOT_SOURCE_LIMIT)) {
    const entry = sources.timelineById[id];
    if (entry?.kind !== 'tool' || !entry.toolCallId) continue;
    const tool = sources.toolsById[entry.toolCallId];
    const origin = tool ? originForTool(tool, { kind: 'tool', toolCallId: tool.id }) : null;
    if (origin && provenanceTouches(origin.provenance, change)) candidates.push(origin);
  }
  const runs = [...sources.subagents].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)).slice(-LEGACY_RUN_LIMIT);
  for (const run of runs) {
    for (const tool of run.tools) {
      const origin = originForTool(tool, { kind: 'agent', runId: run.id });
      if (origin && provenanceTouches(origin.provenance, change)) candidates.push(origin);
    }
  }
  for (const team of sources.teams) {
    for (const event of team.timeline.slice(-FLIGHT_RECORDER_LIMIT)) {
      if (!event.provenance || !provenanceTouches(event.provenance, change)) continue;
      const target = teamTarget(team, event);
      if (!target) continue;
      candidates.push({
        id: `team:${team.id}:${event.toolCallId ?? event.id}`,
        actorLabel: event.nodeId ? `Team agent ${event.nodeId}` : 'Team agent',
        toolName: event.toolName ?? 'tool', timestamp: event.timestamp, provenance: event.provenance, target,
      });
    }
  }
  const deduplicated = new Map<string, ChangeOrigin>();
  for (const origin of candidates.sort((left, right) => right.timestamp - left.timestamp || left.id.localeCompare(right.id))) {
    const path = origin.provenance.affectedPaths.find((reference: AffectedPath) => reference.path === change.path || reference.path === change.oldPath)?.path ?? '';
    const key = `${origin.provenance.actor.kind}:${origin.toolName}:${path}:${origin.target.kind}:${origin.id}`;
    if (!deduplicated.has(key)) deduplicated.set(key, origin);
    if (deduplicated.size === ORIGIN_LIMIT) break;
  }
  return [...deduplicated.values()];
}
