import { create } from 'zustand';
import type { AppError, PiEvent, RuntimeMessage, RuntimeState } from '../../shared/contracts/ipc';

const disconnected: RuntimeState = {
  status: 'disconnected', project: null, sessionId: null, sessionFile: null, streaming: false,
  model: null, models: [], thinkingLevel: 'medium', messages: [], error: null,
};

interface RuntimeStore {
  runtime: RuntimeState;
  messagesById: Record<string, RuntimeMessage>;
  messageOrder: string[];
  reasoningByMessageId: Record<string, string>;
  lastError: AppError | null;
  setRuntime: (state: RuntimeState) => void;
  applyEvents: (events: PiEvent[]) => void;
}

function indexed(messages: RuntimeMessage[]) {
  return {
    messagesById: Object.fromEntries(messages.map((message) => [message.id, message])),
    messageOrder: messages.map((message) => message.id),
    reasoningByMessageId: Object.fromEntries(
      messages.flatMap((message) => message.reasoning ? [[message.id, message.reasoning]] : []),
    ),
  };
}

export const useRuntimeStore = create<RuntimeStore>((set) => ({
  runtime: disconnected,
  ...indexed([]),
  reasoningByMessageId: {},
  lastError: null,
  setRuntime: (runtime) => set({ runtime, ...indexed(runtime.messages), lastError: runtime.error }),
  applyEvents: (events) => set((current) => {
    let runtime = current.runtime;
    let messagesById = { ...current.messagesById };
    let messageOrder = [...current.messageOrder];
    let reasoningByMessageId = { ...current.reasoningByMessageId };
    let lastError = current.lastError;
    for (const event of events) {
      if (event.type === 'state.changed') {
        runtime = event.state;
        // Full message snapshots are used for explicit session/project loads only.
        // Frequent lifecycle snapshots intentionally omit history to bound IPC.
        if (event.messagesIncluded && !event.state.streaming) {
          ({ messagesById, messageOrder, reasoningByMessageId } = indexed(event.state.messages));
        }
        lastError = event.state.error;
      } else if (event.type === 'message.started') {
        if (!messagesById[event.messageId]) {
          messagesById[event.messageId] = { id: event.messageId, role: event.role, text: '', timestamp: event.timestamp };
          messageOrder.push(event.messageId);
        }
      } else if (event.type === 'assistant.text') {
        const existing = messagesById[event.messageId] ?? { id: event.messageId, role: 'assistant' as const, text: '', timestamp: event.timestamp };
        if (!messagesById[event.messageId]) messageOrder.push(event.messageId);
        messagesById[event.messageId] = { ...existing, text: existing.text + event.delta };
      } else if (event.type === 'assistant.reasoning') {
        reasoningByMessageId[event.messageId] = (reasoningByMessageId[event.messageId] ?? '') + event.delta;
      } else if (event.type === 'message.completed') {
        const existing = messagesById[event.messageId];
        if (!existing) messageOrder.push(event.messageId);
        messagesById[event.messageId] = {
          id: event.messageId, role: event.role, text: event.text,
          timestamp: existing?.timestamp ?? event.timestamp,
          ...(event.error === undefined ? {} : { error: event.error }),
        };
      } else if (event.type === 'error') {
        lastError = event.error;
      } else if (event.type === 'run.started') {
        runtime = { ...runtime, streaming: true };
      } else if (event.type === 'run.completed') {
        runtime = { ...runtime, streaming: false };
      }
    }
    return { runtime, messagesById, messageOrder, reasoningByMessageId, lastError };
  }),
}));
