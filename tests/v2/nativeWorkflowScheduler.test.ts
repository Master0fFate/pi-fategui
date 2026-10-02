import { describe, expect, it } from 'vitest';
import { createModels } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { MemoryStorage, type Storage, type StorageWrite } from '@earendil-works/pi-durable';
import { NativeWorkflowScheduler, type NativeWorkflowRun } from '../../src/main/pi/durable/NativeWorkflowScheduler';
import { NativeExecutionUnknownError } from '../../src/main/pi/durable/NativeExecutionFence';

const ctx = BACKGROUND_CONTEXT;
const noop = () => {};
function memory() {
  const backing = new MemoryStorage();
  return { backing, handle: (): Storage => new Proxy(backing, { get(target, key) { if (key === 'close') return async () => {}; const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } }) };
}
function scheduler(storage: Storage) { return new NativeWorkflowScheduler({ storage, id: 'workflow-fixture', parentSessionId: 'sdk-parent', cwd: '/sdk-project', models: createModels(), assertOwnership: async () => {} }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { resolve, promise }; }
const node = (id: string, dependsOn: string[] = [], dependencyFailure: 'run' | 'skip' = 'skip') => ({ id, dependsOn, dependencyFailure });

describe('native task orchestration around existing SDK child execution', () => {
  it('releases capacity at the first native child receipt and retains SDK results as native task evidence', async () => {
    const storage = memory();
    const releaseA = deferred<void>();
    const starts: string[] = [];
    const settled: string[] = [];
    const scope = scheduler(storage.handle());
    const work: NativeWorkflowRun = {
      nodes: [node('a'), node('b'), node('c', ['b'])], concurrency: () => 2,
      started: (id) => { starts.push(id); }, settled: (result) => { settled.push(result.id); },
      execute: async (id, dependencies) => {
        if (id === 'a') await releaseA.promise;
        if (id === 'c') expect(dependencies.b).toEqual({ id: 'b', status: 'completed', value: { sdkSessionId: 'existing-jsonl-b' } });
        return { id, status: 'completed', value: { sdkSessionId: `existing-jsonl-${id}` } };
      },
    };
    const run = scope.run(work, new AbortController().signal);
    await expect.poll(() => starts).toContain('c');
    expect(settled).not.toContain('a');
    releaseA.resolve();
    const result = await run;
    expect(Object.keys(result.nodes).sort()).toEqual(['a', 'b', 'c']);
    const tasks = (await storage.backing.scanTasks({}, 30, undefined, ctx)).items;
    expect(tasks.filter((task) => task.kind === 'fate.workflow.graph')).toHaveLength(1);
    const children = tasks.filter((task) => task.kind === 'fate.workflow.node');
    expect(children).toHaveLength(3);
    expect(children.every((task) => task.owner === tasks.find((entry) => entry.kind === 'fate.workflow.graph')!.id && task.state.status === 'terminal')).toBe(true);
    expect(tasks.some((task) => task.kind === 'pi.generation')).toBe(false);
    const root = (await storage.backing.scanConversations({}, 10, undefined, ctx)).items[0]!;
    expect((await storage.backing.scanEntries({ conversationId: root.id }, 10, undefined, ctx)).items).toEqual([]);
  });

  it('uses confirmed native receipts for skip/run dependency policy without relaunching failed SDK work', async () => {
    const executed: string[] = [];
    const result = await scheduler(memory().handle()).run({
      nodes: [node('failed'), node('skip', ['failed']), node('continue', ['failed'], 'run')], concurrency: () => 2, started: noop, settled: noop,
      execute: async (id, dependencies) => { executed.push(id); if (id === 'continue') expect(dependencies.failed?.status).toBe('error'); return { id, status: id === 'failed' ? 'error' : 'completed', value: { retainedSdkSession: id } }; },
    }, new AbortController().signal);
    expect(executed).toEqual(['failed', 'continue']);
    expect(result.nodes.skip?.status).toBe('skipped');
    expect(result.nodes.failed?.status).toBe('error');
  });

  it('quarantines an SDK launch with unknown outcome and never replays it after reopen', async () => {
    const storage = memory();
    let effects = 0;
    const work: NativeWorkflowRun = { nodes: [node('effect'), node('later', ['effect'], 'run')], concurrency: () => 1, started: noop, settled: noop, execute: async () => { effects++; throw new Error('Lost SDK completion'); } };
    await expect(scheduler(storage.handle()).run(work, new AbortController().signal)).rejects.toBeInstanceOf(NativeExecutionUnknownError);
    const before = (await storage.backing.scanTasks({}, 30, undefined, ctx)).items;
    await expect(scheduler(storage.handle()).run(work, new AbortController().signal)).rejects.toBeInstanceOf(NativeExecutionUnknownError);
    expect(effects).toBe(1);
    expect((await storage.backing.scanTasks({}, 30, undefined, ctx)).items).toEqual(before);
  });

  it('fences after a missing native node receipt and does not launch a dependent SDK child', async () => {
    const storage = memory();
    let fail = true;
    const handle = storage.handle();
    const failing = new Proxy(handle, { get(target, key) {
      if (key === 'commit') return async (writes: readonly StorageWrite[], context: typeof ctx) => {
        if (fail && writes.some((write) => write.type === 'task' && write.value.kind === 'fate.workflow.node' && write.value.state.status === 'terminal')) { fail = false; throw new Error('Native receipt commit lost'); }
        return target.commit(writes, context);
      };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const starts: string[] = [];
    await expect(scheduler(failing).run({ nodes: [node('first'), node('dependent', ['first'])], concurrency: () => 1, started: noop, settled: noop, execute: async (id) => { starts.push(id); return { id, status: 'completed' }; } }, new AbortController().signal)).rejects.toBeInstanceOf(NativeExecutionUnknownError);
    expect(starts).toEqual(['first']);
  });

  it('native ownership cancellation signals existing SDK work and admits no dependency afterward', async () => {
    const storage = memory();
    const parent = new AbortController();
    const starts: string[] = [];
    let sdkAborted = false;
    const run = scheduler(storage.handle()).run({ nodes: [node('active'), node('later', ['active'])], concurrency: () => 1, started: noop, settled: noop, execute: async (id, _dependencies, signal) => {
      starts.push(id);
      return new Promise((_, reject) => signal.addEventListener('abort', () => { sdkAborted = true; reject(signal.reason); }, { once: true }));
    } }, parent.signal);
    const observed = expect(run).rejects.toThrow();
    await expect.poll(() => starts).toEqual(['active']);
    parent.abort('User cancelled workflow');
    await observed;
    expect(sdkAborted).toBe(true);
    expect(starts).toEqual(['active']);
  });

  it('does not reuse a completed native graph identity and closes malformed graphs', async () => {
    const storage = memory();
    let executions = 0;
    const work: NativeWorkflowRun = { nodes: [node('single')], concurrency: () => 1, started: noop, settled: noop, execute: async (id) => { executions++; return { id, status: 'completed' }; } };
    await scheduler(storage.handle()).run(work, new AbortController().signal);
    await expect(scheduler(storage.handle()).run(work, new AbortController().signal)).rejects.toThrow('already has history');
    expect(executions).toBe(1);
    let closed = 0;
    const handle = memory().handle();
    const tracked = new Proxy(handle, { get(target, key) { if (key === 'close') return async () => { closed++; }; const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } });
    await expect(scheduler(tracked).run({ ...work, nodes: [node('cycle', ['cycle'])] }, new AbortController().signal)).rejects.toThrow('dependency cycle');
    expect(closed).toBe(1);
  });
  it('retains active durable evidence and open ownership while an SDK callback ignores abort', async () => {
    const storage = memory();
    const release = deferred<void>();
    const parent = new AbortController();
    let started = false;
    let nativeCloseCalls = 0;
    let lateEffects = 0;
    let settled = false;
    const handle = storage.handle();
    const tracked = new Proxy(handle, { get(target, key) { if (key === 'close') return async () => { nativeCloseCalls++; }; const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } });
    const run = scheduler(tracked).run({ nodes: [node('held'), node('later', ['held'])], concurrency: () => 1, started: noop, settled: noop,
      execute: async (id) => { started = true; await release.promise; lateEffects++; return { id, status: 'completed' }; },
    }, parent.signal);
    const observed = run.then(() => { settled = true; }, () => { settled = true; });
    await expect.poll(() => started).toBe(true);
    parent.abort('Ignored abort');
    // Read actual persisted evidence rather than relying only on the returned promise.
    const record = await storage.backing.findDocument({ kind: 'fate.execution.fence', scope: { kind: 'session' } }, 'current', ctx);
    expect((await storage.backing.document(record!.id, 'current', ctx))?.value.state).toBe('active');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(nativeCloseCalls).toBe(0);
    release.resolve();
    await observed;
    expect(lateEffects).toBe(1);
    expect(nativeCloseCalls).toBe(1);
    expect((await storage.backing.document(record!.id, 'current', ctx))?.value.state).toBe('UNKNOWN');
  });

  it('bounds graph admission and handles prototype-like valid node identities', async () => {
    const work: NativeWorkflowRun = { nodes: [node('constructor'), node('toString', ['constructor'])], concurrency: () => 10_000, started: noop, settled: noop, execute: async (id) => ({ id, status: 'completed' }) };
    const result = await scheduler(memory().handle()).run(work, new AbortController().signal);
    expect(Object.keys(result.nodes)).toEqual(['constructor', 'toString']);
    await expect(scheduler(memory().handle()).run({ ...work, nodes: Array.from({ length: 257 }, (_, index) => node(`node-${index}`)) }, new AbortController().signal)).rejects.toThrow('1–256');
  });

});
