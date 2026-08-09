import type { ProjectState, RuntimeState } from '../../shared/contracts/ipc';
import { ProjectRuntimeCoordinator, type ProjectRuntimeCoordinatorOptions } from './ProjectRuntimeCoordinator';

/**
 * Coordinates multiple live Pi runtimes (one per project/folder) behind a single
 * "focused" runtime that the rest of the app talks to. Opening a new folder
 * keeps previously-opened folders' runtimes alive (so a long task in folder A
 * keeps running while you work in folder B); idle folders are evicted by the
 * underlying {@link ProjectRuntimeCoordinator}.
 *
 * Generic over the runtime handle `R` (in production, a `PiRuntimeService`).
 * All creation/disposal/busy/event-forwarding is injected, so the focus and
 * lifecycle rules are unit-testable without a live agent.
 */
export interface MultiProjectRuntimeHooks<R> {
  /** Create a runtime fully bound to a project (e.g. `new PiRuntimeService(…)` + `openProject`). */
  createRuntime: (project: ProjectState) => Promise<R>;
  /** Tear down a runtime and release its resources. */
  disposeRuntime: (runtime: R) => Promise<void>;
  /** True while the runtime has active work (streaming, subagents, goalmax). Never evicted while busy. */
  isBusy: (runtime: R) => boolean;
  /** Called when focus moves to a different runtime (or null). Main rewires event forwarding here. */
  onFocused?: (runtime: R | null, projectPath: string | null) => void;
  /** Called when a background runtime is evicted (e.g. to drop cached renderer state). */
  onEvicted?: (projectPath: string) => void;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

export interface MultiProjectRuntimeManagerOptions extends ProjectRuntimeCoordinatorOptions {
  /** Whether to enable idle eviction at all (disable in tests/single-project mode). Default true. */
  evictionEnabled?: boolean;
}

export class MultiProjectRuntimeManager<R> {
  private readonly coordinator: ProjectRuntimeCoordinator<R>;
  private readonly projectStates = new Map<string, ProjectState>();
  private readonly evictionEnabled: boolean;
  private focusedPath: string | null = null;
  private focusedRuntime: R | null = null;

  constructor(
    private readonly hooks: MultiProjectRuntimeHooks<R>,
    options: MultiProjectRuntimeManagerOptions = {},
  ) {
    this.evictionEnabled = options.evictionEnabled ?? true;
    this.coordinator = new ProjectRuntimeCoordinator<R>(
      {
        createRuntime: async (projectPath, projectName) => {
          const project = this.projectStates.get(projectPath) ?? { path: projectPath, name: projectName, trusted: true };
          return this.hooks.createRuntime(project);
        },
        disposeRuntime: (runtime) => this.hooks.disposeRuntime(runtime),
        isBusy: (runtime) => this.hooks.isBusy(runtime),
        onEvicted: (projectPath) => {
          if (this.projectStates.has(projectPath)) this.projectStates.delete(projectPath);
          this.hooks.onEvicted?.(projectPath);
        },
      },
      { idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS, ...options },
    );
  }

  /** The currently focused runtime handle, or null when no project is open. */
  getFocused(): R | null {
    return this.focusedPath ? this.coordinator.get(this.focusedPath)?.runtime ?? null : null;
  }

  /** The currently focused project path, or null. */
  get focusedProjectPath(): string | null {
    return this.focusedPath;
  }

  get size(): number {
    return this.coordinator.size;
  }

  has(projectPath: string): boolean {
    return this.coordinator.has(projectPath);
  }

  get(projectPath: string): R | null {
    return this.coordinator.get(projectPath)?.runtime ?? null;
  }

  /** Iterate every live runtime in least-recently-touched order. */
  forEach(handler: (projectPath: string, runtime: R) => void): void {
    this.coordinator.forEach(handler);
  }

  /**
   * Open (or re-focus) a project. Keeps all other live projects running.
   * Returns the focused runtime handle and the latest runtime state.
   */
  async openProject(project: ProjectState, readState: (runtime: R) => RuntimeState): Promise<{ runtime: R; state: RuntimeState }> {
    const existing = this.coordinator.get(project.path);
    const previous = this.projectStates.get(project.path);
    // A folder opened without Pi is intentionally represented by a
    // disconnected runtime. If the user later trusts that same folder, replace
    // the disconnected context instead of reusing it forever.
    if (existing && previous && (previous.trusted !== project.trusted || previous.name !== project.name)) {
      await this.close(project.path);
    }
    this.projectStates.set(project.path, project);
    const ctx = await this.coordinator.acquire({ path: project.path, name: project.name });
    this.setFocus(project.path, ctx.runtime);
    const state = readState(ctx.runtime);
    // Initialization failures are returned as state (so IPC can perform its
    // transactional rollback), but must not poison the cached context. An
    // intentional untrusted/disconnected project and auth-required runtime are
    // still useful focused contexts and remain retryable through a later
    // trusted activation or authentication.
    if (state.status === 'error') {
      await this.close(project.path);
    }
    return { runtime: ctx.runtime, state };
  }

  /** Re-focus an already-live project without recreating it. No-op if not live. */
  focus(projectPath: string): boolean {
    const ctx = this.coordinator.get(projectPath);
    if (!ctx) return false;
    this.coordinator.focus(projectPath);
    this.setFocus(projectPath, ctx.runtime);
    return true;
  }

  /** Focus a known project without allocating a Pi runtime yet. */
  focusPreview(project: ProjectState): void {
    this.projectStates.set(project.path, project);
    const changed = this.focusedPath !== project.path || this.focusedRuntime !== null;
    this.focusedPath = project.path;
    this.focusedRuntime = null;
    this.coordinator.clearFocus();
    if (changed) this.hooks.onFocused?.(null, project.path);
  }

  /** Mark activity on a project (resets its idle timer). */
  touch(projectPath: string): void {
    this.coordinator.touch(projectPath);
  }

  /** Explicitly close + dispose a project's runtime (e.g. user "forgets" the folder). */
  async close(projectPath: string): Promise<void> {
    await this.coordinator.close(projectPath);
    this.projectStates.delete(projectPath);
    if (this.focusedPath === projectPath) {
      this.focusedPath = null;
      this.focusedRuntime = null;
      this.hooks.onFocused?.(null, null);
    }
  }

  /** Close whatever is focused. */
  async closeFocused(): Promise<void> {
    if (this.focusedPath) await this.close(this.focusedPath);
  }

  /** Begin idle eviction. Call once at app startup when multi-project mode is on. */
  start(): void {
    if (this.evictionEnabled) this.coordinator.start();
  }

  /** Stop eviction and dispose every live runtime. Call at shutdown. */
  async stop(): Promise<void> {
    const hadFocus = this.focusedPath !== null;
    await this.coordinator.stop();
    this.projectStates.clear();
    this.focusedPath = null;
    this.focusedRuntime = null;
    if (hadFocus) this.hooks.onFocused?.(null, null);
  }

  /** Run one eviction pass immediately (exposed for tests / on-demand reclamation). */
  async sweepOnce(): Promise<void> {
    if (this.evictionEnabled) await this.coordinator.sweepOnce();
  }

  private setFocus(projectPath: string, runtime: R): void {
    const changed = this.focusedPath !== projectPath || this.focusedRuntime !== runtime;
    this.focusedPath = projectPath;
    this.focusedRuntime = runtime;
    this.coordinator.focus(projectPath);
    if (changed) this.hooks.onFocused?.(runtime, projectPath);
  }
}
