import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModelsDevStore, parseRegistry } from './ModelsDevStore';
import type { GeneratedPiProviderConfig } from './ModelsDevCatalog';

let dataRoot: string;

beforeEach(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-modelsdev-'));
});

afterEach(async () => {
  await fs.rm(dataRoot, { recursive: true, force: true });
});

function config(id: string, overrides: Partial<GeneratedPiProviderConfig> = {}): GeneratedPiProviderConfig {
  return {
    id,
    name: `Provider ${id}`,
    baseUrl: `https://${id}.example/v1`,
    apiKey: `$${id.toUpperCase()}_KEY`,
    api: 'openai-completions',
    models: [{
      id: 'model-a',
      name: `Provider ${id}: Model A`,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    }],
    ...overrides,
  };
}

function entry(id: string) {
  return {
    id,
    name: `Provider ${id}`,
    baseUrl: `https://${id}.example/v1`,
    envVar: `${id.toUpperCase()}_KEY`,
    api: 'openai-completions',
    npm: '@ai-sdk/openai-compatible',
    docUrl: null,
    addedAt: 1_000,
    checkedAt: 1_000,
    modelCount: 1,
  };
}

describe('parseRegistry', () => {
  it('accepts a valid registry', () => {
    const registry = parseRegistry(JSON.stringify({ version: 1, providers: { crof: entry('crof') } }));
    expect(Object.keys(registry.providers)).toEqual(['crof']);
  });

  it('treats corrupt or foreign content as empty', () => {
    expect(Object.keys(parseRegistry('{not json').providers)).toEqual([]);
    expect(Object.keys(parseRegistry('42').providers)).toEqual([]);
    expect(Object.keys(parseRegistry('{"providers":[]}').providers)).toEqual([]);
    expect(Object.keys(parseRegistry(`{"providers":{"bad":${JSON.stringify({ id: 'other', name: 'x', baseUrl: 'https://x', api: 'openai-completions', addedAt: 1 })}}}`).providers)).toEqual([]);
  });
});

describe('ModelsDevStore', () => {
  it('upserts and removes a provider in models.json while preserving other entries', async () => {
    const store = new ModelsDevStore(dataRoot);
    // A hand-written provider the user maintains themselves.
    await fs.writeFile(store.storePaths.modelsPath, JSON.stringify({ providers: { manual: { name: 'Manual', baseUrl: 'https://manual.example', models: [] } } }), 'utf-8');
    await store.upsertProviderConfig(config('crof'));
    const afterAdd = await store.readModelsJson();
    expect(Object.keys(afterAdd.providers).sort()).toEqual(['crof', 'manual']);
    expect((afterAdd.providers.crof as { apiKey?: string }).apiKey).toBe('$CROF_KEY');
    await store.removeProviderConfig('crof');
    const afterRemove = await store.readModelsJson();
    expect(Object.keys(afterRemove.providers)).toEqual(['manual']);
  });

  it('starts from an empty providers file when models.json is missing', async () => {
    const store = new ModelsDevStore(dataRoot);
    const file = await store.readModelsJson();
    expect(file.providers).toEqual({});
    await store.upsertProviderConfig(config('solo'));
    expect(Object.keys((await store.readModelsJson()).providers)).toEqual(['solo']);
  });

  it('refuses to touch a models.json it cannot parse', async () => {
    const store = new ModelsDevStore(dataRoot);
    await fs.writeFile(store.storePaths.modelsPath, '{ broken json', 'utf-8');
    await expect(store.upsertProviderConfig(config('crof'))).rejects.toThrow(/not valid JSON/);
    // The original bytes survive.
    expect(await fs.readFile(store.storePaths.modelsPath, 'utf-8')).toBe('{ broken json');
  });

  it('manages registry entries with an in-memory cache', async () => {
    const store = new ModelsDevStore(dataRoot);
    expect(Object.keys((await store.readRegistry()).providers)).toEqual([]);
    await store.upsertRegistryEntry(entry('crof'));
    const secondStore = new ModelsDevStore(dataRoot);
    expect(Object.keys((await secondStore.readRegistry()).providers)).toEqual(['crof']);
    expect(await secondStore.removeRegistryEntry('crof')).toBe(true);
    expect(await secondStore.removeRegistryEntry('crof')).toBe(false);
    expect(Object.keys((await secondStore.readRegistry()).providers)).toEqual([]);
  });
});
