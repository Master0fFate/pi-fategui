import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFateCore } from '../../src/core/createFateCore';
import { FatePaths } from '../../src/core/FatePaths';
import { createLocalIpcContext } from '../../src/core/dispatch/RequestContext';
import { WorkspaceAdmissionQueue } from '../../src/core/workspaces/WorkspaceAdmissionQueue';
import { FakePiSdkAdapter } from './helpers/fakePi';
import { privateTestRoot } from './helpers/isolatedEnvironment';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
let client = createLocalIpcContext({ principalId: '12f7b4e8-9d87-4720-8f19-9c20961f1e10', clientId: '878368d1-9eb9-46c2-bbb1-80b3f6ba231d', expiresAt: Date.now() + 60_000 });

async function fixture() {
  // Windows ownership/ACL checks may outlive a module-global credential. Keep the same finite policy, issue per fixture.
  client = createLocalIpcContext({ principalId: '12f7b4e8-9d87-4720-8f19-9c20961f1e10', clientId: '878368d1-9eb9-46c2-bbb1-80b3f6ba231d', expiresAt: Date.now() + 60_000 });
  const fixtureIdentity = client;
  const root = await mkdtemp(path.join(privateTestRoot(), 'registry-')); roots.push(root);
  const a = path.join(root, 'A'), b = path.join(root, 'B');
  await Promise.all([mkdir(a), mkdir(b)]);
  for (const [dir, content] of [[a, 'A secret'], [b, 'B secret']] as const) {
    await writeFile(path.join(dir, 'sentinel.txt'), content);
    execFileSync('git', ['init', '-q', dir], { env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'empty-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' } });
  }
  const registered = new Set([a, b]);
  const members = new Set<string>();
  const adapter = new FakePiSdkAdapter();
  const core = await createFateCore({ adapter, paths: new FatePaths({ dataRoot: path.join(root, 'data'), piAgentDir: path.join(root, 'pi'), sessionsRoot: path.join(root, 'pi', 'sessions'), attachmentRoot: path.join(root, 'attachments'), lockRoot: path.join(root, 'locks'), profileId: 'test' }),
    workspaceRegistration: { isRegistered: (canonical) => registered.has(canonical) },
    workspaceMembership: (identity, id) => identity === fixtureIdentity && members.has(id),
  });
  const registry = core.workspaces!;
  const dispose = async () => { await core.dispose(); await adapter.dispose(); };
  return { root, a, b, registered, members, registry, core, dispose };
}

describe('host-owned workspace registry', () => {
  it('collapses canonical aliases, keeps independent file/Git roots and refuses cross-scope reads', async () => {
    const f = await fixture();
    try {
      const [a, same, b] = await Promise.all([f.registry.registerHostPath(f.a), f.registry.registerHostPath(path.join(f.a, '.')), f.registry.registerHostPath(f.b)]);
      expect(a).toBe(same);
      expect(a.id).not.toBe(b.id);
      expect(a.runtime).not.toBe(b.runtime);
      f.members.add(a.id);
      expect(f.registry.resolve(client, a.id, a.generation)).toBe(a);
      expect(() => f.registry.resolve(client, b.id, b.generation)).toThrow(/membership/);
      await Promise.all([writeFile(path.join(f.a, 'sentinel.txt'), 'A revised'), writeFile(path.join(f.b, 'sentinel.txt'), 'B revised')]);
      const [aRead, bRead, aGit, bGit] = await Promise.all([a.files.read('sentinel.txt'), b.files.read('sentinel.txt'), a.git.status(), b.git.status()]);
      expect(JSON.stringify(aRead)).toContain('A revised');
      expect(JSON.stringify(aRead)).not.toContain('B revised');
      expect(JSON.stringify(bRead)).toContain('B revised');
      expect(JSON.stringify(aGit)).toContain('sentinel.txt');
      expect(JSON.stringify(bGit)).toContain('sentinel.txt');
      expect(a.files.getRoot()).toBe(f.a);
      expect(b.files.getRoot()).toBe(f.b);
      await expect(a.files.setRoot(f.b)).rejects.toThrow();
      await expect(a.files.read('../B/sentinel.txt')).rejects.toThrow();
      expect(f.core.runtime.focusedProjectPath).toBeNull();
    } finally { await f.dispose(); }
  });

  it('rejects unregistered paths and revoked membership before exposing a handle', async () => {
    const f = await fixture();
    try {
      await expect(f.registry.registerHostPath(f.root)).rejects.toThrow(/not registered/);
      const a = await f.registry.registerHostPath(f.a);
      expect(() => f.registry.resolve(client, a.id, a.generation)).toThrow(/membership/);
      f.members.add(a.id);
      f.registered.delete(f.a);
      expect(() => f.registry.resolve(client, a.id, a.generation)).toThrow(/not registered/);
      expect(await readFile(path.join(f.a, 'sentinel.txt'), 'utf8')).toBe('A secret');
    } finally { await f.dispose(); }
  });

  it('pins an admitted workspace until its queue settles, then permits explicit close', async () => {
    const f = await fixture();
    try {
      const a = await f.registry.registerHostPath(f.a);
      expect(a.admission).toBeInstanceOf(WorkspaceAdmissionQueue);
      if (!(a.admission instanceof WorkspaceAdmissionQueue)) throw new Error('The real admission queue is required.');
      const selection = a.admission.snapshot();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const running = a.admission.run({ workspaceGeneration: a.generation, expectedSessionId: selection.selectedSessionId,
        selectionRevision: selection.selectionRevision, controlGeneration: 1 },
      () => ({ currentGeneration: a.generation, controlGeneration: 1, permission: true }), async () => { await gate; });
      await Promise.resolve();
      await expect(f.registry.unregisterHostWorkspace(a.id)).rejects.toThrow(/active/);
      // Direct registry teardown must still refuse active admission; host-wide
      // core shutdown is a different path and now requests cancellation.
      expect(() => f.registry.beginShutdown()).toThrow(/work is active/);
      expect(f.core.runtime.peekWorkspace(f.a)).toBe(a.runtime);
      await expect(f.core.runtime.closeProjectPath(f.a)).rejects.toThrow(/admission is active/);
      release(); await running;
      await f.registry.unregisterHostWorkspace(a.id);
      expect(f.core.runtime.peekWorkspace(f.a)).toBeNull();
    } finally { await f.dispose(); }
  });

  it('fences new resolutions and admissions before awaited disposal', async () => {
    const f = await fixture();
    try {
      const a = await f.registry.registerHostPath(f.a);
      const b = await f.registry.registerHostPath(f.b);
      f.members.add(a.id);
      let entered!: () => void; let release!: () => void;
      const disposing = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const list = a.runtime.listSessions.bind(a.runtime);
      vi.spyOn(a.runtime, 'listSessions').mockImplementation(async () => { entered(); await gate; return list(); });
      const closing = f.registry.unregisterHostWorkspace(a.id);
      await disposing;
      expect(() => f.registry.resolve(client, a.id, a.generation)).toThrow(/not registered/);
      expect(a.admission).toBeInstanceOf(WorkspaceAdmissionQueue);
      if (!(a.admission instanceof WorkspaceAdmissionQueue)) throw new Error('The real queue is required.');
      let invoked = false;
      await expect(a.admission.run({ workspaceGeneration: a.generation, expectedSessionId: a.runtime.getState(false).sessionId,
        selectionRevision: 0, controlGeneration: 1 }, () => ({ currentGeneration: a.generation, controlGeneration: 1, permission: true }),
      () => { invoked = true; })).rejects.toMatchObject({ code: 'STALE_WORKSPACE' });
      expect(invoked).toBe(false);
      release(); await closing;
      expect(f.core.runtime.peekWorkspace(f.b)).toBe(b.runtime);
    } finally { vi.restoreAllMocks(); await f.dispose(); }
  });

  it('uses the same admission fence for a direct runtime close outside the registry', async () => {
    const f = await fixture();
    try {
      const a = await f.registry.registerHostPath(f.a);
      const b = await f.registry.registerHostPath(f.b);
      f.members.add(a.id);
      let entered!: () => void; let release!: () => void;
      const disposing = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const list = a.runtime.listSessions.bind(a.runtime);
      vi.spyOn(a.runtime, 'listSessions').mockImplementation(async () => { entered(); await gate; return list(); });
      const closing = f.core.runtime.closeProjectPath(f.a);
      await disposing;
      expect(() => f.registry.resolve(client, a.id, a.generation)).toThrow(/not registered/);
      let invoked = false;
      await expect(a.admission.run({ workspaceGeneration: a.generation, expectedSessionId: a.runtime.getState(false).sessionId,
        selectionRevision: 0, controlGeneration: 1 }, () => ({ currentGeneration: a.generation, controlGeneration: 1, permission: true }),
      () => { invoked = true; })).rejects.toMatchObject({ code: 'STALE_WORKSPACE' });
      expect(invoked).toBe(false);
      release(); await closing;
      expect(f.core.runtime.peekWorkspace(f.b)).toBe(b.runtime);
      const replacement = await f.registry.registerHostPath(f.a);
      expect(replacement.id).toBe(a.id);
      expect(replacement.generation).toBeGreaterThan(a.generation);
    } finally { vi.restoreAllMocks(); await f.dispose(); }
  });

  it('keeps failed teardown owned and fenced until an explicit retry succeeds', async () => {
    const f = await fixture();
    try {
      const a = await f.registry.registerHostPath(f.a);
      f.members.add(a.id);
      const dispose = a.runtime.dispose.bind(a.runtime);
      const spy = vi.spyOn(a.runtime, 'dispose').mockRejectedValueOnce(new Error('writer did not stop'))
        .mockImplementation(() => dispose());
      await expect(f.registry.unregisterHostWorkspace(a.id)).rejects.toThrow('writer did not stop');
      expect(f.core.runtime.peekWorkspace(f.a)).toBe(a.runtime);
      expect(() => f.registry.resolve(client, a.id, a.generation)).toThrow(/not registered/);
      await expect(a.admission.run({ workspaceGeneration: a.generation, expectedSessionId: a.runtime.getState(false).sessionId,
        selectionRevision: 0, controlGeneration: 1 }, () => ({ currentGeneration: a.generation, controlGeneration: 1, permission: true }),
      () => { throw new Error('never'); })).rejects.toMatchObject({ code: 'STALE_WORKSPACE' });
      await f.registry.unregisterHostWorkspace(a.id);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally { vi.restoreAllMocks(); await f.dispose(); }
  });

  it('retains real host-private random workspace identity across core restart without persisting or exposing a root pathname', async () => {
    const f = await fixture();
    const adapter = new FakePiSdkAdapter();
    let reopened: Awaited<ReturnType<typeof createFateCore>> | null = null;
    try {
      const original = await f.registry.registerHostPath(f.a);
      const originalId = original.id;
      await f.dispose();
      reopened = await createFateCore({ adapter,
        paths: new FatePaths({ dataRoot: path.join(f.root, 'data'), piAgentDir: path.join(f.root, 'pi'), sessionsRoot: path.join(f.root, 'pi', 'sessions'),
          attachmentRoot: path.join(f.root, 'attachments'), lockRoot: path.join(f.root, 'locks'), profileId: 'test' }),
        workspaceRegistration: { isRegistered: (canonical) => f.registered.has(canonical) },
        workspaceMembership: (identity, id) => identity === client && id === originalId,
      });
      const current = await reopened.workspaces!.registerHostPath(f.a);
      expect(current.id).toBe(originalId);
      expect(reopened.workspaces!.resolve(client, current.id, current.generation)).toBe(current);
      const directory = path.join(f.root, 'workspace-identities');
      const files = await readdir(directory);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/u);
      const stored = await readFile(path.join(directory, files[0]!), 'utf8');
      expect(stored).toContain(originalId);
      expect(stored).not.toContain(f.a);
      expect(stored).not.toContain(f.b);
    } finally { await reopened?.dispose(); await adapter.dispose(); await f.dispose(); }
  });

  it('increments a generation after eviction and refuses a stale handle without closing B', async () => {
    const f = await fixture();
    try {
      const a = await f.registry.registerHostPath(f.a);
      const b = await f.registry.registerHostPath(f.b);
      f.members.add(a.id);
      await f.registry.unregisterHostWorkspace(a.id);
      const replacement = await f.registry.registerHostPath(f.a);
      expect(replacement.id).toBe(a.id);
      expect(replacement.generation).toBe(a.generation + 1);
      expect(() => f.registry.resolve(client, a.id, a.generation)).toThrow('Stale workspace generation.');
      expect(f.registry.resolve(client, replacement.id, replacement.generation)).toBe(replacement);
      f.members.delete(a.id);
      expect(() => f.registry.resolve(client, a.id, a.generation)).toThrow('Workspace membership required.');
      const expired = createLocalIpcContext({ principalId: client.principalId, clientId: client.clientId, expiresAt: Date.now() - 1 });
      expect(() => f.registry.resolve(expired, a.id, a.generation)).toThrow('Workspace membership required.');
      f.members.add(a.id);
      expect(b.files.getRoot()).toBe(f.b);
    } finally { await f.dispose(); }
  });
});
