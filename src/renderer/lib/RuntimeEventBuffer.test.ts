import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PiEvent, RuntimeState } from '../../shared/contracts/ipc';
import { useRuntimeStore } from '../stores/runtimeStore';
import { MAX_BUFFERED_STREAM_CHARACTERS, MAX_BUFFERED_STREAM_EVENTS, RuntimeEventBuffer, streamPresentationDelay } from './RuntimeEventBuffer';

const text = (cursor: number, delta = 'token'): PiEvent => ({ type: 'assistant.text', messageId: 'answer', delta, cursor, timestamp: cursor });

afterEach(() => vi.useRealTimers());

describe('stream presentation', () => {
  it.each([
    [{}, 0],
    [{ performanceMode: 'true' }, 64],
    [{ reduceMotion: 'true' }, 64],
    [{ holyShitMode: 'true' }, 200],
  ])('uses the effective visual mode %j', (dataset, expected) => {
    const root = document.createElement('div');
    Object.assign(root.dataset, dataset);
    expect(streamPresentationDelay(root)).toBe(expected);
  });

  it('keeps normal mode immediate and idle modes free of timers', () => {
    vi.useFakeTimers();
    const apply = vi.fn();
    const buffer = new RuntimeEventBuffer(apply, () => 0);
    const events = [text(1)];
    buffer.enqueue(events);
    expect(apply).toHaveBeenCalledWith(events);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([64, 200])('batches streams without losing order or extending the %i ms deadline', async (delay) => {
    vi.useFakeTimers();
    const apply = vi.fn();
    const buffer = new RuntimeEventBuffer(apply, () => delay);
    buffer.enqueue([text(1)]);
    await vi.advanceTimersByTimeAsync(delay - 1);
    buffer.enqueue([text(2)]);
    expect(apply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(apply).toHaveBeenCalledExactlyOnceWith([text(1), text(2)]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each<PiEvent>([
    { type: 'run.completed', runId: 'run', aborted: false, timestamp: 2 },
    { type: 'error', error: { code: 'PI_RUNTIME_ERROR', message: 'Failed', retryable: true }, timestamp: 2 },
    { type: 'queue.changed', steering: 1, followUp: 0, timestamp: 2 },
    { type: 'message.completed', messageId: 'answer', role: 'assistant', text: 'final', timestamp: 2 },
    { type: 'tool.started', toolCallId: 'tool', name: 'read', input: '{}', timestamp: 2 },
  ])('flushes immediately before $type', (event) => {
    vi.useFakeTimers();
    const apply = vi.fn();
    const buffer = new RuntimeEventBuffer(apply, () => 200);
    buffer.enqueue([text(1)]);
    buffer.enqueue([event]);
    expect(apply).toHaveBeenCalledExactlyOnceWith([text(1), event]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps child deltas and tool snapshots in order', async () => {
    vi.useFakeTimers();
    const apply = vi.fn();
    const buffer = new RuntimeEventBuffer(apply, () => 200);
    const events: PiEvent[] = [
      { type: 'subagent.event', runId: 'child', event: { type: 'assistant.reasoning', messageId: 'answer', delta: 'thinking', timestamp: 1 }, timestamp: 1 },
      { type: 'tool.updated', toolCallId: 'tool', output: 'first', timestamp: 2 },
      { type: 'tool.updated', toolCallId: 'tool', output: 'latest', timestamp: 3 },
    ];
    for (const event of events) buffer.enqueue([event]);
    await vi.advanceTimersByTimeAsync(200);
    expect(apply).toHaveBeenCalledExactlyOnceWith(events);
  });

  it('keeps only the newest known-tool snapshot at its original cursor position', async () => {
    vi.useFakeTimers();
    const apply = vi.fn();
    const buffer = new RuntimeEventBuffer(apply, () => 200, () => true);
    const first: PiEvent = { type: 'tool.updated', toolCallId: 'tool', output: 'first', timestamp: 1, cursor: 1 };
    const latest: PiEvent = { ...first, output: 'latest', timestamp: 3, cursor: 3 };
    buffer.enqueue([first, text(2), latest]);
    await vi.advanceTimersByTimeAsync(200);
    expect(apply).toHaveBeenCalledExactlyOnceWith([text(2), latest]);
  });

  it('does not replace a newer snapshot with a stale cursor or invent an unknown tool position', async () => {
    vi.useFakeTimers();
    const apply = vi.fn();
    const buffer = new RuntimeEventBuffer(apply, () => 200, (id) => id === 'known');
    const events: PiEvent[] = [
      { type: 'tool.updated', toolCallId: 'known', output: 'new', timestamp: 4, cursor: 4 },
      { type: 'tool.updated', toolCallId: 'known', output: 'stale', timestamp: 2, cursor: 2 },
      { type: 'tool.updated', toolCallId: 'unknown', output: 'first', timestamp: 5, cursor: 5 },
      text(6),
      { type: 'tool.updated', toolCallId: 'unknown', output: 'latest', timestamp: 7, cursor: 7 },
    ];
    buffer.enqueue(events);
    await vi.advanceTimersByTimeAsync(200);
    expect(apply.mock.calls.flatMap(([batch]) => batch)).toEqual(events);
  });

  it.each([[10, 9, 11], [1, 3, 2], [1, undefined, 2], [undefined, 1, undefined]])('preserves store cursor barriers for %j', async (first, middle, last) => {
    vi.useFakeTimers();
    const initial: RuntimeState = {
      status: 'ready', project: null, sessionId: 'immediate', sessionFile: null, streaming: true,
      model: null, models: [], thinkingLevel: 'medium', messages: [], error: null, eventCursor: 0,
      tools: [{ id: 'tool', name: 'read', input: '{}', output: '', outputTruncated: false, status: 'running', startedAt: 0, updatedAt: 0 }],
    };
    const events: PiEvent[] = [
      { type: 'tool.updated', toolCallId: 'tool', output: 'first', timestamp: 1, ...(first === undefined ? {} : { cursor: first }) },
      { type: 'assistant.text', messageId: 'answer', delta: 'text', timestamp: 2, ...(middle === undefined ? {} : { cursor: middle }) },
      { type: 'tool.updated', toolCallId: 'tool', output: 'last', timestamp: 3, ...(last === undefined ? {} : { cursor: last }) },
    ];
    const snapshot = () => {
      const state = useRuntimeStore.getState();
      return { cursor: state.sequence, output: state.toolsById.tool?.output, text: state.messagesById.answer?.text };
    };
    useRuntimeStore.getState().hydrateRuntime(initial);
    useRuntimeStore.getState().applyEvents(events);
    const expected = snapshot();
    useRuntimeStore.getState().hydrateRuntime({ ...initial, sessionId: 'buffered' });
    const buffer = new RuntimeEventBuffer(useRuntimeStore.getState().applyEvents, () => 200, () => true);
    buffer.enqueue(events);
    await vi.advanceTimersByTimeAsync(200);
    expect(snapshot()).toEqual(expected);
  });

  it('releases superseded large output instead of hitting the character cap', async () => {
    vi.useFakeTimers();
    const apply = vi.fn();
    const buffer = new RuntimeEventBuffer(apply, () => 200, () => true);
    const events: PiEvent[] = Array.from({ length: 100 }, (_, index) => ({ type: 'tool.updated', toolCallId: 'tool', output: String(index).padEnd(64_000, 'x'), timestamp: index }));
    for (const event of events) buffer.enqueue([event]);
    expect(apply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(apply).toHaveBeenCalledExactlyOnceWith([events.at(-1)]);
  });

  it('bounds pending characters and count without dropping events', () => {
    vi.useFakeTimers();
    const received: PiEvent[] = [];
    const apply = vi.fn((events: PiEvent[]) => received.push(...events));
    const buffer = new RuntimeEventBuffer(apply, () => 200);
    const events = Array.from({ length: MAX_BUFFERED_STREAM_EVENTS + 1 }, (_, index) => text(index));
    for (const event of events) buffer.enqueue([event]);
    expect(apply).toHaveBeenCalledTimes(1);
    buffer.enqueue([text(1000, 'x'.repeat(MAX_BUFFERED_STREAM_CHARACTERS))]);
    expect(received).toEqual([...events, text(1000, 'x'.repeat(MAX_BUFFERED_STREAM_CHARACTERS))]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flushes a previous mode on the next normal-mode event', () => {
    vi.useFakeTimers();
    const apply = vi.fn();
    let delay = 200;
    const buffer = new RuntimeEventBuffer(apply, () => delay);
    buffer.enqueue([text(1)]);
    delay = 0;
    buffer.enqueue([text(2)]);
    expect(apply).toHaveBeenCalledExactlyOnceWith([text(1), text(2)]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops pending presentation and its timer when the subscriber is disposed', async () => {
    vi.useFakeTimers();
    const apply = vi.fn();
    const buffer = new RuntimeEventBuffer(apply, () => 200);
    buffer.enqueue([text(1)]);
    buffer.clear();
    await vi.advanceTimersByTimeAsync(200);
    expect(apply).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
