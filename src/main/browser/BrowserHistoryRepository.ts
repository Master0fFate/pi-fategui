import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const SCHEMA_VERSION = 2;
const MAX_ENTRIES = 2_000;
const MAX_TABS = 16;
const MAX_URL_CHARACTERS = 8_192;
const MAX_STATE_BYTES = 1024 * 1024;

export interface BrowserHistorySession {
  tabs: string[];
  activeIndex: number;
}

interface BrowserHistoryState {
  schemaVersion: typeof SCHEMA_VERSION;
  sessions: Record<string, BrowserHistorySession>;
}

export type BrowserHistoryWrite = string | BrowserHistorySession | null;

function isRestorableProtocol(url: string): boolean {
  try {
    return new Set(['http:', 'https:', 'file:']).has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Decide whether a committed URL is worth restoring on the next browser open.
 * Real network pages (http/https, including localhost) and local previews
 * (file://, the display address of a local page) qualify; blank pages and the
 * ephemeral fate-local capability URLs are discarded because a stored token
 * can never reload after the service that issued it is gone.
 */
export function isRestorableBrowserUrl(url: string): boolean {
  if (!url || url.length > MAX_URL_CHARACTERS) return false;
  return isRestorableProtocol(url);
}

function hashKey(projectPath: string): string {
  return createHash('sha256').update(projectPath).digest('hex');
}

function boundedSession(tabs: readonly string[], activeIndex: number): BrowserHistorySession | null {
  const bounded = tabs
    .filter((url) => isRestorableBrowserUrl(url))
    .map((url) => url.slice(0, MAX_URL_CHARACTERS))
    .slice(0, MAX_TABS);
  if (bounded.length === 0) return null;
  return {
    tabs: bounded,
    activeIndex: Math.min(Math.max(0, Math.trunc(activeIndex) || 0), bounded.length - 1),
  };
}

/**
 * Per-project open-tab store for the built-in browser. Fate UI keeps the
 * restorable tab list for each canonical project path so reopening the
 * browser (after closing it or restarting the app) restores those pages.
 *
 * Entries are bounded and written atomically; a corrupt or oversized file is
 * treated as empty rather than crashing the browser.
 */
export class BrowserHistoryRepository {
  private readonly statePath: string;
  private cache: BrowserHistoryState | null = null;
  private loadPromise: Promise<BrowserHistoryState> | null = null;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(
    dataRoot = process.env.FATE_GUI_DATA_DIR ? path.resolve(process.env.FATE_GUI_DATA_DIR) : path.join(os.homedir(), '.pi', 'fateGUI'),
  ) {
    this.statePath = path.join(dataRoot, 'browser-history.json');
  }

  async load(projectPath: string): Promise<string | null> {
    const session = await this.loadSession(projectPath);
    if (!session) return null;
    return session.tabs[session.activeIndex] ?? session.tabs[0] ?? null;
  }

  async loadSession(projectPath: string): Promise<BrowserHistorySession | null> {
    if (!projectPath) return null;
    const session = (await this.read()).sessions[hashKey(projectPath)];
    return session ? { tabs: [...session.tabs], activeIndex: session.activeIndex } : null;
  }

  /** Remember restorable tabs for a project. Pass null to forget. A lone
   *  non-restorable URL is ignored so a stray about:blank never erases the
   *  last real pages. An empty tab list forgets the project. */
  async save(projectPath: string, value: BrowserHistoryWrite): Promise<void> {
    if (!projectPath) return;
    const key = hashKey(projectPath);
    this.saveChain = this.saveChain.then(async () => {
      const state = await this.read();
      if (value === null) delete state.sessions[key];
      else if (typeof value === 'string') {
        if (!isRestorableBrowserUrl(value)) return;
        state.sessions[key] = { tabs: [value.slice(0, MAX_URL_CHARACTERS)], activeIndex: 0 };
      } else {
        const session = boundedSession(value.tabs, value.activeIndex);
        if (!session) delete state.sessions[key];
        else state.sessions[key] = session;
      }
      await this.persist(state);
    }).catch(() => undefined);
    await this.saveChain;
  }

  private async read(): Promise<BrowserHistoryState> {
    if (this.cache) return this.cache;
    if (!this.loadPromise) this.loadPromise = this.readFresh();
    this.cache = await this.loadPromise;
    this.loadPromise = null;
    return this.cache;
  }

  private async readFresh(): Promise<BrowserHistoryState> {
    try {
      const stat = await fs.stat(this.statePath);
      if (!stat.isFile() || stat.size > MAX_STATE_BYTES) return emptyState();
      return parseState(JSON.parse(await fs.readFile(this.statePath, 'utf8')));
    } catch {
      return emptyState();
    }
  }

  private async persist(state: BrowserHistoryState): Promise<void> {
    const entries = Object.entries(state.sessions).slice(-MAX_ENTRIES);
    const trimmed: BrowserHistoryState = { schemaVersion: SCHEMA_VERSION, sessions: Object.fromEntries(entries) };
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(trimmed)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, this.statePath);
      this.cache = trimmed;
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function parseState(value: unknown): BrowserHistoryState {
  if (!value || typeof value !== 'object') return emptyState();
  const raw = value as { schemaVersion?: unknown; urls?: unknown; sessions?: unknown };
  if (raw.schemaVersion === 1 && raw.urls && typeof raw.urls === 'object') {
    const sessions: Record<string, BrowserHistorySession> = {};
    for (const [key, entry] of Object.entries(raw.urls as Record<string, unknown>)) {
      if (typeof entry === 'string' && isRestorableBrowserUrl(entry)) {
        sessions[key] = { tabs: [entry.slice(0, MAX_URL_CHARACTERS)], activeIndex: 0 };
      }
      if (Object.keys(sessions).length >= MAX_ENTRIES) break;
    }
    return { schemaVersion: SCHEMA_VERSION, sessions };
  }
  if (raw.schemaVersion !== SCHEMA_VERSION || !raw.sessions || typeof raw.sessions !== 'object') return emptyState();
  const sessions: Record<string, BrowserHistorySession> = {};
  for (const [key, entry] of Object.entries(raw.sessions as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as { tabs?: unknown; activeIndex?: unknown };
    if (!Array.isArray(candidate.tabs)) continue;
    const session = boundedSession(
      candidate.tabs.filter((url): url is string => typeof url === 'string'),
      typeof candidate.activeIndex === 'number' ? candidate.activeIndex : 0,
    );
    if (session) sessions[key] = session;
    if (Object.keys(sessions).length >= MAX_ENTRIES) break;
  }
  return { schemaVersion: SCHEMA_VERSION, sessions };
}

function emptyState(): BrowserHistoryState {
  return { schemaVersion: SCHEMA_VERSION, sessions: {} };
}
