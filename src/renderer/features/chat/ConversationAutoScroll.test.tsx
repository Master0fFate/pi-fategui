import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiEvent, RuntimeState } from '../../../shared/contracts/ipc';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { ConversationTimeline, getConversationScrollbarMetrics } from './ConversationTimeline';

const virtuosoMock = vi.hoisted(() => ({
  autoscrollToBottom: vi.fn(),
  scrollToIndex: vi.fn(),
  atBottomStateChange: null as ((atBottom: boolean) => void) | null,
  totalListHeightChanged: null as ((height: number) => void) | null,
}));

vi.mock('react-virtuoso', async () => {
  const React = await import('react');
  type MockHandle = { autoscrollToBottom: () => void; scrollToIndex: (location: unknown) => void };
  type MockFollowOutput = boolean | 'auto' | 'smooth' | ((isAtBottom: boolean) => boolean | 'auto' | 'smooth');
  type MockProps = {
    atBottomStateChange?: (atBottom: boolean) => void;
    data?: readonly unknown[];
    followOutput?: MockFollowOutput;
    initialTopMostItemIndex?: { index: number | 'LAST'; align?: 'start' | 'center' | 'end'; behavior?: 'auto' | 'smooth' };
    scrollerRef?: (target: HTMLElement | Window | null) => void;
    totalListHeightChanged?: (height: number) => void;
  };

  const Virtuoso = React.forwardRef<MockHandle, MockProps>((props, ref) => {
    const scroller = React.useRef<HTMLDivElement>(null);
    const previousDataLength = React.useRef<number | null>(null);
    React.useImperativeHandle(ref, () => ({
      autoscrollToBottom: virtuosoMock.autoscrollToBottom,
      scrollToIndex: virtuosoMock.scrollToIndex,
    }), []);
    React.useLayoutEffect(() => {
      const dataLength = props.data?.length ?? 0;
      const previousLength = previousDataLength.current;
      previousDataLength.current = dataLength;
      if (previousLength === null || previousLength === dataLength) return;
      const behavior = typeof props.followOutput === 'function' ? props.followOutput(true) : props.followOutput;
      if (behavior) virtuosoMock.scrollToIndex({ index: 'LAST', align: 'end', behavior: behavior === true ? 'auto' : behavior });
    }, [props.data?.length, props.followOutput]);
    React.useEffect(() => {
      props.scrollerRef?.(scroller.current);
      virtuosoMock.atBottomStateChange = props.atBottomStateChange ?? null;
      virtuosoMock.totalListHeightChanged = props.totalListHeightChanged ?? null;
      props.atBottomStateChange?.(true);
      return () => {
        props.scrollerRef?.(null);
        virtuosoMock.atBottomStateChange = null;
        virtuosoMock.totalListHeightChanged = null;
      };
    }, [props.atBottomStateChange, props.scrollerRef, props.totalListHeightChanged]);
    return React.createElement('div', {
      ref: scroller,
      'data-testid': 'virtuoso-scroller',
      'data-initial-top-most-item': props.initialTopMostItemIndex?.index,
    });
  });

  return { Virtuoso };
});

const ready = (): RuntimeState => ({
  status: 'ready',
  project: { path: '/project', name: 'project', trusted: true },
  sessionId: 's1',
  sessionFile: null,
  streaming: true,
  model: { provider: 'test', id: 'model', name: 'Model', reasoning: true, contextWindow: 100_000, supportsImages: false },
  models: [],
  thinkingLevel: 'medium',
  permissionLevel: 'edit',
  messages: [],
  commands: [],
  error: null,
});

let animationFrames = new Map<number, FrameRequestCallback>();
let nextAnimationFrameId = 1;

const flushAnimationFrames = () => {
  const callbacks = [...animationFrames.values()];
  animationFrames.clear();
  act(() => callbacks.forEach((callback) => callback(performance.now())));
};

const apply = (events: PiEvent[]) => {
  act(() => useRuntimeStore.getState().applyEvents(events));
};

function viewport() {
  const scroller = screen.getByTestId('virtuoso-scroller');
  const dimensions = { height: 1_000, top: 600 };
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, get: () => dimensions.height },
    scrollTop: {
      configurable: true,
      get: () => dimensions.top,
      set: (value: number) => { dimensions.top = Math.max(0, Math.min(value, dimensions.height - 400)); },
    },
  });
  fireEvent.scroll(scroller);
  return { scroller, dimensions };
}

describe('conversation scrollbar metrics', () => {
  it('maps the full conversation range into the bounded visual track', () => {
    expect(getConversationScrollbarMetrics(2_000, 500, 320, 750)).toEqual({
      maxScroll: 1_500,
      scrollTop: 750,
      thumbHeight: 80,
      thumbOffset: 120,
    });
    expect(getConversationScrollbarMetrics(500, 500, 320, 0)).toBeNull();
  });
});

describe('conversation output auto-scroll', () => {
  beforeEach(() => {
    animationFrames = new Map();
    nextAnimationFrameId = 1;
    virtuosoMock.autoscrollToBottom.mockReset();
    virtuosoMock.scrollToIndex.mockReset();
    virtuosoMock.atBottomStateChange = null;
    virtuosoMock.totalListHeightChanged = null;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextAnimationFrameId++;
      animationFrames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      animationFrames.delete(id);
    });
    useRuntimeStore.getState().setRuntime({ ...ready(), sessionId: null });
    useRuntimeStore.getState().setRuntime(ready());
    useUiStore.setState({ flightDeckJump: null, toast: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the virtual final item for End and scrolls Home directly to zero', () => {
    render(<ConversationTimeline />);
    const scrollbar = screen.getByRole('scrollbar', { name: 'Conversation scroll position' });
    fireEvent.keyDown(scrollbar, { key: 'End' });
    expect(virtuosoMock.scrollToIndex).toHaveBeenLastCalledWith({ index: 'LAST', align: 'end', behavior: 'auto' });
    const scroller = screen.getByTestId('virtuoso-scroller');
    scroller.scrollTop = 600;
    fireEvent.keyDown(scrollbar, { key: 'Home' });
    expect(scroller.scrollTop).toBe(0);
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledOnce();
  });

  it('positions an unseen session at the final historical item exactly once', () => {
    const coldSession = { ...ready(), sessionId: 'cold-history-once', streaming: false, messages: [] };
    act(() => useRuntimeStore.getState().hydrateRuntime(coldSession));
    render(<ConversationTimeline />);
    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();

    act(() => useRuntimeStore.getState().hydrateRuntime({
      ...coldSession,
      messages: [{ id: 'historical-1', role: 'user', text: 'Earlier prompt', timestamp: 1 }],
    }));
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledWith({ index: 'LAST', align: 'end', behavior: 'auto' });

    act(() => useRuntimeStore.getState().hydrateRuntime({
      ...coldSession,
      messages: [
        { id: 'historical-1', role: 'user', text: 'Earlier prompt', timestamp: 1 },
        { id: 'historical-2', role: 'assistant', text: 'Earlier answer', timestamp: 2 },
      ],
    }));
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledTimes(1);
  });

  it('positions each selected project/session history at the final item', () => {
    const firstSelection = {
      ...ready(),
      sessionId: 'cold-history-return',
      streaming: false,
      messages: [{ id: 'seen-history', role: 'user' as const, text: 'Remember my position', timestamp: 1 }],
    };
    const otherProjectSelection = {
      ...ready(),
      project: { path: '/other-project', name: 'other-project', trusted: true },
      sessionId: 'cold-history-return',
      streaming: false,
      messages: [
        { id: 'between-1', role: 'user' as const, text: 'Other prompt', timestamp: 1 },
        { id: 'between-2', role: 'assistant' as const, text: 'Other answer', timestamp: 2 },
      ],
    };
    act(() => useRuntimeStore.getState().hydrateRuntime(firstSelection));
    render(<ConversationTimeline />);
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('virtuoso-scroller')).toHaveAttribute('data-initial-top-most-item', 'LAST');

    act(() => useRuntimeStore.getState().hydrateRuntime(otherProjectSelection));
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledTimes(2);

    virtuosoMock.scrollToIndex.mockClear();
    act(() => useRuntimeStore.getState().hydrateRuntime(firstSelection));

    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledOnce();
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledWith({ index: 'LAST', align: 'end', behavior: 'auto' });
  });

  it('follows streaming text, reasoning, and tool updates while pinned to the bottom', () => {
    render(<ConversationTimeline />);
    const { dimensions } = viewport();
    const events: PiEvent[] = [
      { type: 'assistant.text', messageId: 'assistant-1', delta: 'Answer', timestamp: 1 },
      { type: 'assistant.reasoning', messageId: 'assistant-1', delta: 'Checking', timestamp: 2 },
      { type: 'assistant.reasoning', messageId: 'assistant-1', delta: ' files', timestamp: 3 },
      { type: 'tool.started', toolCallId: 'read-1', name: 'read', input: '{}', timestamp: 4 },
      { type: 'tool.updated', toolCallId: 'read-1', output: 'README contents', timestamp: 5 },
    ];
    for (const event of events) {
      apply([event]);
      dimensions.height += 20;
      flushAnimationFrames();
      expect(dimensions.top).toBe(dimensions.height - 400);
      expect(animationFrames.size).toBe(0);
    }
    expect(virtuosoMock.autoscrollToBottom).not.toHaveBeenCalled();
    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();
  });

  it('consumes retained and missing inspector jumps exactly once', () => {
    apply([{ type: 'message.completed', messageId: 'retained', role: 'assistant', text: 'Answer', timestamp: 1 }]);
    render(<ConversationTimeline />);
    virtuosoMock.scrollToIndex.mockClear();

    act(() => useUiStore.getState().requestFlightDeckJump('/project', 's1', { kind: 'message', messageId: 'retained' }));
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledOnce();
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledWith({ index: 0, align: 'center', behavior: 'auto' });
    expect(useUiStore.getState().flightDeckJump).toBeNull();

    apply([
      { type: 'message.completed', messageId: 'later', role: 'assistant', text: 'Later', timestamp: 2 },
      { type: 'error', error: { code: 'UNKNOWN', message: 'Failed', retryable: false }, timestamp: 3 },
    ]);
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledOnce();

    act(() => useUiStore.getState().requestFlightDeckJump('/project', 's1', { kind: 'error', timelineId: 'error:1' }));
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledTimes(2);
    expect(virtuosoMock.scrollToIndex).toHaveBeenLastCalledWith({ index: 2, align: 'center', behavior: 'auto' });
    expect(useUiStore.getState().flightDeckJump).toBeNull();

    act(() => useUiStore.getState().requestFlightDeckJump('/project', 's1', { kind: 'message', messageId: 'missing' }));
    expect(useUiStore.getState().flightDeckJump).toBeNull();
    expect(useUiStore.getState().toast).toMatchObject({ title: 'Activity not retained' });
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledTimes(2);
  });

  it('follows late prompt and image measurements without polling or overriding manual scrolling', () => {
    render(<ConversationTimeline />);
    const { scroller, dimensions } = viewport();
    apply([{ type: 'message.completed', messageId: 'large-prompt', role: 'user', text: 'prompt '.repeat(50_000), timestamp: 1 }]);
    dimensions.height = 40_000;
    virtuosoMock.atBottomStateChange?.(false);
    fireEvent.scroll(scroller);
    flushAnimationFrames();
    expect(dimensions.top).toBe(39_600);
    expect(animationFrames.size).toBe(0);

    dimensions.height = 60_000;
    act(() => virtuosoMock.totalListHeightChanged?.(60_000));
    flushAnimationFrames();
    expect(dimensions.top).toBe(59_600);
    expect(animationFrames.size).toBe(0);

    fireEvent.wheel(scroller, { deltaY: -120 });
    scroller.scrollTop = 450;
    fireEvent.scroll(scroller);
    flushAnimationFrames();
    dimensions.height = 80_000;
    act(() => {
      virtuosoMock.totalListHeightChanged?.(80_000);
      virtuosoMock.atBottomStateChange?.(true);
    });
    apply([{ type: 'assistant.text', messageId: 'assistant-after-prompt', delta: 'Answer', timestamp: 2 }]);
    flushAnimationFrames();
    expect(dimensions.top).toBe(450);
    expect(virtuosoMock.autoscrollToBottom).not.toHaveBeenCalled();
  });

  it('follows a sent prompt when its response and tool arrive in the same batch', () => {
    render(<ConversationTimeline />);
    const { scroller, dimensions } = viewport();
    fireEvent.wheel(scroller, { deltaY: -120 });
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    flushAnimationFrames();
    apply([
      { type: 'message.completed', messageId: 'batched-prompt', role: 'user', text: 'Do the work', timestamp: 1 },
      { type: 'assistant.text', messageId: 'batched-response', delta: 'Working', timestamp: 2 },
      { type: 'tool.started', toolCallId: 'batched-tool', name: 'read', input: '{}', timestamp: 3 },
    ]);
    flushAnimationFrames();
    expect(dimensions.top).toBe(600);
    expect(animationFrames.size).toBe(0);

    fireEvent.wheel(scroller, { deltaY: -120 });
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    flushAnimationFrames();
    apply([{ type: 'assistant.text', messageId: 'batched-response', delta: ' more', timestamp: 4 }]);
    flushAnimationFrames();
    expect(dimensions.top).toBe(0);
  });

  it('keeps following when a reasoning row changes layout before the scheduled scroll', () => {
    render(<ConversationTimeline />);
    const { scroller, dimensions } = viewport();
    apply([{ type: 'assistant.reasoning', messageId: 'assistant-1', delta: 'Checking', timestamp: 1 }]);
    dimensions.height = 1_120;
    virtuosoMock.atBottomStateChange?.(false);
    fireEvent.scroll(scroller);
    flushAnimationFrames();
    expect(dimensions.top).toBe(720);
    expect(virtuosoMock.autoscrollToBottom).not.toHaveBeenCalled();
  });

  it('stops following when the user scrolls up and resumes after they return to the bottom', () => {
    render(<ConversationTimeline />);
    const { scroller, dimensions } = viewport();
    apply([{ type: 'assistant.text', messageId: 'assistant-1', delta: 'First', timestamp: 1 }]);
    fireEvent.wheel(scroller, { deltaY: -120 });
    scroller.scrollTop = 450;
    fireEvent.scroll(scroller);
    flushAnimationFrames();
    expect(dimensions.top).toBe(450);

    fireEvent.wheel(scroller, { deltaY: 120 });
    scroller.scrollTop = 600;
    fireEvent.scroll(scroller);
    apply([{ type: 'assistant.text', messageId: 'assistant-1', delta: ' second', timestamp: 2 }]);
    dimensions.height = 1_120;
    flushAnimationFrames();
    expect(dimensions.top).toBe(720);
  });
});
