import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiEvent, RuntimeState } from '../../../shared/contracts/ipc';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { ConversationTimeline, getConversationScrollbarMetrics } from './ConversationTimeline';

const virtuosoMock = vi.hoisted(() => ({
  autoscrollToBottom: vi.fn(),
  scrollToIndex: vi.fn(),
  atBottomStateChange: null as ((atBottom: boolean) => void) | null,
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
      props.atBottomStateChange?.(true);
      return () => {
        props.scrollerRef?.(null);
        virtuosoMock.atBottomStateChange = null;
      };
    }, [props.atBottomStateChange, props.scrollerRef]);
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

    apply([{ type: 'assistant.text', messageId: 'assistant-1', delta: 'Answer', timestamp: 1 }]);
    flushAnimationFrames();
    expect(virtuosoMock.autoscrollToBottom).toHaveBeenCalledTimes(1);

    apply([{ type: 'assistant.reasoning', messageId: 'assistant-1', delta: 'Checking', timestamp: 2 }]);
    flushAnimationFrames();
    expect(virtuosoMock.autoscrollToBottom).toHaveBeenCalledTimes(2);

    apply([{ type: 'assistant.reasoning', messageId: 'assistant-1', delta: ' files', timestamp: 3 }]);
    flushAnimationFrames();
    expect(virtuosoMock.autoscrollToBottom).toHaveBeenCalledTimes(3);

    apply([{ type: 'tool.started', toolCallId: 'read-1', name: 'read', input: '{}', timestamp: 4 }]);
    flushAnimationFrames();
    expect(virtuosoMock.autoscrollToBottom).toHaveBeenCalledTimes(4);

    apply([{ type: 'tool.updated', toolCallId: 'read-1', output: 'README contents', timestamp: 5 }]);
    flushAnimationFrames();
    expect(virtuosoMock.autoscrollToBottom).toHaveBeenCalledTimes(5);
    expect(virtuosoMock.scrollToIndex).not.toHaveBeenCalled();
  });

  it('keeps following when a reasoning row changes layout before the scheduled scroll', () => {
    render(<ConversationTimeline />);
    const scroller = screen.getByTestId('virtuoso-scroller');
    let scrollHeight = 1_000;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });
    scroller.scrollTop = 600;
    fireEvent.scroll(scroller);

    apply([{ type: 'assistant.reasoning', messageId: 'assistant-1', delta: 'Checking', timestamp: 1 }]);
    scrollHeight = 1_120;
    virtuosoMock.atBottomStateChange?.(false);
    fireEvent.scroll(scroller);
    flushAnimationFrames();

    expect(virtuosoMock.autoscrollToBottom).toHaveBeenCalledOnce();
    expect(virtuosoMock.scrollToIndex).toHaveBeenCalledWith({ index: 'LAST', align: 'end', behavior: 'auto' });
  });

  it('stops following when the user scrolls up and resumes after they return to the bottom', () => {
    render(<ConversationTimeline />);
    const scroller = screen.getByTestId('virtuoso-scroller');
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_000 },
    });

    scroller.scrollTop = 600;
    fireEvent.scroll(scroller);
    apply([{ type: 'assistant.text', messageId: 'assistant-1', delta: 'First', timestamp: 1 }]);

    fireEvent.wheel(scroller, { deltaY: -120 });
    scroller.scrollTop = 450;
    fireEvent.scroll(scroller);
    flushAnimationFrames();
    expect(virtuosoMock.autoscrollToBottom).not.toHaveBeenCalled();

    fireEvent.wheel(scroller, { deltaY: 120 });
    scroller.scrollTop = 600;
    fireEvent.scroll(scroller);
    apply([{ type: 'assistant.text', messageId: 'assistant-1', delta: ' second', timestamp: 2 }]);
    flushAnimationFrames();
    expect(virtuosoMock.autoscrollToBottom).toHaveBeenCalledTimes(1);
  });
});
