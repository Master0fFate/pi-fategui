import { open, type FileHandle } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { sessionProjectMatches } from './SessionProjectIdentity';

export type SnapshotRecord = Record<string, unknown>;

/** Limits retained data, not the size of the saved file. In particular, a huge
 * individual JSONL line must never become a huge readline/string buffer. */
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_PARSED_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_RETAINED_HISTORY_BYTES = 24 * 1024 * 1024;
const MAX_RETAINED_CHILD_STATE_BYTES = 16 * 1024 * 1024;
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 200_000;
const MAX_HISTORY_ENTRIES = 4_999;
const MAX_ID_LENGTH = 1_024;
const MAX_SCALAR_LENGTH = 4_096;
const MAX_EXTENSION_DATA_BYTES = 128 * 1024;
const MAX_RETAINED_EXTENSION_BYTES = 4 * 1024 * 1024;
const types = new Set(['message', 'thinking_level_change', 'model_change', 'usage', 'compaction', 'branch_summary', 'custom', 'custom_message', 'context_edit', 'label', 'session_info']);
const scalarFields = new Set(['type', 'id', 'parentId', 'timestamp', 'provider', 'modelId', 'thinkingLevel', 'name', 'customType', 'display', 'firstKeptEntryId', 'fromId', 'targetId']);

export class SessionSnapshotLimitError extends Error {
  constructor(reason: string) {
    super(`The saved session ${reason} and cannot be previewed safely.`);
  }
}

function record(value: unknown): value is SnapshotRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validEntry(value: SnapshotRecord): boolean {
  return typeof value.type === 'string' && types.has(value.type)
    && typeof value.id === 'string' && value.id.length > 0
    && (typeof value.parentId === 'string' || value.parentId === null);
}

function boundedString(value: unknown, length = MAX_SCALAR_LENGTH): string | undefined {
  return typeof value === 'string' ? value.slice(0, length) : undefined;
}

/** Validate the skipped payload so a malformed giant line cannot become a fake active leaf. */
class JsonLineValidator {
  private readonly stack: Array<{ kind: 'object' | 'array'; state: 'key-or-end' | 'key' | 'colon' | 'value-or-end' | 'value' | 'comma-or-end' }> = [];
  private root: 'value' | 'done' = 'value';
  private token: 'string' | 'number' | 'literal' | null = null;
  private keyString = false;
  private escaped = false;
  private unicodeDigits = 0;
  private numberState: 'minus' | 'zero' | 'integer' | 'fraction-start' | 'fraction' | 'exponent-start' | 'exponent-sign' | 'exponent' = 'minus';
  private literal = '';
  private literalIndex = 0;
  private invalid = false;

  write(text: string): void {
    for (let index = 0; index < text.length && !this.invalid; index += 1) {
      const char = text[index]!;
      if (this.token === 'string') {
        if (this.unicodeDigits > 0) {
          if (!/[0-9a-f]/iu.test(char)) this.invalid = true;
          else this.unicodeDigits -= 1;
        } else if (this.escaped) {
          if (char === 'u') this.unicodeDigits = 4;
          else if (!'"\\/bfnrt'.includes(char)) this.invalid = true;
          this.escaped = false;
        } else if (char === '\\') this.escaped = true;
        else if (char === '"') {
          this.token = null;
          if (this.keyString) {
            const top = this.stack.at(-1);
            if (!top || top.kind !== 'object') this.invalid = true;
            else top.state = 'colon';
          } else this.completeValue();
        } else if (char.charCodeAt(0) < 32) this.invalid = true;
        continue;
      }
      if (this.token === 'literal') {
        if (char !== this.literal[this.literalIndex]) this.invalid = true;
        else if (++this.literalIndex === this.literal.length) { this.token = null; this.completeValue(); }
        continue;
      }
      if (this.token === 'number') {
        if (this.numberState === 'minus') {
          if (char === '0') this.numberState = 'zero';
          else if (/[1-9]/u.test(char)) this.numberState = 'integer';
          else this.invalid = true;
        } else if (this.numberState === 'fraction-start' || this.numberState === 'exponent-sign' || this.numberState === 'exponent-start') {
          if (this.numberState === 'exponent-start' && (char === '+' || char === '-')) this.numberState = 'exponent-sign';
          else if (/[0-9]/u.test(char)) this.numberState = this.numberState === 'fraction-start' ? 'fraction' : 'exponent';
          else this.invalid = true;
        } else if (/[0-9]/u.test(char) && this.numberState !== 'zero') {
          // An integer, fraction or exponent can continue with digits.
        } else if (char === '.' && (this.numberState === 'zero' || this.numberState === 'integer')) this.numberState = 'fraction-start';
        else if ((char === 'e' || char === 'E') && ['zero', 'integer', 'fraction'].includes(this.numberState)) this.numberState = 'exponent-start';
        else { this.token = null; this.completeValue(); index -= 1; }
        continue;
      }
      if (char === ' ' || char === '\t' || char === '\r' || char === '\n') continue;
      const top = this.stack.at(-1);
      const state = top?.state ?? this.root;
      if (state === 'key-or-end' || state === 'key') {
        if (char === '"') { this.token = 'string'; this.keyString = true; }
        else if (char === '}' && state === 'key-or-end') { this.stack.pop(); this.completeValue(); }
        else this.invalid = true;
      } else if (state === 'colon') {
        if (char !== ':' || !top) this.invalid = true;
        else top.state = 'value';
      } else if (state === 'value-or-end' && char === ']') { this.stack.pop(); this.completeValue(); }
      else if (state === 'value' || state === 'value-or-end') this.startValue(char);
      else if (state === 'comma-or-end') {
        if (char === ',') {
          if (top) top.state = top.kind === 'object' ? 'key' : 'value';
          else this.invalid = true;
        } else if (top && char === (top.kind === 'object' ? '}' : ']')) { this.stack.pop(); this.completeValue(); }
        else this.invalid = true;
      } else this.invalid = true;
    }
  }

  valid(): boolean {
    if (this.token === 'number' && ['zero', 'integer', 'fraction', 'exponent'].includes(this.numberState)) {
      this.token = null;
      this.completeValue();
    }
    return !this.invalid && this.token === null && this.stack.length === 0 && this.root === 'done';
  }

  private startValue(char: string): void {
    if (char === '{' || char === '[') {
      if (this.stack.length >= 512) { this.invalid = true; return; }
      this.stack.push({ kind: char === '{' ? 'object' : 'array', state: char === '{' ? 'key-or-end' : 'value-or-end' });
    } else if (char === '"') { this.token = 'string'; this.keyString = false; }
    else if (char === 't' || char === 'f' || char === 'n') {
      this.token = 'literal';
      this.literal = char === 't' ? 'true' : char === 'f' ? 'false' : 'null';
      this.literalIndex = 1;
    } else if (char === '-') { this.token = 'number'; this.numberState = 'minus'; }
    else if (char === '0') { this.token = 'number'; this.numberState = 'zero'; }
    else if (/[1-9]/u.test(char)) { this.token = 'number'; this.numberState = 'integer'; }
    else this.invalid = true;
  }

  private completeValue(): void {
    const top = this.stack.at(-1);
    if (top) {
      if (top.state !== 'value' && top.state !== 'value-or-end') this.invalid = true;
      else top.state = 'comma-or-end';
    } else if (this.root !== 'value') this.invalid = true;
    else this.root = 'done';
  }
}

/**
 * For a single record above the parse budget, scan incrementally without
 * retaining its payload. Capture tree fields even AFTER a giant content field;
 * a visible omission stands in for content that cannot fit the preview.
 */
export class OversizedRecordFields {
  private readonly decoder = new StringDecoder('utf8');
  private readonly validator = new JsonLineValidator();
  private fields: SnapshotRecord = {};
  private readonly seenRoutingFields = new Set<string>();
  private ambiguousRouting = false;
  private depth = 0;
  private insideString = false;
  private escaped = false;
  private capture: 'key' | 'value' | 'message-key' | 'message-value' | null = null;
  private captured = '';
  private captureOverflow = false;
  private key: string | null = null;
  private messageKey: string | null = null;
  private awaitingValue = false;
  private awaitingMessageValue = false;
  private expectingKey = false;
  private expectingMessageKey = false;
  private messageDepth = 0;
  private firstCharacter = '';
  private lastCharacter = '';
  private nullParent = '';
  private displayLiteral = '';

  write(bytes: Buffer): void {
    this.consume(this.decoder.write(bytes));
  }

  finish(): SnapshotRecord | null {
    this.consume(this.decoder.end());
    if (this.ambiguousRouting || this.firstCharacter !== '{' || this.lastCharacter !== '}' || this.depth !== 0 || this.insideString || !this.validator.valid()) return null;
    if (this.fields.parentId === undefined && this.nullParent.trim() === 'null') this.fields.parentId = null;
    return this.fields;
  }

  private completeString(): void {
    if (!this.captureOverflow && this.capture) {
      let decoded: string | undefined;
      try { decoded = JSON.parse(`"${this.captured}"`) as string; } catch { /* Invalid oversized record. */ }
      if (decoded !== undefined) {
        if (this.capture === 'key') {
          this.key = decoded;
          // JSON.parse uses the last duplicate value, including null/objects.
          // A metadata-only scan must not retain an earlier string instead.
          if (scalarFields.has(decoded) || decoded === 'message') {
            if (this.seenRoutingFields.has(decoded)) this.ambiguousRouting = true;
            this.seenRoutingFields.add(decoded);
          }
        }
        else if (this.capture === 'message-key') this.messageKey = decoded;
        else if (this.capture === 'value' && this.key && scalarFields.has(this.key)) this.fields[this.key] = decoded;
        else if (this.capture === 'message-value' && this.messageKey === 'role') this.fields.messageRole = decoded;
      }
    }
    this.captured = '';
    this.capture = null;
    this.captureOverflow = false;
  }

  private completeDisplay(): void {
    if (this.key !== 'display' || !this.awaitingValue) return;
    const literal = this.displayLiteral.trim();
    if (literal === 'true' || literal === 'false') this.fields.display = literal === 'true';
    this.displayLiteral = '';
  }

  private consume(text: string): void {
    this.validator.write(text);
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i]!;
      if (!/\s/u.test(char)) {
        if (!this.firstCharacter) this.firstCharacter = char;
        this.lastCharacter = char;
      }
      if (this.insideString) {
        if (this.escaped) this.escaped = false;
        else if (char === '\\') this.escaped = true;
        else if (char === '"') {
          this.insideString = false;
          this.completeString();
          continue;
        }
        if (this.capture && !this.captureOverflow) {
          if (this.captured.length < MAX_SCALAR_LENGTH * 6) this.captured += char;
          else this.captureOverflow = true;
        }
        continue;
      }
      if (char === '"') {
        this.insideString = true;
        this.capture = this.depth === 1 && this.expectingKey ? 'key'
          : this.depth === 1 && this.awaitingValue && this.key && scalarFields.has(this.key) ? 'value'
            : this.depth === this.messageDepth && this.messageDepth > 0 && this.expectingMessageKey ? 'message-key'
              : this.depth === this.messageDepth && this.messageDepth > 0 && this.awaitingMessageValue && this.messageKey === 'role' ? 'message-value'
                : null;
        if (this.depth === 1 && this.expectingKey) this.expectingKey = false;
        else if (this.depth === 1 && this.awaitingValue) this.awaitingValue = false;
        else if (this.depth === this.messageDepth && this.expectingMessageKey) this.expectingMessageKey = false;
        else if (this.depth === this.messageDepth && this.awaitingMessageValue) this.awaitingMessageValue = false;
        continue;
      }
      if (char === '{' || char === '[') {
        if (this.depth === 1 && this.awaitingValue && this.key === 'message' && char === '{') {
          this.messageDepth = 2;
          this.expectingMessageKey = true;
        }
        if (this.depth === 1) this.awaitingValue = false;
        this.depth += 1;
        if (this.depth === 1) this.expectingKey = true;
      } else if (char === '}' || char === ']') {
        if (char === '}' && this.depth === 1) this.completeDisplay();
        if (this.depth === this.messageDepth) this.messageDepth = 0;
        this.depth -= 1;
      } else if (char === ':') {
        if (this.depth === 1 && this.key !== null) this.awaitingValue = true;
        else if (this.depth === this.messageDepth && this.messageKey !== null) this.awaitingMessageValue = true;
      } else if (char === ',') {
        if (this.depth === 1) {
          this.completeDisplay();
          this.key = null;
          this.awaitingValue = false;
          this.expectingKey = true;
        } else if (this.depth === this.messageDepth) {
          this.messageKey = null;
          this.awaitingMessageValue = false;
          this.expectingMessageKey = true;
        }
      } else if (this.depth === 1 && this.key === 'parentId' && this.awaitingValue && this.nullParent.length < 8) {
        this.nullParent += char;
      } else if (this.depth === 1 && this.key === 'display' && this.awaitingValue && this.displayLiteral.length < 8) {
        this.displayLiteral += char;
      }
    }
  }
}

interface IndexedEntry {
  value: SnapshotRecord;
  offset: number;
  byteLength: number;
  /** Latest team/subagent state must survive even when its event is old. */
  childKey?: string;
  childVersion?: number;
}

function childStateKey(entry: SnapshotRecord): { key: string; version: number } | undefined {
  if (entry.type !== 'custom' || !record(entry.data)) return undefined;
  const data = entry.data;
  if (entry.customType === 'fate-agent-team-event') {
    const team = record(data.payload) && record(data.payload.team) ? data.payload.team : null;
    const id = typeof data.teamId === 'string' ? data.teamId : team?.id;
    if (typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH) {
      return { key: `team:${id}`, version: typeof data.sequence === 'number' ? data.sequence : Number.NEGATIVE_INFINITY };
    }
  } else if (entry.customType === 'fate-subagent-run' && record(data.run)) {
    const run = data.run;
    if (typeof run.id === 'string' && run.id.length > 0 && run.id.length <= MAX_ID_LENGTH) {
      return { key: `subagent:${run.id}`, version: typeof run.updatedAt === 'number' ? run.updatedAt : Number.NEGATIVE_INFINITY };
    }
  }
  return undefined;
}

export interface ReadSessionSnapshot {
  entries: SnapshotRecord[];
  branch: SnapshotRecord[];
  /** null means a later session_info explicitly cleared the name. */
  name?: string | null;
  firstMessage?: string;
  messageCount: number;
  lastActivityTime?: number;
  /** Human-readable warning when a valid payload cannot fit the preview budget. */
  previewNotice?: string;
}

function compactEntry(entry: SnapshotRecord, extensionBudget: { remaining: number }): SnapshotRecord {
  const result: SnapshotRecord = {
    type: entry.type,
    id: entry.id,
    parentId: entry.parentId,
    ...(boundedString(entry.timestamp, 100) === undefined ? {} : { timestamp: boundedString(entry.timestamp, 100) }),
  };
  if (entry.type === 'message' && record(entry.message)) {
    const message = entry.message;
    result.message = {
      role: boundedString(message.role, 32) ?? 'custom',
      content: '[Earlier message omitted from preview]',
      ...(typeof message.timestamp === 'number' ? { timestamp: message.timestamp } : {}),
      // A clipped result is still a recorded result. Preserve its identity so
      // hydration cannot mislabel a completed tool call as interrupted.
      ...(boundedString(message.toolCallId, MAX_ID_LENGTH) ? { toolCallId: boundedString(message.toolCallId, MAX_ID_LENGTH) } : {}),
      ...(boundedString(message.toolName, 200) ? { toolName: boundedString(message.toolName, 200) } : {}),
      ...(typeof message.isError === 'boolean' ? { isError: message.isError } : {}),
      ...(boundedString(message.stopReason, 50) ? { stopReason: boundedString(message.stopReason, 50) } : {}),
      ...(record(message.usage) ? { usage: message.usage } : {}),
      ...(boundedString(message.provider, 200) ? { provider: boundedString(message.provider, 200) } : {}),
      ...(boundedString(message.model, 200) ? { model: boundedString(message.model, 200) } : {}),
    };
  } else if (entry.type === 'message') {
    result.message = { role: boundedString(entry.messageRole, 32) ?? 'custom', content: '[Large message omitted from preview]' };
  } else if (entry.type === 'custom_message') {
    result.customType = boundedString(entry.customType, 200);
    result.display = entry.display === true;
    result.content = '[Earlier custom message omitted from preview]';
  } else if (entry.type === 'custom') {
    result.customType = boundedString(entry.customType, 200);
    if (entry.customType === 'fate-saved-agent-v1' && entry.data !== undefined) {
      const encoded = JSON.stringify(entry.data);
      if (encoded && Buffer.byteLength(encoded, 'utf8') <= Math.min(MAX_EXTENSION_DATA_BYTES, extensionBudget.remaining)) {
        result.data = entry.data;
        extensionBudget.remaining -= Buffer.byteLength(encoded, 'utf8');
      }
    }
  } else if (entry.type === 'model_change') {
    result.provider = boundedString(entry.provider, 200);
    result.modelId = boundedString(entry.modelId, 200);
  } else if (entry.type === 'thinking_level_change') {
    result.thinkingLevel = boundedString(entry.thinkingLevel, 50);
  } else if (entry.type === 'session_info') {
    result.name = boundedString(entry.name, 500);
  } else if (entry.type === 'label') {
    result.targetId = boundedString(entry.targetId, MAX_ID_LENGTH);
    result.label = boundedString(entry.label, 500);
  } else if (entry.type === 'compaction' || entry.type === 'branch_summary') {
    result.summary = boundedString(entry.summary, 2_000) ?? '[Earlier summary omitted from preview]';
    if (typeof entry.tokensBefore === 'number') result.tokensBefore = entry.tokensBefore;
    if (typeof entry.fromHook === 'boolean') result.fromHook = entry.fromHook;
    result.firstKeptEntryId = boundedString(entry.firstKeptEntryId, MAX_ID_LENGTH);
    result.fromId = boundedString(entry.fromId, MAX_ID_LENGTH);
    if (record(entry.usage)) result.usage = entry.usage;
  } else if (entry.type === 'usage') {
    if (record(entry.usage)) result.usage = entry.usage;
  } else if (entry.type === 'context_edit') {
    result.targetId = boundedString(entry.targetId, MAX_ID_LENGTH);
  }
  return result;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 2_000);
  if (!Array.isArray(content)) return '';
  for (const part of content) {
    if (record(part) && part.type === 'text' && typeof part.text === 'string') return part.text.slice(0, 2_000);
  }
  return '';
}

async function readRecord(handle: FileHandle, offset: number, byteLength: number): Promise<SnapshotRecord | null> {
  if (byteLength > MAX_PARSED_RECORD_BYTES) return null;
  const buffer = Buffer.allocUnsafe(byteLength);
  let received = 0;
  while (received < byteLength) {
    const { bytesRead } = await handle.read(buffer, received, byteLength - received, offset + received);
    if (bytesRead === 0) return null;
    received += bytesRead;
  }
  try {
    const value: unknown = JSON.parse(buffer.toString('utf8'));
    return record(value) ? value : null;
  } catch { return null; }
}

/** A fixed-size, positional read. No readFile/readline of an unbounded line. */
export async function readSessionSnapshot(filePath: string, sessionId: string, expectedCwd?: string): Promise<ReadSessionSnapshot | undefined> {
  const handle = await open(filePath, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || !Number.isSafeInteger(stats.size)) return undefined;
    // Preserve the former exact snapshot semantics for ordinary files while
    // keeping the same global retention cap. Only large files need projection.
    const retainFullFile = stats.size <= MAX_RETAINED_HISTORY_BYTES;
    const indexed: IndexedEntry[] = [];
    const extensionBudget = { remaining: MAX_RETAINED_EXTENSION_BYTES };
    let indexBytes = 0;
    const header = { value: null as SnapshotRecord | null };
    let name: string | null | undefined;
    let firstMessage: string | undefined;
    let messageCount = 0;
    let lastActivityTime: number | undefined;
    let previewClipped = false;
    let childStateClipped = false;
    let lineStart = 0;
    let lineParts: Buffer[] = [];
    let lineBytes = 0;
    let oversized: OversizedRecordFields | null = null;
    const acceptLine = () => {
      let parsed: SnapshotRecord | null = null;
      if (oversized) parsed = oversized.finish();
      else if (lineBytes > 0) {
        try {
          const value: unknown = JSON.parse(Buffer.concat(lineParts, lineBytes).toString('utf8'));
          if (record(value)) parsed = value;
        } catch { /* Ignore malformed or incomplete JSONL, as Pi does. */ }
      }
      if (parsed) {
        if (!header.value) {
          if (parsed.type !== 'session' || parsed.id !== sessionId
            || expectedCwd !== undefined && !sessionProjectMatches(parsed.cwd, expectedCwd)) return false;
          header.value = parsed;
        } else if (validEntry(parsed)) {
          if ((parsed.id as string).length > MAX_ID_LENGTH || (typeof parsed.parentId === 'string' && parsed.parentId.length > MAX_ID_LENGTH)) {
            throw new SessionSnapshotLimitError('has an entry identifier that exceeds the reader limit');
          }
          if (indexed.length >= MAX_INDEX_ENTRIES) throw new SessionSnapshotLimitError(`has more than ${MAX_INDEX_ENTRIES.toLocaleString()} entries`);
          const value = retainFullFile && !oversized ? parsed : compactEntry(parsed, extensionBudget);
          if (parsed.customType === 'fate-saved-agent-v1' && value.data === undefined) {
            throw new SessionSnapshotLimitError('has saved-agent metadata that exceeds the reader budget');
          }
          indexBytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
          if (indexBytes > MAX_INDEX_BYTES) throw new SessionSnapshotLimitError('has more session metadata than the reader budget');
          const child = childStateKey(parsed);
          indexed.push({ value, offset: lineStart, byteLength: lineBytes,
            ...(child ? { childKey: child.key, childVersion: child.version } : {}),
          });
          if (oversized || (parsed.type === 'custom' && (parsed.customType === 'fate-agent-team-event' || parsed.customType === 'fate-subagent-run') && !child)) {
            previewClipped = true;
            if (parsed.type === 'custom') childStateClipped = true;
          }
          if (value.type === 'session_info') {
            const nextName = typeof value.name === 'string' ? value.name.trim() : '';
            name = nextName || null;
          }
          if (value.type === 'message') {
            messageCount += 1;
            const message = record(parsed.message) ? parsed.message : null;
            if (message?.role === 'user' && !firstMessage) firstMessage = messageText(message.content) || undefined;
            if (message?.role === 'user' || message?.role === 'assistant') {
              const timestamp = typeof message.timestamp === 'number' ? message.timestamp
                : typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : NaN;
              if (Number.isFinite(timestamp) && Math.abs(timestamp) <= 8.64e15) {
                lastActivityTime = Math.max(lastActivityTime ?? Number.NEGATIVE_INFINITY, timestamp);
              }
            }
          }
        }
      }
      return true;
    };
    const append = (chunk: Buffer) => {
      lineBytes += chunk.length;
      if (oversized) oversized.write(chunk);
      else if (lineBytes <= MAX_PARSED_RECORD_BYTES) lineParts.push(Buffer.from(chunk));
      else {
        oversized = new OversizedRecordFields();
        for (const part of lineParts) oversized.write(part);
        oversized.write(chunk);
        lineParts = [];
      }
    };
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    for (let position = 0; position < stats.size;) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stats.size - position), position);
      if (bytesRead === 0) return undefined; // Concurrent truncation: do not invent a complete last entry.
      let start = 0;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] !== 10) continue;
        if (index > start) append(buffer.subarray(start, index));
        if (!acceptLine()) return undefined;
        lineStart = position + index + 1;
        lineParts = [];
        lineBytes = 0;
        oversized = null;
        start = index + 1;
      }
      if (start < bytesRead) append(buffer.subarray(start, bytesRead));
      position += bytesRead;
    }
    if (lineBytes > 0 && !acceptLine()) return undefined;
    if (!header.value || header.value.id !== sessionId) return undefined;

    // Pi's active leaf is the LAST valid entry, not the newest timestamp or
    // the last message. Follow parent IDs, including metadata-only giant nodes.
    const byId = new Map(indexed.map((entry, index) => [entry.value.id as string, index]));
    const branchIndexes: number[] = [];
    const visited = new Set<string>();
    let cursor = indexed.length ? indexed.length - 1 : undefined;
    while (cursor !== undefined) {
      const id = indexed[cursor]!.value.id as string;
      if (visited.has(id)) break;
      visited.add(id);
      branchIndexes.push(cursor);
      const parentId = indexed[cursor]!.value.parentId;
      cursor = typeof parentId === 'string' ? byId.get(parentId) : undefined;
    }
    branchIndexes.reverse();

    // Keep the most recent actual messages on this branch, rather than the
    // last N file records (which could belong to inactive forks). Older
    // entries remain compact so model/thinking/compaction/lineage still work.
    let retainedBytes = 0;
    for (let index = branchIndexes.length - 1, count = 0; !retainFullFile && index >= 0 && count < MAX_HISTORY_ENTRIES; index -= 1) {
      const item = indexed[branchIndexes[index]!]!;
      // Hidden extension snapshots can outweigh the conversation by hundreds
      // of MiB. Their latest required state has its own budget below; they
      // must not consume the visible-message byte or count budget.
      if (item.value.type === 'custom') { previewClipped = true; continue; }
      count += 1;
      if (item.byteLength > MAX_PARSED_RECORD_BYTES || item.byteLength + retainedBytes > MAX_RETAINED_HISTORY_BYTES) { previewClipped = true; continue; }
      const full = await readRecord(handle, item.offset, item.byteLength);
      if (!full || !validEntry(full) || full.id !== item.value.id || full.parentId !== item.value.parentId) { previewClipped = true; continue; }
      item.value = full;
      retainedBytes += item.byteLength;
    }
    if (!retainFullFile && branchIndexes.length > MAX_HISTORY_ENTRIES) previewClipped = true;

    // A 900 MiB session may contain thousands of repeated 300 KiB team
    // snapshots. Recent-history retention alone can silently lose a team that
    // last updated before the tail. Rehydrate only its highest-sequence event
    // (and each subagent's latest run) from its file offset, within a distinct
    // child-state budget. Never keep the duplicated old event bodies.
    const latestChildren = new Map<string, number>();
    const unavailableChildTypes = new Set<string>();
    for (const index of branchIndexes) {
      const item = indexed[index]!;
      if (item.value.type === 'custom' && !item.childKey
        && (item.value.customType === 'fate-agent-team-event' || item.value.customType === 'fate-subagent-run')) {
        unavailableChildTypes.add(item.value.customType);
      }
    }
    for (const item of indexed) {
      if (item.value.type === 'custom' && unavailableChildTypes.has(String(item.value.customType))) {
        // An unreadable latest snapshot can supersede any earlier member of
        // this family. Show no stale running/completed state as authoritative.
        const { data: _omitted, ...metadata } = item.value;
        item.value = metadata;
        childStateClipped = true;
      }
    }
    for (const index of branchIndexes) {
      const item = indexed[index]!;
      if (!item.childKey || unavailableChildTypes.has(String(item.value.customType))) continue;
      const previous = latestChildren.get(item.childKey);
      if (previous === undefined || (indexed[previous]!.childVersion ?? Number.NEGATIVE_INFINITY) <= (item.childVersion ?? Number.NEGATIVE_INFINITY)) {
        latestChildren.set(item.childKey, index);
      }
    }
    let childBytes = 0;
    for (const index of [...latestChildren.values()].sort((left, right) => right - left)) {
      const item = indexed[index]!;
      if (item.value.data !== undefined) continue; // Already in the recent-history budget.
      if (item.byteLength > MAX_PARSED_RECORD_BYTES || item.byteLength + childBytes > MAX_RETAINED_CHILD_STATE_BYTES) {
        childStateClipped = true;
        continue;
      }
      const full = await readRecord(handle, item.offset, item.byteLength);
      if (!full || !validEntry(full) || full.id !== item.value.id || full.parentId !== item.value.parentId) {
        childStateClipped = true;
        continue;
      }
      item.value = full;
      childBytes += item.byteLength;
    }
    return {
      entries: indexed.map((item) => item.value),
      branch: branchIndexes.map((index) => indexed[index]!.value),
      ...(name === undefined ? {} : { name }),
      ...(firstMessage === undefined ? {} : { firstMessage }),
      messageCount,
      ...(lastActivityTime === undefined ? {} : { lastActivityTime }),
      ...(!previewClipped && !childStateClipped ? {} : { previewNotice: childStateClipped
        ? 'Some large child-agent state could not fit in the preview. Saved history was not changed.'
        : 'Older or large records are compact previews. Saved history was not changed.' }),
    };
  } finally {
    await handle.close();
  }
}
