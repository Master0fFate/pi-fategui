import { ArrowUpRight, Check, ChevronDown, ChevronRight, CircleAlert, CircleStop, LoaderCircle } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import type { RuntimeTool, SubagentRun } from '../../../shared/contracts/ipc';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { useSkinComponents } from '../../skins/SkinProvider';
import { MessageImages } from './RichMessageContent';
import { previewHotPathText, shouldAutoShowRunningOutput } from './hotPathBudgets';

function elapsed(start: number, end: number): string {
  const milliseconds = Math.max(0, end - start);
  return milliseconds < 1_000 ? `${milliseconds} ms` : `${(milliseconds / 1_000).toFixed(1)} s`;
}

const activeChildStatuses = new Set<SubagentRun['status']>(['blocked', 'queued', 'running']);
const failedChildStatuses = new Set<SubagentRun['status']>(['error', 'timed-out', 'budget-exceeded', 'interrupted']);

type PresentedToolStatus = RuntimeTool['status'] | 'stopped';

export function presentedSubagentToolStatus(toolStatus: RuntimeTool['status'], childStatuses: readonly SubagentRun['status'][]): PresentedToolStatus {
  if (toolStatus === 'error') return 'error';
  if (toolStatus === 'running' || childStatuses.some((status) => activeChildStatuses.has(status))) return 'running';
  if (childStatuses.some((status) => failedChildStatuses.has(status))) return 'error';
  if (childStatuses.some((status) => status === 'cancelled')) return 'stopped';
  return 'succeeded';
}

export const ToolCard = memo(function ToolCard({ toolCallId, compact = false, waitPollCount = 1 }: { toolCallId: string; compact?: boolean; waitPollCount?: number | undefined }) {
  const { Symbol } = useSkinComponents();
  const tool = useRuntimeStore((state) => state.toolsById[toolCallId]);
  const childStatusKey = useRuntimeStore((state) => state.toolsById[toolCallId]?.subagentRunIds
    ?.flatMap((runId) => state.subagentsById[runId]?.status ?? [])
    .join('|') ?? '');
  const jump = useUiStore((state) => state.flightDeckJump);
  const clearFlightDeckJump = useUiStore((state) => state.clearFlightDeckJump);
  const projectPath = useRuntimeStore((state) => state.runtime.project?.path);
  const sessionId = useRuntimeStore((state) => state.runtime.sessionId);
  const focused = Boolean(jump && jump.projectPath === projectPath && jump.sessionId === sessionId && jump.target.kind === 'tool' && jump.target.toolCallId === toolCallId);
  const cardRef = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const card = cardRef.current;
    if (!focused || !jump || !card) return;
    if (typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'nearest' });
    card.focus({ preventScroll: true });
    if (document.activeElement === card) clearFlightDeckJump(jump.nonce);
  }, [clearFlightDeckJump, focused, jump]);
  if (!tool) return null;
  const isSubagentTool = /^subagent(?:_|$)/u.test(tool.name);
  const presentedStatus = isSubagentTool
    ? presentedSubagentToolStatus(tool.status, childStatusKey ? childStatusKey.split('|') as SubagentRun['status'][] : [])
    : tool.status;
  const Icon = presentedStatus === 'running' ? LoaderCircle : presentedStatus === 'error' ? CircleAlert : presentedStatus === 'stopped' ? CircleStop : Check;
  const statusLabel = presentedStatus === 'running' ? 'Running' : presentedStatus === 'error' ? 'Error' : presentedStatus === 'stopped' ? 'Stopped' : 'Completed';
  const presentedStatusLabel = waitPollCount > 1 ? `${waitPollCount} wait polls · ${statusLabel}` : statusLabel;
  const summary = tool.input.replace(/\s+/g, ' ').trim() || 'No input';
  const ariaStatus = isSubagentTool && presentedStatus === 'succeeded' ? 'completed' : presentedStatus;
  const childIds = [...new Set(tool.subagentRunIds ?? [])];
  const hasChildLink = childIds.length > 0 || tool.name === 'agent_workflow';

  return (
    <article ref={cardRef} tabIndex={-1} data-flight-focus={focused || undefined} className={`tool-card tool-card--${presentedStatus}${tool.images?.length ? ' tool-card--with-images' : ''}${compact ? ' tool-card--compact' : ''}`} aria-label={`${tool.name} tool ${ariaStatus}`}>
      <button className="tool-card-header" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <Symbol text={presentedStatus === 'running' ? '[run]' : presentedStatus === 'error' ? '[err]' : presentedStatus === 'stopped' ? '[stop]' : '[ok]'}><Icon size={13} className={`tool-status-icon${presentedStatus === 'running' ? ' tool-spinner' : ''}`} aria-hidden="true" /></Symbol>
        <span className="tool-heading icon-label"><strong>{tool.name}</strong><small>{summary}</small></span>
        <span className="tool-meta icon-label">{isSubagentTool ? presentedStatusLabel : tool.status === 'running' ? 'Running' : elapsed(tool.startedAt, tool.endedAt ?? tool.updatedAt)}</span>
        <Symbol text={expanded ? '-' : '+'}>{expanded ? <ChevronDown className="tool-disclosure-icon" size={13} /> : <ChevronRight className="tool-disclosure-icon" size={13} />}</Symbol>
      </button>
      {hasChildLink ? (
        <button
          className="tool-subagent-link"
          type="button"
          aria-label={childIds.length === 1 ? 'View subagent session' : childIds.length > 1 ? `View ${childIds.length} subagent sessions` : 'View agent sessions'}
          onClick={() => {
            const ui = useUiStore.getState();
            const referenceId = childIds.length === 1 ? childIds[0] : undefined;
            if (!referenceId || referenceId.length > 100 || referenceId.trim() !== referenceId || /[\u0000-\u001f\u007f]/u.test(referenceId)) {
              ui.openSubagentList();
              return;
            }
            const runtime = useRuntimeStore.getState();
            const matchingTeams = Object.values(runtime.agentTeamsById)
              .filter((team) => team.nodes.some((node) => node.id === referenceId));
            const historical = Object.hasOwn(runtime.subagentsById, referenceId)
              && runtime.subagentsById[referenceId]?.id === referenceId;
            if (matchingTeams.length === 1 && !historical) {
              ui.openAgentTeamNode(matchingTeams[0]!.id, referenceId);
            } else if (historical && matchingTeams.length === 0) {
              ui.openSubagent(referenceId);
            } else {
              ui.openSubagentList();
            }
          }}
        >
          <ArrowUpRight size={12} aria-hidden="true" />
          <span className="icon-label">{childIds.length === 1 ? 'View child session' : childIds.length > 1 ? `View ${childIds.length} child sessions` : 'View agent sessions'}</span>
        </button>
      ) : null}
      {tool.images?.length ? <div className="tool-images"><MessageImages images={tool.images} /></div> : null}
      {(expanded || (tool.status === 'running' && shouldAutoShowRunningOutput(tool.output))) && (
        <div className="tool-details">
          {expanded && <section><span>Input</span><pre>{tool.input || '—'}</pre></section>}
          <section><span>{tool.status === 'error' ? 'Error' : 'Output'}{(tool.outputTruncated || (!expanded && previewHotPathText(tool.output).clipped)) && <em>bounded preview</em>}</span><pre>{expanded ? (tool.output || (tool.status === 'running' ? 'Waiting for output…' : 'No output')) : previewHotPathText(tool.output || (tool.status === 'running' ? 'Waiting for output…' : 'No output')).text}</pre></section>
        </div>
      )}
    </article>
  );
});
