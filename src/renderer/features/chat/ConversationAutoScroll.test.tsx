import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiEvent, RuntimeState } from '../../../shared/contracts/ipc';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { ConversationTimeline, getConversationScrollbarMetrics } from './ConversationTimeline';

const virtuosoMock = vi.hoisted(() => ({ autoscrollToBottom: vi.fn(), scrollToIndex: vi.fn() }));

vi.mock('react-virtuoso', async () => {
  const React = await import('react');
  type MockHandle = { autoscrollToBottom: () => void; scrollToIndex: (location: unknown) => void };
  type MockProps = {
    atBottomStateChange?: (atBottom: boolean) => void;
    scrollerRef?: (target: HTMLElement | Window | null) => void;
  };

  const Virtuoso = React.forwardRef<MockHandle, MockProps>((props, ref) => {
    const scroller = React.useRef<HTMLDivElement>(null);
    React.useImperativeHandle(ref, () => ({
      autoscrollToBottom: virtuosoMock.autoscrollToBottom,
      scrollToIndex: virtuosoMock.scrollToIndex,
    }), []);
    React.useEffect(() => {
      props.scrollerRef?.(scroller.current);
      props.atBottomStateChange?.(true);
      return () => props.scrollerRef?.(null);
    }, [props.atBottomStateChange, props.scrollerRef]);
    return React.createElement('div', { ref: scroller, 'data-testid': 'virtuoso-scroller' });
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

    scroller.scrollTop = 450;
    fireEvent.scroll(scroller);
    flushAnimationFrames();
    expect(virtuosoMock.autoscrollToBottom).not.toHaveBeenCalled();

    scroller.scrollTop = 600;
    fireEvent.scroll(scroller);
    apply([{ type: 'assistant.text', messageId: 'assistant-1', delta: ' second', timestamp: 2 }]);
    flushAnimationFrames();
    expect(virtuosoMock.autoscrollToBottom).toHaveBeenCalledTimes(1);
  });
});
