import { useEffect, useState, useSyncExternalStore } from 'react';
import { App } from '../app/App';
import './desktop-connections.css';
import { getDesktopConnectionsOptional, getDesktopConnectionRevision, getDesktopConnectionState,
  getFateApiOptional, initializeDesktopConnections, subscribeDesktopConnection } from './api';
import type { DesktopConnectionApi } from '../../shared/contracts/connections';
import { ConnectionProfileEditor } from '../features/connections/ConnectionProfileEditor';
import { ConnectionFeedback } from '../features/connections/ConnectionFeedback';

/** Native selection is resolved before local hydration. An unavailable remote remains remote. */
export function DesktopPlatformRoot() {
  useSyncExternalStore(subscribeDesktopConnection, getDesktopConnectionRevision, getDesktopConnectionRevision);
  const connections = getDesktopConnectionsOptional();
  const state = getDesktopConnectionState();
  const [profiles, setProfiles] = useState<Awaited<ReturnType<DesktopConnectionApi['listConnectionProfiles']>>>([]);
  const [initialized, setInitialized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!connections) { setInitialized(true); return; }
    void Promise.all([initializeDesktopConnections(), connections.listConnectionProfiles()]).then(([, rows]) => {
      if (active) { setProfiles(rows); setInitialized(true); }
    }).catch(() => { if (active) { setError('The saved execution host is unavailable. Select a host explicitly; local fallback is disabled.'); setInitialized(true); } });
    return () => { active = false; };
  }, [connections]);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); await initializeDesktopConnections(); }
    catch { setError('Host selection or connection was not confirmed. No local fallback was made.'); }
    finally { setBusy(false); }
  };
  const key = state ? `${state.kind}:${state.generation}:${state.profile?.id ?? ''}:${state.serverEpoch ?? ''}` : 'selection-unconfirmed';
  return <div className="desktop-platform-root">
    {connections && <ConnectionProfileEditor api={connections} onSaved={async () => setProfiles(await connections.listConnectionProfiles())} />}
    {connections && (profiles.length > 0 || state?.kind !== 'local') && <section className="desktop-host-selector" aria-label="Execution host">
      <label>Execution host <select aria-label="Execution host" disabled={busy} value={state?.kind === 'local' ? 'local' : state?.profile?.id ?? ''}
        onChange={(event) => { const id = event.target.value; void run(() => connections.selectConnectionProfile(id === 'local' ? { kind: 'local' } : { kind: 'remote', profileId: id })); }}>
        {(!state || state.kind === 'remote' && !profiles.some((profile) => profile.id === state.profile?.id)) &&
          <option value={state?.profile?.id ?? ''} disabled>{state?.profile?.label ?? 'Selection unconfirmed'} — remote unavailable; no local execution</option>}
        <option value="local">This computer — local execution</option>
        {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label} — remote execution</option>)}
      </select></label>
      {state?.kind === 'remote' && <><ConnectionFeedback state={state} /><span>Remote files are not local files.</span>
        <button type="button" disabled={busy} onClick={() => void run(() => getFateApiOptional()!.remote!.connect())}>Connect selected host</button>
        <button type="button" disabled={busy} onClick={() => void run(() => getFateApiOptional()!.remote!.disconnect())}>Disconnect selected host</button></>}
      {error && <p role="alert">{error}</p>}
    </section>}
    {initialized ? <App key={key} /> : <p role="status">Checking the saved execution host. Local execution has not started.</p>}
  </div>;
}
