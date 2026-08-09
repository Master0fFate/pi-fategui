import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const SCHEMA_VERSION = 1;
const MAX_ENTRIES = 2_000;
const MAX_URL_CHARACTERS = 8_192;
const MAX_STATE_BYTES = 1024 * 1024;

export interface BrowserHistoryState {
  schemaVersion: typeof SCHEMA_VERSION;
  /** Canonical project path -> last restorable URL. */
  urls: Record<string, string>;
}

function isRestorableProtocol(url: string): boolean {
  return /^https?:\/\//iu.test(url);
}

/**
 * Decide whether a committed URL is worth restoring on the next browser open.
 * Only real network pages (http/https, including localhost) qualify; blank
 * pages and ephemeral local previews are discarded so reopening lands on a page
 * that can actually reload.
 */
export function isRestorableBrowserUrl(url: string): boolean {
  if (!url || url.length > MAX_URL_CHARACTERS) return false;
  if (url === 'about:blank') return false;
  return isRestorableProtocol(url);
}

function hashKey(projectPath: string): string {
  return createHash('sha256').update(projectPath).digest('hex');
}

/**
 * Per-project "last visited page" store for the built-in browser. Fate UI keeps
 * one entry per canonical project path so reopening a browser (after closing it
 * or restarting the app) returns to the page the user was last on.
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
    if (!projectPath) return null;
    const state = await this.read();
    const value = state.urls[hashKey(projectPath)];
    return typeof value === 'string' && isRestorableBrowserUrl(value) ? value : null;
  }

  /** Remember the last restorable URL for a project. Pass null to forget; a non-restorable url is ignored so a stray about:blank never erases the last real page. */
  async save(projectPath: string, url: string | null): Promise<void> {
    if (!projectPath) return;
    const key = hashKey(projectPath);
    this.saveChain = this.saveChain.then(async () => {
      const state = await this.read();
      if (url === null) delete state.urls[key];
      else if (isRestorableBrowserUrl(url)) state.urls[key] = url.slice(0, MAX_URL_CHARACTERS);
      else return; // keep the existing remembered page
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
      const value: unknown = JSON.parse(await fs.readFile(this.statePath, 'utf8'));
      if (!value || typeof value !== 'object' || (value as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION) return emptyState();
      const raw = (value as { urls?: unknown }).urls;
      if (!raw || typeof raw !== 'object') return emptyState();
      const urls: Record<string, string> = {};
      for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof entry === 'string' && isRestorableBrowserUrl(entry)) urls[key] = entry.slice(0, MAX_URL_CHARACTERS);
        if (Object.keys(urls).length >= MAX_ENTRIES) break;
      }
      return { schemaVersion: SCHEMA_VERSION, urls };
    } catch {
      return emptyState();
    }
  }

  private async persist(state: BrowserHistoryState): Promise<void> {
    const entries = Object.entries(state.urls).slice(-MAX_ENTRIES);
    const trimmed: BrowserHistoryState = { schemaVersion: SCHEMA_VERSION, urls: Object.fromEntries(entries) };
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

function emptyState(): BrowserHistoryState {
  return { schemaVersion: SCHEMA_VERSION, urls: {} };
}
