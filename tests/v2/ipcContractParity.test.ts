import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CoreIpcAdapter } from '../../src/main/ipc/CoreIpcAdapter';
import { createScopedRuntimeHandlers } from '../../src/core/handlers/runtimeHandlers';
import { WorkspaceAdmissionQueue } from '../../src/core/workspaces/WorkspaceAdmissionQueue';
import type { WorkspaceHandle } from '../../src/core/workspaces/WorkspaceHandle';
import type { WorkspaceRegistry } from '../../src/core/workspaces/WorkspaceRegistry';
import type { MultiProjectPiRuntime } from '../../src/main/pi/MultiProjectPiRuntime';
import { runAbortContract, runPromptContract, runSelectionContract } from './fixtures/contractCases';
import type { MonitorDashboard } from '../../src/shared/contracts/monitorDashboard';

const rootA = 'C:/temporary/contract-project-A';
const rootB = 'C:/temporary/contract-project-B';
const sessionA = randomUUID();
const sessionB = randomUUID();
const workspaceId = randomUUID();

function fixture(abortFailure?: Error) {
  let calls = 0;
  let prompts = 0;
  let selects = 0;
  let trusted = true;
  let member = true;
  let selected: string = sessionA;
  let hostRevision = 0;
  let focusedRoot = rootA;
  let onRegister: (() => void | Promise<void>) | undefined;
  let monitorCalls = 0;
  const dashboard = (root: string, id: string): MonitorDashboard => ({
    projectPath: root, sessionId: id, checkedAt: 1, revision: 'rev', overall: 'unknown',
    sources: { runs: 'unknown', teams: 'unknown', tasks: 'unknown', activity: 'unknown' },
    sourceCheckedAt: { runs: null, teams: null, tasks: null, activity: null },
    counts: { active: 0, attention: 0, runs: 0, teams: 0, tasks: 0, activity: 0 },
    section: 'tasks', total: 0, offset: 2, limit: 5, unchanged: false, items: [],
  });
  const observe = (id: string) => {
    if (selected !== id) { selected = id; hostRevision += 1; }
    queue.observeSelection(id);
  };
  const owner = {
    getState: (_includeMessages: false) => ({ project: { path: rootA, trusted: true }, sessionId: selected }),
    abort: async () => { calls++; if (abortFailure) throw abortFailure; return { aborted: true }; },
    prompt: async () => { prompts++; return { accepted: true, runId: randomUUID() }; },
    switchSession: async (id: string) => { selects++; observe(id); return {
      status: 'ready', project: { path: rootA, name: 'A', trusted: true }, sessionId: id,
      sessionFile: null, streaming: false, model: null, models: [], thinkingLevel: 'off', messages: [], error: null,
    }; },
    getMonitorDashboard: async (...args: unknown[]) => {
      // No live root slot exists in this fixture. The native desktop read must not
      // provide the agent-tool-only root session argument.
      if (args.length > 1) throw new Error('Cold session has no live root slot');
      monitorCalls++;
      return dashboard(rootA, selected);
    },
  };
  let queue = new WorkspaceAdmissionQueue(owner, 1);
  let handle = { id: workspaceId, generation: 1, root: rootA, runtime: owner, admission: queue } as unknown as WorkspaceHandle;
  const router = {
    getState: () => ({ project: { path: focusedRoot, trusted: true }, sessionId: selected }),
  };
  const runtime = {
    asRouter: () => router,
    workspaceOrigin: (root: string) => root === rootA ? { workspaceId, workspaceGeneration: 1 } : null,
    workspaceSelectionRevision: (root: string) => root === rootA ? hostRevision : null,
    peekWorkspace: (root: string) => root === rootA ? owner : null,
  } as unknown as MultiProjectPiRuntime;
  const registry = {
    registerHostPath: async (root: string) => { await onRegister?.(); if (root !== rootA) throw new Error('Unregistered root'); return handle; },
    resolve: (_identity: unknown, id: string, generation: number) => {
      if (!member || id !== workspaceId || generation !== 1) throw new Error('No membership');
      return handle;
    },
  } as unknown as WorkspaceRegistry;
  const adapter = new CoreIpcAdapter(runtime, registry, () => trusted);
  return { adapter, calls: () => calls, prompts: () => prompts, selects: () => selects,
    monitorCalls: () => monitorCalls, selectionRevision: () => queue.snapshot().selectionRevision,
    distrust: () => { trusted = false; }, revoke: () => { member = false; },
    focus: (root: string) => { focusedRoot = root; },
    select: observe,
    onRegister: (action: () => void | Promise<void>) => { onRegister = action; },
    replaceFirstQueue: () => {
      queue = new WorkspaceAdmissionQueue(owner, 1);
      handle = { ...handle, admission: queue } as unknown as WorkspaceHandle;
    },
  };
}

describe('desktop IPC contract (transport-reusable cases)', () => {
  it('runs one selected-session abort through the dispatcher; never invokes two handlers', async () => {
    const { adapter, calls } = fixture();
    await runAbortContract({ abort: () => adapter.abort({}), calls });
  });
  it('keeps a native handler failure without retrying or running a second implementation', async () => {
    const failure = new Error('Existing abort failure');
    const { adapter, calls } = fixture(failure);
    await expect(adapter.abort({})).rejects.toBe(failure);
    expect(calls()).toBe(1);
  });
  it('rejects an untrusted sender before dispatch and does not run a command', async () => {
    const { adapter, calls, distrust } = fixture();
    distrust();
    await expect(adapter.abort({})).rejects.toThrow();
    expect(calls()).toBe(0);
  });
  it('keeps named Monitor paging and source status for a selected cold session without a live root slot', async () => {
    const { adapter, monitorCalls } = fixture();
    const result = await adapter.monitor({ section: 'tasks', offset: 2, limit: 5 });
    expect(result).toMatchObject({ projectPath: rootA, sessionId: sessionA, offset: 2, limit: 5, sources: { runs: 'unknown' } });
    expect(monitorCalls()).toBe(1);
  });
  it('rejects a session selected during registration without aborting the new session', async () => {
    const { adapter, calls, onRegister, select } = fixture();
    onRegister(() => select(sessionB));
    await expect(adapter.abort({})).rejects.toThrow();
    expect(calls()).toBe(0);
  });
  it('rejects first-registration A→B→A across an awaited barrier and a fresh revision-zero queue', async () => {
    const { adapter, calls, onRegister, select, replaceFirstQueue, selectionRevision } = fixture();
    let entered!: () => void;
    let release!: () => void;
    const atBarrier = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    onRegister(async () => { entered(); await gate; replaceFirstQueue(); });
    const pending = adapter.abort({});
    await atBarrier;
    select(sessionB);
    select(sessionA);
    release();
    await expect(pending).rejects.toThrow();
    expect(selectionRevision()).toBe(0);
    expect(calls()).toBe(0);
  });
  it('rejects A→B→A after capture at the real queue head, with no abort side effect', async () => {
    const { adapter, calls, select, selectionRevision } = fixture();
    await adapter.scoped(async ({ handle, authorize, command }) => {
      select(sessionB);
      select(sessionA);
      expect(selectionRevision()).toBe(command.selectionRevision + 2);
      await expect(createScopedRuntimeHandlers(handle, authorize).abort(command, {})).rejects.toMatchObject({ code: 'STALE_SESSION' });
    });
    expect(calls()).toBe(0);
  });
  it('refuses a project switch or revoked membership before an abort enters the handler', async () => {
    const first = fixture();
    first.onRegister(() => first.focus(rootB));
    await expect(first.adapter.abort({})).rejects.toThrow();
    expect(first.calls()).toBe(0);
    const second = fixture();
    second.onRegister(() => second.revoke());
    await expect(second.adapter.abort({})).rejects.toThrow();
    expect(second.calls()).toBe(0);
  });
  it('dispatches a plain-text prompt once and retains the legacy acceptance result', async () => {
    const { adapter, prompts } = fixture();
    await runPromptContract({ prompt: (text) => adapter.prompt({ text }), calls: prompts });
  });
  it('dispatches selection once and advances its real revision', async () => {
    const { adapter, selects, selectionRevision } = fixture();
    await runSelectionContract({ select: (sessionId) => adapter.select({ sessionId }), calls: selects }, sessionB);
    expect(selectionRevision()).toBe(1);
  });
});
