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
  /** Write a clean marker only after every shutdown step actually settles. */
  onClean?: () => void | Promise<void>;
  /** Called with the truthful bounded result; the host owns process exit. */
  onExit: (status: 'settled' | 'incomplete') => void;
  /** Called when async disposal throws. */
  onError?: (error: unknown) => void;
  /** Dispose timeout. Defaults to 5000ms. */
  timeoutMs?: number;
}

export class ShutdownCoordinator {
  private shutdownPromise: Promise<void> | null = null;
  private quitReady = false;

  constructor(private readonly deps: ShutdownCoordinatorDeps) {
    const budget = deps.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 60_000) throw new Error('A finite shutdown timeout between 1ms and 60s is required.');
  }

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
    let incomplete = false;
    try { this.deps.onBeforeDispose?.(); } catch (error) { incomplete = true; this.reportError(error); }
    try { this.deps.disposeSync?.(); } catch (error) { incomplete = true; this.reportError(error); }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = Date.now() + (this.deps.timeoutMs ?? 5_000);
    try {
      const cleanup = async (): Promise<'settled' | 'incomplete'> => {
        const results = await Promise.all(this.deps.disposeAsync().map((value) => Promise.resolve(value)));
        if (results.some((result) => typeof result === 'object' && result !== null && 'status' in result && result.status === 'incomplete')) {
          return 'incomplete';
        }
        return 'settled';
      };
      const timeout = new Promise<'incomplete'>((resolve) => {
        timer = setTimeout(() => resolve('incomplete'), this.deps.timeoutMs ?? 5_000);
      });
      const outcome = await Promise.race([cleanup(), timeout]);
      if (outcome === 'incomplete' || Date.now() >= deadline) incomplete = true;
      if (!incomplete) {
        // Never begin the marker while a core or other disposer is pending.
        const marked = await Promise.race([Promise.resolve().then(() => this.deps.onClean?.()).then(() => 'settled' as const), timeout]);
        if (marked === 'incomplete') incomplete = true;
      }
    } catch (error) {
      incomplete = true;
      this.reportError(error);
    } finally {
      if (timer !== null) clearTimeout(timer);
      this.quitReady = true;
      this.deps.onExit(incomplete ? 'incomplete' : 'settled');
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
