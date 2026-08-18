import type { Debugger, WebContents } from 'electron';
import { BrowserError } from './BrowserErrors';

export type CdpDomain = 'Page' | 'DOM' | 'Accessibility' | 'DOMSnapshot' | 'Overlay' | 'CSS' | 'Runtime' | 'Target' | 'Input';
export type CdpAvailabilityListener = (event: { available: boolean; reason?: string }) => void;

export interface BrowserCdpClient {
  send<T>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  supports(domain: CdpDomain): boolean;
}

export interface BrowserCdpEventClient extends BrowserCdpClient {
  waitForEvent<T>(method: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T>;
}

const ENABLE_COMMANDS: Partial<Record<CdpDomain, { method: string; params?: Record<string, unknown> }>> = {
  Page: { method: 'Page.enable' },
  DOM: { method: 'DOM.enable' },
  Accessibility: { method: 'Accessibility.enable' },
  Overlay: { method: 'Overlay.enable' },
  CSS: { method: 'CSS.enable' },
  Runtime: { method: 'Runtime.enable' },
  // OOPIF targets are intentionally not auto-attached in the first cut. Safe
  // semantic support requires target-scoped identity plus coordinate mapping;
  // partially routing sessions would risk acting on the wrong element.
};

export class CdpClient implements BrowserCdpClient {
  private readonly supportedDomains = new Set<CdpDomain>();
  private listener: CdpAvailabilityListener | null = null;
  private disposed = false;
  private detachListener: ((event: Electron.Event, reason: string) => void) | null = null;
  private messageListener: ((event: Electron.Event, method: string, params: unknown) => void) | null = null;
  private readonly eventWaiters = new Map<string, Set<(params: unknown) => void>>();

  constructor(private readonly contents: WebContents) {}

  setAvailabilityListener(listener: CdpAvailabilityListener | null): void {
    this.listener = listener;
  }

  async attach(): Promise<void> {
    if (this.disposed) throw new BrowserError('CDP_UNAVAILABLE', 'The browser CDP client has been disposed.');
    const debuggerApi = this.contents.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach();
    if (!this.detachListener) {
      this.detachListener = (_event, reason) => {
        this.supportedDomains.clear();
        this.listener?.({ available: false, reason });
      };
      debuggerApi.on('detach', this.detachListener);
    }
    if (!this.messageListener) {
      this.messageListener = (_event, method, params) => {
        const waiters = this.eventWaiters.get(method);
        if (!waiters) return;
        for (const resolve of [...waiters]) resolve(params);
      };
      debuggerApi.on('message', this.messageListener);
    }

    this.supportedDomains.clear();
    const schema = await this.trySchemaDomains();
    for (const domain of ['Page', 'DOM', 'Accessibility', 'DOMSnapshot', 'Overlay', 'CSS', 'Runtime', 'Target', 'Input'] as const) {
      if (!schema.has(domain)) continue;
      const enable = ENABLE_COMMANDS[domain];
      if (!enable || await this.trySend(enable.method, enable.params)) this.supportedDomains.add(domain);
    }
    const essential: readonly CdpDomain[] = ['Page', 'DOM', 'Accessibility', 'DOMSnapshot', 'Input'];
    const missing = essential.filter((domain) => !this.supportedDomains.has(domain));
    if (missing.length > 0) {
      this.supportedDomains.clear();
      const reason = `Chromium is missing required browser automation domains: ${missing.join(', ')}.`;
      this.listener?.({ available: false, reason });
      throw new BrowserError('CDP_UNAVAILABLE', reason, true);
    }
    this.listener?.({ available: true });
  }

  supports(domain: CdpDomain): boolean {
    return this.supportedDomains.has(domain);
  }

  async send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.disposed || !this.contents.debugger.isAttached()) {
      throw new BrowserError('CDP_UNAVAILABLE', 'Semantic browser control is not attached.', true);
    }
    return this.contents.debugger.sendCommand(method, params, sessionId) as Promise<T>;
  }

  waitForEvent<T>(method: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    if (this.disposed || !this.contents.debugger.isAttached()) {
      return Promise.reject(new BrowserError('CDP_UNAVAILABLE', 'Semantic browser control is not attached.', true));
    }
    return new Promise<T>((resolve, reject) => {
      const waiters = this.eventWaiters.get(method) ?? new Set<(params: unknown) => void>();
      const settle = (params: unknown) => { cleanup(); resolve(params as T); };
      const abort = () => { cleanup(); reject(new DOMException('Browser inspection aborted.', 'AbortError')); };
      const timer = setTimeout(() => {
        cleanup();
        reject(new BrowserError('UNSUPPORTED_ACTION', `Timed out waiting for ${method}.`, true));
      }, options.timeoutMs ?? 60_000);
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        waiters.delete(settle);
        if (waiters.size === 0) this.eventWaiters.delete(method);
      };
      waiters.add(settle);
      this.eventWaiters.set(method, waiters);
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
    });
  }

  async detach(): Promise<void> {
    // Idempotent and never-throwing: the listener fields gate the debugger
    // interaction, so a second call is a harmless no-op.
    // A destroyed webContents takes its debugger attachment with it, and
    // merely reading `.debugger` on it throws. isDestroyed() stays callable.
    if (!this.contents.isDestroyed()) {
      const debuggerApi = this.contents.debugger;
      if (this.detachListener) debuggerApi.off('detach', this.detachListener);
      if (this.messageListener) debuggerApi.off('message', this.messageListener);
      if (debuggerApi.isAttached()) {
        try {
          debuggerApi.detach();
        } catch {
          // The renderer is already gone; Chromium reclaimed the session.
        }
      }
    }
    this.detachListener = null;
    this.messageListener = null;
    this.eventWaiters.clear();
    this.supportedDomains.clear();
  }

  async dispose(): Promise<void> {
    // Set the flag first so concurrent dispose() calls become no-ops while
    // this one runs, and so in-flight sends fail fast instead of queuing.
    this.disposed = true;
    this.listener = null;
    await this.detach();
  }

  private async trySchemaDomains(): Promise<Set<string>> {
    try {
      const result = await withHandshakeTimeout(
        this.send<{ domains?: Array<{ name?: string }> }>('Schema.getDomains'),
        'Chromium protocol discovery timed out.',
      );
      return new Set((result.domains ?? []).map((domain) => domain.name).filter((name): name is string => Boolean(name)));
    } catch {
      return new Set();
    }
  }

  private async trySend(method: string, params: Record<string, unknown> = {}): Promise<boolean> {
    try {
      await withHandshakeTimeout(this.send(method, params), `Chromium did not enable ${method} in time.`);
      return true;
    } catch {
      return false;
    }
  }
}

function withHandshakeTimeout<T>(operation: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BrowserError('CDP_UNAVAILABLE', message, true)), 5_000);
    timer.unref?.();
    void operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export type ElectronDebuggerTransport = Debugger;
