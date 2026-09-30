import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { readAgentSessionPreset, SAVED_AGENT_SESSION_TYPE } from './AgentSessionPreset';
import type { SavedAgentSession } from '../../shared/contracts/agents';

const OWNER_TYPE = 'fate-agent-home-v1';
const homeOwnerSchema = z.object({ agentId: z.string().uuid(), revision: z.number().int().positive().safe(), instructions: z.string().max(65_536), projectPath: z.string().min(1) }).passthrough();
export interface HomeOwner { agentId: string; revision: number; instructions: string; projectPath: string; preset?: SavedAgentSession }
export interface HomeOpenOptions { enabled: boolean; deleted: boolean; requireExisting?: boolean | undefined; requirePreset?: boolean | undefined }

// Owner and preset entries are small; conversation lines are not. Read the
// entire JSONL for duplicate ownership, but retain only bounded metadata.
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_METADATA_LINE_BYTES = 1024 * 1024;
const MAX_FIELD_BYTES = 512;
const ambiguousHome = () => new Error('Unsafe or ambiguous home session. Recover manually.');

/** Extract only top-level type/customType from a giant, unrelated JSONL line.
 * In particular, a customType after a giant payload must not hide a second
 * owner. The full metadata entry must fit the bounded JSON parser below. */
class OversizedHomeLine {
  private readonly decoder = new StringDecoder('utf8');
  private depth = 0;
  private started = false;
  private closed = false;
  private inString = false;
  private escaped = false;
  private capture: 'key' | 'value' | null = null;
  private captured = '';
  private overflow = false;
  private key: string | null = null;
  private expectingKey = false;
  private awaitingValue = false;
  private seenType = false;
  private seenCustomType = false;
  private entryType: string | undefined;
  private customType: string | undefined;
  private invalid = false;

  write(bytes: Buffer): void { this.consume(this.decoder.write(bytes)); }

  finish(): { type: string; customType?: string } {
    this.consume(this.decoder.end());
    if (this.invalid || !this.closed || this.inString || this.depth !== 0 || !this.entryType) throw ambiguousHome();
    return { type: this.entryType, ...(this.customType === undefined ? {} : { customType: this.customType }) };
  }

  private completeString(): void {
    if (this.capture) {
      if (this.overflow) {
        if (this.capture === 'value') this.invalid = true;
      } else {
        try {
          const value: string = JSON.parse(`"${this.captured}"`) as string;
          if (this.capture === 'key') this.key = value;
          else if (this.key === 'type') {
            if (this.seenType) this.invalid = true;
            this.seenType = true;
            this.entryType = value;
          } else if (this.key === 'customType') {
            if (this.seenCustomType) this.invalid = true;
            this.seenCustomType = true;
            this.customType = value;
          }
        } catch { this.invalid = true; }
      }
    }
    this.capture = null;
    this.captured = '';
    this.overflow = false;
  }

  private consume(text: string): void {
    for (const char of text) {
      if (this.invalid) return;
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (char === '\\') this.escaped = true;
        else if (char === '"') { this.inString = false; this.completeString(); continue; }
        if (this.capture && !this.overflow) {
          if (this.captured.length < MAX_FIELD_BYTES) this.captured += char;
          else this.overflow = true;
        }
        continue;
      }
      if (/\s/u.test(char)) continue;
      if (this.closed) { this.invalid = true; return; }
      if (!this.started) {
        if (char !== '{') { this.invalid = true; return; }
        this.started = true;
        this.depth = 1;
        this.expectingKey = true;
        continue;
      }
      if (this.depth === 1 && this.awaitingValue && (this.key === 'type' || this.key === 'customType') && char !== '"') {
        this.invalid = true;
        return;
      }
      if (char === '"') {
        this.inString = true;
        this.capture = this.depth === 1 && this.expectingKey ? 'key'
          : this.depth === 1 && this.awaitingValue && (this.key === 'type' || this.key === 'customType') ? 'value' : null;
        if (this.depth === 1) { this.expectingKey = false; this.awaitingValue = false; }
      } else if (char === '{' || char === '[') {
        if (this.depth === 1) this.awaitingValue = false;
        this.depth += 1;
      } else if (char === '}' || char === ']') {
        this.depth -= 1;
        if (this.depth < 0) this.invalid = true;
        if (this.depth === 0) this.closed = true;
      } else if (this.depth === 1 && char === ':' && this.key !== null) this.awaitingValue = true;
      else if (this.depth === 1 && char === ',') {
        this.key = null;
        this.awaitingValue = false;
        this.expectingKey = true;
      } else if (this.depth === 1 && this.awaitingValue) this.awaitingValue = false;
    }
  }
}

async function readHomeMetadata(file: string, expected: Awaited<ReturnType<typeof fs.lstat>>): Promise<{ sessionId: string; owner: unknown; presetEntries: readonly unknown[] }> {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size === 0 || !Number.isSafeInteger(stat.size)
      || stat.dev !== expected.dev || stat.ino !== expected.ino || stat.size !== expected.size) throw ambiguousHome();
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let sessionId: string | null = null;
    let owner: unknown;
    let ownerCount = 0;
    const presetEntries: unknown[] = [];
    let parts: Buffer[] = [];
    let lineBytes = 0;
    let oversized: OversizedHomeLine | null = null;
    const acceptLine = () => {
      if (oversized) {
        const entry = oversized.finish();
        if (!sessionId || entry.type === 'custom' && (entry.customType === OWNER_TYPE || entry.customType === SAVED_AGENT_SESSION_TYPE)) throw ambiguousHome();
      } else if (lineBytes > 0) {
        let entry: unknown;
        try { entry = JSON.parse(Buffer.concat(parts, lineBytes).toString('utf8')) as unknown; }
        catch { return; } // Match the SDK: malformed JSONL lines are skipped.
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw ambiguousHome();
        const value = entry as Record<string, unknown>;
        if (!sessionId) {
          if (value.type !== 'session' || typeof value.id !== 'string' || !value.id) throw ambiguousHome();
          sessionId = value.id;
        } else if (value.type === 'custom' && value.customType === OWNER_TYPE) {
          ownerCount += 1;
          if (ownerCount !== 1) throw new Error('Ambiguous home ownership.');
          owner = value.data;
        } else if (value.type === 'custom' && value.customType === SAVED_AGENT_SESSION_TYPE) {
          // Preserve the preset reader's duplicate and schema checks when required.
          presetEntries.push(value);
          if (presetEntries.length > 1) throw new Error('Saved Agent session has ambiguous ownership.');
        }
      }
    };
    const append = (bytes: Buffer) => {
      lineBytes += bytes.length;
      if (oversized) oversized.write(bytes);
      else if (lineBytes <= MAX_METADATA_LINE_BYTES) parts.push(Buffer.from(bytes));
      else {
        oversized = new OversizedHomeLine();
        for (const part of parts) oversized.write(part);
        oversized.write(bytes);
        parts = [];
      }
    };
    for (let position = 0; position < stat.size;) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (bytesRead === 0) throw ambiguousHome();
      let start = 0;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] !== 10) continue;
        if (index > start) append(buffer.subarray(start, index));
        acceptLine();
        parts = [];
        lineBytes = 0;
        oversized = null;
        start = index + 1;
      }
      if (start < bytesRead) append(buffer.subarray(start, bytesRead));
      position += bytesRead;
    }
    if (lineBytes > 0) acceptLine();
    const after = await handle.stat();
    const current = await fs.lstat(file);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
      || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1
      || current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size
      || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) throw ambiguousHome();
    if (!sessionId || ownerCount !== 1) throw new Error('Ambiguous home ownership.');
    return { sessionId, owner, presetEntries };
  } finally { await handle.close(); }
}

/** Initializes durable ownership through the supported SDK empty-file open path. */
export class HomeOwnership {
  constructor(private readonly directory: string) {}

  async open(owner: HomeOwner, lifecycle: HomeOpenOptions = { enabled: true, deleted: false }, sessionKey = owner.agentId): Promise<{ sessionId: string; file: string; appliedRevision: number }> {
    if (!lifecycle.enabled || lifecycle.deleted) throw new Error('Disabled or deleted Agents cannot open or run a home; the saved conversation is retained.');
    const parsedSessionKey = z.string().uuid().safeParse(sessionKey);
    if (!parsedSessionKey.success) throw new Error('Invalid home owner.');
    const projectPath = await fs.realpath(owner.projectPath);
    const ownerRecord = homeOwnerSchema.parse({ agentId: owner.agentId, revision: owner.revision, instructions: owner.instructions, projectPath });
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const root = await fs.realpath(this.directory);
    if ((await fs.lstat(this.directory)).isSymbolicLink()) throw new Error('Linked home storage is not allowed.');
    const file = path.join(root, `${sessionKey}.jsonl`);
    const lock = `${file}.lock`;
    const lockOwner = await this.acquireLock(lock);
    let temp: string | null = null;
    try {
      const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size === 0)) throw ambiguousHome();
      if (!stat && lifecycle.requireExisting) throw new Error('The retained home session is missing. Restore it from backup; ownership was not silently reassigned.');
      if (!stat) {
        temp = path.join(root, `${randomUUID()}.tmp`);
        const empty = await fs.open(temp, 'wx', 0o600);
        await empty.close();
        const manager = SessionManager.open(temp, root, projectPath);
        manager.appendCustomEntry(OWNER_TYPE, ownerRecord);
        if (owner.preset) {
          manager.appendCustomEntry(SAVED_AGENT_SESSION_TYPE, owner.preset);
          manager.appendSessionInfo(owner.preset.name);
          if (owner.preset.defaults.model) manager.appendModelChange(owner.preset.defaults.model.provider, owner.preset.defaults.model.id);
          manager.appendThinkingLevelChange(owner.preset.defaults.thinkingLevel);
        }
        const durable = await fs.open(temp, 'r+');
        try { await durable.sync(); } finally { await durable.close(); }
        await fs.rename(temp, file);
      }
      const metadata = await readHomeMetadata(file, stat ?? await fs.lstat(file));
      const saved = homeOwnerSchema.parse(metadata.owner);
      if (saved.agentId !== ownerRecord.agentId || saved.projectPath !== projectPath) throw new Error('Home belongs to another Agent or project.');
      if (lifecycle.requirePreset === true || (lifecycle.requirePreset !== false && owner.preset !== undefined)) {
        const preset = readAgentSessionPreset({ getEntries: () => metadata.presetEntries });
        if (!preset) throw new Error('Saved Agent session is missing or corrupt. Restore it from backup; ownership was not silently reassigned.');
        if (preset.agentId !== owner.agentId || preset.projectPath !== projectPath) throw new Error('Saved Agent session belongs to another Agent or project.');
      }
      // Rename/default/instruction edits never rewrite a historical home snapshot.
      return { sessionId: metadata.sessionId, file, appliedRevision: saved.revision };
    } finally {
      await lockOwner.handle.close();
      if (await fs.readFile(lock, 'utf8').catch(() => null) === lockOwner.owner) await fs.unlink(lock).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      if (temp) await fs.unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  private async acquireLock(lock: string): Promise<{ handle: Awaited<ReturnType<typeof fs.open>>; owner: string }> {
    const ownerRecord = JSON.stringify({ token: randomUUID(), pid: process.pid, host: os.hostname() });
    try {
      const handle = await fs.open(lock, 'wx', 0o600);
      try {
        await handle.writeFile(ownerRecord);
        await handle.sync();
        return { handle, owner: ownerRecord };
      } catch (error) {
        await handle.close().catch(() => undefined);
        await fs.unlink(lock).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const lockStat = await fs.lstat(lock).catch((statError: unknown) => { if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return null; throw statError; });
      if (!lockStat || !lockStat.isFile() || lockStat.isSymbolicLink() || lockStat.nlink !== 1) throw new Error('Unsafe home lock. Recover manually without following linked storage.');
      const source = await fs.readFile(lock, 'utf8');
      let owner: { pid?: unknown; host?: unknown; token?: unknown };
      try { owner = JSON.parse(source) as { pid?: unknown; host?: unknown; token?: unknown }; }
      catch { throw new Error('Unsafe home lock. Recover manually after confirming the writer is stopped.'); }
      if (owner?.host === os.hostname() && typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); }
        catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === 'ESRCH') {
            // A crash between lock acquisition and release leaves this owner
            // record behind. A proven-dead writer on this host cannot still be
            // inside the critical section, so one recovery attempt is safe; a
            // changed lock during recovery means another writer won the race.
            if (await fs.readFile(lock, 'utf8').catch(() => null) === source) {
              await fs.unlink(lock);
              return this.acquireLock(lock);
            }
          }
        }
      }
      throw new Error('An Agent home operation is already in progress or was interrupted without recovery. Stop other Fate UI windows for this project, then retry; if it persists, remove only the matching .lock file after confirming no writer is active.');
    }
  }
}
