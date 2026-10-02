import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { piPromptDisposition } from './PiSdkCompatibility';
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
      apiKey: 'sk-fate-offline-payload-only',
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

  it.each([undefined, null, 'none', 'minimal'] as const)('preserves OpenRouter explicit off mapping %s without inventing one', async (off) => {
    const model = runtime.getModels('openrouter').find((candidate) => candidate.reasoning && candidate.api === 'openai-completions')!;
    expect(model).toBeDefined();
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('Network must not be used.'));
    let payload: unknown;
    await runtime.completeSimple({ ...model, thinkingLevelMap: off === undefined ? {} : { off } }, {
      messages: [{ role: 'user', content: 'Reasoning contract probe', timestamp: 0 }],
    }, {
      apiKey: 'sk-fate-offline-payload-only',
      fetch,
      onPayload(value) {
        payload = value;
        throw new Error('Payload captured before network.');
      },
    });
    expect(payload).toBeDefined();
    if (off == null) expect(payload).not.toHaveProperty('reasoning');
    else expect(payload).toHaveProperty('reasoning', { effort: off });
    expect(fetch).not.toHaveBeenCalled();
  });
});


describe('Pi 1.0 prompt disposition boundary', () => {
  it.each(['started', 'queued', 'handled'] as const)('accepts only native disposition %s', (value) => {
    expect(piPromptDisposition(value)).toBe(value);
  });

  it.each([true, false, undefined, null, '', 'rejected', 'accepted', 1, {}])('rejects incompatible or unknown admission %j', (value) => {
    expect(piPromptDisposition(value)).toBeNull();
  });

  it('uses native handled acknowledgment and throws without acknowledgment on rejected input', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-sdk-admission-'));
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(root, 'auth.json'), modelsPath: null,
      modelsStorePath: path.join(root, 'models-store.json'), allowModelNetwork: false });
    const services = await createAgentSessionServices({ cwd: root, agentDir: path.join(root, 'agent'), modelRuntime,
      settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
      resourceLoaderOptions: { includeHomeAgentSkills: false, noExtensions: true, noSkills: true, noContextFiles: true,
        noThemes: true, noPromptTemplates: true,
        extensionFactories: [(pi) => { pi.on('input', (event) => {
          if (event.text === 'handled locally') return { action: 'handled' };
          return { action: 'continue' };
        }); }],
      },
    });
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(root), noTools: 'all' });
    const acknowledgement = vi.fn();
    const transport = vi.fn<typeof session.agent.streamFunction>(() => { throw new Error('Provider transport must not run'); });
    session.agent.streamFunction = transport;
    try {
      await session.prompt('handled locally', { preflightResult: acknowledgement });
      expect(acknowledgement).toHaveBeenCalledExactlyOnceWith('handled');
      acknowledgement.mockClear();
      await expect(session.prompt('no authenticated model', { preflightResult: acknowledgement })).rejects.toThrow();
      expect(acknowledgement).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
      expect(session.messages.some((message) => message.role === 'user')).toBe(false);
    } finally {
      session.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
