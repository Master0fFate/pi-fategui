import { ArrowUpRight, Check, ChevronDown, ChevronRight, CircleAlert, CircleStop, LoaderCircle } from 'lucide-react';
import { memo, useState } from 'react';
import type { RuntimeTool, SubagentRun } from '../../../shared/contracts/ipc';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { MessageImages } from './RichMessageContent';

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
  const tool = useRuntimeStore((state) => state.toolsById[toolCallId]);
  const childStatusKey = useRuntimeStore((state) => state.toolsById[toolCallId]?.subagentRunIds
    ?.flatMap((runId) => state.subagentsById[runId]?.status ?? [])
    .join('|') ?? '');
  const [expanded, setExpanded] = useState(false);
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

  return (
    <article className={`tool-card tool-card--${presentedStatus}${tool.images?.length ? ' tool-card--with-images' : ''}${compact ? ' tool-card--compact' : ''}`} aria-label={`${tool.name} tool ${ariaStatus}`}>
      <button className="tool-card-header" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <Icon size={13} className={`tool-status-icon${presentedStatus === 'running' ? ' tool-spinner' : ''}`} aria-hidden="true" />
        <span className="tool-heading icon-label"><strong>{tool.name}</strong><small>{summary}</small></span>
        <span className="tool-meta icon-label">{isSubagentTool ? presentedStatusLabel : tool.status === 'running' ? 'Running' : elapsed(tool.startedAt, tool.endedAt ?? tool.updatedAt)}</span>
        {expanded ? <ChevronDown className="tool-disclosure-icon" size={13} /> : <ChevronRight className="tool-disclosure-icon" size={13} />}
      </button>
      {tool.subagentRunIds?.length ? (
        <button
          className="tool-subagent-link"
          type="button"
          aria-label={tool.subagentRunIds.length === 1 ? 'View subagent session' : `View ${tool.subagentRunIds.length} subagent sessions`}
          onClick={() => {
            const ui = useUiStore.getState();
            if (tool.subagentRunIds?.length === 1) ui.openSubagent(tool.subagentRunIds[0]!);
            else ui.openSubagentList();
          }}
        >
          <ArrowUpRight size={12} aria-hidden="true" />
          <span className="icon-label">{tool.subagentRunIds.length === 1 ? 'View child session' : `View ${tool.subagentRunIds.length} child sessions`}</span>
        </button>
      ) : null}
      {tool.images?.length ? <div className="tool-images"><MessageImages images={tool.images} /></div> : null}
      {(expanded || (tool.status === 'running' && tool.output)) && (
        <div className="tool-details">
          {expanded && <section><span>Input</span><pre>{tool.input || '—'}</pre></section>}
          <section><span>{tool.status === 'error' ? 'Error' : 'Output'}{tool.outputTruncated && <em>bounded preview</em>}</span><pre>{tool.output || (tool.status === 'running' ? 'Waiting for output…' : 'No output')}</pre></section>
        </div>
      )}
    </article>
  );
});
