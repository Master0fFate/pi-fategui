import { Brain, CircleAlert, PackageCheck, PackageOpen } from 'lucide-react';
import { memo } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { ToolCard } from './ToolCard';

const MessageRow = memo(function MessageRow({ messageId }: { messageId: string }) {
  const message = useRuntimeStore((state) => state.messagesById[messageId]);
  const streaming = useRuntimeStore((state) => state.runtime.streaming);
  if (!message) return null;
  return (
    <article className={`chat-message chat-message--${message.role}${message.error ? ' chat-message--error' : ''}`}>
      <span>{message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Pi' : 'Tool result'}</span>
      <pre>{message.text || (streaming && message.role === 'assistant' ? '…' : '')}</pre>
    </article>
  );
});

const ReasoningRow = memo(function ReasoningRow({ messageId }: { messageId: string }) {
  const reasoning = useRuntimeStore((state) => state.reasoningByMessageId[messageId]);
  if (!reasoning) return null;
  return (
    <details className="reasoning-row">
      <summary><Brain size={13} /> Reasoning</summary>
      <pre>{reasoning}</pre>
    </details>
  );
});

const TimelineRow = memo(function TimelineRow({ id }: { id: string }) {
  const entry = useRuntimeStore((state) => state.timelineById[id]);
  if (!entry) return null;
  if (entry.kind === 'message') return <MessageRow messageId={entry.messageId} />;
  if (entry.kind === 'reasoning') return <ReasoningRow messageId={entry.messageId} />;
  if (entry.kind === 'tool') return <ToolCard toolCallId={entry.toolCallId} />;
  if (entry.kind === 'error') {
    return (
      <div className="timeline-notice timeline-notice--error" role="alert">
        <CircleAlert size={15} /><span><strong>{entry.error.message}</strong>{entry.error.actionable && <small>{entry.error.actionable}</small>}</span>
      </div>
    );
  }
  const Icon = entry.phase === 'started' ? PackageOpen : PackageCheck;
  const text = entry.phase === 'started' ? 'Compacting conversation context…' : entry.aborted ? 'Context compaction was cancelled.' : 'Conversation context compacted.';
  return <div className="timeline-notice"><Icon size={15} /><span>{text}</span></div>;
});

export function ConversationTimeline() {
  const order = useRuntimeStore((state) => state.timelineOrder);
  return (
    <div className="conversation" aria-label="Conversation timeline" aria-live="polite" data-entry-count={order.length}>
      <Virtuoso
        className="conversation-virtuoso"
        data={order}
        computeItemKey={(_index, id) => id}
        itemContent={(_index, id) => <div className="timeline-row"><TimelineRow id={id} /></div>}
        followOutput="auto"
        increaseViewportBy={{ top: 300, bottom: 500 }}
      />
    </div>
  );
}
