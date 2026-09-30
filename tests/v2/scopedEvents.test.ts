import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFateCore } from '../../src/core/createFateCore';
import { FatePaths } from '../../src/core/FatePaths';
import { ScopedDomainEvents } from '../../src/core/events/ScopedDomainEvents';
import type { PiEvent } from '../../src/shared/contracts/ipc';
import { FakePiSdkAdapter } from './helpers/fakePi';
import { privateTestRoot } from './helpers/isolatedEnvironment';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))); });
async function fixture() {
  const root = await mkdtemp(path.join(privateTestRoot(), 'scoped-')); roots.push(root);
  const a = path.join(root, 'A'), b = path.join(root, 'B'); await mkdir(a); await mkdir(b);
  const adapter = new FakePiSdkAdapter();
  const core = await createFateCore({ adapter, paths: new FatePaths({ dataRoot: path.join(root, 'data'), piAgentDir: path.join(root, 'pi'), sessionsRoot: path.join(root, 'pi', 'sessions'), attachmentRoot: path.join(root, 'attachments'), lockRoot: path.join(root, 'locks'), profileId: 'test' }) });
  return { core, adapter, a, b, dispose: async () => { await core.dispose(); await adapter.dispose(); } };
}

describe('producer-scoped domain events', () => {
  it('retains A text/session after selecting B while B streams independently', async () => {
    const f = await fixture();
    const scoped: Array<{ id: string; session: string | null; event: PiEvent }> = [];
    const desktop = vi.fn();
    f.core.runtime.setEventSink(desktop);
    const unsubscribe = f.core.runtime.scopedEvents.subscribe(({ kind, origin, event }) => {
      if (kind === 'pi') scoped.push({ id: origin.workspaceId, session: origin.sessionId, event });
    });
    try {
      await f.core.runtime.openProject({ path: f.a, name: 'A', trusted: true });
      const aService = f.core.runtime.getFocused();
      const aSession = aService.getState(false).sessionId!;
      f.adapter.controls.get(aSession)!.barriers.hold('emit');
      await f.core.runtime.asRouter().prompt({ text: 'A turn', behavior: 'prompt' });
      await f.adapter.controls.get(aSession)!.barriers.reached('emit');
      await f.core.runtime.openProject({ path: f.b, name: 'B', trusted: true });
      const bService = f.core.runtime.getFocused();
      const bSession = bService.getState(false).sessionId!;
      f.adapter.controls.get(bSession)!.text = 'B transcript';
      await f.core.runtime.asRouter().prompt({ text: 'B turn', behavior: 'prompt' });
      const legacyBefore = desktop.mock.calls.length;
      f.adapter.controls.get(aSession)!.barriers.release('emit');
      await vi.waitFor(() => expect(f.adapter.invocations.some((entry) => entry.kind === 'emit' && entry.sessionId === aSession)).toBe(true));
      const aOrigin = f.core.runtime.workspaceOrigin(f.a)!;
      const bOrigin = f.core.runtime.workspaceOrigin(f.b)!;
      expect(aOrigin.workspaceId).not.toBe(bOrigin.workspaceId);
      expect(scoped.some((item) => item.id === aOrigin.workspaceId && item.session === aSession && JSON.stringify(item.event).includes('deterministic response'))).toBe(true);
      expect(scoped.every((item) => item.id !== bOrigin.workspaceId || !JSON.stringify(item.event).includes('deterministic response'))).toBe(true);
      expect(f.core.runtime.focusedProjectPath).toBe(f.b);
      expect(desktop.mock.calls.length).toBeGreaterThanOrEqual(legacyBefore);
      unsubscribe();
    } finally { await f.dispose(); }
  });

  it('forwards background task and goal updates with the producer session', async () => {
    const f = await fixture();
    const seen: Array<{ kind: string; sessionId: string | null; id: string }> = [];
    f.core.runtime.scopedEvents.subscribe((entry) => seen.push({ kind: entry.kind, sessionId: entry.origin.sessionId, id: entry.origin.workspaceId }));
    try {
      await f.core.runtime.openProject({ path: f.a, name: 'A', trusted: true });
      const service = f.core.runtime.getFocused();
      const sessionId = service.getState(false).sessionId!;
      await f.core.runtime.openProject({ path: f.b, name: 'B', trusted: true });
      await service.createTask({ title: 'Background task', detail: '', required: false, status: 'todo' });
      await service.createGoalMax({ objective: 'Verify background goal events', verificationLevel: 'normal', agentStrategy: 'off', tokenLimit: null, timeLimitMs: null });
      const origin = f.core.runtime.workspaceOrigin(f.a)!;
      expect(seen).toContainEqual({ kind: 'task', sessionId, id: origin.workspaceId });
      expect(seen).toContainEqual({ kind: 'goal', sessionId, id: origin.workspaceId });
      expect(f.core.runtime.focusedProjectPath).toBe(f.b);
    } finally { await f.dispose(); }
  });

  it('delivers a background Team update without routing it to B', async () => {
    const f = await fixture();
    const seen: Array<{ id: string; session: string | null; type: string }> = [];
    f.core.runtime.scopedEvents.subscribe((entry) => {
      if (entry.kind === 'pi') seen.push({ id: entry.origin.workspaceId, session: entry.origin.sessionId, type: entry.event.type });
    });
    try {
      await f.core.runtime.openProject({ path: f.a, name: 'A', trusted: true });
      const service = f.core.runtime.getFocused();
      const session = service.getState(false).sessionId!;
      await f.core.runtime.openProject({ path: f.b, name: 'B', trusted: true });
      await service.controlAgentTeam({ action: 'createTeam', name: 'Background team' });
      expect(seen).toContainEqual({ id: f.core.runtime.workspaceOrigin(f.a)!.workspaceId, session, type: 'agent-team.updated' });
      expect(f.core.runtime.getFocused().getState(false).project?.path).toBe(f.b);
    } finally { await f.dispose(); }
  });

  it('keeps adjacent identical message IDs separate by producer origin and protects deltas from legacy mutation', () => {
    const events = new ScopedDomainEvents();
    const captured: PiEvent[] = [];
    events.subscribe((entry) => { if (entry.kind === 'pi') captured.push(entry.event); });
    const first: PiEvent = { type: 'assistant.text', messageId: 'same', delta: 'A', timestamp: 1 };
    events.publish({ kind: 'pi', origin: { workspaceId: 'A', workspaceGeneration: 1, sessionId: 'SA' }, event: first });
    first.delta += 'later legacy merge';
    events.publish({ kind: 'pi', origin: { workspaceId: 'B', workspaceGeneration: 1, sessionId: 'SB' }, event: { type: 'assistant.text', messageId: 'same', delta: 'B', timestamp: 2 } });
    expect(captured.map((event) => event.type === 'assistant.text' ? event.delta : null)).toEqual(['A', 'B']);
  });
});
