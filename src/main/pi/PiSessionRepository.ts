import { rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  getAgentDir,
  SessionManager,
  type AgentSession,
  type SessionInfo,
  type SessionTreeNode,
} from '@earendil-works/pi-coding-agent';
import type { SessionBranch, SessionSummary } from '../../shared/contracts/ipc';
import { messageText } from './PiEventNormalizer';

export interface SessionRepositorySource {
  list(cwd: string): Promise<SessionInfo[]>;
  rename(path: string, name: string): void;
  remove?(path: string): Promise<void>;
}

const sdkSource: SessionRepositorySource = {
  list: (cwd) => SessionManager.list(cwd),
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

  constructor(private readonly source: SessionRepositorySource = sdkSource, sessionsRoot: string = defaultSessionsRoot()) {
    this.sessionsRoot = resolve(sessionsRoot);
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
    const value = this.source.list(cwd).then((sessions) => {
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

  async resolve(cwd: string, sessionId: string): Promise<SessionSummary | undefined> {
    return (await this.list(cwd, null)).find((session) => session.id === sessionId);
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
