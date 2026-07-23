import { create } from 'zustand';
import type { AppError, PiEvent, RuntimeMessage, RuntimeState } from '../../shared/contracts/ipc';

export const MAX_LIVE_TOOL_OUTPUT = 64_000;

export interface ToolExecution {
  id: string;
  name: string;
  input: string;
  output: string;
  outputTruncated: boolean;
  status: 'running' | 'succeeded' | 'error';
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
}

export type TimelineEntity =
  | { id: string; kind: 'message'; messageId: string; timestamp: number }
  | { id: string; kind: 'reasoning'; messageId: string; timestamp: number }
  | { id: string; kind: 'tool'; toolCallId: string; timestamp: number }
  | { id: string; kind: 'error'; error: AppError; timestamp: number }
  | { id: string; kind: 'compaction'; phase: 'started' | 'completed'; aborted?: boolean; timestamp: number };

const disconnected: RuntimeState = {
  status: 'disconnected', project: null, sessionId: null, sessionFile: null, streaming: false,
  model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null,
};

interface RuntimeStore {
  runtime: RuntimeState;
  messagesById: Record<string, RuntimeMessage>;
  messageOrder: string[];
  reasoningByMessageId: Record<string, string>;
  toolsById: Record<string, ToolExecution>;
  toolOrder: string[];
  timelineById: Record<string, TimelineEntity>;
  timelineOrder: string[];
  queue: { steering: number; followUp: number };
  lastError: AppError | null;
  sequence: number;
  activeCompactionId: string | null;
  setRuntime: (state: RuntimeState) => void;
  applyEvents: (events: PiEvent[]) => void;
}

function boundOutput(output: string): { output: string; outputTruncated: boolean } {
  if (output.length <= MAX_LIVE_TOOL_OUTPUT) return { output, outputTruncated: false };
  const marker = '\n… live output truncated …\n';
  const available = MAX_LIVE_TOOL_OUTPUT - marker.length;
  const startLength = Math.ceil(available / 2);
  const endLength = Math.floor(available / 2);
  return {
    output: `${output.slice(0, startLength)}${marker}${output.slice(-endLength)}`,
    outputTruncated: true,
  };
}

function indexed(messages: RuntimeMessage[]) {
  const messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));
  const messageOrder = messages.map((message) => message.id);
  const reasoningByMessageId = Object.fromEntries(
    messages.flatMap((message) => message.reasoning ? [[message.id, message.reasoning]] : []),
  );
  const timelineById: Record<string, TimelineEntity> = {};
  const timelineOrder: string[] = [];
  for (const message of messages) {
    const messageEntry: TimelineEntity = { id: `message:${message.id}`, kind: 'message', messageId: message.id, timestamp: message.timestamp };
    timelineById[messageEntry.id] = messageEntry;
    timelineOrder.push(messageEntry.id);
    if (message.reasoning) {
      const reasoningEntry: TimelineEntity = { id: `reasoning:${message.id}`, kind: 'reasoning', messageId: message.id, timestamp: message.timestamp };
      timelineById[reasoningEntry.id] = reasoningEntry;
      timelineOrder.push(reasoningEntry.id);
    }
  }
  return { messagesById, messageOrder, reasoningByMessageId, timelineById, timelineOrder };
}

export const useRuntimeStore = create<RuntimeStore>((set) => ({
  runtime: disconnected,
  ...indexed([]),
  toolsById: {},
  toolOrder: [],
  queue: { steering: 0, followUp: 0 },
  lastError: null,
  sequence: 0,
  activeCompactionId: null,
  setRuntime: (runtime) => set((current) => {
    const sameSession = current.runtime.sessionId !== null
      && current.runtime.sessionId === runtime.sessionId
      && current.runtime.project?.path === runtime.project?.path;
    if (sameSession) {
      // Model/thinking/status responses describe the same session and must not
      // erase streamed timeline or tool entities already owned by the store.
      return { runtime, lastError: runtime.error };
    }
    return {
      runtime,
      ...indexed(runtime.messages),
      toolsById: {},
      toolOrder: [],
      queue: { steering: 0, followUp: 0 },
      lastError: runtime.error,
      sequence: 0,
      activeCompactionId: null,
    };
  }),
  applyEvents: (events) => set((current) => {
    let runtime = current.runtime;
    let messagesById = current.messagesById;
    let messageOrder = current.messageOrder;
    let reasoningByMessageId = current.reasoningByMessageId;
    let toolsById = current.toolsById;
    let toolOrder = current.toolOrder;
    let timelineById = current.timelineById;
    let timelineOrder = current.timelineOrder;
    let queue = current.queue;
    let lastError = current.lastError;
    let sequence = current.sequence;
    let activeCompactionId = current.activeCompactionId;

    const setMessage = (id: string, message: RuntimeMessage) => {
      if (messagesById === current.messagesById) messagesById = { ...messagesById };
      messagesById[id] = message;
    };
    const setReasoning = (id: string, value: string) => {
      if (reasoningByMessageId === current.reasoningByMessageId) reasoningByMessageId = { ...reasoningByMessageId };
      reasoningByMessageId[id] = value;
    };
    const setTool = (id: string, tool: ToolExecution) => {
      if (toolsById === current.toolsById) toolsById = { ...toolsById };
      toolsById[id] = tool;
    };
    const setTimeline = (entry: TimelineEntity) => {
      if (timelineById === current.timelineById) timelineById = { ...timelineById };
      timelineById[entry.id] = entry;
    };
    const appendMessage = (messageId: string, role: RuntimeMessage['role'], timestamp: number) => {
      if (!messagesById[messageId]) {
        setMessage(messageId, { id: messageId, role, text: '', timestamp });
        if (messageOrder === current.messageOrder) messageOrder = [...messageOrder];
        messageOrder.push(messageId);
      }
      const id = `message:${messageId}`;
      if (!timelineById[id]) {
        setTimeline({ id, kind: 'message', messageId, timestamp });
        if (timelineOrder === current.timelineOrder) timelineOrder = [...timelineOrder];
        timelineOrder.push(id);
      }
    };
    const appendReasoning = (messageId: string, timestamp: number) => {
      const id = `reasoning:${messageId}`;
      if (!timelineById[id]) {
        setTimeline({ id, kind: 'reasoning', messageId, timestamp });
        if (timelineOrder === current.timelineOrder) timelineOrder = [...timelineOrder];
        timelineOrder.push(id);
      }
    };
    const appendTool = (toolCallId: string, timestamp: number) => {
      const id = `tool:${toolCallId}`;
      if (!timelineById[id]) {
        setTimeline({ id, kind: 'tool', toolCallId, timestamp });
        if (timelineOrder === current.timelineOrder) timelineOrder = [...timelineOrder];
        timelineOrder.push(id);
      }
      if (!toolOrder.includes(toolCallId)) {
        if (toolOrder === current.toolOrder) toolOrder = [...toolOrder];
        toolOrder.push(toolCallId);
      }
    };

    for (const event of events) {
      if (event.type === 'state.changed') {
        runtime = event.state;
        if (event.messagesIncluded) {
          ({ messagesById, messageOrder, reasoningByMessageId, timelineById, timelineOrder } = indexed(event.state.messages));
          toolsById = {};
          toolOrder = [];
          activeCompactionId = null;
        }
        lastError = event.state.error;
      } else if (event.type === 'message.started') {
        appendMessage(event.messageId, event.role, event.timestamp);
      } else if (event.type === 'assistant.text') {
        appendMessage(event.messageId, 'assistant', event.timestamp);
        const existing = messagesById[event.messageId]!;
        setMessage(event.messageId, { ...existing, text: existing.text + event.delta });
      } else if (event.type === 'assistant.reasoning') {
        appendMessage(event.messageId, 'assistant', event.timestamp);
        appendReasoning(event.messageId, event.timestamp);
        setReasoning(event.messageId, (reasoningByMessageId[event.messageId] ?? '') + event.delta);
      } else if (event.type === 'message.completed') {
        appendMessage(event.messageId, event.role, event.timestamp);
        const existing = messagesById[event.messageId];
        setMessage(event.messageId, {
          id: event.messageId,
          role: event.role,
          text: event.text,
          timestamp: existing?.timestamp ?? event.timestamp,
          ...(event.error === undefined ? {} : { error: event.error }),
        });
      } else if (event.type === 'tool.started') {
        appendTool(event.toolCallId, event.timestamp);
        setTool(event.toolCallId, {
          id: event.toolCallId, name: event.name, input: event.input, output: '', outputTruncated: false,
          status: 'running', startedAt: event.timestamp, updatedAt: event.timestamp,
        });
      } else if (event.type === 'tool.updated') {
        appendTool(event.toolCallId, event.timestamp);
        const existing = toolsById[event.toolCallId] ?? {
          id: event.toolCallId, name: 'Tool', input: '', output: '', outputTruncated: false,
          status: 'running' as const, startedAt: event.timestamp, updatedAt: event.timestamp,
        };
        setTool(event.toolCallId, { ...existing, ...boundOutput(event.output), updatedAt: event.timestamp });
      } else if (event.type === 'tool.completed') {
        appendTool(event.toolCallId, event.timestamp);
        const existing = toolsById[event.toolCallId];
        setTool(event.toolCallId, {
          id: event.toolCallId,
          name: event.name,
          input: existing?.input ?? '',
          ...boundOutput(event.output),
          status: event.error ? 'error' : 'succeeded',
          startedAt: existing?.startedAt ?? event.timestamp,
          updatedAt: event.timestamp,
          endedAt: event.timestamp,
        });
      } else if (event.type === 'queue.changed') {
        queue = { steering: event.steering, followUp: event.followUp };
      } else if (event.type === 'context.compaction') {
        if (event.phase === 'started') {
          const id = `compaction:${++sequence}`;
          activeCompactionId = id;
          setTimeline({ id, kind: 'compaction', phase: 'started', timestamp: event.timestamp });
          if (timelineOrder === current.timelineOrder) timelineOrder = [...timelineOrder];
          timelineOrder.push(id);
        } else {
          const id = activeCompactionId ?? `compaction:${++sequence}`;
          setTimeline({ id, kind: 'compaction', phase: 'completed', ...(event.aborted === undefined ? {} : { aborted: event.aborted }), timestamp: event.timestamp });
          if (!timelineOrder.includes(id)) {
            if (timelineOrder === current.timelineOrder) timelineOrder = [...timelineOrder];
            timelineOrder.push(id);
          }
          activeCompactionId = null;
        }
      } else if (event.type === 'error') {
        lastError = event.error;
        const id = `error:${++sequence}`;
        setTimeline({ id, kind: 'error', error: event.error, timestamp: event.timestamp });
        if (timelineOrder === current.timelineOrder) timelineOrder = [...timelineOrder];
        timelineOrder.push(id);
      } else if (event.type === 'run.started') {
        runtime = { ...runtime, streaming: true };
      } else if (event.type === 'run.completed') {
        runtime = { ...runtime, streaming: false };
      }
    }
    return {
      runtime, messagesById, messageOrder, reasoningByMessageId, toolsById, toolOrder,
      timelineById, timelineOrder, queue, lastError, sequence, activeCompactionId,
    };
  }),
}));
