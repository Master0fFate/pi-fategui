/**
 * Idempotent application shutdown.
 *
 * The first request prevents the quit, runs the (optional) synchronous dispose
 * steps, then races async disposal against a timeout, and finally marks the
 * app ready to quit and calls onExit. Subsequent requests keep preventing the
 * quit until disposal settles; once settled the app is allowed to quit. This
 * preserves the original before-quit ordering without depending on Electron.
 */
export interface ShutdownCoordinatorDeps {
  /** Runs once before disposal starts (for example, remembering window placement). */
  onBeforeDispose?: () => void;
  /** Synchronous dispose steps that run before the async race. */
  disposeSync?: () => void;
  /** Async dispose steps raced against the timeout. */
  disposeAsync: () => readonly unknown[];
  /** Called after disposal settles (success or timeout). */
  onExit: () => void;
  /** Called when async disposal throws. */
  onError?: (error: unknown) => void;
  /** Dispose timeout. Defaults to 5000ms. */
  timeoutMs?: number;
}

export class ShutdownCoordinator {
  private shutdownPromise: Promise<void> | null = null;
  private quitReady = false;

  constructor(private readonly deps: ShutdownCoordinatorDeps) {}

  isQuitReady(): boolean {
    return this.quitReady;
  }

  /**
   * Request shutdown. Returns true while shutdown is starting or in progress
   * (the caller must prevent the quit); returns false once the app is ready to
   * quit (the caller allows the quit to proceed).
   */
  requestShutdown(): boolean {
    if (this.quitReady) return false;
    if (this.shutdownPromise) return true;
    this.shutdownPromise = this.run();
    return true;
  }

  /** Await disposal settling (mainly for tests). */
  settled(): Promise<void> | null {
    return this.shutdownPromise;
  }

  private async run(): Promise<void> {
    // Best-effort continuation: a throw in an earlier hook must not prevent the
    // later disposal phases or the final exit. Each error is reported via
    // reportError (which never throws), and onExit is called exactly once in the
    // finally block.
    try {
      this.deps.onBeforeDispose?.();
    } catch (error) {
      this.reportError(error);
    }
    try {
      this.deps.disposeSync?.();
    } catch (error) {
      this.reportError(error);
    }
    try {
      await Promise.race([
        Promise.all(this.deps.disposeAsync().map((value) => Promise.resolve(value))).then(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, this.deps.timeoutMs ?? 5_000)),
      ]);
    } catch (error) {
      this.reportError(error);
    } finally {
      this.quitReady = true;
      this.deps.onExit();
    }
  }

  /** Reports a disposal error without letting a throwing observer stop cleanup or the final exit. */
  private reportError(error: unknown): void {
    try {
      this.deps.onError?.(error);
    } catch {
      // A throwing onError callback must not prevent later disposal or the exit.
    }
  }
}
