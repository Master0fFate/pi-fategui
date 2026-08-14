import { describe, expect, it, vi } from 'vitest';
import { ShutdownCoordinator } from './shutdown';

describe('ShutdownCoordinator', () => {
  it('runs before/sync/async dispose in order, then exits once', async () => {
    const order: string[] = [];
    const onBeforeDispose = vi.fn(() => { order.push('before'); });
    const disposeSync = vi.fn(() => { order.push('sync'); });
    const disposeAsync = vi.fn(() => { order.push('async-start'); return [Promise.resolve('a'), Promise.resolve('b')]; });
    const onExit = vi.fn(() => { order.push('exit'); });
    const onError = vi.fn();

    const coord = new ShutdownCoordinator({ onBeforeDispose, disposeSync, disposeAsync, onExit, onError });

    // Idempotent while running: repeated requests keep preventing the quit.
    expect(coord.requestShutdown()).toBe(true);
    expect(coord.requestShutdown()).toBe(true);

    const settled = coord.settled();
    expect(settled).not.toBeNull();
    await settled;

    expect(onBeforeDispose).toHaveBeenCalledTimes(1);
    expect(disposeSync).toHaveBeenCalledTimes(1);
    expect(disposeAsync).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(coord.isQuitReady()).toBe(true);
    expect(order).toEqual(['before', 'sync', 'async-start', 'exit']);
    // Once settled, a further request allows the quit to proceed.
    expect(coord.requestShutdown()).toBe(false);
  });

  it('exits after the timeout even if async disposal never settles', async () => {
    const onExit = vi.fn();
    const coord = new ShutdownCoordinator({
      disposeAsync: () => [new Promise<void>(() => undefined)],
      onExit,
      timeoutMs: 10,
    });

    expect(coord.requestShutdown()).toBe(true);
    await coord.settled();

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(coord.isQuitReady()).toBe(true);
  });

  it('reports disposal errors but still exits', async () => {
    const onError = vi.fn();
    const onExit = vi.fn();
    const coord = new ShutdownCoordinator({
      disposeAsync: () => [Promise.reject(new Error('boom'))],
      onError,
      onExit,
    });

    coord.requestShutdown();
    await coord.settled();

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(coord.isQuitReady()).toBe(true);
  });

  it('continues to sync and async disposal and exits once when onBeforeDispose throws', async () => {
    const order: string[] = [];
    const onError = vi.fn();
    const disposeSync = vi.fn(() => { order.push('sync'); });
    const disposeAsync = vi.fn(() => { order.push('async-start'); return [Promise.resolve()]; });
    const onExit = vi.fn(() => { order.push('exit'); });
    const coord = new ShutdownCoordinator({
      onBeforeDispose: () => { order.push('before'); throw new Error('before-boom'); },
      disposeSync,
      disposeAsync,
      onExit,
      onError,
    });

    expect(coord.requestShutdown()).toBe(true);
    await coord.settled();

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'before-boom' }));
    expect(disposeSync).toHaveBeenCalledTimes(1);
    expect(disposeAsync).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(coord.isQuitReady()).toBe(true);
    expect(order).toEqual(['before', 'sync', 'async-start', 'exit']);
  });

  it('continues to async disposal and exits once when disposeSync throws', async () => {
    const order: string[] = [];
    const onError = vi.fn();
    const disposeAsync = vi.fn(() => { order.push('async-start'); return [Promise.resolve()]; });
    const onExit = vi.fn(() => { order.push('exit'); });
    const coord = new ShutdownCoordinator({
      onBeforeDispose: () => { order.push('before'); },
      disposeSync: () => { order.push('sync'); throw new Error('sync-boom'); },
      disposeAsync,
      onExit,
      onError,
    });

    expect(coord.requestShutdown()).toBe(true);
    await coord.settled();

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'sync-boom' }));
    expect(disposeAsync).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(coord.isQuitReady()).toBe(true);
    expect(order).toEqual(['before', 'sync', 'async-start', 'exit']);
  });

  it('still runs later cleanup and exits once when onError itself throws', async () => {
    const order: string[] = [];
    const onError = vi.fn(() => { throw new Error('observer broken'); });
    const disposeSync = vi.fn(() => { order.push('sync'); });
    const disposeAsync = vi.fn(() => { order.push('async-start'); return [Promise.resolve()]; });
    const onExit = vi.fn(() => { order.push('exit'); });
    const coord = new ShutdownCoordinator({
      onBeforeDispose: () => { order.push('before'); throw new Error('before-boom'); },
      disposeSync,
      disposeAsync,
      onExit,
      onError,
    });

    expect(coord.requestShutdown()).toBe(true);
    await coord.settled();

    // The throwing observer is reported but cannot prevent sync/async disposal or the single exit.
    expect(onError).toHaveBeenCalled();
    expect(disposeSync).toHaveBeenCalledTimes(1);
    expect(disposeAsync).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(coord.isQuitReady()).toBe(true);
    expect(order).toEqual(['before', 'sync', 'async-start', 'exit']);
  });
});
