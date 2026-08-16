import { describe, expect, it } from 'vitest';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { crofaiProviderConfig, parseCrofaiCatalog, registerBundledModelProviders } from './bundledProviders';

function recordingRuntime(): { runtime: Pick<ModelRuntime, 'registerProvider'>; registrations: Array<{ providerId: string; config: unknown }> } {
  const registrations: Array<{ providerId: string; config: unknown }> = [];
  return {
    registrations,
    runtime: {
      registerProvider(providerId: string, config: never) {
        registrations.push({ providerId, config });
      },
    } as Pick<ModelRuntime, 'registerProvider'>,
  };
}

describe('crofaiProviderConfig', () => {
  it('registers the exact CrofAI display provider against the OpenAI-compatible endpoint', () => {
    const config = crofaiProviderConfig();
    expect(config.name).toBe('CrofAI');
    expect(config.baseUrl).toBe('https://crof.ai/v1');
    expect(config.api).toBe('openai-completions');
    // Auth must be an environment reference, never an embedded secret.
    expect(config.apiKey).toBe('$CROFAI_API_KEY');
    expect(String(config.apiKey)).not.toMatch(/nahc|sk-|bearer/i);
  });

  it('ships a non-empty offline model snapshot with thinking maps only on reasoning models', () => {
    const models = crofaiProviderConfig().models ?? [];
    expect(models.length).toBeGreaterThanOrEqual(20);
    for (const model of models) {
      expect(model.id).toMatch(/^[a-z0-9][a-z0-9.-]*$/i);
      expect(model.name.startsWith('CrofAI: ')).toBe(true);
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxTokens).toBeGreaterThan(0);
      if (model.reasoning) expect(model.thinkingLevelMap?.high).toBe('high');
      else expect(model.thinkingLevelMap).toBeUndefined();
    }
    const ids = models.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('falls back to the snapshot when the live catalog cannot be fetched', async () => {
    const config = crofaiProviderConfig();
    expect(typeof config.refreshModels).toBe('function');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('network unavailable'); };
    try {
      const refreshed = await config.refreshModels?.({} as Parameters<NonNullable<typeof config.refreshModels>>[0]);
      expect(refreshed?.length).toBe(config.models?.length);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('parseCrofaiCatalog', () => {
  it('maps an OpenAI-style model list payload', () => {
    const models = parseCrofaiCatalog({
      data: [
        { id: 'deepseek-v4-pro', name: 'DeepSeek: DeepSeek V4 Pro', reasoning_effort: true, context_length: 1000000, max_completion_tokens: 131072, pricing: { prompt: '0.35', completion: '0.80', cache_prompt: '0.003' } },
        { id: 'plain-model' },
        'not-an-object',
      ],
    });
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({ id: 'deepseek-v4-pro', name: 'CrofAI: DeepSeek: DeepSeek V4 Pro', reasoning: true, contextWindow: 1000000, maxTokens: 131072, cost: { input: 0.35, output: 0.8, cacheRead: 0.003, cacheWrite: 0 } });
    expect(models[0]?.thinkingLevelMap).toMatchObject({ off: 'none', high: 'high' });
    expect(models[1]).toMatchObject({ id: 'plain-model', name: 'CrofAI: plain-model', reasoning: false, contextWindow: 128000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(models[1]?.thinkingLevelMap).toBeUndefined();
  });

  it('tolerates malformed payloads', () => {
    expect(parseCrofaiCatalog(null)).toEqual([]);
    expect(parseCrofaiCatalog({ data: 'nope' })).toEqual([]);
  });
});

describe('registerBundledModelProviders', () => {
  it('registers exactly one provider with the literal id CrofAI', () => {
    const { runtime, registrations } = recordingRuntime();
    registerBundledModelProviders(runtime as ModelRuntime);
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.providerId).toBe('CrofAI');
    expect((registrations[0]?.config as { name?: string }).name).toBe('CrofAI');
  });
});
