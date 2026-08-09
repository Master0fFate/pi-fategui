import { randomUUID } from 'node:crypto';
import type { ModelInfo, PermissionLevel, ThinkingLevel } from '../../../shared/contracts/ipc';
import {
  AGENT_TEAM_MAX_ACTIVE_TURNS,
  AGENT_TEAM_MAX_DEPTH,
  AGENT_TEAM_MAX_MESSAGE_BYTES,
  AGENT_TEAM_MAX_MESSAGES,
  AGENT_TEAM_MAX_NODES,
  agentTeamSchema,
  type AgentTeam,
  type AgentTeamEnvelope,
  type AgentTeamNode,
  type AgentTeamTask,
  type AgentTeamTimelineEvent,
} from '../../../shared/contracts/multiAgent';
import { emptyUsage } from '../SubagentSessionFactory';
import type { AgentTeamLedgerEvent, AgentTeamRuntime } from './AgentTeamTypes';

export const DEFAULT_AGENT_TEAM_LIMITS = Object.freeze({
  maxDepth: AGENT_TEAM_MAX_DEPTH,
  maxNodes: AGENT_TEAM_MAX_NODES,
  maxActiveTurns: AGENT_TEAM_MAX_ACTIVE_TURNS,
  maxMessages: AGENT_TEAM_MAX_MESSAGES,
  maxMessageBytes: AGENT_TEAM_MAX_MESSAGE_BYTES,
});

export function createTeamRuntime(
  rootSessionId: string,
  projectPath: string,
  model: ModelInfo,
  thinkingLevel: ThinkingLevel,
  permissionLevel: PermissionLevel,
  options: { name?: string; selected?: boolean; now?: number } = {},
): AgentTeamRuntime {
  const now = options.now ?? Date.now();
  const teamId = `team-${randomUUID()}`;
  const rootNodeId = `node-${randomUUID()}`;
  const root: AgentTeamNode = {
    id: rootNodeId,
    teamId,
    parentNodeId: null,
    path: '/root',
    handle: 'root',
    displayName: 'Main agent',
    depth: 0,
    role: 'root',
    agentName: 'root',
    permissionLevel,
    enabledTools: [],
    model,
    thinkingLevel,
    status: 'active',
    childIds: [],
    unreadMessages: 0,
    writer: false,
    usage: emptyUsage(),
    createdAt: now,
    updatedAt: now,
  };
  const timeline: AgentTeamTimelineEvent[] = [{ id: `event-${randomUUID()}`, sequence: 1, type: 'team.created', summary: 'Agent Team V2 created.', timestamp: now }];
  const state: AgentTeam = {
    id: teamId,
    rootSessionId,
    projectPath,
    name: options.name?.trim().slice(0, 100) || 'Agent Team',
    protocolVersion: 2,
    status: 'active',
    selected: options.selected ?? true,
    rootNodeId,
    limits: { ...DEFAULT_AGENT_TEAM_LIMITS },
    activeTurns: 0,
    writerNodeId: null,
    usage: emptyUsage(),
    nodes: [root],
    tasks: [],
    envelopes: [],
    operationReceipts: [],
    timeline,
    createdAt: now,
    updatedAt: now,
  };
  return {
    state,
    nodes: new Map([[root.id, root]]),
    tasks: new Map(),
    envelopes: new Map(),
    nodeRuntime: new Map(),
    pathToNode: new Map([['/root', root.id]]),
    operationReceipts: new Map(),
    waitEdges: new Map(),
    sequence: 1,
  };
}

export function hydrateTeamRuntime(value: unknown, fallbackProjectPath = 'unknown'): AgentTeamRuntime | null {
  const legacy = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const migrated = legacy ? {
    ...legacy,
    projectPath: typeof legacy.projectPath === 'string' && legacy.projectPath ? legacy.projectPath : fallbackProjectPath,
    name: typeof legacy.name === 'string' && legacy.name ? legacy.name : 'Agent Team',
    selected: typeof legacy.selected === 'boolean' ? legacy.selected : true,
  } : value;
  const parsed = agentTeamSchema.safeParse(migrated);
  if (!parsed.success) return null;
  const state = structuredClone(parsed.data);
  for (const node of state.nodes) {
    if (node.depth > 0 && (node.status === 'active' || node.status === 'creating')) {
      node.status = 'interrupted';
      node.lastError = 'Fate UI restarted while this agent turn was active. Resume it explicitly.';
      node.updatedAt = Date.now();
    }
  }
  for (const task of state.tasks) {
    if (task.status === 'running' || task.status === 'queued' || task.status === 'waiting-for-children') {
      task.status = 'interrupted';
      task.error = 'Fate UI restarted while this task was active.';
      task.endedAt = Date.now();
    }
  }
  state.status = state.status === 'closed' || state.status === 'released' ? state.status : 'restored-interrupted';
  state.activeTurns = 0;
  state.writerNodeId = null;
  state.updatedAt = Date.now();
  return {
    state,
    nodes: new Map(state.nodes.map((node) => [node.id, node])),
    tasks: new Map(state.tasks.map((task) => [task.id, task])),
    envelopes: new Map(state.envelopes.map((envelope) => [envelope.id, envelope])),
    nodeRuntime: new Map(),
    pathToNode: new Map(state.nodes.filter((node) => node.status !== 'released').map((node) => [node.path, node.id])),
    operationReceipts: new Map(state.operationReceipts.map((receipt) => [receipt.key, receipt])),
    waitEdges: new Map(),
    sequence: Math.max(0, ...state.timeline.map((event) => event.sequence)),
  };
}

export function ledgerSnapshot(runtime: AgentTeamRuntime, type: string, timestamp = Date.now()): AgentTeamLedgerEvent {
  return {
    kind: 'fate-agent-team-event',
    version: 1,
    teamId: runtime.state.id,
    sequence: runtime.sequence,
    timestamp,
    type,
    payload: { team: projectTeam(runtime) },
  };
}

export function projectTeam(runtime: AgentTeamRuntime): AgentTeam {
  runtime.state.nodes = [...runtime.nodes.values()].sort((left, right) => left.createdAt - right.createdAt || left.path.localeCompare(right.path));
  runtime.state.tasks = [...runtime.tasks.values()].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)).slice(-512);
  runtime.state.envelopes = [...runtime.envelopes.values()].sort((left, right) => left.sequence - right.sequence).slice(-runtime.state.limits.maxMessages);
  runtime.state.operationReceipts = [...runtime.operationReceipts.values()] as AgentTeam['operationReceipts'];
  runtime.state.operationReceipts = runtime.state.operationReceipts.slice(-512);
  runtime.state.timeline = runtime.state.timeline.slice(-256);
  return agentTeamSchema.parse(structuredClone(runtime.state));
}

export function appendTimeline(
  runtime: AgentTeamRuntime,
  type: AgentTeamTimelineEvent['type'],
  summary: string,
  refs: Pick<AgentTeamTimelineEvent, 'nodeId' | 'taskId' | 'envelopeId' | 'toolCallId' | 'toolName' | 'messageId' | 'provenance'> = {},
  timestamp = Date.now(),
): void {
  runtime.sequence += 1;
  runtime.state.updatedAt = timestamp;
  runtime.state.timeline.push({
    id: `event-${randomUUID()}`,
    sequence: runtime.sequence,
    type,
    summary: summary.slice(0, 1_000),
    timestamp,
    ...refs,
  });
}

export function addEnvelope(
  runtime: AgentTeamRuntime,
  input: Omit<AgentTeamEnvelope, 'id' | 'teamId' | 'sequence' | 'createdAt' | 'state'>,
  now = Date.now(),
): AgentTeamEnvelope {
  if (runtime.envelopes.size >= runtime.state.limits.maxMessages) throw new Error(`Agent team message limit (${runtime.state.limits.maxMessages}) reached.`);
  if (Buffer.byteLength(input.content, 'utf8') > runtime.state.limits.maxMessageBytes) throw new Error(`Agent team messages are limited to ${runtime.state.limits.maxMessageBytes} UTF-8 bytes.`);
  const envelope: AgentTeamEnvelope = {
    ...input,
    id: `envelope-${randomUUID()}`,
    teamId: runtime.state.id,
    sequence: runtime.envelopes.size + 1,
    state: 'queued',
    createdAt: now,
  };
  runtime.envelopes.set(envelope.id, envelope);
  appendTimeline(runtime, 'envelope.created', `${envelope.kind} queued for ${envelope.recipientNodeId}.`, { envelopeId: envelope.id, taskId: envelope.taskId }, now);
  return envelope;
}

export function addTask(runtime: AgentTeamRuntime, input: Omit<AgentTeamTask, 'id' | 'teamId' | 'createdAt'>, now = Date.now()): AgentTeamTask {
  const task: AgentTeamTask = { ...input, id: `task-${randomUUID()}`, teamId: runtime.state.id, createdAt: now };
  runtime.tasks.set(task.id, task);
  appendTimeline(runtime, 'task.created', `Task assigned to ${task.assigneeNodeId}.`, { taskId: task.id, nodeId: task.assigneeNodeId }, now);
  return task;
}
