/**
 * Framework-free state machine for multi-window launch dispatch.
 *
 * Owns the set of open windows, the focused window, renderer readiness, the
 * pending project path, and the registered project opener. Electron's
 * BrowserWindow wiring stays thin in the factory; this module holds the
 * testable invariants:
 *
 * - a forwarded project path stays pending until the renderer, opener, and an
 *   owner window are all ready;
 * - the active window is the focused window when it is still live, otherwise
 *   the first live open window;
 * - the last window closing tears down shared state and clears readiness;
 * - only an initial window owns launch-time restore.
 */
export interface LaunchDispatcherDeps<WindowHandle> {
  /** True when the handle is still usable (not destroyed). */
  isLive: (handle: WindowHandle) => boolean;
  /** Report a failure to open a project (for example an invalid forwarded path). */
  reportLaunchError: (error: unknown) => void;
  /** Invoked when the last open window closes. */
  onLastWindowClosed: () => void;
  /** Invoked when restoring the last trusted project fails. */
  onRestoreError?: (error: unknown) => void;
}

export class LaunchDispatcher<WindowHandle = unknown> {
  private readonly openHandles = new Set<WindowHandle>();
  private focusedHandle: WindowHandle | null = null;
  private rendererReady = false;
  private pendingProjectPath: string | null = null;
  private projectPathOpener: ((projectPath: string, owner: WindowHandle) => Promise<unknown>) | null = null;
  /** Bumped on each immediate dispatch so a pending initial restore can detect an intervening explicit open. */
  private restoreGeneration = 0;

  constructor(private readonly deps: LaunchDispatcherDeps<WindowHandle>) {}

  /** Track a newly created window; the first becomes focused by default. */
  register(handle: WindowHandle): void {
    this.openHandles.add(handle);
    if (this.focusedHandle === null) this.focusedHandle = handle;
  }

  setFocused(handle: WindowHandle): void {
    this.focusedHandle = handle;
  }

  /** Register the IPC-backed opener. Until this is set, paths stay pending. */
  setOpener(opener: (projectPath: string, owner: WindowHandle) => Promise<unknown>): void {
    this.projectPathOpener = opener;
  }

  markRendererReady(): void {
    this.rendererReady = true;
  }

  isRendererReady(): boolean {
    return this.rendererReady;
  }

  setPendingProjectPath(projectPath: string | null): void {
    this.pendingProjectPath = projectPath;
  }

  getPendingProjectPath(): string | null {
    return this.pendingProjectPath;
  }

  /** The focused window when it is still live, otherwise the first live window. */
  activeHandle(): WindowHandle | null {
    const focused = this.focusedHandle;
    if (focused && this.openHandles.has(focused) && this.deps.isLive(focused)) return focused;
    for (const handle of this.openHandles) if (this.deps.isLive(handle)) return handle;
    return null;
  }

  /**
   * Open the project path immediately when the renderer, opener, and an owner
   * are ready; otherwise keep it pending. Returns true when dispatched now.
   */
  dispatch(projectPath: string): boolean {
    const owner = this.activeHandle();
    if (!this.projectPathOpener || !this.rendererReady || !owner) {
      this.pendingProjectPath = projectPath;
      return false;
    }
    this.pendingProjectPath = null;
    // An explicit dispatch invalidates any pending initial restore: once a
    // concrete project is opened, a later-resolving last-trusted-project must
    // not override it.
    this.restoreGeneration += 1;
    void this.projectPathOpener(projectPath, owner).catch(this.deps.reportLaunchError);
    return true;
  }

  /**
   * Only an initial window owns launch-time restore. An explicit pending path
   * takes priority over the last trusted project; otherwise the last trusted
   * project is restored without a second trust prompt.
   */
  runInitialRestore(options: {
    restoreLastTrustedProject: () => Promise<string | null>;
    consumeLaunchError: () => unknown | null;
  }): void {
    this.rendererReady = true;
    const launchError = options.consumeLaunchError();
    if (launchError !== null && launchError !== undefined) this.deps.reportLaunchError(launchError);
    const explicitProjectPath = this.pendingProjectPath;
    this.pendingProjectPath = null;
    if (explicitProjectPath) {
      this.dispatch(explicitProjectPath);
      return;
    }
    // Capture the generation before awaiting restore. An explicit dispatch that
    // lands while restore is in flight bumps the generation; when restore then
    // resolves with the stale last-trusted project, it is discarded instead of
    // overriding the path the user just opened.
    const restoreGeneration = this.restoreGeneration;
    void options
      .restoreLastTrustedProject()
      .then((recentProjectPath) => {
        if (restoreGeneration !== this.restoreGeneration) return;
        const projectPath = this.pendingProjectPath ?? recentProjectPath;
        this.pendingProjectPath = null;
        if (projectPath) this.dispatch(projectPath);
      })
      .catch((error: unknown) => this.deps.onRestoreError?.(error));
  }

  /** Bookkeeping for a closing window. Returns true when it was the last one. */
  close(handle: WindowHandle): boolean {
    this.openHandles.delete(handle);
    if (this.focusedHandle === handle) this.focusedHandle = null;
    if (this.openHandles.size === 0) {
      this.rendererReady = false;
      this.deps.onLastWindowClosed();
      return true;
    }
    return false;
  }

  openWindowCount(): number {
    return this.openHandles.size;
  }
}
