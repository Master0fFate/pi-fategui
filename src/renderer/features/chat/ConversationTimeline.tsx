import { Brain, CircleAlert, PackageCheck, PackageOpen, Plug } from 'lucide-react';
import { memo, useCallback, useEffect, useRef } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { AssistantMarkdown } from './RichMessageContent';
import { ToolCard } from './ToolCard';

export { AssistantMarkdown } from './RichMessageContent';

export const MessageRow = memo(function MessageRow({ messageId }: { messageId: string }) {
  const message = useRuntimeStore((state) => state.messagesById[messageId]);
  const modelName = useRuntimeStore((state) => state.runtime.model?.name ?? 'Assistant');
  const streamingThisMessage = useRuntimeStore((state) => state.runtime.streaming && state.messageOrder.at(-1) === messageId);
  if (!message || (message.role === 'assistant' && !message.text && !message.images?.length)) return null;
  const richContent = message.role === 'assistant' || message.role === 'system' || Boolean(message.images?.length);
  return (
    <article className={`chat-message chat-message--${message.role}${message.error ? ' chat-message--error' : ''}`}>
      <span>{message.role === 'user' ? 'You' : message.role === 'assistant' ? modelName : message.role === 'system' ? <><Plug size={11} aria-hidden="true" /> System</> : 'Tool result'}</span>
      {richContent && !(message.role === 'assistant' && streamingThisMessage && !message.images?.length)
        ? <AssistantMarkdown text={message.text} images={message.images} />
        : <p className="message-plain">{message.text}</p>}
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

const ConversationFooter = () => <div className="conversation-composer-spacer" aria-hidden="true" />;

const BOTTOM_THRESHOLD_PX = 4;

const scrollerIsAtBottom = (scroller: HTMLElement) =>
  scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= BOTTOM_THRESHOLD_PX;

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
  const Icon = entry.phase === 'started' ? PackageOpen : entry.phase === 'failed' ? CircleAlert : PackageCheck;
  const text = entry.phase === 'started'
    ? 'Compacting conversation context…'
    : entry.phase === 'failed'
      ? entry.error?.message ?? 'Conversation context could not be compacted.'
      : entry.aborted ? 'Context compaction was cancelled.' : 'Conversation context compacted.';
  return <div className={`timeline-notice${entry.phase === 'failed' ? ' timeline-notice--error' : ''}`} role={entry.phase === 'failed' ? 'alert' : undefined}><Icon size={15} /><span>{text}{entry.error?.actionable && <small>{entry.error.actionable}</small>}</span></div>;
});

export function ConversationTimeline() {
  const order = useRuntimeStore((state) => state.timelineOrder);
  const visibleOrder = useRuntimeStore((state) => state.visibleTimelineOrder);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const pinnedToBottomRef = useRef(false);
  const followFrameRef = useRef<number | null>(null);

  const updatePinnedState = useCallback(() => {
    const scroller = scrollerRef.current;
    if (scroller) pinnedToBottomRef.current = scrollerIsAtBottom(scroller);
  }, []);

  const bindScroller = useCallback((target: HTMLElement | Window | null) => {
    const nextScroller = target instanceof HTMLElement ? target : null;
    if (scrollerRef.current === nextScroller) return;
    scrollerRef.current?.removeEventListener('scroll', updatePinnedState);
    scrollerRef.current = nextScroller;
    nextScroller?.addEventListener('scroll', updatePinnedState, { passive: true });
  }, [updatePinnedState]);

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    // A growing final row briefly reports false before the scheduled follow runs.
    // Native scroll events still let an intentional user scroll cancel that follow.
    if (atBottom || followFrameRef.current === null) pinnedToBottomRef.current = atBottom;
  }, []);

  useEffect(() => {
    const cancelScheduledFollow = () => {
      if (followFrameRef.current === null) return;
      window.cancelAnimationFrame(followFrameRef.current);
      followFrameRef.current = null;
    };

    const unsubscribe = useRuntimeStore.subscribe((next, previous) => {
      const sessionChanged = next.runtime.sessionId !== previous.runtime.sessionId
        || next.runtime.project?.path !== previous.runtime.project?.path;
      if (sessionChanged) {
        cancelScheduledFollow();
        return;
      }

      const outputChanged = next.visibleTimelineOrder !== previous.visibleTimelineOrder
        || next.timelineById !== previous.timelineById
        || next.messagesById !== previous.messagesById
        || next.reasoningByMessageId !== previous.reasoningByMessageId
        || next.toolsById !== previous.toolsById
        || (previous.runtime.streaming && !next.runtime.streaming);
      if (!outputChanged || !pinnedToBottomRef.current || followFrameRef.current !== null) return;

      followFrameRef.current = window.requestAnimationFrame(() => {
        const scroller = scrollerRef.current;
        const virtuoso = virtuosoRef.current;
        if (pinnedToBottomRef.current && virtuoso) {
          // Trap Virtuoso's next measured size increase and also correct a size
          // change that the browser has already committed in this frame.
          virtuoso.autoscrollToBottom();
          if (scroller && !scrollerIsAtBottom(scroller)) {
            virtuoso.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' });
          }
        }
        followFrameRef.current = null;
      });
    });

    return () => {
      unsubscribe();
      cancelScheduledFollow();
      scrollerRef.current?.removeEventListener('scroll', updatePinnedState);
    };
  }, [updatePinnedState]);

  return (
    <div className="conversation" aria-label="Conversation timeline" aria-live="polite" data-entry-count={order.length} data-visible-entry-count={visibleOrder.length}>
      <Virtuoso
        ref={virtuosoRef}
        className="conversation-virtuoso"
        data={visibleOrder}
        computeItemKey={(_index, id) => id}
        itemContent={(_index, id) => <div className="timeline-row"><TimelineRow id={id} /></div>}
        components={{ Footer: ConversationFooter }}
        scrollerRef={bindScroller}
        atBottomStateChange={handleAtBottomStateChange}
        atBottomThreshold={BOTTOM_THRESHOLD_PX}
        followOutput="auto"
        increaseViewportBy={{ top: 300, bottom: 500 }}
      />
    </div>
  );
}
