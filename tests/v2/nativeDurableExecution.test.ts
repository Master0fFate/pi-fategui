import { describe, expect, it } from 'vitest';
import { Type } from 'typebox';
import { createModels, fauxAssistantMessage, fauxProvider, type FauxResponseStep } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { MemoryStorage, ToolResultEntry, type Storage, type StorageWrite, type ToolRegistration } from '@earendil-works/pi-durable';
import { NativeDurableExecution } from '../../src/main/pi/durable/NativeDurableExecution';
import { NativeExecutionUnknownError } from '../../src/main/pi/durable/NativeExecutionFence';
import { createNativeChildTool } from '../../src/main/pi/durable/NativeChildTool';

const context = BACKGROUND_CONTEXT;
const model = { provider: 'faux', modelId: 'faux-1' };
function setup(steps: FauxResponseStep[]) {
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  faux.setResponses(steps);
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}
const call = (name: string, id = 'effect-call', args = {}) => fauxAssistantMessage([{ type: 'toolCall', id, name, arguments: args }], { stopReason: 'toolUse' });
const effect = (execute: ToolRegistration['execute']): ToolRegistration => ({ name: 'effect', description: 'A controlled synthetic effect', parameters: Type.Object({}), execute });

async function open(storage: Storage, models: ReturnType<typeof setup>['models'], nativeTools: ToolRegistration[] = [], assertOwnership = async () => {}) {
  return NativeDurableExecution.open({ storage, models, model, cwd: '/synthetic-approved-project', systemPrompt: 'Use only approved capabilities.', nativeTools, assertOwnership, settings: { retry: { enabled: false }, compaction: { enabled: false } } });
}

/** Memory backend with independent handles to model process close/reopen without shared sessions. */
function durableMemory() {
  const backing = new MemoryStorage();
  return { backing, handle: (): Storage => new Proxy(backing, { get(target, property) {
    if (property === 'close') return async () => {};
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) };
}

function pending() {
  let reached!: () => void;
  const started = new Promise<void>((resolve) => { reached = resolve; });
  const step: FauxResponseStep = (_request, options) => new Promise((_, reject) => {
    reached();
    options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
  });
  return { started, step };
}

describe('native Pi Harness execution', () => {
  it('runs actual native generation/tool tasks, keeps image input, and deduplicates request IDs', async () => {
    let effects = 0;
    let requests = 0;
    const setupModels = setup([
      (request) => {
        requests++;
        expect(request.messages.some((message) => message.role === 'user' && Array.isArray(message.content) && message.content.some((block) => block.type === 'image'))).toBe(true);
        return call('effect');
      },
      () => { requests++; return fauxAssistantMessage('Verified result'); },
    ]);
    const storage = new MemoryStorage();
    const execution = await open(storage, setupModels.models, [effect(async () => { effects++; return { content: [{ type: 'text', text: 'effect receipt' }] }; })]);
    const events: string[] = [];
    const stream = await execution.observe((batch) => { events.push(...batch.map((event) => event.type)); });
    const input = { type: 'input' as const, requestId: 'request-1', content: [{ type: 'text' as const, text: 'Do the approved work' }, { type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' }] };
    const id = await execution.submit(input);
    expect((await execution.wait(id)).status).toBe('done');
    expect(await execution.submit(input)).toBe(id);
    expect((await execution.wait(id)).status).toBe('done');
    expect(effects).toBe(1);
    expect(requests).toBe(2);
    const tasks = (await storage.scanTasks({}, 100, undefined, context)).items;
    expect(tasks.map((task) => task.kind)).toContain('pi.generation');
    expect(tasks.map((task) => task.kind)).toContain('pi.tool');
    expect(tasks.every((task) => task.state.status === 'terminal')).toBe(true);
    expect((await execution.entries()).items.some((entry) => entry.kind === ToolResultEntry.kind)).toBe(true);
    expect(await execution.fenceState()).toEqual({ state: 'idle' });
    await stream.stop();
    expect(events).toContain('tool_execution_start');
    await execution.close();
  });

  it('uses the native inbox for follow-up admission and withdrawal, without a Fate replay queue', async () => {
    const busy = pending();
    const { models } = setup([busy.step]);
    const execution = await open(new MemoryStorage(), models);
    const active = await execution.submit({ type: 'input', requestId: 'active', content: 'Wait' });
    await busy.started;
    const queued = await execution.submit({ type: 'input', requestId: 'queued', content: 'Follow-up', whenBusy: 'followUp' });
    expect((await execution.status(queued)).status).toBe('queued');
    expect(await execution.withdraw(queued)).toBe('aborted');
    expect((await execution.status(queued)).status).toBe('unanswered');
    await execution.abort();
    expect((await execution.status(active)).status).toBe('unanswered');
    await execution.close();
  });

  it('fences a thrown side effect BEFORE the model can attempt the effect again', async () => {
    let effects = 0;
    let modelCalls = 0;
    const { models } = setup([
      () => { modelCalls++; return call('effect'); },
      () => { modelCalls++; return call('effect', 'duplicated-effect'); },
    ]);
    const execution = await open(new MemoryStorage(), models, [effect(async () => { effects++; throw new Error('Lost acknowledgement after effect'); })]);
    const id = await execution.submit({ type: 'input', requestId: 'unknown-effect', content: 'Effect' });
    await expect(execution.wait(id)).rejects.toBeInstanceOf(NativeExecutionUnknownError);
    expect(effects).toBe(1);
    expect(modelCalls).toBe(1);
    await expect.poll(async () => (await execution.fenceState())?.state).toBe('UNKNOWN');
    await expect(execution.submit({ type: 'input', requestId: 'next', content: 'Try again' })).rejects.toBeInstanceOf(NativeExecutionUnknownError);
    await execution.close();
  });

  it('persists UNKNOWN before reopen, never resumes prior tasks even when marked replay-safe', async () => {
    const memory = durableMemory();
    let effectStarted!: () => void;
    const started = new Promise<void>((resolve) => { effectStarted = resolve; });
    let effects = 0;
    const interruptedTool = effect(async (_args, _api, ctx) => {
      effects++;
      effectStarted();
      return new Promise((_, reject) => ctx.abortSignal!.addEventListener('abort', () => reject(ctx.abortSignal!.reason), { once: true }));
    });
    const { models } = setup([call('effect')]);
    const execution = await open(memory.handle(), models, [interruptedTool]);
    await execution.submit({ type: 'input', requestId: 'interrupted', content: 'Waiting request' });
    await started;
    await execution.close();
    const toolTask = (await memory.backing.scanTasks({ kind: 'pi.tool' }, 10, undefined, context)).items[0]!;
    if (toolTask.state.status !== 'running' && toolTask.state.status !== 'pending') throw new Error('Expected interrupted native tool intent');
    // Model an upstream replay-safe policy left by another host version. Fate still refuses.
    await memory.backing.commit([{ type: 'task', value: { ...toolTask, state: { ...toolTask.state, checkpoint: { phase: 'execute', arguments: {}, replay: 'safe' } } } }], context);
    const before = (await memory.backing.scanTasks({}, 100, undefined, context)).items;
    expect(effects).toBe(1);
    expect(before.some((task) => task.state.status !== 'terminal')).toBe(true);
    let replayed = 0;
    const nextModels = setup([() => { replayed++; return fauxAssistantMessage('Should never happen'); }]).models;
    await expect(open(memory.handle(), nextModels)).rejects.toBeInstanceOf(NativeExecutionUnknownError);
    expect(replayed).toBe(0);
    expect((await memory.backing.scanTasks({}, 100, undefined, context)).items).toEqual(before);
    const record = await memory.backing.findDocument({ kind: 'fate.execution.fence', scope: { kind: 'session' } }, 'current', context);
    expect((await memory.backing.document(record!.id, 'current', context))?.value.state).toBe('UNKNOWN');
    await expect(open(memory.handle(), nextModels)).rejects.toBeInstanceOf(NativeExecutionUnknownError);
    expect(replayed).toBe(0);
  });

  it('reopens a quiescent native store with all history retained', async () => {
    const memory = durableMemory();
    const { models } = setup([fauxAssistantMessage('First answer'), fauxAssistantMessage('Second answer')]);
    const first = await open(memory.handle(), models);
    await first.wait(await first.submit({ type: 'input', requestId: 'first', content: 'First question' }));
    const prior = (await first.entries()).items;
    await first.close();
    const second = await open(memory.handle(), models);
    await second.wait(await second.submit({ type: 'input', requestId: 'second', content: 'Second question' }));
    const after = (await second.entries()).items;
    for (const entry of prior) expect(after).toContainEqual(entry);
    await second.close();
  });

  it('uses native task-owned child conversations and collects the native child answer', async () => {
    const { models } = setup([
      call('fate_delegate', 'delegate-1', { task: 'Inspect the fixture' }),
      fauxAssistantMessage('Child result'),
      fauxAssistantMessage('Parent synthesis'),
    ]);
    const storage = new MemoryStorage();
    const child = createNativeChildTool({ resolve: async () => ({ cwd: '/synthetic-approved-project', tools: [], model, instructions: 'Read-only approved child.' }) });
    const execution = await open(storage, models, [child]);
    expect((await execution.wait(await execution.submit({ type: 'input', requestId: 'parent', content: 'Delegate' }))).status).toBe('done');
    const conversations = (await storage.scanConversations({}, 100, undefined, context)).items;
    expect(conversations).toHaveLength(2);
    const owned = conversations.find((conversation) => conversation.owner !== undefined)!;
    const owner = await storage.task(owned.owner!.taskId, context);
    expect(owner?.kind).toBe('pi.tool');
    expect(owner?.state.status).toBe('terminal');
    expect((await execution.entries(owned.id)).items.some((entry) => entry.kind === 'pi.assistant')).toBe(true);
    await execution.close();
  });

  it('does not publish admission or run a provider if the pre-admission fence commit rejects', async () => {
    let reject = false;
    let calls = 0;
    const backing = new MemoryStorage();
    const storage = new Proxy(backing, { get(target, property) {
      if (property === 'commit') return async (writes: readonly StorageWrite[], ctx: typeof context) => {
        if (reject) throw new Error('Injected ambiguous commit failure');
        return target.commit(writes, ctx);
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const { models } = setup([() => { calls++; return fauxAssistantMessage('Forbidden'); }]);
    const execution = await open(storage, models);
    reject = true;
    await expect(execution.submit({ type: 'input', requestId: 'failure', content: 'No effect' })).rejects.toThrow('Injected ambiguous');
    reject = false;
    await expect(execution.submit({ type: 'input', requestId: 'retry', content: 'Still blocked' })).rejects.toBeInstanceOf(NativeExecutionUnknownError);
    expect(calls).toBe(0);
    await execution.close();
  });


  it('blocks the next model when a tool result receipt commit fails after the effect', async () => {
    const memory = durableMemory();
    let failed = false;
    let effects = 0;
    let requests = 0;
    const storage = new Proxy(memory.handle(), { get(target, property) {
      if (property === 'commit') return async (writes: readonly StorageWrite[], ctx: typeof context) => {
        if (!failed && writes.some((write) => write.type === 'entry' && write.value.kind === ToolResultEntry.kind)) {
          failed = true;
          throw new Error('Lost tool receipt commit');
        }
        return target.commit(writes, ctx);
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const { models } = setup([() => { requests++; return call('effect'); }, () => { requests++; return call('effect', 'duplicate'); }]);
    const execution = await open(storage, models, [effect(async () => { effects++; return { content: [{ type: 'text', text: 'Effect happened' }] }; })]);
    await expect(execution.wait(await execution.submit({ type: 'input', requestId: 'receipt-lost', content: 'Effect' }))).rejects.toBeInstanceOf(NativeExecutionUnknownError);
    expect(effects).toBe(1);
    expect(requests).toBe(1);
    await execution.close();
    await expect(open(memory.handle(), models)).rejects.toBeInstanceOf(NativeExecutionUnknownError);
  });

  it('treats persisted-but-rejected admission commits as UNKNOWN across reopen', async () => {
    const memory = durableMemory();
    let failAfterCommit = false;
    let calls = 0;
    const storage = new Proxy(memory.handle(), { get(target, property) {
      if (property === 'commit') return async (writes: readonly StorageWrite[], ctx: typeof context) => {
        const receipt = await target.commit(writes, ctx);
        if (failAfterCommit) { failAfterCommit = false; throw new Error('Commit persisted but acknowledgement was lost'); }
        return receipt;
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const { models } = setup([() => { calls++; return fauxAssistantMessage('Forbidden'); }]);
    const execution = await open(storage, models);
    failAfterCommit = true;
    await expect(execution.submit({ type: 'input', requestId: 'ambiguous', content: 'No retry' })).rejects.toThrow('acknowledgement');
    await execution.close();
    await expect(open(memory.handle(), models)).rejects.toBeInstanceOf(NativeExecutionUnknownError);
    expect(calls).toBe(0);
  });

  it('checks owner authority before model admission and rejects declared SDK feature gaps', async () => {
    const { models } = setup([fauxAssistantMessage('No')]);
    let owner = true;
    const execution = await open(new MemoryStorage(), models, [], async () => { if (!owner) throw new Error('Owner lost'); });
    owner = false;
    await expect(execution.submit({ type: 'input', requestId: 'owner', content: 'No' })).rejects.toThrow('Owner lost');
    await execution.close();
    await expect(NativeDurableExecution.open({ storage: new MemoryStorage(), models, model, cwd: '/fixture', systemPrompt: '', assertOwnership: async () => {}, requiredSdkFeatures: ['extension-lifecycle'] })).rejects.toThrow('extension-lifecycle');
  });
});
