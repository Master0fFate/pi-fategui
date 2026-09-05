import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ModelsDevProviderDetail, ModelsDevProviderSummary } from '../../../shared/contracts/ipc';
import { ModelsDevStore, type ModelsDevRegistryEntry } from './ModelsDevStore';
import {
  buildProviderConfig,
  effortValuesOf,
  mapApiKind,
  mergeLiveOpenAiModels,
  parseLiveOpenAiModels,
  parseModelsDevCatalog,
  type GeneratedPiProviderConfig,
  type ParsedModelsDevProvider,
} from './ModelsDevCatalog';

/**
 * Network-facing service over the models.dev catalog (https://models.dev).
 *
 * Rules (agreed product behaviour):
 * - The Add Provider picker always fetches the FULL live catalog from
 *   models.dev. Nothing about the picker is cached.
 * - Adding a provider writes its model list into models.json; that file is
 *   the local cache. OpenAI-compatible providers then overlay GET /v1/models
 *   so the live provider list wins over a stale models.dev snapshot.
 * - `refreshManagedProviders` runs once per Fate GUI start (main bootstrap,
 *   not per agent runtime). Offline or failed refreshes keep the cached list.
 * - PI_OFFLINE disables every network call.
 */

export const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const FETCH_TIMEOUT_MS = 12_000;
const LIVE_MODELS_TIMEOUT_MS = 8_000;
const MAX_PAYLOAD_BYTES = 24 * 1024 * 1024;
const LIVE_MODELS_MAX_BYTES = 2 * 1024 * 1024;
/** Crof (and similar WAFs) reject /v1/models with HTTP 403 when User-Agent is missing. */
const LIVE_MODELS_USER_AGENT = 'pi/0.85.0 (Fate UI)';

export type ModelsDevFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface ModelsDevServiceOptions {
  readonly store?: ModelsDevStore;
  readonly fetchImpl?: ModelsDevFetch;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export class ModelsDevError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelsDevError';
  }
}

function isOffline(): boolean {
  const value = process.env.PI_OFFLINE?.trim();
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

export class ModelsDevService {
  private readonly store: ModelsDevStore;
  private readonly fetchImpl: ModelsDevFetch;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private inflight: Promise<Map<string, ParsedModelsDevProvider>> | null = null;

  constructor(options: ModelsDevServiceOptions = {}) {
    this.store = options.store ?? new ModelsDevStore();
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as ReturnType<ModelsDevFetch>);
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  /** Fetch and parse api.json. Concurrent calls share one request. */
  fetchCatalog(signal?: AbortSignal): Promise<Map<string, ParsedModelsDevProvider>> {
    if (isOffline()) return Promise.reject(new ModelsDevError('models.dev is disabled because PI_OFFLINE is set.'));
    if (!this.inflight) {
      this.inflight = this.fetchCatalogOnce(signal)
        .catch((error: unknown) => {
          this.inflight = null;
          throw error;
        })
        .then((catalog) => {
          this.inflight = null;
          return catalog;
        });
    }
    return this.inflight;
  }

  private async fetchCatalogOnce(signal?: AbortSignal): Promise<Map<string, ParsedModelsDevProvider>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('models.dev request timed out')), FETCH_TIMEOUT_MS);
    const abortWithParent = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortWithParent();
    else signal?.addEventListener('abort', abortWithParent, { once: true });
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    let response: Awaited<ReturnType<ModelsDevFetch>>;
    try {
      response = await this.fetchImpl(MODELS_DEV_API_URL, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new ModelsDevError(`models.dev responded with HTTP ${response.status}.`);
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_PAYLOAD_BYTES) throw new ModelsDevError('models.dev response exceeded the 24 MB safety limit.');
    try {
      return parseModelsDevCatalog(JSON.parse(new TextDecoder().decode(body)));
    } catch {
      throw new ModelsDevError('models.dev returned data that Fate UI could not parse.');
    }
  }

  private requireProvider(catalog: Map<string, ParsedModelsDevProvider>, providerId: string): ParsedModelsDevProvider {
    const provider = catalog.get(providerId);
    if (!provider) throw new ModelsDevError(`"${providerId}" is not in the models.dev catalog anymore.`);
    return provider;
  }

  /**
   * Live picker list. `existingProviderIds` (native pi providers plus anything
   * already in models.json) and managed registry ids decide the row status.
   */
  async listProviders(existingProviderIds: ReadonlySet<string>): Promise<{ providers: Array<{ summary: ModelsDevProviderSummary; provider: ParsedModelsDevProvider }>; fetchedAt: number }> {
    const catalog = await this.fetchCatalog();
    const registry = await this.store.readRegistry();
    const rows: Array<{ summary: import('../../../shared/contracts/ipc').ModelsDevProviderSummary; provider: ParsedModelsDevProvider }> = [];
    for (const provider of catalog.values()) {
      const status = provider.id in registry.providers ? 'managed' : existingProviderIds.has(provider.id) ? 'configured' : 'available';
      rows.push({
        provider,
        summary: {
          id: provider.id,
          name: provider.name,
          modelCount: provider.models.length,
          envVar: provider.envVar,
          baseUrl: provider.baseUrl,
          api: mapApiKind(provider.npm ?? undefined),
          docUrl: provider.docUrl,
          status,
        },
      });
    }
    rows.sort((left, right) => left.summary.name.localeCompare(right.summary.name));
    return { providers: rows, fetchedAt: this.now() };
  }

  /** Full provider detail for the confirm step. */
  async getProviderDetail(providerId: string): Promise<ModelsDevProviderDetail & { provider: ParsedModelsDevProvider }> {
    const catalog = await this.fetchCatalog();
    const provider = this.requireProvider(catalog, providerId);
    const api = mapApiKind(provider.npm ?? undefined);
    const models = provider.models
      .filter((model): model is typeof model & { id: string } => typeof model.id === 'string' && model.id.trim() !== '')
      .sort((left, right) => left.id.toLowerCase().localeCompare(right.id.toLowerCase()))
      .slice(0, 500)
      .map((model) => {
        const reasoning = model.reasoning === true;
        const modalities = typeof model.modalities === 'object' && model.modalities !== null && Array.isArray((model.modalities as { input?: unknown }).input)
          ? (model.modalities as { input: unknown[] }).input
          : [];
        const limit = typeof model.limit === 'object' && model.limit !== null ? model.limit as Record<string, unknown> : {};
        const cost = typeof model.cost === 'object' && model.cost !== null ? model.cost as Record<string, unknown> : {};
        return {
          id: model.id,
          name: typeof model.name === 'string' && model.name.trim() ? model.name : model.id,
          reasoning,
          toolCall: model.tool_call === true,
          structuredOutput: model.structured_output === true,
          imageInput: model.attachment === true || modalities.includes('image'),
          contextWindow: typeof limit.context === 'number' && limit.context >= 1 ? Math.floor(limit.context) : 128_000,
          maxTokens: typeof limit.output === 'number' && limit.output >= 1 ? Math.floor(limit.output) : 16_384,
          effortValues: reasoning ? effortValuesOf(model) : [],
          costInput: typeof cost.input === 'number' && cost.input >= 0 ? cost.input : 0,
          costOutput: typeof cost.output === 'number' && cost.output >= 0 ? cost.output : 0,
        };
      });
    return { id: provider.id, name: provider.name, baseUrl: provider.baseUrl, envVar: provider.envVar, api, docUrl: provider.docUrl, models, provider };
  }

  private async readStoredApiKey(providerId: string): Promise<string | null> {
    try {
      const content = await fs.readFile(path.join(this.store.storePaths.dataRoot, 'auth.json'), 'utf-8');
      const parsed: unknown = JSON.parse(content);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const entry = (parsed as Record<string, unknown>)[providerId];
      if (typeof entry !== 'object' || entry === null) return null;
      const record = entry as { type?: unknown; key?: unknown };
      if (record.type === 'api_key' && typeof record.key === 'string' && record.key.trim()) return record.key.trim();
      return null;
    } catch {
      return null;
    }
  }

  private async fetchLiveOpenAiModels(baseUrl: string, apiKey: string): Promise<ReturnType<typeof parseLiveOpenAiModels>> {
    if (isOffline()) return [];
    const url = `${baseUrl.replace(/\/+$/, '')}/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('provider models request timed out')), LIVE_MODELS_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
          'user-agent': LIVE_MODELS_USER_AGENT,
        },
      });
      if (!response.ok) return [];
      const body = await response.arrayBuffer();
      if (body.byteLength > LIVE_MODELS_MAX_BYTES) return [];
      return parseLiveOpenAiModels(JSON.parse(new TextDecoder().decode(body)));
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private async applyLiveOpenAiOverlay(config: GeneratedPiProviderConfig, apiKey?: string): Promise<GeneratedPiProviderConfig> {
    if (config.api !== 'openai-completions') return config;
    const envName = config.apiKey?.startsWith('$') ? config.apiKey.slice(1) : '';
    const fromEnv = envName ? process.env[envName]?.trim() : '';
    const key = apiKey?.trim() || (await this.readStoredApiKey(config.id)) || fromEnv || '';
    if (!key) return config;
    const live = await this.fetchLiveOpenAiModels(config.baseUrl, key);
    if (live.length === 0) {
      this.log(`Live /v1/models for "${config.id}" returned no models; keeping the models.dev list.`);
      return config;
    }
    const merged = mergeLiveOpenAiModels(config, live);
    this.log(`Merged live /v1/models for "${config.id}": ${config.models.length} catalog → ${merged.models.length} live.`);
    return merged;
  }

  /** Add a provider: fetch live data, write models.json + registry. */
  async addProvider(providerId: string, options: { apiKey?: string | undefined } = {}): Promise<{ config: GeneratedPiProviderConfig; entry: ModelsDevRegistryEntry }> {
    const catalog = await this.fetchCatalog();
    const provider = this.requireProvider(catalog, providerId);
    const config = await this.applyLiveOpenAiOverlay(buildProviderConfig(provider), options.apiKey);
    if (config.models.length === 0) throw new ModelsDevError(`"${providerId}" exposes no usable models on models.dev.`);
    const timestamp = this.now();
    const entry: ModelsDevRegistryEntry = {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      envVar: provider.envVar,
      api: config.api,
      npm: provider.npm,
      docUrl: provider.docUrl,
      addedAt: timestamp,
      checkedAt: timestamp,
      modelCount: config.models.length,
    };
    await this.store.upsertProviderConfig(config);
    await this.store.upsertRegistryEntry(entry);
    this.log(`Added models.dev provider "${provider.id}" with ${config.models.length} models.`);
    return { config, entry };
  }

  /** Remove a managed provider from models.json + registry. */
  async removeProvider(providerId: string): Promise<void> {
    const removed = await this.store.removeRegistryEntry(providerId);
    if (!removed) throw new ModelsDevError(`"${providerId}" is not a models.dev-managed provider.`);
    await this.store.removeProviderConfig(providerId);
    this.log(`Removed models.dev provider "${providerId}".`);
  }

  /** All managed providers from the registry, sorted by name. No network. */
  async managedProviders(): Promise<ModelsDevRegistryEntry[]> {
    const registry = await this.store.readRegistry();
    return Object.values(registry.providers).sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * GUI-start refresh: fetch the catalog once and regenerate the model list
   * of every managed provider. Identity fields (baseUrl, api kind, env var)
   * stay frozen at their add-time values. Offline or failed refreshes keep
   * the cached lists. Never throws.
   */
  async refreshManagedProviders(): Promise<Array<{ id: string; config: GeneratedPiProviderConfig }>> {
    const registry = await this.store.readRegistry();
    const ids = Object.keys(registry.providers);
    if (ids.length === 0) return [];
    let catalog: Map<string, ParsedModelsDevProvider>;
    try {
      catalog = await this.fetchCatalog();
    } catch (error) {
      this.log(`models.dev refresh skipped: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    const updated: Array<{ id: string; config: GeneratedPiProviderConfig }> = [];
    const timestamp = this.now();
    for (const id of ids) {
      const entry = registry.providers[id]!;
      const provider = catalog.get(id);
      if (!provider) {
        this.log(`models.dev no longer lists "${id}"; keeping the cached model list.`);
        continue;
      }
      // Identity stays as the user added it; only the model list refreshes.
      // Overlay GET /v1/models so ids missing from models.dev still appear.
      const config = await this.applyLiveOpenAiOverlay(buildProviderConfig(provider, {
        name: entry.name,
        baseUrl: entry.baseUrl,
        envVar: entry.envVar,
        api: entry.api as GeneratedPiProviderConfig['api'],
      }));
      if (config.models.length === 0) continue;
      try {
        await this.store.upsertProviderConfig(config);
        await this.store.upsertRegistryEntry({ ...entry, name: entry.name, checkedAt: timestamp, modelCount: config.models.length });
        updated.push({ id, config });
      } catch (error) {
        this.log(`models.dev refresh failed for "${id}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return updated;
  }
}
