import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fateDataRoot, fateProviderStoragePaths } from '../FateProviderStorage';
import type { GeneratedPiProviderConfig } from './ModelsDevCatalog';

/**
 * Persistence for models.dev-managed providers.
 *
 * Two Fate-owned files cooperate:
 * - `~/.pi/fateGUI/models.json`     The pi provider config. Managed providers
 *   are written here with their FULL model list, so every ModelRuntime (and a
 *   plain pi CLI pointed at this file) sees them offline. This file is the
 *   model-list cache: it is refreshed once per Fate GUI start from models.dev.
 * - `~/.pi/fateGUI/modelsdev.json`  The management registry: which provider
 *   ids Fate added, their frozen identity (baseUrl, api kind, env var), and
 *   the last successful catalog check time.
 *
 * Non-managed entries in models.json are never touched. Writes are atomic
 * (temp file + rename) with 0600 permissions where the platform allows it.
 */

export const MODELS_DEV_REGISTRY_VERSION = 1;

export interface ModelsDevRegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly envVar: string | null;
  readonly api: string;
  readonly npm: string | null;
  readonly docUrl: string | null;
  readonly addedAt: number;
  readonly checkedAt: number | null;
  readonly modelCount: number;
}

export interface ModelsDevRegistry {
  readonly version: number;
  readonly providers: Readonly<Record<string, ModelsDevRegistryEntry>>;
}

const EMPTY_REGISTRY: ModelsDevRegistry = { version: MODELS_DEV_REGISTRY_VERSION, providers: {} };

export interface ModelsDevStorePaths {
  readonly dataRoot: string;
  readonly registryPath: string;
  readonly modelsPath: string;
}

export class ModelsDevStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelsDevStoreError';
  }
}

/** Atomic JSON write: temp file in the same directory, then rename. */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await fs.writeFile(tempPath, content, { flag: 'wx', mode: 0o600 });
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isRegistryEntry(value: unknown): value is ModelsDevRegistryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<ModelsDevRegistryEntry>;
  return typeof entry.id === 'string' && entry.id.trim() !== ''
    && typeof entry.name === 'string' && entry.name.trim() !== ''
    && typeof entry.baseUrl === 'string' && entry.baseUrl.startsWith('http')
    && (entry.envVar === null || typeof entry.envVar === 'string')
    && typeof entry.api === 'string' && entry.api.trim() !== ''
    && typeof entry.addedAt === 'number' && Number.isFinite(entry.addedAt);
}

/** Parse the registry file. Corrupt or foreign content yields an empty registry. */
export function parseRegistry(content: string): ModelsDevRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return EMPTY_REGISTRY;
  }
  if (typeof parsed !== 'object' || parsed === null) return EMPTY_REGISTRY;
  const providers = (parsed as { providers?: unknown }).providers;
  if (typeof providers !== 'object' || providers === null) return EMPTY_REGISTRY;
  const valid: Record<string, ModelsDevRegistryEntry> = {};
  for (const [id, entry] of Object.entries(providers as Record<string, unknown>)) {
    if (isRegistryEntry(entry) && entry.id === id) valid[id] = entry;
  }
  return { version: MODELS_DEV_REGISTRY_VERSION, providers: valid };
}

/** Shape of models.json on disk: `{ "providers": { [id]: config } }`. */
export interface ModelsJsonFile {
  providers: Record<string, unknown>;
}

export class ModelsDevStore {
  private readonly paths: ModelsDevStorePaths;
  private registry: ModelsDevRegistry | null = null;

  constructor(dataRoot: string = fateDataRoot()) {
    this.paths = {
      dataRoot,
      registryPath: path.join(dataRoot, 'modelsdev.json'),
      modelsPath: fateProviderStoragePaths(dataRoot).modelsPath,
    };
  }

  get storePaths(): ModelsDevStorePaths {
    return this.paths;
  }

  /** Read (and cache) the management registry. Missing file is not an error. */
  async readRegistry(): Promise<ModelsDevRegistry> {
    if (this.registry) return this.registry;
    let content: string;
    try {
      content = await fs.readFile(this.paths.registryPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.registry = EMPTY_REGISTRY;
      throw error;
    }
    return this.registry = parseRegistry(content);
  }

  private async writeRegistry(registry: ModelsDevRegistry): Promise<void> {
    await writeJsonAtomic(this.paths.registryPath, registry);
    this.registry = registry;
  }

  async upsertRegistryEntry(entry: ModelsDevRegistryEntry): Promise<void> {
    const current = await this.readRegistry();
    await this.writeRegistry({
      version: MODELS_DEV_REGISTRY_VERSION,
      providers: { ...current.providers, [entry.id]: entry },
    });
  }

  async removeRegistryEntry(providerId: string): Promise<boolean> {
    const current = await this.readRegistry();
    if (!(providerId in current.providers)) return false;
    const { [providerId]: _removed, ...rest } = current.providers;
    await this.writeRegistry({ version: MODELS_DEV_REGISTRY_VERSION, providers: rest });
    return true;
  }

  /** Read models.json. A missing file yields an empty providers map. */
  async readModelsJson(): Promise<ModelsJsonFile> {
    let content: string;
    try {
      content = await fs.readFile(this.paths.modelsPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { providers: {} };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      // pi tolerates JSONC comments in models.json; Fate's writer does not.
      // Never clobber a file we cannot parse - surface it instead.
      throw new ModelsDevStoreError(
        `Fate UI could not read ${this.paths.modelsPath} because it is not valid JSON (${error instanceof Error ? error.message : String(error)}). Fix or remove the file manually, then try again.`,
      );
    }
    const providers = (parsed as { providers?: unknown })?.providers;
    if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) {
      throw new ModelsDevStoreError(`Fate UI could not read ${this.paths.modelsPath}: the "providers" field is missing or invalid.`);
    }
    return { providers: providers as Record<string, unknown> };
  }

  /** Write one managed provider into models.json, preserving all other entries. */
  async upsertProviderConfig(config: GeneratedPiProviderConfig): Promise<void> {
    const file = await this.readModelsJson();
    file.providers[config.id] = {
      name: config.name,
      baseUrl: config.baseUrl,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      api: config.api,
      models: config.models,
    };
    await writeJsonAtomic(this.paths.modelsPath, file);
  }

  /** Remove one managed provider from models.json, preserving all other entries. */
  async removeProviderConfig(providerId: string): Promise<void> {
    const file = await this.readModelsJson();
    delete file.providers[providerId];
    await writeJsonAtomic(this.paths.modelsPath, file);
  }
}
