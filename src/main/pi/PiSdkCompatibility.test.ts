import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { modelInfo, modelThinkingLevels } from './SubagentProtocol';

describe('embedded Pi SDK compatibility', () => {
  let directory: string;
  let runtime: ModelRuntime;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-sdk-compat-'));
    runtime = await ModelRuntime.create({
      authPath: path.join(directory, 'auth.json'),
      modelsPath: null,
      modelsStorePath: path.join(directory, 'models-store.json'),
      allowModelNetwork: false,
    });
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it.each(['openai', 'openai-codex'])('exposes native Astra on %s without custom model configuration', (provider) => {
    const model = runtime.getModel(provider, 'gpt-6-astra');
    expect(model).toBeDefined();
    if (!model) throw new Error('Native Astra is missing from the SDK.');
    expect(modelInfo(model)).toMatchObject({ provider, id: 'gpt-6-astra', reasoning: true, supportsImages: true, contextWindow: 272_000 });
    expect(modelThinkingLevels(model)).toEqual(provider === 'openai'
      ? ['low', 'medium', 'high', 'xhigh', 'max']
      : ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('does not advertise extended effort without model support', () => {
    const model = runtime.getModel('openai', 'gpt-6-astra')!;
    expect(modelThinkingLevels({ ...model, thinkingLevelMap: {} })).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    expect(modelThinkingLevels({ ...model, reasoning: false })).toEqual(['off']);
  });

  it.each(['gpt-5.6-sol', 'gpt-6-astra'])('uses the upstream 30-minute long-cache payload for %s', async (id) => {
    const model = runtime.getModel('openai', id)!;
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('Network must not be used.'));
    let payload: unknown;
    const result = await runtime.completeSimple(model, {
      messages: [{ role: 'user', content: 'Cache contract probe', timestamp: 0 }],
    }, {
      apiKey: 'test-key',
      reasoning: 'low',
      cacheRetention: 'long',
      sessionId: 'fate-sdk-cache-test',
      fetch,
      onPayload(value) {
        payload = value;
        throw new Error('Payload captured before network.');
      },
    });
    expect(payload).toMatchObject({ prompt_cache_options: { ttl: '30m' } });
    expect(JSON.parse(JSON.stringify(payload))).not.toHaveProperty('prompt_cache_retention');
    expect(result.errorMessage).toContain('Payload captured before network.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves the OpenRouter patch when off has no explicit provider mapping', async () => {
    const model = runtime.getModels('openrouter').find((candidate) => candidate.reasoning)!;
    expect(model).toBeDefined();
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('Network must not be used.'));
    let payload: unknown;
    await runtime.completeSimple({ ...model, thinkingLevelMap: {} }, {
      messages: [{ role: 'user', content: 'Reasoning contract probe', timestamp: 0 }],
    }, {
      apiKey: 'test-key',
      fetch,
      onPayload(value) {
        payload = value;
        throw new Error('Payload captured before network.');
      },
    });
    expect(payload).toBeDefined();
    expect(payload).not.toHaveProperty('reasoning');
    expect(fetch).not.toHaveBeenCalled();
  });
});
