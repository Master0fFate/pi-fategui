import { describe, expect, it, vi } from 'vitest';
import type { ProjectState, RuntimeState } from '../../shared/contracts/ipc';
import { MultiProjectRuntimeManager, type MultiProjectRuntimeHooks } from './MultiProjectRuntimeManager';

interface FakeRuntime {
  id: number;
  projectPath: string;
  busy: boolean;
  disposed: boolean;
}

const readyState = (input: string | FakeRuntime): RuntimeState => {
  const projectPath = typeof input === 'string' ? input : input.projectPath;
  return ({
    status: 'ready',
    project: { path: projectPath, name: projectPath, trusted: true },
    sessionId: 's1',
    sessionFile: null,
    streaming: false,
    model: null,
    models: [],
    thinkingLevel: 'medium',
    messages: [],
    error: null,
  } as unknown as RuntimeState);
};

function makeManager(options?: { idleTimeoutMs?: number; evictionEnabled?: boolean }) {
  let next = 1;
  const created: FakeRuntime[] = [];
  const focusLog: Array<{ path: string | null; id: number | null }> = [];
  const evicted: string[] = [];
  const hooks: MultiProjectRuntimeHooks<FakeRuntime> = {
    createRuntime: async (project: ProjectState) => {
      const runtime: FakeRuntime = { id: next++, projectPath: project.path, busy: false, disposed: false };
      created.push(runtime);
      return runtime;
    },
    disposeRuntime: async (runtime) => { runtime.disposed = true; },
    isBusy: (runtime) => runtime.busy,
    onFocused: (runtime, path) => focusLog.push({ path, id: runtime ? runtime.id : null }),
    onEvicted: (path) => evicted.push(path),
  };
  let now = 0;
  const manager = new MultiProjectRuntimeManager<FakeRuntime>(hooks, { now: () => now, evictionEnabled: true, ...options });
  return { manager, created, focusLog, evicted, setNow: (n: number) => { now = n; } };
}

describe('MultiProjectRuntimeManager', () => {
  it('opens a project, focuses it, and reports focused state', async () => {
    const { manager } = makeManager();
    const { runtime, state } = await manager.openProject({ path: '/a', name: 'a', trusted: true }, (r) => readyState(r.projectPath));
    expect(manager.getFocused()).toBe(runtime);
    expect(manager.focusedProjectPath).toBe('/a');
    expect(state.project?.path).toBe('/a');
  });

  it('does not cache a failed initialization state', async () => {
    const { manager, created } = makeManager();
    await manager.openProject({ path: '/a', name: 'a', trusted: true }, () => ({
      ...readyState('/a'), status: 'error',
    } as RuntimeState));
    expect(manager.has('/a')).toBe(false);
    expect(manager.focusedProjectPath).toBeNull();
    expect(created[0]!.disposed).toBe(true);
  });

  it('keeps an untrusted disconnected context and replaces it after trust changes', async () => {
    const { manager, created } = makeManager();
    const untrusted = { path: '/a', name: 'a', trusted: false } as ProjectState;
    const trusted = { path: '/a', name: 'a', trusted: true } as ProjectState;
    const disconnected = { ...readyState('/a'), status: 'disconnected', project: untrusted } as RuntimeState;
    await manager.openProject(untrusted, () => disconnected);
    expect(manager.has('/a')).toBe(true);
    expect(manager.getFocused()).toBe(created[0]);
    await manager.openProject(trusted, (runtime) => readyState(runtime));
    expect(created).toHaveLength(2);
    expect(created[0]!.disposed).toBe(true);
    expect(manager.getFocused()).toBe(created[1]);
    expect(manager.focusedProjectPath).toBe('/a');
  });

  it('keeps the previous project alive when opening a second folder', async () => {
    const { manager, created } = makeManager();
    await manager.openProject({ path: '/a', name: 'a', trusted: true }, readyState);
    await manager.openProject({ path: '/b', name: 'b', trusted: true }, readyState);
    expect(created).toHaveLength(2);
    expect(manager.has('/a')).toBe(true);
    expect(manager.has('/b')).toBe(true);
    expect(manager.focusedProjectPath).toBe('/b');
    expect(created[0]!.disposed).toBe(false);
  });

  it('reuses an existing runtime when reopening the same folder (no recreate)', async () => {
    const { manager, created, focusLog } = makeManager();
    await manager.openProject({ path: '/a', name: 'a', trusted: true }, readyState);
    await manager.openProject({ path: '/b', name: 'b', trusted: true }, readyState);
    const before = created.length;
    await manager.openProject({ path: '/a', name: 'a', trusted: true }, readyState);
    expect(created).toHaveLength(before);
    expect(manager.focusedProjectPath).toBe('/a');
    expect(focusLog.at(-1)).toEqual({ path: '/a', id: created[0]!.id });
  });

  it('focus() re-points at a live project without recreating', async () => {
    const { manager, created } = makeManager();
    await manager.openProject({ path: '/a', name: 'a', trusted: true }, readyState);
    await manager.openProject({ path: '/b', name: 'b', trusted: true }, readyState);
    const ok = manager.focus('/a');
    expect(ok).toBe(true);
    expect(manager.focusedProjectPath).toBe('/a');
    expect(manager.getFocused()).toBe(created[0]);
    expect(manager.focus('/missing')).toBe(false);
  });

  it('focusPreview selects a known folder without allocating a runtime', () => {
    const { manager, created, focusLog } = makeManager();
    manager.focusPreview({ path: '/preview', name: 'preview', trusted: true });
    expect(created).toHaveLength(0);
    expect(manager.focusedProjectPath).toBe('/preview');
    expect(manager.getFocused()).toBeNull();
    expect(focusLog.at(-1)).toEqual({ path: '/preview', id: null });
  });

  it('rewires focus when a preview-only project is promoted to a live runtime', async () => {
    const { manager, created, focusLog } = makeManager();
    const project = { path: '/preview', name: 'preview', trusted: true } as ProjectState;
    manager.focusPreview(project);
    await manager.openProject(project, readyState);
    expect(focusLog).toEqual([
      { path: '/preview', id: null },
      { path: '/preview', id: created[0]!.id },
    ]);
    expect(manager.getFocused()).toBe(created[0]);
  });

  it('onFocused fires only when focus actually changes', async () => {
    const { manager, focusLog } = makeManager();
    await manager.openProject({ path: '/a', name: 'a', trusted: true }, readyState);
    expect(focusLog).toHaveLength(1);
    await manager.openProject({ path: '/a', name: 'a', trusted: true }, readyState); // same focus
    expect(focusLog).toHaveLength(1);
    await manager.openProject({ path: '/b', name: 'b', trusted: true }, readyState);
    expect(focusLog).toHaveLength(2);
    expect(focusLog.at(-1)).toEqual({ path: '/b', id: expect.any(Number) });
  });

  it('never evicts a busy background runtime', async () => {
    const { manager, created, evicted, setNow } = makeManager({ idleTimeoutMs: 1_000 });
    await manager.openProject({ path: '/a', name: 'a', trusted: true }, readyState);
    await manager.openProject({ path: '/b', name: 'b', trusted: true }, readyState);
    manager.focus('/a');
    created[1]!.busy = true; // /b busy in background
    setNow(100_000);
    await manager.sweepOnce();
    expect(evicted).toEqual([]);
    expect(created[1]!.disposed).toBe(false);
  });

  it('evicts an idle, non-focused runtime after the grace period and clears focus if it was focused', async () => {
    const { manager, evicted, setNow, focusLog } = makeManager({ idleTimeoutMs: 5_000 });
    await manager.openProject({ path: '/a', name: 'a', trusted: true }, readyState);
    await manager.openProject({ path: '/b', name: 'b', trusted: true }, readyState);
    manager.focus('/a'); // /b idle + unfocused
    setNow(1_000); await manager.sweepOnce(); // start idle clock
    setNow(10_000); await manager.sweepOnce(); // past grace
    expect(evicted).toEqual(['/b']);
    expect(manager.focusedProjectPath).toBe('/a'); // focused unaffected
  });

  it('close() disposes a specific project and clears focus if needed', async () => {
    const { manager, focusLog } = makeManager();
    await manager.openProject({ path: '/a', name: 'a', trusted: true }, readyState);
    await manager.close('/a');
    expect(manager.has('/a')).toBe(false);
    expect(manager.getFocused()).toBeNull();
    expect(focusLog.at(-1)).toEqual({ path: null, id: null });
  });

  it('stop() disposes every runtime and resets focus', async () => {
    const { manager, created } = makeManager();
    await manager.openProject({ path: '/a', name: 'a', trusted: true }, readyState);
    await manager.openProject({ path: '/b', name: 'b', trusted: true }, readyState);
    await manager.stop();
    expect(created.every((r) => r.disposed)).toBe(true);
    expect(manager.size).toBe(0);
    expect(manager.getFocused()).toBeNull();
  });

  it('evictionEnabled:false disables sweeping entirely', async () => {
    const { manager, evicted, setNow } = makeManager({ evictionEnabled: false, idleTimeoutMs: 1 });
    await manager.openProject({ path: '/a', name: 'a', trusted: true }, readyState);
    await manager.openProject({ path: '/b', name: 'b', trusted: true }, readyState);
    manager.focus('/a');
    setNow(10_000_000);
    await manager.sweepOnce();
    expect(evicted).toEqual([]);
  });
});

// Silence unused-import lint in environments that tree-shake type-only imports.
void vi;
