import { isAdapterCreatedContext, type RequestContext } from '../dispatch/RequestContext';
import { ProtocolFault } from '../../shared/protocol/errors';
import { millisecondsSchema, uuidSchema } from '../../shared/protocol/requestIds';

export const CONTROL_LEASE_MS = 15_000;
export const CONTROL_RENEW_INTERVAL_MS = 5_000;

export interface ControlLease {
  readonly workspaceId: string;
  readonly principalId: string;
  /** Server-issued ticket identity, never a field supplied by the command body. */
  readonly clientId: string;
  readonly generation: number;
  readonly expiresAt: number;
}
export interface ControlTransition {
  readonly previous: ControlLease | null;
  readonly current: ControlLease | null;
  readonly generation: number;
}

interface Slot { generation: number; lease: ControlLease | null }

/** In-memory, single-host control state. All transitions and checks are synchronous; no awaits
 * may occur between a queue-head check and entry to a mutating handler. A boot starts a new epoch.
 * The caller owns authentication, membership, disconnection hooks and event publication.
 */
export class WorkspaceControl {
  private readonly slots = new Map<string, Slot>();

  constructor(private readonly options: {
    readonly isMember: (context: RequestContext, workspaceId: string) => boolean;
    /** Trusted host policy. Default: takeover is disabled. Never derive this from request JSON. */
    readonly mayTakeOver?: (context: RequestContext, previous: ControlLease) => boolean;
    readonly now?: () => number;
  }) {}

  private time(): number { return millisecondsSchema.parse((this.options.now ?? Date.now)()); }
  private identity(context: RequestContext, workspaceId: string, now: number): void {
    if (!isAdapterCreatedContext(context) || context.adapter !== 'authenticated-server' || context.expiresAt <= now) throw new ProtocolFault('UNAUTHENTICATED');
    if (!uuidSchema.safeParse(workspaceId).success) throw new ProtocolFault('INVALID_REQUEST');
    if (this.options.isMember(context, workspaceId) !== true) throw new ProtocolFault('FORBIDDEN');
  }
  private slot(workspaceId: string): Slot {
    let slot = this.slots.get(workspaceId);
    if (!slot) { slot = { generation: 0, lease: null }; this.slots.set(workspaceId, slot); }
    return slot;
  }
  private expire(slot: Slot, now: number): void {
    if (slot.lease && slot.lease.expiresAt <= now) { slot.generation += 1; slot.lease = null; }
  }
  private transition(slot: Slot, workspaceId: string, context: RequestContext | null, now: number): ControlTransition {
    const previous = slot.lease;
    slot.generation += 1;
    slot.lease = context === null ? null : Object.freeze({ workspaceId, principalId: context.principalId,
      clientId: context.clientId, generation: slot.generation, expiresAt: Math.min(now + CONTROL_LEASE_MS, context.expiresAt) });
    return Object.freeze({ previous, current: slot.lease, generation: slot.generation });
  }
  private owns(lease: ControlLease | null, context: RequestContext): boolean {
    return lease !== null && lease.principalId === context.principalId && lease.clientId === context.clientId;
  }

  /** Observers must explicitly claim. A second client cannot silently steal control. */
  claim(context: RequestContext, workspaceId: string): ControlTransition {
    const now = this.time(); this.identity(context, workspaceId, now);
    const slot = this.slot(workspaceId); this.expire(slot, now);
    if (slot.lease) throw new ProtocolFault('CONTROL_REQUIRED');
    return this.transition(slot, workspaceId, context, now);
  }

  /** Renewal does not alter the generation. Stale/expired renewals cannot recreate a lease. */
  renew(context: RequestContext, workspaceId: string, generation: number): ControlLease {
    const now = this.time(); this.identity(context, workspaceId, now);
    const slot = this.slot(workspaceId); this.expire(slot, now);
    if (!Number.isSafeInteger(generation) || !this.owns(slot.lease, context) || slot.generation !== generation) throw new ProtocolFault('CONTROL_REQUIRED');
    slot.lease = Object.freeze({ ...slot.lease!, expiresAt: Math.min(now + CONTROL_LEASE_MS, context.expiresAt) });
    return slot.lease;
  }

  /** Explicit release requires the exact current generation and authenticated controller. */
  release(context: RequestContext, workspaceId: string, generation: number): ControlTransition {
    const now = this.time(); this.identity(context, workspaceId, now);
    const slot = this.slot(workspaceId); this.expire(slot, now);
    if (!Number.isSafeInteger(generation) || !this.owns(slot.lease, context) || slot.generation !== generation) throw new ProtocolFault('CONTROL_REQUIRED');
    return this.transition(slot, workspaceId, null, now);
  }

  /** Host-authorized takeover fences the prior controller. It does not cancel its active run. */
  takeover(context: RequestContext, workspaceId: string): ControlTransition {
    const now = this.time(); this.identity(context, workspaceId, now);
    const slot = this.slot(workspaceId); this.expire(slot, now);
    const previous = slot.lease;
    if (!previous) throw new ProtocolFault('CONTROL_REQUIRED');
    if (this.owns(previous, context) || this.options.mayTakeOver?.(context, previous) !== true) throw new ProtocolFault('FORBIDDEN');
    // Even trusted callbacks can reenter this object. Do not transfer a newer controller.
    if (slot.lease !== previous || slot.generation !== previous.generation) throw new ProtocolFault('CONTROL_REQUIRED');
    return this.transition(slot, workspaceId, context, now);
  }

  /** Called with the server-created identity when its connection/ticket is revoked.
   * No membership check: membership itself may have been revoked already.
   */
  disconnect(context: RequestContext): readonly ControlTransition[] {
    if (!isAdapterCreatedContext(context) || context.adapter !== 'authenticated-server') throw new ProtocolFault('UNAUTHENTICATED');
    const now = this.time();
    const changes: ControlTransition[] = [];
    for (const [workspaceId, slot] of this.slots) {
      if (this.owns(slot.lease, context)) changes.push(this.transition(slot, workspaceId, null, now));
    }
    return changes;
  }

  /** Synchronous queue-head / Dispatcher resolver check. Never trust an envelope owner ID. */
  hasControl(context: RequestContext, workspaceId: string, generation: number): boolean {
    const now = this.time();
    if (!isAdapterCreatedContext(context) || context.adapter !== 'authenticated-server' || context.expiresAt <= now
      || !uuidSchema.safeParse(workspaceId).success || this.options.isMember(context, workspaceId) !== true) return false;
    const slot = this.slots.get(workspaceId);
    if (!slot) return false;
    this.expire(slot, now);
    return Number.isSafeInteger(generation) && slot.generation === generation && this.owns(slot.lease, context);
  }
}
