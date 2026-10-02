import { randomUUID } from 'node:crypto';
import { createModels } from '@earendil-works/pi-ai/models';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFateCore } from '../../src/core/createFateCore';
import { FateDurableStore } from '../../src/core/durable/FateDurableStore';
import { DurableStorageCloseUncertainError } from '../../src/core/durable/OwnedDurableStorage';
import { FatePaths } from '../../src/core/FatePaths';
import { MultiProjectPiRuntime, type MultiProjectPiRuntimeDeps } from '../../src/main/pi/MultiProjectPiRuntime';
import { SessionQueueRepository } from '../../src/main/pi/SessionQueueRepository';
import { resolveStatePersistenceBackend } from '../../src/shared/v2FeaturePolicy';
import { parseServerConfig } from '../../src/server/config';
import { startNodeServerWithFactory } from '../../src/server/compose';
import type { FateCoreOptions } from '../../src/core/createFateCore';
import { FakePiSdkAdapter } from './helpers/fakePi';
import { privateTestRoot } from './helpers/isolatedEnvironment';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(privateTestRoot(), 'native-composition-')); roots.push(root);
  const project = path.join(root, 'project'); await fs.mkdir(project);
  const paths = new FatePaths({ dataRoot: path.join(root, 'data'), piAgentDir: path.join(root, 'pi'), sessionsRoot: path.join(root, 'pi', 'sessions'),
    attachmentRoot: path.join(root, 'attachments'), lockRoot: path.join(root, 'locks'), profileId: 'native-fixture', profileKind: 'desktop' });
  const adapter = new FakePiSdkAdapter();
  const createRuntime = vi.fn((dependencies: MultiProjectPiRuntimeDeps) => new MultiProjectPiRuntime(dependencies));
  return { root, paths, project, adapter, createRuntime };
}

describe('actual native state composition and rollout', () => {
  it('selects one durable queue/task/goal authority and reopens it after actual core shutdown', async () => {
    const f = await fixture();
    const message = { id: randomUUID(), behavior: 'followUp' as const, text: 'A synthetic editable draft, never execute at startup', createdAt: 1 };
    const core = await createFateCore({ ...f, statePersistence: 'native-durable' });
    const dependencies = f.createRuntime.mock.calls[0]![0];
    try {
      expect(core.statePersistence).toBe('native-durable');
      expect(dependencies.createTaskPersistence).toBeTypeOf('function');
      await dependencies.createQueuePersistence!().save(f.project, 'synthetic-session', [message]);
      expect((await fs.stat(path.join(f.paths.dataRoot, 'durable', 'v1', 'state.sqlite'))).size).toBeGreaterThan(0);
      await expect(fs.stat(path.join(f.paths.dataRoot, 'session-queues', 'v1'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(f.adapter.invocations).toHaveLength(0);
      await expect(core.shutdownCore()).resolves.toEqual({ status: 'settled' });
      await expect(dependencies.createQueuePersistence!().load(f.project, 'synthetic-session')).rejects.toThrow();
    } finally { await core.dispose(); }
    // Activated native state is selected on ordinary restart without a hidden second flag.
    const restarted = await createFateCore({ ...f });
    try {
      expect(restarted.statePersistence).toBe('native-durable');
      const current = f.createRuntime.mock.calls.at(-1)![0];
      await expect(current.createQueuePersistence!().load(f.project, 'synthetic-session')).resolves.toEqual([message]);
      expect(f.adapter.invocations).toHaveLength(0);
    } finally { await restarted.dispose(); await f.adapter.dispose(); }
  });

  it('refuses empty native activation over legacy drafts without changing source bytes', async () => {
    const f = await fixture();
    const legacy = new SessionQueueRepository(path.join(f.paths.dataRoot, 'session-queues', 'v1'), 1);
    const messages = [{ id: randomUUID(), behavior: 'steer' as const, text: 'must remain intact', createdAt: 1 }];
    await legacy.save(f.project, 'saved-session', messages);
    await expect(createFateCore({ ...f, statePersistence: 'native-durable' })).rejects.toThrow('explicit validated migration');
    await expect(legacy.load(f.project, 'saved-session')).resolves.toEqual(messages);
    expect(f.createRuntime).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(f.paths.dataRoot, 'durable'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(f.paths.lockRoot)).toEqual([]);
    await f.adapter.dispose();
  });

  it('never falls back to stale legacy state and never opens a competing owner', async () => {
    const f = await fixture();
    const core = await createFateCore({ ...f, statePersistence: 'native-durable' });
    try {
      await expect(createFateCore({ ...f, statePersistence: 'native-durable' })).rejects.toThrow('Owner already in use');
      await expect(createFateCore({ ...f })).rejects.toThrow('Owner already in use');
    } finally { await core.dispose(); }
    await expect(createFateCore({ ...f, statePersistence: 'legacy-json' })).rejects.toThrow('Native durable state exists');
    expect(await fs.readdir(f.paths.lockRoot)).toEqual([]);
    await f.adapter.dispose();
  });

  it('forwards only a validated host-local server state selection to the actual core', async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.root, 'server-profile'), { mode: 0o700 });
    const input = { profile: { profileId: 'server-native', profileRoot: path.join(f.root, 'server-profile'), home: f.root },
      statePersistence: 'native-durable', workspaces: [f.project], host: '127.0.0.1', port: 43199, flags: { terminal: false, browser: false } };
    expect((await parseServerConfig(input)).statePersistence).toBe('native-durable');
    await expect(parseServerConfig({ ...input, statePersistence: 'auto' })).rejects.toThrow();
    const factory = vi.fn((options: FateCoreOptions) => createFateCore({ ...options, adapter: f.adapter }));
    const server = await startNodeServerWithFactory(input, factory);
    try {
      expect(factory.mock.calls[0]![0].statePersistence).toBe('native-durable');
      expect(server.core.statePersistence).toBe('native-durable');
      expect(server.readiness.listener).toBe('disabled');
      expect(f.adapter.invocations).toHaveLength(0);
    } finally { await server.stop(); await server.core.dispose(); await f.adapter.dispose(); }
  });

  it('retains profile ownership when native startup cannot confirm its storage cleanup', async () => {
    const f = await fixture();
    // Typed factory-failure seam only: no actual database or unowned child is opened.
    vi.spyOn(FateDurableStore, 'open').mockRejectedValueOnce(new DurableStorageCloseUncertainError([new Error('synthetic close failure')], 'Synthetic uncertain startup close'));
    await expect(createFateCore({ ...f, statePersistence: 'native-durable' })).rejects.toThrow('cleanup was incomplete');
    expect(f.createRuntime).not.toHaveBeenCalled();
    const locks = await fs.readdir(f.paths.lockRoot);
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatch(/^profile-.*\.lock$/u);
    await expect(createFateCore({ ...f, statePersistence: 'native-durable' })).rejects.toThrow('Owner already in use');
    await f.adapter.dispose();
  });

  it('uses native task scheduling in the selected core and fences the SDK host after an uncertain node', async () => {
    const f = await fixture();
    const core = await createFateCore({ ...f, statePersistence: 'native-durable' });
    try {
      const factory = f.createRuntime.mock.calls[0]![0].nativeWorkflowSchedulerFactory;
      expect(factory).toBeTypeOf('function');
      const models = createModels(); // Actual native Models with no provider configured.
      const scheduler = await factory!({ id: 'synthetic-good-graph', parentSessionId: 'synthetic-parent', cwd: f.project, models });
      const started = vi.fn(), settled = vi.fn(), effect = vi.fn(async (id: string) => ({ id, status: 'completed' as const, value: { synthetic: true } }));
      await expect(scheduler.run({ nodes: [{ id: 'first', dependsOn: [], dependencyFailure: 'skip' }], concurrency: () => 1, execute: effect, started, settled }, new AbortController().signal))
        .resolves.toMatchObject({ nodes: { first: { status: 'completed' } } });
      expect(effect).toHaveBeenCalledOnce(); expect(started).toHaveBeenCalledOnce(); expect(settled).toHaveBeenCalledOnce();
      expect(f.adapter.invocations).toHaveLength(0); // Native orchestration did not create another Pi conversation engine.
      const fence = vi.spyOn(core.runtime, 'beginShutdown');
      const failing = await factory!({ id: 'synthetic-unknown-graph', parentSessionId: 'synthetic-parent', cwd: f.project, models });
      await expect(failing.run({ nodes: [{ id: 'uncertain', dependsOn: [], dependencyFailure: 'skip' }], concurrency: () => 1,
        execute: async () => { throw new Error('synthetic effect outcome unavailable'); }, started: () => {}, settled: () => {} }, new AbortController().signal)).rejects.toThrow();
      expect(fence).toHaveBeenCalled();
      await expect(core.runtime.openProject({ path: f.project, name: 'Synthetic', trusted: true })).rejects.toThrow();
    } finally { await core.dispose(); await f.adapter.dispose(); }
    // The previous UNKNOWN blocks ordinary startup before a different workflow
    // identity or a fresh parent model turn can be admitted.
    const constructions = f.createRuntime.mock.calls.length;
    await expect(createFateCore({ ...f })).rejects.toThrow('Native workflow history requires stopped-owner review');
    expect(f.createRuntime).toHaveBeenCalledTimes(constructions);
    expect(await fs.readdir(f.paths.lockRoot)).toEqual([]);
  });

  it('rejects unknown backends and split-authority overrides before creating state', async () => {
    expect(resolveStatePersistenceBackend(undefined)).toBe('legacy-json');
    expect(() => resolveStatePersistenceBackend('auto')).toThrow();
    const f = await fixture();
    await expect(createFateCore({ ...f, statePersistence: 'native-durable', persistence: { createQueue: () => new SessionQueueRepository() } })).rejects.toThrow('one authoritative store');
    await expect(fs.stat(f.paths.dataRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await f.adapter.dispose();
  });
});
