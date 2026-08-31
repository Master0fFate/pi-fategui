import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelsDevService, type ModelsDevFetch } from './ModelsDevService';
import { ModelsDevStore } from './ModelsDevStore';

let dataRoot: string;
let savedOffline: string | undefined;

beforeEach(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-modelsdev-svc-'));
  savedOffline = process.env.PI_OFFLINE;
  delete process.env.PI_OFFLINE;
});

afterEach(async () => {
  await fs.rm(dataRoot, { recursive: true, force: true });
  if (savedOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = savedOffline;
});

function catalogPayload() {
  return {
    crof: {
      id: 'crof', name: 'CrofAI', api: 'https://crof.ai/v1', env: ['CROF_API_KEY'], npm: '@ai-sdk/openai-compatible',
      models: {
        'kimi-k3': { id: 'kimi-k3', name: 'Kimi K3', reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high', 'max'] }], tool_call: true, structured_output: true, limit: { context: 1_000_000, output: 262_144 }, cost: { input: 2, output: 8, cache_read: 0.25 } },
        'glm-4.7': { id: 'glm-4.7', name: 'GLM-4.7', reasoning: true, reasoning_options: [], tool_call: true, limit: { context: 202_752, output: 202_752 }, cost: { input: 0.25, output: 1.1 } },
      },
    },
    anthropic: {
      id: 'anthropic', name: 'Anthropic', api: 'https://api.anthropic.com/v1', env: ['ANTHROPIC_API_KEY'], npm: '@ai-sdk/anthropic',
      models: { 'claude-x': { id: 'claude-x', name: 'Claude X', reasoning: true, reasoning_options: [], tool_call: true, limit: { context: 200_000, output: 64_000 }, cost: { input: 3, output: 15 } } },
    },
  };
}

function fetchWith(payload: unknown): ModelsDevFetch {
  const body = JSON.stringify(payload);
  return vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer })) as unknown as ModelsDevFetch;
}

function serviceWith(fetchImpl: ModelsDevFetch) {
  return new ModelsDevService({ store: new ModelsDevStore(dataRoot), fetchImpl, now: () => 42_000 });
}

describe('ModelsDevService.listProviders', () => {
  it('marks rows managed, configured, and available', async () => {
    const service = serviceWith(fetchWith(catalogPayload()));
    const store = new ModelsDevStore(dataRoot);
    await store.upsertRegistryEntry({ id: 'crof', name: 'CrofAI', baseUrl: 'https://crof.ai/v1', envVar: 'CROF_API_KEY', api: 'openai-completions', npm: '@ai-sdk/openai-compatible', docUrl: null, addedAt: 1, checkedAt: 1, modelCount: 2 });
    const { providers } = await service.listProviders(new Set(['anthropic']));
    const byId = new Map(providers.map(({ summary }) => [summary.id, summary]));
    expect(byId.get('crof')!.status).toBe('managed');
    expect(byId.get('anthropic')!.status).toBe('configured');
    expect(providers.map(({ summary }) => summary.id)).toEqual(['anthropic', 'crof']); // sorted by name
    expect(byId.get('crof')!.modelCount).toBe(2);
  });

  it('rejects when offline mode is set', async () => {
    process.env.PI_OFFLINE = '1';
    const service = serviceWith(fetchWith(catalogPayload()));
    await expect(service.listProviders(new Set())).rejects.toThrow(/PI_OFFLINE/);
  });
});

describe('ModelsDevService.addProvider', () => {
  it('writes models.json and the registry', async () => {
    const service = serviceWith(fetchWith(catalogPayload()));
    const { config, entry } = await service.addProvider('crof');
    expect(config.apiKey).toBe('$CROF_API_KEY');
    expect(config.models).toHaveLength(2);
    expect(entry.modelCount).toBe(2);
    const store = new ModelsDevStore(dataRoot);
    const models = await store.readModelsJson();
    const written = models.providers.crof as { name?: string; baseUrl?: string; models?: unknown[] };
    expect(written.name).toBe('CrofAI');
    expect(written.baseUrl).toBe('https://crof.ai/v1');
    expect(written.models).toHaveLength(2);
    expect(Object.keys((await store.readRegistry()).providers)).toEqual(['crof']);
  });

  it('fails for unknown providers', async () => {
    const service = serviceWith(fetchWith(catalogPayload()));
    await expect(service.addProvider('ghost')).rejects.toThrow(/not in the models.dev catalog/);
  });
});

describe('ModelsDevService.removeProvider', () => {
  it('removes a managed provider only', async () => {
    const service = serviceWith(fetchWith(catalogPayload()));
    await service.addProvider('crof');
    await service.removeProvider('crof');
    const store = new ModelsDevStore(dataRoot);
    expect(Object.keys((await store.readModelsJson()).providers)).toEqual([]);
    expect(Object.keys((await store.readRegistry()).providers)).toEqual([]);
    await expect(service.removeProvider('crof')).rejects.toThrow(/not a models.dev-managed provider/);
  });
});

describe('ModelsDevService.refreshManagedProviders', () => {
  it('refreshes model lists but keeps frozen identity fields', async () => {
    const service = serviceWith(fetchWith(catalogPayload()));
    await service.addProvider('crof');
    // Upstream changes its base URL and drops a model; the user keeps the old URL.
    const changed = catalogPayload();
    changed.crof.api = 'https://moved.example/v1';
    delete (changed.crof.models as Record<string, unknown>)['glm-4.7'];
    const refreshed = serviceWith(fetchWith(changed));
    const updated = await refreshed.refreshManagedProviders();
    expect(updated).toHaveLength(1);
    const store = new ModelsDevStore(dataRoot);
    const models = await store.readModelsJson();
    const provider = models.providers.crof as { baseUrl?: string; models?: Array<{ id: string }> };
    expect(provider.baseUrl).toBe('https://crof.ai/v1'); // frozen at add time
    expect(provider.models!.map((model) => model.id)).toEqual(['kimi-k3']);
    const registry = await store.readRegistry();
    expect(registry.providers.crof!.checkedAt).toBe(42_000);
    expect(registry.providers.crof!.modelCount).toBe(1);
  });

  it('keeps the cached list when the network fails', async () => {
    const service = serviceWith(fetchWith(catalogPayload()));
    await service.addProvider('crof');
    const offline = new ModelsDevService({
      store: new ModelsDevStore(dataRoot),
      fetchImpl: vi.fn(async () => { throw new Error('network down'); }) as unknown as ModelsDevFetch,
      now: () => 42_000,
    });
    const updated = await offline.refreshManagedProviders();
    expect(updated).toEqual([]);
    const store = new ModelsDevStore(dataRoot);
    const models = await store.readModelsJson();
    expect((models.providers.crof as { models?: unknown[] }).models).toHaveLength(2);
  });

  it('is a no-op without managed providers', async () => {
    const fetchImpl = vi.fn() as unknown as ModelsDevFetch;
    const service = serviceWith(fetchImpl);
    expect(await service.refreshManagedProviders()).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('overlays the provider /v1/models list so live ids missing from models.dev appear', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('models.dev')) {
        const body = JSON.stringify(catalogPayload());
        return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
      }
      const body = JSON.stringify({
        data: [
          { id: 'kimi-k3', name: 'Kimi K3', custom_reasoning: true, context_length: 1_000_000 },
          { id: 'glm-5.3-flash', name: 'Z.ai: GLM 5.3 Flash', custom_reasoning: true, reasoning_effort: true, context_length: 1_000_000, max_completion_tokens: 131_072 },
        ],
      });
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
    }) as unknown as ModelsDevFetch;
    const service = new ModelsDevService({ store: new ModelsDevStore(dataRoot), fetchImpl, now: () => 42_000 });
    await service.addProvider('crof');
    await fs.writeFile(path.join(dataRoot, 'auth.json'), JSON.stringify({ crof: { type: 'api_key', key: 'test-key' } }));
    const updated = await service.refreshManagedProviders();
    const ids = updated[0]!.config.models.map((model) => model.id);
    expect(ids).toEqual(['glm-5.3-flash', 'kimi-k3']);
    expect(fetchImpl).toHaveBeenCalledWith('https://crof.ai/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer test-key', 'user-agent': expect.stringContaining('pi/') }),
    }));
  });
});
