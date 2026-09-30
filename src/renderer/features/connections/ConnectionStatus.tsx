import { useId } from 'react';
import type { PermissionLevel } from '../../../shared/contracts/ipc';
import './connections.css';

export interface ConnectionStatusProps {
  /** Host identity comes from the authenticated workspace, not the browser location. */
  hostName: string;
  connected: boolean;
  /** Host/transport supplied description; never derive task completion from disconnection. */
  statusLabel: string;
  workspaceName: string | null;
  sessionId: string | null;
  permissionLevel: PermissionLevel | null;
  /** Current selected-session fact supplied by the host; null is not fresh evidence. */
  running: boolean | null;
  lastConfirmedAt: number | null;
  /** A factual last-known label from host state, not inferred from connection loss. */
  lastConfirmedStatus: string | null;
  controlLabel: string;
  panelId: string;
  panelOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

function confirmedTime(value: number | null): { label: string; dateTime?: string } {
  if (value === null) return { label: 'No confirmed host update yet' };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { label: 'Last confirmed time unavailable' };
  return { label: `Last confirmed ${date.toLocaleString()}`, dateTime: date.toISOString() };
}

/** Mount once, immediately before the prompt. The panel deliberately has no second status strip. */
export function ConnectionStatus({ hostName, connected, statusLabel, workspaceName, sessionId, permissionLevel, running, lastConfirmedAt, lastConfirmedStatus, controlLabel, panelId, panelOpen, onOpenChange }: ConnectionStatusProps) {
  const descriptionId = useId();
  const confirmed = confirmedTime(lastConfirmedAt);
  const warnAboutHostWork = !connected || running === true;
  return (
    <section className="connection-status" aria-label="Connection status" aria-describedby={warnAboutHostWork ? descriptionId : undefined}>
      <div className="connection-status-copy" role="status" aria-live="polite" aria-atomic="true">
        <strong>Host: {hostName}</strong>
        <span>Workspace: {workspaceName ?? 'none selected'}</span>
        <span>Session: {sessionId ?? 'none selected'}</span>
        <span>{statusLabel}</span>
        <span>{controlLabel}</span>
        <span>Permission: {permissionLevel ?? 'unknown'}</span>
        {connected && <span>Selected session: {running === true ? 'running' : running === false ? 'not running' : 'unknown'}</span>}
        {!connected && <><span>Last confirmed state: {lastConfirmedStatus ?? 'unknown'}</span><time dateTime={confirmed.dateTime}>{confirmed.label}</time></>}
      </div>
      <button id={`${panelId}-trigger`} type="button" aria-expanded={panelOpen} aria-controls={panelId} onClick={() => onOpenChange(!panelOpen)}>
        {panelOpen ? 'Hide controls' : 'Review controls'}
      </button>
      {warnAboutHostWork && <p id={descriptionId} className="connection-warning">{!connected ? 'Host state is unconfirmed. ' : ''}Work, including paid work, may continue on the host independently of this UI. Connection loss does not mean it stopped or completed.</p>}
    </section>
  );
}
