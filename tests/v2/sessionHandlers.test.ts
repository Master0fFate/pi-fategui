import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFateCore } from '../../src/core/createFateCore';
import { createLocalIpcContext } from '../../src/core/dispatch/RequestContext';
import { FatePaths } from '../../src/core/FatePaths';
import { createRuntimeHandlers, createScopedRuntimeHandlers } from '../../src/core/handlers/runtimeHandlers';
import { createSessionHandlers } from '../../src/core/handlers/sessionHandlers';
import { FakePiSdkAdapter } from './helpers/fakePi';
import { privateTestRoot } from './helpers/isolatedEnvironment';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(privateTestRoot(), 'handlers-')); roots.push(root);
  const a = path.join(root, 'A'), b = path.join(root, 'B'); await mkdir(a); await mkdir(b);
  const adapter = new FakePiSdkAdapter();
  const client = createLocalIpcContext({ principalId: '099981d4-a8f7-414d-8feb-f9d4b4a91aa5', clientId: 'bacdd2b3-3c8e-4c1f-9832-f1ae91e67eda', expiresAt: Date.now() + 60_000 });
  const members = new Set<string>();
  const core = await createFateCore({ adapter, paths: new FatePaths({ dataRoot: path.join(root, 'data'), piAgentDir: path.join(root, 'pi'), sessionsRoot: path.join(root, 'pi', 'sessions'), attachmentRoot: path.join(root, 'attachments'), lockRoot: path.join(root, 'locks'), profileId: 'test' }),
    workspaceRegistration: { isRegistered: (canonical) => canonical === a || canonical === b },
    workspaceMembership: (identity, id) => identity === client && members.has(id) });
  await core.runtime.openProject({ path: a, name: 'A', trusted: true });
  const service = core.runtime.getFocused();
  const handle = await core.workspaces!.registerHostPath(a);
  members.add(handle.id);
  return { a, b, adapter, core, service, handle, client, session: createSessionHandlers(service), run: createRuntimeHandlers(service), dispose: async () => { await core.dispose(); await adapter.dispose(); } };
}

describe('shared captured session and runtime handlers', () => {
  it('accepts one prompt once using the existing Pi runtime and rejects unvalidated references', async () => {
    const f = await fixture();
    try {
      const prompt = vi.spyOn(f.service, 'prompt');
      const result = await f.run.prompt({ text: 'one call', behavior: 'prompt' });
      expect(result.accepted).toBe(true);
      expect(prompt).toHaveBeenCalledOnce();
      expect(f.adapter.invocations.filter((entry) => entry.kind === 'prompt')).toHaveLength(1);
      await expect(f.run.prompt({ text: 'never', sessionReferences: [{ projectPath: f.b, sessionId: 'other' }] })).rejects.toThrow();
      expect(prompt).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(f.adapter.invocations.some((entry) => entry.kind === 'settled')).toBe(true));
    } finally { await f.dispose(); }
  });

  it('lists stored sessions without another Pi initialization or selection; new selection stays in A', async () => {
    const f = await fixture();
    try {
      await f.core.runtime.openProject({ path: f.b, name: 'B', trusted: true });
      const previous = f.service.getState(false).sessionId;
      const created = f.adapter.invocations.filter((entry) => entry.kind === 'createRuntime').length;
      await f.session.listStoredSessions(f.a, { query: '' });
      await f.session.listSessions({ query: '' });
      expect(f.adapter.invocations.filter((entry) => entry.kind === 'createRuntime')).toHaveLength(created);
      expect(f.service.getState(false).sessionId).toBe(previous);
      await expect(f.session.listStoredSessions(f.b, { query: '' })).rejects.toThrow(/captured workspace/);
      const fresh = await f.session.newSession({});
      expect(fresh.project?.path).toBe(f.a);
      expect(f.core.runtime.getFocused().getState(false).project?.path).toBe(f.b);
      if (previous) {
        // An in-memory fake session has no persisted JSONL; selection must reject,
        // never retarget B or silently create a replacement session.
        await expect(f.session.selectSession({ sessionId: previous })).rejects.toThrow(/no longer exists/);
        expect(f.core.runtime.getFocused().getState(false).project?.path).toBe(f.b);
      }
    } finally { await f.dispose(); }
  });

  it('rejects a scoped prompt when a desktop selection changes during reference preparation', async () => {
    const f = await fixture();
    try {
      let entered!: () => void; let release!: () => void;
      const preparing = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const authorize = () => {
        f.core.workspaces!.resolve(f.client, f.handle.id, f.handle.generation);
        return { currentGeneration: f.handle.generation, controlGeneration: 1, permission: true };
      };
      const handlers = createScopedRuntimeHandlers(f.handle, authorize, async () => { entered(); await gate; return f.a; });
      const selection = f.handle.admission.snapshot();
      const command = { workspaceGeneration: f.handle.generation, expectedSessionId: selection.selectedSessionId,
        selectionRevision: selection.selectionRevision, controlGeneration: 1 };
      const attempt = handlers.prompt(command, { text: 'must stay on A', behavior: 'prompt',
        sessionReferences: [{ id: selection.selectedSessionId!, title: 'A', projectPath: f.a }] });
      await preparing;
      await f.service.newSession(); // Competing legacy desktop path until T19.
      release();
      await expect(attempt).rejects.toMatchObject({ code: 'STALE_SESSION' });
      expect(f.adapter.invocations.filter((entry) => entry.kind === 'prompt')).toHaveLength(0);
    } finally { await f.dispose(); }
  });

  it('does not apply a queued model change after permission is revoked', async () => {
    const f = await fixture();
    try {
      let permission = true;
      const authorize = () => {
        f.core.workspaces!.resolve(f.client, f.handle.id, f.handle.generation);
        return { currentGeneration: f.handle.generation, controlGeneration: 1, permission };
      };
      const selection = f.handle.admission.snapshot();
      const command = { workspaceGeneration: f.handle.generation, expectedSessionId: selection.selectedSessionId,
        selectionRevision: selection.selectionRevision, controlGeneration: 1 };
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const first = f.handle.admission.run(command, authorize, async () => { await gate; });
      await Promise.resolve();
      const setModel = vi.spyOn(f.service, 'setModel');
      const queued = createScopedRuntimeHandlers(f.handle, authorize).setModel(command, { provider: 'v2-fake', id: 'v2-deterministic' });
      permission = false;
      release(); await first;
      await expect(queued).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
      expect(setModel).not.toHaveBeenCalled();
    } finally { await f.dispose(); }
  });

  it('forwards an existing stable queue ID and original text through the same runtime method', async () => {
    const f = await fixture();
    try {
      const id = '079a3c7e-d9c2-44d9-ac06-b98423af9031';
      const mutate = vi.spyOn(f.service, 'mutateQueuedMessage').mockResolvedValue({ state: f.service.getState(false), restored: { text: 'original text' } });
      const edit = await f.run.mutateQueue({ id, action: 'edit' });
      expect(mutate).toHaveBeenCalledOnce();
      expect(mutate).toHaveBeenCalledWith({ id, action: 'edit' });
      expect(edit.restored).toEqual({ text: 'original text' });
      expect(f.adapter.invocations.filter((entry) => entry.kind === 'prompt')).toHaveLength(0);
      // The existing PiRuntimeService queue tests cover duplicate live IDs and recovery.
    } finally { await f.dispose(); }
  });

  it('preserves abort failure and writer ownership rather than inventing a stopped result', async () => {
    const f = await fixture();
    try {
      const id = f.service.getState(false).sessionId!;
      const controls = f.adapter.controls.get(id)!;
      controls.barriers.hold('emit');
      await f.run.prompt({ text: 'active', behavior: 'prompt' });
      await controls.barriers.reached('emit');
      controls.refuseCancellation = true;
      await expect(f.run.abort({})).rejects.toThrow(/cancellation failed/);
      expect(f.service.hasEvictionBlockingWork()).toBe(true);
      controls.refuseCancellation = false;
      await f.run.abort({});
      await vi.waitFor(() => expect(f.adapter.invocations.some((entry) => entry.kind === 'settled' && entry.sessionId === id)).toBe(true));
    } finally {
      // A failed abort did not release the writer early. After the later
      // successful stop and settlement, normal shutdown can complete.
      await expect(f.core.dispose()).resolves.toBeUndefined();
      await f.adapter.dispose();
    }
  });
});
