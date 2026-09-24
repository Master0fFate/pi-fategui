import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderFileSync,
  parseAuthApiKeys,
  parseProvidersJson,
  type FileSyncRuntime,
  type ProviderConfigInputLike,
  type ProviderFileSyncResult,
} from './ProviderFileSync';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'provider-file-sync-'));
  temporaryRoots.push(root);
  return root;
}

interface RecordedRuntimeState {
  registered: string[];
  unregistered: string[];
  keys: Map<string, string>;
  removedKeys: string[];
  refreshes: number;
}

class RecordingRuntime implements FileSyncRuntime {
  readonly state: RecordedRuntimeState = { registered: [], unregistered: [], keys: new Map(), removedKeys: [], refreshes: 0 };
  readonly configs = new Map<string, ProviderConfigInputLike>();

  constructor(private readonly native: string[] = []) {}

  getProviders(): readonly { id: string }[] {
    return [...this.native, ...this.state.registered].map((id) => ({ id }));
  }

  registerProvider(providerId: string, config: ProviderConfigInputLike): void {
    if (this.native.includes(providerId)) throw new Error(`Provider "${providerId}" already exists.`);
    if (!this.state.registered.includes(providerId)) this.state.registered.push(providerId);
    this.configs.set(providerId, { ...this.configs.get(providerId), ...config });
  }

  unregisterProvider(providerId: string): void {
    this.state.registered = this.state.registered.filter((id) => id !== providerId);
    this.state.unregistered.push(providerId);
    this.configs.delete(providerId);
  }

  async setRuntimeApiKey(providerId: string, apiKey: string): Promise<void> {
    this.state.keys.set(providerId, apiKey);
  }

  async removeRuntimeApiKey(providerId: string): Promise<void> {
    this.state.keys.delete(providerId);
    this.state.removedKeys.push(providerId);
  }

  async refresh(): Promise<void> {
    this.state.refreshes += 1;
  }
}

const SAMPLE_PROVIDER = {
  name: '15BAI',
  baseUrl: 'https://api.b.ai/v1',
  api: 'openai-completions',
  models: [{
    id: 'claude-opus-5',
    name: '15BAI Claude Opus 5',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 128000,
  }],
} as unknown as ProviderConfigInputLike;

function writeModels(root: string, providers: Record<string, unknown>): Promise<void> {
  return writeFile(path.join(root, 'models.json'), JSON.stringify({ providers }), 'utf8');
}

function writeAuth(root: string, entries: Record<string, unknown>): Promise<void> {
  return writeFile(path.join(root, 'auth.json'), JSON.stringify(entries), 'utf8');
}

async function waitForSync(syncs: Promise<ProviderFileSyncResult>[]): Promise<ProviderFileSyncResult> {
  return syncs[syncs.length - 1]!;
}

describe('parseProvidersJson', () => {
  it('extracts provider configs and rejects unusable files', () => {
    const valid = parseProvidersJson('{"providers":{"15bai":{"baseUrl":"https://api.b.ai/v1"}}}');
    expect(valid && valid['15bai']).toMatchObject({ baseUrl: 'https://api.b.ai/v1' });
    expect(parseProvidersJson('not json')).toBeNull();
    expect(parseProvidersJson('{"providers":[]}')).toBeNull();
    expect(parseProvidersJson('{}')).toBeNull();
  });
});

describe('parseAuthApiKeys', () => {
  it('keeps only api_key entries with non-empty keys', () => {
    const keys = parseAuthApiKeys(JSON.stringify({
      '15bai': { type: 'api_key', key: ' sk-test ' },
      oauthProvider: { type: 'oauth', access: 'token' },
      empty: { type: 'api_key', key: '   ' },
    }));
    expect(keys.size).toBe(1);
    expect(keys.get('15bai')).toBe('sk-test');
    expect(parseAuthApiKeys('not json').size).toBe(0);
  });
});

describe('ProviderFileSync', () => {
  it('registers a new provider from models.json and applies its auth key', async () => {
    const root = await fixtureRoot();
    const runtime = new RecordingRuntime();
    const syncs: Promise<ProviderFileSyncResult>[] = [];
    const sync = new ProviderFileSync(runtime, { modelsPath: path.join(root, 'models.json'), authPath: path.join(root, 'auth.json') }, {
      onSync: (result) => { syncs.push(Promise.resolve(result)); },
    });
    await writeModels(root, { '15bai': SAMPLE_PROVIDER });
    await writeAuth(root, { '15bai': { type: 'api_key', key: 'sk-live-key' } });

    const result = await sync.syncNow();

    expect(result.changed).toBe(true);
    expect(result.registered).toEqual(['15bai']);
    expect(result.keysApplied).toEqual(['15bai']);
    expect(runtime.configs.get('15bai')).toMatchObject({ baseUrl: 'https://api.b.ai/v1' });
    expect(runtime.state.keys.get('15bai')).toBe('sk-live-key');
    expect(runtime.state.refreshes).toBe(1);
    expect((await waitForSync(syncs)).registered).toEqual(['15bai']);
    sync.stop();
  });

  it('is a no-op when the files are unchanged', async () => {
    const root = await fixtureRoot();
    const runtime = new RecordingRuntime();
    const sync = new ProviderFileSync(runtime, { modelsPath: path.join(root, 'models.json'), authPath: path.join(root, 'auth.json') });
    await writeModels(root, { '15bai': SAMPLE_PROVIDER });
    await writeAuth(root, { '15bai': { type: 'api_key', key: 'sk-live-key' } });
    await sync.syncNow();

    const second = await sync.syncNow();

    expect(second.changed).toBe(false);
    expect(runtime.state.registered).toEqual(['15bai']);
    expect(runtime.state.refreshes).toBe(1);
    sync.stop();
  });

  it('re-applies a key only when its value changes', async () => {
    const root = await fixtureRoot();
    const runtime = new RecordingRuntime();
    const sync = new ProviderFileSync(runtime, { modelsPath: path.join(root, 'models.json'), authPath: path.join(root, 'auth.json') });
    await writeModels(root, { '15bai': SAMPLE_PROVIDER });
    await writeAuth(root, { '15bai': { type: 'api_key', key: 'sk-key-one' } });
    await sync.syncNow();
    await writeAuth(root, { '15bai': { type: 'api_key', key: 'sk-key-one' } });
    await sync.syncNow();
    expect(runtime.state.keys.get('15bai')).toBe('sk-key-one');

    await writeAuth(root, { '15bai': { type: 'api_key', key: 'sk-key-two' } });
    const result = await sync.syncNow();

    expect(result.keysApplied).toEqual(['15bai']);
    expect(runtime.state.keys.get('15bai')).toBe('sk-key-two');
    sync.stop();
  });

  it('revokes a key removed from auth.json without unregistering the provider', async () => {
    const root = await fixtureRoot();
    const runtime = new RecordingRuntime();
    const sync = new ProviderFileSync(runtime, { modelsPath: path.join(root, 'models.json'), authPath: path.join(root, 'auth.json') });
    await writeModels(root, { '15bai': SAMPLE_PROVIDER });
    await writeAuth(root, { '15bai': { type: 'api_key', key: 'sk-key-one' } });
    await sync.syncNow();

    await writeAuth(root, {});
    const result = await sync.syncNow();

    expect(result.keysRemoved).toEqual(['15bai']);
    expect(runtime.state.keys.has('15bai')).toBe(false);
    expect(runtime.state.registered).toEqual(['15bai']);
    expect(runtime.state.refreshes).toBe(2);
    sync.stop();
  });

  it('keeps an applied key while auth.json is temporarily invalid', async () => {
    const root = await fixtureRoot();
    const runtime = new RecordingRuntime();
    const sync = new ProviderFileSync(runtime, { modelsPath: path.join(root, 'models.json'), authPath: path.join(root, 'auth.json') });
    await writeModels(root, { '15bai': SAMPLE_PROVIDER });
    await writeAuth(root, { '15bai': { type: 'api_key', key: 'sk-key-one' } });
    await sync.syncNow();

    await writeFile(path.join(root, 'auth.json'), '{ truncated', 'utf8');
    const invalid = await sync.syncNow();
    expect(invalid.changed).toBe(false);
    expect(runtime.state.keys.get('15bai')).toBe('sk-key-one');
    await writeAuth(root, {});
    expect((await sync.syncNow()).keysRemoved).toEqual(['15bai']);
    sync.stop();
  });

  it('refreshes live models when an existing provider configuration changes', async () => {
    const root = await fixtureRoot();
    const runtime = new RecordingRuntime(['15bai']);
    const sync = new ProviderFileSync(runtime, { modelsPath: path.join(root, 'models.json'), authPath: path.join(root, 'auth.json') });
    await writeModels(root, { '15bai': SAMPLE_PROVIDER });
    await writeAuth(root, {});
    await sync.syncNow();

    await writeModels(root, { '15bai': { ...SAMPLE_PROVIDER, baseUrl: 'https://new.example/v1' } });
    const result = await sync.syncNow();
    expect(result.changed).toBe(true);
    expect(result.registered).toEqual([]);
    expect(runtime.state.refreshes).toBe(1);
    sync.stop();
  });

  it('drops a runtime key when its disk provider is removed', async () => {
    const root = await fixtureRoot();
    const runtime = new RecordingRuntime(['15bai']);
    const sync = new ProviderFileSync(runtime, { modelsPath: path.join(root, 'models.json'), authPath: path.join(root, 'auth.json') });
    await writeModels(root, { '15bai': SAMPLE_PROVIDER });
    await writeAuth(root, { '15bai': { type: 'api_key', key: 'sk-key-one' } });
    await sync.syncNow();

    await writeModels(root, {});
    await writeAuth(root, {});
    const result = await sync.syncNow();
    expect(result.keysRemoved).toEqual(['15bai']);
    expect(runtime.state.removedKeys).toEqual(['15bai']);
    expect(runtime.state.keys.has('15bai')).toBe(false);
    sync.stop();
  });

  it('updates a provider registered after startup when its model file changes', async () => {
    const root = await fixtureRoot();
    const runtime = new RecordingRuntime();
    const sync = new ProviderFileSync(runtime, { modelsPath: path.join(root, 'models.json'), authPath: path.join(root, 'auth.json') });
    await writeModels(root, { '15bai': SAMPLE_PROVIDER });
    await writeAuth(root, {});
    await sync.syncNow();

    const { name: _oldName, ...updated } = SAMPLE_PROVIDER;
    await writeModels(root, { '15bai': { ...updated, baseUrl: 'https://new.example/v1' } });
    const result = await sync.syncNow();
    expect(result.changed).toBe(true);
    expect(runtime.configs.get('15bai')).toMatchObject({ baseUrl: 'https://new.example/v1' });
    expect(runtime.configs.get('15bai')).not.toHaveProperty('name');
    expect(runtime.state.registered).toEqual(['15bai']);
    sync.stop();
  });

  it('unregisters only providers it registered and never native ones', async () => {
    const root = await fixtureRoot();
    const runtime = new RecordingRuntime(['openai-codex']);
    const sync = new ProviderFileSync(runtime, { modelsPath: path.join(root, 'models.json'), authPath: path.join(root, 'auth.json') });
    await writeModels(root, { '15bai': SAMPLE_PROVIDER, 'openai-codex': SAMPLE_PROVIDER });
    await sync.syncNow();
    expect(runtime.state.registered).toEqual(['15bai']);

    await writeModels(root, { 'openai-codex': SAMPLE_PROVIDER });
    const result = await sync.syncNow();

    expect(result.unregistered).toEqual(['15bai']);
    expect(runtime.state.removedKeys).toEqual(['15bai']);
    expect(runtime.getProviders().map((provider) => provider.id)).toEqual(['openai-codex']);
    sync.stop();
  });

  it('treats a corrupt models.json as a no-op instead of unregistering everything', async () => {
    const root = await fixtureRoot();
    const runtime = new RecordingRuntime();
    const sync = new ProviderFileSync(runtime, { modelsPath: path.join(root, 'models.json'), authPath: path.join(root, 'auth.json') });
    await writeModels(root, { '15bai': SAMPLE_PROVIDER });
    await sync.syncNow();

    await writeFile(path.join(root, 'models.json'), '{ truncated', 'utf8');
    const result = await sync.syncNow();

    expect(result.changed).toBe(false);
    expect(runtime.state.registered).toEqual(['15bai']);
    sync.stop();
  });

  it('watches the directory and syncs an external save without a restart', async () => {
    const root = await fixtureRoot();
    const runtime = new RecordingRuntime();
    const observed: ProviderFileSyncResult[] = [];
    const sync = new ProviderFileSync(runtime, { modelsPath: path.join(root, 'models.json'), authPath: path.join(root, 'auth.json') }, {
      debounceMs: 20,
      onSync: (result) => { observed.push(result); },
    });
    sync.start();
    try {
      await writeModels(root, { '15bai': SAMPLE_PROVIDER });
      await writeAuth(root, { '15bai': { type: 'api_key', key: 'sk-watcher-key' } });

      // The startup catch-up can legitimately report an empty directory first.
      // Wait for the external save itself, not merely the first callback.
      await vi.waitFor(() => {
        expect(observed.some((result) => result.registered.includes('15bai'))).toBe(true);
        expect(runtime.state.registered).toEqual(['15bai']);
        expect(runtime.state.keys.get('15bai')).toBe('sk-watcher-key');
      }, { timeout: 10_000, interval: 25 });
    } finally {
      sync.stop();
    }
  });
});
