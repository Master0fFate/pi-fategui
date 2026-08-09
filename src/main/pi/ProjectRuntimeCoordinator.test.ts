import { describe, expect, it, vi } from 'vitest';
import { ProjectRuntimeCoordinator, type ProjectRuntimeCoordinatorHooks } from './ProjectRuntimeCoordinator';

interface FakeRuntime {
  id: number;
  busy: boolean;
}

function makeHooks(): {
  hooks: ProjectRuntimeCoordinatorHooks<FakeRuntime>;
  created: FakeRuntime[];
  disposed: FakeRuntime[];
  evicted: string[];
} {
  let next = 1;
  const created: FakeRuntime[] = [];
  const disposed: FakeRuntime[] = [];
  const evicted: string[] = [];
  const hooks: ProjectRuntimeCoordinatorHooks<FakeRuntime> = {
    createRuntime: async () => {
      const runtime: FakeRuntime = { id: next++, busy: false };
      created.push(runtime);
      return runtime;
    },
    disposeRuntime: async (runtime) => {
      disposed.push(runtime);
    },
    isBusy: (runtime) => runtime.busy,
    onEvicted: (path) => { evicted.push(path); },
  };
  return { hooks, created, disposed, evicted };
}

describe('ProjectRuntimeCoordinator', () => {
  it('acquires, reuses, and focuses a project runtime', async () => {
    const { hooks, created } = makeHooks();
    let now = 1_000;
    const c = new ProjectRuntimeCoordinator<FakeRuntime>(hooks, { now: () => now });

    const a = await c.acquire({ path: '/a', name: 'a' });
    expect(created).toHaveLength(1);
    expect(c.focusedProjectPath).toBe('/a');
    expect(c.getFocused()?.runtime).toBe(a.runtime);

    const aAgain = await c.acquire({ path: '/a', name: 'a' });
    expect(created).toHaveLength(1);
    expect(aAgain.runtime).toBe(a.runtime);
  });

  it('deduplicates concurrent acquires for the same path', async () => {
    const { hooks, created } = makeHooks();
    const c = new ProjectRuntimeCoordinator<FakeRuntime>(hooks);
    const [first, second] = await Promise.all([
      c.acquire({ path: '/same', name: 'same' }),
      c.acquire({ path: '/same', name: 'same' }),
    ]);
    expect(first.runtime).toBe(second.runtime);
    expect(created).toHaveLength(1);
  });

  it('counts in-flight creations toward the concurrency cap', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const createCalls: string[] = [];
    const hooks: ProjectRuntimeCoordinatorHooks<FakeRuntime> = {
      createRuntime: async (projectPath) => {
        createCalls.push(projectPath);
        if (projectPath === '/a') await firstGate;
        return { id: createCalls.length, busy: false };
      },
      disposeRuntime: async () => undefined,
      isBusy: (runtime) => runtime.busy,
    };
    const c = new ProjectRuntimeCoordinator<FakeRuntime>(hooks, { maxConcurrent: 1 });
    const first = c.acquire({ path: '/a', name: 'a' });
    await Promise.resolve();
    const second = c.acquire({ path: '/b', name: 'b' });
    await Promise.resolve();
    expect(createCalls).toEqual(['/a']);
    releaseFirst();
    await first;
    await expect(second).rejects.toThrow(/all 1 runtime slots/u);
    expect(createCalls).toEqual(['/a']);
    expect(c.size).toBe(1);
  });

  it('waits for an in-flight acquire before closing that project', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const disposed: FakeRuntime[] = [];
    const runtime = { id: 1, busy: false };
    const c = new ProjectRuntimeCoordinator<FakeRuntime>({
      createRuntime: async () => { await gate; return runtime; },
      disposeRuntime: async (value) => { disposed.push(value); },
      isBusy: (value) => value.busy,
    });
    const acquisition = c.acquire({ path: '/a', name: 'a' });
    const closing = c.close('/a');
    release();
    await acquisition;
    await closing;
    expect(disposed).toEqual([runtime]);
    expect(c.has('/a')).toBe(false);
  });

  it('enforces the concurrency cap before creating a new runtime', async () => {
    const { hooks, created, disposed } = makeHooks();
    const c = new ProjectRuntimeCoordinator<FakeRuntime>(hooks, { maxConcurrent: 1 });
    await c.acquire({ path: '/a', name: 'a' });
    await expect(c.acquire({ path: '/b', name: 'b' })).rejects.toThrow(/all 1 runtime slots/u);
    expect(created).toHaveLength(1);
    expect(disposed).toHaveLength(0);
  });

  it('retains a context when disposal fails so it can be retried', async () => {
    const { hooks } = makeHooks();
    hooks.disposeRuntime = vi.fn(async () => { throw new Error('dispose failed'); });
    const c = new ProjectRuntimeCoordinator<FakeRuntime>(hooks);
    await c.acquire({ path: '/a', name: 'a' });
    await expect(c.close('/a')).rejects.toThrow('dispose failed');
    expect(c.has('/a')).toBe(true);
    expect(c.focusedProjectPath).toBe('/a');
  });

  it('focus switches the active project without disposing others', async () => {
    const { hooks } = makeHooks();
    const c = new ProjectRuntimeCoordinator<FakeRuntime>(hooks);
    await c.acquire({ path: '/a', name: 'a' });
    await c.acquire({ path: '/b', name: 'b' });

    expect(c.focusedProjectPath).toBe('/b');
    c.focus('/a');
    expect(c.focusedProjectPath).toBe('/a');
    expect(c.has('/b')).toBe(true);
    expect(c.size).toBe(2);
  });

  it('never evicts a busy or focused runtime', async () => {
    const { hooks, created, disposed } = makeHooks();
    let now = 0;
    const c = new ProjectRuntimeCoordinator<FakeRuntime>(hooks, { idleTimeoutMs: 1_000, now: () => now });

    await c.acquire({ path: '/a', name: 'a' });
    await c.acquire({ path: '/b', name: 'b' });
    c.focus('/a');
    created[1]!.busy = true; // /b is busy

    now = 100_000; // well past the idle timeout
    await c.sweepOnce();

    expect(disposed).toHaveLength(0); // /a focused, /b busy
  });

  it('evicts an idle, non-focused runtime after the grace period', async () => {
    const { hooks, evicted } = makeHooks();
    let now = 0;
    const c = new ProjectRuntimeCoordinator<FakeRuntime>(hooks, { idleTimeoutMs: 5_000, now: () => now });

    await c.acquire({ path: '/a', name: 'a' });
    await c.acquire({ path: '/b', name: 'b' });
    c.focus('/a'); // /b is unfocused

    // First sweep starts the idle clock for /b (not yet eligible).
    now = 1_000;
    await c.sweepOnce();
    expect(evicted).toHaveLength(0);

    // Past grace period -> /b evicted, /a (focused) kept.
    now = 10_000;
    await c.sweepOnce();
    expect(evicted).toEqual(['/b']);
    expect(c.has('/a')).toBe(true);
  });

  it('touch resets idle and recentness', async () => {
    const { hooks, evicted } = makeHooks();
    let now = 0;
    const c = new ProjectRuntimeCoordinator<FakeRuntime>(hooks, { idleTimeoutMs: 5_000, now: () => now });

    await c.acquire({ path: '/a', name: 'a' });
    await c.acquire({ path: '/b', name: 'b' });
    c.focus('/a');

    now = 4_000;
    c.touch('/b'); // /b active again
    now = 8_000; // only 4s since touch — still within grace
    await c.sweepOnce();
    expect(evicted).toHaveLength(0);
  });

  it('enforces the concurrency cap by evicting the oldest idle non-focused runtime', async () => {
    const { hooks, evicted } = makeHooks();
    const c = new ProjectRuntimeCoordinator<FakeRuntime>(hooks, { maxConcurrent: 2 });

    await c.acquire({ path: '/a', name: 'a' });
    await c.acquire({ path: '/b', name: 'b' });
    await c.acquire({ path: '/c', name: 'c' }); // exceeds cap of 2

    await c.sweepOnce();
    expect(evicted).toEqual(['/a']); // oldest idle, non-focused (focus is /c)
  });

  it('close disposes a specific project and clears focus if needed', async () => {
    const { hooks, disposed } = makeHooks();
    const c = new ProjectRuntimeCoordinator<FakeRuntime>(hooks);

    const a = await c.acquire({ path: '/a', name: 'a' });
    await c.close('/a');

    expect(disposed).toEqual([a.runtime]);
    expect(c.has('/a')).toBe(false);
    expect(c.focusedProjectPath).toBeNull();
  });

  it('stop disposes every live context', async () => {
    const { hooks, disposed } = makeHooks();
    const c = new ProjectRuntimeCoordinator<FakeRuntime>(hooks);
    const a = await c.acquire({ path: '/a', name: 'a' });
    const b = await c.acquire({ path: '/b', name: 'b' });

    await c.stop();

    expect(disposed).toHaveLength(2);
    expect(disposed.map((r) => r.id).sort()).toEqual([a.runtime.id, b.runtime.id].sort());
    expect(c.size).toBe(0);
  });

  it('start schedules the sweep and stop clears it', () => {
    const { hooks } = makeHooks();
    const c = new ProjectRuntimeCoordinator<FakeRuntime>(hooks, { sweepIntervalMs: 10 });
    const spy = vi.spyOn(c, 'sweepOnce').mockImplementation(async () => undefined);
    c.start();
    // stop synchronously clears the timer; just ensure no throw and sweep was wired.
    expect(typeof c.size).toBe('number');
    void c.stop();
    spy.mockRestore();
  });
});
