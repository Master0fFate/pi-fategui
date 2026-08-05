import {
  Bot,
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  GitBranch,
  LoaderCircle,
  MessagesSquare,
  OctagonX,
  Target,
  Wrench,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgentTeam, AgentTeamEnvelope, AgentTeamNode, AgentTeamTimelineEvent } from '../../../shared/contracts/multiAgent';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useShallow } from 'zustand/react/shallow';
import type {
  RuntimeMessage,
  RuntimeTool,
  SubagentRun,
  SubagentStatus,
  SubagentWorkflow,
  SubagentWorkflowNode,
} from '../../../shared/contracts/ipc';
import { subagentDisplayName, subagentHandle } from '../../../shared/subagentIdentity';
import { AssistantMarkdown, MessageImages } from '../chat/RichMessageContent';
import { HorizontalResizeHandle } from '../../components/HorizontalResizeHandle';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { useGoalMaxStore } from '../../stores/goalMaxStore';
import { GoalMaxAgentMarker, GoalMaxAssignmentScope, type GoalMaxAgentLink } from '../goalmaxxing/GoalMaxAgentMarker';
import { SubagentControls, type SubagentControlTarget } from './SubagentControls';
import { AgentTeamControls } from './AgentTeamControls';
import type { FlightDeckTarget } from './flightDeck';

const activeStatuses = new Set<SubagentStatus>(['queued', 'running']);
const TRANSCRIPT_BOTTOM_THRESHOLD_PX = 4;

function useBottomAnchoredTranscript(selectionKey: string, itemCount: number) {
  const listRef = useRef<VirtuosoHandle>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const anchoredSelectionRef = useRef<string | null>(null);
  const pinnedToBottomRef = useRef(true);
  const updatePinnedState = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    pinnedToBottomRef.current = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= TRANSCRIPT_BOTTOM_THRESHOLD_PX;
  }, []);
  const bindScroller = useCallback((target: HTMLElement | Window | null) => {
    const nextScroller = target instanceof HTMLElement ? target : null;
    if (scrollerRef.current === nextScroller) return;
    scrollerRef.current?.removeEventListener('scroll', updatePinnedState);
    scrollerRef.current = nextScroller;
    nextScroller?.addEventListener('scroll', updatePinnedState, { passive: true });
    updatePinnedState();
  }, [updatePinnedState]);
  useEffect(() => () => scrollerRef.current?.removeEventListener('scroll', updatePinnedState), [updatePinnedState]);
  useLayoutEffect(() => {
    if (itemCount === 0) {
      anchoredSelectionRef.current = null;
      return;
    }
    if (anchoredSelectionRef.current === selectionKey) return;
    anchoredSelectionRef.current = selectionKey;
    pinnedToBottomRef.current = true;
    listRef.current?.scrollToIndex({ index: itemCount - 1, align: 'end', behavior: 'auto' });
  }, [itemCount, selectionKey]);
  const followOutput = useCallback(() => pinnedToBottomRef.current ? 'auto' as const : false, []);
  return { listRef, bindScroller, followOutput };
}

function statusLabel(status: SubagentStatus): string {
  switch (status) {
    case 'blocked': return 'Blocked';
    case 'queued': return 'Queued';
    case 'running': return 'Running';
    case 'completed': return 'Completed';
    case 'error': return 'Failed';
    case 'cancelled': return 'Cancelled';
    case 'timed-out': return 'Timed out';
    case 'budget-exceeded': return 'Budget stopped';
    case 'skipped': return 'Skipped';
    case 'interrupted': return 'Interrupted';
  }
}

function StatusIcon({ status, size = 13 }: { status: SubagentStatus; size?: number }) {
  if (status === 'blocked' || status === 'queued') return <Clock3 size={size} aria-hidden="true" />;
  if (status === 'running') return <LoaderCircle size={size} className="tool-spinner" aria-hidden="true" />;
  if (status === 'completed') return <Check size={size} aria-hidden="true" />;
  if (status === 'error') return <CircleAlert size={size} aria-hidden="true" />;
  return <OctagonX size={size} aria-hidden="true" />;
}

type Activity =
  | { id: string; kind: 'message'; position: number; message: RuntimeMessage }
  | { id: string; kind: 'tool'; position: number; tool: RuntimeTool };

function activitiesFor(run: SubagentRun): Activity[] {
  return [
    ...run.messages.map((message, index): Activity => ({
      id: `message:${message.id}`,
      kind: 'message',
      position: message.timelinePosition ?? index,
      message,
    })),
    ...run.tools.map((tool, index): Activity => ({
      id: `tool:${tool.id}`,
      kind: 'tool',
      position: tool.timelinePosition ?? run.messages.length + index,
      tool,
    })),
  ].sort((left, right) => left.position - right.position);
}

function ChildTool({ tool }: { tool: RuntimeTool }) {
  const Icon = tool.status === 'running' ? LoaderCircle : tool.status === 'error' ? CircleAlert : Check;
  return (
    <details className={`subagent-tool subagent-tool--${tool.status}`}>
      <summary>
        <Icon size={12} className={tool.status === 'running' ? 'tool-spinner' : undefined} aria-hidden="true" />
        <strong>{tool.name}</strong>
        <span>{tool.status === 'running' ? 'Running' : tool.status === 'error' ? 'Failed' : 'Done'}</span>
      </summary>
      <div>
        <label>Input</label>
        <pre>{tool.input || '—'}</pre>
        <label>{tool.status === 'error' ? 'Error' : 'Output'}{tool.outputTruncated ? ' · bounded' : ''}</label>
        <pre>{tool.output || (tool.status === 'running' ? 'Waiting for output…' : tool.images?.length ? 'Image output' : 'No output')}</pre>
        {tool.images?.length ? <div className="subagent-tool-images"><MessageImages images={tool.images} /></div> : null}
      </div>
    </details>
  );
}

function ChildMessage({ message }: { message: RuntimeMessage }) {
  if (message.role === 'assistant' && !message.text && !message.reasoning && !message.images?.length) return null;
  const label = message.role === 'user' ? 'Parent task' : message.role === 'assistant' ? 'Child agent' : 'System';
  return (
    <article className={`subagent-message subagent-message--${message.role}${message.error ? ' subagent-message--error' : ''}`}>
      <span className="subagent-activity-label">{label}</span>
      {message.reasoning ? (
        <details className="subagent-reasoning">
          <summary><Brain size={12} aria-hidden="true" /><span className="icon-label">Reasoning</span></summary>
          <pre>{message.reasoning}</pre>
        </details>
      ) : null}
      {message.role === 'assistant' || message.role === 'system' || message.images?.length
        ? <AssistantMarkdown text={message.text} images={message.images} />
        : <p>{message.text}</p>}
    </article>
  );
}

function ActivityRow({ activity }: { activity: Activity }) {
  return (
    <div className="subagent-activity-row">
      {activity.kind === 'message' ? <ChildMessage message={activity.message} /> : <ChildTool tool={activity.tool} />}
    </div>
  );
}

type AgentTeamChatActivity =
  | { id: string; kind: 'envelope'; timestamp: number; order: number; envelope: AgentTeamEnvelope }
  | { id: string; kind: 'tool'; timestamp: number; order: number; started?: AgentTeamTimelineEvent; completed?: AgentTeamTimelineEvent };

type AgentTeamSelection = { team: AgentTeam; node: AgentTeamNode };

function agentTeamActivities(team: AgentTeam, node: AgentTeamNode): AgentTeamChatActivity[] {
  const activities: AgentTeamChatActivity[] = team.envelopes
    .filter((envelope) => envelope.authorNodeId === node.id || envelope.recipientNodeId === node.id)
    .map((envelope) => ({
      id: `envelope:${envelope.id}`,
      kind: 'envelope' as const,
      timestamp: envelope.createdAt,
      order: envelope.sequence,
      envelope,
    }));
  const tools = new Map<string, Extract<AgentTeamChatActivity, { kind: 'tool' }>>();
  for (const event of team.timeline) {
    if (event.nodeId !== node.id || (event.type !== 'tool.started' && event.type !== 'tool.completed')) continue;
    const toolCallId = event.toolCallId ?? event.id;
    const current = tools.get(toolCallId) ?? {
      id: `tool:${toolCallId}`,
      kind: 'tool' as const,
      timestamp: event.timestamp,
      order: event.sequence,
    };
    current.timestamp = Math.min(current.timestamp, event.timestamp);
    current.order = Math.min(current.order, event.sequence);
    if (event.type === 'tool.started') current.started = event;
    else current.completed = event;
    tools.set(toolCallId, current);
  }
  activities.push(...tools.values());
  return activities.sort((left, right) => left.timestamp - right.timestamp || left.order - right.order);
}

function AgentTeamEnvelopeRow({ team, node, envelope }: { team: AgentTeam; node: AgentTeamNode; envelope: AgentTeamEnvelope }) {
  const authoredByNode = envelope.authorNodeId === node.id;
  const peerId = authoredByNode ? envelope.recipientNodeId : envelope.authorNodeId;
  const peer = team.nodes.find((candidate) => candidate.id === peerId);
  const peerLabel = peer ? `@${peer.handle}` : 'team';
  const role = envelope.kind === 'CONTROL' ? 'system' : authoredByNode ? 'assistant' : 'user';
  const label = envelope.kind === 'NEW_TASK'
    ? authoredByNode ? `Delegated task to ${peerLabel}` : 'Parent task'
    : envelope.kind === 'FINAL_ANSWER'
      ? authoredByNode ? 'Child agent' : `Result from ${peerLabel}`
      : envelope.kind === 'MESSAGE'
        ? authoredByNode ? `Message to ${peerLabel}` : `Message from ${peerLabel}`
        : 'System';
  return (
    <article className={`subagent-message subagent-message--${role}`}>
      <span className="subagent-activity-label">{label}</span>
      {role === 'assistant' ? <AssistantMarkdown text={envelope.content} /> : <p>{envelope.content}</p>}
    </article>
  );
}

function AgentTeamToolRow({ activity }: { activity: Extract<AgentTeamChatActivity, { kind: 'tool' }> }) {
  const event = activity.completed ?? activity.started;
  if (!event) return null;
  const failed = activity.completed?.summary.toLocaleLowerCase().includes(' failed ') ?? false;
  const status = activity.completed ? failed ? 'error' : 'succeeded' : 'running';
  const Icon = status === 'running' ? LoaderCircle : status === 'error' ? CircleAlert : Check;
  const paths = event.provenance?.affectedPaths.map((path) => `${path.operation} ${path.path}`) ?? [];
  return (
    <details className={`subagent-tool subagent-tool--${status}`}>
      <summary>
        <Icon size={12} className={status === 'running' ? 'tool-spinner' : undefined} aria-hidden="true" />
        <strong>{event.toolName ?? 'tool'}</strong>
        <span>{status === 'running' ? 'Running' : status === 'error' ? 'Failed' : 'Done'}</span>
      </summary>
      <div>
        <label>Retained activity</label>
        <pre>{activity.completed?.summary ?? activity.started?.summary}</pre>
        {paths.length ? <><label>Affected paths</label><pre>{paths.join('\n')}</pre></> : null}
      </div>
    </details>
  );
}

function AgentTeamActivityRow({ team, node, activity }: { team: AgentTeam; node: AgentTeamNode; activity: AgentTeamChatActivity }) {
  return (
    <div className="subagent-activity-row">
      {activity.kind === 'envelope'
        ? <AgentTeamEnvelopeRow team={team} node={node} envelope={activity.envelope} />
        : <AgentTeamToolRow activity={activity} />}
    </div>
  );
}

function AgentTeamChatPreview({ team, node, goalLink, height }: AgentTeamSelection & { goalLink?: GoalMaxAgentLink | undefined; height: number }) {
  const close = useUiStore((state) => state.closeSubagent);
  const activities = useMemo(() => agentTeamActivities(team, node), [node, team]);
  const transcriptScroll = useBottomAnchoredTranscript(`${team.id}:${node.id}`, activities.length);
  const status = teamNodeStatus(node);
  const active = status === 'queued' || status === 'running';
  const task = node.currentTaskId ? team.tasks.find((candidate) => candidate.id === node.currentTaskId) : undefined;
  const error = node.lastError ?? task?.error;
  return (
    <section className="subagent-chat-preview" aria-label={`${node.displayName} chat preview`} style={{ flexBasis: height }}>
      <header className="subagent-chat-preview-header">
        <span className="subagent-chat-preview-status"><StatusIcon status={status} /></span>
        <span className="subagent-chat-preview-copy">
          <strong>{node.displayName}</strong>
          <small>@{node.handle} · {statusLabel(status)}</small>
        </span>
        <span className="subagent-chat-readonly">Read only</span>
        <button type="button" onClick={close} aria-label="Close sub-agent chat preview"><X size={14} /></button>
      </header>
      {goalLink ? <GoalMaxAssignmentScope link={goalLink} /> : null}
      {error ? <div className="subagent-error" role="alert"><CircleAlert size={13} /><span>{error}</span></div> : null}
      {activities.length === 0 ? (
        <div className="subagent-transcript-empty" role="status">
          {active ? <LoaderCircle size={20} className="tool-spinner" /> : <MessagesSquare size={20} />}
          <span>{active ? 'Waiting for retained team activity…' : 'No retained conversation for this agent.'}</span>
        </div>
      ) : (
        <Virtuoso
          ref={transcriptScroll.listRef}
          key={`team:${team.id}:${node.id}`}
          className="subagent-transcript"
          aria-label="Read-only child transcript"
          data={activities}
          alignToBottom
          initialItemCount={Math.min(activities.length, 12)}
          computeItemKey={(_index, activity) => activity.id}
          itemContent={(_index, activity) => <AgentTeamActivityRow team={team} node={node} activity={activity} />}
          scrollerRef={transcriptScroll.bindScroller}
          followOutput={active ? transcriptScroll.followOutput : false}
        />
      )}
    </section>
  );
}

function SubagentChatPreview({ runId, teamSelection, goalLink, height }: { runId: string | null; teamSelection: AgentTeamSelection | null; goalLink?: GoalMaxAgentLink | undefined; height: number }) {
  const run = useRuntimeStore((state) => runId ? state.subagentsById[runId] : undefined);
  const close = useUiStore((state) => state.closeSubagent);
  const jump = useUiStore((state) => state.flightDeckJump);
  const clearFlightDeckJump = useUiStore((state) => state.clearFlightDeckJump);
  const projectPath = useRuntimeStore((state) => state.runtime.project?.path);
  const sessionId = useRuntimeStore((state) => state.runtime.sessionId);
  const focused = Boolean(run && jump && jump.projectPath === projectPath && jump.sessionId === sessionId && jump.target.kind === 'agent' && jump.target.runId === run.id);
  const previewRef = useRef<HTMLElement>(null);
  const activities = useMemo(() => run ? activitiesFor(run) : [], [run]);
  const transcriptScroll = useBottomAnchoredTranscript(run?.id ?? 'empty', activities.length);
  useEffect(() => {
    const preview = previewRef.current;
    if (!focused || !jump || !preview) return;
    preview.focus({ preventScroll: true });
    if (document.activeElement === preview) clearFlightDeckJump(jump.nonce);
  }, [clearFlightDeckJump, focused, jump]);

  if (!run && teamSelection) return <AgentTeamChatPreview {...teamSelection} goalLink={goalLink} height={height} />;
  if (!run) {
    return (
      <section className="subagent-chat-preview subagent-chat-preview--empty" aria-label="Sub-agent chat preview" style={{ flexBasis: height }}>
        <MessagesSquare size={20} aria-hidden="true" />
        <strong>Select a child agent</strong>
        <span>Its read-only conversation will appear here.</span>
      </section>
    );
  }

  const isActive = activeStatuses.has(run.status);
  const handle = subagentHandle(run);
  const displayName = subagentDisplayName(run);
  return (
    <section ref={previewRef} className="subagent-chat-preview" aria-label={`${displayName} chat preview`} tabIndex={-1} data-flight-focus={focused || undefined} style={{ flexBasis: height }}>
      <header className="subagent-chat-preview-header">
        <span className="subagent-chat-preview-status"><StatusIcon status={run.status} /></span>
        <span className="subagent-chat-preview-copy">
          <strong>{displayName}</strong>
          <small>@{handle} · {statusLabel(run.status)}</small>
        </span>
        <span className="subagent-chat-readonly">Read only</span>
        <button type="button" onClick={close} aria-label="Close sub-agent chat preview"><X size={14} /></button>
      </header>
      {goalLink ? <GoalMaxAssignmentScope link={goalLink} /> : null}
      {run.transcriptTruncated || run.omittedActivity > 0 ? (
        <div className="subagent-boundary">Older child activity was bounded{run.omittedActivity ? ` · ${run.omittedActivity} items omitted` : ''}.</div>
      ) : null}
      {run.result && (run.transcriptTruncated || !run.messages.some((message) => message.role === 'assistant' && message.text)) ? (
        <details className="subagent-final-result">
          <summary>Full final result</summary>
          <pre>{run.result}</pre>
        </details>
      ) : null}
      {run.error ? <div className="subagent-error" role="alert"><CircleAlert size={13} /><span>{run.error}</span></div> : null}
      {activities.length === 0 ? (
        <div className="subagent-transcript-empty" role="status">
          {isActive ? <LoaderCircle size={20} className="tool-spinner" /> : <MessagesSquare size={20} />}
          <span>{run.status === 'queued' ? 'Preparing child conversation…' : isActive ? 'Waiting for child activity…' : 'No transcript was preserved.'}</span>
        </div>
      ) : (
        <Virtuoso
          ref={transcriptScroll.listRef}
          key={`subagent:${run.id}`}
          className="subagent-transcript"
          aria-label="Read-only child transcript"
          data={activities}
          alignToBottom
          initialItemCount={Math.min(activities.length, 12)}
          computeItemKey={(_index, activity) => activity.id}
          itemContent={(_index, activity) => <ActivityRow activity={activity} />}
          scrollerRef={transcriptScroll.bindScroller}
          followOutput={isActive ? transcriptScroll.followOutput : false}
        />
      )}
    </section>
  );
}

type AgentSessionRowView = SubagentControlTarget & Pick<SubagentRun, 'agentSource' | 'agentName' | 'model'>;

function AgentSessionRowById({ runId, goalLink }: { runId: string; goalLink?: GoalMaxAgentLink | undefined }) {
  const selected = useUiStore((state) => state.selectedAgent?.kind === 'subagent' && state.selectedAgent.runId === runId);
  const run = useRuntimeStore(useShallow((state): AgentSessionRowView | null => {
    const current = state.subagentsById[runId];
    if (!current) return null;
    const { id, role, task, handle, displayName, status, mailbox, agentSource, agentName, model } = current;
    return { id, role, task, handle, displayName, status, mailbox, agentSource, agentName, model };
  }));
  return run ? <AgentSessionRow run={run} goalLink={goalLink} selected={selected} /> : null;
}

function AgentSessionRow({ run, goalLink, selected }: { run: AgentSessionRowView; goalLink?: GoalMaxAgentLink | undefined; selected: boolean }) {
  const displayName = subagentDisplayName(run);
  const handle = subagentHandle(run);
  return (
    <article className={`subagent-session-row subagent-session-row--${run.status}`} data-selected={selected || undefined}>
      <button
        className="subagent-session-open"
        type="button"
        aria-current={selected || undefined}
        onClick={() => useUiStore.getState().openSubagent(run.id)}
        aria-label={`Open ${displayName} (${`@${handle}`}) child session: ${statusLabel(run.status)}`}
      >
        <span className="subagent-status-mark"><StatusIcon status={run.status} /></span>
        <span className="subagent-session-copy">
          <span><strong>{displayName}</strong><code>@{handle}</code>{goalLink ? <GoalMaxAgentMarker link={goalLink} /> : null}</span>
          <small>{run.task}</small>
          <span className="subagent-session-meta">
            <em>{statusLabel(run.status)}{run.mailbox.state === 'available' ? ' · mailbox' : ''}</em>
            <small title={`${run.agentSource}/${run.agentName}`}>{run.agentName} profile · {run.model.name}</small>
          </span>
        </span>
        <ChevronRight className="subagent-open-chevron" size={13} aria-hidden="true" />
      </button>
      <SubagentControls run={run} compact />
    </article>
  );
}

function workflowNodeStatus(node: SubagentWorkflowNode): SubagentStatus {
  switch (node.status) {
    case 'pending': return 'queued';
    case 'running': return 'running';
    case 'completed': return 'completed';
    case 'error': return 'error';
    case 'skipped': return 'skipped';
    case 'cancelled': return 'cancelled';
    case 'interrupted': return 'interrupted';
  }
}

function WorkflowNodeRow({ node, goalLink }: { node: SubagentWorkflowNode; goalLink?: GoalMaxAgentLink | undefined }) {
  const status = workflowNodeStatus(node);
  const handle = node.handle ?? node.id;
  const displayName = node.displayName ?? node.id;
  return (
    <article className={`subagent-session-row subagent-session-row--${status} subagent-session-row--placeholder`}>
      <div className="subagent-session-open">
        <span className="subagent-status-mark"><StatusIcon status={status} /></span>
        <span className="subagent-session-copy">
          <span><strong>{displayName}</strong><code data-status={node.status}>@{handle}</code>{goalLink ? <GoalMaxAgentMarker link={goalLink} /> : null}</span>
          <small>{node.task}</small>
          <span className="subagent-session-meta">
            <em>{node.status}</em>
            <small>{node.dependsOn.length ? `After ${node.dependsOn.join(', ')}` : 'Workflow root'}</small>
          </span>
        </span>
      </div>
    </article>
  );
}

function DelegationBranch({
  runs,
  workflow,
  parentError,
  ordinal,
  goalLinks,
}: {
  runs: SubagentRun[];
  workflow?: SubagentWorkflow;
  parentError: boolean;
  ordinal: number;
  goalLinks: ReadonlyMap<string, GoalMaxAgentLink>;
}) {
  const runById = new Map(runs.map((run) => [run.id, run]));
  const renderedRunIds = new Set<string>();
  const workflowChildren = workflow?.nodes.map((node) => {
    const run = node.runId ? runById.get(node.runId) : undefined;
    if (run) renderedRunIds.add(run.id);
    return run
      ? <AgentSessionRowById key={run.id} runId={run.id} goalLink={goalLinks.get(run.id)} />
      : <WorkflowNodeRow key={`node:${node.id}`} node={node} goalLink={node.runId ? goalLinks.get(node.runId) : undefined} />;
  }) ?? [];
  const extraRuns = runs.filter((run) => !renderedRunIds.has(run.id));
  const children = [...workflowChildren, ...extraRuns.map((run) => <AgentSessionRowById key={run.id} runId={run.id} goalLink={goalLinks.get(run.id)} />)];
  const active = runs.filter((run) => activeStatuses.has(run.status)).length
    + (workflow?.nodes.filter((node) => (!node.runId || !runById.has(node.runId)) && (node.status === 'running' || node.status === 'pending')).length ?? 0);
  const completed = workflow?.nodes.filter((node) => node.status === 'completed').length
    ?? runs.filter((run) => run.status === 'completed').length;
  const label = workflow
    ? 'Workflow'
    : runs.some((run) => run.executionMode === 'managed') ? 'Managed delegation' : 'Blocking delegation';
  const branchStatus = workflow?.status ?? (active ? 'running' : parentError || runs.some((run) => run.status === 'error') ? 'error' : 'settled');
  const summary = workflow
    ? `${completed}/${workflow.nodes.length} nodes · up to ${workflow.maxConcurrency} parallel`
    : `${runs.length} ${runs.length === 1 ? 'agent' : 'agents'}${active ? ` · ${active} active` : ''}`;
  const Icon = workflow ? GitBranch : Wrench;
  const latestWorkflowLiveness = workflow?.livenessReports?.[workflow.livenessReports.length - 1];

  return (
    <section className="agent-tree-branch" data-status={branchStatus} aria-label={workflow ? `Workflow ${workflow.id}` : `Delegation ${ordinal}`}>
      <header className="agent-tree-branch-heading">
        <span className="agent-tree-branch-mark"><Icon size={12} aria-hidden="true" /></span>
        <span className="agent-tree-branch-copy"><strong>{label}</strong><small>{summary}</small></span>
        <span className="agent-tree-branch-state">{branchStatus}</span>
      </header>
      {latestWorkflowLiveness ? (
        <details className="subagent-boundary" open={workflow?.status === 'running'}>
          <summary>Workflow liveness checkpoint · {latestWorkflowLiveness.trigger}</summary>
          <p>{latestWorkflowLiveness.reason}</p>
          <pre>{latestWorkflowLiveness.checkpointSummary}</pre>
          <small>Workflow continued automatically · Parent options: {latestWorkflowLiveness.recommendedOptions.join(', ')}</small>
        </details>
      ) : null}
      <div className="agent-tree-children">{children}</div>
      {parentError ? <span className="subagent-parent-error">Parent delegation reported an error</span> : null}
    </section>
  );
}

function teamJumpNodeId(team: AgentTeam, target: FlightDeckTarget): string | null {
  if (target.kind === 'team-node' && target.teamId === team.id) return target.nodeId;
  if (target.kind !== 'task' || target.teamId !== team.id) return null;
  return target.nodeId ?? team.tasks.find((task) => task.id === target.taskId)?.assigneeNodeId ?? null;
}

function teamNodeStatus(node: AgentTeamNode): SubagentStatus {
  if (node.status === 'creating') return 'queued';
  if (node.status === 'active') return 'running';
  if (node.status === 'ready') return 'completed';
  if (node.status === 'failed') return 'error';
  if (node.status === 'interrupted') return 'interrupted';
  return 'cancelled';
}

function AgentTeamNodeRow({ team, node, goalLinks }: { team: AgentTeam; node: AgentTeamNode; goalLinks: ReadonlyMap<string, GoalMaxAgentLink> }) {
  const jump = useUiStore((state) => state.flightDeckJump);
  const selected = useUiStore((state) => state.selectedAgent?.kind === 'team-node' && state.selectedAgent.teamId === team.id && state.selectedAgent.nodeId === node.id);
  const openNode = useUiStore((state) => state.openAgentTeamNode);
  const projectPath = useRuntimeStore((state) => state.runtime.project?.path);
  const sessionId = useRuntimeStore((state) => state.runtime.sessionId);
  const focused = Boolean(jump && jump.projectPath === projectPath && jump.sessionId === sessionId && teamJumpNodeId(team, jump.target) === node.id);
  const rowRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const row = rowRef.current;
    if (!focused || !jump || !row) return;
    openNode(team.id, node.id);
    if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
    row.focus({ preventScroll: true });
    if (document.activeElement === row) useUiStore.getState().clearFlightDeckJump(jump.nonce);
  }, [focused, jump, node.id, openNode, team.id]);
  const children = node.childIds.flatMap((id) => {
    const child = team.nodes.find((candidate) => candidate.id === id);
    return child ? [child] : [];
  }).sort((left, right) => left.path.localeCompare(right.path));
  const task = node.currentTaskId ? team.tasks.find((candidate) => candidate.id === node.currentTaskId) : undefined;
  return (
    <div className="agent-tree-node" data-depth={node.depth} role="treeitem" aria-level={node.depth + 1} aria-expanded={children.length ? true : undefined}>
      <article ref={rowRef} className={`subagent-session-row subagent-session-row--${teamNodeStatus(node)}`} data-flight-focus={focused || undefined} data-selected={selected || undefined} tabIndex={-1}>
        <button
          className="subagent-session-open"
          type="button"
          aria-current={selected || undefined}
          aria-label={`${node.displayName} Agent Team node ${node.status}`}
          onClick={() => openNode(team.id, node.id)}
        >
          <span className="subagent-status-mark"><StatusIcon status={teamNodeStatus(node)} /></span>
          <span className="subagent-session-copy">
            <span><strong>{node.displayName}</strong><code>@{node.handle}</code>{goalLinks.get(node.id) ? <GoalMaxAgentMarker link={goalLinks.get(node.id)!} /> : null}</span>
            <small>{task?.summary ?? node.path}</small>
            <span className="subagent-session-meta"><em>{node.status}{node.writer ? ' · writer' : ''}{node.unreadMessages ? ` · ${node.unreadMessages} unread` : ''}</em><small>{node.agentName} profile · {node.model.name}</small></span>
          </span>
        </button>
        <AgentTeamControls node={node} />
      </article>
      {children.length ? <div className="agent-tree-children" role="group">{children.map((child) => <AgentTeamNodeRow key={child.id} team={team} node={child} goalLinks={goalLinks} />)}</div> : null}
    </div>
  );
}

function AgentTeamBranch({ team, goalLinks }: { team: AgentTeam; goalLinks: ReadonlyMap<string, GoalMaxAgentLink> }) {
  const root = team.nodes.find((node) => node.id === team.rootNodeId);
  const jump = useUiStore((state) => state.flightDeckJump);
  const projectPath = useRuntimeStore((state) => state.runtime.project?.path);
  const sessionId = useRuntimeStore((state) => state.runtime.sessionId);
  const targetNodeId = jump && jump.projectPath === projectPath && jump.sessionId === sessionId ? teamJumpNodeId(team, jump.target) : null;
  const focused = Boolean(root && targetNodeId === root.id);
  const branchRef = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    if (targetNodeId) setExpanded(true);
  }, [targetNodeId]);
  useEffect(() => {
    const branch = branchRef.current;
    if (!focused || !jump || !branch) return;
    if (typeof branch.scrollIntoView === 'function') branch.scrollIntoView({ block: 'nearest' });
    branch.focus({ preventScroll: true });
    if (document.activeElement === branch) useUiStore.getState().clearFlightDeckJump(jump.nonce);
  }, [focused, jump]);
  const children = root?.childIds.flatMap((id) => {
    const child = team.nodes.find((candidate) => candidate.id === id);
    return child ? [child] : [];
  }).sort((left, right) => left.path.localeCompare(right.path)) ?? [];
  const childrenId = `agent-team-children-${team.id}`;
  return (
    <section ref={branchRef} className="agent-tree-branch" data-status={team.status} data-expanded={expanded} aria-label={`Agent Team V2 ${team.id}`} tabIndex={-1} data-flight-focus={focused || undefined}>
      <button className="agent-tree-branch-heading agent-tree-branch-toggle" type="button" aria-expanded={expanded} aria-controls={childrenId} onClick={() => setExpanded((current) => !current)}>
        <span className="agent-tree-branch-mark"><GitBranch size={12} /></span>
        <span className="agent-tree-branch-copy"><strong>Agent Team V2</strong><small>{team.nodes.length - 1}/{team.limits.maxNodes} nodes · {team.activeTurns}/{team.limits.maxActiveTurns} active{team.writerNodeId ? ' · writer leased' : ''}</small></span>
        <span className="agent-tree-branch-state">{team.status}</span>
        <ChevronRight className="agent-tree-branch-chevron" size={13} aria-hidden="true" />
      </button>
      {expanded ? <div id={childrenId} className="agent-tree-children" role="tree">{children.map((node) => <AgentTeamNodeRow key={node.id} team={team} node={node} goalLinks={goalLinks} />)}</div> : null}
    </section>
  );
}

export function SubagentSessionsPanel() {
  const runtime = useRuntimeStore(useShallow((state) => ({
    project: state.runtime.project,
    sessionId: state.runtime.sessionId,
    sessions: state.runtime.sessions,
    objective: state.runtime.objective,
    subagentWorkflows: state.runtime.subagentWorkflows,
    agentTeams: state.runtime.agentTeams,
  })));
  const order = useRuntimeStore((state) => state.subagentOrder);
  const runStructure = useRuntimeStore(useShallow((state) => state.subagentOrder.map((id) => {
    const run = state.subagentsById[id];
    return `${id}\0${run?.status ?? ''}\0${run?.parentToolCallId ?? ''}\0${run?.workflowId ?? ''}`;
  })));
  const runsById = useRuntimeStore.getState().subagentsById;
  const toolProjection = useRuntimeStore(useShallow((state) => ({ toolsById: state.toolsById, version: state.toolsVersion })));
  const toolsById = toolProjection.toolsById;
  const selectedAgent = useUiStore((state) => state.selectedAgent);
  const panelRef = useRef<HTMLElement>(null);
  const [previewHeight, setPreviewHeight] = useState(260);
  const resizePreview = (height: number) => {
    const panelHeight = panelRef.current?.clientHeight ?? 0;
    const maximum = Math.max(140, (panelHeight > 0 ? panelHeight : 900) - 180);
    setPreviewHeight(Math.min(maximum, Math.max(140, height)));
  };
  const goalProjection = useGoalMaxStore(useShallow((state) => ({
    hasGoal: Boolean(state.goal),
    criteria: state.goal?.criteria,
    childAssignments: state.goal?.childAssignments,
  })));
  const jump = useUiStore((state) => state.flightDeckJump);
  const clearFlightDeckJump = useUiStore((state) => state.clearFlightDeckJump);
  const showToast = useUiStore((state) => state.showToast);
  void runStructure;
  const agentTeams = runtime.agentTeams ?? [];
  const selectedRunId = selectedAgent?.kind === 'subagent' ? selectedAgent.runId : null;
  const selectedTeamNode = useMemo<AgentTeamSelection | null>(() => {
    if (selectedAgent?.kind !== 'team-node') return null;
    const team = agentTeams.find((candidate) => candidate.id === selectedAgent.teamId);
    const node = team?.nodes.find((candidate) => candidate.id === selectedAgent.nodeId);
    return team && node ? { team, node } : null;
  }, [agentTeams, selectedAgent]);
  const goalLinks = useMemo(() => {
    if (!goalProjection.hasGoal) return new Map<string, GoalMaxAgentLink>();
    const criteriaById = new Map((goalProjection.criteria ?? []).map((criterion) => [criterion.id, criterion.title]));
    return new Map((goalProjection.childAssignments ?? []).map((assignment) => [assignment.nodeId, {
      assignment,
      criterionTitles: assignment.criterionIds.flatMap((id) => criteriaById.get(id) ?? []),
    }]));
  }, [goalProjection.childAssignments, goalProjection.criteria, goalProjection.hasGoal]);
  useEffect(() => {
    if (!jump || jump.projectPath !== runtime.project?.path || jump.sessionId !== runtime.sessionId) return;
    let retained = true;
    if (jump.target.kind === 'agent') retained = order.includes(jump.target.runId);
    else if (jump.target.kind === 'team-node' || jump.target.kind === 'task') {
      const target = jump.target;
      const team = agentTeams.find((candidate) => candidate.id === target.teamId);
      const nodeId = team ? teamJumpNodeId(team, target) : null;
      retained = Boolean(team && nodeId && team.nodes.some((node) => node.id === nodeId));
    } else return;
    if (retained) return;
    showToast({ kind: 'info', title: 'Activity not retained', message: 'That agent activity is no longer available in the bounded recorder.' });
    clearFlightDeckJump(jump.nonce);
  }, [agentTeams, clearFlightDeckJump, jump, order, runtime.project?.path, runtime.sessionId, showToast]);
  const runs = order.flatMap((id) => runsById[id] ? [runsById[id]!] : []).reverse();
  const workflows = [...(runtime.subagentWorkflows ?? [])].reverse();
  const groups = new Map<string, SubagentRun[]>();
  for (const run of runs) groups.set(run.parentToolCallId, [...(groups.get(run.parentToolCallId) ?? []), run]);
  const workflowToolIds = new Set(workflows.map((workflow) => workflow.parentToolCallId));
  const delegations = [...groups.entries()].filter(([toolCallId]) => !workflowToolIds.has(toolCallId));
  const activeSession = runtime.sessions?.find((session) => session.id === runtime.sessionId);
  const workflowRunIds = new Set(workflows.flatMap((workflow) => workflow.nodes.flatMap((node) => node.runId ? [node.runId] : [])));
  const standaloneRuns = runs.filter((run) => !workflowRunIds.has(run.id));
  const workflowNodes = workflows.flatMap((workflow) => workflow.nodes);
  const totalAgents = standaloneRuns.length + workflowNodes.length;
  const activeAgents = standaloneRuns.filter((run) => activeStatuses.has(run.status)).length
    + workflowNodes.filter((node) => {
      const run = node.runId ? runsById[node.runId] : undefined;
      return run ? activeStatuses.has(run.status) : node.status === 'running' || node.status === 'pending';
    }).length;
  const teamAgents = agentTeams.reduce((total, team) => total + Math.max(0, team.nodes.length - 1), 0);
  const teamActive = agentTeams.reduce((total, team) => total + team.activeTurns, 0);
  const hasChildren = runs.length > 0 || workflows.length > 0 || agentTeams.length > 0;

  return (
    <section ref={panelRef} className={`subagent-sessions${hasChildren ? ' subagent-sessions--has-children' : ''}`} aria-label="Agent sessions">
      <div className="agent-tree-root">
        <span className="agent-tree-root-mark"><Bot size={15} aria-hidden="true" /></span>
        <span className="agent-tree-root-copy"><strong>Main agent</strong><small>{activeSession?.title ?? runtime.objective ?? 'Current Pi session'}</small></span>
        {hasChildren ? <span className="agent-tree-overview">{totalAgents + teamAgents} {totalAgents + teamAgents === 1 ? 'agent' : 'agents'}{activeAgents + teamActive ? ` · ${activeAgents + teamActive} active` : ''}</span> : null}
        {goalProjection.hasGoal ? <span className="goalmax-root-marker" title="Main agent is linked to the current goal" aria-label="Main agent linked to GoalMax"><Target size={11} /></span> : null}
      </div>
      {!hasChildren ? (
        <div className="inspector-empty subagent-empty"><MessagesSquare size={24} /><strong>No child sessions</strong><p>Managed child sessions and workflow graphs appear here when the parent launches them.</p></div>
      ) : (
        <div className="agent-tree-forest" aria-label={workflows.length ? 'Subagent workflows' : undefined}>
          {agentTeams.map((team) => <AgentTeamBranch key={team.id} team={team} goalLinks={goalLinks} />)}
          {workflows.map((workflow, index) => (
            <DelegationBranch
              key={workflow.id}
              runs={groups.get(workflow.parentToolCallId) ?? []}
              workflow={workflow}
              parentError={toolsById[workflow.parentToolCallId]?.status === 'error'}
              ordinal={workflows.length + delegations.length - index}
              goalLinks={goalLinks}
            />
          ))}
          {delegations.map(([toolCallId, group], index) => (
            <DelegationBranch
              key={toolCallId}
              runs={group}
              parentError={toolsById[toolCallId]?.status === 'error'}
              ordinal={delegations.length - index}
              goalLinks={goalLinks}
            />
          ))}
        </div>
      )}
      <HorizontalResizeHandle label="Resize sub-agent chat preview" value={previewHeight} minimum={140} maximum={720} direction={-1} onChange={resizePreview} onReset={() => resizePreview(260)} />
      <SubagentChatPreview
        runId={selectedRunId}
        teamSelection={selectedTeamNode}
        goalLink={selectedRunId ? goalLinks.get(selectedRunId) : selectedTeamNode ? goalLinks.get(selectedTeamNode.node.id) : undefined}
        height={previewHeight}
      />
    </section>
  );
}
