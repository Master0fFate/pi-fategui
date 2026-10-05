import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { App } from '../app/App';
import './desktop-connections.css';
import { getDesktopConnectionsOptional, getDesktopConnectionRevision, getDesktopConnectionState,
  getFateApiOptional, initializeDesktopConnections, subscribeDesktopConnection } from './api';
import type { ConnectionProfile } from '../../shared/contracts/connections';
import { ExecutionHostContext, type ExecutionHost } from './executionHost';

/**
 * Native selection is resolved before local hydration. An unavailable remote remains remote.
 * This root draws nothing above the workbench: the host controls live in Settings → Hosts and
 * in one button of the workspace header, so the first row of the window stays the title bar.
 */
export function DesktopPlatformRoot() {
  useSyncExternalStore(subscribeDesktopConnection, getDesktopConnectionRevision, getDesktopConnectionRevision);
  const connections = getDesktopConnectionsOptional();
  const state = getDesktopConnectionState();
  const [profiles, setProfiles] = useState<readonly ConnectionProfile[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  useEffect(() => {
    let active = true;
    if (!connections) { setInitialized(true); return; }
    void Promise.all([initializeDesktopConnections(), connections.listConnectionProfiles()]).then(([, rows]) => {
      if (active) { setProfiles(rows); setInitialized(true); }
    }).catch(() => { if (active) { setError('The saved execution host is unavailable. Select a host explicitly; local fallback is disabled.'); setInitialized(true); } });
    return () => { active = false; };
  }, [connections]);
  const host = useMemo<ExecutionHost | null>(() => {
    if (!connections) return null;
    const run = async (action: () => Promise<unknown>) => {
      if (busyRef.current) return;
      busyRef.current = true; setBusy(true); setError(null);
      try { await action(); await initializeDesktopConnections(); }
      catch { setError('Host selection or connection was not confirmed. No local fallback was made.'); }
      finally { busyRef.current = false; setBusy(false); }
    };
    return {
      api: connections, state, profiles, busy, error,
      select: (id) => void run(() => connections.selectConnectionProfile(id === 'local' ? { kind: 'local' } : { kind: 'remote', profileId: id })),
      connect: () => void run(() => getFateApiOptional()!.remote!.connect()),
      disconnect: () => void run(() => getFateApiOptional()!.remote!.disconnect()),
      reloadProfiles: async () => setProfiles(await connections.listConnectionProfiles()),
    };
  }, [connections, state, profiles, busy, error]);
  const key = state ? `${state.kind}:${state.generation}:${state.profile?.id ?? ''}:${state.serverEpoch ?? ''}` : 'selection-unconfirmed';
  return <ExecutionHostContext.Provider value={host}>
    <div className="desktop-platform-root">
      {initialized ? <App key={key} /> : <p className="desktop-platform-status" role="status">Checking the saved execution host. Local execution has not started.</p>}
    </div>
  </ExecutionHostContext.Provider>;
}
