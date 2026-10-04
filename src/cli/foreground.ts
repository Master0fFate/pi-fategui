import type { CoreShutdownResult } from '../core/lifecycle/CoreLifecycle';
export interface ForegroundHost {
  stop(): Promise<CoreShutdownResult>;
  /** A network host must include transport-owned writers, not only core cleanup. */
  settled?(): Promise<void> | null;
  readonly core: { readonly lifecycle: { settled(): Promise<void> | null } };
}
export interface HostSignals {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}
/** A failed or timed-out stop cannot exit and abandon the retained profile lock. */
export async function runForegroundHost(server: ForegroundHost, signals: HostSignals = process,
  write: (text: string) => void = (text) => { process.stderr.write(text); }): Promise<void> {
  await new Promise<void>((resolve) => {
    const retention = setInterval(() => undefined, 60_000);
    let stopping = false;
    const settled = () => { clearInterval(retention); signals.off('SIGINT', requestStop); signals.off('SIGTERM', requestStop); resolve(); };
    const requestStop = () => {
      if (stopping) return;
      stopping = true;
      void server.stop().then(async (result) => {
        if (result.status === 'settled') { settled(); return; }
        write('Host shutdown is incomplete. The process retains ownership. Inspect the host before recovery.\n');
        const actual = server.settled ? server.settled() : server.core.lifecycle.settled();
        if (actual) {
          try { await actual; write('Host shutdown has now settled.\n'); settled(); }
          catch { /* The live process and retained lock remain for operator review. */ }
        }
      }).catch(() => { write('Host shutdown failed. The process retains ownership. Inspect the host before recovery.\n'); });
    };
    signals.on('SIGINT', requestStop); signals.on('SIGTERM', requestStop);
  });
}
