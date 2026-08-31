import { describe, expect, it } from 'vitest';
import {
  buildProviderConfig,
  buildThinkingLevelMap,
  effortValuesOf,
  mapApiKind,
  mergeLiveOpenAiModels,
  parseLiveOpenAiModels,
  parseModelsDevCatalog,
  parseProviderEntry,
} from './ModelsDevCatalog';

function crofLikeProvider() {
  return {
    id: 'crof',
    name: 'CrofAI',
    api: 'https://crof.ai/v1',
    doc: 'https://crof.ai/docs',
    env: ['CROF_API_KEY'],
    npm: '@ai-sdk/openai-compatible',
    models: {
      'kimi-k3': {
        id: 'kimi-k3',
        name: 'Kimi K3',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high', 'max'] }],
        tool_call: true,
        structured_output: true,
        attachment: true,
        modalities: { input: ['text', 'image', 'video'], output: ['text'] },
        limit: { context: 1_000_000, output: 262_144 },
        cost: { input: 2, output: 8, cache_read: 0.25 },
      },
      'glm-4.7': {
        id: 'glm-4.7',
        name: 'GLM-4.7',
        reasoning: true,
        reasoning_options: [],
        tool_call: true,
        limit: { context: 202_752, output: 202_752 },
        cost: { input: 0.25, output: 1.1, cache_read: 0.05, cache_write: 0 },
      },
    },
  };
}

describe('mapApiKind', () => {
  it('maps known adapters to their pi streaming API', () => {
    expect(mapApiKind('@ai-sdk/anthropic')).toBe('anthropic-messages');
    expect(mapApiKind('@ai-sdk/google-vertex/anthropic')).toBe('anthropic-messages');
    expect(mapApiKind('@ai-sdk/google')).toBe('google-generative-ai');
    expect(mapApiKind('@ai-sdk/google-vertex')).toBe('google-vertex');
    expect(mapApiKind('@ai-sdk/amazon-bedrock')).toBe('bedrock-converse-stream');
    expect(mapApiKind('@ai-sdk/mistral')).toBe('mistral-conversations');
  });

  it('defaults everything else to OpenAI completions', () => {
    expect(mapApiKind('@ai-sdk/openai-compatible')).toBe('openai-completions');
    expect(mapApiKind('@ai-sdk/groq')).toBe('openai-completions');
    expect(mapApiKind(undefined)).toBe('openai-completions');
  });
});

describe('buildThinkingLevelMap', () => {
  it('maps a standard four-step scale', () => {
    expect(buildThinkingLevelMap(['none', 'low', 'medium', 'high'])).toEqual({
      off: 'none', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high',
    });
  });

  it('maps a none/low/high/max scale with xhigh promoted to max', () => {
    const map = buildThinkingLevelMap(['none', 'low', 'high', 'max'])!;
    expect(map.off).toBe('none');
    expect(map.minimal).toBe('low');
    expect(map.low).toBe('low');
    expect(map.medium).toBe('high');
    expect(map.high).toBe('high');
    expect(map.xhigh).toBe('max');
    expect(map.max).toBe('max');
  });

  it('hides off when thinking cannot be disabled', () => {
    const map = buildThinkingLevelMap(['low', 'medium', 'high'])!;
    expect(map.off).toBeNull();
    expect(map.minimal).toBe('low');
  });

  it('returns undefined for empty scales so pi uses its defaults', () => {
    expect(buildThinkingLevelMap([])).toBeUndefined();
  });

  it('ranks unknown effort names monotonically', () => {
    const map = buildThinkingLevelMap(['none', 'turbo', 'ultra'])!;
    expect(map.off).toBe('none');
    expect(map.medium).toBe('turbo');
    expect(map.high).toBe('turbo'); // turbo (rank 3) is nearer than ultra (rank 6)
    expect(map.xhigh).toBe('ultra');
    expect(map.max).toBe('ultra');
  });
});

describe('effortValuesOf', () => {
  it('reads the first effort option and ignores other option kinds', () => {
    const model = { reasoning_options: [{ type: 'boolean' }, { type: 'effort', values: ['none', 'high'] }] };
    expect(effortValuesOf(model)).toEqual(['none', 'high']);
  });

  it('returns empty for malformed values', () => {
    expect(effortValuesOf({ reasoning_options: [{ type: 'effort', values: ['ok', 42] }] })).toEqual([]);
    expect(effortValuesOf({})).toEqual([]);
  });
});

describe('parseProviderEntry and parseModelsDevCatalog', () => {
  it('validates provider entries', () => {
    expect(parseProviderEntry('crof', crofLikeProvider())).not.toBeNull();
    expect(parseProviderEntry('no-url', { ...crofLikeProvider(), api: undefined })).toBeNull();
    expect(parseProviderEntry('no-models', { ...crofLikeProvider(), models: {} })).toBeNull();
    expect(parseProviderEntry('bad-models', { ...crofLikeProvider(), models: 'nope' })).toBeNull();
    expect(parseProviderEntry('junk', 'junk')).toBeNull();
  });

  it('normalizes the base URL and reads the env var', () => {
    const parsed = parseProviderEntry('crof', crofLikeProvider())!;
    expect(parsed.baseUrl).toBe('https://crof.ai/v1');
    expect(parsed.envVar).toBe('CROF_API_KEY');
    expect(parsed.models).toHaveLength(2);
  });

  it('parses the full catalog and skips invalid entries', () => {
    const catalog = parseModelsDevCatalog({ crof: crofLikeProvider(), broken: { api: 'nope' } });
    expect(catalog.size).toBe(1);
    expect(catalog.has('crof')).toBe(true);
    expect(parseModelsDevCatalog('junk').size).toBe(0);
  });
});

describe('buildProviderConfig', () => {
  const parsed = parseProviderEntry('crof', crofLikeProvider())!;

  it('builds a models.json compatible provider with env-var key reference', () => {
    const config = buildProviderConfig(parsed);
    expect(config.id).toBe('crof');
    expect(config.name).toBe('CrofAI');
    expect(config.baseUrl).toBe('https://crof.ai/v1');
    expect(config.apiKey).toBe('$CROF_API_KEY');
    expect(config.api).toBe('openai-completions');
    expect(config.models).toHaveLength(2);
    expect(config.models[0]!.id).toBe('glm-4.7'); // sorted by id
  });

  it('maps model metadata: costs, limits, image input, effort map, compat', () => {
    const kimi = configModel(buildProviderConfig(parsed), 'kimi-k3');
    expect(kimi.name).toBe('CrofAI: Kimi K3');
    expect(kimi.reasoning).toBe(true);
    expect(kimi.input).toEqual(['text', 'image']); // video dropped, attachment true
    expect(kimi.cost).toEqual({ input: 2, output: 8, cacheRead: 0.25, cacheWrite: 0 });
    expect(kimi.contextWindow).toBe(1_000_000);
    expect(kimi.maxTokens).toBe(262_144);
    expect(kimi.thinkingLevelMap!.off).toBe('none');
    expect(kimi.thinkingLevelMap!.max).toBe('max');
    expect((kimi.compat as { supportsStrictMode?: boolean }).supportsStrictMode).toBe(true);
    expect((kimi.compat as { maxTokensField?: string }).maxTokensField).toBe('max_tokens');
  });

  it('leaves reasoning models without an effort scale on pi defaults', () => {
    const glm = configModel(buildProviderConfig(parsed), 'glm-4.7');
    expect(glm.reasoning).toBe(true);
    expect(glm.thinkingLevelMap).toBeUndefined();
  });

  it('honors frozen identity overrides on refresh', () => {
    const config = buildProviderConfig(parsed, { name: 'Renamed', baseUrl: 'https://proxy.example/v1/', envVar: 'OTHER_KEY', api: 'anthropic-messages' });
    expect(config.name).toBe('Renamed');
    expect(config.baseUrl).toBe('https://proxy.example/v1');
    expect(config.apiKey).toBe('$OTHER_KEY');
    expect(config.api).toBe('anthropic-messages');
    expect(config.models[0]!.compat).toBeUndefined(); // no openai compat on anthropic kind
  });
});

function configModel(config: ReturnType<typeof buildProviderConfig>, id: string) {
  const model = config.models.find((candidate) => candidate.id === id);
  if (!model) throw new Error(`missing model ${id}`);
  return model;
}

describe('parseLiveOpenAiModels and mergeLiveOpenAiModels', () => {
  it('parses OpenAI data arrays and string context lengths', () => {
    const parsed = parseLiveOpenAiModels({
      data: [
        { id: 'glm-5.3-flash', name: 'Z.ai: GLM 5.3 Flash', custom_reasoning: true, reasoning_effort: true, context_length: '1,000,000', max_completion_tokens: 131_072, pricing: { prompt: '0.07', completion: '0.22', cache_prompt: '0.01' } },
        { id: 'glm-5.3-flash' },
        { name: 'no-id' },
      ],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ id: 'glm-5.3-flash', reasoning: true, contextWindow: 1_000_000, maxTokens: 131_072, cost: { input: 0.07, output: 0.22, cacheRead: 0.01, cacheWrite: 0 } });
  });

  it('keeps models.dev metadata on overlap and adds live-only ids', () => {
    const config = buildProviderConfig(parseProviderEntry('crof', crofLikeProvider())!);
    const merged = mergeLiveOpenAiModels(config, [
      { id: 'kimi-k3', name: 'Kimi K3', reasoning: true, contextWindow: 1, maxTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: 'glm-5.3-flash', name: 'Z.ai: GLM 5.3 Flash', reasoning: true, contextWindow: 1_000_000, maxTokens: 131_072, cost: { input: 0.07, output: 0.22, cacheRead: 0.01, cacheWrite: 0 } },
    ]);
    expect(merged.models.map((model) => model.id)).toEqual(['glm-5.3-flash', 'kimi-k3']);
    expect(configModel(merged, 'kimi-k3').cost.input).toBe(2); // models.dev metadata kept
    expect(configModel(merged, 'glm-5.3-flash').name).toBe('CrofAI: Z.ai: GLM 5.3 Flash');
    expect(merged.models.some((model) => model.id === 'glm-4.7')).toBe(false);
  });
});
