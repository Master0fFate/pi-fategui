import { describe, expect, it } from 'vitest';
import { Type } from 'typebox';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { MemoryStorage, type Storage } from '@earendil-works/pi-durable';
import type { ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { NativeDurableExecution } from '../../src/main/pi/durable/NativeDurableExecution';
import { NativeEffectNotStartedError } from '../../src/main/pi/durable/NativeExecutionFence';
import { DurableStorageCloseUncertainError } from '../../src/core/durable/OwnedDurableStorage';

function opts(storage: Storage = new MemoryStorage()) {
  return { storage, models: createModels(), model: { provider: 'faux', modelId: 'faux-1' }, cwd: '/approved-checkout', systemPrompt: 'Approved prompt', assertOwnership: async () => {}, settings: { retry: { enabled: false }, compaction: { enabled: false } } };
}
function override(storage: Storage, replacements: Record<string, unknown>): Storage {
  return new Proxy(storage, { get(target, key) {
    if (typeof key === 'string' && key in replacements) return replacements[key];
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

describe('independent native Harness review regressions', () => {
  it('all callers observe the same pending/successful close and it runs once', async () => {
    const backing = new MemoryStorage();
    let calls = 0;
    let finish!: () => void;
    const block = new Promise<void>((resolve) => { finish = resolve; });
    const execution = await NativeDurableExecution.open(opts(override(backing, { close: async () => { calls++; await block; await backing.close(BACKGROUND_CONTEXT); } })));
    const first = execution.close();
    const second = execution.close();
    expect(first).toBe(second);
    let settled = false;
    void second.then(() => { settled = true; });
    await expect.poll(() => calls).toBe(1);
    expect(settled).toBe(false);
    finish();
    await Promise.all([first, second, execution.close()]);
    expect(calls).toBe(1);
    await expect(execution.submit({ type: 'input', requestId: 'after-close', content: 'No' })).rejects.toThrow('closed');
  });

  it('repeated close preserves its rejection rather than reporting false success', async () => {
    let calls = 0;
    const execution = await NativeDurableExecution.open(opts(override(new MemoryStorage(), { close: async () => { calls++; throw new Error('Backend close failed'); } })));
    await expect(execution.close()).rejects.toThrow('Backend close failed');
    await expect(execution.close()).rejects.toThrow('Backend close failed');
    expect(calls).toBe(1);
  });

  it('open cleanup failures before and after Harness construction stay typed for owner retention', async () => {
    const before = override(new MemoryStorage(), { scanTasks: async () => { throw new Error('Preflight failed'); }, close: async () => { throw new Error('Cannot close preflight'); } });
    await expect(NativeDurableExecution.open(opts(before))).rejects.toBeInstanceOf(DurableStorageCloseUncertainError);
    const backing = new MemoryStorage();
    const after = override(backing, { commit: async (...args: Parameters<Storage['commit']>) => {
      if (args[0].some((write) => write.type === 'conversation')) throw new Error('Root construction failed');
      return backing.commit(...args);
    }, close: async () => { throw new Error('Cannot close Harness'); } });
    await expect(NativeDurableExecution.open(opts(after))).rejects.toBeInstanceOf(DurableStorageCloseUncertainError);
  });

  it('refuses cwd changes/default clearing but permits the original binding', async () => {
    const execution = await NativeDurableExecution.open(opts());
    await expect(execution.configure({ cwd: '/other-checkout' })).rejects.toThrow('capability rebinding');
    await expect(execution.configure({ cwd: null })).rejects.toThrow('capability rebinding');
    await expect(execution.configure({ cwd: '/approved-checkout' })).resolves.toBeUndefined();
    await execution.close();
  });

  it.each([true, false])('matches native all-call termination (all terminate=%s)', async (allTerminate) => {
    const options = opts();
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    let calls = 0;
    faux.setResponses([
      () => { calls++; return fauxAssistantMessage([{ type: 'toolCall', id: 'a1', name: 'a', arguments: {} }, { type: 'toolCall', id: 'b1', name: 'b', arguments: {} }], { stopReason: 'toolUse' }); },
      () => { calls++; return fauxAssistantMessage('Continued mixed batch'); },
    ]);
    options.models.setProvider(faux.provider);
    const definition = (name: string, terminate: boolean): ToolDefinition => ({ name, label: name, description: name, parameters: Type.Object({}), execute: async () => ({ content: [{ type: 'text', text: name }], details: {}, terminate }) });
    // These synthetic definitions never consume context. Any unexpected access fails.
    const context = async () => new Proxy({}, { get(_target, key) { if (key === 'then') return undefined; throw new Error(`Unexpected ${String(key)}`); } }) as ExtensionToolContext;
    const execution = await NativeDurableExecution.open({ ...options, tools: [{ definition: definition('a', true), context }, { definition: definition('b', allTerminate), context }] });
    expect((await execution.wait(await execution.submit({ type: 'input', requestId: 'termination', content: 'Execute' }))).status).toBe('done');
    expect(calls).toBe(allTerminate ? 1 : 2);
    expect((await execution.fenceState())?.state).toBe('idle');
    await execution.close();
  });

  it.each(['trusted-declaration', 'pre-effect-refusal'])('preserves known no-effect failures: %s', async (mode) => {
    const options = opts();
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses([fauxAssistantMessage([{ type: 'toolCall', id: 'safe1', name: 'explicit_capability', arguments: {} }], { stopReason: 'toolUse' }), fauxAssistantMessage('Explained the known failure')]);
    options.models.setProvider(faux.provider);
    const execution = await NativeDurableExecution.open({ ...options,
      knownNoEffectFailures: mode === 'trusted-declaration' ? ['explicit_capability'] : [],
      nativeTools: [{ name: 'explicit_capability', description: 'Host-classified capability', parameters: Type.Object({}), execute: async () => {
        if (mode === 'pre-effect-refusal') throw new NativeEffectNotStartedError('Policy refused before effect');
        throw new Error('Confirmed read failure');
      } }],
    });
    expect((await execution.wait(await execution.submit({ type: 'input', requestId: mode, content: 'Inspect' }))).status).toBe('done');
    expect((await execution.fenceState())?.state).toBe('idle');
    await execution.close();
  });
});
