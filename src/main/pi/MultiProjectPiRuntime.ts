import type { GoalMaxEvent } from '../../shared/contracts/goalmaxxing';
import type { PiEvent, ProjectState, RuntimeState, SessionSummary } from '../../shared/contracts/ipc';
import type { TaskEvent } from '../../shared/contracts/tasks';
import type { PiBrowserRuntimeIntegration } from './BrowserRuntimeBridge';
import type { GoalMaxPersistence } from './goalmaxxing/GoalMaxRepository';
import type { ImageGenerationSettingsResolver } from './PiImageTool';
import { MultiProjectRuntimeManager } from './MultiProjectRuntimeManager';
import { createDefaultModelRuntime, PiRuntimeService, type ModelRuntimeProvider, type PiSdkAdapter, type SessionDefaults } from './PiRuntimeService';
import type { MutationRecorder } from './provenance/mutationRecorder';
import type { SessionPermissionPersistence } from './SessionPermissionStore';

const noopEventSink = (_events: PiEvent[]) => undefined;
const noopGoalSink = (_event: GoalMaxEvent) => undefined;
const noopTaskSink = (_event: TaskEvent) => undefined;

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
  adapter?: PiSdkAdapter;
  sessionPermissions: SessionPermissionPersistence;
  getImageGenerationSettings: ImageGenerationSettingsResolver;
  createGoalPersistence: () => GoalMaxPersistence;
  browserIntegration: PiBrowserRuntimeIntegration | null;
  defaults: () => Promise<SessionDefaults>;
  /** Optional mutation-attestation recorder threaded to root and child confined tools. */
  recordAttestation?: MutationRecorder;
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
  private requestedDefaults: SessionDefaults | undefined;
  /** The runtime currently initializing before the coordinator can focus it. */
  private pendingOpenPath: string | null = null;
  private readonly attentionByProject = new Map<string, Map<string, NonNullable<SessionSummary['attention']>>>();

  constructor(private readonly deps: MultiProjectPiRuntimeDeps) {
    this.bootService = this.createService();
    this.manager = new MultiProjectRuntimeManager<PiRuntimeService>(
      {
        createRuntime: async (project) => {
          const service = this.createService();
          // Wire the service before opening it. Initialization emits the first
          // project/runtime state, and startup has no IPC response to deliver
          // that state to the renderer.
          this.pendingOpenPath = project.path;
          this.wireService(project.path, service);
          try {
            await service.openProject(project, this.requestedDefaults ?? await this.deps.defaults());
          } finally {
            if (this.pendingOpenPath === project.path) this.pendingOpenPath = null;
          }
          return service;
        },
        disposeRuntime: async (service) => {
          const projectPath = service.getState(false).project?.path;
          if (projectPath) {
            try { this.rememberAttention(projectPath, this.mergeRememberedAttention(projectPath, await service.listSessions())); } catch { /* Disposal must still release the runtime. */ }
          }
          await service.dispose();
        },
        isBusy: (service) => {
          const state = service.getState(false);
          return state.streaming || (state.activeSessionRunning ?? false) || (state.runningSessionCount ?? 0) > 0;
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
        onEvicted: () => this.rewireSinks(),
      },
      // Keep every folder's agent alive (no idle eviction). Correctness and
      // instant folder switching come first; the hard concurrency cap still
      // reclaims the oldest idle slot when too many folders are open at once.
      // Re-enable idle eviction later once multi-folder is stable and tuned.
      { evictionEnabled: false },
    );
    this.manager.start();
    this.router = this.buildRouter();
  }

  /** The service the renderer currently sees (focused, or a disconnected boot service). */
  getFocused(): PiRuntimeService {
    return this.manager.getFocused() ?? this.bootService;
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
    this.requestedDefaults = defaults;
    // Fast path: if this folder already has a live runtime, re-focus it
    // directly and return its current state. This skips the boot-service
    // "empty preview" flash and the disk-session reload, so switching back to
    // a folder whose agent is already running is instant and never blanks the
    // session list the user was looking at.
    if (this.manager.focus(project.path)) {
      return this.getFocused().getState();
    }
    // Focus a lightweight preview immediately. This removes the long blank
    // interval while Pi loads extensions, tools, and model providers.
    this.manager.focusPreview(project);
    this.bootService.setProjectPreview(project, [], true);
    const preview = this.bootService.listSessionsForPath(project.path).catch(() => []);
    try {
      const { state } = await this.manager.openProject(project, (service) => service.getState());
      return state;
    } finally {
      this.requestedDefaults = undefined;
      const sessions = await preview;
      if (this.manager.focusedProjectPath === project.path && this.getFocused() === this.bootService) {
        this.bootService.setProjectPreview(project, sessions, true);
      }
    }
  }

  /** Re-focus an already-live project without recreating it. */
  focus(projectPath: string): boolean {
    return this.manager.focus(projectPath);
  }

  async focusProject(project: ProjectState): Promise<RuntimeState> {
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

  async dispose(): Promise<void> {
    await this.manager.stop();
    await this.bootService.dispose();
  }

  private createService(): PiRuntimeService {
    const modelRuntimeProvider: ModelRuntimeProvider = async () => {
      if (!this.sharedModelRuntime) {
        this.sharedModelRuntime = (this.deps.adapter?.createModelRuntime ?? createDefaultModelRuntime)();
        this.sharedModelRuntime = this.sharedModelRuntime.catch((error) => {
          this.sharedModelRuntime = null;
          throw error;
        });
      }
      return this.sharedModelRuntime!;
    };
    return new PiRuntimeService(
      this.deps.adapter,
      undefined,
      this.deps.sessionPermissions,
      undefined,
      this.deps.getImageGenerationSettings,
      this.deps.createGoalPersistence(),
      this.deps.browserIntegration,
      modelRuntimeProvider,
      this.deps.recordAttestation ?? null,
    );
  }

  private wireService(path: string, service: PiRuntimeService): void {
    service.setEventSink((events) => {
      this.manager.touch(path);
      if (this.manager.focusedProjectPath === path || this.pendingOpenPath === path) {
        const sessionId = service.getState(false).sessionId;
        if (sessionId) this.attentionByProject.get(path)?.delete(sessionId);
        this.rendererSink(events);
      } else {
        this.observeBackgroundAttention(path, service, events);
      }
    });
    service.setGoalEventSink((event) => {
      this.manager.touch(path);
      if (this.manager.focusedProjectPath === path || this.pendingOpenPath === path) this.goalSink(event);
    });
    service.setTaskEventSink((event) => {
      this.manager.touch(path);
      if (this.manager.focusedProjectPath === path || this.pendingOpenPath === path) this.taskSink(event);
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
