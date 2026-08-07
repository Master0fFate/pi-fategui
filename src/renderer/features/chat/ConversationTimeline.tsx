import { Brain, Check, CircleAlert, Copy, GitFork, PackageCheck, PackageOpen, Plug, RotateCcw } from 'lucide-react';
import { memo, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useShallow } from 'zustand/react/shallow';
import { AppTooltip } from '../../components/AppTooltip';
import { writeClipboardText } from '../../lib/clipboard';
import { type TimelineEntity, type ToolExecution, useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { MentionText } from './AgentMention';
import { AssistantMarkdown, ConversationImageViewerProvider } from './RichMessageContent';
import { ToolCard } from './ToolCard';

export { AssistantMarkdown } from './RichMessageContent';

const messageTimestampFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function formatMessageTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Time unavailable';
  return messageTimestampFormatter.format(timestamp);
}

const MAX_FORK_POINT_TEXT = 2_000;
const EMPTY_MESSAGE_ORDER: readonly string[] = [];
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
  const { message, streaming, latestMessageId, modelName, forkPoints, forkMessageOrder, forkCapable, sessionOperation } = useRuntimeStore(useShallow((state) => ({
    message: state.messagesById[messageId],
    streaming: state.runtime.streaming,
    latestMessageId: state.messageOrder.at(-1),
    modelName: state.runtime.model?.name ?? 'Assistant',
    forkPoints: state.runtime.forkPoints,
    forkMessageOrder: state.runtime.forkPoints?.length ? state.messageOrder : EMPTY_MESSAGE_ORDER,
    forkCapable: Boolean(state.runtime.sessionCapabilities?.fork),
    sessionOperation: Boolean(state.runtime.sessionOperation),
  })));
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [forking, setForking] = useState(false);
  if (!message || (message.role === 'assistant' && !message.text && !message.images?.length)) return null;
  const streamingThisMessage = streaming && latestMessageId === messageId;
  const richContent = message.role === 'assistant' || message.role === 'system' || Boolean(message.images?.length);
  const forkEntryId = forkEntryForMessage(messageId, forkMessageOrder, useRuntimeStore.getState().messagesById, forkPoints);
  const canFork = Boolean(forkEntryId && forkCapable && !streaming && !sessionOperation);
  const label = message.role === 'user' ? 'You' : message.role === 'assistant' ? modelName : message.role === 'system' ? 'System' : 'Tool result';
  const forkUnavailable = forking
    ? 'Creating the new session…'
    : streaming
      ? 'Available when Pi finishes the current response'
      : sessionOperation
        ? 'Available when the current session operation finishes'
        : !forkCapable
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
      const promptText = result.selectedText ?? forkPoints?.find((point) => point.entryId === forkEntryId)?.text ?? '';
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
          : <p className="message-plain"><MentionText text={message.text} /></p>}
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

interface CoalescedTimeline {
  order: string[];
  waitPollCountById: Record<string, number>;
}

function subagentWaitTarget(tool: ToolExecution | undefined): string | null {
  if (!tool || tool.name !== 'subagent_manage' || tool.status === 'error') return null;
  try {
    const input = JSON.parse(tool.input) as Record<string, unknown>;
    if (input.action !== 'wait') return null;
    const targets = Array.isArray(input.runIds) ? input.runIds : Array.isArray(input.runs) ? input.runs : null;
    if (!targets?.length || targets.some((target) => typeof target !== 'string')) return null;
    return JSON.stringify([...targets].sort());
  } catch {
    return null;
  }
}

export function coalesceSubagentWaitPolls(
  order: readonly string[],
  timelineById: Record<string, TimelineEntity>,
  toolsById: Record<string, ToolExecution>,
): CoalescedTimeline {
  const coalesced: string[] = [];
  const waitPollCountById: Record<string, number> = {};
  let activeTarget: string | null = null;
  let activeCount = 0;

  for (const id of order) {
    const entry = timelineById[id];
    const target = entry?.kind === 'tool' ? subagentWaitTarget(toolsById[entry.toolCallId]) : null;
    if (target !== null && target === activeTarget) {
      const previousId = coalesced.at(-1)!;
      coalesced[coalesced.length - 1] = id;
      delete waitPollCountById[previousId];
      activeCount += 1;
      waitPollCountById[id] = activeCount;
      continue;
    }

    coalesced.push(id);
    activeTarget = target;
    activeCount = target === null ? 0 : 1;
  }

  return { order: coalesced, waitPollCountById };
}

const scrollerIsAtBottom = (scroller: HTMLElement) =>
  scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= BOTTOM_THRESHOLD_PX;

const TimelineRow = memo(function TimelineRow({ id, waitPollCount }: { id: string; waitPollCount?: number | undefined }) {
  const entry = useRuntimeStore((state) => state.timelineById[id]);
  if (!entry) return null;
  if (entry.kind === 'message') return <MessageRow messageId={entry.messageId} />;
  if (entry.kind === 'reasoning') return <ReasoningRow messageId={entry.messageId} />;
  if (entry.kind === 'tool') return <ToolCard toolCallId={entry.toolCallId} waitPollCount={waitPollCount} />;
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
  const timelineVersion = useRuntimeStore((state) => state.timelineVersion);
  const waitPollVersion = useRuntimeStore((state) => state.waitPollVersion);
  const timelineById = useRuntimeStore.getState().timelineById;
  const { order: displayOrder, waitPollCountById } = useMemo(() => {
    // Tool output updates do not change wait-poll grouping. Recompute only when
    // timeline structure or a wait tool's lifecycle changes.
    const { timelineById, toolsById } = useRuntimeStore.getState();
    return coalesceSubagentWaitPolls(visibleOrder, timelineById, toolsById);
  }, [timelineVersion, visibleOrder, waitPollVersion]);
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
  const flightDeckJump = useUiStore((state) => state.flightDeckJump);
  const clearFlightDeckJump = useUiStore((state) => state.clearFlightDeckJump);
  const showToast = useUiStore((state) => state.showToast);
  const userScrollIntentRef = useRef(false);
  const userScrollIntentFrameRef = useRef<number | null>(null);
  const followFrameRef = useRef<number | null>(null);
  const scrollbarFrameRef = useRef<number | null>(null);
  const [scrollerElement, setScrollerElement] = useState<HTMLElement | null>(null);
  const [scrollbarMetrics, setScrollbarMetrics] = useState<ScrollbarMetrics | null>(null);

  useLayoutEffect(() => {
    if (!flightDeckJump || flightDeckJump.projectPath !== projectPath || flightDeckJump.sessionId !== sessionId) return;
    const targetId = flightDeckJump.target.kind === 'message'
      ? flightDeckJump.target.timelineId ?? `message:${flightDeckJump.target.messageId}`
      : flightDeckJump.target.kind === 'error' ? flightDeckJump.target.timelineId : null;
    if (!targetId) return;
    const index = displayOrder.indexOf(targetId);
    if (index >= 0) {
      virtuosoRef.current?.scrollToIndex({ index, align: 'center', behavior: 'auto' });
    } else {
      showToast({ kind: 'info', title: 'Activity not retained', message: 'That conversation activity is no longer available in the bounded timeline.' });
    }
    clearFlightDeckJump(flightDeckJump.nonce);
  }, [clearFlightDeckJump, displayOrder, flightDeckJump, projectPath, sessionId, showToast]);

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

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = true;
    if (userScrollIntentFrameRef.current !== null) window.cancelAnimationFrame(userScrollIntentFrameRef.current);
    userScrollIntentFrameRef.current = window.requestAnimationFrame(() => {
      userScrollIntentRef.current = false;
      userScrollIntentFrameRef.current = null;
    });
  }, []);

  const updatePinnedState = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const atBottom = scrollerIsAtBottom(scroller);
    // Virtuoso and browser scroll anchoring both emit native scroll events while
    // a growing row is measured. Only explicit input may unpin the conversation.
    if (atBottom || userScrollIntentRef.current) pinnedToBottomRef.current = atBottom;
  }, []);

  const bindScroller = useCallback((target: HTMLElement | Window | null) => {
    const nextScroller = target instanceof HTMLElement ? target : null;
    if (scrollerRef.current === nextScroller) return;
    scrollerRef.current?.removeEventListener('scroll', updatePinnedState);
    scrollerRef.current?.removeEventListener('wheel', markUserScrollIntent);
    scrollerRef.current?.removeEventListener('touchmove', markUserScrollIntent);
    scrollerRef.current = nextScroller;
    setScrollerElement(nextScroller);
    nextScroller?.addEventListener('scroll', updatePinnedState, { passive: true });
    nextScroller?.addEventListener('wheel', markUserScrollIntent, { passive: true });
    nextScroller?.addEventListener('touchmove', markUserScrollIntent, { passive: true });
  }, [markUserScrollIntent, updatePinnedState]);

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
    // Keep following unless wheel/touch input or an explicit scrollbar action
    // shows that the user intentionally moved away from the bottom.
    if (atBottom || userScrollIntentRef.current) pinnedToBottomRef.current = atBottom;
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
        || next.timelineVersion !== previous.timelineVersion
        || next.messagesVersion !== previous.messagesVersion
        || next.reasoningVersion !== previous.reasoningVersion
        || next.toolsVersion !== previous.toolsVersion
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
      if (userScrollIntentFrameRef.current !== null) window.cancelAnimationFrame(userScrollIntentFrameRef.current);
      scrollerRef.current?.removeEventListener('scroll', updatePinnedState);
      scrollerRef.current?.removeEventListener('wheel', markUserScrollIntent);
      scrollerRef.current?.removeEventListener('touchmove', markUserScrollIntent);
    };
  }, [markUserScrollIntent, refreshScrollbar, scheduleScrollbarRefresh, updatePinnedState]);

  const scrollToThumbOffset = useCallback((offset: number) => {
    const scroller = scrollerRef.current;
    const track = scrollbarTrackRef.current;
    const metrics = readScrollbarMetrics();
    if (!scroller || !track || !metrics) return;
    const maxThumbOffset = track.clientHeight - metrics.thumbHeight;
    const boundedOffset = clamp(offset, 0, maxThumbOffset);
    scroller.scrollTop = maxThumbOffset > 0 ? boundedOffset / maxThumbOffset * metrics.maxScroll : 0;
    pinnedToBottomRef.current = scrollerIsAtBottom(scroller);
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
    pinnedToBottomRef.current = scrollerIsAtBottom(scroller);
    refreshScrollbar();
  };

  return (
    <ConversationImageViewerProvider>
      <div className="conversation" aria-label="Conversation timeline" aria-live="polite" data-entry-count={order.length} data-visible-entry-count={displayOrder.length}>
      <Virtuoso
        key={timelineSessionKey ?? 'no-session'}
        ref={virtuosoRef}
        className="conversation-virtuoso"
        data={displayOrder}
        computeItemKey={(_index, id) => id}
        itemContent={(index, id) => {
          const previousEntry = index > 0 ? timelineById[displayOrder[index - 1] ?? ''] : undefined;
          return <div className="timeline-row" data-entry-kind={timelineById[id]?.kind} data-follows-message={followsMessage(previousEntry) || undefined}><TimelineRow id={id} waitPollCount={waitPollCountById[id]} /></div>;
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
    </ConversationImageViewerProvider>
  );
}
