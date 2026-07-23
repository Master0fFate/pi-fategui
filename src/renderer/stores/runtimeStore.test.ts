import { beforeEach, describe, expect, it } from 'vitest';
import { useRuntimeStore } from './runtimeStore';

const reset = () => useRuntimeStore.setState({
  runtime: { status: 'disconnected', project: null, sessionId: null, sessionFile: null, streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], error: null },
  messagesById: {}, messageOrder: [], reasoningByMessageId: {}, lastError: null,
});

describe('runtimeStore event reducer', () => {
  beforeEach(reset);

  it('updates only the streamed message entity across a batched delta', () => {
    useRuntimeStore.getState().applyEvents([
      { type: 'message.started', messageId: 'm1', role: 'assistant', timestamp: 1 },
      { type: 'assistant.text', messageId: 'm1', delta: 'hello ', timestamp: 2 },
      { type: 'assistant.text', messageId: 'm1', delta: 'world', timestamp: 3 },
      { type: 'assistant.reasoning', messageId: 'm1', delta: 'checked', timestamp: 3 },
    ]);
    expect(useRuntimeStore.getState().messagesById.m1?.text).toBe('hello world');
    expect(useRuntimeStore.getState().reasoningByMessageId.m1).toBe('checked');
    expect(useRuntimeStore.getState().messageOrder).toEqual(['m1']);
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
  });
});
