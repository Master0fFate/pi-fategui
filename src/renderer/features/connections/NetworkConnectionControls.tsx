import { useEffect, useId, useState } from 'react';
import type { NetworkWorkspaceApi } from '../../../client/NetworkWorkspaceApi';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { ConnectionStatus } from './ConnectionStatus';
import { WorkspaceControlPanel } from './WorkspaceControlPanel';
import { NetworkHistory } from './NetworkHistory';

/** One host-first status surface. The transport still owns every authority check. */
export function NetworkConnectionControls({ api }: { api: NetworkWorkspaceApi }) {
  const id = useId();
  const selected = useRuntimeStore((state) => state.selected);
  const snapshot = useRuntimeStore((state) => state.snapshot);
  const phase = useRuntimeStore((state) => state.phase);
  const request = useRuntimeStore((state) => state.request);
  const pending = useRuntimeStore((state) => state.pendingReview);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, updateLeaseClock] = useState(0);
  // Expiring authority is not an immortal label. This renders the adapter's
  // calibrated lease getter; it does not renew control or send any request.
  useEffect(() => {
    const timer = window.setInterval(() => updateLeaseClock((tick) => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const controls = snapshot?.header.controls;
  const sessionId = snapshot?.header.sessionId ?? null;
  const current = api.isConnected && phase === 'observing' && selected !== null && snapshot !== null;
  const hostName = api.hostName ?? api.hostId ?? new URL(api.origin).host;
  const lookup = selected && sessionId ? api.pendingPromptReview(selected, sessionId) : null;
  const unresolved = pending !== null || lookup?.kind !== 'none' && lookup !== null;
  const scopeKey = [api.authenticatedSessionId, api.serverEpoch, selected?.workspaceId,
    selected?.workspaceGeneration, sessionId, snapshot?.header.selectionRevision, api.control, request].join(':');
  const refresh = () => useRuntimeStore.getState().refresh(api);
  const act = async (operation: () => Promise<unknown>) => {
    if (!current || busy) return;
    setBusy(true); setError(null);
    try { await operation(); }
    catch { setError('Control response was not confirmed. Refresh the host state before another action.'); }
    finally { await refresh(); setBusy(false); }
  };
  return <>
    <ConnectionStatus hostName={hostName} workspaceName={selected?.label ?? null} sessionId={sessionId}
      connected={current} statusLabel={unresolved ? 'original outcome requires review' : phase}
      controlLabel={api.control !== null && current ? 'controller' : 'observer'}
      permissionLevel={controls?.permissionLevel ?? null} running={controls?.activeSessionRunning ?? null}
      lastConfirmedAt={snapshot?.header.capturedAt ?? null}
      lastConfirmedStatus={controls?.activeSessionRunning === true ? 'running' : controls?.status ?? null}
      panelId={id} panelOpen={open} onOpenChange={setOpen} />
    {!open && <div className="connection-actions">
      <button type="button" disabled={!current || !api.supports('workspace.control') || busy || api.control !== null}
        onClick={() => selected && void act(() => api.claimControl(selected))}>Claim control</button>
      <button type="button" disabled={!current || busy || api.control === null}
        onClick={() => selected && void act(() => api.releaseControl(selected))}>Release control</button>
    </div>}
    {open && <WorkspaceControlPanel id={id} hostName={hostName} workspace={selected} sessionId={sessionId}
      permissionLevel={controls?.permissionLevel ?? null} estimatedHostTime={() => api.estimatedHostTime}
      scopeKey={scopeKey} ready={current} controlGeneration={api.control} canControl={api.supports('workspace.control')}
      canApprovePermission={api.supports('permission.approve')} takeoverAllowed={api.takeoverAllowed === true}
      onClose={() => setOpen(false)} canRefresh={api.isConnected} onRefresh={refresh}
      onClaim={() => { if (!selected) throw new Error('No host workspace'); return api.claimControl(selected); }}
      onRenew={() => { if (!selected) throw new Error('No host workspace'); return api.renewControl(selected); }}
      onRelease={() => { if (!selected) throw new Error('No host workspace'); return api.releaseControl(selected); }}
      onTakeover={() => { if (!selected) throw new Error('No host workspace'); return api.takeOverControl(selected); }}
      onRequestPermission={(input) => { if (!selected) throw new Error('No host workspace'); return api.requestPermissionApproval(selected, input); }}
      onRespondPermission={(input) => { if (!selected) throw new Error('No host workspace'); return api.respondPermissionApproval(selected, input); }} />}
    {open && current && selected && sessionId && <NetworkHistory key={scopeKey} api={api} workspace={selected} sessionId={sessionId} />}
    {error && <p role="alert">{error}</p>}
  </>;
}
