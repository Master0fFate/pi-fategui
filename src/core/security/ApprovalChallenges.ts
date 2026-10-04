import { isAdapterCreatedContext, type RequestContext } from '../dispatch/RequestContext';
import { ProtocolFault } from '../../shared/protocol/errors';
import { millisecondsSchema, uuidSchema } from '../../shared/protocol/requestIds';
import { permissionRank } from './PermissionPolicy';
import type { PermissionLevel } from '../../shared/contracts/ipc';

export const APPROVAL_CHALLENGE_MS = 60_000;
export const MAX_PENDING_APPROVALS = 1024;

export interface ApprovalTarget {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly action: string;
  readonly oldLevel: PermissionLevel;
  readonly newLevel: PermissionLevel;
  /** Bound at issue and confirmation; a later reclaim by the same client cannot reuse a nonce. */
  readonly controlGeneration?: number;
  readonly selectionRevision?: number;
}
export interface ApprovalChallenge extends ApprovalTarget {
  readonly id: string;
  readonly principalId: string;
  /** The ticket-backed identity, not a browser-selected owner ID. */
  readonly clientId: string;
  readonly hostMaximum: PermissionLevel;
  readonly expiresAt: number;
}
export interface ApprovalState {
  readonly trusted: boolean;
  readonly storageHealthy: boolean;
  /** The currently active level, not an uncommitted persistent write. */
  readonly currentLevel: PermissionLevel;
  /** Host-owned configuration. Network profiles default to edit in the host policy. */
  readonly hostMaximum: PermissionLevel;
}

function validLevel(level: unknown): level is PermissionLevel {
  return level === 'read-only' || level === 'edit' || level === 'full-access';
}
function validTarget(target: ApprovalTarget): boolean {
  return typeof target === 'object' && target !== null && uuidSchema.safeParse(target.workspaceId).success && uuidSchema.safeParse(target.sessionId).success
    && typeof target.action === 'string' && target.action.length > 0 && target.action.length <= 128
    && validLevel(target.oldLevel) && validLevel(target.newLevel)
    && (target.controlGeneration === undefined || Number.isSafeInteger(target.controlGeneration) && target.controlGeneration >= 0)
    && (target.selectionRevision === undefined || Number.isSafeInteger(target.selectionRevision) && target.selectionRevision >= 0);
}
function validState(state: ApprovalState): boolean {
  return typeof state?.trusted === 'boolean' && typeof state.storageHealthy === 'boolean'
    && validLevel(state.currentLevel) && validLevel(state.hostMaximum);
}

/** Memory-only, one-use confirmations. The host supplies authoritative state and persistence;
 * neither a boolean confirmation nor any request field can change the host ceiling.
 * The caller must serialize independent permission changes for this session with its grant store.
 */
export class ApprovalChallenges {
  private readonly pending = new Map<string, ApprovalChallenge>();
  private readonly saving = new Set<string>();
  private readonly inFlight = new Map<string, ApprovalChallenge>();
  private readonly revoked = new Set<string>();

  constructor(private readonly options: {
    /** Synchronous membership, current-controller and session-target check. */
    readonly mayApprove: (context: RequestContext, target: ApprovalTarget) => boolean;
    /** Synchronous trusted host lookup; must check project trust and store health. */
    readonly readState: (context: RequestContext, target: ApprovalTarget) => ApprovalState;
    readonly now?: () => number;
  } & ({
    /** Legacy split persistence/activation: recheck authority AFTER persistence. */
    readonly save: (context: RequestContext, target: ApprovalTarget) => Promise<void>;
    readonly activate: (context: RequestContext, target: ApprovalTarget) => void;
    readonly atomicGrant?: never;
  } | {
    /** Existing runtime transaction: fences its session, persists once, then publishes tools.
     * A consumed confirmation is admitted BEFORE awaiting this operation. */
    readonly atomicGrant: (context: RequestContext, target: ApprovalTarget) => Promise<void>;
    readonly save?: never;
    readonly activate?: never;
  })) {}

  get supportsAtomicGrant(): boolean { return typeof this.options.atomicGrant === 'function'; }

  private time(): number { return millisecondsSchema.parse((this.options.now ?? Date.now)()); }
  private identity(context: RequestContext, target: ApprovalTarget, now: number): void {
    if (!isAdapterCreatedContext(context) || context.adapter !== 'authenticated-server' || context.expiresAt <= now) throw new ProtocolFault('UNAUTHENTICATED');
    if (!validTarget(target)) throw new ProtocolFault('INVALID_REQUEST');
  }
  private current(context: RequestContext, target: ApprovalTarget, expectedMaximum?: PermissionLevel): ApprovalState {
    const state = this.options.readState(context, target);
    if (!validState(state) || !state.trusted || !state.storageHealthy) throw new ProtocolFault('PERMISSION_REQUIRED');
    if (state.currentLevel !== target.oldLevel || expectedMaximum !== undefined && state.hostMaximum !== expectedMaximum
      // The same scoped transaction handles reductions and elevations. Reject
      // no-ops, not reductions; the destination must still obey the host cap.
      || target.newLevel === target.oldLevel
      || permissionRank[target.newLevel] > permissionRank[state.hostMaximum]) throw new ProtocolFault('PERMISSION_REQUIRED');
    return state;
  }
  private prune(now: number): void {
    for (const [id, challenge] of this.pending) if (challenge.expiresAt <= now) this.pending.delete(id);
  }
  private key(target: ApprovalTarget): string { return `${target.workspaceId}:${target.sessionId}`; }
  private clean(target: ApprovalTarget): ApprovalTarget {
    // Pass only reviewed fields to trusted callbacks; do not forward arbitrary JSON properties.
    return Object.freeze({ workspaceId: target.workspaceId, sessionId: target.sessionId, action: target.action,
      oldLevel: target.oldLevel, newLevel: target.newLevel,
      ...(target.controlGeneration === undefined ? {} : { controlGeneration: target.controlGeneration }),
      ...(target.selectionRevision === undefined ? {} : { selectionRevision: target.selectionRevision }) });
  }

  /** Host calls after it verifies control, membership and the requested target. No grant yet. */
  issue(context: RequestContext, target: ApprovalTarget): ApprovalChallenge {
    const now = this.time(); this.identity(context, target, now);
    const clean = this.clean(target);
    this.prune(now);
    if (this.pending.size >= MAX_PENDING_APPROVALS || this.saving.has(this.key(clean))) throw new ProtocolFault('BUSY');
    if (this.options.mayApprove(context, clean) !== true) throw new ProtocolFault('CONTROL_REQUIRED');
    const state = this.current(context, clean);
    const challenge: ApprovalChallenge = Object.freeze({ ...clean, id: uuidSchema.parse(globalThis.crypto.randomUUID()),
      principalId: context.principalId, clientId: context.clientId, hostMaximum: state.hostMaximum,
      expiresAt: Math.min(now + APPROVAL_CHALLENGE_MS, context.expiresAt) });
    this.pending.set(challenge.id, challenge);
    return challenge;
  }

  /** A matching reply consumes its nonce BEFORE awaiting storage. Reuse, cross-client,
   * cross-session and cross-action replies cannot grant anything.
   * Control/membership must be checked by the host at the admission seam as well.
   */
  async consume(context: RequestContext, id: string, target: ApprovalTarget, onAdmitted?: () => void): Promise<void> {
    const now = this.time(); this.identity(context, target, now);
    const clean = this.clean(target);
    if (!uuidSchema.safeParse(id).success) throw new ProtocolFault('PERMISSION_REQUIRED');
    const challenge = this.pending.get(id);
    if (!challenge || challenge.expiresAt <= now) { this.pending.delete(id); throw new ProtocolFault('PERMISSION_REQUIRED'); }
    if (challenge.principalId !== context.principalId || challenge.clientId !== context.clientId
      || challenge.workspaceId !== clean.workspaceId || challenge.sessionId !== clean.sessionId
      || challenge.action !== clean.action || challenge.oldLevel !== clean.oldLevel || challenge.newLevel !== clean.newLevel
      || challenge.controlGeneration !== clean.controlGeneration || challenge.selectionRevision !== clean.selectionRevision) throw new ProtocolFault('PERMISSION_REQUIRED');
    this.pending.delete(id);
    const key = this.key(clean);
    if (this.saving.has(key)) throw new ProtocolFault('BUSY');
    this.saving.add(key);
    this.inFlight.set(id, challenge);
    try {
      if (this.options.mayApprove(context, clean) !== true) throw new ProtocolFault('CONTROL_REQUIRED');
      this.current(context, clean, challenge.hostMaximum);
      if (this.options.atomicGrant) {
        // Admission is the last synchronous authority check. The runtime's own
        // permissionChange fence performs one durable write before publication.
        // Like an admitted run, this transaction may complete after lease expiry
        // or connection loss. A pending/unadmitted nonce does not survive either.
        onAdmitted?.();
        try { await this.options.atomicGrant(context, clean); }
        catch (error) { throw error instanceof ProtocolFault ? error : new ProtocolFault('OUTCOME_UNKNOWN'); }
        return;
      }
      onAdmitted?.();
      try { await this.options.save!(context, clean); }
      catch { throw new ProtocolFault('STORAGE_UNAVAILABLE'); }
      // Split-mode storage can take longer than the challenge lifetime, and host policy can change while it writes.
      // A successful write alone never enables tools. Host resolution must still intersect its cap.
      const afterSave = this.time();
      if (afterSave >= challenge.expiresAt || context.expiresAt <= afterSave || this.revoked.has(id)) throw new ProtocolFault('PERMISSION_REQUIRED');
      if (this.options.mayApprove(context, clean) !== true) throw new ProtocolFault('CONTROL_REQUIRED');
      this.current(context, clean, challenge.hostMaximum);
      this.options.activate!(context, clean);
    } finally { this.inFlight.delete(id); this.revoked.delete(id); this.saving.delete(key); }
  }

  /** Revoke outstanding confirmations on connection loss, logout or credential rotation. */
  revokeClient(context: RequestContext): void {
    if (!isAdapterCreatedContext(context) || context.adapter !== 'authenticated-server') throw new ProtocolFault('UNAUTHENTICATED');
    for (const [id, challenge] of this.pending) if (challenge.principalId === context.principalId && challenge.clientId === context.clientId) this.pending.delete(id);
    for (const [id, challenge] of this.inFlight) if (challenge.principalId === context.principalId && challenge.clientId === context.clientId) this.revoked.add(id);
  }
}
