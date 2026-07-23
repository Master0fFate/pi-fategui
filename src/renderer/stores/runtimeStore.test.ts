import { beforeEach, describe, expect, it } from 'vitest';
import type { PiEvent } from '../../shared/contracts/ipc';
import { MAX_LIVE_TOOL_OUTPUT, useRuntimeStore } from './runtimeStore';

const reset = () => useRuntimeStore.setState({
  runtime: { status: 'disconnected', project: null, sessionId: null, sessionFile: null, streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null },
  messagesById: {}, messageOrder: [], reasoningByMessageId: {}, toolsById: {}, toolOrder: [],
  timelineById: {}, timelineOrder: [], queue: { steering: 0, followUp: 0 }, lastError: null,
  sequence: 0, activeCompactionId: null,
});

describe('runtimeStore event reducer', () => {
  beforeEach(reset);

  it('updates only the streamed message entity across a batched delta', () => {
    useRuntimeStore.getState().applyEvents([
      { type: 'message.started', messageId: 'm1', role: 'assistant', timestamp: 1 },
      { type: 'message.started', messageId: 'm2', role: 'user', timestamp: 1 },
    ]);
    const untouched = useRuntimeStore.getState().messagesById.m2;
    const order = useRuntimeStore.getState().messageOrder;
    const timelineOrder = useRuntimeStore.getState().timelineOrder;

    useRuntimeStore.getState().applyEvents([
      { type: 'assistant.text', messageId: 'm1', delta: 'hello ', timestamp: 2 },
      { type: 'assistant.text', messageId: 'm1', delta: 'world', timestamp: 3 },
      { type: 'assistant.reasoning', messageId: 'm1', delta: 'checked', timestamp: 3 },
    ]);
    expect(useRuntimeStore.getState().messagesById.m1?.text).toBe('hello world');
    expect(useRuntimeStore.getState().messagesById.m2).toBe(untouched);
    expect(useRuntimeStore.getState().messageOrder).toBe(order);
    expect(useRuntimeStore.getState().reasoningByMessageId.m1).toBe('checked');
    // One reasoning row was added; existing message IDs were not rebuilt.
    expect(useRuntimeStore.getState().timelineOrder.slice(0, 2)).toEqual(timelineOrder);
  });

  it('preserves streamed entities when a bounded lifecycle snapshot omits message history', () => {
    useRuntimeStore.getState().applyEvents([
      { type: 'message.started', messageId: 'm1', role: 'assistant', timestamp: 1 },
      { type: 'assistant.text', messageId: 'm1', delta: 'answer', timestamp: 2 },
      { type: 'assistant.reasoning', messageId: 'm1', delta: 'reason', timestamp: 2 },
      {
        type: 'state.changed',
        timestamp: 3,
        messagesIncluded: false,
        state: { status: 'ready', project: null, sessionId: 's1', sessionFile: null, streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], error: null },
      },
    ]);
    expect(useRuntimeStore.getState().messagesById.m1?.text).toBe('answer');
    expect(useRuntimeStore.getState().reasoningByMessageId.m1).toBe('reason');
  });

  it('hydrates completed reasoning from an authoritative runtime state', () => {
    useRuntimeStore.getState().setRuntime({
      status: 'ready', project: null, sessionId: 's1', sessionFile: null, streaming: false,
      model: null, models: [], thinkingLevel: 'medium', error: null,
      messages: [{ id: 'stable', role: 'assistant', text: 'answer', reasoning: 'reason', timestamp: 1 }],
    });
    expect(useRuntimeStore.getState().reasoningByMessageId.stable).toBe('reason');
    expect(useRuntimeStore.getState().timelineOrder).toEqual(['message:stable', 'reasoning:stable']);
  });

  it('models structured tool transitions and bounds live output', () => {
    useRuntimeStore.getState().applyEvents([
      { type: 'tool.started', toolCallId: 't1', name: 'bash', input: '{"command":"test"}', timestamp: 10 },
      { type: 'tool.updated', toolCallId: 't1', output: 'x'.repeat(MAX_LIVE_TOOL_OUTPUT + 100), timestamp: 11 },
    ]);
    expect(useRuntimeStore.getState().toolsById.t1?.status).toBe('running');
    expect(useRuntimeStore.getState().toolsById.t1?.output.length).toBeLessThan(MAX_LIVE_TOOL_OUTPUT + 100);
    expect(useRuntimeStore.getState().toolsById.t1?.outputTruncated).toBe(true);

    useRuntimeStore.getState().applyEvents([
      { type: 'tool.completed', toolCallId: 't1', name: 'bash', output: 'failed', error: true, timestamp: 20 },
    ]);
    expect(useRuntimeStore.getState().toolsById.t1).toMatchObject({ status: 'error', output: 'failed', startedAt: 10, endedAt: 20 });
    expect(useRuntimeStore.getState().timelineOrder).toEqual(['tool:t1']);
  });

  it('preserves tool history when controls update the same runtime session', () => {
    useRuntimeStore.getState().setRuntime({
      status: 'ready', project: { path: '/project', name: 'project', trusted: true }, sessionId: 'same', sessionFile: null,
      streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null,
    });
    useRuntimeStore.getState().applyEvents([
      { type: 'tool.started', toolCallId: 't1', name: 'read', input: '{}', timestamp: 1 },
      { type: 'tool.completed', toolCallId: 't1', name: 'read', output: 'ok', error: false, timestamp: 2 },
    ]);
    useRuntimeStore.getState().setRuntime({
      ...useRuntimeStore.getState().runtime,
      thinkingLevel: 'high',
      messages: [],
    });
    expect(useRuntimeStore.getState().toolsById.t1?.status).toBe('succeeded');
    expect(useRuntimeStore.getState().timelineOrder).toContain('tool:t1');
  });

  it('indexes 5,000 entries without replacing the ordered entity model', () => {
    const events: PiEvent[] = Array.from({ length: 5_000 }, (_value, index) => ({
      type: 'message.started', messageId: `m${index}`, role: index % 2 ? 'assistant' : 'user', timestamp: index,
    }));
    useRuntimeStore.getState().applyEvents(events);
    expect(useRuntimeStore.getState().timelineOrder).toHaveLength(5_000);
    expect(Object.keys(useRuntimeStore.getState().messagesById)).toHaveLength(5_000);
  });

  it('adds error and compaction entities and tracks queue state', () => {
    useRuntimeStore.getState().applyEvents([
      { type: 'context.compaction', phase: 'started', timestamp: 1 },
      { type: 'context.compaction', phase: 'completed', aborted: false, timestamp: 2 },
      { type: 'queue.changed', steering: 1, followUp: 2, timestamp: 3 },
      { type: 'error', error: { code: 'UNKNOWN', message: 'Failed', retryable: true }, timestamp: 4 },
    ]);
    expect(useRuntimeStore.getState().timelineOrder).toHaveLength(2);
    expect(useRuntimeStore.getState().queue).toEqual({ steering: 1, followUp: 2 });
    expect(Object.values(useRuntimeStore.getState().timelineById).map((item) => item.kind)).toEqual(['compaction', 'error']);
  });
});
