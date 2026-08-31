/**
 * Pure parsing and mapping for the models.dev provider catalog
 * (https://models.dev/api.json).
 *
 * models.dev is a community-maintained catalog of AI providers, their models,
 * capabilities, pricing, and API endpoints. Fate UI uses it to power the
 * "Add Provider" picker and to seed the model list of every user-added
 * provider. OpenAI-compatible providers then overlay the provider's own
 * /v1/models list so ids that models.dev has not listed yet still appear.
 * models.dev metadata wins on overlap.
 *
 * This module is pure: no fs, no network. Everything is defensively parsed
 * because the payload is third-party data.
 */

/** Pi streaming API kinds a models.dev adapter maps onto. */
export type PiApiKind =
  | 'openai-completions'
  | 'anthropic-messages'
  | 'google-generative-ai'
  | 'google-vertex'
  | 'bedrock-converse-stream'
  | 'mistral-conversations';

/** Hard caps for one provider generated from models.dev data. */
export const MAX_MODELS_PER_PROVIDER = 500;

/** Verified-safe compat defaults for OpenAI-compatible aggregators. */
const OPENAI_COMPAT_DEFAULTS = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: true,
  maxTokensField: 'max_tokens',
  thinkingFormat: 'openai',
} as const;

/** Map a models.dev npm adapter to the pi streaming API kind. */
export function mapApiKind(npm: string | undefined): PiApiKind {
  switch (npm) {
    case '@ai-sdk/anthropic':
    case '@ai-sdk/google-vertex/anthropic':
      return 'anthropic-messages';
    case '@ai-sdk/google':
      return 'google-generative-ai';
    case '@ai-sdk/google-vertex':
      return 'google-vertex';
    case '@ai-sdk/amazon-bedrock':
      return 'bedrock-converse-stream';
    case '@ai-sdk/mistral':
      return 'mistral-conversations';
    default:
      // 150+ models.dev providers are plain OpenAI-compatible; the catch-all
      // also covers @ai-sdk/openai, groq, together, deepseek, xai, and friends.
      return 'openai-completions';
  }
}

/** Pi thinking levels in effort order. */
const PI_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type PiThinkingLevel = (typeof PI_LEVELS)[number];
export type ThinkingLevelMap = Partial<Record<PiThinkingLevel, string | null>>;

/** Effort rank on a shared 0..6 scale; unknown names are ranked later. */
const EFFORT_RANK: Record<string, number> = {
  none: 0, disabled: 0, minimal: 1, low: 2, medium: 3, default: 3, high: 4, xhigh: 5, max: 6,
};
const PI_LEVEL_RANK: Record<PiThinkingLevel, number> = {
  off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6,
};

function rankedEffortValues(values: readonly string[]): Array<{ value: string; rank: number }> {
  const ranked = values.map((value) => ({ value, rank: EFFORT_RANK[value] ?? -1 }));
  // Unknown effort names get a rank interpolated between their known
  // neighbours by position, so exotic scales still map monotonically.
  for (let index = 0; index < ranked.length; index += 1) {
    if (ranked[index]!.rank >= 0) continue;
    let previous = index - 1;
    while (previous >= 0 && ranked[previous]!.rank < 0) previous -= 1;
    let next = index + 1;
    while (next < ranked.length && ranked[next]!.rank < 0) next += 1;
    const below = previous >= 0 ? ranked[previous]!.rank : 0;
    const above = next < ranked.length ? ranked[next]!.rank : 6;
    const spread = above - below;
    const gap = Math.max(1, next - previous - 1);
    const step = Math.min(5, Math.max(1, Math.round(spread / gap)));
    ranked[index] = { value: ranked[index]!.value, rank: Math.min(6, below + step) };
  }
  return ranked;
}

/**
 * Map a models.dev effort value list onto a pi thinkingLevelMap.
 * Each pi level gets the nearest provider value; ties prefer the stronger
 * value, except `off` which only maps to a genuine rank-0 value so unsupported
 * "disable thinking" is hidden instead of silently enabling it.
 * Returns undefined when the model exposes no effort scale; pi then uses its
 * default reasoning handling.
 */
export function buildThinkingLevelMap(values: readonly string[]): ThinkingLevelMap | undefined {
  if (values.length === 0) return undefined;
  const ranked = rankedEffortValues(values);
  const map: ThinkingLevelMap = {};
  for (const level of PI_LEVELS) {
    if (level === 'off') {
      const none = ranked.find((entry) => entry.rank === 0);
      map.off = none ? none.value : null;
      continue;
    }
    const target = PI_LEVEL_RANK[level];
    let best: { value: string; rank: number } | null = null;
    for (const entry of ranked) {
      if (!best) { best = entry; continue; }
      const bestDistance = Math.abs(best.rank - target);
      const entryDistance = Math.abs(entry.rank - target);
      if (entryDistance < bestDistance || (entryDistance === bestDistance && entry.rank > best.rank)) best = entry;
    }
    map[level] = best ? best.value : null;
  }
  return map;
}

/** The effort values of a model's first `type: "effort"` reasoning option. */
export function effortValuesOf(model: ModelsDevModelEntry): string[] {
  const options = Array.isArray(model.reasoning_options) ? model.reasoning_options : [];
  for (const option of options) {
    if (!option || typeof option !== 'object' || (option as { type?: unknown }).type !== 'effort') continue;
    const values = (option as { values?: unknown }).values;
    if (Array.isArray(values) && values.length > 0 && values.every((value) => typeof value === 'string' && value.trim() !== '')) {
      return values.slice(0, 20).map((value) => (value as string).trim());
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Raw payload shapes (all fields optional; validated on read)
// ---------------------------------------------------------------------------

export interface ModelsDevModelEntry {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly reasoning?: unknown;
  readonly reasoning_options?: unknown;
  readonly tool_call?: unknown;
  readonly structured_output?: unknown;
  readonly attachment?: unknown;
  readonly modalities?: unknown;
  readonly limit?: unknown;
  readonly cost?: unknown;
}

export interface ModelsDevProviderEntry {
  readonly id?: unknown;
  readonly name?: unknown;
  /** Base URL of the provider API (for example "https://crof.ai/v1"). */
  readonly api?: unknown;
  readonly doc?: unknown;
  readonly env?: unknown;
  readonly npm?: unknown;
  readonly models?: unknown;
}

/** One validated provider with its raw models, ready for mapping. */
export interface ParsedModelsDevProvider {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly envVar: string | null;
  readonly npm: string | null;
  readonly docUrl: string | null;
  readonly models: readonly ModelsDevModelEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function httpsUrlOrNull(value: unknown): string | null {
  const raw = stringOrNull(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Validate one provider entry from api.json. Returns null when unusable. */
export function parseProviderEntry(id: string, entry: unknown): ParsedModelsDevProvider | null {
  if (!isRecord(entry)) return null;
  const baseUrl = httpsUrlOrNull(entry.api);
  if (!baseUrl) return null;
  const rawModels = entry.models;
  if (!isRecord(rawModels)) return null;
  const models: ModelsDevModelEntry[] = [];
  for (const model of Object.values(rawModels)) {
    if (!isRecord(model)) continue;
    if (typeof model.id !== 'string' || !model.id.trim()) continue;
    models.push(model as unknown as ModelsDevModelEntry & { id: string });
  }
  if (models.length === 0) return null;
  const env = Array.isArray(entry.env) ? entry.env.find((value): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value)) : undefined;
  return {
    id,
    name: stringOrNull(entry.name) ?? id,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    envVar: env ?? null,
    npm: stringOrNull(entry.npm),
    docUrl: httpsUrlOrNull(entry.doc),
    models,
  };
}

/** Parse the full api.json payload into validated providers keyed by id. */
export function parseModelsDevCatalog(payload: unknown): Map<string, ParsedModelsDevProvider> {
  const providers = new Map<string, ParsedModelsDevProvider>();
  if (!isRecord(payload)) return providers;
  for (const [id, entry] of Object.entries(payload)) {
    if (!id.trim()) continue;
    const parsed = parseProviderEntry(id, entry);
    if (parsed) providers.set(id, parsed);
  }
  return providers;
}

// ---------------------------------------------------------------------------
// pi model config generation (models.json compatible)
// ---------------------------------------------------------------------------

export interface GeneratedPiModel {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly input: readonly ('text' | 'image')[];
  readonly cost: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly thinkingLevelMap?: ThinkingLevelMap;
  readonly compat?: Record<string, unknown>;
}

export interface GeneratedPiProviderConfig {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly api: PiApiKind;
  readonly models: readonly GeneratedPiModel[];
}

function nonNegative(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function positiveIntegerOr(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

/** Map one models.dev model entry into a pi models.json model object. */
export function mapModel(providerName: string, apiKind: PiApiKind, model: ModelsDevModelEntry & { id: string }): GeneratedPiModel {
  const reasoning = model.reasoning === true;
  const modalities = isRecord(model.modalities) && Array.isArray(model.modalities.input) ? model.modalities.input : [];
  const imageInput = model.attachment === true || modalities.includes('image');
  const limit = isRecord(model.limit) ? model.limit : {};
  const cost = isRecord(model.cost) ? model.cost : {};
  const modelName = stringOrNull(model.name) ?? model.id;
  const effortValues = reasoning ? effortValuesOf(model) : [];
  const thinkingLevelMap = effortValues.length > 0 ? buildThinkingLevelMap(effortValues) : undefined;
  return {
    id: model.id,
    name: `${providerName}: ${modelName}`,
    reasoning,
    input: imageInput ? ['text', 'image'] : ['text'],
    cost: {
      input: nonNegative(cost.input),
      output: nonNegative(cost.output),
      cacheRead: nonNegative(cost.cache_read),
      cacheWrite: nonNegative(cost.cache_write),
    },
    contextWindow: positiveIntegerOr(limit.context, 128_000),
    maxTokens: positiveIntegerOr(limit.output, 16_384),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(apiKind === 'openai-completions'
      ? { compat: { ...OPENAI_COMPAT_DEFAULTS, supportsStrictMode: model.structured_output === true } }
      : {}),
  };
}

/** Sort key for stable model ordering. */
function modelSortKey(model: ModelsDevModelEntry & { id: string }): string {
  return model.id.toLowerCase();
}

/** Frozen identity fields applied over the live catalog entry on refresh. */
export interface ProviderIdentityOverrides {
  readonly name?: string;
  readonly baseUrl?: string;
  readonly envVar?: string | null;
  readonly api?: PiApiKind;
}

/**
 * Build the full pi provider config (models.json shape) for one models.dev
 * provider. Models are capped and sorted; the API key stays an env-var
 * reference so no secret is ever written to models.json. Overrides pin the
 * user's add-time identity when refreshing a managed provider.
 */
export function buildProviderConfig(provider: ParsedModelsDevProvider, overrides: ProviderIdentityOverrides = {}): GeneratedPiProviderConfig {
  const apiKind = overrides.api ?? mapApiKind(provider.npm ?? undefined);
  const providerName = overrides.name ?? provider.name;
  const baseUrl = (overrides.baseUrl ?? provider.baseUrl).replace(/\/+$/, '');
  const envVar = overrides.envVar !== undefined ? overrides.envVar : provider.envVar;
  const models = provider.models
    .filter((model): model is ModelsDevModelEntry & { id: string } => typeof model.id === 'string' && model.id.trim() !== '')
    .sort((left, right) => modelSortKey(left).localeCompare(modelSortKey(right)))
    .slice(0, MAX_MODELS_PER_PROVIDER)
    .map((model) => mapModel(providerName, apiKind, model));
  return {
    id: provider.id,
    name: providerName,
    baseUrl,
    ...(envVar ? { apiKey: `$${envVar}` } : {}),
    api: apiKind,
    models,
  };
}

/** One model advertised by an OpenAI-compatible GET /v1/models payload. */
export interface LiveOpenAiModel {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly cost: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
}

function parseLooseNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, '').trim());
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

/** Parse an OpenAI-style `{ data: [...] }` or `{ models: [...] }` catalog. */
export function parseLiveOpenAiModels(payload: unknown): LiveOpenAiModel[] {
  if (!isRecord(payload)) return [];
  const entries = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];
  const models: LiveOpenAiModel[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const id = stringOrNull(entry.id)?.trim();
    if (!id || id.length > 200 || seen.has(id)) continue;
    seen.add(id);
    const pricing = isRecord(entry.pricing) ? entry.pricing : {};
    const reasoning = entry.reasoning === true || entry.custom_reasoning === true || entry.reasoning_effort === true;
    models.push({
      id,
      name: stringOrNull(entry.name) ?? id,
      reasoning,
      contextWindow: positiveIntegerOr(parseLooseNumber(entry.context_length), 128_000),
      maxTokens: positiveIntegerOr(parseLooseNumber(entry.max_completion_tokens ?? entry.max_tokens), 16_384),
      cost: {
        input: nonNegative(parseLooseNumber(pricing.prompt ?? pricing.input)),
        output: nonNegative(parseLooseNumber(pricing.completion ?? pricing.output)),
        cacheRead: nonNegative(parseLooseNumber(pricing.cache_prompt ?? pricing.cache_read)),
        cacheWrite: nonNegative(parseLooseNumber(pricing.cache_write)),
      },
    });
  }
  return models;
}

export function mapLiveOpenAiModel(providerName: string, live: LiveOpenAiModel): GeneratedPiModel {
  return {
    id: live.id,
    name: `${providerName}: ${live.name}`,
    reasoning: live.reasoning,
    input: ['text'],
    cost: live.cost,
    contextWindow: live.contextWindow,
    maxTokens: live.maxTokens,
    compat: { ...OPENAI_COMPAT_DEFAULTS, supportsReasoningEffort: live.reasoning, supportsStrictMode: false },
  };
}

/**
 * Overlay a live /v1/models list onto a models.dev-built config.
 * Live ids are the source of truth. Overlapping ids keep models.dev metadata.
 */
export function mergeLiveOpenAiModels(config: GeneratedPiProviderConfig, live: readonly LiveOpenAiModel[]): GeneratedPiProviderConfig {
  if (live.length === 0) return config;
  const catalogById = new Map(config.models.map((model) => [model.id, model]));
  const merged: GeneratedPiModel[] = [];
  const seen = new Set<string>();
  for (const entry of live) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(catalogById.get(entry.id) ?? mapLiveOpenAiModel(config.name, entry));
  }
  merged.sort((left, right) => left.id.toLowerCase().localeCompare(right.id.toLowerCase()));
  return { ...config, models: merged.slice(0, MAX_MODELS_PER_PROVIDER) };
}
