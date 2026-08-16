import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

/**
 * Providers Fate UI ships built-in, registered on every ModelRuntime the app
 * creates. Registered configs compose below the user's models.json entries,
 * so a user who defines their own "CrofAI" block in the Fate provider store
 * still overrides these defaults completely.
 */
type BundledProviderConfig = Parameters<ModelRuntime['registerProvider']>[1];

interface CrofaiModelSnapshotEntry {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly cost: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
}

const CROFAI_PROVIDER_ID = 'CrofAI';
const CROFAI_BASE_URL = 'https://crof.ai/v1';
const CROFAI_API_KEY_ENV = 'CROFAI_API_KEY';
const CROFAI_CATALOG_URL = `${CROFAI_BASE_URL}/models`;
const CROFAI_CATALOG_TIMEOUT_MS = 10_000;
const CROFAI_CATALOG_MAX_MODELS = 200;

/** CrofAI reasoning-effort values mapped from pi thinking levels. */
const CROFAI_THINKING_LEVEL_MAP = {
  off: 'none',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
} as const;

/** Compatibility flags verified against CrofAI's OpenAI-compatible API. */
const CROFAI_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: true,
  supportsStrictMode: true,
  supportsOpenAIGrammarTools: false,
  maxTokensField: 'max_tokens',
  thinkingFormat: 'openai',
} as const;
type CrofaiModelCompat = NonNullable<NonNullable<NonNullable<BundledProviderConfig['models']>[number]>['compat']>;
const crofaiModelCompat = (): CrofaiModelCompat => ({ ...CROFAI_COMPAT });

/** Offline snapshot of https://crof.ai/v1/models, captured 2026-08-16.
 *  Costs are USD per million tokens. refreshModels() updates this on demand. */
const CROFAI_MODEL_SNAPSHOT: readonly CrofaiModelSnapshotEntry[] = [
  { id: 'deepseek-v3.2', name: 'CrofAI: DeepSeek: DeepSeek V3.2', reasoning: false, contextWindow: 163840, maxTokens: 163840, cost: { input: 0.18, output: 0.35, cacheRead: 0.04, cacheWrite: 0 } },
  { id: 'deepseek-v4-flash', name: 'CrofAI: DeepSeek: DeepSeek V4 Flash', reasoning: true, contextWindow: 1000000, maxTokens: 131072, cost: { input: 0.12, output: 0.21, cacheRead: 0.003, cacheWrite: 0 } },
  { id: 'deepseek-v4-flash-0731', name: 'CrofAI: DeepSeek: DeepSeek V4 Flash 0731', reasoning: true, contextWindow: 1000000, maxTokens: 131072, cost: { input: 0.12, output: 0.21, cacheRead: 0.003, cacheWrite: 0 } },
  { id: 'deepseek-v4-pro', name: 'CrofAI: DeepSeek: DeepSeek V4 Pro', reasoning: true, contextWindow: 1000000, maxTokens: 131072, cost: { input: 0.35, output: 0.8, cacheRead: 0.003, cacheWrite: 0 } },
  { id: 'deepseek-v4-pro-0813', name: 'CrofAI: DeepSeek: DeepSeek V4 Pro 0813', reasoning: true, contextWindow: 1000000, maxTokens: 131072, cost: { input: 0.35, output: 0.8, cacheRead: 0.01, cacheWrite: 0 } },
  { id: 'gemma-4-31b-it', name: 'CrofAI: Google: Gemma 4 31B', reasoning: true, contextWindow: 262144, maxTokens: 262144, cost: { input: 0.1, output: 0.3, cacheRead: 0.02, cacheWrite: 0 } },
  { id: 'glm-5.1', name: 'CrofAI: Z.ai: GLM 5.1', reasoning: true, contextWindow: 202752, maxTokens: 202752, cost: { input: 0.45, output: 2.15, cacheRead: 0.08, cacheWrite: 0 } },
  { id: 'glm-5.2', name: 'CrofAI: Z.ai: GLM 5.2', reasoning: true, contextWindow: 1000000, maxTokens: 131072, cost: { input: 0.15, output: 0.52, cacheRead: 0.02, cacheWrite: 0 } },
  { id: 'greg-1-mini', name: 'CrofAI: Crof: Greg 1 Mini', reasoning: false, contextWindow: 229376, maxTokens: 229376, cost: { input: 0.07, output: 0.15, cacheRead: 0.01, cacheWrite: 0 } },
  { id: 'greg-2-super', name: 'CrofAI: Crof: Greg 2 Super', reasoning: false, contextWindow: 229376, maxTokens: 229376, cost: { input: 1.5, output: 5, cacheRead: 0.25, cacheWrite: 0 } },
  { id: 'greg-2-ultra', name: 'CrofAI: Crof: Greg 2 Ultra', reasoning: false, contextWindow: 229376, maxTokens: 229376, cost: { input: 3, output: 10, cacheRead: 0.5, cacheWrite: 0 } },
  { id: 'greg-rp', name: 'CrofAI: Crof: Greg (Roleplay)', reasoning: false, contextWindow: 229376, maxTokens: 229376, cost: { input: 0.1, output: 0.3, cacheRead: 0.02, cacheWrite: 0 } },
  { id: 'kimi-k2.6', name: 'CrofAI: MoonshotAI: Kimi K2.6', reasoning: true, contextWindow: 262144, maxTokens: 262144, cost: { input: 0.5, output: 1.99, cacheRead: 0.05, cacheWrite: 0 } },
  { id: 'kimi-k2.7-code', name: 'CrofAI: MoonshotAI: Kimi K2.7 Code', reasoning: true, contextWindow: 262144, maxTokens: 262144, cost: { input: 0.55, output: 2.25, cacheRead: 0.05, cacheWrite: 0 } },
  { id: 'kimi-k3', name: 'CrofAI: MoonshotAI: Kimi K3', reasoning: true, contextWindow: 1000000, maxTokens: 262144, cost: { input: 2, output: 8, cacheRead: 0.25, cacheWrite: 0 } },
  { id: 'kimi-k3-eco', name: 'CrofAI: MoonshotAI: Kimi K3 (Eco)', reasoning: true, contextWindow: 1000000, maxTokens: 131072, cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 } },
  { id: 'mimo-v2.5-pro', name: 'CrofAI: Xiaomi: MiMo-V2.5-Pro', reasoning: true, contextWindow: 1000000, maxTokens: 131072, cost: { input: 0.4, output: 0.8, cacheRead: 0.003, cacheWrite: 0 } },
  { id: 'qwen3.5-397b-a17b', name: 'CrofAI: Qwen: Qwen3.5 397B A17B', reasoning: true, contextWindow: 262144, maxTokens: 262144, cost: { input: 0.35, output: 1.75, cacheRead: 0.07, cacheWrite: 0 } },
  { id: 'qwen3.5-9b', name: 'CrofAI: Qwen: Qwen3.5 9B', reasoning: true, contextWindow: 262144, maxTokens: 262144, cost: { input: 0.04, output: 0.15, cacheRead: 0.008, cacheWrite: 0 } },
  { id: 'qwen3.6-27b', name: 'CrofAI: Qwen: Qwen3.6 27B', reasoning: true, contextWindow: 262144, maxTokens: 262144, cost: { input: 0.2, output: 1.5, cacheRead: 0.04, cacheWrite: 0 } },
];

function positiveIntegerOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function nonNegativeNumberOr(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Map one CrofAI /v1/models catalog entry to a pi model config. */
export function crofaiModelFromCatalogEntry(entry: {
  id?: unknown;
  name?: unknown;
  reasoning_effort?: unknown;
  context_length?: unknown;
  max_completion_tokens?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown; cache_prompt?: unknown } | null;
}): NonNullable<BundledProviderConfig['models']>[number] | null {
  if (typeof entry.id !== 'string' || !entry.id.trim()) return null;
  const reasoning = entry.reasoning_effort === true;
  const catalogName = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : entry.id;
  return {
    id: entry.id,
    name: `CrofAI: ${catalogName}`,
    reasoning,
    input: ['text'],
    contextWindow: positiveIntegerOr(entry.context_length, 128000),
    maxTokens: positiveIntegerOr(entry.max_completion_tokens, 16384),
    cost: {
      input: nonNegativeNumberOr(entry.pricing?.prompt),
      output: nonNegativeNumberOr(entry.pricing?.completion),
      cacheRead: nonNegativeNumberOr(entry.pricing?.cache_prompt),
      cacheWrite: 0,
    },
    ...(reasoning ? { thinkingLevelMap: { ...CROFAI_THINKING_LEVEL_MAP } } : {}),
    compat: crofaiModelCompat(),
  };
}

function crofaiSnapshotModels(): NonNullable<BundledProviderConfig['models']> {
  return CROFAI_MODEL_SNAPSHOT.map((entry) => ({
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: ['text' as const],
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    cost: { ...entry.cost },
    ...(entry.reasoning ? { thinkingLevelMap: { ...CROFAI_THINKING_LEVEL_MAP } } : {}),
    compat: crofaiModelCompat(),
  }));
}

/** Parse an OpenAI-style model list payload into CrofAI model configs. */
export function parseCrofaiCatalog(payload: unknown): NonNullable<BundledProviderConfig['models']> {
  const data = payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
    ? (payload as { data: unknown[] }).data
    : [];
  return data
    .slice(0, CROFAI_CATALOG_MAX_MODELS)
    .flatMap((entry) => {
      const mapped = entry && typeof entry === 'object' ? crofaiModelFromCatalogEntry(entry as Parameters<typeof crofaiModelFromCatalogEntry>[0]) : null;
      return mapped ? [mapped] : [];
    });
}

async function fetchCrofaiCatalog(): Promise<NonNullable<BundledProviderConfig['models']>> {
  const response = await fetch(CROFAI_CATALOG_URL, { signal: AbortSignal.timeout(CROFAI_CATALOG_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`CrofAI catalog request failed: HTTP ${response.status}`);
  const models = parseCrofaiCatalog(await response.json());
  if (models.length === 0) throw new Error('CrofAI catalog returned no usable models.');
  return models;
}

export function crofaiProviderConfig(): BundledProviderConfig {
  return {
    name: 'CrofAI',
    baseUrl: CROFAI_BASE_URL,
    apiKey: `$${CROFAI_API_KEY_ENV}`,
    api: 'openai-completions',
    models: crofaiSnapshotModels(),
    refreshModels: async () => {
      try {
        return await fetchCrofaiCatalog();
      } catch {
        // Offline or blocked: keep the shipped snapshot instead of failing the refresh.
        return crofaiSnapshotModels();
      }
    },
  };
}

/** Register every provider Fate UI ships with the shared ModelRuntime. */
export function registerBundledModelProviders(runtime: ModelRuntime): void {
  runtime.registerProvider(CROFAI_PROVIDER_ID, crofaiProviderConfig());
}
