import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createModels } from '@earendil-works/pi-ai';
import { MemoryStorage, type Storage, type StorageWrite } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { OwnerLock } from '../../src/core/ownership/OwnerLock';
import { DurableStorageCloseUncertainError, openOwnedDurableStorage } from '../../src/core/durable/OwnedDurableStorage';
import { createOwnedNativeWorkflowSchedulerFactory, NativeWorkflowScheduler, type NativeWorkflowRun } from '../../src/main/pi/durable/NativeWorkflowScheduler';
import { NativeExecutionUnknownError } from '../../src/main/pi/durable/NativeExecutionFence';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const input = { id: 'native-workflow', parentSessionId: 'legacy-sdk-parent', cwd: '/synthetic', models: createModels() };
const work: NativeWorkflowRun = { nodes: [{ id: 'one', dependsOn: [], dependencyFailure: 'skip' }], concurrency: () => 1, started: () => {}, settled: () => {}, execute: async (id) => ({ id, status: 'completed', value: { sdkSessionId: 'original-jsonl' } }) };
function wrap(backing: Storage, overrides: Record<string, unknown>): Storage { return new Proxy(backing, { get(target, key) { if (typeof key === 'string' && key in overrides) return overrides[key]; const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } }); }

describe('owned native workflow factory and unsafe callbacks', () => {
  it('writes the real native graph to profile-owned WAL/FULL SQLite and releases only the database handle', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fate-owned-native-workflow-')); roots.push(root);
    const dataRoot = path.join(root, 'profile'); await mkdir(dataRoot, { mode: 0o700 });
    const owner = await OwnerLock.acquire(path.join(root, 'owners'), 'profile', dataRoot);
    const make = createOwnedNativeWorkflowSchedulerFactory({ dataRoot, profileOwner: owner });
    const scope = await make(input);
    await scope.run(work, new AbortController().signal);
    const identity = createHash('sha256').update(`${input.cwd}\0${input.parentSessionId}\0${input.id}`).digest('hex');
    const inspected = await openOwnedDurableStorage({ dataRoot, profileOwner: owner, filename: `workflow-${identity}.sqlite` });
    expect(inspected.diagnostics).toMatchObject({ journalMode: 'wal', synchronous: 2 });
    const tasks = (await inspected.storage.scanTasks({}, 10, undefined, BACKGROUND_CONTEXT)).items;
    expect(tasks.map((task) => task.kind).sort()).toEqual(['fate.workflow.graph', 'fate.workflow.node']);
    expect(tasks.every((task) => task.state.status === 'terminal')).toBe(true);
    await inspected.storage.close(BACKGROUND_CONTEXT);
    await owner.release();
  });

  it('notifies owner retention before a failed close is returned and preserves that close outcome', async () => {
    const order: string[] = [];
    let closed = 0;
    const storage = wrap(new MemoryStorage(), { close: async () => { closed++; throw new Error('Failed native database close'); } });
    const scope = new NativeWorkflowScheduler({ ...input, storage, assertOwnership: async () => {}, onCloseUncertain: (error) => { expect(error).toBeInstanceOf(DurableStorageCloseUncertainError); order.push('retain'); }, onUnsafeFailure: () => { order.push('fence'); } });
    await expect(scope.run(work, new AbortController().signal).catch((error) => { order.push('rejected'); throw error; })).rejects.toBeInstanceOf(DurableStorageCloseUncertainError);
    expect(order).toEqual(['fence', 'retain', 'rejected']);
    await expect(scope.close()).rejects.toBeInstanceOf(DurableStorageCloseUncertainError);
    expect(closed).toBe(1);
  });

  it('reports an ambiguous bootstrap commit as unsafe even when the backend originally throws a plain Error', async () => {
    const backing = new MemoryStorage();
    let failed = false;
    const unsafe: unknown[] = [];
    const storage = wrap(backing, { commit: async (writes: readonly StorageWrite[], ctx: typeof BACKGROUND_CONTEXT) => {
      const value = await backing.commit(writes, ctx);
      if (!failed) { failed = true; throw new Error('Lost bootstrap acknowledgement'); }
      return value;
    } });
    const scope = new NativeWorkflowScheduler({ ...input, storage, assertOwnership: async () => {}, onUnsafeFailure: (error) => { unsafe.push(error); } });
    await expect(scope.run(work, new AbortController().signal)).rejects.toBeInstanceOf(NativeExecutionUnknownError);
    expect(unsafe).toHaveLength(1);
  });

  it('does not classify pre-admission invalid input or normal pre-admission cancellation as unsafe', async () => {
    const unsafe: unknown[] = [];
    const make = () => new NativeWorkflowScheduler({ ...input, storage: new MemoryStorage(), assertOwnership: async () => {}, onUnsafeFailure: (error) => { unsafe.push(error); } });
    await expect(make().run({ ...work, nodes: [] }, new AbortController().signal)).rejects.toThrow('1–256');
    const signal = new AbortController(); signal.abort(new DOMException('Cancelled before admission', 'AbortError'));
    await expect(make().run(work, signal.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(unsafe).toEqual([]);
  });
  it('does not create unidentified history for invalid or already-cancelled new work', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fate-pristine-native-workflow-')); roots.push(root);
    const dataRoot = path.join(root, 'profile'); await mkdir(dataRoot, { mode: 0o700 });
    const owner = await OwnerLock.acquire(path.join(root, 'owners'), 'profile', dataRoot);
    const unsafe: unknown[] = [];
    const make = createOwnedNativeWorkflowSchedulerFactory({ dataRoot, profileOwner: owner, onUnsafeFailure: (error) => { unsafe.push(error); } });
    const invalid = await make({ ...input, id: 'known-invalid' });
    await expect(invalid.run({ ...work, nodes: [] }, new AbortController().signal)).rejects.toThrow('1–256');
    const cancelled = await make({ ...input, id: 'known-cancelled' });
    const signal = new AbortController(); signal.abort(new DOMException('Cancelled before admission', 'AbortError'));
    await expect(cancelled.run(work, signal.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const files = await import('node:fs/promises').then((fs) => fs.readdir(path.join(dataRoot, 'durable', 'v1')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; }));
    expect(files).toEqual([]);
    expect(unsafe).toEqual([]);
    await owner.release();
  });

  it('retains one lazy handle per identity until confirmed close without poisoning known duplicate admission', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fate-duplicate-native-workflow-')); roots.push(root);
    const dataRoot = path.join(root, 'profile'); await mkdir(dataRoot, { mode: 0o700 });
    const owner = await OwnerLock.acquire(path.join(root, 'owners'), 'profile', dataRoot);
    const unsafe: unknown[] = [];
    const make = createOwnedNativeWorkflowSchedulerFactory({ dataRoot, profileOwner: owner, onUnsafeFailure: (error) => { unsafe.push(error); } });
    const first = await make(input);
    await expect(make(input)).rejects.toThrow('active owned handle');
    await first.close();
    const replacement = await make(input);
    await replacement.run(work, new AbortController().signal);
    expect(unsafe).toEqual([]);
    await owner.release();
  });

});
