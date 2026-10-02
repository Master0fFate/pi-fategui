import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createPiSdkAdapter } from '../../src/main/pi/PiRuntimeService';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFateCore } from '../../src/core/createFateCore';
import { FatePaths } from '../../src/core/FatePaths';
import { NativeWorkflowReviewService } from '../../src/core/recovery/NativeWorkflowReview';
import { MultiProjectPiRuntime, type MultiProjectPiRuntimeDeps } from '../../src/main/pi/MultiProjectPiRuntime';
import { AgentsService } from '../../src/main/agents/AgentsService';
import { GoalMaxCoordinator, type GoalMaxCoordinatorHost } from '../../src/main/pi/goalmaxxing/GoalMaxCoordinator';
import { FakePiSdkAdapter } from './helpers/fakePi';
import { privateTestRoot } from './helpers/isolatedEnvironment';

const roots: string[] = [];
const settledRoots = new Set<string>();
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) { if (settledRoots.delete(root)) await fs.rm(root, { recursive: true, force: true }); else await fs.writeFile(path.join(privateTestRoot(), ".fate-retained-owned-work.json"), JSON.stringify({ root, reason: "review-composition cleanup not confirmed" })); } });
async function fixture() {
  const root = await fs.mkdtemp(path.join(privateTestRoot(), 'review-composition-')); roots.push(root);
  const project = path.join(root, 'project'); await fs.mkdir(project);
  const paths = new FatePaths({ dataRoot: path.join(root, 'data'), piAgentDir: path.join(root, 'pi'), sessionsRoot: path.join(root, 'pi', 'sessions'),
    attachmentRoot: path.join(root, 'attachments'), lockRoot: path.join(root, 'locks'), profileKind: 'desktop', profileId: 'review-fixture' });
  const adapter = new FakePiSdkAdapter();
  let dependencies!: MultiProjectPiRuntimeDeps;
  const createRuntime = (input: MultiProjectPiRuntimeDeps) => { dependencies = input; return new MultiProjectPiRuntime(input); };
  const core = await createFateCore({ paths, adapter, createRuntime, statePersistence: 'native-durable' });
  await core.runtime.openProject({ path: project, name: 'Fixture', trusted: true });
  const sessionId = core.runtime.getFocused().getState(false).sessionId!;
  // Seed an actual persisted active goal without generating a provider turn.
  const host: GoalMaxCoordinatorHost = { runtime: () => ({ projectPath: project, sessionId, projectTrusted: true, permissionLevel: 'edit',
    idle: true, streaming: false, queuedUserMessages: 0, tokensUsed: 0, activeChildren: 0, children: [] }),
    startGoal: async () => true, continueGoal: async () => undefined, steerGoal: async () => undefined,
    abortGoal: async () => undefined, verifyGoal: async () => ({ verdict: 'fail', report: 'Not executed' }),
    diagnoseGoal: async () => ({ report: 'Not executed' }), persistSessionEvent: () => {}, emit: () => {} };
  const seed = new GoalMaxCoordinator(host, dependencies.createGoalPersistence(), { capture: async () => ({ fingerprint: 'fixture', changedFileCount: 0, paths: [], repository: false }) } as never);
  await seed.create({ objective: 'Retained active goal requires new intent', verificationLevel: 'normal', agentStrategy: 'off', tokenLimit: null, timeLimitMs: null });
  const id = 'old-unknown'; const models = createModels();
  const scheduler = await dependencies.nativeWorkflowSchedulerFactory!({ id, parentSessionId: sessionId, cwd: project, models });
  await expect(scheduler.run({ nodes: [{ id: 'effect', dependsOn: [], dependencyFailure: 'skip' }], concurrency: () => 1,
    execute: async () => { throw new Error('Synthetic lost effect outcome'); }, started: () => {}, settled: () => {} }, new AbortController().signal)).rejects.toThrow();
  await core.dispose(); await adapter.dispose(); await seed.dispose();
  const filename = `workflow-${createHash('sha256').update(`${project}\0${sessionId}\0${id}`).digest('hex')}.sqlite`;
  const original = await fs.readFile(path.join(paths.dataRoot, 'durable', 'v1', filename));
  const review = new NativeWorkflowReviewService({ paths }); const plan = await review.prepare(); await review.acknowledge(plan);
  const nextAdapter = new FakePiSdkAdapter();
  const start = vi.spyOn(AgentsService.prototype, 'start');
  const restarted = await createFateCore({ paths, adapter: nextAdapter, createRuntime, savedAgents: { scheduleRoutines: true } });
  return { root, project, paths, sessionId, id, filename, original, models, review, plan, adapter: nextAdapter, core: restarted, start, dependencies: () => dependencies };
}

describe('actual reviewed UNKNOWN startup composition', () => {
  for (const disposition of ['handled', 'rejected'] as const) {
    it(`does not treat compaction-held input as intent when native preflight ${disposition} it`, async () => {
      const f = await fixture();
      try {
        await f.core.runtime.openProject({ path: f.project, name: 'Fixture', trusted: true });
        const service = f.core.runtime.getFocused();
        const internal = service as any, slot = internal.selectedSlot, session = slot.runtime.session;
        let compacting = true;
        Object.defineProperty(session, 'isCompacting', { configurable: true, get: () => compacting });
        vi.spyOn(session, 'prompt').mockImplementation(async (_text: any, options: any) => {
          if (disposition === 'rejected') throw new Error('Synthetic preflight refusal');
          options.preflightResult('handled');
        });
        await service.prompt({ text: 'Held user instruction', behavior: 'prompt' });
        expect(internal.allowsRecoveredContinuation(f.sessionId)).toBe(false);
        compacting = false; await internal.releaseHeldCompactionMessages(slot);
        expect(internal.allowsRecoveredContinuation(f.sessionId)).toBe(false);
        expect(await service.getGoalMax()).toMatchObject({ status: 'paused' });
      } finally { await f.core.dispose(); await f.adapter.dispose(); settledRoots.add(f.root); }
    });
  }

  it('waits for native acceptance of a current held input and discards cancelled held intent', async () => {
    const f = await fixture();
    try {
      await f.core.runtime.openProject({ path: f.project, name: 'Fixture', trusted: true });
      const service = f.core.runtime.getFocused(), internal = service as any, slot = internal.selectedSlot, session = slot.runtime.session;
      let compacting = true;
      Object.defineProperty(session, 'isCompacting', { configurable: true, get: () => compacting });
      await service.prompt({ text: 'Withdraw this held request', behavior: 'prompt' });
      await service.mutateQueuedMessage({ id: slot.heldCompactionMessages[0].id, action: 'cancel' });
      compacting = false; await internal.releaseHeldCompactionMessages(slot);
      expect(internal.allowsRecoveredContinuation(f.sessionId)).toBe(false);
      compacting = true;
      await service.prompt({ text: 'Accept this new held request', behavior: 'prompt' });
      expect(internal.allowsRecoveredContinuation(f.sessionId)).toBe(false);
      const controls = f.adapter.controls.get(f.sessionId)!; controls.barriers.hold('settle');
      compacting = false; await internal.releaseHeldCompactionMessages(slot); await controls.barriers.reached('settle');
      expect(internal.allowsRecoveredContinuation(f.sessionId)).toBe(true);
      await service.controlGoalMax({ action: 'pause', reason: 'Settle synthetic test' }); controls.barriers.release('settle');
    } finally { f.adapter.controls.forEach((control) => control.barriers.releaseAll()); await f.core.dispose(); await f.adapter.dispose(); settledRoots.add(f.root); }
  });

  it('refuses every backend selection if native state disappears beside retained workflow review evidence', async () => {
    const f = await fixture(); await f.core.dispose(); await f.adapter.dispose();
    const state = path.join(f.paths.dataRoot, 'durable', 'v1', 'state.sqlite');
    const preserved = path.join(f.root, 'preserved-state.sqlite'); await fs.rename(state, preserved);
    try {
      for (const statePersistence of [undefined, 'legacy-json', 'native-durable'] as const) {
        const createRuntime = vi.fn();
        await expect(createFateCore({ paths: f.paths, adapter: f.adapter, createRuntime, ...(statePersistence ? { statePersistence } : {}) })).rejects.toThrow('Native state is missing');
        expect(createRuntime).not.toHaveBeenCalled();
        await expect(fs.stat(state)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(await fs.readFile(path.join(f.paths.dataRoot, 'durable', 'v1', f.filename))).toEqual(f.original);
    } finally { await fs.rename(preserved, state); settledRoots.add(f.root); }
  });

  it('binds fresh direct-message intent to genuine native consumption before the synthetic model runs', async () => {
    const f = await fixture();
    await f.core.dispose(); await f.adapter.dispose();
    const models = await ModelRuntime.create({ authPath: path.join(f.root, 'synthetic-auth.json'), modelsPath: null,
      modelsStorePath: path.join(f.root, 'synthetic-models.json'), allowModelNetwork: false, refreshOnCreate: false });
    const faux = fauxProvider({ tokensPerSecond: 100_000 }); models.registerNativeProvider(faux.provider);
    const adapter = { ...createPiSdkAdapter(f.paths), createModelRuntime: async () => models };
    const core = await createFateCore({ paths: f.paths, adapter });
    try {
      expect(core.executionRecoveryMode).toBe('explicit-work-only');
      await core.runtime.openProject({ path: f.project, name: 'Fixture', trusted: true });
      const service = core.runtime.getFocused();
      const internal = service as unknown as {
        createAdditionalSlot(): Promise<{ runtime: { session: import('@earendil-works/pi-coding-agent').AgentSession } }>;
        allowsRecoveredContinuation(id: string): boolean;
      };
      const slot = await internal.createAdditionalSlot(), session = slot.runtime.session;
      await session.setModel(models.getModel('faux', 'faux-1')!);
      const consumed: string[] = []; let modelCalls = 0; let intentDuringModel = false; let consumedBeforeModel = false;
      const unsubscribe = session.subscribe((event) => {
        if (event.type === 'message_start' && event.message.role === 'custom') consumed.push(event.message.customType);
      });
      faux.setResponses([() => {
        modelCalls++;
        consumedBeforeModel = consumed.includes('fate-direct-session-message');
        intentDuringModel = internal.allowsRecoveredContinuation(session.sessionId);
        return fauxAssistantMessage('Synthetic accepted direct message.');
      }]);
      expect(internal.allowsRecoveredContinuation(session.sessionId)).toBe(false);
      await service.sendSessionMessage(session.sessionId, 'A fresh direct instruction');
      expect(modelCalls).toBe(1);
      expect(consumedBeforeModel).toBe(true); expect(intentDuringModel).toBe(true);
      expect(consumed).toEqual(['fate-direct-session-message']);
      // The idle background runtime is released after settlement. Its accepted
      // turn cannot authorize a future reopened generation.
      expect(internal.allowsRecoveredContinuation(session.sessionId)).toBe(false);
      unsubscribe();
    } finally { await core.dispose(); settledRoots.add(f.root); }
  });

  it('opens a persisted active goal inertly and only admits automatic continuation after a new explicit prompt', async () => {
    const f = await fixture();
    try {
      expect(f.core.executionRecoveryMode).toBe('explicit-work-only'); expect(f.start).not.toHaveBeenCalled();
      await f.core.runtime.openProject({ path: f.project, name: 'Fixture', trusted: true });
      const service = f.core.runtime.getFocused();
      expect(service.getState(false).sessionId).toBe(f.sessionId);
      expect(await service.getGoalMax()).toMatchObject({ status: 'paused', executionState: 'idle', blockedReason: expect.stringContaining('explicit') });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(f.adapter.invocations.filter((item) => item.kind === 'prompt')).toHaveLength(0);
      const controls = f.adapter.controls.get(f.sessionId)!; controls.barriers.hold('settle');
      expect(await service.prompt({ text: 'New explicit reviewed work', behavior: 'prompt' })).toMatchObject({ accepted: true });
      await controls.barriers.reached('settle');
      expect(await service.getGoalMax()).toMatchObject({ status: 'active' });
      await service.controlGoalMax({ action: 'pause', reason: 'Test quiescence before releasing the synthetic turn' });
      controls.barriers.release('settle');
      expect(f.adapter.invocations.filter((item) => item.kind === 'prompt')).toHaveLength(1);
      expect(await fs.readFile(path.join(f.paths.dataRoot, 'durable', 'v1', f.filename))).toEqual(f.original);
    } finally { f.adapter.controls.forEach((control) => control.barriers.releaseAll()); await f.core.dispose(); await f.adapter.dispose(); settledRoots.add(f.root); }
  });

  it('refuses the retired identity before storage opens while a separately reviewed new identity can execute', async () => {
    const f = await fixture();
    try {
      const factory = f.dependencies().nativeWorkflowSchedulerFactory!;
      await expect(factory({ id: f.id, parentSessionId: f.sessionId, cwd: f.project, models: f.models })).rejects.toMatchObject({ code: 'NATIVE_EFFECT_NOT_STARTED' });
      const effect = vi.fn(async (id: string) => ({ id, status: 'completed' as const }));
      const fresh = await factory({ id: 'explicit-new-identity', parentSessionId: f.sessionId, cwd: f.project, models: f.models });
      await expect(fresh.run({ nodes: [{ id: 'new', dependsOn: [], dependencyFailure: 'skip' }], concurrency: () => 1, execute: effect,
        started: () => {}, settled: () => {} }, new AbortController().signal)).resolves.toBeDefined();
      expect(effect).toHaveBeenCalledOnce();
      expect(f.adapter.invocations.filter((item) => item.kind === 'prompt')).toHaveLength(0);
      expect(await fs.readFile(path.join(f.paths.dataRoot, 'durable', 'v1', f.filename))).toEqual(f.original);
    } finally { await f.core.dispose(); await f.adapter.dispose(); settledRoots.add(f.root); }
  });
  it('holds automatic child notifications and preserves an explicit no-wake flag through deferred delivery', async () => {
    const f = await fixture();
    try {
      await f.core.runtime.openProject({ path: f.project, name: 'Fixture', trusted: true });
      const service = f.core.runtime.getFocused();
      const internal = service as unknown as {
        selectedSlot: { runtime: { session: import('@earendil-works/pi-coding-agent').AgentSession }; sessionGeneration: number; sessionTurnPhase: string };
        sendChildGeneratedMessage(...args: unknown[]): Promise<void>;
        flushDeferredChildMessages(...args: unknown[]): void;
      };
      const slot = internal.selectedSlot, session = slot.runtime.session;
      const delivery = vi.spyOn(session, 'sendCustomMessage').mockResolvedValue(undefined);
      const message = { customType: 'synthetic-child-report', content: 'retained result', display: true };
      await internal.sendChildGeneratedMessage(slot, session, message, 'followUp', true);
      expect(delivery).toHaveBeenLastCalledWith(message, { triggerTurn: false });
      const controls = f.adapter.controls.get(f.sessionId)!; controls.barriers.hold('settle');
      expect(await service.prompt({ text: 'Explicit test turn', behavior: 'prompt' })).toMatchObject({ accepted: true });
      await controls.barriers.reached('settle'); expect(session.isStreaming).toBe(true);
      slot.sessionTurnPhase = 'idle'; delivery.mockClear();
      await internal.sendChildGeneratedMessage(slot, session, message, 'followUp', false);
      expect(delivery).not.toHaveBeenCalled();
      internal.flushDeferredChildMessages(slot, session, slot.sessionGeneration);
      await vi.waitFor(() => expect(delivery).toHaveBeenCalledWith(message, { triggerTurn: false, deliverAs: 'followUp' }));
      await service.controlGoalMax({ action: 'pause', reason: 'Settle fixture without automatic continuation' });
      controls.barriers.release('settle'); delivery.mockRestore();
      expect(f.adapter.invocations.filter((item) => item.kind === 'prompt')).toHaveLength(1);
    } finally { await f.core.dispose(); await f.adapter.dispose(); settledRoots.add(f.root); }
  });

});
