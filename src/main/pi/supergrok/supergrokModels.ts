import { XAI_API_BASE_URL, defaultSuperGrokFetch, type SuperGrokFetch } from './supergrokOAuth';

/**
 * SuperGrok model catalog: a static seed that works before any sign-in, plus
 * the live xAI /v1/models list once OAuth credentials exist. Model mapping is
 * ported from pi-supergrok 0.2.2 (MIT).
 */

export interface SuperGrokModelConfig {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly input: readonly ('text' | 'image')[];
  readonly cost: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
  readonly contextWindow: number;
  readonly maxTokens: number;
}

/**
 * Models always offered by the supergrok provider, even before login or when
 * the live /v1/models endpoint does not list them yet. Live models are merged
 * in by id without overriding these.
 */
const STATIC_SUPERGROK_MODELS: readonly SuperGrokModelConfig[] = [
  { id: 'grok-4.20-0309-non-reasoning', name: 'Grok 4.20 Non-Reasoning (SuperGrok)', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 8_192 },
  { id: 'grok-4.20-0309-reasoning', name: 'Grok 4.20 Reasoning (SuperGrok)', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 8_192 },
  { id: 'grok-4.3', name: 'Grok 4.3 (SuperGrok)', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 8_192 },
  { id: 'grok-build-0.1', name: 'Grok Build 0.1 (SuperGrok)', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 8_192 },
  { id: 'grok-composer-2.5-fast', name: 'Grok Composer 2.5 Fast (SuperGrok)', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 8_192 },
];

export function supergrokStaticModels(): SuperGrokModelConfig[] {
  return STATIC_SUPERGROK_MODELS.map((model) => ({ ...model, input: [...model.input], cost: { ...model.cost } }));
}

/** Merge static models with live ones; static entries win on id conflicts. */
export function mergeSuperGrokModels(liveModels: readonly SuperGrokModelConfig[]): SuperGrokModelConfig[] {
  const models = supergrokStaticModels();
  for (const model of liveModels) {
    if (!models.some((existing) => existing.id === model.id)) models.push(model);
  }
  return models;
}

function numberFrom(raw: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function booleanFrom(raw: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function arrayIncludes(value: unknown, item: string): boolean | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.some((entry) => String(entry).toLowerCase() === item);
}

/** xAI prices per 10k tokens in some payloads; convert to per million. */
function xaiPriceFrom(raw: Record<string, unknown>, key: string): number | undefined {
  const value = numberFrom(raw, [key]);
  return value === undefined ? undefined : value / 10_000;
}

function costFrom(raw: Record<string, unknown>): SuperGrokModelConfig['cost'] {
  const pricing = typeof raw.pricing === 'object' && raw.pricing ? (raw.pricing as Record<string, unknown>) : raw;
  return {
    input: numberFrom(pricing, ['input', 'prompt', 'input_cost_per_million', 'prompt_cost_per_million']) ?? xaiPriceFrom(pricing, 'prompt_text_token_price') ?? 0,
    output: numberFrom(pricing, ['output', 'completion', 'output_cost_per_million', 'completion_cost_per_million']) ?? xaiPriceFrom(pricing, 'completion_text_token_price') ?? 0,
    cacheRead: numberFrom(pricing, ['cacheRead', 'cache_read', 'cache_read_cost_per_million']) ?? xaiPriceFrom(pricing, 'cached_prompt_text_token_price') ?? 0,
    cacheWrite: numberFrom(pricing, ['cacheWrite', 'cache_write', 'cache_write_cost_per_million']) ?? 0,
  };
}

export function supergrokDisplayName(id: string): string {
  return `${id.split(/[-_]/g).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')} (SuperGrok)`;
}

/** Map one raw /v1/models entry to a model config; undefined drops it. */
export function mapSuperGrokModel(raw: Record<string, unknown>): SuperGrokModelConfig | undefined {
  const id = String(raw.id ?? '').trim();
  if (!id) return undefined;
  // Chat Completions only: skip image/video generation and multi-agent entries.
  if (/image|video|imagine|multi-agent/i.test(id)) return undefined;
  const contextWindow = numberFrom(raw, ['context_window', 'contextWindow', 'max_context_window', 'maxContextWindow', 'context_length', 'contextLength']) ?? 131_072;
  const maxTokens = numberFrom(raw, ['max_output_tokens', 'maxOutputTokens', 'max_tokens', 'maxTokens']) ?? 8_192;
  const supportsImages = booleanFrom(raw, ['supports_images', 'supportsImages', 'vision', 'image']) ?? arrayIncludes(raw.input, 'image') ?? arrayIncludes(raw.capabilities, 'image') ?? true;
  const reasoning = booleanFrom(raw, ['reasoning', 'supports_reasoning', 'supportsReasoning']) ?? !/non[-_ ]?reasoning|code[-_ ]?fast|^grok-3(?:-|$)/i.test(id);
  return {
    id,
    name: String(raw.name ?? supergrokDisplayName(id)).trim(),
    reasoning,
    input: supportsImages ? ['text', 'image'] : ['text'],
    cost: costFrom(raw),
    contextWindow,
    maxTokens,
  };
}

/** Fetch the live model list with a SuperGrok OAuth access token. */
export async function fetchSuperGrokModels(accessToken: string, fetchImpl: SuperGrokFetch = defaultSuperGrokFetch, signal?: AbortSignal): Promise<SuperGrokModelConfig[]> {
  const response = await fetchImpl(`${XAI_API_BASE_URL}/models`, {
    headers: { accept: 'application/json', authorization: `Bearer ${accessToken}`, 'x-grok-source': 'pi-supergrok' },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`Failed to fetch xAI models: HTTP ${response.status} ${await response.text()}`);
  const payload = (await response.json()) as { data?: unknown };
  const entries = Array.isArray(payload.data) ? payload.data : [];
  return entries
    .map((entry) => (entry && typeof entry === 'object' ? mapSuperGrokModel(entry as Record<string, unknown>) : undefined))
    .filter((model): model is SuperGrokModelConfig => model !== undefined);
}
