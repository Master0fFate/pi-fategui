import type { PermissionHostPolicy } from '../../core/security/PermissionPolicy';
import type { NativeWorkflowSchedulerFactory } from './durable/NativeWorkflowScheduler';
import type { LearningService } from '../learning/LearningService';
import type { GoalMaxEvent } from '../../shared/contracts/goalmaxxing';
import type { PiEvent, ProjectState, RuntimeState, SessionSummary } from '../../shared/contracts/ipc';
import type { AgentWorkspacePolicy } from '../../shared/contracts/multiAgent';
import type { TaskEvent } from '../../shared/contracts/tasks';
import type { MonitorRunsSource } from './monitor/MonitorDashboard';
import type { PiBrowserRuntimeIntegration } from './BrowserRuntimeBridge';
import type { GoalMaxPersistence } from './goalmaxxing/GoalMaxRepository';
import type { ImageGenerationSettingsResolver } from './PiImageTool';
import { MultiProjectRuntimeManager } from './MultiProjectRuntimeManager';
import { createDefaultModelRuntime, PiRuntimeService, type ModelRuntimeProvider, type PiSdkAdapter, type SessionDefaults } from './PiRuntimeService';
import type { FatePaths } from '../../core/FatePaths';
import type { MutationRecorder } from './provenance/mutationRecorder';
import type { SessionPermissionPersistence } from './SessionPermissionStore';
import type { SessionQueuePersistence } from './SessionQueueRepository';
import type { PiSessionRepository } from './PiSessionRepository';
import type { SessionTitleGenerator } from './PiSessionTitleGenerator';
import type { ModelsDevService } from './modelsdev/ModelsDevService';
import type { TaskPersistence } from './tasks/TaskRepository';
import type { ProviderAuthUrlPort } from '../../core/ports';
import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { assertPrivateWindowsAcl, withPrivateWindowsAclScope } from '../../core/storage/WindowsPrivateAcl';
import { ScopedDomainEvents, type EventOrigin } from '../../core/events/ScopedDomainEvents';
import { hostCheckoutOwnership, type CheckoutOwnership } from '../../core/ownership/CheckoutOwnership';
import type { OwnerLock } from '../../core/ownership/OwnerLock';
import { PiDesktopError } from './errors';

const noopEventSink = (_events: PiEvent[]) => undefined;
const noopGoalSink = (_event: GoalMaxEvent) => undefined;
const noopTaskSink = (_event: TaskEvent) => undefined;
const workspaceIdentitySchema = z.object({ version: z.literal(1), workspaceId: z.string().uuid(),
  rootKey: z.string().regex(/^[a-f0-9]{64}$/u), device: z.string().max(100), inode: z.string().max(100) }).strict();
async function syncIdentityDirectory(directory: string): Promise<void> {
  try { const handle = await fs.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
  catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
}
/** A private host-owned random identity for the same physical registered checkout.
 * No pathname/dictionary-searchable digest crosses the protocol. No SDK or trust decision is made here. */
async function durableWorkspaceIdentity(paths: FatePaths, projectPath: string): Promise<string> {
  // One finite lookup shares one ACL helper process; both checks stay live.
  try { return await withPrivateWindowsAclScope(() => readWorkspaceIdentity(paths, projectPath)); }
  catch { throw new Error('Workspace identity storage is unavailable.'); }
}
async function readWorkspaceIdentity(paths: FatePaths, projectPath: string): Promise<string> {
  try {
    const canonical = await fs.realpath(projectPath);
    const physical = await fs.stat(canonical);
    if (!physical.isDirectory()) throw new Error('Invalid root');
    const rootKey = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex');
    const root = path.join(path.dirname(paths.dataRoot), 'workspace-identities');
    try { await fs.mkdir(root, { mode: 0o700 }); await syncIdentityDirectory(path.dirname(root)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const privateRoot = await fs.lstat(root);
    if (!privateRoot.isDirectory() || privateRoot.isSymbolicLink() || process.platform !== 'win32' && (privateRoot.mode & 0o077) !== 0) throw new Error('Invalid private root');
    await assertPrivateWindowsAcl(root);
    const target = path.join(root, `${rootKey}.json`);
    try {
      const data = workspaceIdentitySchema.parse({ version: 1, workspaceId: randomUUID(), rootKey,
        device: String(physical.dev), inode: String(physical.ino) });
      const output = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await output.writeFile(JSON.stringify(data), 'utf8'); await output.sync(); } finally { await output.close(); }
      await syncIdentityDirectory(root);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const before = await fs.lstat(target);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 2048
      || process.platform !== 'win32' && (before.mode & 0o077) !== 0) throw new Error('Invalid identity');
    await assertPrivateWindowsAcl(target);
    const input = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const live = await input.stat();
      if (!live.isFile() || live.nlink !== 1 || live.dev !== before.dev || live.ino !== before.ino || live.size > 2048) throw new Error('Invalid identity');
      const bytes = Buffer.alloc(2049); const { bytesRead } = await input.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 2048) throw new Error('Invalid identity');
      const saved = workspaceIdentitySchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))) as unknown);
      const current = await fs.stat(canonical);
      if (saved.rootKey !== rootKey || saved.device !== String(current.dev) || saved.inode !== String(current.ino)
        || current.dev !== physical.dev || current.ino !== physical.ino) throw new Error('Checkout identity changed');
      return saved.workspaceId;
    } finally { await input.close(); }
  } catch { throw new Error('Workspace identity storage is unavailable.'); }
}

export function backgroundAttentionUpdate(events: readonly PiEvent[]): SessionSummary['attention'] | null | undefined {
  let update: SessionSummary['attention'] | null | undefined;
  for (const event of events) {
    if (event.type === 'run.started') update = 'running';
    else if (event.type === 'error') update = 'error';
    else if (event.type === 'run.completed') update = event.aborted ? null : 'completed';
  }
  return update;
}

/**
 * Multi-folder runtime owner for Fate UI. Holds one {@link PiRuntimeService}
 * per open project, keeps background folders' agents running while you work in
 * another folder, evicts idle folders, and presents a single router that
 * quacks like a `PiRuntimeService` so the rest of the app (IPC, terminal,
 * browser bridge) is unchanged.
 *
 * The "focused" service is the one the renderer sees (state + events). Other
 * live services keep streaming silently — their events are dropped here and
 * their progress surfaces via the on-disk session listing.
 */
export interface MultiProjectPiRuntimeDeps {
  /** Profile-owned native scheduling for new DAGs; restored native graphs never fall back. */
  nativeWorkflowSchedulerFactory?: NativeWorkflowSchedulerFactory;
  requireFreshExecutionIntent?: boolean;
  adapter?: PiSdkAdapter;
  paths?: FatePaths;
  /** Same process-wide host namespace used by desktop Git and Team. */
  checkoutOwnership?: CheckoutOwnership;
  learning?: LearningService;
  sessionPermissions: SessionPermissionPersistence;
  /** Immutable host-owned maximum, shared by focused and background runtimes. */
  permissionHost?: PermissionHostPolicy;
  getImageGenerationSettings: ImageGenerationSettingsResolver;
  createGoalPersistence: () => GoalMaxPersistence;
  createQueuePersistence?: () => SessionQueuePersistence;
  createSessionRepository?: () => PiSessionRepository;
  createSessionTitleGenerator?: () => SessionTitleGenerator;
  createModelsDevService?: () => ModelsDevService;
  createTaskPersistence?: () => TaskPersistence;
  providerAuthUrlPresenter?: ProviderAuthUrlPort;
  browserIntegration: PiBrowserRuntimeIntegration | null;
  monitorRuns?: (projectPath: string) => Promise<MonitorRunsSource>;
  defaults: () => Promise<SessionDefaults>;
  getDisabledModels?: () => readonly string[];
  /** Live global policy used by all focused and background Agent Team runtimes. */
  getAgentWorkspacePolicy?: () => AgentWorkspacePolicy;
  /** Optional mutation-attestation recorder threaded to root and child confined tools. */
  recordAttestation?: MutationRecorder;
  /** Native taskbar/Dock attention when any root session settles. */
  notifySessionSettled?: () => void;
}

export class MultiProjectPiRuntime {
  private readonly manager: MultiProjectRuntimeManager<PiRuntimeService>;
  /** Never opened; provides a disconnected state before any project is focused. */
  private readonly bootService: PiRuntimeService;
  private readonly router: PiRuntimeService;
  private rendererSink: (events: PiEvent[]) => void = noopEventSink;
  private goalSink: (event: GoalMaxEvent) => void = noopGoalSink;
  private taskSink: (event: TaskEvent) => void = noopTaskSink;
  private sharedModelRuntime: Promise<Awaited<ReturnType<PiSdkAdapter['createModelRuntime']>>> | null = null;
  private readonly requestedDefaultsByPath = new Map<string, SessionDefaults>();
  /** In-flight startup paths; never mistake one concurrent workspace for another. */
  private readonly pendingOpenPaths = new Set<string>();
  private readonly attentionByProject = new Map<string, Map<string, NonNullable<SessionSummary['attention']>>>();
  private readonly origins = new Map<string, { workspaceId: string; workspaceGeneration: number }>();
  /** Independent of the registry's late-created admission queue. Never reset on an A→B→A switch. */
  private readonly selectionHistory = new Map<string, { selected: string | null; revision: number }>();
  private readonly serviceOrigins = new WeakMap<PiRuntimeService, { workspaceId: string; workspaceGeneration: number }>();
  private readonly admissionGuards = new Map<string, () => boolean>();
  private readonly lifecycleHooks = new Map<string, { beforeDispose(service: PiRuntimeService): void; onEvicted(): void }>();
  private readonly checkoutOwners = new Map<string, OwnerLock>();
  private readonly servicePaths = new WeakMap<PiRuntimeService, string>();
  private readonly checkoutOwnership: CheckoutOwnership | null;
  private stopping = false;
  readonly scopedEvents = new ScopedDomainEvents();

  constructor(private readonly deps: MultiProjectPiRuntimeDeps) {
    this.checkoutOwnership = deps.checkoutOwnership ?? (deps.paths ? hostCheckoutOwnership() : null);
    this.bootService = this.createService();
    this.manager = new MultiProjectRuntimeManager<PiRuntimeService>(
      {
        createRuntime: async (project) => {
          // The legacy desktop open/focus route and the scoped registry converge
          // here. Ownership is acquired before a writable Pi service is opened.
          const checkout = project.trusted ? await this.checkoutOwnership?.checkout(project.path) : undefined;
          if (checkout) this.checkoutOwners.set(project.path, checkout);
          let settled = true;
          try {
          const prior = this.origins.get(project.path);
          this.origins.set(project.path, { workspaceId: prior?.workspaceId ?? (this.deps.paths?.profileKind === 'server'
            ? await durableWorkspaceIdentity(this.deps.paths, project.path) : randomUUID()), workspaceGeneration: (prior?.workspaceGeneration ?? 0) + 1 });
          const service = this.createService();
          settled = false;
          this.servicePaths.set(service, project.path);
          this.serviceOrigins.set(service, this.origins.get(project.path)!);
          if (!this.selectionHistory.has(project.path)) this.selectionHistory.set(project.path, { selected: null, revision: 0 });
          service.subscribeSelection((selected) => {
            const history = this.selectionHistory.get(project.path);
            if (history && history.selected !== selected) {
              history.selected = selected;
              history.revision += 1;
            }
          });
          // Wire the service before opening it. Initialization emits the first
          // project/runtime state, and startup has no IPC response to deliver
          // that state to the renderer.
          this.pendingOpenPaths.add(project.path);
          this.wireService(project.path, service);
          try {
            await service.openProject(project, this.requestedDefaultsByPath.get(project.path) ?? await this.deps.defaults());
            if (this.stopping) service.beginHostShutdown();
            return service;
          } catch (error) {
            try { await service.dispose(); settled = true; } catch (cleanup) { throw new AggregateError([error, cleanup], 'Project startup and cleanup failed; checkout ownership retained.'); }
            throw error;
          } finally {
            this.pendingOpenPaths.delete(project.path);
          }
          } catch (error) {
            if (checkout && settled) {
              try { await checkout.release(); this.checkoutOwners.delete(project.path); }
              catch (releaseError) { throw new AggregateError([error, releaseError], 'Project startup failed; checkout lock release failed.'); }
            }
            throw error;
          }
        },
        disposeRuntime: async (service) => {
          const projectPath = service.getState(false).project?.path;
          const lifecycle = projectPath ? this.lifecycleHooks.get(projectPath) : undefined;
          lifecycle?.beforeDispose(service);
          if (projectPath) {
            try { this.rememberAttention(projectPath, this.mergeRememberedAttention(projectPath, await service.listSessions())); } catch { /* Disposal must still release the runtime. */ }
          }
          await service.dispose();
          const ownerPath = this.servicePaths.get(service);
          const checkout = ownerPath ? this.checkoutOwners.get(ownerPath) : undefined;
          if (checkout) {
            await checkout.release();
            this.checkoutOwners.delete(ownerPath!);
          }
        },
        isBusy: (service) => {
          if (service.hasEvictionBlockingWork()) return true;
          const projectPath = service.getState(false).project?.path;
          return projectPath ? this.admissionGuards.get(projectPath)?.() === true : false;
        },
        onFocused: (service, projectPath) => {
          this.deps.browserIntegration?.setFocusedProjectPath?.(projectPath);
          if (service && projectPath) {
            const sessionId = service.getState(false).sessionId;
            if (sessionId) {
              this.attentionByProject.get(projectPath)?.delete(sessionId);
              this.deps.browserIntegration?.setActiveRoot({ projectPath, sessionId });
            }
          } else {
            this.deps.browserIntegration?.setActiveRoot(null);
          }
          this.rewireSinks();
        },
        onEvicted: (projectPath) => {
          this.lifecycleHooks.get(projectPath)?.onEvicted();
          this.rewireSinks();
        },
      },
      // Idle unfocused folders are evicted after the coordinator grace period.
      // Busy folders stay live. The concurrency cap still reclaims the oldest
      // idle slot when too many folders are open at once.
      { evictionEnabled: true },
    );
    this.manager.start();
    this.router = this.buildRouter();
  }

  /** The service the renderer currently sees (focused, or a disconnected boot service). */
  getFocused(): PiRuntimeService {
    return this.manager.getFocused() ?? this.bootService;
  }

  /** One stable host login service, sharing the existing SDK model runtime. */
  hostProviderLoginService(): PiRuntimeService { return this.bootService; }

  /** Includes unfocused work, descendants, runnable goals, and pending admissions. */
  hasHostActiveWork(): boolean {
    if (this.stopping || this.pendingOpenPaths.size > 0 || this.bootService.hasEvictionBlockingWork()) return true;
    let busy = false;
    this.manager.forEach((root, service) => {
      if (service.hasEvictionBlockingWork() || this.admissionGuards.get(root)?.() === true) busy = true;
    });
    return busy;
  }

  get focusedProjectPath(): string | null {
    return this.manager.focusedProjectPath;
  }

  /**
   * Open (or re-focus) a project, keeping every other live folder running.
   * The `defaults` argument is accepted for signature compatibility and
   * intentionally ignored — defaults come from settings via `deps.defaults()`,
   * the same source the caller used, so behavior is identical.
   */
  async openProject(project: ProjectState, defaults?: SessionDefaults): Promise<RuntimeState> {
    if (this.stopping) throw new Error('The core is shutting down; project admission is closed.');
    // Fast path: if this folder already has a live runtime, re-focus it
    // directly and return its current state. This skips the boot-service
    // "empty preview" flash and the disk-session reload, so switching back to
    // a folder whose agent is already running is instant and never blanks the
    // session list the user was looking at.
    if (this.manager.focus(project.path)) {
      return this.getFocused().getState();
    }
    if (defaults) this.requestedDefaultsByPath.set(project.path, defaults);
    // Focus a lightweight preview immediately. This removes the long blank
    // interval while Pi loads extensions, tools, and model providers.
    this.manager.focusPreview(project);
    this.bootService.setProjectPreview(project, [], true);
    const preview = this.bootService.listSessionsForPath(project.path).catch(() => []);
    try {
      const { state } = await this.manager.openProject(project, (service) => service.getState());
      return state;
    } finally {
      this.requestedDefaultsByPath.delete(project.path);
      const sessions = await preview;
      if (this.manager.focusedProjectPath === project.path && this.getFocused() === this.bootService) {
        this.bootService.setProjectPreview(project, sessions, true);
      }
    }
  }

  /** Host-validated registration; ordinary clients cannot supply ProjectState. */
  registerKnownWorkspace(project: ProjectState): void {
    if (this.stopping) throw new Error('The core is shutting down; project admission is closed.');
    this.manager.registerKnownProject(project);
  }

  /** Host admission keeps a workspace pinned during queued or running commands. */
  setWorkspaceAdmissionGuard(projectPath: string, guard: (() => boolean) | null): void {
    if (guard) this.admissionGuards.set(projectPath, guard);
    else this.admissionGuards.delete(projectPath);
  }

  /** One synchronous close fence shared by explicit close, idle eviction and replacement. */
  setWorkspaceLifecycleHooks(projectPath: string,
    hooks: { beforeDispose(service: PiRuntimeService): void; onEvicted(): void } | null): void {
    if (hooks) this.lifecycleHooks.set(projectPath, hooks);
    else this.lifecycleHooks.delete(projectPath);
  }

  /** Stable host ID, incremented generation on every runtime replacement. */
  workspaceOrigin(projectPath: string): { workspaceId: string; workspaceGeneration: number } | null {
    return this.origins.get(projectPath) ?? null;
  }

  /** Synchronous host-owned revision, installed before the first project startup await. */
  workspaceSelectionRevision(projectPath: string): number | null {
    return this.selectionHistory.get(projectPath)?.revision ?? null;
  }

  /** Inspect a live runtime without acquiring, focusing, or creating it. */
  peekWorkspace(projectPath: string): PiRuntimeService | null {
    return this.manager.get(projectPath);
  }

  /** Returns a project runtime without changing desktop selection or using the router. */
  async acquireWorkspace(projectPath: string): Promise<PiRuntimeService> {
    if (this.stopping) throw new Error('The core is shutting down; project admission is closed.');
    const { runtime, state } = await this.manager.acquireKnownProject(projectPath, (service) => service.getState(false));
    if (state.status === 'error' || state.project?.path !== projectPath || !state.project.trusted) {
      throw new Error('The registered workspace runtime is not ready.');
    }
    return runtime;
  }

  /** Re-focus an already-live project without recreating it. */
  focus(projectPath: string): boolean {
    return this.manager.focus(projectPath);
  }

  async focusProject(project: ProjectState): Promise<RuntimeState> {
    if (this.stopping) throw new Error('The core is shutting down; project admission is closed.');
    // A live runtime is re-focused instantly without recreation.
    if (this.manager.focus(project.path)) return this.getFocused().getState();
    // No live runtime: show a lightweight preview (session titles read from
    // disk) WITHOUT spawning a Pi agent. The agent spawns lazily when the user
    // opens a session in this folder. This keeps folder browsing cheap and
    // matches the multi-folder design: titles always, agents on demand, idle
    // agents evicted after the grace period.
    this.manager.focusPreview(project);
    const sessions = await this.bootService.listSessionsForPath(project.path).catch(() => []);
    return this.bootService.setProjectPreview(project, sessions);
  }

  async closeProject(): Promise<RuntimeState> {
    await this.manager.closeFocused();
    return this.bootService.setProjectPreview(null, [], true);
  }

  async closeProjectPath(projectPath: string): Promise<void> {
    if (this.admissionGuards.get(projectPath)?.()) throw new Error('Workspace admission is active.');
    await this.manager.close(projectPath);
    this.attentionByProject.delete(projectPath);
  }

  async deleteSessionsForPath(projectPath: string): Promise<{ deleted: number; skipped: number }> {
    const live = this.manager.get(projectPath);
    const result = await (live ?? this.getFocused()).deleteSessionsForPath(projectPath);
    this.attentionByProject.delete(projectPath);
    return result;
  }

  async listSessionsForPath(projectPath: string, query = ''): Promise<SessionSummary[]> {
    const live = this.manager.get(projectPath);
    if (live && live.getState(false).project?.path === projectPath) {
      const state = live.getState(false);
      // Prefer the runtime's own session list (which merges live attention
      // dots: running / completed / error) so background folders keep their
      // colored status dots. Fall back to a disk-only listing only when the
      // runtime has no selected slot to project from.
      let sessions: SessionSummary[];
      if (state.status !== 'disconnected' && state.status !== 'error') {
        const liveSessions = await live.listSessions(query);
        sessions = liveSessions.length > 0 ? liveSessions : await live.listSessionsForPath(projectPath, query);
      } else {
        sessions = await live.listSessionsForPath(projectPath, query);
      }
      const remembered = this.attentionByProject.get(projectPath);
      const selectedId = state.sessionId;
      const merged = this.manager.focusedProjectPath !== projectPath && selectedId && remembered?.has(selectedId)
        ? sessions.map((session) => session.id === selectedId && !session.attention ? { ...session, attention: remembered.get(selectedId)! } : session)
        : sessions;
      this.rememberAttention(projectPath, merged);
      return merged;
    }
    return this.mergeRememberedAttention(projectPath, await this.getFocused().listSessionsForPath(projectPath, query));
  }

  private mergeRememberedAttention(projectPath: string, sessions: readonly SessionSummary[]): SessionSummary[] {
    const remembered = this.attentionByProject.get(projectPath);
    return remembered
      ? sessions.map((session) => !session.attention && remembered.has(session.id) ? { ...session, attention: remembered.get(session.id)! } : session)
      : [...sessions];
  }

  private observeBackgroundAttention(projectPath: string, service: PiRuntimeService, events: readonly PiEvent[]): void {
    if (this.manager.focusedProjectPath === projectPath) return;
    const sessionId = service.getState(false).sessionId;
    if (!sessionId) return;
    const remembered = this.attentionByProject.get(projectPath) ?? new Map<string, NonNullable<SessionSummary['attention']>>();
    const update = backgroundAttentionUpdate(events);
    if (update === null) remembered.delete(sessionId);
    else if (update) remembered.set(sessionId, update);
    if (remembered.size > 0) this.attentionByProject.set(projectPath, remembered);
    else this.attentionByProject.delete(projectPath);
  }

  private rememberAttention(projectPath: string, sessions: readonly SessionSummary[]): void {
    const remembered = this.attentionByProject.get(projectPath) ?? new Map<string, NonNullable<SessionSummary['attention']>>();
    for (const session of sessions) {
      if (session.attention) remembered.set(session.id, session.attention);
      else remembered.delete(session.id);
    }
    if (remembered.size > 0) this.attentionByProject.set(projectPath, remembered);
    else this.attentionByProject.delete(projectPath);
  }

  setEventSink(sink: (events: PiEvent[]) => void): void {
    this.rendererSink = sink;
    this.bootService.setEventSink(sink);
    this.rewireSinks();
  }

  setGoalEventSink(sink: (event: GoalMaxEvent) => void): void {
    this.goalSink = sink;
    this.rewireSinks();
  }

  setTaskEventSink(sink: (event: TaskEvent) => void): void {
    this.taskSink = sink;
    this.bootService.setTaskEventSink(sink);
    this.rewireSinks();
  }

  /** A drop-in `PiRuntimeService` that routes to the focused project (or boot service). */
  asRouter(): PiRuntimeService {
    return this.router;
  }

  /** Registry verifies that its runtime already holds this canonical checkout. */
  ownsCheckout(projectPath: string): boolean {
    return this.checkoutOwners.has(projectPath);
  }

  /** Host-only synchronous fence for new projects, prompts, and automatic continuations. */
  beginShutdown(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.manager.beginShutdown();
    this.bootService.beginHostShutdown();
    this.manager.forEach((_path, service) => service.beginHostShutdown());
  }

  async dispose(): Promise<void> {
    this.beginShutdown();
    const failures: unknown[] = [];
    try { await this.manager.stop(); } catch (error) { failures.push(error); }
    try { await this.bootService.dispose(); } catch (error) { failures.push(error); }
    if (this.checkoutOwners.size > 0) failures.push(new Error('Checkout startup or shutdown remains uncertain; ownership retained for operator review.'));
    if (failures.length) throw new AggregateError(failures, 'Multi-project runtime shutdown was incomplete.');
  }

  private createService(): PiRuntimeService {
    const modelRuntimeProvider: ModelRuntimeProvider = async () => {
      if (!this.sharedModelRuntime) {
        this.sharedModelRuntime = this.deps.adapter ? this.deps.adapter.createModelRuntime() : createDefaultModelRuntime(this.deps.paths);
        this.sharedModelRuntime = this.sharedModelRuntime.catch((error) => {
          this.sharedModelRuntime = null;
          throw error;
        });
      }
      return this.sharedModelRuntime!;
    };
    const service = new PiRuntimeService(
      this.deps.adapter,
      this.deps.createSessionRepository?.(),
      this.deps.sessionPermissions,
      this.deps.createSessionTitleGenerator?.(),
      this.deps.getImageGenerationSettings,
      this.deps.createGoalPersistence(),
      this.deps.browserIntegration,
      modelRuntimeProvider,
      this.deps.recordAttestation ?? null,
      this.deps.createTaskPersistence?.(),
      undefined,
      this.deps.createModelsDevService?.(),
      this.deps.createQueuePersistence?.(),
      this.deps.permissionHost,
      this.deps.providerAuthUrlPresenter,
      this.deps.paths,
      this.deps.nativeWorkflowSchedulerFactory,
      this.deps.requireFreshExecutionIntent,
    );
    service.setExecutionAdmissionGuard(() => {
      if (this.stopping) throw new Error('The runtime host is stopping; all retained execution admission is closed.');
      if (this.bootService?.hasProviderLoginOwnership()) throw new PiDesktopError({ code: 'RUN_ACTIVE',
        message: 'Wait for host provider login to settle before starting Pi work.', retryable: true });
    });
    service.setModelCatalogListener((models) => {
      if (this.bootService && this.bootService !== service) {
        this.bootService.synchronizeModelCatalog(models, this.getFocused() === this.bootService && this.pendingOpenPaths.size === 0);
      }
      this.manager?.forEach((_path, other) => {
        if (other !== service) other.synchronizeModelCatalog(models);
      });
    });
    if (this.deps.learning) service.setLearningService(this.deps.learning);
    if (this.deps.monitorRuns) service.setMonitorRunsSource(this.deps.monitorRuns);
    service.setSessionSettledListener(() => this.deps.notifySessionSettled?.());
    if (this.deps.getDisabledModels) service.setDisabledModelsSource(this.deps.getDisabledModels);
    if (this.deps.getAgentWorkspacePolicy) service.setAgentWorkspacePolicySource(this.deps.getAgentWorkspacePolicy);
    return service;
  }

  private wireService(path: string, service: PiRuntimeService): void {
    const serviceOrigin = this.serviceOrigins.get(service);
    const originFor = (sessionId: string | null): EventOrigin | null => serviceOrigin ? { ...serviceOrigin, sessionId } : null;
    service.setScopedPiSink((event, sessionId) => {
      const origin = originFor(sessionId);
      if (origin) this.scopedEvents.publish({ kind: 'pi', origin, event });
    });
    service.setEventSink((events) => {
      this.manager.touch(path);
      if (this.manager.focusedProjectPath === path) {
        const sessionId = service.getState(false).sessionId;
        if (sessionId) this.attentionByProject.get(path)?.delete(sessionId);
        this.rendererSink(events);
      } else {
        this.observeBackgroundAttention(path, service, events);
      }
    });
    service.setGoalEventSink((event) => {
      this.manager.touch(path);
      const origin = originFor(event.sessionId);
      if (origin) this.scopedEvents.publish({ kind: 'goal', origin, event });
      if (this.manager.focusedProjectPath === path) this.goalSink(event);
    });
    service.setTaskEventSink((event) => {
      this.manager.touch(path);
      const origin = originFor(event.sessionId);
      if (origin) this.scopedEvents.publish({ kind: 'task', origin, event });
      if (this.manager.focusedProjectPath === path) this.taskSink(event);
    });
  }

  private rewireSinks(): void {
    this.manager.forEach((path, service) => this.wireService(path, service));
  }

  private buildRouter(): PiRuntimeService {
    const self = this;
    return new Proxy({} as PiRuntimeService, {
      get(_target, prop: string | symbol) {
        switch (prop) {
          case 'openProject': return (project: ProjectState, defaults?: SessionDefaults) => self.openProject(project, defaults);
          case 'focusProject': return (project: ProjectState) => self.focusProject(project);
          case 'closeProject': return () => self.closeProject();
          case 'closeProjectPath': return (projectPath: string) => self.closeProjectPath(projectPath);
          case 'listSessionsForPath': return (projectPath: string, query?: string) => self.listSessionsForPath(projectPath, query);
          case 'deleteSessionsForPath': return (projectPath: string) => self.deleteSessionsForPath(projectPath);
          case 'switchSession': return async (sessionId: string) => {
            const state = await self.getFocused().switchSession(sessionId);
            if (state.project?.path && state.sessionId) self.attentionByProject.get(state.project.path)?.delete(state.sessionId);
            return state;
          };
          case 'setEventSink': return (sink: (events: PiEvent[]) => void) => self.setEventSink(sink);
          case 'setGoalEventSink': return (sink: (event: GoalMaxEvent) => void) => self.setGoalEventSink(sink);
          case 'setTaskEventSink': return (sink: (event: TaskEvent) => void) => self.setTaskEventSink(sink);
          case 'dispose': return () => self.dispose();
          default: break;
        }
        const target = self.getFocused();
        const value = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as unknown as PiRuntimeService;
  }
}
