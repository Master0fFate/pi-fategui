import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

/** Provider config exactly as Fate writes it into models.json. */
export type ProviderConfigInputLike = Parameters<ModelRuntime['registerProvider']>[1];

/**
 * Structural subset of ModelRuntime that ProviderFileSync needs. The real
 * runtime satisfies it; tests substitute a recorder.
 */
export interface FileSyncRuntime {
  getProviders(): readonly { id: string }[];
  registerProvider(providerId: string, config: ProviderConfigInputLike): void;
  unregisterProvider(providerId: string): void;
  setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>;
  removeRuntimeApiKey(providerId: string): Promise<void>;
  refresh(options?: { allowNetwork?: boolean }): Promise<unknown>;
}

export interface ProviderFileSyncPaths {
  modelsPath: string;
  authPath: string;
}

export interface ProviderFileSyncOptions {
  debounceMs?: number;
  onSync?: (result: ProviderFileSyncResult) => void | Promise<void>;
  log?: (message: string) => void;
}

export interface ProviderFileSyncResult {
  changed: boolean;
  registered: string[];
  keysApplied: string[];
  keysRemoved: string[];
  unregistered: string[];
}

const EMPTY_RESULT: ProviderFileSyncResult = { changed: false, registered: [], keysApplied: [], keysRemoved: [], unregistered: [] };

/** Parse `{ providers: { [id]: config } }`. Returns null when unusable. */
export function parseProvidersJson(content: string): Record<string, ProviderConfigInputLike> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const providers = (parsed as { providers?: unknown } | null)?.providers;
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return null;
  const result: Record<string, ProviderConfigInputLike> = {};
  for (const [id, config] of Object.entries(providers as Record<string, unknown>)) {
    if (!id.trim() || typeof config !== 'object' || config === null) continue;
    result[id] = config as ProviderConfigInputLike;
  }
  return result;
}

/** Extract `providerId -> apiKey` for `type: "api_key"` entries. */
export function parseAuthApiKeys(content: string): Map<string, string> {
  const keys = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return keys;
  }
  if (typeof parsed !== 'object' || parsed === null) return keys;
  for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { type?: unknown; key?: unknown };
    if (record.type === 'api_key' && typeof record.key === 'string' && record.key.trim()) keys.set(id, record.key.trim());
  }
  return keys;
}

/**
 * Reconcile Fate-owned models.json + auth.json into a live ModelRuntime so a
 * provider saved on disk (settings UI, custom entry, or hand edit) is usable
 * immediately, without restarting the app.
 *
 * Safety rules:
 * - Only providers this instance registered are ever unregistered; native and
 *   catalog providers managed elsewhere are never touched.
 * - A corrupt models.json is a no-op: the runtime keeps its current composition.
 * - Content hashing makes repeated syncs (and watcher echoes of our own writes)
 *   no-ops, so the loop cannot feed back into itself.
 */
export class ProviderFileSync {
  private readonly runtime: FileSyncRuntime;
  private readonly paths: ProviderFileSyncPaths;
  private readonly debounceMs: number;
  private readonly onSync: ProviderFileSyncOptions['onSync'];
  private readonly log: (message: string) => void;

  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private queue: Promise<ProviderFileSyncResult> = Promise.resolve(EMPTY_RESULT);
  private lastContentHash: string | null = null;
  private lastModelsContent: string | null = null;
  private readonly registeredBySync = new Set<string>();
  private readonly registeredConfigs = new Map<string, string>();
  private readonly appliedKeys = new Map<string, string>();
  private stopped = false;

  constructor(runtime: FileSyncRuntime, paths: ProviderFileSyncPaths, options: ProviderFileSyncOptions = {}) {
    this.runtime = runtime;
    this.paths = paths;
    this.debounceMs = options.debounceMs ?? 250;
    this.onSync = options.onSync;
    this.log = options.log ?? (() => undefined);
  }

  hasRuntime(runtime: FileSyncRuntime): boolean {
    return this.runtime === runtime;
  }

  /** Watch both files' shared directory and run one catch-up sync. */
  start(): void {
    if (this.watcher || this.stopped) return;
    const directory = path.dirname(this.paths.modelsPath);
    const watched = new Set([path.basename(this.paths.modelsPath), path.basename(this.paths.authPath)]);
    try {
      this.watcher = watch(directory, { persistent: false }, (_event, filename) => {
        const name = typeof filename === 'string' ? filename : null;
        // macOS can omit the filename for a directory event. Reconcile when
        // it does; content hashes make unrelated events safe and cheap.
        if (name && !watched.has(name)) return;
        this.scheduleSync();
      });
      this.watcher.on('error', (error) => this.log(`Provider file watcher failed: ${error instanceof Error ? error.message : String(error)}`));
      // Close the startup race: an external save can land between opening the
      // directory watcher and the first notification on some native runners.
      this.scheduleSync();
    } catch (error) {
      this.log(`Provider file watcher could not start: ${error instanceof Error ? error.message : String(error)}`);
      this.watcher = null;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.watcher?.close();
    this.watcher = null;
  }

  private scheduleSync(): void {
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.syncNow().catch(() => undefined);
    }, this.debounceMs);
  }

  /** Serialized reconcile; concurrent calls wait for and return the latest run. */
  syncNow(): Promise<ProviderFileSyncResult> {
    const run = this.queue.then(() => this.reconcile()).catch((error: unknown) => {
      this.log(`Provider file sync failed: ${error instanceof Error ? error.message : String(error)}`);
      return EMPTY_RESULT;
    });
    this.queue = run.then(() => EMPTY_RESULT, () => EMPTY_RESULT);
    return run;
  }

  private async contentHash(): Promise<string | null> {
    const parts: string[] = [];
    for (const filePath of [this.paths.modelsPath, this.paths.authPath]) {
      try {
        parts.push(await fs.readFile(filePath, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') parts.push('');
        else return null;
      }
    }
    return createHash('sha256').update(parts.join('\u0000')).digest('hex');
  }

  private async reconcile(): Promise<ProviderFileSyncResult> {
    const hash = await this.contentHash();
    if (hash === null || hash === this.lastContentHash) return EMPTY_RESULT;
    const [modelsContent, authContent] = await Promise.all([
      fs.readFile(this.paths.modelsPath, 'utf8').then((content) => content, () => null),
      fs.readFile(this.paths.authPath, 'utf8').then((content) => content, () => null),
    ]);
    const diskProviders = modelsContent === null ? null : parseProvidersJson(modelsContent);
    // A missing or unreadable models.json must never unregister live providers:
    // treat it as "nothing to do" rather than "everything was removed".
    if (!diskProviders) {
      this.lastContentHash = hash;
      return EMPTY_RESULT;
    }
    // A half-written auth file must not revoke every live credential. A missing
    // file, unlike invalid JSON, is an explicit removal of the stored keys.
    let authValid = authContent === null;
    if (authContent !== null) {
      try {
        const parsed: unknown = JSON.parse(authContent);
        authValid = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
      } catch { /* Wait for the next completed file write. */ }
    }
    const diskKeys = authValid && authContent !== null ? parseAuthApiKeys(authContent) : new Map<string, string>();
    const modelsChanged = this.lastModelsContent !== null && this.lastModelsContent !== modelsContent;

    const runtimeIds = new Set(this.runtime.getProviders().map((provider) => provider.id));
    const diskIds = new Set(Object.keys(diskProviders));
    const registered: string[] = [];
    const keysApplied: string[] = [];
    const keysRemoved: string[] = [];
    const unregistered: string[] = [];

    for (const id of diskIds) {
      if (runtimeIds.has(id)) continue;
      try {
        this.runtime.registerProvider(id, diskProviders[id]!);
        this.registeredBySync.add(id);
        this.registeredConfigs.set(id, JSON.stringify(diskProviders[id]));
        registered.push(id);
      } catch (error) {
        this.log(`Provider "${id}" could not be registered: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Providers admitted after startup have an SDK registration overlay. Refresh
    // alone reloads the file but that old overlay still wins until updated.
    if (modelsChanged) {
      for (const id of this.registeredBySync) {
        if (!diskIds.has(id)) continue;
        const config = JSON.stringify(diskProviders[id]);
        if (this.registeredConfigs.get(id) === config) continue;
        try {
          // SDK re-registration merges omitted fields with the old overlay.
          // Remove it first so deleting a field on disk really deletes it live.
          this.runtime.unregisterProvider(id);
          this.runtime.registerProvider(id, diskProviders[id]!);
          this.registeredConfigs.set(id, config);
        } catch (error) {
          try {
            this.runtime.registerProvider(id, JSON.parse(this.registeredConfigs.get(id)!) as ProviderConfigInputLike);
          } catch { /* Keep the original error; the next file edit can retry. */ }
          this.log(`Provider "${id}" could not be updated: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    for (const id of diskIds) {
      const key = diskKeys.get(id);
      if (!key) continue;
      const isNewlyRegistered = registered.includes(id);
      if (!isNewlyRegistered && this.appliedKeys.get(id) === key) continue;
      try {
        await this.runtime.setRuntimeApiKey(id, key);
        this.appliedKeys.set(id, key);
        keysApplied.push(id);
      } catch (error) {
        this.log(`API key for "${id}" could not be applied: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    for (const id of [...this.appliedKeys.keys()]) {
      if (diskIds.has(id) && (!authValid || diskKeys.has(id))) continue;
      try {
        await this.runtime.removeRuntimeApiKey(id);
        this.appliedKeys.delete(id);
        keysRemoved.push(id);
      } catch (error) {
        this.log(`API key for "${id}" could not be removed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    for (const id of [...this.registeredBySync]) {
      if (diskIds.has(id)) continue;
      this.registeredBySync.delete(id);
      this.registeredConfigs.delete(id);
      this.appliedKeys.delete(id);
      if (!keysRemoved.includes(id)) {
        try {
          await this.runtime.removeRuntimeApiKey(id);
        } catch { /* The key may never have been stored; registration removal still applies. */ }
      }
      try {
        this.runtime.unregisterProvider(id);
        unregistered.push(id);
      } catch (error) {
        this.log(`Provider "${id}" could not be unregistered: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const changed = modelsChanged || registered.length > 0 || keysApplied.length > 0 || keysRemoved.length > 0 || unregistered.length > 0;
    this.lastContentHash = hash;
    this.lastModelsContent = modelsContent;
    if (!changed) return EMPTY_RESULT;
    try {
      await this.runtime.refresh({ allowNetwork: false });
    } catch (error) {
      this.log(`Model refresh after provider sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const result: ProviderFileSyncResult = { changed, registered, keysApplied, keysRemoved, unregistered };
    await this.onSync?.(result);
    return result;
  }
}
