import { Brain, Check, CircleAlert, Copy, GitFork, PackageCheck, PackageOpen, Plug, RotateCcw } from 'lucide-react';
import { memo, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { AppTooltip } from '../../components/AppTooltip';
import { writeClipboardText } from '../../lib/clipboard';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { AssistantMarkdown } from './RichMessageContent';
import { ToolCard } from './ToolCard';

export { AssistantMarkdown } from './RichMessageContent';

function formatMessageTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Time unavailable';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

const MAX_FORK_POINT_TEXT = 2_000;
const forkTextMatches = (messageText: string, pointText: string) => messageText.slice(0, MAX_FORK_POINT_TEXT) === pointText;

export function forkEntryForMessage(messageId: string, messageOrder: readonly string[], messagesById: Record<string, { role: string; text: string }>, forkPoints: readonly { entryId: string; text: string }[] | undefined): string | null {
  if (!forkPoints?.length) return null;
  const messageIndex = messageOrder.indexOf(messageId);
  let userMessageIndex = -1;
  for (let index = messageIndex; index >= 0; index -= 1) {
    if (messagesById[messageOrder[index] ?? '']?.role === 'user') {
      userMessageIndex = index;
      break;
    }
  }
  const userMessage = messagesById[messageOrder[userMessageIndex] ?? ''];
  if (!userMessage) return null;

  // Both collections preserve active-branch order. Resolve from the end so a
  // bounded renderer history still aligns with Pi's bounded fork-point list.
  let userOffsetFromEnd = 0;
  for (let index = userMessageIndex; index < messageOrder.length; index += 1) {
    if (messagesById[messageOrder[index] ?? '']?.role === 'user') userOffsetFromEnd += 1;
  }
  const ordinalPoint = forkPoints.at(-userOffsetFromEnd);
  if (ordinalPoint && forkTextMatches(userMessage.text, ordinalPoint.text)) return ordinalPoint.entryId;

  // Defensive fallback for adapters that omit a subset of user messages. Pi's
  // IPC intentionally bounds fork-point text, so compare the same prefix.
  let occurrenceFromEnd = 0;
  for (let index = userMessageIndex; index < messageOrder.length; index += 1) {
    const candidate = messagesById[messageOrder[index] ?? ''];
    if (candidate?.role === 'user' && candidate.text === userMessage.text) occurrenceFromEnd += 1;
  }
  for (let pointIndex = forkPoints.length - 1; pointIndex >= 0; pointIndex -= 1) {
    const point = forkPoints[pointIndex];
    if (!point || !forkTextMatches(userMessage.text, point.text)) continue;
    occurrenceFromEnd -= 1;
    if (occurrenceFromEnd === 0) return point.entryId;
  }
  return null;
}

export const MessageRow = memo(function MessageRow({ messageId }: { messageId: string }) {
  const message = useRuntimeStore((state) => state.messagesById[messageId]);
  const runtime = useRuntimeStore((state) => state.runtime);
  const messageOrder = useRuntimeStore((state) => state.messageOrder);
  const messagesById = useRuntimeStore((state) => state.messagesById);
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [forking, setForking] = useState(false);
  if (!message || (message.role === 'assistant' && !message.text && !message.images?.length)) return null;
  const streamingThisMessage = runtime.streaming && messageOrder.at(-1) === messageId;
  const richContent = message.role === 'assistant' || message.role === 'system' || Boolean(message.images?.length);
  const modelName = runtime.model?.name ?? 'Assistant';
  const forkEntryId = forkEntryForMessage(messageId, messageOrder, messagesById, runtime.forkPoints);
  const canFork = Boolean(forkEntryId && runtime.sessionCapabilities?.fork && !runtime.streaming && !runtime.sessionOperation);
  const label = message.role === 'user' ? 'You' : message.role === 'assistant' ? modelName : message.role === 'system' ? 'System' : 'Tool result';
  const forkUnavailable = forking
    ? 'Creating the new session…'
    : runtime.streaming
      ? 'Available when Pi finishes the current response'
      : runtime.sessionOperation
        ? 'Available when the current session operation finishes'
        : !runtime.sessionCapabilities?.fork
          ? 'Session branching is unavailable'
          : !forkEntryId
            ? 'The branch point for this message is unavailable'
            : null;

  const copyMessage = async () => {
    if (!message.text || copying) return;
    setCopying(true);
    try {
      await writeClipboardText(message.text);
      setCopied(true);
      useUiStore.getState().showToast({ kind: 'success', title: 'Message copied', message: 'The message is on your clipboard.' });
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      useUiStore.getState().showToast({ kind: 'error', title: 'Copy failed', message: 'The system clipboard is unavailable.' });
    } finally {
      setCopying(false);
    }
  };

  const forkMessage = async (retry = false) => {
    if (!forkEntryId || !canFork || forking) return;
    if (!('piDesktop' in window) || typeof window.piDesktop.forkSession !== 'function') {
      useUiStore.getState().showToast({ kind: 'error', title: retry ? 'Could not try again' : 'Could not fork', message: 'The desktop session bridge is unavailable.' });
      return;
    }
    setForking(true);
    try {
      const result = await window.piDesktop.forkSession(forkEntryId);
      useRuntimeStore.getState().setRuntime(result.state);
      const promptText = result.selectedText ?? runtime.forkPoints?.find((point) => point.entryId === forkEntryId)?.text ?? '';
      if (retry) {
        if (!promptText) throw new Error('The prompt for this response is unavailable.');
        if (typeof window.piDesktop.prompt !== 'function') throw new Error('The desktop prompt bridge is unavailable.');
        await window.piDesktop.prompt({ text: promptText, behavior: 'prompt' });
        useUiStore.getState().showToast({ kind: 'success', title: 'Trying again', message: 'Pi is generating a fresh response.' });
      } else {
        useUiStore.getState().requestComposerDraft(message.text, true, 'This is a new session branched from this message. Edit the selected message, then send it to continue.');
        useUiStore.getState().showToast({ kind: 'success', title: 'Fork ready', message: 'A new session is ready from this point.' });
      }
    } catch (error) {
      useUiStore.getState().showToast({ kind: 'error', title: retry ? 'Could not try again' : 'Could not fork', message: error instanceof Error ? error.message : 'The conversation action failed.' });
    } finally {
      setForking(false);
    }
  };

  return (
    <div className={`chat-message-row chat-message-row--${message.role}`}>
      <article className={`chat-message chat-message--${message.role}${message.error ? ' chat-message--error' : ''}`}>
        {richContent && !(message.role === 'assistant' && streamingThisMessage && !message.images?.length)
          ? <AssistantMarkdown text={message.text} images={message.images} />
          : <p className="message-plain">{message.text}</p>}
      </article>
      <footer className="message-footer">
        <span className="message-footer-meta">{message.role === 'system' ? <><Plug size={11} aria-hidden="true" /><span className="icon-label">{label} <span aria-hidden="true">·</span> {formatMessageTimestamp(message.timestamp)}</span></> : <>{label} <span aria-hidden="true">·</span> {formatMessageTimestamp(message.timestamp)}</>}</span>
        <span className="message-footer-actions">
          <AppTooltip content={copied ? 'Copied' : message.text ? 'Copy message' : 'This message has no text to copy'} wrapTrigger><button className="message-action" type="button" aria-label={copied ? 'Message copied' : 'Copy message'} disabled={!message.text || copying} onClick={() => { void copyMessage(); }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button></AppTooltip>
          {message.role !== 'system' && <AppTooltip content={forkUnavailable ?? 'Fork from this message'} wrapTrigger><button className="message-action" type="button" aria-label="Fork from this message" disabled={!canFork || forking} onClick={() => { void forkMessage(); }}><GitFork size={14} /></button></AppTooltip>}
          {message.role === 'assistant' && <AppTooltip content={forkUnavailable ?? 'Try again from this prompt'} wrapTrigger><button className="message-action" type="button" aria-label="Try again" disabled={!canFork || forking} onClick={() => { void forkMessage(true); }}><RotateCcw size={14} /></button></AppTooltip>}
        </span>
      </footer>
    </div>
  );
});

const ReasoningRow = memo(function ReasoningRow({ messageId }: { messageId: string }) {
  const reasoning = useRuntimeStore((state) => state.reasoningByMessageId[messageId]);
  if (!reasoning) return null;
  return (
    <details className="reasoning-row">
      <summary><Brain size={13} /><span className="icon-label">Reasoning</span></summary>
      <pre>{reasoning}</pre>
    </details>
  );
});

const BOTTOM_THRESHOLD_PX = 4;
const MIN_SCROLLBAR_THUMB_HEIGHT = 24;

const sessionTimelineKey = (projectPath: string | null, sessionId: string | null) =>
  sessionId === null ? null : JSON.stringify([projectPath, sessionId]);

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

// ConversationTimeline owns pinned following below. Item-count following stays
// disabled so only the session-scoped list and explicit controller move output.
const preventImplicitTimelineFollow = () => false as const;

export function followsMessage(previousEntry: { kind: string } | undefined): boolean {
  return previousEntry?.kind === 'message';
}

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
  const timelineById = useRuntimeStore((state) => state.timelineById);
  const projectPath = useRuntimeStore((state) => state.runtime.project?.path ?? null);
  const sessionId = useRuntimeStore((state) => state.runtime.sessionId);
  const hasHistoricalTimeline = useRuntimeStore((state) => state.runtime.messages.length > 0 || Boolean(state.runtime.tools?.length));
  const timelineSessionKey = sessionTimelineKey(projectPath, sessionId);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const positionedSessionRef = useRef<string | null>(null);
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
    if (!timelineSessionKey) {
      positionedSessionRef.current = null;
      return;
    }
    if (visibleOrder.length === 0 || positionedSessionRef.current === timelineSessionKey) return;
    const virtuoso = virtuosoRef.current;
    if (!virtuoso) return;
    positionedSessionRef.current = timelineSessionKey;
    // A new live conversation is already visible and follows the pinned-scroll
    // path. Historical sessions instead open at their absolute final item.
    if (!hasHistoricalTimeline) return;
    pinnedToBottomRef.current = true;
    virtuoso.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' });
  }, [hasHistoricalTimeline, timelineSessionKey, visibleOrder.length]);

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
        key={timelineSessionKey ?? 'no-session'}
        ref={virtuosoRef}
        className="conversation-virtuoso"
        data={visibleOrder}
        computeItemKey={(_index, id) => id}
        itemContent={(index, id) => {
          const previousEntry = index > 0 ? timelineById[visibleOrder[index - 1] ?? ''] : undefined;
          return <div className="timeline-row" data-entry-kind={timelineById[id]?.kind} data-follows-message={followsMessage(previousEntry) || undefined}><TimelineRow id={id} /></div>;
        }}
        components={{ Footer: ConversationFooter }}
        scrollerRef={bindScroller}
        atBottomStateChange={handleAtBottomStateChange}
        atBottomThreshold={BOTTOM_THRESHOLD_PX}
        initialTopMostItemIndex={hasHistoricalTimeline && visibleOrder.length > 0 ? { index: 'LAST', align: 'end', behavior: 'auto' } : undefined}
        followOutput={preventImplicitTimelineFollow}
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
