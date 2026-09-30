import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFateCore } from '../../src/core/createFateCore';
import { FatePaths } from '../../src/core/FatePaths';
import { MultiProjectRuntimeManager } from '../../src/main/pi/MultiProjectRuntimeManager';
import type { RuntimeState } from '../../src/shared/contracts/ipc';
import { FakePiSdkAdapter } from './helpers/fakePi';
import { privateTestRoot } from './helpers/isolatedEnvironment';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const state = (root: string, status: RuntimeState['status'] = 'ready') => ({ status, project: { path: root, name: root, trusted: true } }) as RuntimeState;
const known = (root: string) => ({ path: root, name: root, trusted: true });

function manager(create: (root: string) => Promise<{ root: string; busy: boolean; disposed?: boolean }>, maxConcurrent = 8) {
  const dispose = vi.fn(async (runtime: { root: string; busy: boolean; disposed?: boolean }) => { runtime.disposed = true; });
  const focus = vi.fn();
  const runtime = new MultiProjectRuntimeManager({
    createRuntime: (project) => create(project.path), disposeRuntime: dispose,
    isBusy: (value) => value.busy, onFocused: focus,
  }, { maxConcurrent, evictionEnabled: true });
  return { runtime, dispose, focus };
}

describe('non-focused workspace acquisition', () => {
  it('keeps desktop A selected while acquiring B and deduplicates B startup', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const create = vi.fn(async (root: string) => { if (root === 'B') await gate; return { root, busy: false }; });
    const { runtime, focus } = manager(create);
    await runtime.openProject(known('A'), (value) => state(value.root));
    runtime.registerKnownProject(known('B'));
    const first = runtime.acquireKnownProject('B', (value) => state(value.root));
    const second = runtime.acquireKnownProject('B', (value) => state(value.root));
    expect(runtime.focusedProjectPath).toBe('A');
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.runtime).toBe(b.runtime);
    expect(runtime.focusedProjectPath).toBe('A');
    expect(focus).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
    await runtime.stop();
  });

  it('refuses unknown/untrusted projects and does not evict busy background work', async () => {
    const create = vi.fn(async (root: string) => ({ root, busy: false }));
    const { runtime, dispose } = manager(create, 2);
    await expect(runtime.acquireKnownProject('unknown', (value) => state(value.root))).rejects.toThrow(/unknown or untrusted/);
    expect(() => runtime.registerKnownProject({ ...known('B'), trusted: false })).toThrow(/trusted/);
    await runtime.openProject(known('A'), (value) => state(value.root));
    runtime.registerKnownProject(known('B'));
    const b = (await runtime.acquireKnownProject('B', (value) => state(value.root))).runtime;
    b.busy = true; // Represents an active descendant or a retained failed-to-stop writer.
    runtime.registerKnownProject(known('C'));
    await expect(runtime.acquireKnownProject('C', (value) => state(value.root))).rejects.toThrow(/slots are busy or focused/);
    expect(dispose).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(2);
    await runtime.stop();
  });

  it('does not deadlock two capacity waiters behind the same slow eviction', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let disposing = false;
    const manager = new MultiProjectRuntimeManager({
      createRuntime: async (project) => ({ root: project.path, busy: false }),
      disposeRuntime: async (value) => { if (value.root === 'X') { disposing = true; await gate; } },
      isBusy: (value) => value.busy,
    }, { maxConcurrent: 2 });
    await manager.openProject(known('A'), (value) => state(value.root));
    await manager.openProject(known('X'), (value) => state(value.root));
    manager.focus('A');
    for (const root of ['B', 'C']) manager.registerKnownProject(known(root));
    const b = manager.acquireKnownProject('B', (value) => state(value.root));
    const c = manager.acquireKnownProject('C', (value) => state(value.root));
    await vi.waitFor(() => expect(disposing).toBe(true));
    release();
    const results = await Promise.allSettled([b, c]);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(manager.size).toBeLessThanOrEqual(2);
    await manager.stop();
  });

  it('removes only failed startup and preserves the selected desktop router', async () => {
    const create = vi.fn(async (root: string) => { if (root === 'B') throw new Error('startup failed'); return { root, busy: false }; });
    const { runtime } = manager(create);
    await runtime.openProject(known('A'), (value) => state(value.root));
    runtime.registerKnownProject(known('B'));
    await expect(runtime.acquireKnownProject('B', (value) => state(value.root))).rejects.toThrow('startup failed');
    expect(runtime.focusedProjectPath).toBe('A');
    expect(runtime.has('B')).toBe(false);
    expect(runtime.getFocused()?.root).toBe('A');
    await runtime.stop();
  });

  it('uses the actual core runtime without changing focused A', async () => {
    const root = await mkdtemp(path.join(privateTestRoot(), 'acquire-'));
    roots.push(root);
    const a = path.join(root, 'A'); const b = path.join(root, 'B');
    await mkdir(a); await mkdir(b);
    const adapter = new FakePiSdkAdapter();
    const core = await createFateCore({ adapter, paths: new FatePaths({ dataRoot: path.join(root, 'data'), piAgentDir: path.join(root, 'pi'), sessionsRoot: path.join(root, 'pi', 'sessions'), attachmentRoot: path.join(root, 'attachments'), lockRoot: path.join(root, 'locks'), profileId: 'test' }) });
    try {
      await core.runtime.openProject({ path: a, name: 'A', trusted: true });
      core.runtime.registerKnownWorkspace({ path: b, name: 'B', trusted: true });
      const [first, second] = await Promise.all([core.runtime.acquireWorkspace(b), core.runtime.acquireWorkspace(b)]);
      expect(first).toBe(second);
      expect(first.getState(false).project?.path).toBe(b);
      expect(core.runtime.focusedProjectPath).toBe(a);
      expect(core.runtime.asRouter().getState(false).project?.path).toBe(a);
      expect(adapter.invocations.filter((entry) => entry.kind === 'createModelRuntime')).toHaveLength(1);
      await expect(core.runtime.acquireWorkspace(path.join(root, 'unknown'))).rejects.toThrow(/unknown or untrusted/);
    } finally { await core.dispose(); await adapter.dispose(); }
  });
});
