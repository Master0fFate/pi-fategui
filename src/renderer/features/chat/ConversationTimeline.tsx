import { Brain, CircleAlert, PackageCheck, PackageOpen, Plug } from 'lucide-react';
import { memo, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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

const BOTTOM_THRESHOLD_PX = 4;
const MIN_SCROLLBAR_THUMB_HEIGHT = 24;

interface ScrollbarMetrics {
  maxScroll: number;
  scrollTop: number;
  thumbHeight: number;
  thumbOffset: number;
}

const clamp = (value: number, minimum: number, maximum: number) => Math.min(Math.max(value, minimum), maximum);

export function getConversationScrollbarMetrics(
  scrollHeight: number,
  clientHeight: number,
  trackHeight: number,
  scrollTop: number,
): ScrollbarMetrics | null {
  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  if (maxScroll === 0 || trackHeight <= 0) return null;
  const thumbHeight = Math.min(trackHeight, Math.max(MIN_SCROLLBAR_THUMB_HEIGHT, trackHeight * clientHeight / scrollHeight));
  const maxThumbOffset = trackHeight - thumbHeight;
  const boundedScrollTop = clamp(scrollTop, 0, maxScroll);
  return {
    maxScroll,
    scrollTop: boundedScrollTop,
    thumbHeight,
    thumbOffset: maxThumbOffset * boundedScrollTop / maxScroll,
  };
}

const ConversationFooter = () => <div className="conversation-composer-spacer" aria-hidden="true" />;

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
  const scrollbarTrackRef = useRef<HTMLDivElement>(null);
  const scrollbarThumbRef = useRef<HTMLDivElement>(null);
  const draggedPointerIdRef = useRef<number | null>(null);
  const dragOffsetRef = useRef(0);
  const pinnedToBottomRef = useRef(false);
  const followFrameRef = useRef<number | null>(null);
  const scrollbarFrameRef = useRef<number | null>(null);
  const [scrollerElement, setScrollerElement] = useState<HTMLElement | null>(null);
  const [scrollbarMetrics, setScrollbarMetrics] = useState<ScrollbarMetrics | null>(null);

  const readScrollbarMetrics = useCallback(() => {
    const scroller = scrollerRef.current;
    const track = scrollbarTrackRef.current;
    if (!scroller || !track) return null;
    return getConversationScrollbarMetrics(scroller.scrollHeight, scroller.clientHeight, track.clientHeight, scroller.scrollTop);
  }, []);

  const refreshScrollbar = useCallback(() => {
    const next = readScrollbarMetrics();
    setScrollbarMetrics((current) => (
      current?.maxScroll === next?.maxScroll
      && current?.scrollTop === next?.scrollTop
      && current?.thumbHeight === next?.thumbHeight
      && current?.thumbOffset === next?.thumbOffset
        ? current
        : next
    ));
  }, [readScrollbarMetrics]);

  const scheduleScrollbarRefresh = useCallback(() => {
    if (scrollbarFrameRef.current !== null) return;
    scrollbarFrameRef.current = window.requestAnimationFrame(() => {
      refreshScrollbar();
      scrollbarFrameRef.current = null;
    });
  }, [refreshScrollbar]);

  const updatePinnedState = useCallback(() => {
    const scroller = scrollerRef.current;
    if (scroller) pinnedToBottomRef.current = scrollerIsAtBottom(scroller);
  }, []);

  const bindScroller = useCallback((target: HTMLElement | Window | null) => {
    const nextScroller = target instanceof HTMLElement ? target : null;
    if (scrollerRef.current === nextScroller) return;
    scrollerRef.current?.removeEventListener('scroll', updatePinnedState);
    scrollerRef.current = nextScroller;
    setScrollerElement(nextScroller);
    nextScroller?.addEventListener('scroll', updatePinnedState, { passive: true });
  }, [updatePinnedState]);

  useLayoutEffect(() => {
    if (!scrollerElement) return;
    const observer = new ResizeObserver(refreshScrollbar);
    scrollerElement.addEventListener('scroll', refreshScrollbar, { passive: true });
    observer.observe(scrollerElement);
    if (scrollbarTrackRef.current) observer.observe(scrollbarTrackRef.current);
    refreshScrollbar();
    return () => {
      scrollerElement.removeEventListener('scroll', refreshScrollbar);
      observer.disconnect();
    };
  }, [refreshScrollbar, scrollerElement]);

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
        scheduleScrollbarRefresh();
        return;
      }

      const outputChanged = next.visibleTimelineOrder !== previous.visibleTimelineOrder
        || next.timelineById !== previous.timelineById
        || next.messagesById !== previous.messagesById
        || next.reasoningByMessageId !== previous.reasoningByMessageId
        || next.toolsById !== previous.toolsById
        || (previous.runtime.streaming && !next.runtime.streaming);
      if (!outputChanged) return;
      if (!pinnedToBottomRef.current || followFrameRef.current !== null) {
        scheduleScrollbarRefresh();
        return;
      }

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
          refreshScrollbar();
        }
        followFrameRef.current = null;
      });
    });

    return () => {
      unsubscribe();
      cancelScheduledFollow();
      if (scrollbarFrameRef.current !== null) window.cancelAnimationFrame(scrollbarFrameRef.current);
      scrollerRef.current?.removeEventListener('scroll', updatePinnedState);
    };
  }, [refreshScrollbar, scheduleScrollbarRefresh, updatePinnedState]);

  const scrollToThumbOffset = useCallback((offset: number) => {
    const scroller = scrollerRef.current;
    const track = scrollbarTrackRef.current;
    const metrics = readScrollbarMetrics();
    if (!scroller || !track || !metrics) return;
    const maxThumbOffset = track.clientHeight - metrics.thumbHeight;
    const boundedOffset = clamp(offset, 0, maxThumbOffset);
    scroller.scrollTop = maxThumbOffset > 0 ? boundedOffset / maxThumbOffset * metrics.maxScroll : 0;
    refreshScrollbar();
  }, [readScrollbarMetrics, refreshScrollbar]);

  const handleScrollbarPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const metrics = readScrollbarMetrics();
    const track = scrollbarTrackRef.current;
    if (!metrics || !track) return;
    event.preventDefault();
    const thumb = scrollbarThumbRef.current;
    const thumbRect = thumb?.getBoundingClientRect();
    dragOffsetRef.current = thumbRect && event.clientY >= thumbRect.top && event.clientY <= thumbRect.bottom
      ? event.clientY - thumbRect.top
      : metrics.thumbHeight / 2;
    draggedPointerIdRef.current = event.pointerId;
    track.setPointerCapture(event.pointerId);
    scrollToThumbOffset(event.clientY - track.getBoundingClientRect().top - dragOffsetRef.current);
  };

  const handleScrollbarPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (draggedPointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    const track = scrollbarTrackRef.current;
    if (track) scrollToThumbOffset(event.clientY - track.getBoundingClientRect().top - dragOffsetRef.current);
  };

  const finishScrollbarDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (draggedPointerIdRef.current !== event.pointerId) return;
    draggedPointerIdRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleScrollbarKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const lineStep = Math.max(40, Math.round(scroller.clientHeight / 10));
    const pageStep = Math.max(lineStep, Math.round(scroller.clientHeight * 0.9));
    let nextScrollTop: number | null = null;
    if (event.key === 'Home') nextScrollTop = 0;
    else if (event.key === 'End') nextScrollTop = scroller.scrollHeight;
    else if (event.key === 'PageUp') nextScrollTop = scroller.scrollTop - pageStep;
    else if (event.key === 'PageDown') nextScrollTop = scroller.scrollTop + pageStep;
    else if (event.key === 'ArrowUp') nextScrollTop = scroller.scrollTop - lineStep;
    else if (event.key === 'ArrowDown') nextScrollTop = scroller.scrollTop + lineStep;
    if (nextScrollTop === null) return;
    event.preventDefault();
    scroller.scrollTop = nextScrollTop;
    refreshScrollbar();
  };

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
      <div
        ref={scrollbarTrackRef}
        className="conversation-scrollbar"
        role="scrollbar"
        aria-label="Conversation scroll position"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={Math.round(scrollbarMetrics?.maxScroll ?? 0)}
        aria-valuenow={Math.round(scrollbarMetrics?.scrollTop ?? 0)}
        tabIndex={scrollbarMetrics ? 0 : -1}
        data-visible={Boolean(scrollbarMetrics)}
        onPointerDown={handleScrollbarPointerDown}
        onPointerMove={handleScrollbarPointerMove}
        onPointerUp={finishScrollbarDrag}
        onPointerCancel={finishScrollbarDrag}
        onKeyDown={handleScrollbarKeyDown}
      >
        <div
          ref={scrollbarThumbRef}
          className="conversation-scrollbar-thumb"
          style={scrollbarMetrics ? { height: `${scrollbarMetrics.thumbHeight}px`, transform: `translateY(${scrollbarMetrics.thumbOffset}px)` } : undefined}
        />
      </div>
    </div>
  );
}
