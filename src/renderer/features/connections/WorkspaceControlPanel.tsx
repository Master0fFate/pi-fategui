import { useEffect, useId, useRef, useState } from 'react';
import type { WebWorkspace } from '../../../client/WebFateApi';
import type { PermissionLevel } from '../../../shared/contracts/ipc';
import { methodCatalog, type InputOf, type WireResultOf } from '../../../shared/protocol/methods';
import type { CommandStatus } from '../../../shared/protocol/commandOutcomes';
import './connections.css';

export interface WorkspaceControlPanelProps {
  id: string;
  hostName: string;
  workspace: WebWorkspace | null;
  sessionId: string | null;
  permissionLevel: PermissionLevel | null;
  /** Production passes calibrated host time; Date.now is only the standalone fallback. */
  estimatedHostTime?: () => number;
  /** Changes on auth, epoch, workspace generation, session/selection or lease change. */
  scopeKey: string;
  /** True only after authentication, current scope, snapshot and replay barrier. */
  ready: boolean;
  controlGeneration: number | null;
  canControl: boolean;
  canApprovePermission: boolean;
  /** Must come from trusted host policy. Unknown policy is false. */
  takeoverAllowed: boolean;
  onClose: () => void;
  /** False during transport loss; a stale connected view may still be refreshed. */
  canRefresh?: boolean;
  onRefresh: () => Promise<unknown>;
  onClaim: () => Promise<unknown>;
  onRenew: () => Promise<unknown>;
  onRelease: () => Promise<unknown>;
  onTakeover?: () => Promise<unknown>;
  /** Client authentication only. Provider administration stays host-local. */
  onLogin?: () => void;
  originalRequestId?: string | null;
  onReviewOriginal?: (input: InputOf<'command.status'>) => Promise<CommandStatus>;
  onRequestPermission: (input: InputOf<'permission.issue'>) => Promise<WireResultOf<'permission.issue'>>;
  onRespondPermission: (input: InputOf<'permission.confirm'>) => Promise<WireResultOf<'permission.confirm'>>;
}

/** Presentation only: the adapter and host recheck authority for every operation. */
export function WorkspaceControlPanel(props: WorkspaceControlPanelProps) {
  const { id, hostName, workspace, sessionId, permissionLevel, scopeKey, ready, controlGeneration,
    canControl, canApprovePermission, takeoverAllowed, onClose, onRefresh, onClaim, onRenew, onRelease,
    onTakeover, onLogin, originalRequestId, onReviewOriginal, onRequestPermission, onRespondPermission, estimatedHostTime = Date.now } = props;
  const titleId = useId();
  const permissionId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const takeoverButton = useRef<HTMLButtonElement>(null);
  const permissionButton = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLButtonElement | null>(null);
  const current = useRef(props);
  current.current = props;
  const inFlight = useRef(false);
  const challengeScope = useRef<string | null>(null);
  const takeoverScope = useRef<string | null>(null);
  const usedChallenges = useRef(new Set<string>());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newLevel, setNewLevel] = useState<PermissionLevel>('edit');
  const [takeoverReview, setTakeoverReview] = useState(false);
  const [challenge, setChallenge] = useState<WireResultOf<'permission.issue'> | null>(null);
  const [now, setNow] = useState(() => estimatedHostTime());
  const mutable = ready && workspace !== null && sessionId !== null && canControl;
  const controlling = mutable && controlGeneration !== null;
  const permissionReady = controlling && canApprovePermission && permissionLevel !== null;
  const reviewLimitReached = usedChallenges.current.size >= 128;
  const expired = challenge !== null && (!Number.isFinite(now) || challenge.expiresAt <= now);
  const challengeCurrent = challenge !== null && challengeScope.current === scopeKey && permissionReady && challenge.sessionId === sessionId
    && challenge.oldLevel === permissionLevel && !expired && !usedChallenges.current.has(challenge.challengeId);

  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    usedChallenges.current.clear(); challengeScope.current = null; takeoverScope.current = null;
    setChallenge(null); setTakeoverReview(false); setError(null); setMessage(null);
    // Scope changes can remove the focused review action. Keep focus inside the live panel.
    if (document.activeElement?.closest('.connection-inline-review') || challenge || takeoverReview) heading.current?.focus();
  }, [scopeKey, ready]);
  useEffect(() => {
    if (!challenge) return;
    const updateHostTime = () => setNow(current.current.estimatedHostTime?.() ?? Date.now());
    updateHostTime();
    const timer = window.setInterval(updateHostTime, 1000);
    return () => window.clearInterval(timer);
  }, [challenge, estimatedHostTime]);
  useEffect(() => { if (takeoverReview || challenge) cancel.current?.focus(); }, [takeoverReview, challenge]);
  useEffect(() => {
    if (!busy && !challenge && !takeoverReview && returnTo.current) {
      if (!returnTo.current.disabled) returnTo.current.focus();
      else heading.current?.focus();
      returnTo.current = null;
    }
  }, [busy, challenge, takeoverReview]);
  const cancelTakeover = () => {
    takeoverScope.current = null;
    returnTo.current = takeoverButton.current; setTakeoverReview(false); heading.current?.focus();
  };

  const sameScope = (key: string) => current.current.scopeKey === key && current.current.ready;
  const close = () => {
    onClose();
    document.getElementById(`${id}-trigger`)?.focus();
  };
  const run = async (action: () => Promise<unknown>, label: string, allowed: boolean, refreshAfter = true) => {
    if (!allowed || inFlight.current) return;
    const key = scopeKey;
    if (document.activeElement instanceof HTMLButtonElement && !returnTo.current) returnTo.current = document.activeElement;
    heading.current?.focus();
    inFlight.current = true; setBusy(true); setError(null); setMessage(null);
    try {
      await action();
      if (sameScope(key)) setMessage(`${label} response received. The host remains authoritative.`);
    } catch {
      if (current.current.scopeKey === key) setError(`${label} was not confirmed. Review the host state before another action.`);
    } finally {
      try { if (refreshAfter && current.current.scopeKey === key) await onRefresh(); }
      catch { if (current.current.scopeKey === key) setError('Host refresh failed. The displayed state is unconfirmed.'); }
      inFlight.current = false; setBusy(false);
    }
  };
  const requestPermission = async () => {
    if (!permissionReady || !sessionId || !permissionLevel || newLevel === permissionLevel || inFlight.current || challenge || takeoverReview || reviewLimitReached) return;
    const key = scopeKey;
    const checked = methodCatalog['permission.issue'].inputSchema.safeParse({ sessionId, action: 'runtime.setPermission', oldLevel: permissionLevel, newLevel });
    if (!checked.success) { setError('Permission scope is invalid. Refresh before requesting review.'); return; }
    const input = checked.data;
    returnTo.current = permissionButton.current; heading.current?.focus();
    inFlight.current = true; setBusy(true); setError(null); setMessage(null);
    try {
      const result = methodCatalog['permission.issue'].wireResultSchema.parse(await onRequestPermission(input));
      if (sameScope(key) && result.sessionId === sessionId && result.oldLevel === permissionLevel && result.newLevel === newLevel
        && result.expiresAt > (current.current.estimatedHostTime?.() ?? Date.now()) && !usedChallenges.current.has(result.challengeId)) {
        challengeScope.current = key; setChallenge(result);
      }
      else if (current.current.scopeKey === key) setError('Permission challenge is stale or mismatched. Refresh the host state.');
    } catch { if (current.current.scopeKey === key) setError('No current permission challenge was confirmed. Permission was not granted by this UI.'); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const cancelPermission = () => {
    if (challenge) usedChallenges.current.add(challenge.challengeId);
    challengeScope.current = null;
    returnTo.current = permissionButton.current;
    setChallenge(null); setMessage('Permission review canceled. No confirmation was sent.');
    heading.current?.focus();
  };
  const confirmPermission = async () => {
    const hostNow = current.current.estimatedHostTime?.() ?? Date.now();
    if (!challengeCurrent || !challenge || inFlight.current || !Number.isFinite(hostNow) || challenge.expiresAt <= hostNow) return;
    const key = scopeKey;
    const checked = methodCatalog['permission.confirm'].inputSchema.safeParse({ challengeId: challenge.challengeId,
      sessionId: challenge.sessionId, action: 'runtime.setPermission', oldLevel: challenge.oldLevel, newLevel: challenge.newLevel });
    if (!checked.success) { cancelPermission(); setError('Permission challenge is invalid. Refresh the host state.'); return; }
    const input = checked.data;
    // Consume locally BEFORE the network call. An uncertain response never exposes a repeat confirmation.
    usedChallenges.current.add(challenge.challengeId); challengeScope.current = null; returnTo.current = permissionButton.current;
    setChallenge(null); heading.current?.focus();
    await run(async () => {
      const result = methodCatalog['permission.confirm'].wireResultSchema.parse(await onRespondPermission(input));
      if (result.sessionId !== input.sessionId || result.level !== input.newLevel) throw new Error('Mismatched permission response');
      if (!sameScope(key)) return;
    }, 'Permission confirmation', true);
  };
  const reviewOriginal = async () => {
    if (!ready || !originalRequestId || !onReviewOriginal || inFlight.current) return;
    const key = scopeKey;
    const input = methodCatalog['command.status'].inputSchema.safeParse({ requestId: originalRequestId });
    if (!input.success) { setError('Original request identity is invalid. Resolve it on the host; do not resend.'); return; }
    if (document.activeElement instanceof HTMLButtonElement) returnTo.current = document.activeElement;
    heading.current?.focus();
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const result = methodCatalog['command.status'].wireResultSchema.parse(await onReviewOriginal(input.data));
      // The parent retains the original host/workspace scope. Session selection may
      // legitimately have changed since this recorded command was submitted.
      if (result.receipt && result.receipt.requestId !== originalRequestId) throw new Error('Mismatched receipt');
      if (sameScope(key) && current.current.originalRequestId === originalRequestId) {
        setMessage(`Original request status: ${result.state}. ${result.receipt?.kind === 'prompt' && result.receipt.outcome === 'accepted'
          ? 'The prompt was admitted; this is not proof the run completed.' : 'This status is not a new execution. Review host state; do not resend an uncertain command.'}`);
      }
      if (sameScope(key)) await onRefresh();
    } catch { if (current.current.scopeKey === key) setError('Original request status was not confirmed. Do not resend.'); }
    finally { inFlight.current = false; setBusy(false); }
  };

  return <section id={id} className="workspace-control-panel" aria-labelledby={titleId} onKeyDown={(event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (challenge) cancelPermission();
    else if (takeoverReview) cancelTakeover();
    else close();
  }}>
    <h2 id={titleId} ref={heading} tabIndex={-1}>Workspace controls</h2>
    <p>Host: {hostName} · Workspace: {workspace?.label ?? 'none selected'} · Session: {sessionId ?? 'none selected'}</p>
    <p>Control permits only host-authorized actions; it does not raise the host permission cap. Provider login stays on the execution host.</p>
    {!ready && <p>State is not current. New mutations are disabled; review the connection and refresh first. Work, including paid work, may continue on the host.</p>}
    <div className="connection-actions">
      {onLogin && <button type="button" onClick={onLogin}>Sign in to host</button>}
      <button type="button" disabled={busy || props.canRefresh === false} onClick={() => void run(onRefresh, 'Host refresh', props.canRefresh !== false, false)}>Refresh host state</button>
      <button type="button" onClick={close}>Close controls</button>
    </div>
    <fieldset><legend>Explicit workspace control</legend><div className="connection-actions">
      <button type="button" disabled={!mutable || busy || controlling || Boolean(challenge) || takeoverReview} onClick={() => void run(onClaim, 'Control claim', mutable && !controlling)}>Claim control</button>
      <button type="button" disabled={!controlling || busy || Boolean(challenge) || takeoverReview} onClick={() => void run(onRenew, 'Control renewal', controlling)}>Renew control</button>
      <button type="button" disabled={!controlling || busy || Boolean(challenge) || takeoverReview} onClick={() => void run(onRelease, 'Control release', controlling)}>Release control</button>
      <button ref={takeoverButton} type="button" disabled={!mutable || controlling || !takeoverAllowed || !onTakeover || busy || Boolean(challenge)} onClick={() => { takeoverScope.current = scopeKey; setTakeoverReview(true); }}>Take over control</button>
    </div>
      {!takeoverAllowed && <p>Takeover is unavailable unless the host policy explicitly permits it.</p>}
      {takeoverReview && <div className="connection-inline-review" role="group" aria-label="Takeover confirmation">
        <p>Take control of {workspace?.label ?? 'this workspace'} on {hostName}? This invalidates the other controller’s lease. Existing work is not canceled. Your original draft remains with its original session.</p>
        <div className="connection-actions"><button ref={cancel} type="button" onClick={cancelTakeover}>Cancel</button>
          <button type="button" disabled={!mutable || !takeoverAllowed || !onTakeover || busy || takeoverScope.current !== scopeKey} onClick={() => {
            if (!onTakeover || !takeoverAllowed || !mutable || takeoverScope.current !== scopeKey) return;
            takeoverScope.current = null;
            returnTo.current = takeoverButton.current; setTakeoverReview(false); heading.current?.focus(); void run(onTakeover, 'Control takeover', true);
          }}>Confirm takeover</button></div>
      </div>}
    </fieldset>
    <fieldset><legend>Scoped permission review</legend>
      <p>Current permission: {permissionLevel ?? 'unknown'}. Reducing permission does not retroactively sandbox an active external operation.</p>
      <label htmlFor={permissionId}>Requested permission</label>
      <select id={permissionId} value={newLevel} disabled={!permissionReady || busy || Boolean(challenge) || takeoverReview} onChange={(event) => {
        const level = methodCatalog['permission.issue'].inputSchema.shape.newLevel.parse(event.target.value); setNewLevel(level);
      }}><option value="read-only">Read only</option><option value="edit">Edit</option><option value="full-access">Full access</option></select>
      <button ref={permissionButton} type="button" disabled={!permissionReady || busy || Boolean(challenge) || takeoverReview || newLevel === permissionLevel || reviewLimitReached} onClick={() => void requestPermission()}>Request permission review</button>
      {reviewLimitReached && <p>Permission review limit reached for this view. Refresh the host scope before requesting another challenge.</p>}
      {challenge && <div className="connection-inline-review" role="group" aria-label="Permission confirmation">
        <p>Host: {hostName} · Workspace: {workspace?.label} · Session: {challenge.sessionId}</p>
        <p>Action: runtime.setPermission · {challenge.oldLevel} → {challenge.newLevel}</p>
        <p>{expired ? 'Challenge expired. Cancel and request a new review.' : 'One-use host challenge. Cancel is the safe default.'}</p>
        <div className="connection-actions"><button ref={cancel} type="button" onClick={cancelPermission}>Cancel</button>
          <button type="button" disabled={!challengeCurrent || busy} onClick={() => void confirmPermission()}>Confirm permission change</button></div>
      </div>}
    </fieldset>
    {originalRequestId && <div className="connection-inline-review" role="group" aria-label="Original command review">
      <p>Original request: {originalRequestId}. An unknown outcome is not a failed execution. Do not resend.</p>
      <button type="button" disabled={!ready || busy || !onReviewOriginal} onClick={() => void reviewOriginal()}>Review original request</button>
    </div>}
    {message && <p role="status" aria-live="polite">{message}</p>}
    {error && <p className="connection-error" role="alert">{error}</p>}
  </section>;
}
