import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { PiEvent } from '../../shared/contracts/ipc';
import { normalizeError } from './errors';

const MAX_SERIALIZED_LENGTH = 64_000;

function timestamp(): number {
  return Date.now();
}

export function safeText(value: unknown, maximum = MAX_SERIALIZED_LENGTH): string {
  let result: string;
  if (typeof value === 'string') result = value;
  else {
    try {
      result = JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item) ?? String(value);
    } catch {
      result = String(value);
    }
  }
  return result.length <= maximum ? result : `${result.slice(0, maximum)}\n… output truncated by Pi Desktop`;
}

export function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const candidate = message as { content?: unknown; errorMessage?: unknown };
  if (typeof candidate.content === 'string') return candidate.content;
  if (!Array.isArray(candidate.content)) return typeof candidate.errorMessage === 'string' ? candidate.errorMessage : '';
  const text = candidate.content.flatMap((part: unknown) => {
    if (!part || typeof part !== 'object') return [];
    const block = part as { type?: string; text?: unknown; thinking?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') return [block.text];
    return [];
  }).join('');
  return text || (typeof candidate.errorMessage === 'string' ? candidate.errorMessage : '');
}

function messageRole(message: unknown): 'user' | 'assistant' | 'tool' {
  const role = message && typeof message === 'object' ? (message as { role?: unknown }).role : undefined;
  return role === 'user' || role === 'assistant' ? role : 'tool';
}

function messageError(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const value = message as { stopReason?: unknown; isError?: unknown };
  return value.isError === true || value.stopReason === 'error';
}

export class PiEventNormalizer {
  private readonly messageIds = new WeakMap<object, string>();
  private sequence = 0;
  private activeAssistantId: string | null = null;

  constructor(private readonly runId: () => string | null) {}

  resetSession(): void {
    this.activeAssistantId = null;
  }

  normalize(event: AgentSessionEvent): PiEvent[] {
    const now = timestamp();
    switch (event.type) {
      case 'agent_start': {
        const runId = this.runId();
        return runId ? [{ type: 'run.started', runId, timestamp: now }] : [];
      }
      case 'agent_end': {
        const runId = this.runId();
        const last = event.messages.at(-1) as { stopReason?: string } | undefined;
        return runId ? [{ type: 'run.completed', runId, aborted: last?.stopReason === 'aborted', timestamp: now }] : [];
      }
      case 'message_start': {
        const role = messageRole(event.message);
        if (role === 'tool') return [];
        const id = this.messageId(event.message);
        if (role === 'assistant') this.activeAssistantId = id;
        return [{ type: 'message.started', messageId: id, role, timestamp: now }];
      }
      case 'message_update': {
        const update = event.assistantMessageEvent;
        const messageId = this.activeAssistantId ?? this.messageId(event.message);
        if (update.type === 'text_delta' && update.delta) {
          return [{ type: 'assistant.text', messageId, delta: update.delta, timestamp: now }];
        }
        if (update.type === 'thinking_delta' && update.delta) {
          return [{ type: 'assistant.reasoning', messageId, delta: update.delta, timestamp: now }];
        }
        if (update.type === 'error') {
          return [{ type: 'error', error: normalizeError(new Error(update.error.errorMessage ?? 'The model request failed.')), timestamp: now }];
        }
        return [];
      }
      case 'message_end': {
        const role = messageRole(event.message);
        if (role === 'tool') return [];
        const id = role === 'assistant' && this.activeAssistantId ? this.activeAssistantId : this.messageId(event.message);
        if (role === 'assistant') this.activeAssistantId = null;
        const normalized: PiEvent = { type: 'message.completed', messageId: id, role, text: messageText(event.message), timestamp: now };
        if (messageError(event.message)) normalized.error = true;
        return [normalized];
      }
      case 'tool_execution_start':
        return [{ type: 'tool.started', toolCallId: event.toolCallId, name: event.toolName, input: safeText(event.args), timestamp: now }];
      case 'tool_execution_update':
        return [{ type: 'tool.updated', toolCallId: event.toolCallId, output: safeText(event.partialResult), timestamp: now }];
      case 'tool_execution_end':
        return [{ type: 'tool.completed', toolCallId: event.toolCallId, name: event.toolName, output: safeText(event.result), error: event.isError, timestamp: now }];
      case 'queue_update':
        return [{ type: 'queue.changed', steering: event.steering.length, followUp: event.followUp.length, timestamp: now }];
      case 'compaction_start':
        return [{ type: 'context.compaction', phase: 'started', timestamp: now }];
      case 'compaction_end':
        return [{ type: 'context.compaction', phase: 'completed', aborted: event.aborted, timestamp: now }];
      default:
        return [];
    }
  }

  messageId(message: unknown): string {
    if (message && typeof message === 'object') {
      const existing = this.messageIds.get(message);
      if (existing) return existing;
      const created = `message-${++this.sequence}`;
      this.messageIds.set(message, created);
      return created;
    }
    return `message-${++this.sequence}`;
  }
}
