import { create } from 'zustand';
import type { AppError, PiEvent, RuntimeMessage, RuntimeState, RuntimeTool, SubagentRun } from '../../shared/contracts/ipc';
import type { AgentTeam, AgentTeamEnvelope, AgentTeamNode, AgentTeamTask } from '../../shared/contracts/multiAgent';
import { applySubagentChildEvent, boundSubagentRun, boundSubagentRuns } from '../../shared/subagents';
import type { Capability, WireResultOf } from '../../shared/protocol/methods';
import type { NetworkWorkspaceApi } from '../../client/NetworkWorkspaceApi';
export type { NetworkWorkspaceApi } from '../../client/NetworkWorkspaceApi';
import { UnconfirmedCommand } from '../../client/HttpCommandTransport';
import type { PendingCommandMethod } from '../../client/WebFateApi';

export type ReadView<T> = { status: 'loading' | 'unavailable' | 'error'; value?: never }
  | { status: 'ready'; value: T };
interface NetworkViews {
  scopeKey: string | null;
  sessions: ReadView<WireResultOf<'session.list'>>;
  models: ReadView<WireResultOf<'runtime.models'>>;
  queue: ReadView<WireResultOf<'runtime.queueRead'>>;
  teams: ReadView<WireResultOf<'team.read'>>;
  agents: ReadView<WireResultOf<'agent.read'>>;
}
const emptyNetworkViews = (): NetworkViews => ({ scopeKey: null, sessions: { status: 'loading' }, models: { status: 'loading' },
  queue: { status: 'loading' }, teams: { status: 'loading' }, agents: { status: 'loading' } });
export function currentNetworkScope() {
  const state = useRuntimeStore.getState();
  const header = state.snapshot?.header;
  if (state.source !== 'network' || state.phase !== 'observing' || !state.selected || !header?.sessionId
    || header.selectionRevision === undefined || header.workspaceId !== state.selected.workspaceId
    || header.workspaceGeneration !== state.selected.workspaceGeneration) return null;
  return { scope: state.selected, sessionId: header.sessionId, header,
    key: `${header.serverEpoch}:${header.workspaceId}:${header.workspaceGeneration}:${header.sessionId}:${header.selectionRevision}:${header.snapshotId}:${state.request}` };
}
export function canMutateNetwork(api: NetworkWorkspaceApi, capability: Capability): boolean {
  const state = useRuntimeStore.getState();
  const captured = currentNetworkScope();
  return activeViewApi === api && api.isConnected && api.control !== null && api.supports(capability) && captured !== null
    && captured.header.serverEpoch === api.serverEpoch
    && api.pendingPromptReview(captured.scope, captured.sessionId).kind === 'none'
    && !state.networkBusy && state.pendingReview === null && state.networkError === null;
}
import type { SnapshotHeader, SnapshotItem } from '../../shared/protocol/snapshots';

export type RegisteredWorkspace = WireResultOf<'workspace.list'>['workspaces'][number];
export type NetworkTeam = WireResultOf<'team.read'>['teams'][number];
export type NetworkTeamNode = NetworkTeam['nodes'][number];
export type NetworkAgent = WireResultOf<'agent.read'>['agents'][number];
export interface BoundedSnapshot { readonly header: SnapshotHeader; readonly items: readonly SnapshotItem[] }
/** Narrow renderer read port. Neither transport has to invent a full RuntimeState. */
export interface WorkspaceViewApi {
  readonly isConnected: boolean;
  readonly reconnectError: string | null;
  listWorkspaces(): Promise<readonly RegisteredWorkspace[]>;
  /** Resolve only after all pages and the scoped replay acknowledgement are validated.
   * The adapter enforces incomplete-transaction expiry using host time, not the renderer clock.
   */
  readSnapshot(workspace: RegisteredWorkspace): Promise<BoundedSnapshot>;
}
interface WorkspaceViewState {
  networkNavigation: { scopeKey: string; target: NonNullable<WireResultOf<'workspace.monitorDetail'>['target']> } | null;
  networkSelectionNotice: string | null;
  networkViews: NetworkViews;
  networkBusy: boolean;
  networkError: string | null;
  pendingReview: { scope: RegisteredWorkspace; sessionId: string; requestId: string; method?: PendingCommandMethod } | null;
  loadNetworkViews: (api: NetworkWorkspaceApi, group: 'session' | 'queue' | 'agents') => Promise<void>;
  recoverPendingReview: (api: NetworkWorkspaceApi) => void;
  reviewNetworkCommand: (api: NetworkWorkspaceApi) => Promise<void>;
  runNetworkMutation: (api: NetworkWorkspaceApi, capability: Capability, operation: (scope: RegisteredWorkspace) => Promise<{ readonly requestId: string }>) => Promise<boolean>;
  source: 'desktop' | 'network';
  workspaces: readonly RegisteredWorkspace[];
  selected: RegisteredWorkspace | null;
  snapshot: BoundedSnapshot | null;
  phase: 'synchronizing' | 'observing' | 'disconnected' | 'error';
  error: string | null;
  request: number;
  select: (workspace: RegisteredWorkspace | null) => void;
  initialize: (api: WorkspaceViewApi) => Promise<void>;
  refresh: (api: WorkspaceViewApi) => Promise<void>;
  invalidate: () => void;
  disconnect: () => void;
  reset: () => void;
}
const emptyView = { workspaces: [] as readonly RegisteredWorkspace[], selected: null, snapshot: null,
  phase: 'synchronizing' as const, error: null, networkSelectionNotice: null, networkNavigation: null };
let activeViewApi: WorkspaceViewApi | null = null;
let networkMutationRequest = 0;
const sameWorkspace = (a: RegisteredWorkspace | null, b: RegisteredWorkspace) => a !== null
  && a.workspaceId === b.workspaceId && a.workspaceGeneration === b.workspaceGeneration;

/** Common, source-backed controls. Missing wire fields remain unknown, not defaults. */
export function selectSessionView(state: RuntimeStore) {
  const network = state.source === 'network';
  const controls = network ? state.snapshot?.header.controls : null;
  return {
    source: state.source,
    label: network ? state.selected?.label ?? null : state.runtime.project?.name ?? null,
    sessionId: network ? state.snapshot?.header.sessionId ?? null : state.runtime.sessionId,
    status: network ? controls?.status ?? null : state.runtime.status,
    activeSessionRunning: network ? controls?.activeSessionRunning ?? null : state.runtime.activeSessionRunning ?? state.runtime.streaming,
    permissionLevel: network ? controls?.permissionLevel ?? null : state.runtime.permissionLevel ?? null,
    thinkingLevel: network ? controls?.thinkingLevel ?? null : state.runtime.thinkingLevel,
    model: network ? controls?.model ?? null : state.runtime.model,
    queue: network ? controls?.queue ?? null : state.queue,
    // Transaction/page TTL does not expire a completed, acknowledged live view.
    confirmed: network ? state.phase === 'observing' && state.snapshot !== null
      : state.runtime.status !== 'disconnected',
    capturedAt: network ? state.snapshot?.header.capturedAt ?? null : null,
  };
}

/** Host summaries and desktop Team state are different sources, never interchangeable lifecycle objects. */
export function selectAgentView(state: RuntimeStore): { source: 'desktop' | 'network'; rows: SnapshotHeader['agents']; partial: boolean } {
  if (state.source === 'network') return { source: state.source, rows: state.snapshot?.header.agents ?? [], partial: true };
  const rows = [
    ...state.subagentOrder.flatMap((id) => {
      const run = state.subagentsById[id];
      return run ? [{ id: run.id, title: (run.displayName ?? run.id).slice(0, 240), status: run.status }] : [];
    }),
    ...state.agentTeamOrder.flatMap((id) => state.agentTeamsById[id]?.nodes.map((node) => ({
      id: node.id, title: node.id.slice(0, 240), status: node.status,
    })) ?? []),
  ];
  return { source: state.source, rows: rows.slice(0, 500), partial: rows.length > 500 };
}

type RuntimeQueue = NonNullable<RuntimeState['queue']>;
const emptyQueue = (): RuntimeQueue => ({ steering: 0, followUp: 0, items: [] });

function reconcileQueue(current: RuntimeQueue, steering: number, followUp: number): RuntimeQueue {
  const items = current.items ?? [];
  const retainedSteering = new Set((steering === 0 ? [] : items.filter((item) => item.behavior === 'steer').slice(-steering)).map((item) => item.id));
  const retainedFollowUp = new Set((followUp === 0 ? [] : items.filter((item) => item.behavior === 'followUp').slice(-followUp)).map((item) => item.id));
  return {
    steering,
    followUp,
    items: items.filter((item) => retainedSteering.has(item.id) || retainedFollowUp.has(item.id)),
  };
}

export const MAX_LIVE_TOOL_OUTPUT = 64_000;
export const MAX_LIVE_TIMELINE_ENTITIES = 5_000;
export const MAX_LIVE_IMAGE_CHARACTERS = 20_000_000;

export type ToolExecution = RuntimeTool;

export type TimelineEntity =
  | { id: string; kind: 'message'; messageId: string; timestamp: number }
  | { id: string; kind: 'reasoning'; messageId: string; timestamp: number }
  | { id: string; kind: 'tool'; toolCallId: string; timestamp: number }
  | { id: string; kind: 'error'; error: AppError; timestamp: number }
  | { id: string; kind: 'compaction'; phase: 'started' | 'completed' | 'failed'; aborted?: boolean; error?: AppError; timestamp: number };

const disconnected: RuntimeState = {
  status: 'disconnected', project: null, sessionId: null, sessionFile: null, streaming: false,
  model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null,
};

interface RuntimeStore extends WorkspaceViewState {
  runtime: RuntimeState;
  messagesById: Record<string, RuntimeMessage>;
  messageOrder: string[];
  reasoningByMessageId: Record<string, string>;
  toolsById: Record<string, ToolExecution>;
  toolOrder: string[];
  subagentsById: Record<string, SubagentRun>;
  subagentOrder: string[];
  agentTeamsById: Record<string, AgentTeam>;
  agentTeamOrder: string[];
  agentNodesById: Record<string, AgentTeamNode>;
  agentTasksById: Record<string, AgentTeamTask>;
  agentEnvelopesById: Record<string, AgentTeamEnvelope>;
  timelineById: Record<string, TimelineEntity>;
  timelineOrder: string[];
  visibleTimelineOrder: string[];
  visibleTimelineIds: Set<string>;
  messagesVersion: number;
  reasoningVersion: number;
  toolsVersion: number;
  timelineVersion: number;
  waitPollVersion: number;
  subagentRecorderVersion: number;
  queue: RuntimeQueue;
  lastError: AppError | null;
  /** Last accepted main-process event cursor. Uncursored fixtures do not advance it. */
  sequence: number;
  /** Renderer-local identity sequence for uncursored notice rows. */
  timelineSequence: number;
  activeCompactionId: string | null;
  pendingSessionSwitch: { projectPath: string; sessionId: string; generation: number } | null;
  sessionSwitchGeneration: number;
  setRuntime: (state: RuntimeState) => void;
  hydrateRuntime: (state: RuntimeState) => void;
  beginSessionSwitch: (sessionId: string) => number | null;
  completeSessionSwitch: (generation: number, state: RuntimeState) => boolean;
  cancelSessionSwitch: (generation: number, state: RuntimeState) => boolean;
  applyEvents: (events: PiEvent[]) => void;
}

function boundOutput(output: string): { output: string; outputTruncated: boolean } {
  if (output.length <= MAX_LIVE_TOOL_OUTPUT) return { output, outputTruncated: false };
  const marker = '\n… live output truncated …\n';
  const available = MAX_LIVE_TOOL_OUTPUT - marker.length;
  const startLength = Math.ceil(available / 2);
  const endLength = Math.floor(available / 2);
  return {
    output: `${output.slice(0, startLength)}${marker}${output.slice(-endLength)}`,
    outputTruncated: true,
  };
}

function isSubagentWaitPoll(name: string, input: string): boolean {
  if (name !== 'subagent_manage') return false;
  try {
    return (JSON.parse(input) as { action?: unknown }).action === 'wait';
  } catch {
    return false;
  }
}

function boundLiveText(value: string): string {
  if (value.length <= MAX_LIVE_TOOL_OUTPUT) return value;
  const marker = '\n… live text truncated …\n';
  const available = MAX_LIVE_TOOL_OUTPUT - marker.length;
  return `${value.slice(0, Math.ceil(available / 2))}${marker}${value.slice(-Math.floor(available / 2))}`;
}

function coalesceAdjacentStreamDelta(events: readonly PiEvent[], startIndex: number): { event: PiEvent; lastIndex: number } {
  const first = events[startIndex]!;
  if (first.cursor !== undefined || (first.type !== 'assistant.text' && first.type !== 'assistant.reasoning')) return { event: first, lastIndex: startIndex };
  let delta = first.delta;
  let lastIndex = startIndex;
  while (lastIndex + 1 < events.length) {
    const next = events[lastIndex + 1]!;
    if (next.cursor !== undefined || next.type !== first.type || next.messageId !== first.messageId) break;
    delta += next.delta;
    lastIndex += 1;
  }
  return {
    event: lastIndex === startIndex ? first : { ...first, delta },
    lastIndex,
  };
}

function enforceLiveImageBudget(
  messages: Record<string, RuntimeMessage>,
  tools: Record<string, ToolExecution>,
  timeline: readonly string[],
): { messagesById: Record<string, RuntimeMessage>; toolsById: Record<string, ToolExecution> } {
  let messagesById = messages;
  let toolsById = tools;
  let retainedCharacters = 0;
  const seenMessages = new Set<string>();
  const seenTools = new Set<string>();
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const id = timeline[index]!;
    if (id.startsWith('message:')) {
      const messageId = id.slice('message:'.length);
      if (seenMessages.has(messageId)) continue;
      seenMessages.add(messageId);
      const message = messagesById[messageId];
      const characters = message?.images?.reduce((total, image) => total + image.data.length, 0) ?? 0;
      if (!message || characters === 0) continue;
      if (retainedCharacters + characters <= MAX_LIVE_IMAGE_CHARACTERS) {
        retainedCharacters += characters;
      } else {
        if (messagesById === messages) messagesById = { ...messagesById };
        const { images: _images, ...withoutImages } = message;
        messagesById[messageId] = { ...withoutImages, text: message.text || '[Image omitted from older live history to keep memory bounded.]' };
      }
    } else if (id.startsWith('tool:')) {
      const toolId = id.slice('tool:'.length);
      if (seenTools.has(toolId)) continue;
      seenTools.add(toolId);
      const tool = toolsById[toolId];
      const characters = tool?.images?.reduce((total, image) => total + image.data.length, 0) ?? 0;
      if (!tool || characters === 0) continue;
      if (retainedCharacters + characters <= MAX_LIVE_IMAGE_CHARACTERS) {
        retainedCharacters += characters;
      } else {
        if (toolsById === tools) toolsById = { ...toolsById };
        const { images: _images, ...withoutImages } = tool;
        toolsById[toolId] = { ...withoutImages, output: tool.output || '[Image omitted from older live history to keep memory bounded.]' };
      }
    }
  }
  return { messagesById, toolsById };
}

function indexedSubagents(runs: SubagentRun[] = []) {
  const bounded = boundSubagentRuns(runs);
  return {
    subagentsById: Object.fromEntries(bounded.map((run) => [run.id, run])),
    subagentOrder: bounded.map((run) => run.id),
  };
}

function indexedAgentTeams(teams: AgentTeam[] = []) {
  return {
    agentTeamsById: Object.fromEntries(teams.map((team) => [team.id, team])),
    agentTeamOrder: teams.map((team) => team.id),
    agentNodesById: Object.fromEntries(teams.flatMap((team) => team.nodes.map((node) => [node.id, node]))),
    agentTasksById: Object.fromEntries(teams.flatMap((team) => team.tasks.map((task) => [task.id, task]))),
    agentEnvelopesById: Object.fromEntries(teams.flatMap((team) => team.envelopes.map((envelope) => [envelope.id, envelope]))),
  };
}

function indexed(messages: RuntimeMessage[], tools: RuntimeTool[] = []) {
  let messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));
  let messageOrder = messages.map((message) => message.id);
  let reasoningByMessageId = Object.fromEntries(
    messages.flatMap((message) => message.reasoning ? [[message.id, message.reasoning]] : []),
  );
  let toolsById = Object.fromEntries(tools.map((tool) => [tool.id, tool]));
  let toolOrder = tools.map((tool) => tool.id);
  const timelineById: Record<string, TimelineEntity> = {};
  const ordered: Array<{ id: string; position: number; rank: number }> = [];
  messages.forEach((message, index) => {
    const position = message.timelinePosition ?? index;
    const messageEntry: TimelineEntity = { id: `message:${message.id}`, kind: 'message', messageId: message.id, timestamp: message.timestamp };
    timelineById[messageEntry.id] = messageEntry;
    ordered.push({ id: messageEntry.id, position, rank: 1 });
    if (message.reasoning) {
      const reasoningEntry: TimelineEntity = { id: `reasoning:${message.id}`, kind: 'reasoning', messageId: message.id, timestamp: message.timestamp };
      timelineById[reasoningEntry.id] = reasoningEntry;
      ordered.push({ id: reasoningEntry.id, position, rank: 0 });
    }
  });
  tools.forEach((tool, index) => {
    const entry: TimelineEntity = { id: `tool:${tool.id}`, kind: 'tool', toolCallId: tool.id, timestamp: tool.startedAt };
    timelineById[entry.id] = entry;
    ordered.push({ id: entry.id, position: tool.timelinePosition ?? messages.length + index, rank: 2 });
  });
  ordered.sort((left, right) => left.position - right.position || left.rank - right.rank);
  let timelineOrder = ordered.map((item) => item.id);
  if (timelineOrder.length > MAX_LIVE_TIMELINE_ENTITIES) {
    const existingBoundary = messages.find((message) => message.historyOmitted !== undefined);
    const boundaryMessageId = existingBoundary?.id ?? 'history-boundary-renderer';
    const boundaryTimelineId = `message:${boundaryMessageId}`;
    const recent = timelineOrder.filter((id) => id !== boundaryTimelineId).slice(-(MAX_LIVE_TIMELINE_ENTITIES - 1));
    const retainedTimeline = new Set([boundaryTimelineId, ...recent]);
    const newlyOmitted = timelineOrder.reduce((total, id) => {
      const entry = timelineById[id];
      return total + (id !== boundaryTimelineId && entry && !retainedTimeline.has(id) ? 1 : 0);
    }, 0);
    const omitted = (existingBoundary?.historyOmitted ?? 0) + newlyOmitted;
    if (omitted > 0) {
      const boundary: RuntimeMessage = {
        id: boundaryMessageId,
        role: 'system',
        text: `${omitted.toLocaleString()} earlier conversation items were omitted from this view to keep Fate UI responsive.`,
        timestamp: 0,
        timelinePosition: -1,
        historyOmitted: omitted,
      };
      messagesById[boundaryMessageId] = boundary;
      if (!messageOrder.includes(boundaryMessageId)) messageOrder.unshift(boundaryMessageId);
      timelineById[boundaryTimelineId] = { id: boundaryTimelineId, kind: 'message', messageId: boundaryMessageId, timestamp: 0 };
      timelineOrder = [boundaryTimelineId, ...recent];
    } else {
      timelineOrder = timelineOrder.slice(-MAX_LIVE_TIMELINE_ENTITIES);
      retainedTimeline.clear();
      for (const id of timelineOrder) retainedTimeline.add(id);
    }
    for (const id of Object.keys(timelineById)) if (!retainedTimeline.has(id)) delete timelineById[id];
    const retainedMessages = new Set<string>();
    const retainedReasoning = new Set<string>();
    const retainedTools = new Set<string>();
    for (const entry of Object.values(timelineById)) {
      if (entry.kind === 'message') retainedMessages.add(entry.messageId);
      else if (entry.kind === 'reasoning') { retainedMessages.add(entry.messageId); retainedReasoning.add(entry.messageId); }
      else if (entry.kind === 'tool') retainedTools.add(entry.toolCallId);
    }
    messageOrder = messageOrder.filter((id) => retainedMessages.has(id));
    messagesById = Object.fromEntries(messageOrder.flatMap((id) => messagesById[id] ? [[id, messagesById[id]!]] : []));
    reasoningByMessageId = Object.fromEntries(Object.entries(reasoningByMessageId).filter(([id]) => retainedReasoning.has(id)));
    toolOrder = toolOrder.filter((id) => retainedTools.has(id));
    toolsById = Object.fromEntries(toolOrder.flatMap((id) => toolsById[id] ? [[id, toolsById[id]!]] : []));
  }
  ({ messagesById, toolsById } = enforceLiveImageBudget(messagesById, toolsById, timelineOrder));
  const visibleTimelineOrder = timelineOrder.filter((id) => {
    const entry = timelineById[id];
    if (!entry) return false;
    if (entry.kind === 'message') {
      const message = messagesById[entry.messageId];
      return Boolean(message && (message.role !== 'assistant' || message.text || message.images?.length));
    }
    if (entry.kind === 'reasoning') return Boolean(reasoningByMessageId[entry.messageId]);
    return true;
  });
  return { messagesById, messageOrder, reasoningByMessageId, toolsById, toolOrder, timelineById, timelineOrder, visibleTimelineOrder, visibleTimelineIds: new Set(visibleTimelineOrder) };
}

export const useRuntimeStore = create<RuntimeStore>((set, get) => ({
  ...emptyView, source: 'desktop', request: 0,
  networkViews: emptyNetworkViews(), networkBusy: false, networkError: null, pendingReview: null,
  recoverPendingReview: (api) => {
    const captured = currentNetworkScope();
    if (!captured || activeViewApi !== api) return;
    const retained = get().pendingReview;
    if (retained) {
      const saved = api.pendingPromptReview(retained.scope, retained.sessionId);
      if (retained.method === 'runtime.prompt' || saved.kind !== 'none' && saved.value?.requestId === retained.requestId && saved.value.method === 'runtime.prompt') {
        set({ pendingReview: null, networkError: `Original prompt ${retained.requestId} is retained for Composer review. Its draft and unknown outcome are not cleared.` });
      }
      return;
    }
    const pending = api.pendingPromptReview(captured.scope, captured.sessionId);
    if (pending.kind === 'match' && pending.value.method === 'runtime.prompt') {
      // Composer owns the current prompt draft and its correlated receipt review.
      // Do not strand a second generic record after Composer settles that prompt.
      set({ networkError: `Original prompt ${pending.value.requestId} needs review in Composer. Do not resend.` });
    } else if (pending.kind === 'match') set({ pendingReview: { scope: captured.scope, sessionId: captured.sessionId, requestId: pending.value.requestId, method: pending.value.method },
      networkError: 'Review the original command before another mutation.' });
    else if (pending.kind === 'blocked') {
      const original = pending.value;
      const originalScope = original && original.origin === api.origin && original.authSessionId === api.authenticatedSessionId
        && (!original.hostId || original.hostId === api.hostId)
        ? get().workspaces.find((scope) => scope.workspaceId === original.workspaceId && scope.workspaceGeneration === original.workspaceGeneration) : undefined;
      if (original?.method === 'runtime.prompt') set({ networkError: `Original prompt ${original.requestId} remains bound to workspace ${original.workspaceId}, session ${original.sessionId}. Review it in Composer; changing session or epoch does not permit resend.` });
      else if (original && originalScope) set({ pendingReview: { scope: originalScope, sessionId: original.sessionId, requestId: original.requestId, method: original.method },
        networkError: 'Saved original command needs review in its original workspace. A different selected session does not permit resend.' });
      else set({ networkError: `Pending command recovery is blocked.${original ? ` Original ID: ${original.requestId}.` : ''} Return to its original host/workspace and review it. Do not resend.` });
    } else set({ networkError: null });
  },
  reviewNetworkCommand: async (api) => {
    const pending = get().pendingReview;
    if (!pending || get().networkBusy || !api.isConnected || activeViewApi !== api) return;
    const savedOwner = api.pendingPromptReview(pending.scope, pending.sessionId);
    if (pending.method === 'runtime.prompt' || savedOwner.kind !== 'none' && savedOwner.value?.method === 'runtime.prompt') {
      set({ pendingReview: null, networkError: `Original prompt ${pending.requestId} is retained for Composer review. No original ID, draft or status was cleared.` }); return;
    }
    const request = ++networkMutationRequest;
    const current = () => activeViewApi === api && networkMutationRequest === request && get().pendingReview === pending;
    set({ networkBusy: true });
    try {
      const status = await api.reviewPromptStatus(pending.scope, pending.requestId);
      if (!current()) return;
      if (status.state === 'rejected' || status.state === 'settled' && status.receipt?.requestId === pending.requestId) {
        const saved = api.pendingPromptReview(pending.scope, pending.sessionId);
        if (saved.kind !== 'none' && saved.value?.requestId !== pending.requestId) {
          set({ networkError: 'Saved pending identity changed. Do not erase it or resend; review the saved original ID.' }); return;
        }
        api.clearPendingPromptReview();
        set({ pendingReview: null, networkError: null });
        await get().refresh(api);
      } else set({ networkError: `Original command ${status.state}. No mutation was replayed. Review again; host work may continue.` });
    } catch { if (current()) set({ networkError: 'Original command status is unavailable. Do not resend; reconnect and review its original ID.' }); }
    finally { if (activeViewApi === api && networkMutationRequest === request) set({ networkBusy: false }); }
  },
  runNetworkMutation: async (api, capability, operation) => {
    // Composer alone owns prompt drafts and correlated prompt uncertainty.
    if (capability === 'runtime.prompt') return false;
    const captured = currentNetworkScope();
    if (!captured || !canMutateNetwork(api, capability)) return false;
    get().recoverPendingReview(api);
    if (get().pendingReview || get().networkError) return false;
    const request = ++networkMutationRequest;
    const current = () => activeViewApi === api && networkMutationRequest === request;
    set({ networkBusy: true, networkError: null });
    try {
      api.assertPendingReviewStorageAvailable();
      await operation(captured.scope);
      if (!current() || get().selected?.workspaceId !== captured.scope.workspaceId || get().selected?.workspaceGeneration !== captured.scope.workspaceGeneration) return false;
      await get().refresh(api); // Receipts are admission/outcome facts, never full domain state.
      return current() && get().phase === 'observing';
    } catch (error) {
      if (!current()) return false;
      if (error instanceof UnconfirmedCommand) {
        const saved = api.pendingPromptReview(captured.scope, captured.sessionId);
        const original = saved.kind !== 'none' && saved.value?.requestId === error.requestId ? saved.value : null;
        if (original?.method === 'runtime.prompt') set({ pendingReview: null, networkError: `Original prompt ${error.requestId} is retained for Composer review. Do not resend.` });
        else set({ pendingReview: { scope: captured.scope, sessionId: captured.sessionId, requestId: error.requestId,
          ...(original ? { method: original.method } : {}) }, networkError: 'Command outcome unknown. Review its original ID; do not retry the action.' });
      } else {
        const pending = api.pendingPromptReview(captured.scope, captured.sessionId);
        if (pending.kind === 'match' && pending.value.method !== 'runtime.prompt') set({ pendingReview: { scope: captured.scope,
          sessionId: captured.sessionId, requestId: pending.value.requestId, method: pending.value.method } });
        set({ networkError: 'Host action was not confirmed. Refresh the workspace or review the original command before another action.' });
      }
      return false;
    } finally { if (current()) set({ networkBusy: false }); }
  },
  loadNetworkViews: async (api, group) => {
    const captured = currentNetworkScope();
    if (!captured || !api.isConnected) return;
    if (get().networkViews.scopeKey !== captured.key) set({ networkViews: { ...emptyNetworkViews(), scopeKey: captured.key } });
    const current = () => api.isConnected && currentNetworkScope()?.key === captured.key;
    const load = async <T extends { sessionId: string; selectionRevision: number }>(capability: Capability, read: () => Promise<T>, install: (view: ReadView<T>) => void) => {
      install({ status: api.supports(capability) ? 'loading' : 'unavailable' });
      if (!api.supports(capability)) return;
      try {
        const value = await read();
        if (value.sessionId !== captured.sessionId || value.selectionRevision !== captured.header.selectionRevision) throw new Error('Read selection changed.');
        if (current()) install({ status: 'ready', value });
      } catch { if (current()) install({ status: 'error' }); }
    };
    if (group === 'session') await Promise.all([
      load('session.read', () => api.readSessions(captured.scope), (sessions) => set((state) => ({ networkViews: { ...state.networkViews, sessions } }))),
      load('runtime.configure', () => api.readModels(captured.scope), (models) => set((state) => ({ networkViews: { ...state.networkViews, models } }))),
    ]);
    if (group === 'queue') await load('queue.read', () => api.readQueue(captured.scope), (queue) => set((state) => ({ networkViews: { ...state.networkViews, queue } })));
    if (group === 'agents') await Promise.all([
      load('agent.read', () => api.readTeams(captured.scope), (teams) => set((state) => ({ networkViews: { ...state.networkViews, teams } }))),
      load('agent.read', () => api.readAgents(captured.scope), (agents) => set((state) => ({ networkViews: { ...state.networkViews, agents } }))),
    ]);
  },
  select: (selected) => set((current) => ({ source: 'network', selected, snapshot: null, error: null,
    phase: selected ? 'synchronizing' : 'observing', request: current.request + 1, networkViews: emptyNetworkViews(), networkSelectionNotice: null, networkNavigation: null })),
  invalidate: () => set((current) => ({ phase: 'synchronizing', request: current.request + 1, networkViews: emptyNetworkViews(), networkNavigation: null })),
  disconnect: () => set((current) => ({ phase: activeViewApi?.reconnectError ? 'error' : 'disconnected',
    error: activeViewApi?.reconnectError ?? null, request: current.request + 1 })),
  reset: () => { activeViewApi = null; networkMutationRequest++; set((current) => ({ ...emptyView, source: 'desktop', request: current.request + 1,
    networkViews: emptyNetworkViews(), networkBusy: false, networkError: null, pendingReview: null })); },
  initialize: async (api) => {
    get().reset();
    activeViewApi = api;
    set({ source: 'network' });
    const request = get().request;
    try {
      const workspaces = await api.listWorkspaces();
      if (activeViewApi !== api || get().request !== request || !api.isConnected) return;
      set({ workspaces, selected: workspaces[0] ?? null, phase: workspaces.length ? 'synchronizing' : 'observing' });
    } catch (error) {
      if (activeViewApi === api && get().request === request) set({ phase: api.isConnected ? 'error' : 'disconnected',
        error: error instanceof Error ? error.message : 'Registered workspaces are unavailable.' });
    }
  },
  refresh: async (api) => {
    const selected = get().selected;
    if (!selected || activeViewApi !== api) return;
    const request = get().request + 1;
    set({ request, phase: api.isConnected ? 'synchronizing' : 'disconnected', error: null, networkViews: emptyNetworkViews(), networkNavigation: null });
    if (!api.isConnected) return;
    try {
      const snapshot = await api.readSnapshot(selected);
      if (activeViewApi !== api || get().request !== request || !api.isConnected || !sameWorkspace(get().selected, selected)) return;
      if (snapshot.header.workspaceId !== selected.workspaceId || snapshot.header.workspaceGeneration !== selected.workspaceGeneration) {
        throw new Error('Snapshot scope changed. Select this workspace again.');
      }
      // Both timestamps are host facts. Reject an invalid transaction lifetime,
      // but never compare the host page TTL with the renderer's wall clock.
      // readSnapshot owns expired/incomplete assembly refusal before it resolves.
      if (snapshot.header.expiresAt <= snapshot.header.capturedAt) {
        throw new Error('Snapshot transaction has an invalid lifetime. Refresh this workspace.');
      }
      const previous = get().snapshot?.header;
      const selectionChanged = previous?.serverEpoch === snapshot.header.serverEpoch && previous.sessionId !== snapshot.header.sessionId;
      set({ snapshot, phase: 'observing', error: null, ...(selectionChanged ? {
        networkSelectionNotice: 'Host selected a different session. Unsent drafts stay under their original host, workspace and session.' } : {}) });
    } catch (error) {
      if (activeViewApi !== api || get().request !== request) return;
      set({ phase: api.isConnected ? 'error' : 'disconnected',
        error: error instanceof Error ? error.message : 'The bounded snapshot is unavailable.' });
    }
  },
  runtime: disconnected,
  ...indexed([]),
  ...indexedSubagents(),
  ...indexedAgentTeams(),
  messagesVersion: 0,
  reasoningVersion: 0,
  toolsVersion: 0,
  timelineVersion: 0,
  waitPollVersion: 0,
  subagentRecorderVersion: 0,
  queue: emptyQueue(),
  lastError: null,
  sequence: 0,
  timelineSequence: 0,
  activeCompactionId: null,
  pendingSessionSwitch: null,
  sessionSwitchGeneration: 0,
  setRuntime: (runtime) => set((current) => {
    // Desktop domain results never overwrite an authenticated network view.
    if (current.source === 'network') return current;
    const sameSession = current.runtime.sessionId !== null
      && current.runtime.sessionId === runtime.sessionId
      && current.runtime.project?.path === runtime.project?.path;
    if (sameSession) {
      // Command responses are metadata snapshots. Preserve event-owned entities
      // until an explicit authoritative hydration or session change occurs.
      const subagents = runtime.subagents ? indexedSubagents(runtime.subagents) : {
        subagentsById: current.subagentsById,
        subagentOrder: current.subagentOrder,
      };
      const agentTeams = runtime.agentTeams ? indexedAgentTeams(runtime.agentTeams) : {
        agentTeamsById: current.agentTeamsById,
        agentTeamOrder: current.agentTeamOrder,
        agentNodesById: current.agentNodesById,
        agentTasksById: current.agentTasksById,
        agentEnvelopesById: current.agentEnvelopesById,
      };
      return {
        runtime: {
          ...current.runtime,
          ...runtime,
          messages: current.runtime.messages,
          tools: current.runtime.tools ?? [],
          subagents: subagents.subagentOrder.flatMap((id) => subagents.subagentsById[id] ? [subagents.subagentsById[id]!] : []),
          agentTeams: agentTeams.agentTeamOrder.flatMap((id) => agentTeams.agentTeamsById[id] ? [agentTeams.agentTeamsById[id]!] : []),
        },
        ...subagents,
        ...agentTeams,
        queue: runtime.queue ?? current.queue,
        lastError: runtime.error,
        sequence: runtime.eventCursor === undefined ? current.sequence : Math.max(current.sequence, runtime.eventCursor),
        subagentRecorderVersion: current.subagentRecorderVersion + (runtime.subagents ? 1 : 0),
        pendingSessionSwitch: current.pendingSessionSwitch
          && current.pendingSessionSwitch.projectPath === runtime.project?.path
          && current.pendingSessionSwitch.sessionId === runtime.sessionId
          ? current.pendingSessionSwitch
          : null,
      };
    }
    const projection = indexed(runtime.messages, runtime.tools);
    const subagents = indexedSubagents(runtime.subagents);
    const agentTeams = indexedAgentTeams(runtime.agentTeams);
    return {
      runtime: {
        ...runtime,
        messages: projection.messageOrder.flatMap((id) => projection.messagesById[id] ? [projection.messagesById[id]!] : []),
        tools: projection.toolOrder.flatMap((id) => projection.toolsById[id] ? [projection.toolsById[id]!] : []),
        subagents: subagents.subagentOrder.flatMap((id) => subagents.subagentsById[id] ? [subagents.subagentsById[id]!] : []),
        agentTeams: agentTeams.agentTeamOrder.flatMap((id) => agentTeams.agentTeamsById[id] ? [agentTeams.agentTeamsById[id]!] : []),
      },
      ...projection,
      ...subagents,
      ...agentTeams,
      messagesVersion: current.messagesVersion + 1,
      reasoningVersion: current.reasoningVersion + 1,
      toolsVersion: current.toolsVersion + 1,
      timelineVersion: current.timelineVersion + 1,
      waitPollVersion: current.waitPollVersion + 1,
      subagentRecorderVersion: current.subagentRecorderVersion + 1,
      queue: runtime.queue ?? emptyQueue(),
      lastError: runtime.error,
      sequence: runtime.eventCursor ?? 0,
      timelineSequence: 0,
      activeCompactionId: null,
      pendingSessionSwitch: current.pendingSessionSwitch
        && current.pendingSessionSwitch.projectPath === runtime.project?.path
        && current.pendingSessionSwitch.sessionId === runtime.sessionId
        ? current.pendingSessionSwitch
        : null,
    };
  }),
  hydrateRuntime: (runtime) => set((current) => {
    if (current.source === 'network') return current;
    const projection = indexed(runtime.messages, runtime.tools);
    const subagents = indexedSubagents(runtime.subagents);
    const agentTeams = indexedAgentTeams(runtime.agentTeams);
    return {
      runtime: {
        ...runtime,
        messages: projection.messageOrder.flatMap((id) => projection.messagesById[id] ? [projection.messagesById[id]!] : []),
        tools: projection.toolOrder.flatMap((id) => projection.toolsById[id] ? [projection.toolsById[id]!] : []),
        subagents: subagents.subagentOrder.flatMap((id) => subagents.subagentsById[id] ? [subagents.subagentsById[id]!] : []),
        agentTeams: agentTeams.agentTeamOrder.flatMap((id) => agentTeams.agentTeamsById[id] ? [agentTeams.agentTeamsById[id]!] : []),
      },
      ...projection,
      ...subagents,
      ...agentTeams,
      messagesVersion: current.messagesVersion + 1,
      reasoningVersion: current.reasoningVersion + 1,
      toolsVersion: current.toolsVersion + 1,
      timelineVersion: current.timelineVersion + 1,
      waitPollVersion: current.waitPollVersion + 1,
      subagentRecorderVersion: current.subagentRecorderVersion + 1,
      queue: runtime.queue ?? emptyQueue(),
      lastError: runtime.error,
      sequence: runtime.eventCursor ?? 0,
      timelineSequence: 0,
      activeCompactionId: null,
      pendingSessionSwitch: null,
    };
  }),
  beginSessionSwitch: (sessionId) => {
    let generation: number | null = null;
    set((current) => {
      if (current.source === 'network') return current;
      const projectPath = current.runtime.project?.path;
      const target = current.runtime.sessions?.find((session) => session.id === sessionId);
      if (!projectPath || !target || target.active || current.pendingSessionSwitch) return current;
      generation = current.sessionSwitchGeneration + 1;
      const sessions = current.runtime.sessions?.map((session) => ({ ...session, active: session.id === sessionId }));
      return {
        runtime: {
          ...current.runtime,
          sessionId,
          sessionFile: target.path,
          streaming: target.attention === 'running',
          activeSessionRunning: target.attention === 'running',
          model: null,
          pendingModel: null,
          messages: [],
          tools: [],
          objective: undefined,
          contextUsage: undefined,
          queue: emptyQueue(),
          extensionUi: { statuses: [], widgets: [], working: null, title: null },
          sessions,
          subagents: [],
          subagentWorkflows: [],
          agentTeams: [],
          branches: [],
          forkPoints: [],
          sessionOperation: true,
          error: null,
        },
        ...indexed([]),
        ...indexedSubagents(),
        ...indexedAgentTeams(),
        messagesVersion: current.messagesVersion + 1,
        reasoningVersion: current.reasoningVersion + 1,
        toolsVersion: current.toolsVersion + 1,
        timelineVersion: current.timelineVersion + 1,
        waitPollVersion: current.waitPollVersion + 1,
        subagentRecorderVersion: current.subagentRecorderVersion + 1,
        queue: emptyQueue(),
        lastError: null,
        sequence: 0,
        timelineSequence: 0,
        activeCompactionId: null,
        pendingSessionSwitch: { projectPath, sessionId, generation },
        sessionSwitchGeneration: generation,
      };
    });
    return generation;
  },
  completeSessionSwitch: (generation, runtime) => {
    let completed = false;
    set((current) => {
      if (current.source === 'network') return current;
      const pending = current.pendingSessionSwitch;
      if (!pending || pending.generation !== generation || pending.projectPath !== runtime.project?.path || pending.sessionId !== runtime.sessionId) return current;
      completed = true;
      const projection = indexed(runtime.messages, runtime.tools);
      const subagents = indexedSubagents(runtime.subagents);
      const agentTeams = indexedAgentTeams(runtime.agentTeams);
      return {
        runtime: {
          ...runtime,
          messages: projection.messageOrder.flatMap((id) => projection.messagesById[id] ? [projection.messagesById[id]!] : []),
          tools: projection.toolOrder.flatMap((id) => projection.toolsById[id] ? [projection.toolsById[id]!] : []),
          subagents: subagents.subagentOrder.flatMap((id) => subagents.subagentsById[id] ? [subagents.subagentsById[id]!] : []),
          agentTeams: agentTeams.agentTeamOrder.flatMap((id) => agentTeams.agentTeamsById[id] ? [agentTeams.agentTeamsById[id]!] : []),
        },
        ...projection,
        ...subagents,
        ...agentTeams,
        messagesVersion: current.messagesVersion + 1,
        reasoningVersion: current.reasoningVersion + 1,
        toolsVersion: current.toolsVersion + 1,
        timelineVersion: current.timelineVersion + 1,
        waitPollVersion: current.waitPollVersion + 1,
        subagentRecorderVersion: current.subagentRecorderVersion + 1,
        queue: runtime.queue ?? emptyQueue(),
        lastError: runtime.error,
        sequence: runtime.eventCursor ?? 0,
        timelineSequence: 0,
        activeCompactionId: null,
        pendingSessionSwitch: null,
      };
    });
    return completed;
  },
  cancelSessionSwitch: (generation, runtime) => {
    let cancelled = false;
    set((current) => {
      if (current.source === 'network' || current.pendingSessionSwitch?.generation !== generation) return current;
      cancelled = true;
      const projection = indexed(runtime.messages, runtime.tools);
      const subagents = indexedSubagents(runtime.subagents);
      const agentTeams = indexedAgentTeams(runtime.agentTeams);
      return {
        runtime: {
          ...runtime,
          messages: projection.messageOrder.flatMap((id) => projection.messagesById[id] ? [projection.messagesById[id]!] : []),
          tools: projection.toolOrder.flatMap((id) => projection.toolsById[id] ? [projection.toolsById[id]!] : []),
          subagents: subagents.subagentOrder.flatMap((id) => subagents.subagentsById[id] ? [subagents.subagentsById[id]!] : []),
          agentTeams: agentTeams.agentTeamOrder.flatMap((id) => agentTeams.agentTeamsById[id] ? [agentTeams.agentTeamsById[id]!] : []),
        },
        ...projection,
        ...subagents,
        ...agentTeams,
        messagesVersion: current.messagesVersion + 1,
        reasoningVersion: current.reasoningVersion + 1,
        toolsVersion: current.toolsVersion + 1,
        timelineVersion: current.timelineVersion + 1,
        waitPollVersion: current.waitPollVersion + 1,
        subagentRecorderVersion: current.subagentRecorderVersion + 1,
        queue: runtime.queue ?? emptyQueue(),
        lastError: runtime.error,
        sequence: runtime.eventCursor ?? 0,
        timelineSequence: 0,
        activeCompactionId: null,
        pendingSessionSwitch: null,
      };
    });
    return cancelled;
  },
  applyEvents: (events) => set((current) => {
    if (current.source === 'network') return current;
    let runtime = current.runtime;
    let messagesById = current.messagesById;
    let messageOrder = current.messageOrder;
    let reasoningByMessageId = current.reasoningByMessageId;
    let toolsById = current.toolsById;
    let toolOrder = current.toolOrder;
    let subagentsById = current.subagentsById;
    let subagentOrder = current.subagentOrder;
    let agentTeamsById = current.agentTeamsById;
    let agentTeamOrder = current.agentTeamOrder;
    let agentNodesById = current.agentNodesById;
    let agentTasksById = current.agentTasksById;
    let agentEnvelopesById = current.agentEnvelopesById;
    let subagentsChanged = false;
    let subagentRecorderChanged = false;
    let subagentImagePayloadChanged = false;
    let timelineById = current.timelineById;
    let timelineOrder = current.timelineOrder;
    let visibleTimelineOrder = current.visibleTimelineOrder;
    let visibleTimelineIds = current.visibleTimelineIds;
    let queue = current.queue;
    let lastError = current.lastError;
    let sequence = current.sequence;
    let timelineSequence = current.timelineSequence;
    let activeCompactionId = current.activeCompactionId;
    let pendingSessionSwitch = current.pendingSessionSwitch;
    let imagePayloadChanged = false;
    let runtimeHistoryChanged = false;
    let messagesChanged = false;
    let reasoningChanged = false;
    let toolsChanged = false;
    let timelineChanged = false;
    let waitPollChanged = false;

    // Normalized record containers are store-owned mutable indexes. Entity
    // values remain immutable, while scalar versions invalidate the few broad
    // projections that need a whole record. This avoids cloning up to 5,000
    // record properties for every streaming delta or tool-output batch.
    const setMessage = (id: string, message: RuntimeMessage) => {
      imagePayloadChanged ||= messagesById[id]?.images !== message.images;
      messagesById[id] = message;
      messagesChanged = true;
    };
    const setReasoning = (id: string, value: string) => {
      reasoningByMessageId[id] = value;
      reasoningChanged = true;
    };
    const setTool = (id: string, tool: ToolExecution) => {
      imagePayloadChanged ||= toolsById[id]?.images !== tool.images;
      toolsById[id] = tool;
      toolsChanged = true;
    };
    const setBoundedSubagent = (run: SubagentRun) => {
      if (subagentsById === current.subagentsById) subagentsById = { ...subagentsById };
      if (!subagentsById[run.id]) {
        if (subagentOrder === current.subagentOrder) subagentOrder = [...subagentOrder];
        subagentOrder.push(run.id);
      }
      subagentsById[run.id] = run;
      subagentsChanged = true;
    };
    const setSubagent = (run: SubagentRun) => setBoundedSubagent(boundSubagentRun(run));
    const setTimeline = (entry: TimelineEntity) => {
      timelineById[entry.id] = entry;
      timelineChanged = true;
    };
    const setTimelineVisibility = (id: string, visible: boolean) => {
      const alreadyVisible = visibleTimelineIds.has(id);
      if (visible === alreadyVisible) return;
      timelineChanged = true;
      if (visibleTimelineOrder === current.visibleTimelineOrder) visibleTimelineOrder = [...visibleTimelineOrder];
      if (visibleTimelineIds === current.visibleTimelineIds) visibleTimelineIds = new Set(visibleTimelineIds);
      if (visible) {
        visibleTimelineIds.add(id);
        visibleTimelineOrder.push(id);
      } else {
        visibleTimelineIds.delete(id);
        visibleTimelineOrder = visibleTimelineOrder.filter((entryId) => entryId !== id);
      }
    };
    const appendMessage = (messageId: string, role: RuntimeMessage['role'], timestamp: number) => {
      if (!messagesById[messageId]) {
        setMessage(messageId, { id: messageId, role, text: '', timestamp });
        if (messageOrder === current.messageOrder) messageOrder = [...messageOrder];
        messageOrder.push(messageId);
      }
      const id = `message:${messageId}`;
      if (!timelineById[id]) {
        setTimeline({ id, kind: 'message', messageId, timestamp });
        if (timelineOrder === current.timelineOrder) timelineOrder = [...timelineOrder];
        timelineOrder.push(id);
      }
      if (role !== 'assistant') setTimelineVisibility(id, true);
    };
    const appendReasoning = (messageId: string, timestamp: number) => {
      const id = `reasoning:${messageId}`;
      if (!timelineById[id]) {
        setTimeline({ id, kind: 'reasoning', messageId, timestamp });
        if (timelineOrder === current.timelineOrder) timelineOrder = [...timelineOrder];
        const messageIndex = timelineOrder.indexOf(`message:${messageId}`);
        if (messageIndex === -1) timelineOrder.push(id);
        else timelineOrder.splice(messageIndex, 0, id);
      }
      setTimelineVisibility(id, true);
    };
    const appendTool = (toolCallId: string, timestamp: number) => {
      const id = `tool:${toolCallId}`;
      if (!timelineById[id]) {
        setTimeline({ id, kind: 'tool', toolCallId, timestamp });
        if (timelineOrder === current.timelineOrder) timelineOrder = [...timelineOrder];
        timelineOrder.push(id);
      }
      if (!toolsById[toolCallId]) {
        if (toolOrder === current.toolOrder) toolOrder = [...toolOrder];
        toolOrder.push(toolCallId);
      }
      setTimelineVisibility(id, true);
    };

    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      const merged = coalesceAdjacentStreamDelta(events, eventIndex);
      const event = merged.event;
      eventIndex = merged.lastIndex;
      const crossesSessionBoundary = event.type === 'state.changed'
        && (runtime.project?.path !== event.state.project?.path || runtime.sessionId !== event.state.sessionId);
      if (event.cursor !== undefined && !crossesSessionBoundary) {
        if (event.cursor <= sequence) continue;
        sequence = event.cursor;
      } else if (event.cursor !== undefined) {
        sequence = event.cursor;
      }
      if (pendingSessionSwitch) {
        const confirmsTarget = event.type === 'state.changed'
          && event.messagesIncluded
          && event.state.project?.path === pendingSessionSwitch.projectPath
          && event.state.sessionId === pendingSessionSwitch.sessionId;
        if (!confirmsTarget) continue;
        pendingSessionSwitch = null;
      }
      if (event.type === 'state.changed') {
        const sameSession = runtime.project?.path === event.state.project?.path
          && (runtime.sessionId === null ? messageOrder.length > 0 || toolOrder.length > 0 : runtime.sessionId === event.state.sessionId);
        if (event.messagesIncluded || !sameSession) {
          runtime = event.state;
          ({ messagesById, messageOrder, reasoningByMessageId, toolsById, toolOrder, timelineById, timelineOrder, visibleTimelineOrder, visibleTimelineIds } = indexed(event.state.messages, event.state.tools));
          runtimeHistoryChanged = true;
          messagesChanged = true;
          reasoningChanged = true;
          toolsChanged = true;
          timelineChanged = true;
          waitPollChanged = true;
          ({ subagentsById, subagentOrder } = indexedSubagents(event.state.subagents));
          ({ agentTeamsById, agentTeamOrder, agentNodesById, agentTasksById, agentEnvelopesById } = indexedAgentTeams(event.state.agentTeams));
          subagentsChanged = true;
          subagentRecorderChanged = true;
          activeCompactionId = null;
          timelineSequence = 0;
          sequence = event.state.eventCursor ?? event.cursor ?? (sameSession ? sequence : 0);
          queue = event.state.queue ?? emptyQueue();
        } else {
          if (event.state.subagents) {
            ({ subagentsById, subagentOrder } = indexedSubagents(event.state.subagents));
            subagentsChanged = true;
            subagentRecorderChanged = true;
          }
          if (event.state.agentTeams) ({ agentTeamsById, agentTeamOrder, agentNodesById, agentTasksById, agentEnvelopesById } = indexedAgentTeams(event.state.agentTeams));
          runtime = {
            ...runtime,
            ...event.state,
            messages: runtime.messages,
            tools: runtime.tools ?? [],
            subagents: subagentOrder.flatMap((id) => subagentsById[id] ? [subagentsById[id]!] : []),
          };
          if (event.state.queue) queue = event.state.queue;
          if (event.state.eventCursor !== undefined) sequence = Math.max(sequence, event.state.eventCursor);
        }
        lastError = event.state.error;
      } else if (event.type === 'message.started') {
        appendMessage(event.messageId, event.role, event.timestamp);
      } else if (event.type === 'assistant.text') {
        appendMessage(event.messageId, 'assistant', event.timestamp);
        const existing = messagesById[event.messageId]!;
        setMessage(event.messageId, { ...existing, text: boundLiveText(existing.text + event.delta) });
        setTimelineVisibility(`message:${event.messageId}`, true);
      } else if (event.type === 'assistant.reasoning') {
        appendMessage(event.messageId, 'assistant', event.timestamp);
        appendReasoning(event.messageId, event.timestamp);
        setReasoning(event.messageId, boundLiveText((reasoningByMessageId[event.messageId] ?? '') + event.delta));
      } else if (event.type === 'message.completed') {
        appendMessage(event.messageId, event.role, event.timestamp);
        const existing = messagesById[event.messageId];
        setMessage(event.messageId, {
          id: event.messageId,
          role: event.role,
          text: event.text,
          timestamp: existing?.timestamp ?? event.timestamp,
          ...(event.images === undefined ? {} : { images: event.images }),
          ...(event.error === undefined ? {} : { error: event.error }),
        });
        setTimelineVisibility(`message:${event.messageId}`, event.role !== 'assistant' || Boolean(event.text) || Boolean(event.images?.length));
      } else if (event.type === 'tool.started') {
        appendTool(event.toolCallId, event.timestamp);
        waitPollChanged ||= isSubagentWaitPoll(event.name, event.input);
        setTool(event.toolCallId, {
          id: event.toolCallId, name: event.name, input: event.input, output: '', outputTruncated: false,
          status: 'running', startedAt: event.timestamp, updatedAt: event.timestamp,
          ...(event.subagentRunIds === undefined ? {} : { subagentRunIds: event.subagentRunIds }),
          ...(event.provenance === undefined ? {} : { provenance: event.provenance }),
        });
      } else if (event.type === 'tool.updated') {
        appendTool(event.toolCallId, event.timestamp);
        const existing = toolsById[event.toolCallId] ?? {
          id: event.toolCallId, name: 'Tool', input: '', output: '', outputTruncated: false,
          status: 'running' as const, startedAt: event.timestamp, updatedAt: event.timestamp,
        };
        setTool(event.toolCallId, {
          ...existing,
          ...boundOutput(event.output),
          updatedAt: event.timestamp,
          ...(event.subagentRunIds === undefined ? {} : { subagentRunIds: event.subagentRunIds }),
          ...((event.provenance ?? existing.provenance) === undefined ? {} : { provenance: event.provenance ?? existing.provenance }),
        });
      } else if (event.type === 'tool.completed') {
        appendTool(event.toolCallId, event.timestamp);
        const existing = toolsById[event.toolCallId];
        waitPollChanged ||= isSubagentWaitPoll(event.name, existing?.input ?? '');
        setTool(event.toolCallId, {
          id: event.toolCallId,
          name: event.name,
          input: existing?.input ?? '',
          ...boundOutput(event.output),
          status: event.error ? 'error' : 'succeeded',
          startedAt: existing?.startedAt ?? event.timestamp,
          updatedAt: event.timestamp,
          endedAt: event.timestamp,
          ...(event.images === undefined ? {} : { images: event.images }),
          ...((event.subagentRunIds ?? existing?.subagentRunIds) ? { subagentRunIds: event.subagentRunIds ?? existing?.subagentRunIds } : {}),
          ...((event.provenance ?? existing?.provenance) ? { provenance: event.provenance ?? existing?.provenance } : {}),
        });
      } else if (event.type === 'subagent.started') {
        setSubagent(event.run);
        subagentRecorderChanged = true;
      } else if (event.type === 'subagent.updated') {
        const existing = subagentsById[event.runId];
        if (existing) {
          subagentRecorderChanged ||= event.status !== existing.status || event.displayName !== undefined;
          const base = { ...existing };
          if (event.status === 'queued' || event.status === 'running') delete base.endedAt;
          setSubagent({
            ...base,
            status: event.status,
            updatedAt: event.updatedAt,
            ...(event.startedAt === undefined ? {} : { startedAt: event.startedAt }),
            ...(event.timeoutAt === undefined ? {} : { timeoutAt: event.timeoutAt }),
            ...(event.model === undefined ? {} : { model: event.model }),
            ...(event.thinkingLevel === undefined ? {} : { thinkingLevel: event.thinkingLevel }),
            ...(event.controlCount === undefined ? {} : { controlCount: event.controlCount }),
            ...(event.displayName === undefined ? {} : { displayName: event.displayName }),
            ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
            ...(event.mailbox === undefined ? {} : { mailbox: event.mailbox }),
            ...(event.usage === undefined ? {} : { usage: event.usage }),
          });
        }
      } else if (event.type === 'subagent.event') {
        const existing = subagentsById[event.runId];
        if (existing) {
          subagentRecorderChanged ||= event.event.type === 'message.started'
            || event.event.type === 'message.completed'
            || event.event.type === 'tool.started'
            || event.event.type === 'tool.completed';
          subagentImagePayloadChanged ||= (event.event.type === 'message.completed' || event.event.type === 'tool.completed')
            && Boolean(event.event.images?.length);
          setBoundedSubagent(applySubagentChildEvent(existing, event.event));
        }
      } else if (event.type === 'subagent.liveness') {
        const existing = subagentsById[event.runId];
        if (existing && !(existing.livenessReports ?? []).some((report) => report.id === event.report.id)) {
          setSubagent({
            ...existing,
            livenessReports: [...(existing.livenessReports ?? []), event.report].slice(-20),
            updatedAt: Math.max(existing.updatedAt, event.timestamp),
          });
        }
      } else if (event.type === 'subagent.completed') {
        subagentRecorderChanged = true;
        subagentImagePayloadChanged ||= Boolean(
          event.run.messages.some((message) => message.images?.length)
          || event.run.tools.some((tool) => tool.images?.length),
        );
        setSubagent(event.run);
      } else if (event.type === 'agent-team.updated') {
        const teams = [...(runtime.agentTeams ?? [])];
        const teamIndex = teams.findIndex((team) => team.id === event.team.id);
        if (teamIndex >= 0) teams[teamIndex] = event.team;
        else teams.push(event.team);
        teams.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
        ({ agentTeamsById, agentTeamOrder, agentNodesById, agentTasksById, agentEnvelopesById } = indexedAgentTeams(teams));
        runtime = { ...runtime, agentTeams: teams };
      } else if (event.type === 'subagent.workflow.updated') {
        const workflows = [...(runtime.subagentWorkflows ?? [])];
        const index = workflows.findIndex((workflow) => workflow.id === event.workflow.id);
        if (index >= 0) workflows[index] = event.workflow;
        else workflows.push(event.workflow);
        runtime = { ...runtime, subagentWorkflows: workflows };
      } else if (event.type === 'subagent.workflow.liveness') {
        const workflows = [...(runtime.subagentWorkflows ?? [])];
        const index = workflows.findIndex((workflow) => workflow.id === event.workflowId);
        if (index >= 0) {
          const workflow = workflows[index]!;
          if (!(workflow.livenessReports ?? []).some((report) => report.id === event.report.id)) {
            workflows[index] = {
              ...workflow,
              livenessReports: [...(workflow.livenessReports ?? []), event.report].slice(-20),
              updatedAt: Math.max(workflow.updatedAt, event.timestamp),
            };
            runtime = { ...runtime, subagentWorkflows: workflows };
          }
        }
      } else if (event.type === 'queue.changed') {
        queue = reconcileQueue(queue, event.steering, event.followUp);
        runtime = { ...runtime, queue };
      } else if (event.type === 'context.compaction') {
        if (event.phase === 'started') {
          const id = `compaction:${++timelineSequence}`;
          activeCompactionId = id;
          setTimeline({ id, kind: 'compaction', phase: 'started', timestamp: event.timestamp });
          if (timelineOrder === current.timelineOrder) timelineOrder = [...timelineOrder];
          timelineOrder.push(id);
          setTimelineVisibility(id, true);
        } else {
          const id = activeCompactionId ?? `compaction:${++timelineSequence}`;
          setTimeline({
            id,
            kind: 'compaction',
            phase: event.phase,
            ...(event.aborted === undefined ? {} : { aborted: event.aborted }),
            ...(event.error === undefined ? {} : { error: event.error }),
            timestamp: event.timestamp,
          });
          if (event.error) lastError = event.error;
          if (!timelineOrder.includes(id)) {
            if (timelineOrder === current.timelineOrder) timelineOrder = [...timelineOrder];
            timelineOrder.push(id);
          }
          setTimelineVisibility(id, true);
          activeCompactionId = null;
        }
      } else if (event.type === 'error') {
        lastError = event.error;
        const id = `error:${++timelineSequence}`;
        setTimeline({ id, kind: 'error', error: event.error, timestamp: event.timestamp });
        if (timelineOrder === current.timelineOrder) timelineOrder = [...timelineOrder];
        timelineOrder.push(id);
        setTimelineVisibility(id, true);
      } else if (event.type === 'run.started') {
        runtime = { ...runtime, streaming: true };
      } else if (event.type === 'run.completed') {
        runtime = { ...runtime, streaming: false };
      }
    }
    if (imagePayloadChanged) {
      ({ messagesById, toolsById } = enforceLiveImageBudget(messagesById, toolsById, timelineOrder));
      runtimeHistoryChanged = true;
      messagesChanged = true;
      toolsChanged = true;
    }
    if (timelineOrder.length > MAX_LIVE_TIMELINE_ENTITIES) {
      runtimeHistoryChanged = true;
      messagesChanged = true;
      reasoningChanged = true;
      toolsChanged = true;
      timelineChanged = true;
      waitPollChanged = true;
      const firstEntry = timelineById[timelineOrder[0]!];
      const firstMessage = firstEntry?.kind === 'message' ? messagesById[firstEntry.messageId] : undefined;
      const conventionalBoundary = messagesById['history-boundary-renderer'];
      const existingBoundary = firstMessage?.historyOmitted !== undefined
        ? firstMessage
        : conventionalBoundary?.historyOmitted !== undefined
          ? conventionalBoundary
          : Object.values(messagesById).find((message) => message.historyOmitted !== undefined);
      const boundaryMessageId = existingBoundary?.id ?? 'history-boundary-renderer';
      const boundaryTimelineId = `message:${boundaryMessageId}`;
      let candidates: string[];
      if (timelineOrder[0] === boundaryTimelineId) candidates = timelineOrder.slice(1);
      else if (existingBoundary) candidates = timelineOrder.filter((id) => id !== boundaryTimelineId);
      else candidates = timelineOrder;
      const evictedCount = Math.max(0, candidates.length - (MAX_LIVE_TIMELINE_ENTITIES - 1));
      const evictedIds = candidates.slice(0, evictedCount);
      const recent = candidates.slice(evictedCount);
      const omitted = (existingBoundary?.historyOmitted ?? 0) + evictedIds.length;
      const boundary: RuntimeMessage = {
        id: boundaryMessageId,
        role: 'system',
        text: `${omitted.toLocaleString()} earlier conversation items were omitted from this view to keep Fate UI responsive.`,
        timestamp: 0,
        timelinePosition: -1,
        historyOmitted: omitted,
      };
      setMessage(boundaryMessageId, boundary);
      if (!messageOrder.includes(boundaryMessageId)) messageOrder = [boundaryMessageId, ...messageOrder];
      setTimeline({ id: boundaryTimelineId, kind: 'message', messageId: boundaryMessageId, timestamp: 0 });
      timelineOrder = [boundaryTimelineId, ...recent];

      const removedMessageIds = new Set<string>();
      const removedToolIds = new Set<string>();
      for (const id of evictedIds) {
        const entry = timelineById[id];
        if (!entry) continue;
        delete timelineById[id];
        if (entry.kind === 'message' || entry.kind === 'reasoning') removedMessageIds.add(entry.messageId);
        else if (entry.kind === 'tool') removedToolIds.add(entry.toolCallId);
      }
      for (const id of removedMessageIds) {
        const messageRetained = Boolean(timelineById[`message:${id}`] || timelineById[`reasoning:${id}`]);
        if (!messageRetained) delete messagesById[id];
        if (!timelineById[`reasoning:${id}`]) delete reasoningByMessageId[id];
      }
      for (const id of removedToolIds) {
        if (!timelineById[`tool:${id}`]) delete toolsById[id];
      }
      messageOrder = messageOrder.filter((id) => Boolean(messagesById[id]));
      toolOrder = toolOrder.filter((id) => Boolean(toolsById[id]));
      visibleTimelineOrder = timelineOrder.filter((id) => id === boundaryTimelineId || visibleTimelineIds.has(id));
      visibleTimelineIds = new Set(visibleTimelineOrder);
    }

    // Snapshot arrays must not retain image/history entities removed from the
    // normalized indexes. Refresh once at these boundaries, not on text/tool
    // deltas that preserve image references and intentionally leave snapshots stale.
    if (runtimeHistoryChanged) {
      runtime = {
        ...runtime,
        messages: messageOrder.flatMap((id) => messagesById[id] ? [messagesById[id]!] : []),
        tools: toolOrder.flatMap((id) => toolsById[id] ? [toolsById[id]!] : []),
      };
    }

    if (subagentsChanged) {
      if (subagentImagePayloadChanged) {
        const bounded = boundSubagentRuns(subagentOrder.flatMap((id) => subagentsById[id] ? [subagentsById[id]!] : []));
        subagentsById = Object.fromEntries(bounded.map((run) => [run.id, run]));
      }
      runtime = {
        ...runtime,
        subagents: subagentOrder.flatMap((id) => subagentsById[id] ? [subagentsById[id]!] : []),
      };
    }

    return {
      runtime, messagesById, messageOrder, reasoningByMessageId, toolsById, toolOrder,
      subagentsById, subagentOrder,
      agentTeamsById, agentTeamOrder, agentNodesById, agentTasksById, agentEnvelopesById,
      timelineById, timelineOrder, visibleTimelineOrder, visibleTimelineIds,
      messagesVersion: current.messagesVersion + (messagesChanged ? 1 : 0),
      reasoningVersion: current.reasoningVersion + (reasoningChanged ? 1 : 0),
      toolsVersion: current.toolsVersion + (toolsChanged ? 1 : 0),
      timelineVersion: current.timelineVersion + (timelineChanged ? 1 : 0),
      waitPollVersion: current.waitPollVersion + (waitPollChanged ? 1 : 0),
      subagentRecorderVersion: current.subagentRecorderVersion + (subagentRecorderChanged ? 1 : 0),
      queue, lastError, sequence, timelineSequence, activeCompactionId, pendingSessionSwitch,
    };
  }),
}));
