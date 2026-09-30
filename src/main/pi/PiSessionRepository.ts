import { lstat, open, opendir, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  getAgentDir,
  SessionManager,
  type AgentSession,
  type FileEntry,
  type SessionEntry,
  type SessionInfo,
  type SessionTreeNode,
} from '@earendil-works/pi-coding-agent';
import type { SessionBranch, SessionSummary } from '../../shared/contracts/ipc';
import type { SnapshotItem } from '../../shared/protocol/snapshots';
import { messageText } from './PiEventNormalizer';
import { agentTeamSchema, type AgentTeam } from '../../shared/contracts/multiAgent';
import { OversizedRecordFields, readSessionSnapshot, SessionSnapshotLimitError, type SnapshotRecord } from './SessionSnapshotReader';

export interface SessionRepositorySource {
  /** `includeSearchText` is intentionally opt-in: normal sidebar loading must not scan every transcript. */
  list(cwd: string, includeSearchText?: boolean): Promise<SessionInfo[]>;
  rename(path: string, name: string): void;
  remove?(path: string): Promise<void>;
}

export type ColdTeamRead =
  | { state: 'ok'; teams: ReadonlyMap<string, AgentTeam | null> }
  | { state: 'unknown'; reason: 'missing' | 'oversized' | 'partial-tail' | 'corrupt' | 'unavailable' };

export interface SessionSnapshot {
  summary: SessionSummary;
  /** Valid non-header JSONL entries: full for ordinary files, bounded projections for large files. */
  entries: readonly Record<string, unknown>[];
  /** The active root-to-leaf path: recent records are full; older records are projections. */
  branch: readonly Record<string, unknown>[];
  /** Non-destructive clipping notice for the cold UI, if any. */
  previewNotice?: string;
}

const sdkMutationSource: Omit<SessionRepositorySource, 'list'> = {
  rename: (sessionPath, name) => { SessionManager.open(sessionPath).appendSessionInfo(name); },
  remove: (sessionPath) => rm(sessionPath),
};

/**
 * Absolute root that owns every project session directory. The Pi SDK stores
 * each project's sessions one level below this root, in a
 * `--<encoded project path>--` folder it derives deterministically. Every
 * delete must resolve to a direct `.jsonl` child of such a folder; anything
 * else is refused so a deletion can never escape the session store.
 */
export function defaultSessionsRoot(): string {
  return resolve(join(getAgentDir(), 'sessions'));
}

/**
 * Mirrors Pi's default session-directory encoding without calling
 * `SessionManager.create()`, which would create a directory as a side effect.
 * Fate only calls this with an already canonical project path, so `resolve()`
 * has the same shape as Pi's public SessionManager path resolution.
 */
export function projectSessionDirectory(cwd: string, sessionsRoot = defaultSessionsRoot()): string {
  const resolvedCwd = resolve(cwd);
  const encoded = `--${resolvedCwd.replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`;
  return join(resolve(sessionsRoot), encoded);
}

/**
 * True when `sessionPath` is a direct `.jsonl` child of a project session
 * directory that lives directly under `sessionsRoot`. This is the only shape
 * the SDK ever produces for a listed session, and it is verified here so that
 * removal safety never depends on the listing source behaving.
 */
export function isSafeSessionPath(sessionsRoot: string, sessionPath: string): boolean {
  if (!sessionPath || sessionPath.includes('\0')) return false;
  const resolved = resolve(sessionPath);
  const parent = dirname(resolved);
  if (parent === resolved) return false; // a filesystem root
  if (dirname(parent) !== sessionsRoot) return false; // not a project session directory
  const name = basename(resolved);
  if (!name.endsWith('.jsonl')) return false;
  if (name === '.' || name === '..') return false;
  return true;
}

const FALLBACK_TITLE_LIMIT = 58;
const EXPLICIT_TITLE_LIMIT = 120;
const SERIALIZED_TITLE_LIMIT = 200;
const MAX_PROJECTED_BRANCHES = 5_000;
const MAX_BRANCH_NODES_VISITED = 50_000;
const MAX_CACHED_SESSIONS = 5_000;
const MAX_SESSION_SEARCH_TEXT = 64_000;
const MAX_SESSION_SEARCH_CACHE_CHARACTERS = 20_000_000;
const SESSION_CACHE_TTL_MS = 2_000;
const MAX_PROJECT_CACHE_ENTRIES = 4;
const SESSION_BRANCH_REWRITE_RETRIES = 2;
const MAX_SESSION_METADATA_PREFIX_BYTES = 256 * 1024;
const MAX_SESSION_METADATA_TAIL_BYTES = 128 * 1024;
// Legacy export until HomeOwnership no longer conflates preview with resume.
// This is NOT a preview limit: destructive rewrites have a separate, lower cap.
export const MAX_SESSION_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const MAX_SESSION_BRANCH_REWRITE_BYTES = 32 * 1024 * 1024;
const MAX_SESSION_DISCOVERY_CONCURRENCY = 8;
const sessionEntryTypes = new Set(['message', 'thinking_level_change', 'model_change', 'usage', 'compaction', 'branch_summary', 'custom', 'custom_message', 'context_edit', 'label', 'session_info']);
const hiddenHistoryEntryTypes = new Set(['thinking_level_change', 'model_change', 'usage', 'branch_summary', 'custom', 'context_edit', 'label', 'session_info']);
// Keep the record buffer below 128 KiB while the bounded streaming field
// validator is live. The shared 64 KiB read chunk is not retained per record.
const MAX_HISTORY_RECORD_BUFFER_BYTES = 96 * 1024;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonRecord(line: string): JsonRecord | null {
  if (!line.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string') continue;
    text += part.text;
    if (text.length >= MAX_SESSION_SEARCH_TEXT) return text.slice(0, MAX_SESSION_SEARCH_TEXT);
  }
  return text;
}

interface ScannedSessionMetadata {
  header: JsonRecord;
  name?: string;
  firstMessage: string;
  messageCount: number;
  lastActivityTime?: number;
  searchText: string;
}

function absorbSessionEntry(metadata: ScannedSessionMetadata, entry: JsonRecord, includeSearchText: boolean): void {
  if (entry.type === 'session_info') {
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (name) metadata.name = name;
    else delete metadata.name;
    return;
  }
  if (entry.type !== 'message' || !isRecord(entry.message)) return;
  metadata.messageCount += 1;
  const message = entry.message;
  const role = message.role;
  if (role !== 'user' && role !== 'assistant') return;
  const timestamp = typeof message.timestamp === 'number'
    ? message.timestamp
    : typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  if (Number.isFinite(timestamp)) {
    metadata.lastActivityTime = Math.max(metadata.lastActivityTime ?? Number.NEGATIVE_INFINITY, timestamp);
  }
  const text = textFromContent(message.content);
  if (role === 'user' && !metadata.firstMessage && text) metadata.firstMessage = text;
  if (includeSearchText && text && metadata.searchText.length < MAX_SESSION_SEARCH_TEXT) {
    const separator = metadata.searchText ? '\n' : '';
    metadata.searchText += `${separator}${text}`.slice(0, MAX_SESSION_SEARCH_TEXT - metadata.searchText.length);
  }
}

function parseMetadataLines(source: string, metadata: ScannedSessionMetadata, includeSearchText: boolean, expectHeader: boolean, discardFirstPartialLine = false): boolean {
  const lines = source.split(/\r?\n/gu);
  if (discardFirstPartialLine) lines.shift();
  let headerSeen = !expectHeader;
  for (const line of lines) {
    const entry = parseJsonRecord(line);
    if (!entry) continue;
    if (!headerSeen) {
      if (entry.type !== 'session' || typeof entry.id !== 'string' || !entry.id) return false;
      metadata.header = entry;
      headerSeen = true;
      continue;
    }
    absorbSessionEntry(metadata, entry, includeSearchText);
  }
  return headerSeen;
}

async function readFileRange(filePath: string, position: number, length: number): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readSessionMetadata(filePath: string, includeSearchText: boolean): Promise<SessionInfo | null> {
  try {
    const stats = await lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    const prefixLength = Math.min(stats.size, MAX_SESSION_METADATA_PREFIX_BYTES);
    const prefix = await readFileRange(filePath, 0, prefixLength);
    const metadata: ScannedSessionMetadata = { header: {}, firstMessage: '', messageCount: 0, searchText: '' };
    if (!parseMetadataLines(prefix, metadata, includeSearchText, true)) return null;

    if (stats.size > prefixLength) {
      const tailStart = Math.max(prefixLength, stats.size - MAX_SESSION_METADATA_TAIL_BYTES);
      const tail = await readFileRange(filePath, tailStart, stats.size - tailStart);
      // A tail beginning immediately after a newline already starts on a valid
      // JSONL boundary. Otherwise discard its first partial record.
      const discardFirstPartialLine = tailStart !== prefixLength || !prefix.endsWith('\n');
      parseMetadataLines(tail, metadata, includeSearchText, false, discardFirstPartialLine);
    }

    const id = typeof metadata.header.id === 'string' ? metadata.header.id : '';
    if (!id) return null;
    const createdAt = typeof metadata.header.timestamp === 'string' ? new Date(metadata.header.timestamp) : null;
    const created = createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : stats.birthtime;
    const cwd = typeof metadata.header.cwd === 'string' ? metadata.header.cwd : '';
    const parentSessionPath = typeof metadata.header.parentSession === 'string' ? metadata.header.parentSession : undefined;
    return {
      path: filePath,
      id,
      cwd,
      ...(metadata.name === undefined ? {} : { name: metadata.name }),
      ...(parentSessionPath === undefined ? {} : { parentSessionPath }),
      created,
      // Pi sorts by user/assistant activity rather than title/ledger writes.
      // Prefix/tail metadata finds the recent activity in the common case and
      // avoids turning every sidebar open into a transcript-wide scan.
      modified: metadata.lastActivityTime === undefined ? created : new Date(metadata.lastActivityTime),
      // The catalog deliberately reads bounded metadata rather than a full
      // transcript. Counts remain an inexpensive sidebar estimate for very
      // large sessions instead of a hidden transcript scan.
      messageCount: Math.max(metadata.messageCount, metadata.firstMessage ? 1 : 0),
      firstMessage: metadata.firstMessage || '(no messages)',
      allMessagesText: metadata.searchText,
    };
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, R>(values: readonly T[], limit: number, operation: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await operation(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function listSessionMetadata(cwd: string, sessionsRoot: string, includeSearchText = false): Promise<SessionInfo[]> {
  const directory = projectSessionDirectory(cwd, sessionsRoot);
  const entries: Array<{ name: string; isFile(): boolean }> = [];
  try {
    const handle = await opendir(directory);
    let count = 0;
    for await (const entry of handle) {
      if (++count > MAX_CACHED_SESSIONS * 2) break; // Keep bounded sidebar history; cold reader checks overflow separately.
      entries.push(entry);
    }
  } catch {
    return [];
  }
  const paths = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => join(directory, entry.name))
    .slice(0, MAX_CACHED_SESSIONS);
  const sessions = await mapWithConcurrency(paths, MAX_SESSION_DISCOVERY_CONCURRENCY, (filePath) => readSessionMetadata(filePath, includeSearchText));
  return sessions.filter((session): session is SessionInfo => session !== null)
    .sort((left, right) => right.modified.getTime() - left.modified.getTime());
}

function isSessionEntry(value: FileEntry): value is SessionEntry {
  return value.type !== 'session';
}

function isValidSessionEntry(value: FileEntry): value is SessionEntry {
  return isSessionEntry(value)
    && sessionEntryTypes.has(value.type)
    && typeof value.id === 'string'
    && value.id.length > 0
    && (typeof value.parentId === 'string' || value.parentId === null);
}

function parseEntriesForBranchRewrite(source: string): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const line of source.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof (parsed as { type?: unknown }).type !== 'string') {
        throw new Error('invalid entry');
      }
      entries.push(parsed as FileEntry);
    } catch {
      throw new Error('The saved session is malformed and cannot be safely rewritten.');
    }
  }
  return entries;
}

function referencedRemovedEntry(entry: SessionEntry, removedIds: ReadonlySet<string>): boolean {
  if (entry.type === 'label') return removedIds.has(entry.targetId);
  if (entry.type === 'compaction') return removedIds.has(entry.firstKeptEntryId);
  if (entry.type === 'branch_summary') return removedIds.has(entry.fromId);
  return false;
}

function serializeEntries(entries: readonly FileEntry[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n').concat(entries.length ? '\n' : '');
}

/** A separate cap for destructive operations. Never use the streaming preview
 * reader to authorize a rewrite: that projection intentionally omits payload. */
async function readBoundedBranchRewriteSource(filePath: string): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_SESSION_BRANCH_REWRITE_BYTES || !Number.isSafeInteger(stats.size)) {
      throw new Error('This session is too large to safely rewrite a conversation fork. Its history was not changed.');
    }
    const buffer = Buffer.allocUnsafe(stats.size);
    let received = 0;
    while (received < buffer.length) {
      const { bytesRead } = await handle.read(buffer, received, buffer.length - received, received);
      if (bytesRead === 0) throw new Error('The saved session changed while its fork was being deleted. Try again.');
      received += bytesRead;
    }
    // A concurrent append or truncation must not be silently overwritten.
    if ((await handle.stat()).size !== stats.size) throw new Error('The saved session changed while its fork was being deleted. Try again.');
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function replaceFileAtomically(temporaryPath: string, destinationPath: string): Promise<void> {
  try {
    await rename(temporaryPath, destinationPath);
    return;
  } catch (initialError) {
    const code = (initialError as { code?: unknown }).code;
    if (code !== 'EPERM' && code !== 'EEXIST' && code !== 'ENOTEMPTY') throw initialError;
    const backupPath = `${destinationPath}.${process.pid}.${Date.now()}.branch-delete.backup`;
    await rename(destinationPath, backupPath);
    try {
      await rename(temporaryPath, destinationPath);
    } catch (replacementError) {
      await rename(backupPath, destinationPath).catch(() => undefined);
      throw replacementError;
    }
    await rm(backupPath, { force: true }).catch(() => undefined);
  }
}

function clipTitle(value: string, characterLimit: number, serializedLimit: number): { text: string; truncated: boolean } {
  let text = '';
  let characters = 0;
  for (const character of value) {
    if (characters >= characterLimit || text.length + character.length > serializedLimit) return { text, truncated: true };
    text += character;
    characters += 1;
  }
  return { text, truncated: false };
}

export function sessionDisplayTitle(name: string | undefined, firstMessage: string): string {
  const explicitName = name?.replace(/\s+/g, ' ').trim();
  if (explicitName) {
    const bounded = clipTitle(explicitName, EXPLICIT_TITLE_LIMIT, SERIALIZED_TITLE_LIMIT);
    if (!bounded.truncated) return bounded.text;
    const clipped = clipTitle(explicitName, EXPLICIT_TITLE_LIMIT - 1, SERIALIZED_TITLE_LIMIT - 1).text;
    return `${clipped.trimEnd()}…`;
  }
  const prompt = firstMessage.replace(/\s+/g, ' ').trim();
  if (!prompt || prompt === '(no messages)') return 'Untitled session';
  const bounded = clipTitle(prompt, FALLBACK_TITLE_LIMIT, SERIALIZED_TITLE_LIMIT);
  if (!bounded.truncated) return bounded.text;
  const clipped = clipTitle(prompt, FALLBACK_TITLE_LIMIT - 1, SERIALIZED_TITLE_LIMIT - 1).text;
  const wordBoundary = clipped.lastIndexOf(' ');
  const readable = wordBoundary >= Math.floor(FALLBACK_TITLE_LIMIT * 0.6)
    ? clipped.slice(0, wordBoundary)
    : clipped;
  return `${readable.trimEnd()}…`;
}

interface CachedSessionInfo { session: SessionInfo; searchText: string }

function boundedSessionSearchText(session: SessionInfo, limit: number): string {
  if (limit <= 0) return '';
  let text = '';
  for (const value of [session.name, session.firstMessage, session.allMessagesText]) {
    if (!value || text.length >= limit) continue;
    if (text) text += '\n'.slice(0, limit - text.length);
    text += value.slice(0, limit - text.length);
  }
  return text.toLocaleLowerCase();
}

/** Project-scoped, bounded projection of Pi's persistent JSONL session store. */
export class PiSessionRepository {
  private readonly cache = new Map<string, { expiresAt: number; value: Promise<CachedSessionInfo[]> }>();
  private readonly sessionsRoot: string;
  private readonly source: SessionRepositorySource;

  constructor(source?: SessionRepositorySource, sessionsRoot: string = defaultSessionsRoot()) {
    this.sessionsRoot = resolve(sessionsRoot);
    this.source = source ?? {
      ...sdkMutationSource,
      list: (cwd, includeSearchText = false) => listSessionMetadata(cwd, this.sessionsRoot, includeSearchText),
    };
  }

  /**
   * Validate a batch of session paths before any removal happens. Every path
   * must be a direct `.jsonl` child of ONE shared project session directory
   * under the sessions root. Any violation aborts the whole batch so nothing
   * outside the project's own session folder can ever be deleted.
   */
  private assertSafeSessionPaths(paths: readonly string[]): string[] {
    if (paths.length === 0) return [];
    const resolvedPaths = paths.map((sessionPath) => resolve(sessionPath));
    const root = dirname(resolvedPaths[0]!);
    for (const sessionPath of resolvedPaths) {
      if (dirname(sessionPath) !== root || !isSafeSessionPath(this.sessionsRoot, sessionPath)) {
        throw new Error('Refusing to delete a session outside this project’s session directory.');
      }
    }
    return resolvedPaths;
  }

  invalidate(cwd: string): void {
    this.cache.delete(this.cacheKey(cwd, false));
    this.cache.delete(this.cacheKey(cwd, true));
  }

  private cacheKey(cwd: string, includeSearchText: boolean): string {
    return `${cwd}\0${includeSearchText ? 'search' : 'summary'}`;
  }

  private load(cwd: string, includeSearchText: boolean): Promise<CachedSessionInfo[]> {
    const key = this.cacheKey(cwd, includeSearchText);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.value;
    }
    if (cached) this.cache.delete(key);
    const listed = includeSearchText ? this.source.list(cwd, true) : this.source.list(cwd);
    const value = listed.then((sessions) => {
      let remainingSearchCharacters = MAX_SESSION_SEARCH_CACHE_CHARACTERS;
      return [...sessions]
        .sort((left, right) => right.modified.getTime() - left.modified.getTime())
        .slice(0, MAX_CACHED_SESSIONS)
        .map((session) => {
          const searchText = includeSearchText
            ? boundedSessionSearchText(session, Math.min(MAX_SESSION_SEARCH_TEXT, remainingSearchCharacters))
            : '';
          remainingSearchCharacters -= searchText.length;
          const boundedSession: SessionInfo = {
            path: session.path,
            id: session.id,
            cwd: session.cwd,
            ...(session.name === undefined ? {} : { name: session.name.slice(0, 500) }),
            ...(session.parentSessionPath === undefined ? {} : { parentSessionPath: session.parentSessionPath }),
            created: session.created,
            modified: session.modified,
            messageCount: session.messageCount,
            firstMessage: session.firstMessage.slice(0, 2_000),
            allMessagesText: '',
          };
          return { session: boundedSession, searchText };
        });
    }).then((sessions) => {
      const entry = this.cache.get(key);
      if (entry?.value === value) entry.expiresAt = Date.now() + SESSION_CACHE_TTL_MS;
      return sessions;
    }).catch((error) => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
      throw error;
    });
    this.cache.set(key, { expiresAt: Number.POSITIVE_INFINITY, value });
    while (this.cache.size > MAX_PROJECT_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }

  async list(cwd: string, activeSessionId: string | null, query = ''): Promise<SessionSummary[]> {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const sessions = await this.load(cwd, normalizedQuery.length > 0);
    return sessions
      .filter(({ searchText }) => !normalizedQuery || searchText.includes(normalizedQuery))
      .map(({ session }) => ({
        id: session.id,
        title: sessionDisplayTitle(session.name, session.firstMessage),
        firstMessage: session.firstMessage.slice(0, 2_000),
        path: session.path,
        createdAt: session.created.toISOString(),
        modifiedAt: session.modified.toISOString(),
        messageCount: session.messageCount,
        ...(session.parentSessionPath ? { parentSessionPath: session.parentSessionPath } : {}),
        active: session.id === activeSessionId,
        attention: null,
      }));
  }

  /** Side-effect-free cold Team lookup. SDK getBranch follows parentId from the last
   * complete entry; never infer the selected branch from a tail alone. Refuse large
   * transcripts rather than loading a user's multi-GB conversation into memory. */
  async readColdTeams(cwd: string, sessionId: string): Promise<ColdTeamRead> {
    try {
      // A partial sidebar list is useful but cannot prove a cold Team identity.
      const directory = await opendir(projectSessionDirectory(cwd, this.sessionsRoot));
      let count = 0;
      for await (const _entry of directory) {
        if (++count > MAX_CACHED_SESSIONS * 2) return { state: 'unknown', reason: 'oversized' };
      }
      const summary = await this.resolve(cwd, sessionId);
      if (!summary || !isSafeSessionPath(this.sessionsRoot, summary.path)
        || dirname(resolve(summary.path)) !== projectSessionDirectory(cwd, this.sessionsRoot)) return { state: 'unknown', reason: 'missing' };
      const [file, canonicalRoot, canonicalDir, canonicalFile] = await Promise.all([
        lstat(summary.path), realpath(this.sessionsRoot), realpath(dirname(summary.path)), realpath(summary.path),
      ]);
      if (!file.isFile() || canonicalDir !== join(canonicalRoot, basename(dirname(summary.path)))
        || canonicalFile !== resolve(summary.path)) return { state: 'unknown', reason: 'unavailable' };
      const limit = 8 * 1024 * 1024;
      if (file.size < 1 || file.size > limit) return { state: 'unknown', reason: 'oversized' };
      const handle = await open(summary.path, 'r');
      let text: string;
      try {
        const live = await handle.stat();
        if (!live.isFile() || live.size !== file.size || live.mtimeMs !== file.mtimeMs || live.size > limit) return { state: 'unknown', reason: 'unavailable' };
        const bytes = Buffer.alloc(live.size + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        const after = await handle.stat();
        if (bytesRead !== live.size || after.size !== file.size || after.mtimeMs !== live.mtimeMs) return { state: 'unknown', reason: 'unavailable' };
        text = bytes.toString('utf8', 0, bytesRead);
      } finally { await handle.close(); }
      if (!text.endsWith('\n')) return { state: 'unknown', reason: 'partial-tail' };
      const lines = text.trimEnd().split('\n');
      let header: unknown;
      try { header = JSON.parse(lines.shift() ?? ''); }
      catch { return { state: 'unknown', reason: 'corrupt' }; }
      if (!isRecord(header) || header.type !== 'session' || header.id !== sessionId || header.cwd !== resolve(cwd)) return { state: 'unknown', reason: 'corrupt' };
      const entries = new Map<string, { parentId: string | null; team: AgentTeam | null | undefined; teamId?: string; sequence?: number }>();
      let leaf: string | null = null;
      for (const line of lines) {
        let entry: unknown;
        try { entry = JSON.parse(line); }
        catch { return { state: 'unknown', reason: 'corrupt' }; }
        if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id || entries.has(entry.id)
          || (entry.parentId !== null && typeof entry.parentId !== 'string')) return { state: 'unknown', reason: 'corrupt' };
        let team: AgentTeam | null | undefined;
        let teamId: string | undefined;
        let sequence: number | undefined;
        if (entry.type === 'custom' && entry.customType === 'fate-agent-team-event') {
          const event = entry.data;
          if (!isRecord(event) || event.kind !== 'fate-agent-team-event' || event.version !== 1
            || typeof event.teamId !== 'string' || !Number.isSafeInteger(event.sequence) || !isRecord(event.payload)) return { state: 'unknown', reason: 'corrupt' };
          teamId = event.teamId;
          sequence = event.sequence as number;
          if (event.type === 'team.deleted') team = null;
          else {
            const parsed = agentTeamSchema.safeParse(event.payload.team);
            if (!parsed.success || parsed.data.id !== teamId || parsed.data.rootSessionId !== sessionId) return { state: 'unknown', reason: 'corrupt' };
            team = parsed.data;
          }
        }
        entries.set(entry.id, { parentId: entry.parentId, team, ...(teamId ? { teamId } : {}), ...(sequence !== undefined ? { sequence } : {}) });
        leaf = entry.id;
      }
      const branch = new Set<string>();
      const teams = new Map<string, AgentTeam | null>();
      const sequences = new Map<string, number>();
      while (leaf !== null) {
        if (branch.has(leaf)) return { state: 'unknown', reason: 'corrupt' };
        branch.add(leaf);
        const entry = entries.get(leaf);
        if (!entry) return { state: 'unknown', reason: 'corrupt' };
        if (entry.teamId) {
          const last = sequences.get(entry.teamId);
          if (last !== undefined && entry.sequence! > last) return { state: 'unknown', reason: 'corrupt' };
          sequences.set(entry.teamId, entry.sequence!);
          if (!teams.has(entry.teamId)) teams.set(entry.teamId, entry.team ?? null);
        }
        leaf = entry.parentId;
      }
      return { state: 'ok', teams };
    } catch { return { state: 'unknown', reason: 'unavailable' }; }
  }

  async resolve(cwd: string, sessionId: string): Promise<SessionSummary | undefined> {
    return (await this.list(cwd, null)).find((session) => session.id === sessionId);
  }

  /** Stream only the selected saved JSONL. No whole-file string is allocated;
   * the cold view keeps bounded recent content plus compact tree/usage metadata. */
  async snapshot(cwd: string, sessionId: string, knownSummary?: SessionSummary): Promise<SessionSnapshot | undefined> {
    const summary = knownSummary?.id === sessionId ? knownSummary : await this.resolve(cwd, sessionId);
    if (!summary || !isSafeSessionPath(this.sessionsRoot, summary.path)
      || dirname(resolve(summary.path)) !== projectSessionDirectory(cwd, this.sessionsRoot)) return undefined;
    try {
      const stats = await lstat(summary.path);
      if (!stats.isFile() || stats.isSymbolicLink()) return undefined;
      const read = await readSessionSnapshot(summary.path, sessionId);
      if (!read) return undefined;
      const firstMessage = read.firstMessage ?? summary.firstMessage;
      const title = read.name !== undefined ? sessionDisplayTitle(read.name ?? undefined, firstMessage) : summary.title;
      return {
        summary: {
          ...summary, title, firstMessage,
          messageCount: read.messageCount,
          ...(read.lastActivityTime === undefined ? {} : { modifiedAt: new Date(read.lastActivityTime).toISOString() }),
        },
        entries: read.entries,
        branch: read.branch,
        ...(read.previewNotice === undefined ? {} : { previewNotice: read.previewNotice }),
      };
    } catch (error) {
      if (error instanceof SessionSnapshotLimitError) throw error;
      return undefined;
    }
  }

  /** Read one bounded display page directly from the saved JSONL. Never constructs
   * a SessionManager or changes selection. Cursor offsets are internal to the
   * caller's server-side token table, never accepted from a renderer. */
  async readHistoryPage(cwd: string, sessionId: string, offset = 0, expectedStamp?: string): Promise<{ items: SnapshotItem[]; nextOffset: number | null; stamp: string; oversizedItems: number; mediaOmitted: boolean } | undefined> {
    const summary = await this.resolve(cwd, sessionId);
    if (!summary || !isSafeSessionPath(this.sessionsRoot, summary.path)
      || dirname(resolve(summary.path)) !== projectSessionDirectory(cwd, this.sessionsRoot)) return undefined;
    // Refuse symlinked session files or redirected project directories. A
    // listed ID is not authority to read an arbitrary path outside Pi storage.
    const directory = projectSessionDirectory(cwd, this.sessionsRoot);
    const [fileLink, canonicalRoot, canonicalDir, canonicalFile] = await Promise.all([
      lstat(summary.path), realpath(this.sessionsRoot), realpath(directory), realpath(summary.path),
    ]).catch(() => [null, '', '', ''] as const);
    if (!fileLink?.isFile() || fileLink.isSymbolicLink() || canonicalDir !== join(canonicalRoot, basename(directory))
      || dirname(canonicalFile) !== canonicalDir) return undefined;
    const handle = await open(summary.path, 'r').catch(() => null);
    if (!handle) return undefined;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return undefined;
      const finalPath = await realpath(summary.path).catch(() => null);
      const finalStat = finalPath ? await lstat(summary.path).catch(() => null) : null;
      if (finalPath !== canonicalFile || !finalStat?.isFile() || finalStat.isSymbolicLink()
        || stat.dev !== finalStat.dev || stat.ino !== finalStat.ino) return undefined;
      const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (expectedStamp && stamp !== expectedStamp) throw new Error('RESYNC_REQUIRED');
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= stat.size) throw new Error('RESYNC_REQUIRED');
      // Verify the session header on every read; a replaced file cannot borrow an old listing.
      const headerBuffer = Buffer.alloc(Math.min(64 * 1024, stat.size));
      const headerRead = await handle.read(headerBuffer, 0, headerBuffer.length, 0);
      const headerEnd = headerBuffer.subarray(0, headerRead.bytesRead).indexOf(10);
      if (headerEnd < 0) throw new Error('The saved session header is unavailable.');
      const header = parseJsonRecord(headerBuffer.subarray(0, headerEnd).toString('utf8'));
      if (header?.type !== 'session' || header.id !== sessionId) throw new Error('The saved session header does not match its identity.');
      const items: SnapshotItem[] = [];
      let mediaOmitted = false;
      let oversizedItems = 0;
      let position = offset === 0 ? headerEnd + 1 : offset;
      let lineStart = position;
      let nextOffset: number | null = null;
      let pageFull = false;
      let pageBytes = 1024;
      const addItem = (item: SnapshotItem): boolean => {
        const size = Buffer.byteLength(JSON.stringify(item), 'utf8') + 2;
        if (items.length && pageBytes + size > 768 * 1024) {
          nextOffset = lineStart; // Retry this whole line on the next page.
          pageFull = true;
          return false;
        }
        items.push(item);
        pageBytes += size;
        return true;
      };
      const pushLine = (line: Buffer, oversized: SnapshotRecord | null | undefined, lineEnd: number): void => {
        if (oversized !== undefined) {
          // A malformed/ambiguous large record cannot be declared a visible
          // message OR silently skipped. Refuse this history page explicitly.
          if (!oversized || typeof oversized.type !== 'string' || typeof oversized.id !== 'string' || !oversized.id
            || !(typeof oversized.parentId === 'string' || oversized.parentId === null)) {
            throw new Error('Oversized saved record cannot be classified safely.');
          }
          if (hiddenHistoryEntryTypes.has(oversized.type) || oversized.type === 'custom_message' && oversized.display !== true) return;
          if (oversized.type === 'message' && !['user', 'assistant', 'toolResult'].includes(String(oversized.messageRole))) {
            throw new Error('Oversized saved message cannot be classified safely.');
          }
          if (oversized.type === 'compaction') {
            addItem({ kind: 'message', id: oversized.id.slice(0, 500), role: 'system', text: 'Context compacted',
              timestamp: typeof oversized.timestamp === 'string' && Number.isFinite(Date.parse(oversized.timestamp)) ? Date.parse(oversized.timestamp) : 0,
              clipped: false, mediaOmitted: false });
            return;
          }
          if (oversized.type !== 'message' && oversized.type !== 'custom_message') {
            throw new Error('Oversized saved record cannot be classified safely.');
          }
          if (addItem({ kind: 'message', id: `oversized:${lineEnd}`, role: 'system', text: 'Saved item exceeds the display read limit; original JSONL is unchanged.', timestamp: 0, clipped: true, mediaOmitted: true })) {
            oversizedItems++;
            mediaOmitted = true; // Displayable content might include unsupported media.
          }
          return;
        }
        const entry = parseJsonRecord(line.toString('utf8'));
        // Match PiRuntimeService's saved-branch display projection: custom
        // messages marked display=true and compaction boundaries are transcript
        // rows, not disposable ledger metadata. Do not serialize raw records.
        const message = entry?.type === 'message' && isRecord(entry.message) ? entry.message : null;
        const displayedCustom = entry?.type === 'custom_message' && entry.display === true;
        const compaction = entry?.type === 'compaction';
        if (message || displayedCustom || compaction) {
          const contentSource = message ?? entry!;
          const isTool = message?.role === 'toolResult';
          const role = message?.role === 'user' || message?.role === 'assistant' ? message.role : 'system';
          // Compaction summaries can include private context. Pi's timeline
          // shows only this fixed marker, so the history page does the same.
          const content = compaction ? 'Context compacted' : messageText(contentSource);
          const encoded = Buffer.from(content, 'utf8');
          let limit = Math.min(4096, encoded.length);
          if (limit < encoded.length) while (limit > 0 && (encoded[limit]! & 0xc0) === 0x80) limit--;
          const hasMedia = !compaction && Array.isArray(contentSource.content)
            && contentSource.content.some((part) => isRecord(part) && part.type === 'image');
          const entryTime = typeof entry?.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
          const timestamp = typeof message?.timestamp === 'number' && Number.isFinite(message.timestamp) ? message.timestamp
            : Number.isFinite(entryTime) ? entryTime : 0;
          const added = addItem({ kind: isTool ? 'tool' : 'message', id: typeof entry?.id === 'string' ? entry.id.slice(0, 500) : `entry:${lineEnd}`,
            ...(isTool ? { name: typeof message?.toolName === 'string' ? message.toolName.slice(0, 200) : 'Tool', status: message?.isError === true ? 'error' : 'succeeded' } : { role }),
            text: encoded.subarray(0, limit).toString('utf8'), timestamp,
            clipped: limit < encoded.length, mediaOmitted: hasMedia });
          if (added && hasMedia) mediaOmitted = true;
        } else if (!entry || entry.type === 'message') {
          if (addItem({ kind: 'message', id: `unreadable:${lineEnd}`, role: 'system', text: 'Saved item cannot be displayed; original JSONL is unchanged.',
            timestamp: 0, clipped: true, mediaOmitted: true })) mediaOmitted = true;
        }
      };
      let consumed = 0;
      let carry = Buffer.alloc(0);
      let oversized: OversizedRecordFields | null = null;
      const chunk = Buffer.alloc(64 * 1024);
      // Finish any partially consumed line before paging. An offset inside a
      // JSONL record would silently lose that message on the next page.
      while (position < stat.size && items.length < 128 && (consumed < 768 * 1024 || carry.length > 0 || oversized !== null)) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, stat.size - position), position);
        if (!bytesRead) break;
        let start = 0;
        while (start < bytesRead) {
          const newline = chunk.subarray(start, bytesRead).indexOf(10);
          const end = newline < 0 ? bytesRead : start + newline;
          const part = chunk.subarray(start, end);
          if (!oversized && carry.length + part.length <= MAX_HISTORY_RECORD_BUFFER_BYTES) carry = Buffer.concat([carry, part]);
          else {
            if (!oversized) {
              oversized = new OversizedRecordFields();
              oversized.write(carry);
              carry = Buffer.alloc(0);
            }
            oversized.write(part);
          }
          consumed += part.length + Number(newline >= 0);
          if (newline < 0) { position += bytesRead - start; break; }
          position += end - start + 1;
          pushLine(carry, oversized?.finish(), position);
          carry = Buffer.alloc(0); oversized = null;
          start = end + 1;
          if (pageFull) break;
          lineStart = position;
          if (items.length >= 128 || consumed >= 768 * 1024) { nextOffset = position < stat.size ? position : null; break; }
        }
        if (nextOffset !== null) break;
      }
      if (!pageFull && position === stat.size && (carry.length || oversized)) pushLine(carry, oversized?.finish(), position);
      if (nextOffset === null && position < stat.size) nextOffset = position;
      const after = await handle.stat();
      if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== stamp) throw new Error('RESYNC_REQUIRED');
      return { items, nextOffset, stamp, oversizedItems, mediaOmitted };
    } finally { await handle.close(); }
  }

  async rename(cwd: string, sessionId: string, name: string): Promise<void> {
    const session = await this.resolve(cwd, sessionId);
    if (!session) throw new Error('The selected session no longer exists.');
    this.source.rename(session.path, name);
    this.invalidate(cwd);
  }

  async renameIfUnnamed(cwd: string, sessionId: string, name: string): Promise<boolean> {
    const session = (await this.source.list(cwd)).find((candidate) => candidate.id === sessionId);
    if (!session || session.name?.trim()) return false;
    this.source.rename(session.path, name);
    this.invalidate(cwd);
    return true;
  }

  async delete(cwd: string, sessionId: string): Promise<void> {
    const session = await this.resolve(cwd, sessionId);
    if (!session) throw new Error('The selected session no longer exists.');
    if (!this.source.remove) throw new Error('Deleting sessions is unavailable.');
    this.assertSafeSessionPaths([session.path]);
    await this.source.remove(session.path);
    this.invalidate(cwd);
  }

  /**
   * Rewrites one persisted session file after removing an inactive branch: its
   * leaf, its descendants, and the ancestors that are not shared with the
   * active path. The active branch stays intact. This function only accepts a
   * direct listed session child and validates every JSONL entry before write.
   */
  async deleteBranch(cwd: string, sessionId: string, branchId: string, activeLeafId: string | null): Promise<void> {
    const session = await this.resolve(cwd, sessionId);
    if (!session) throw new Error('The selected session no longer exists.');
    const resolvedPath = this.assertSafeSessionPaths([session.path])[0];
    if (!resolvedPath) throw new Error('The selected session path is unavailable.');
    const stats = await lstat(resolvedPath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('The selected session is not a regular saved session file.');
    if (stats.size > MAX_SESSION_BRANCH_REWRITE_BYTES) {
      throw new Error('This session is too large to safely rewrite a conversation fork. Its history was not changed.');
    }
    for (let attempt = 0; attempt < SESSION_BRANCH_REWRITE_RETRIES; attempt += 1) {
      const before = await readBoundedBranchRewriteSource(resolvedPath);
      const parsed = parseEntriesForBranchRewrite(before);
      const header = parsed.find((entry) => entry.type === 'session');
      if (!header || header.id !== sessionId) throw new Error('The saved session header is invalid.');
      const entries = parsed.filter(isValidSessionEntry);
      if (entries.length !== parsed.filter(isSessionEntry).length) throw new Error('The saved session contains an invalid entry.');
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      if (byId.size !== entries.length || !byId.has(branchId)) throw new Error('That conversation path is no longer available.');
      const activePath = new Set<string>();
      if (activeLeafId) {
        let current = byId.get(activeLeafId);
        while (current && !activePath.has(current.id)) {
          activePath.add(current.id);
          current = current.parentId ? byId.get(current.parentId) : undefined;
        }
      }
      if (activePath.has(branchId)) {
        // The branch sits on the active path (it is the active leaf or one of its ancestors).
        throw new Error('Switch to a different conversation path before deleting this fork.');
      }

      // Index children once, then traverse the fork subtree and its unshared
      // ancestor chain once. Repeated parent walks make deep histories quadratic.
      const childrenByParent = new Map<string, string[]>();
      for (const entry of entries) {
        if (!entry.parentId) continue;
        const children = childrenByParent.get(entry.parentId);
        if (children) children.push(entry.id);
        else childrenByParent.set(entry.parentId, [entry.id]);
      }
      const removedIds = new Set<string>();
      const descendants = [branchId];
      while (descendants.length > 0) {
        const entryId = descendants.pop()!;
        if (removedIds.has(entryId)) continue;
        removedIds.add(entryId);
        const children = childrenByParent.get(entryId);
        if (children) for (const child of children) descendants.push(child);
      }
      const ancestors = new Set<string>();
      let ancestor = byId.get(branchId);
      while (ancestor && !ancestors.has(ancestor.id)) {
        ancestors.add(ancestor.id);
        if (!activePath.has(ancestor.id)) removedIds.add(ancestor.id);
        ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
      }
      if (!removedIds.size || (activeLeafId && removedIds.has(activeLeafId))) throw new Error('Switch to a different conversation path before deleting this fork.');
      const next = parsed.filter((entry) => !isValidSessionEntry(entry) || (!removedIds.has(entry.id) && !referencedRemovedEntry(entry, removedIds)));
      const latest = await readBoundedBranchRewriteSource(resolvedPath);
      if (latest !== before) continue;
      const temporaryPath = `${resolvedPath}.${process.pid}.${Date.now()}.branch-delete.tmp`;
      try {
        await writeFile(temporaryPath, serializeEntries(next), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        if (await readBoundedBranchRewriteSource(resolvedPath) !== before) continue;
        await replaceFileAtomically(temporaryPath, resolvedPath);
        this.invalidate(cwd);
        return;
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    }
    throw new Error('The saved session changed while its fork was being deleted. Try again.');
  }

  /**
   * Delete every listed session except the excluded ones in a single pass.
   * The listing is read ONCE, every path is containment-checked up front
   * (fail closed: a single bad path deletes nothing), and the summary/search
   * cache is invalidated once at the end so the next read reloads from disk.
   */
  async deleteAll(cwd: string, excludedSessionIds: ReadonlySet<string> = new Set()): Promise<number> {
    if (!this.source.remove) throw new Error('Deleting sessions is unavailable.');
    const sessions = await this.source.list(cwd);
    const paths = this.assertSafeSessionPaths(
      sessions.filter((session) => !excludedSessionIds.has(session.id)).map((session) => session.path),
    );
    let deleted = 0;
    for (const sessionPath of paths) {
      await this.source.remove(sessionPath);
      deleted += 1;
    }
    this.invalidate(cwd);
    return deleted;
  }

  branches(session: AgentSession): SessionBranch[] {
    const manager = session.sessionManager;
    if (!manager || typeof manager.getTree !== 'function') return [];
    const activePath = new Set(manager.getBranch().slice(-MAX_BRANCH_NODES_VISITED).map((entry) => entry.id));
    const result: SessionBranch[] = [];
    const stack: Array<{
      node: SessionTreeNode;
      depth: number;
      branchPreview: string;
      latestPreview: string;
      inheritedLabel?: string;
    }> = manager.getTree()
      .slice()
      .reverse()
      .map((node) => ({ node, depth: 0, branchPreview: '', latestPreview: '' }));
    let visited = 0;
    while (stack.length > 0 && visited < MAX_BRANCH_NODES_VISITED && result.length < MAX_PROJECTED_BRANCHES) {
      const { node, depth, branchPreview, latestPreview, inheritedLabel } = stack.pop()!;
      visited += 1;
      const entry = node.entry;
      const preview = entry.type === 'message'
        ? messageText(entry.message).replace(/\s+/g, ' ').trim().slice(0, 100)
        : entry.type === 'branch_summary'
          ? entry.summary.replace(/\s+/g, ' ').trim().slice(0, 100)
          : '';
      const nextBranchPreview = branchPreview || preview;
      const nextLatestPreview = preview || latestPreview;
      const label = node.label?.trim() || inheritedLabel;
      if (node.children.length === 0) {
        result.push({
          id: entry.id.slice(0, 500),
          parentId: entry.parentId?.slice(0, 500) ?? null,
          depth: Math.min(depth, MAX_BRANCH_NODES_VISITED),
          ...(label ? { label: label.slice(0, 500) } : {}),
          preview: nextBranchPreview || nextLatestPreview,
          kind: entry.type.slice(0, 100),
          active: activePath.has(entry.id),
        });
      }
      const startsDistinctPaths = node.children.length > 1;
      for (let index = node.children.length - 1; index >= 0 && stack.length + visited < MAX_BRANCH_NODES_VISITED; index -= 1) {
        stack.push({
          node: node.children[index]!,
          depth: depth + 1,
          branchPreview: startsDistinctPaths ? '' : nextBranchPreview,
          latestPreview: nextLatestPreview,
          ...(label ? { inheritedLabel: label } : {}),
        });
      }
    }
    return result;
  }
}
