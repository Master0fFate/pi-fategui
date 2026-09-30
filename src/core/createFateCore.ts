import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentWorkspaceGitService } from '../main/git/AgentWorkspaceGitService';
import { agentTeamStorageRoots } from '../main/pi/multi-agent/AgentTeamHistory';
import { CommandJournal } from './commands/CommandJournal';
import { LifecycleRepository } from './recovery/LifecycleRepository';
import { RecoveryCoordinator } from './recovery/RecoveryCoordinator';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { AgentRepository } from '../main/agents/AgentRepository';
import { AgentsService, type AgentsHost } from '../main/agents/AgentsService';
import type { LegacyAutomations } from '../main/automations/LegacyAutomations';
import { LearningRepository } from '../main/learning/LearningRepository';
import { LearningService } from '../main/learning/LearningService';
import { AppLogService } from '../main/logging/AppLogService';
import { fateDataRoot, prepareFateProviderStorage } from '../main/pi/FateProviderStorage';
import { createPiSdkAdapter } from '../main/pi/PiRuntimeService';
import { TaskRepository } from '../main/pi/tasks/TaskRepository';
import { MultiProjectPiRuntime, type MultiProjectPiRuntimeDeps } from '../main/pi/MultiProjectPiRuntime';
import type { PiSdkAdapter } from '../main/pi/PiRuntimeService';
import { PiSessionRepository } from '../main/pi/PiSessionRepository';
import { SessionPermissionStore, type SessionPermissionPersistence } from '../main/pi/SessionPermissionStore';
import { SessionQueueRepository, type SessionQueuePersistence } from '../main/pi/SessionQueueRepository';
import { GoalMaxRepository, type GoalMaxPersistence } from '../main/pi/goalmaxxing/GoalMaxRepository';
import { ModelsDevService } from '../main/pi/modelsdev/ModelsDevService';
import { ModelsDevStore } from '../main/pi/modelsdev/ModelsDevStore';
import { MutationAttestationLedger } from '../main/pi/provenance/MutationAttestationLedger';
import { createMutationRecorder } from '../main/pi/provenance/mutationRecorder';
import type { TaskPersistence } from '../main/pi/tasks/TaskRepository';
import { PiThemeService } from '../main/settings/PiThemeService';
import { SettingsService } from '../main/settings/SettingsService';
import { enabledModelIdentity } from '../shared/modelVisibility';
import type { FateCore } from './FateCore';
import { CoreLifecycle, type CoreClientResources } from './lifecycle/CoreLifecycle';
import { WorkspaceEventHub } from './events/WorkspaceEventHub';
import { FatePaths } from './FatePaths';
import type { AttentionPort, BrowserIntegrationPort, ClockPort, FatePathConfiguration, ProjectRegistrationPort, ProviderAuthUrlPort } from './ports';
import type { RequestContext } from './dispatch/RequestContext';
import { WorkspaceRegistry } from './workspaces/WorkspaceRegistry';
import { ProjectTrustService } from './projects/ProjectTrustService';
import { OwnerLock, canonicalFuturePath } from './ownership/OwnerLock';
import { hostCheckoutOwnership } from './ownership/CheckoutOwnership';
import type { PermissionHostPolicy } from './security/PermissionPolicy';

export interface FateCoreOptions {
  readonly paths: FatePathConfiguration;
  readonly logs?: AppLogService;
  /** Only APIs which already support a clock (themes and model metadata) use this clock. */
  readonly clock?: ClockPort;
  /** Omit to use the real existing Pi adapter. Test adapters own their SDK resources/paths. */
  readonly adapter?: PiSdkAdapter;
  readonly permissionHost?: PermissionHostPolicy;
  readonly browserIntegration?: BrowserIntegrationPort | null;
  readonly providerAuthUrlPresenter?: ProviderAuthUrlPort;
  readonly attention?: AttentionPort;
  /** Both host-owned sources are required; omission creates no workspace registry. */
  readonly workspaceRegistration?: ProjectRegistrationPort;
  readonly workspaceMembership?: (identity: RequestContext, workspaceId: string) => boolean;
  readonly instanceSlot?: number;
  /** Finite host wait for the truthful shutdown result; cleanup may continue afterward. */
  readonly shutdownBudgetMs?: number;
  /** Borrowed services/persistence are never disposed or flushed by this factory. */
  readonly settings?: SettingsService;
  readonly persistence?: {
    readonly learning?: LearningRepository;
    readonly permissions?: SessionPermissionPersistence;
    readonly attestations?: MutationAttestationLedger;
    readonly createGoals?: () => GoalMaxPersistence;
    readonly createQueue?: () => SessionQueuePersistence;
    readonly createTasks?: () => TaskPersistence;
  };
  /** Host constructor seam; must return one existing MultiProjectPiRuntime, not a second engine. */
  readonly createRuntime?: (dependencies: MultiProjectPiRuntimeDeps) => MultiProjectPiRuntime;
  /** Explicit opt-in: the desktop's existing scheduler is NOT adopted or duplicated. */
  readonly savedAgents?: {
    readonly scheduleRoutines: boolean;
    readonly notify?: AgentsHost['notify'];
    readonly legacy?: Pick<LegacyAutomations, 'list'>;
  };
}

function sameHostPath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function assertDefaultSdkPaths(paths: FatePaths): void {
  // Keep desktop bound to its original process-start defaults. Other profiles
  // must use an independent Pi/session/credential namespace; the SDK is passed
  // those roots explicitly and may not inherit the desktop's default stores.
  if (paths.profileKind === 'desktop') {
    if (!sameHostPath(paths.piAgentDir, getAgentDir()) || !sameHostPath(paths.sessionsRoot, path.join(getAgentDir(), 'sessions'))
      || !sameHostPath(paths.dataRoot, fateDataRoot())) throw new Error('Desktop Pi/Fate paths must match the configured process-start defaults.');
  } else if (sameHostPath(paths.piAgentDir, getAgentDir()) || sameHostPath(paths.dataRoot, fateDataRoot())
    || !sameHostPath(paths.sessionsRoot, path.join(paths.piAgentDir, 'sessions'))
    || sameHostPath(paths.sessionsRoot, path.join(getAgentDir(), 'sessions'))) {
    throw new Error('A server profile requires separate Pi, credential and session roots.');
  }
}

/**
 * Genuine Node-only composition; the desktop entry owns one instance.
 * Startup does not open a project, register browser tools without an integration,
 * start a terminal, create a listener, or resume saved work.
 */
export async function createFateCore(options: FateCoreOptions): Promise<FateCore> {
  const paths = new FatePaths(options.paths);
  if (Boolean(options.workspaceRegistration) !== Boolean(options.workspaceMembership)) throw new Error('Workspace registration and membership must be supplied together.');
  const slot = options.instanceSlot ?? 1;
  if (!Number.isSafeInteger(slot) || slot < 1) throw new Error('A positive core instance slot is required.');
  if (!options.adapter) assertDefaultSdkPaths(paths);
  const lockRelative = path.relative(paths.dataRoot, paths.lockRoot);
  if (!lockRelative || (lockRelative !== '..' && !lockRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(lockRelative))) {
    throw new Error('Ownership locks must be outside provider dataRoot.');
  }
  const logs = options.logs ?? new AppLogService();
  const clock = options.clock ?? { now: Date.now };
  const owned: Array<() => void | Promise<void>> = [];
  let profile: OwnerLock | null = null;
  let workspaces: WorkspaceRegistry | null = null;
  let recoveryGate: RecoveryCoordinator | null = null;
  let disposal: Promise<void> | null = null;
  let admissionFenceFailed = false;
  const disposeOwned = (): Promise<void> => {
    return disposal ??= Promise.resolve().then(async () => {
    const failures: unknown[] = [];
    for (const cleanup of [...owned].reverse()) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    // A failed runtime/registry teardown may still own live work. Never release
    // its profile lock merely because later cleanup callbacks ran.
    if (admissionFenceFailed) failures.push(new Error('Core admission fencing was incomplete.'));
    if (failures.length > 0) throw new AggregateError(failures, 'Fate core shutdown was incomplete; profile ownership retained.');
    await profile?.release();
    });
  };

  try {
    // Acquire outside dataRoot before any provider first-run mkdir or writable repository.
    profile = await OwnerLock.acquire(paths.lockRoot, 'profile', await canonicalFuturePath(paths.profileKind === 'server' ? path.dirname(paths.dataRoot) : paths.dataRoot));
    const checkoutOwnership = hostCheckoutOwnership();
    // Preserve the current desktop-compatible first-run policy BEFORE settings or
    // any other writer can create dataRoot. No path constructor pre-creates it.
    // A separate server credential-import policy is deliberately still T26 work.
    await prepareFateProviderStorage({ dataRoot: paths.dataRoot, piAgentDir: paths.piAgentDir, legacyImport: paths.profileKind === 'desktop' });
    const settings = options.settings ?? new SettingsService(logs, paths.dataRoot,
      new PiThemeService({ agentDir: paths.piAgentDir, now: () => clock.now() }), paths.piAgentDir);
    if (!options.settings) owned.push(() => settings.flush());
    const repository = options.persistence?.learning ?? new LearningRepository(paths.dataRoot);
    if (!options.persistence?.learning) owned.push(() => repository.flush());
    const learning = new LearningService(repository, () => settings.get().memoryLearning);
    owned.push(() => learning.dispose());
    const sessionPermissions = options.persistence?.permissions ?? new SessionPermissionStore(logs, paths.dataRoot);
    const attestations = options.persistence?.attestations ?? new MutationAttestationLedger(logs, paths.dataRoot, { instanceSlot: slot });
    if (!options.persistence?.attestations) owned.push(async () => { attestations.dispose(); await attestations.flush(); });
    const projects = new ProjectTrustService(paths.dataRoot);
    let savedAgents: AgentsService | null = null;
    const dependencies: MultiProjectPiRuntimeDeps = {
      adapter: options.adapter ?? createPiSdkAdapter(paths),
      paths,
      checkoutOwnership,
      learning,
      sessionPermissions,
      ...(options.permissionHost ? { permissionHost: options.permissionHost } : {}),
      getImageGenerationSettings: () => settings.get().imageGeneration,
      getDisabledModels: () => settings.get().disabledModels ?? [],
      getAgentWorkspacePolicy: () => settings.get().agentWorkspace,
      createGoalPersistence: options.persistence?.createGoals ?? (() => new GoalMaxRepository(logs, path.join(paths.dataRoot, 'goalmaxxing', 'v1'))),
      createQueuePersistence: options.persistence?.createQueue ?? (() => new SessionQueueRepository(path.join(paths.dataRoot, 'session-queues', 'v1'), slot)),
      ...(options.persistence?.createTasks
        ? { createTaskPersistence: options.persistence.createTasks }
        : paths.profileKind === 'server'
          ? { createTaskPersistence: () => new TaskRepository(logs, path.join(paths.dataRoot, 'tasks', 'v1')) }
          : {}),
      createSessionRepository: () => new PiSessionRepository(undefined, paths.sessionsRoot),
      createModelsDevService: () => new ModelsDevService({ store: new ModelsDevStore(paths.dataRoot), now: () => clock.now(), log: (message) => logs.write('warn', 'models', message) }),
      browserIntegration: options.browserIntegration ?? null,
      monitorRuns: async (projectPath) => {
        if (!savedAgents) throw new Error('Scheduled Agents are unavailable.');
        return savedAgents.monitorRuns(projectPath);
      },
      ...(options.providerAuthUrlPresenter ? { providerAuthUrlPresenter: options.providerAuthUrlPresenter } : {}),
      ...(options.attention ? { notifySessionSettled: () => options.attention!.sessionSettled() } : {}),
      recordAttestation: createMutationRecorder(attestations, logs),
      defaults: async () => {
        const loaded = await settings.load();
        return {
          thinkingLevel: loaded.thinkingLevel,
          defaultModel: enabledModelIdentity(loaded.disabledModels, loaded.defaultModel),
          ...(loaded.agentTeamMode ? { agentTeamMode: loaded.agentTeamMode } : {}),
        };
      },
    };
    const runtime = options.createRuntime ? options.createRuntime(dependencies) : new MultiProjectPiRuntime(dependencies);
    owned.push(() => runtime.dispose());
    const events = new WorkspaceEventHub(runtime.scopedEvents);
    owned.push(() => events.dispose());
    workspaces = options.workspaceRegistration && options.workspaceMembership
      ? new WorkspaceRegistry({ projects, runtime, paths, registration: options.workspaceRegistration, isMember: options.workspaceMembership, checkoutOwnership,
        assertStorageAdmission: (root, sessionId, principalId) => recoveryGate?.assertAdmission(root, sessionId, principalId) }) : null;
    const registry = workspaces;
    if (registry) owned.push(() => registry.dispose());
    await settings.load();
    const coldSessions = new PiSessionRepository(undefined, paths.sessionsRoot);
    const coldTasks = new TaskRepository(logs, path.join(paths.dataRoot, 'tasks', 'v1'));
    const coldGit = paths.profileKind === 'server'
      ? new AgentWorkspaceGitService(path.join(paths.dataRoot, 'agent-team-worktrees'), paths.attachmentRoot)
      : new AgentWorkspaceGitService();
    const coldCommands = new CommandJournal({ root: path.join(paths.dataRoot, 'commands', 'v1'), serverEpoch: randomUUID() });
    const recovery = new RecoveryCoordinator(new LifecycleRepository(path.join(paths.dataRoot, 'lifecycle', 'v1')), {
      readSession: async (projectPath, sessionId) => Boolean(await coldSessions.resolve(projectPath, sessionId)),
      readTeams: (projectPath, sessionId) => coldSessions.readColdTeams(projectPath, sessionId),
      goals: options.persistence?.createGoals?.() ?? new GoalMaxRepository(logs, path.join(paths.dataRoot, 'goalmaxxing', 'v1')),
      queue: options.persistence?.createQueue?.() ?? new SessionQueueRepository(path.join(paths.dataRoot, 'session-queues', 'v1'), slot),
      readTasks: (projectPath, sessionId) => coldTasks.loadHealth(projectPath, sessionId),
      commandStatus: (requestId, workspaceId, principalId) => coldCommands.status(requestId, workspaceId, principalId),
      validateWorktree: async (tree, owner) => { await coldGit.validate(tree.path, tree.parentPath, tree.branch, tree.baseCommit, tree.commonDirectory, owner); },
      teamStorageRoots: agentTeamStorageRoots(path.join(paths.dataRoot, 'agent-teams')),
      resolveReview: (identity, workspaceId, generation, sessionId, control) => {
        const handle = workspaces?.resolve(identity, workspaceId, generation);
        if (control && handle?.admission.assertCurrent(control.command, control.authorize, true).sessionId !== sessionId)
          throw new Error('FORBIDDEN: recovery review control no longer owns the selected session.');
        if (control && control.authorize().principalId !== identity.principalId)
          throw new Error('FORBIDDEN: recovery review principal changed.');
        if (!handle || handle.admission.snapshot().selectedSessionId !== sessionId || handle.admission.pending > 0
          || handle.runtime.hasEvictionBlockingWork() || handle.runtime.getState(false).streaming || handle.runtime.getState(false).activeSessionRunning)
          throw new Error('FORBIDDEN: recovery review requires a current idle trusted workspace/session.');
        return { projectPath: handle.root, principalId: identity.principalId };
      },
    });
    const recovered = await recovery.recover();
    recoveryGate = recovery;
    if (!recovered.admissionsAllowed) logs.write('warn', 'recovery', recovered.notice ?? 'Uncertain lifecycle records need review before new admissions.');
    const stopRecovery = runtime.scopedEvents.subscribe((event) => {
      const root = workspaces?.hostRootForOrigin(event.origin.workspaceId, event.origin.workspaceGeneration);
      if (root) recovery.observe(event, root);
    });
    owned.push(async () => { stopRecovery(); await recovery.flush(); });
    if (options.savedAgents) {
      const agents = new AgentsService({
        runtime: runtime.asRouter(),
        workspacePolicy: () => settings.get().agentWorkspace,
        disabledModels: () => settings.get().disabledModels ?? [],
        readMonitorDashboard: async (projectPath, rootSessionId, query) => {
          const owner = runtime.peekWorkspace(projectPath);
          if (!owner) throw new Error('The owning project runtime is not available.');
          return owner.getMonitorDashboard(query, rootSessionId);
        },
        sessionsRoot: paths.sessionsRoot,
        piAgentDir: paths.piAgentDir,
        serverProfile: paths.profileKind === 'server',
        assertAdmission: (root, sessionId) => recovery.assertAdmission(root, sessionId),
        ...(options.savedAgents.notify ? { notify: options.savedAgents.notify } : {}),
      }, new AgentRepository(path.join(paths.dataRoot, 'agents', 'v1')), options.savedAgents.legacy);
      owned.push(() => agents.dispose());
      if (options.savedAgents.scheduleRoutines && recovered.admissionsAllowed) agents.start();
      savedAgents = agents;
    }
    const lifecycle = new CoreLifecycle({
      ...(options.shutdownBudgetMs === undefined ? {} : { shutdownBudgetMs: options.shutdownBudgetMs }),
      beginShutdown: () => {
        const failures: unknown[] = [];
        for (const fence of [() => runtime.beginShutdown(), () => workspaces?.sealForHostShutdown(),
          () => savedAgents?.beginShutdown()]) {
          try { fence(); } catch (error) { failures.push(error); }
        }
        if (failures.length) {
          admissionFenceFailed = true;
          throw new AggregateError(failures, 'Core shutdown admission fencing was incomplete.');
        }
      },
      shutdown: disposeOwned,
    });
    const dispose = (): Promise<void> => {
      lifecycle.shutdownCore();
      return lifecycle.settled()!;
    };
    return { paths, recovery, recovered, logs, settings, projects, learning, sessionPermissions, attestations, runtime, events,
      workspaces, savedAgents, lifecycle, createClient: (resources?: CoreClientResources) => lifecycle.createClient(resources),
      disposeClient: (client) => lifecycle.disposeClient(client), shutdownCore: () => lifecycle.shutdownCore(), dispose };
  } catch (error) {
    try { await disposeOwned(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Fate core startup failed and cleanup was incomplete.'); }
    throw error;
  }
}
