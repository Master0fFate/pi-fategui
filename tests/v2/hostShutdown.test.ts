import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostShutdown } from '../../src/server/HostShutdown';
import { OwnerLock, OwnershipConflict } from '../../src/core/ownership/OwnerLock';
import { runForegroundHost } from '../../src/cli/foreground';
import { privateTestRoot } from './helpers/isolatedEnvironment';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
afterEach(() => vi.useRealTimers());

describe('host shutdown waits for transport-owned writers before core ownership release', () => {
  it('retains a real profile owner beyond the grace budget until terminal exit is observed', async () => {
    const root = await fs.mkdtemp(path.join(privateTestRoot(), 'host-stop-'));
    const locks = path.join(root, 'locks'), resource = path.join(root, 'profile');
    const owner = await OwnerLock.acquire(locks, 'profile', resource);
    const terminal = deferred();
    const fence = vi.fn();
    const stopCore = vi.fn(async () => { await owner.release(); return { status: 'settled' as const }; });
    const host = createHostShutdown({ fence, stopTransports: () => terminal.promise, stopCore,
      coreSettlement: () => null, budgetMs: 10 });
    try {
      const first = host.stop();
      expect(host.stop()).toBe(first);
      expect(fence).toHaveBeenCalledOnce();
      expect(await first).toEqual({ status: 'incomplete', reason: 'timeout' });
      expect(stopCore).not.toHaveBeenCalled();
      await expect(OwnerLock.acquire(locks, 'profile', resource)).rejects.toBeInstanceOf(OwnershipConflict);
      terminal.resolve();
      await host.settled();
      expect(stopCore).toHaveBeenCalledOnce();
      const replacement = await OwnerLock.acquire(locks, 'profile', resource);
      await replacement.release();
    } finally {
      terminal.resolve(); await host.settled(); await owner.release();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('fences transport synchronously and reserves its single result before a reentrant observer', async () => {
    let host!: ReturnType<typeof createHostShutdown>;
    let nested: ReturnType<typeof host.stop> | undefined;
    const transports = vi.fn(async () => undefined);
    const core = vi.fn(async () => ({ status: 'settled' as const }));
    host = createHostShutdown({ fence: () => { nested = host.stop(); }, stopTransports: transports,
      stopCore: core, coreSettlement: () => null });
    const first = host.stop();
    expect(nested).toBe(first);
    expect(transports).toHaveBeenCalledOnce();
    expect(await first).toEqual({ status: 'settled' });
    expect(core).toHaveBeenCalledOnce();
  });

  it.each(['transport', 'fence'] as const)('does not release core ownership after a %s failure', async (failure) => {
    const stopTransports = vi.fn(async () => { if (failure === 'transport') throw new Error('Synthetic stop failure'); });
    const stopCore = vi.fn(async () => ({ status: 'settled' as const }));
    const host = createHostShutdown({ fence: () => { if (failure === 'fence') throw new Error('Synthetic fence failure'); },
      stopTransports, stopCore, coreSettlement: () => null });
    expect(await host.stop()).toEqual({ status: 'incomplete', reason: 'failed' });
    await expect(host.settled()).rejects.toThrow(/Synthetic/);
    expect(stopTransports).toHaveBeenCalledOnce();
    expect(stopCore).not.toHaveBeenCalled();
  });

  it('waits for actual core completion after its separate grace result expires', async () => {
    vi.useFakeTimers();
    const core = deferred();
    const host = createHostShutdown({ fence: () => undefined, stopTransports: async () => undefined,
      stopCore: async () => ({ status: 'incomplete', reason: 'timeout' }), coreSettlement: () => core.promise, budgetMs: 5 });
    const stopped = host.stop();
    await vi.advanceTimersByTimeAsync(5);
    expect(await stopped).toEqual({ status: 'incomplete', reason: 'timeout' });
    core.resolve(); await host.settled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not certify core completion without an actual settlement promise', async () => {
    const host = createHostShutdown({ fence: () => undefined, stopTransports: async () => undefined,
      stopCore: async () => ({ status: 'incomplete', reason: 'failed' }), coreSettlement: () => null });
    expect(await host.stop()).toEqual({ status: 'incomplete', reason: 'failed' });
    await expect(host.settled()).rejects.toThrow('settlement is unavailable');
  });

  it('foreground retention follows the whole host promise, not a missing or already completed core promise', async () => {
    const host = deferred();
    const signals = new EventEmitter();
    const write = vi.fn();
    let returned = false;
    const foreground = runForegroundHost({ stop: async () => ({ status: 'incomplete', reason: 'timeout' }),
      settled: () => host.promise, core: { lifecycle: { settled: () => Promise.resolve() } } }, signals, write)
      .then(() => { returned = true; });
    signals.emit('SIGINT');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(returned).toBe(false);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('shutdown is incomplete'));
    host.resolve(); await foreground;
    expect(returned).toBe(true);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });
});
