import { findOwnerRecord } from '../../src/core/ownership/OwnerLock';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreLifecycle } from '../../src/core/lifecycle/CoreLifecycle';
import { createFateCore } from '../../src/core/createFateCore';
import { FatePaths } from '../../src/core/FatePaths';
import { FakePiSdkAdapter } from './helpers/fakePi';
import { ShutdownCoordinator } from '../../src/main/bootstrap/shutdown';
import { privateTestRoot } from './helpers/isolatedEnvironment';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })));
});

async function fixture() {
  const root = await mkdtemp(path.join(privateTestRoot(), 'lifecycle-'));
  roots.push(root);
  const project = path.join(root, 'project');
  await mkdir(project);
  const paths = new FatePaths({ dataRoot: path.join(root, 'data'), piAgentDir: path.join(root, 'agent'),
    sessionsRoot: path.join(root, 'agent', 'sessions'), attachmentRoot: path.join(root, 'attachments'),
    lockRoot: path.join(root, 'locks'), profileId: 'lifecycle-fixture' });
  return { project, paths, adapter: new FakePiSdkAdapter() };
}

describe('T29 core lifetime', () => {
  it('disconnects two clients, including the last one during a live fake run, without stopping the core', async () => {
    const { project, paths, adapter } = await fixture();
    const core = await createFateCore({ paths, adapter });
    try {
      const state = await core.runtime.openProject({ path: project, name: 'fixture', trusted: true });
      const sessionId = state.sessionId!;
      const control = adapter.controls.get(sessionId)!;
      control.barriers.hold('settle');
      const cleanup = vi.fn();
      const first = core.createClient({ disposeSubscriptions: cleanup });
      const second = core.createClient({ disposeTerminals: cleanup });
      await expect(core.runtime.asRouter().prompt({ text: 'live run', behavior: 'prompt' })).resolves.toMatchObject({ accepted: true });
      await control.barriers.reached('settle');
      await core.disposeClient(first);
      await core.disposeClient(second);
      await core.disposeClient(second);
      expect(cleanup).toHaveBeenCalledTimes(2);
      expect(adapter.invocations.filter((item) => item.kind === 'cancel')).toHaveLength(0);
      expect(core.runtime.peekWorkspace(project)?.hasEvictionBlockingWork()).toBe(true);
      control.barriers.release('settle');
      await vi.waitFor(() => expect(adapter.invocations.some((item) => item.kind === 'settled')).toBe(true));
    } finally { await core.dispose(); await adapter.dispose(); }
  });

  it('seals an active registered workspace, requests cancellation, then releases locks only after the run settles', async () => {
    const { project, paths, adapter } = await fixture();
    const core = await createFateCore({ paths, adapter, workspaceRegistration: { isRegistered: (root) => root === project },
      workspaceMembership: () => true });
    try {
      const handle = await core.workspaces!.registerHostPath(project);
      const sessionId = handle.runtime.getState(false).sessionId!;
      const control = adapter.controls.get(sessionId)!;
      control.barriers.hold('settle');
      await expect(handle.runtime.prompt({ text: 'active host run', behavior: 'prompt' })).resolves.toMatchObject({ accepted: true });
      await control.barriers.reached('settle');
      expect(handle.runtime.hasEvictionBlockingWork()).toBe(true);
      await expect(core.workspaces!.dispose()).rejects.toThrow('work is active');
      expect(await core.workspaces!.registerHostPath(project)).toBe(handle);
      core.lifecycle.beginShutdown();
      core.lifecycle.beginShutdown();
      expect(core.lifecycle.settled()).toBeNull();
      expect(() => core.lifecycle.assertAdmission()).toThrow('shutting down');
      await expect(core.workspaces!.registerHostPath(project)).rejects.toThrow('stopping');
      await expect(handle.runtime.prompt({ text: 'late prompt', behavior: 'prompt' })).rejects.toThrow('shutting down');
      expect(adapter.invocations.some((entry) => entry.kind === 'cancel')).toBe(false);
      expect(core.runtime.ownsCheckout(project)).toBe(true);
      expect((await readdir(paths.lockRoot)).some((name) => name.startsWith('profile-'))).toBe(true);
      const shutdown = core.shutdownCore();
      expect(core.shutdownCore()).toBe(shutdown);
      await expect(shutdown).resolves.toEqual({ status: 'settled' });
      const cancellation = adapter.invocations.find((entry) => entry.kind === 'cancel' && entry.sessionId === sessionId);
      const settlement = adapter.invocations.find((entry) => entry.kind === 'settled' && entry.sessionId === sessionId);
      expect(cancellation).toBeDefined();
      expect(settlement).toBeDefined();
      expect(settlement!.sequence).toBeGreaterThan(cancellation!.sequence);
      expect(core.runtime.ownsCheckout(project)).toBe(false);
      expect((await readdir(paths.lockRoot)).some((name) => name.startsWith('profile-'))).toBe(false);
    } finally { await adapter.dispose(); }
  });

  it('fences a new prompt synchronously before cancellation starts and repeats shutdown exactly once', async () => {
    const stop = vi.fn(async () => undefined);
    const fence = vi.fn();
    const lifecycle = new CoreLifecycle({ beginShutdown: fence, shutdown: stop, shutdownBudgetMs: 100 });
    const first = lifecycle.shutdownCore();
    expect(lifecycle.shutdownCore()).toBe(first);
    expect(fence).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(() => lifecycle.assertAdmission()).toThrow('shutting down');
    expect(() => lifecycle.createClient()).toThrow('shutting down');
    await expect(first).resolves.toEqual({ status: 'settled' });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('allows an early host fence without starting core/client disposal or its wait budget', async () => {
    vi.useFakeTimers();
    const shutdown = vi.fn(async () => undefined);
    const cleanup = vi.fn();
    const fence = vi.fn();
    const lifecycle = new CoreLifecycle({ beginShutdown: fence, shutdown, shutdownBudgetMs: 10 });
    lifecycle.createClient({ disposeTerminals: cleanup });
    lifecycle.beginShutdown();
    lifecycle.beginShutdown();
    expect(lifecycle.isStopping).toBe(true);
    expect(fence).toHaveBeenCalledOnce();
    expect(() => lifecycle.assertAdmission()).toThrow('shutting down');
    expect(() => lifecycle.createClient()).toThrow('shutting down');
    await vi.advanceTimersByTimeAsync(20);
    expect(lifecycle.settled()).toBeNull();
    expect(shutdown).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const result = lifecycle.shutdownCore();
    expect(lifecycle.shutdownCore()).toBe(result);
    await expect(result).resolves.toEqual({ status: 'settled' });
    expect(fence).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('does not duplicate shutdown if the existing fence reenters shutdownCore', async () => {
    const shutdown = vi.fn(async () => undefined);
    let lifecycle!: CoreLifecycle;
    let nested: ReturnType<CoreLifecycle['shutdownCore']> | undefined;
    const fence = vi.fn(() => { nested = lifecycle.shutdownCore(); });
    lifecycle = new CoreLifecycle({ beginShutdown: fence, shutdown });
    const result = lifecycle.shutdownCore();
    expect(nested).toBe(result);
    await expect(result).resolves.toEqual({ status: 'settled' });
    expect(fence).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('does not release a lock or claim clean completion when cancellation refuses to stop', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const lockRelease = vi.fn();
    const lifecycle = new CoreLifecycle({ shutdownBudgetMs: 10, beginShutdown: () => undefined,
      shutdown: async () => { await blocked; lockRelease(); } });
    try {
      const result = lifecycle.shutdownCore();
      expect(lifecycle.shutdownCore()).toBe(result);
      await expect(result).resolves.toEqual({ status: 'incomplete', reason: 'timeout' });
      expect(lockRelease).not.toHaveBeenCalled();
    } finally { release(); await lifecycle.settled(); }
    expect(lockRelease).toHaveBeenCalledOnce();
  });

  it('repeated shutdown never releases a profile lock whose owner token changed', async () => {
    const { paths, adapter } = await fixture();
    const core = await createFateCore({ paths, adapter });
    const name = (await readdir(paths.lockRoot)).find((entry) => entry.startsWith('profile-'))!;
    const recordFile = (await findOwnerRecord(path.join(paths.lockRoot, name)))!;
    const record: unknown = JSON.parse(await readFile(recordFile, 'utf8'));
    if (!record || typeof record !== 'object' || !('token' in record)) throw new Error('Fixture profile lock is missing.');
    await writeFile(recordFile, JSON.stringify({ ...record, token: 'another-owner' }));
    const shutdown = core.shutdownCore();
    expect(core.shutdownCore()).toBe(shutdown);
    await expect(shutdown).resolves.toEqual({ status: 'incomplete', reason: 'failed' });
    expect((await readdir(paths.lockRoot)).includes(name)).toBe(true);
    await expect(core.dispose()).rejects.toThrow('refusing to release another owner');
    await adapter.dispose();
  });

  it('retains profile and checkout ownership after a fake provider refuses cancellation', async () => {
    const { project, paths, adapter } = await fixture();
    const core = await createFateCore({ paths, adapter, shutdownBudgetMs: 50 });
    const state = await core.runtime.openProject({ path: project, name: 'fixture', trusted: true });
    const control = adapter.controls.get(state.sessionId!)!;
    control.barriers.hold('settle');
    control.refuseCancellation = true;
    try {
      await expect(core.runtime.asRouter().prompt({ text: 'refuse to stop', behavior: 'prompt' })).resolves.toMatchObject({ accepted: true });
      await control.barriers.reached('settle');
      const result = core.shutdownCore();
      await expect(core.runtime.asRouter().prompt({ text: 'late', behavior: 'prompt' })).rejects.toThrow('shutting down');
      expect((await result).status).toBe('incomplete');
      expect((await readdir(paths.lockRoot)).some((name) => name.startsWith('profile-'))).toBe(true);
      expect(core.runtime.ownsCheckout(project)).toBe(true);
      control.barriers.releaseAll();
      await expect(core.dispose()).rejects.toThrow();
      expect((await readdir(paths.lockRoot)).some((name) => name.startsWith('profile-'))).toBe(true);
    } finally { control.barriers.releaseAll(); await adapter.dispose(); }
  });

  it('keeps client cleanup independent even when one callback throws synchronously', async () => {
    const second = vi.fn();
    const lifecycle = new CoreLifecycle({ beginShutdown: () => undefined, shutdown: async () => undefined });
    const client = lifecycle.createClient({ disposeSubscriptions: () => { throw new Error('socket'); }, disposeTerminals: second });
    const cleaning = lifecycle.disposeClient(client);
    expect(lifecycle.disposeClient(client)).toBe(cleaning);
    await expect(cleaning).rejects.toThrow('socket');
    expect(second).toHaveBeenCalledOnce();
    await expect(lifecycle.shutdownCore()).resolves.toEqual({ status: 'incomplete', reason: 'failed' });
  });

  it('desktop exits nonzero on an incomplete core result without writing a clean marker', async () => {
    const clean = vi.fn();
    const exit = vi.fn();
    const coordinator = new ShutdownCoordinator({ disposeAsync: () => [Promise.resolve({ status: 'incomplete' })],
      onClean: clean, onExit: exit });
    expect(coordinator.requestShutdown()).toBe(true);
    await coordinator.settled();
    expect(clean).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith('incomplete');
  });

  it('bounds a stalled desktop clean-marker write after actual core settlement', async () => {
    const exit = vi.fn();
    const coordinator = new ShutdownCoordinator({ disposeAsync: () => [Promise.resolve({ status: 'settled' })],
      onClean: () => new Promise<void>(() => undefined), onExit: exit, timeoutMs: 10 });
    coordinator.requestShutdown();
    await coordinator.settled();
    expect(exit).toHaveBeenCalledWith('incomplete');
  });

  it.each([new Error('fence failed'), undefined])('retains an early fence failure, including a falsy throw, until shutdown (%s)', async (failure) => {
    const shutdown = vi.fn(async () => undefined);
    const fence = vi.fn(() => { throw failure; });
    const lifecycle = new CoreLifecycle({ beginShutdown: fence, shutdown });
    lifecycle.beginShutdown();
    lifecycle.beginShutdown();
    expect(lifecycle.settled()).toBeNull();
    expect(shutdown).not.toHaveBeenCalled();
    expect(() => lifecycle.assertAdmission()).toThrow('shutting down');
    const result = lifecycle.shutdownCore();
    expect(lifecycle.shutdownCore()).toBe(result);
    await expect(result).resolves.toEqual({ status: 'incomplete', reason: 'failed' });
    expect(fence).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    await expect(lifecycle.settled()).rejects.toBe(failure);
  });
});
