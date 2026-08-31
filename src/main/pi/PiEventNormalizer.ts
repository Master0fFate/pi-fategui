import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { subagentToolDetailsSchema, type RuntimeImage, type SubagentChildEvent } from '../../shared/contracts/ipc';
import type { ToolActor, ToolProvenance } from '../../shared/contracts/provenance';
import { normalizeError } from './errors';
import { createToolProvenance } from './ToolProvenance';
import { modelSafeUrl } from './BrowserAnnotationContext';

const MAX_SERIALIZED_LENGTH = 64_000;
const MAX_DELTA_LENGTH = 32_000;
const MAX_DELTA_TOTAL_LENGTH = 1_024_000;
const MAX_MESSAGE_CONTENT_BLOCKS = 1_000;
const MAX_SERIALIZATION_NODES = 2_000;
const MAX_SERIALIZATION_DEPTH = 8;
const MAX_TOTAL_IMAGE_CHARACTERS = 20_000_000;
const supportedImageMimeTypes = new Set<RuntimeImage['mimeType']>(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function timestamp(): number {
  return Date.now();
}

function boundedSerializable(value: unknown, state: { nodes: number; characters: number; seen: WeakSet<object> }, depth: number): unknown {
  if (typeof value === 'string') {
    const available = Math.max(0, MAX_SERIALIZED_LENGTH * 2 - state.characters);
    const result = value.slice(0, available);
    state.characters += result.length;
    return result;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_SERIALIZATION_DEPTH || state.nodes >= MAX_SERIALIZATION_NODES || state.seen.has(value)) return '[truncated]';
  state.nodes += 1;
  state.seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => boundedSerializable(item, state, depth + 1));
  }
  const result: Record<string, unknown> = {};
  let inspected = 0;
  for (const key in value as Record<string, unknown>) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    try {
      result[key] = boundedSerializable((value as Record<string, unknown>)[key], state, depth + 1);
    } catch {
      result[key] = '[unavailable]';
    }
    inspected += 1;
    if (inspected >= 200) break;
  }
  return result;
}

export function safeText(value: unknown, maximum = MAX_SERIALIZED_LENGTH): string {
  let result: string;
  if (typeof value === 'string') result = value;
  else {
    try {
      const bounded = boundedSerializable(value, { nodes: 0, characters: 0, seen: new WeakSet() }, 0);
      result = JSON.stringify(bounded) ?? String(bounded);
    } catch {
      result = String(value);
    }
  }
  if (result.length <= maximum) return result;
  const marker = '\n… output truncated by Pi Desktop';
  if (maximum <= marker.length) return result.slice(0, maximum);
  return `${result.slice(0, maximum - marker.length)}${marker}`;
}

export function safeToolInput(toolName: string, value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return safeText(value);
  const input = value as Record<string, unknown>;
  if (toolName === 'browser_type') {
    const text = typeof input.text === 'string' ? input.text : '';
    return safeText({ ...input, text: `[redacted browser input${text ? ` · ${text.length} characters` : ''}]` });
  }
  if (toolName === 'browser_navigate' && typeof input.url === 'string') {
    return safeText({ ...input, url: modelSafeUrl(input.url) });
  }
  return safeText(value);
}

export function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const candidate = message as { content?: unknown; errorMessage?: unknown };
  if (typeof candidate.content === 'string') return candidate.content.slice(0, MAX_SERIALIZED_LENGTH);
  if (!Array.isArray(candidate.content)) return typeof candidate.errorMessage === 'string' ? candidate.errorMessage.slice(0, MAX_SERIALIZED_LENGTH) : '';
  let text = '';
  for (let index = 0; index < Math.min(candidate.content.length, MAX_MESSAGE_CONTENT_BLOCKS); index += 1) {
    const part = candidate.content[index];
    if (!part || typeof part !== 'object') continue;
    const block = part as { type?: string; text?: unknown };
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    text += block.text.slice(0, MAX_SERIALIZED_LENGTH - text.length);
    if (text.length >= MAX_SERIALIZED_LENGTH) break;
  }
  return text || (typeof candidate.errorMessage === 'string' ? candidate.errorMessage.slice(0, MAX_SERIALIZED_LENGTH) : '');
}

function deltaEvents(type: 'assistant.text' | 'assistant.reasoning', messageId: string, delta: string, now: number): SubagentChildEvent[] {
  const events: SubagentChildEvent[] = [];
  const boundedDelta = delta.slice(0, MAX_DELTA_TOTAL_LENGTH);
  for (let offset = 0; offset < boundedDelta.length; offset += MAX_DELTA_LENGTH) {
    events.push({ type, messageId, delta: boundedDelta.slice(offset, offset + MAX_DELTA_LENGTH), timestamp: now });
  }
  return events;
}

export function messageImages(message: unknown, altPrefix = 'Generated image'): RuntimeImage[] {
  if (!message || typeof message !== 'object') return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const images: RuntimeImage[] = [];
  let totalCharacters = 0;
  for (let index = 0; index < Math.min(content.length, MAX_MESSAGE_CONTENT_BLOCKS); index += 1) {
    const part = content[index];
    if (!part || typeof part !== 'object') continue;
    const block = part as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (block.type !== 'image' || typeof block.data !== 'string' || block.data.length === 0 || block.data.length > MAX_TOTAL_IMAGE_CHARACTERS) continue;
    if (typeof block.mimeType !== 'string' || !supportedImageMimeTypes.has(block.mimeType as RuntimeImage['mimeType'])) continue;
    if (totalCharacters + block.data.length > MAX_TOTAL_IMAGE_CHARACTERS) break;
    images.push({ data: block.data, mimeType: block.mimeType as RuntimeImage['mimeType'], alt: `${altPrefix} ${images.length + 1}` });
    totalCharacters += block.data.length;
    if (images.length === 8) break;
  }
  return images;
}

function toolImageAlt(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return undefined;
  const alt = (details as { alt?: unknown }).alt;
  if (typeof alt !== 'string') return undefined;
  return alt.slice(0, 200).trim() || undefined;
}

function messageRole(message: unknown): 'user' | 'assistant' | 'system' | 'tool' | 'hidden' {
  if (!message || typeof message !== 'object') return 'hidden';
  const value = message as { role?: unknown; display?: unknown; customType?: unknown };
  if (value.role === 'user' || value.role === 'assistant') return value.role;
  if (value.role === 'custom') {
    if (value.customType === 'fate-live-agent-reply') return 'system';
    if (value.customType === 'fate-subagent-notification') return 'hidden';
    return value.display === true ? 'system' : 'hidden';
  }
  return value.role === 'toolResult' ? 'tool' : 'hidden';
}

function messageError(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const value = message as { stopReason?: unknown; isError?: unknown };
  return value.isError === true || value.stopReason === 'error';
}

export function subagentRunIds(value: unknown): string[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const details = (value as { details?: unknown }).details;
  const parsed = subagentToolDetailsSchema.safeParse(details);
  if (parsed.success && parsed.data.runIds.length > 0) return parsed.data.runIds;
  if (!details || typeof details !== 'object') return undefined;
  const workflow = details as { kind?: unknown; version?: unknown; runIds?: unknown };
  if (workflow.kind !== 'fate-subagent-workflow' || workflow.version !== 1 || !Array.isArray(workflow.runIds)) return undefined;
  const runIds = workflow.runIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 100);
  return runIds.length === workflow.runIds.length && runIds.length > 0 ? runIds : undefined;
}

export class PiEventNormalizer {
  private readonly messageIds = new WeakMap<object, string>();
  private sequence = 0;
  private activeAssistantId: string | null = null;
  /** Kept through post-run retry, compaction, and queue draining until Pi settles. */
  private settlementRunId: string | null = null;
  private settlementAborted = false;
  private readonly toolProvenance = new Map<string, ToolProvenance>();

  constructor(
    private readonly runId: () => string | null,
    private readonly idPrefix = '',
    private readonly actor: () => ToolActor = () => ({ kind: 'root' }),
  ) {}

  resetSession(): void {
    this.activeAssistantId = null;
    this.settlementRunId = null;
    this.settlementAborted = false;
    this.toolProvenance.clear();
  }

  currentAssistantMessageId(): string | null {
    return this.activeAssistantId;
  }

  normalize(event: AgentSessionEvent): SubagentChildEvent[] {
    const now = timestamp();
    switch (event.type) {
      case 'agent_start': {
        const runId = this.runId();
        if (!runId) return [];
        this.settlementRunId = runId;
        this.settlementAborted = false;
        return [{ type: 'run.started', runId, timestamp: now }];
      }
      case 'agent_end': {
        const runId = this.settlementRunId ?? this.runId();
        if (!runId) return [];
        this.settlementRunId = runId;
        const last = event.messages.at(-1) as { stopReason?: string } | undefined;
        this.settlementAborted = last?.stopReason === 'aborted';
        return [];
      }
      case 'agent_settled': {
        const runId = this.settlementRunId ?? this.runId();
        const aborted = this.settlementAborted;
        this.settlementRunId = null;
        this.settlementAborted = false;
        return runId ? [{ type: 'run.completed', runId, aborted, timestamp: now }] : [];
      }
      case 'message_start': {
        const role = messageRole(event.message);
        if (role === 'tool' || role === 'hidden') return [];
        const id = this.messageId(event.message);
        if (role === 'assistant') this.activeAssistantId = id;
        return [{ type: 'message.started', messageId: id, role, timestamp: now }];
      }
      case 'message_update': {
        const update = event.assistantMessageEvent;
        const messageId = this.activeAssistantId ?? this.messageId(event.message);
        if (update.type === 'text_delta' && update.delta) {
          return deltaEvents('assistant.text', messageId, update.delta, now);
        }
        if (update.type === 'thinking_delta' && update.delta) {
          return deltaEvents('assistant.reasoning', messageId, update.delta, now);
        }
        if (update.type === 'error') {
          return [{ type: 'error', error: normalizeError(new Error(update.error.errorMessage ?? 'The model request failed.')), timestamp: now }];
        }
        return [];
      }
      case 'message_end': {
        const role = messageRole(event.message);
        if (role === 'tool' || role === 'hidden') return [];
        const id = role === 'assistant' && this.activeAssistantId ? this.activeAssistantId : this.messageId(event.message);
        if (role === 'assistant') {
          if (event.message && typeof event.message === 'object') this.messageIds.set(event.message, id);
          this.activeAssistantId = null;
        }
        const images = messageImages(event.message, role === 'user' ? 'Attached image' : 'Generated image');
        const normalized: SubagentChildEvent = {
          type: 'message.completed',
          messageId: id,
          role,
          text: safeText(messageText(event.message)),
          ...(images.length ? { images } : {}),
          timestamp: now,
        };
        if (messageError(event.message)) normalized.error = true;
        return [normalized];
      }
      case 'tool_execution_start': {
        const toolCallId = this.toolId(event.toolCallId);
        const provenance = createToolProvenance(event.toolName, event.args, this.actor());
        if (provenance) {
          this.toolProvenance.set(toolCallId, provenance);
          while (this.toolProvenance.size > 256) {
            const oldest = this.toolProvenance.keys().next().value as string | undefined;
            if (!oldest) break;
            this.toolProvenance.delete(oldest);
          }
        } else this.toolProvenance.delete(toolCallId);
        return [{
          type: 'tool.started',
          toolCallId,
          name: event.toolName,
          input: safeToolInput(event.toolName, event.args),
          ...(provenance ? { provenance } : {}),
          timestamp: now,
        }];
      }
      case 'tool_execution_update': {
        const toolCallId = this.toolId(event.toolCallId);
        const runIds = subagentRunIds(event.partialResult);
        const provenance = this.toolProvenance.get(toolCallId);
        return [{
          type: 'tool.updated',
          toolCallId,
          output: safeText(event.partialResult),
          ...(runIds ? { subagentRunIds: runIds } : {}),
          ...(provenance ? { provenance } : {}),
          timestamp: now,
        }];
      }
      case 'tool_execution_end': {
        const toolCallId = this.toolId(event.toolCallId);
        const explicitImageAlt = toolImageAlt(event.result);
        const images = messageImages(event.result, explicitImageAlt ?? 'Generated image');
        if (explicitImageAlt && images.length === 1) images[0]!.alt = explicitImageAlt;
        const text = messageText(event.result);
        const runIds = subagentRunIds(event.result);
        const provenance = this.toolProvenance.get(toolCallId);
        this.toolProvenance.delete(toolCallId);
        return [{
          type: 'tool.completed',
          toolCallId,
          name: event.toolName,
          output: text ? safeText(text) : (images.length ? '' : safeText(event.result)),
          ...(images.length ? { images } : {}),
          ...(runIds ? { subagentRunIds: runIds } : {}),
          ...(provenance ? { provenance } : {}),
          error: event.isError,
          timestamp: now,
        }];
      }
      case 'queue_update':
        return [{ type: 'queue.changed', steering: event.steering.length, followUp: event.followUp.length, timestamp: now }];
      case 'compaction_start':
        return [{ type: 'context.compaction', phase: 'started', timestamp: now }];
      case 'compaction_end':
        if (event.errorMessage) return [{ type: 'context.compaction', phase: 'failed', error: normalizeError(event.errorMessage), timestamp: now }];
        return [{ type: 'context.compaction', phase: 'completed', aborted: event.aborted, timestamp: now }];
      default:
        return [];
    }
  }

  messageId(message: unknown): string {
    if (message && typeof message === 'object') {
      const existing = this.messageIds.get(message);
      if (existing) return existing;
      const created = `${this.idPrefix}message-${++this.sequence}`;
      this.messageIds.set(message, created);
      return created;
    }
    return `${this.idPrefix}message-${++this.sequence}`;
  }

  private toolId(toolCallId: string): string {
    return `${this.idPrefix}${toolCallId}`;
  }
}
