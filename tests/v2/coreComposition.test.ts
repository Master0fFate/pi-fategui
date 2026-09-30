import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFateCore } from '../../src/core/createFateCore';
import { WorkspaceSnapshotService } from '../../src/core/views/WorkspaceSnapshotService';
import { FatePaths, createDesktopFatePaths } from '../../src/core/FatePaths';
import { AgentsService } from '../../src/main/agents/AgentsService';
import { LearningRepository } from '../../src/main/learning/LearningRepository';
import { LearningService } from '../../src/main/learning/LearningService';
import { AppLogService } from '../../src/main/logging/AppLogService';
import { MultiProjectPiRuntime, type MultiProjectPiRuntimeDeps } from '../../src/main/pi/MultiProjectPiRuntime';
import { MutationAttestationLedger } from '../../src/main/pi/provenance/MutationAttestationLedger';
import { SettingsService } from '../../src/main/settings/SettingsService';
import { FakePiSdkAdapter } from './helpers/fakePi';
import { privateTestRoot } from './helpers/isolatedEnvironment';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(privateTestRoot(), 'core-'));
  roots.push(root);
  const project = path.join(root, 'project');
  await mkdir(project);
  const paths = new FatePaths({
    dataRoot: path.join(root, 'data'), piAgentDir: path.join(root, 'agent'), sessionsRoot: path.join(root, 'agent', 'sessions'),
    attachmentRoot: path.join(root, 'attachments'), lockRoot: path.join(root, 'locks'), profileId: 'fixture',
  });
  return { root, project, paths, adapter: new FakePiSdkAdapter() };
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })));
});

describe('real Node-only Fate core composition', () => {
  it('creates one existing MultiProject runtime and starts/stops an actual deterministic Pi session', async () => {
    const { paths, project, adapter } = await fixture();
    const createRuntime = vi.fn((deps: MultiProjectPiRuntimeDeps) => new MultiProjectPiRuntime({
      ...deps, createSessionTitleGenerator: () => ({ generate: async () => null }),
    }));
    const runtimeCreation = vi.spyOn(adapter, 'createRuntime');
    const adapterDispose = vi.spyOn(adapter, 'dispose');
    const settled = vi.fn();
    const core = await createFateCore({ paths, adapter, createRuntime, attention: { sessionSettled: settled } });
    try {
      expect(createRuntime).toHaveBeenCalledOnce();
      expect(core.runtime).toBeInstanceOf(MultiProjectPiRuntime);
      expect(createRuntime.mock.calls[0]?.[0].browserIntegration).toBeNull();
      expect(core.savedAgents).toBeNull();
      const state = await core.runtime.openProject({ path: project, name: 'fixture', trusted: true });
      expect(state).toMatchObject({ status: 'ready', permissionLevel: 'edit' });
      expect(adapter.invocations.filter((entry) => entry.kind === 'createModelRuntime')).toHaveLength(1);
      expect(runtimeCreation).toHaveBeenCalledOnce();
      expect(runtimeCreation.mock.calls[0]?.[3]?.some((tool) => tool.name.startsWith('browser_'))).toBe(false);
      await expect(core.runtime.asRouter().prompt({ text: 'deterministic turn', behavior: 'prompt' })).resolves.toMatchObject({ accepted: true });
      await vi.waitFor(() => expect(adapter.invocations.some((entry) => entry.kind === 'settled')).toBe(true));
      const origin = core.runtime.workspaceOrigin(project)!;
      const scope = { principalId: 'test', clientId: 'tab', ...origin, serverEpoch: core.events.serverEpoch,
        sessionId: state.sessionId!, projectPath: project };
      const owner = core.runtime.peekWorkspace(project)!;
      const beforeRead = adapter.invocations.length;
      const replay = core.events.subscribe(scope);
      expect(replay.drain().some((envelope) => envelope.origin.sessionId === state.sessionId)).toBe(true);
      replay.close();
      const capture = core.events.subscribeAndSnapshot(scope,
        new WorkspaceSnapshotService(() => owner.flushSnapshotEvents(), () => owner.captureSnapshotView()));
      expect(capture.snapshot.header?.eventStream).toEqual(core.events.position(scope));
      capture.subscription.close();
      expect(adapter.invocations).toHaveLength(beforeRead); // Replay and capture never invoke a provider or command.
      expect(settled).toHaveBeenCalled();
      expect(adapter.invocations.some((entry) => entry.kind === 'providerBlocked')).toBe(false);
      const firstDisposal = core.dispose();
      expect(core.dispose()).toBe(firstDisposal);
      await firstDisposal;
      expect(adapterDispose).not.toHaveBeenCalled(); // Borrowed adapter itself remains caller-owned.
    } finally { await core.dispose(); await adapter.dispose(); }
  });

  it('observes selection before any registry handle exists, with a monotonic host revision', async () => {
    const { paths, project, adapter } = await fixture();
    const core = await createFateCore({ paths, adapter });
    try {
      const opened = await core.runtime.openProject({ path: project, name: 'fixture', trusted: true });
      expect(opened.sessionId).toBeTruthy();
      const before = core.runtime.workspaceSelectionRevision(project);
      expect(before).not.toBeNull();
      const second = await core.runtime.asRouter().newSession();
      expect(second.sessionId).not.toBe(opened.sessionId);
      expect(core.runtime.workspaceSelectionRevision(project)).toBe(before! + 1);
      expect(core.workspaces).toBeNull();
    } finally { await core.dispose(); await adapter.dispose(); }
  });

  it('preserves provider first run before settings can create the profile directory', async () => {
    const { paths: fixturePaths, adapter } = await fixture();
    const paths = new FatePaths({ ...fixturePaths, profileId: 'desktop', profileKind: 'desktop' });
    await mkdir(paths.piAgentDir);
    await writeFile(path.join(paths.piAgentDir, 'auth.json'), '{"fixture":"not-a-real-secret"}');
    await writeFile(path.join(paths.piAgentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'v2-fake', defaultModel: 'v2-deterministic' }));
    await expect(access(paths.dataRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    const core = await createFateCore({ paths, adapter });
    try {
      expect(core.settings.get().defaultModel).toBe('v2-fake/v2-deterministic');
      expect(await readFile(path.join(paths.dataRoot, 'auth.json'), 'utf8')).toBe('{"fixture":"not-a-real-secret"}');
      expect(await readFile(core.settings.getStoragePath(), 'utf8')).toContain('v2-fake/v2-deterministic');
      await expect(access(paths.attachmentRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      // T27 lock parent is separate from provider data and exists while core owns it.
      await expect(access(paths.lockRoot)).resolves.toBeUndefined();
    } finally { await core.dispose(); await adapter.dispose(); }
  });

  it('refuses a real server adapter pointed at desktop Pi roots before any storage side effect', async () => {
    const { paths: fixturePaths } = await fixture();
    const paths = new FatePaths({ ...fixturePaths, piAgentDir: createDesktopFatePaths().piAgentDir });
    const createRuntime = vi.fn((deps: MultiProjectPiRuntimeDeps) => new MultiProjectPiRuntime(deps));
    await expect(createFateCore({ paths, createRuntime })).rejects.toThrow('separate Pi, credential and session roots');
    expect(createRuntime).not.toHaveBeenCalled();
    await expect(access(paths.dataRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('can construct the real default adapter without eagerly starting a provider or project', async () => {
    const core = await createFateCore({ paths: createDesktopFatePaths() });
    try {
      expect(core.runtime.getFocused().getState(false)).toMatchObject({ project: null, status: 'disconnected' });
    } finally { await core.dispose(); }
  });

  it('disposes owned resources in reverse order after settings startup fails; borrowed services survive', async () => {
    vi.useFakeTimers();
    const { paths, adapter } = await fixture();
    const logs = new AppLogService();
    const settings = new SettingsService(logs, paths.dataRoot, undefined, paths.piAgentDir);
    vi.spyOn(settings, 'load').mockRejectedValue(new Error('settings startup failed'));
    const settingsFlush = vi.spyOn(settings, 'flush');
    const repository = new LearningRepository(paths.dataRoot);
    const repositoryFlush = vi.spyOn(repository, 'flush');
    const borrowedLedger = new MutationAttestationLedger(logs, paths.dataRoot);
    const ledgerDispose = vi.spyOn(borrowedLedger, 'dispose');
    const ledgerFlush = vi.spyOn(borrowedLedger, 'flush');
    const order: string[] = [];
    const disposeRuntime = MultiProjectPiRuntime.prototype.dispose;
    vi.spyOn(MultiProjectPiRuntime.prototype, 'dispose').mockImplementation(async function (this: MultiProjectPiRuntime) {
      order.push('runtime'); await disposeRuntime.call(this);
    });
    const disposeLearning = LearningService.prototype.dispose;
    vi.spyOn(LearningService.prototype, 'dispose').mockImplementation(function (this: LearningService) {
      order.push('learning'); disposeLearning.call(this);
    });
    const before = vi.getTimerCount();
    await expect(createFateCore({ paths, adapter, settings, persistence: { learning: repository, attestations: borrowedLedger } })).rejects.toThrow('settings startup failed');
    expect(order).toEqual(['runtime', 'learning']);
    expect(vi.getTimerCount()).toBe(before);
    expect(settingsFlush).not.toHaveBeenCalled();
    expect(repositoryFlush).not.toHaveBeenCalled();
    expect(ledgerDispose).not.toHaveBeenCalled();
    expect(ledgerFlush).not.toHaveBeenCalled();
    await adapter.dispose();
  });

  it('owns at most one optional saved-Agents scheduler and cleans it up if its startup fails', async () => {
    vi.useFakeTimers();
    const { paths, adapter } = await fixture();
    const order: string[] = [];
    const start = AgentsService.prototype.start;
    const startSpy = vi.spyOn(AgentsService.prototype, 'start').mockImplementation(function (this: AgentsService) {
      start.call(this); throw new Error('scheduler startup failed');
    });
    const disposeAgents = AgentsService.prototype.dispose;
    vi.spyOn(AgentsService.prototype, 'dispose').mockImplementation(async function (this: AgentsService) { order.push('agents'); await disposeAgents.call(this); });
    const disposeRuntime = MultiProjectPiRuntime.prototype.dispose;
    vi.spyOn(MultiProjectPiRuntime.prototype, 'dispose').mockImplementation(async function (this: MultiProjectPiRuntime) { order.push('runtime'); await disposeRuntime.call(this); });
    const disposeLedger = MutationAttestationLedger.prototype.dispose;
    vi.spyOn(MutationAttestationLedger.prototype, 'dispose').mockImplementation(function (this: MutationAttestationLedger) { order.push('attestations'); disposeLedger.call(this); });
    const disposeLearning = LearningService.prototype.dispose;
    vi.spyOn(LearningService.prototype, 'dispose').mockImplementation(function (this: LearningService) { order.push('learning'); disposeLearning.call(this); });
    const flushRepository = LearningRepository.prototype.flush;
    vi.spyOn(LearningRepository.prototype, 'flush').mockImplementation(async function (this: LearningRepository) { order.push('learning-store'); await flushRepository.call(this); });
    const flushSettings = SettingsService.prototype.flush;
    vi.spyOn(SettingsService.prototype, 'flush').mockImplementation(async function (this: SettingsService) { order.push('settings'); await flushSettings.call(this); });
    const before = vi.getTimerCount();
    await expect(createFateCore({ paths, adapter, savedAgents: { scheduleRoutines: true } })).rejects.toThrow('scheduler startup failed');
    expect(startSpy).toHaveBeenCalledOnce();
    expect(order).toEqual(['agents', 'runtime', 'attestations', 'learning', 'learning-store', 'settings']);
    expect(vi.getTimerCount()).toBe(before);
    await adapter.dispose();
  });

  it('cleans later resources despite shutdown failure and never pretends failed shutdown succeeded', async () => {
    const { paths, adapter } = await fixture();
    const original = MultiProjectPiRuntime.prototype.dispose;
    const runtimeDispose = vi.spyOn(MultiProjectPiRuntime.prototype, 'dispose').mockImplementation(async function (this: MultiProjectPiRuntime) {
      await original.call(this); throw new Error('runtime shutdown diagnostic');
    });
    const learningDispose = vi.spyOn(LearningService.prototype, 'dispose');
    const settingsFlush = vi.spyOn(SettingsService.prototype, 'flush');
    const core = await createFateCore({ paths, adapter });
    const disposal = core.dispose();
    await expect(disposal).rejects.toThrow('Fate core shutdown was incomplete');
    expect(core.dispose()).toBe(disposal);
    expect(runtimeDispose).toHaveBeenCalledOnce();
    expect(learningDispose).toHaveBeenCalledOnce();
    expect(settingsFlush).toHaveBeenCalledOnce();
    await adapter.dispose();
  });
});
