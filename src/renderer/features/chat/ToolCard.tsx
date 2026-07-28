import { Check, ChevronDown, ChevronRight, CircleAlert, LoaderCircle } from 'lucide-react';
import { memo, useState } from 'react';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { MessageImages } from './RichMessageContent';

function elapsed(start: number, end: number): string {
  const milliseconds = Math.max(0, end - start);
  return milliseconds < 1_000 ? `${milliseconds} ms` : `${(milliseconds / 1_000).toFixed(1)} s`;
}

export const ToolCard = memo(function ToolCard({ toolCallId, compact = false }: { toolCallId: string; compact?: boolean }) {
  const tool = useRuntimeStore((state) => state.toolsById[toolCallId]);
  const [expanded, setExpanded] = useState(false);
  if (!tool) return null;
  const Icon = tool.status === 'running' ? LoaderCircle : tool.status === 'error' ? CircleAlert : Check;
  const summary = tool.input.replace(/\s+/g, ' ').trim() || 'No input';

  return (
    <article className={`tool-card tool-card--${tool.status}${tool.images?.length ? ' tool-card--with-images' : ''}${compact ? ' tool-card--compact' : ''}`} aria-label={`${tool.name} tool ${tool.status}`}>
      <button className="tool-card-header" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <Icon size={13} className={`tool-status-icon${tool.status === 'running' ? ' tool-spinner' : ''}`} aria-hidden="true" />
        <span className="tool-heading icon-label"><strong>{tool.name}</strong><small>{summary}</small></span>
        <span className="tool-meta icon-label">{tool.status === 'running' ? 'Running' : elapsed(tool.startedAt, tool.endedAt ?? tool.updatedAt)}</span>
        {expanded ? <ChevronDown className="tool-disclosure-icon" size={13} /> : <ChevronRight className="tool-disclosure-icon" size={13} />}
      </button>
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
