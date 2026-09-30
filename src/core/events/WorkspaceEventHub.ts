import { randomUUID } from 'node:crypto';
import type { SnapshotPage, SnapshotScope } from '../../shared/protocol/snapshots';
import { snapshotScopeSchema } from '../../shared/protocol/snapshots';
import { EVENT_FRAME_BYTES, EVENT_RING_BYTES, EVENT_RING_COUNT, EVENT_UNSENT_BYTES, EVENT_UNSENT_COUNT,
  eventCursorSchema, scopedEventSchema, type EventCursor, type EventEnvelope, type ScopedHostEvent } from '../../shared/protocol/events';
import type { WorkspaceSnapshotService } from '../views/WorkspaceSnapshotService';
import { ScopedDomainEvents } from './ScopedDomainEvents';

interface Stored { readonly sequence: number; readonly wire: string; readonly bytes: number }
interface Stream {
  readonly generation: number;
  readonly id: string;
  sequence: number;
  oldest: number;
  bytes: number;
  ring: Stored[];
}
export interface EventLimits { readonly ringCount?: number; readonly ringBytes?: number; readonly unsentCount?: number; readonly unsentBytes?: number }
export interface EventSubscription {
  /** Read and release pending envelopes; the transport must bound its own unsent socket queue too. */
  drain(): EventEnvelope[];
  close(): void;
}
class Subscription implements EventSubscription {
  private pending: Stored[] = [];
  private bytes = 0;
  private failed = false;
  private closed = false;
  constructor(readonly scope: SnapshotScope, readonly streamId: string, private readonly limitCount: number,
    private readonly limitBytes: number, private readonly remove: (subscription: Subscription) => void) {}
  get active(): boolean { return !this.failed && !this.closed; }
  push(item: Stored): void {
    if (!this.active) return;
    if (this.pending.length >= this.limitCount || this.bytes + item.bytes > this.limitBytes) { this.fail(); return; }
    this.pending.push(item);
    this.bytes += item.bytes;
  }
  discardThrough(sequence: number): void {
    if (!this.active) throw new Error('RESYNC_REQUIRED');
    while (this.pending[0] && this.pending[0].sequence <= sequence) this.bytes -= this.pending.shift()!.bytes;
  }
  drain(): EventEnvelope[] {
    if (this.failed) throw new Error('RESYNC_REQUIRED');
    if (this.closed) return [];
    const values = this.pending.map(({ wire }) => JSON.parse(wire) as EventEnvelope);
    this.pending = [];
    this.bytes = 0;
    return values;
  }
  fail(): void { if (!this.closed) { this.failed = true; this.close(); } }
  close(): void { if (!this.closed) { this.closed = true; this.pending = []; this.bytes = 0; this.remove(this); } }
}
const positiveLimit = (value: number | undefined, fallback: number, maximum: number): number => {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw new Error('Invalid event memory bound.');
  return limit;
};

/** One Node-owned event sequence per workspace generation. No runtime mutation or command journal lives here. */
export class WorkspaceEventHub {
  readonly serverEpoch: string;
  private readonly streams = new Map<string, Stream>();
  private readonly listeners = new Set<Subscription>();
  private readonly stopSource: () => void;
  private readonly ringCount: number;
  private readonly ringBytes: number;
  private readonly unsentCount: number;
  private readonly unsentBytes: number;
  private disposed = false;

  constructor(source: ScopedDomainEvents, epoch: string = randomUUID(), limits: EventLimits = {}) {
    this.serverEpoch = eventCursorSchema.shape.serverEpoch.parse(epoch);
    this.ringCount = positiveLimit(limits.ringCount, EVENT_RING_COUNT, EVENT_RING_COUNT);
    this.ringBytes = positiveLimit(limits.ringBytes, EVENT_RING_BYTES, EVENT_RING_BYTES);
    this.unsentCount = positiveLimit(limits.unsentCount, EVENT_UNSENT_COUNT, EVENT_UNSENT_COUNT);
    this.unsentBytes = positiveLimit(limits.unsentBytes, EVENT_UNSENT_BYTES, EVENT_UNSENT_BYTES);
    this.stopSource = source.subscribe((event) => this.publish(event));
  }

  /** Trusted host adapter seam. This changes no lease/run and uses the existing workspace sequence. */
  invalidateControl(origin: ScopedHostEvent['origin'], generation: number, timestamp = Date.now()): void {
    const event = scopedEventSchema.parse({ kind: 'control', origin, event: { type: 'control.changed', generation, timestamp } });
    this.publish(event);
  }
  get subscriberCount(): number { return this.listeners.size; }
  /** Retained wire bytes, including framing; oldest is the first still available envelope. */
  retained(scope: SnapshotScope): { count: number; bytes: number; oldest: number } {
    const stream = this.lookup(scope);
    return { count: stream.ring.length, bytes: stream.bytes, oldest: stream.oldest };
  }
  position(scope: SnapshotScope): EventCursor {
    const parsed = this.checkScope(scope);
    const stream = this.lookup(parsed);
    return { serverEpoch: this.serverEpoch, workspaceId: parsed.workspaceId, workspaceGeneration: parsed.workspaceGeneration,
      streamId: stream.id, sequence: stream.sequence };
  }

  /** Cursor 0 is valid only while the initial events remain; missing positions never mean 'start wherever'. */
  subscribe(scope: SnapshotScope, after?: EventCursor): EventSubscription {
    const parsed = this.checkScope(scope);
    const stream = this.lookup(parsed);
    const cursor = after ? eventCursorSchema.parse(after) : this.cursor(parsed, stream, 0);
    if (cursor.serverEpoch !== this.serverEpoch || cursor.workspaceId !== parsed.workspaceId
      || cursor.workspaceGeneration !== parsed.workspaceGeneration || cursor.streamId !== stream.id
      || cursor.sequence < stream.oldest - 1 || cursor.sequence > stream.sequence) throw new Error('RESYNC_REQUIRED');
    const subscription = this.register(parsed, stream);
    for (const item of stream.ring) if (item.sequence > cursor.sequence) subscription.push(item);
    if (!subscription.active) throw new Error('RESYNC_REQUIRED');
    return subscription;
  }

  /** The subscription exists before flush. Capture and high-water are synchronous, without awaits. */
  subscribeAndSnapshot(scope: SnapshotScope, snapshots: WorkspaceSnapshotService): { snapshot: SnapshotPage; subscription: EventSubscription } {
    const parsed = this.checkScope(scope);
    const stream = this.lookup(parsed);
    const subscription = this.register(parsed, stream);
    let snapshot: SnapshotPage | undefined;
    try {
      snapshot = snapshots.capture(parsed, () => this.position(parsed));
      const highWater = snapshot.header?.eventStream;
      if (!highWater || highWater.streamId !== stream.id || !subscription.active) throw new Error('RESYNC_REQUIRED');
      subscription.discardThrough(highWater.sequence);
      return { snapshot, subscription };
    } catch (error) {
      if (snapshot) snapshots.cancel(parsed, snapshot.snapshotId);
      subscription.close();
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopSource();
    for (const subscription of [...this.listeners]) subscription.fail();
    this.streams.clear();
  }

  private cursor(scope: SnapshotScope, stream: Stream, sequence: number): EventCursor {
    return { serverEpoch: this.serverEpoch, workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration,
      streamId: stream.id, sequence };
  }
  private checkScope(input: SnapshotScope): SnapshotScope {
    if (this.disposed) throw new Error('RESYNC_REQUIRED');
    const scope = snapshotScopeSchema.parse(input);
    if (scope.serverEpoch !== this.serverEpoch) throw new Error('RESYNC_REQUIRED');
    return scope;
  }
  private lookup(scope: SnapshotScope): Stream {
    const prior = this.streams.get(scope.workspaceId);
    if (prior && prior.generation !== scope.workspaceGeneration) throw new Error('RESYNC_REQUIRED');
    if (prior) return prior;
    return this.replace(scope.workspaceId, scope.workspaceGeneration);
  }
  private replace(workspaceId: string, generation: number): Stream {
    for (const listener of [...this.listeners]) if (listener.scope.workspaceId === workspaceId) listener.fail();
    // Closed desktop projects can accumulate over a long process lifetime.
    // Eviction invalidates cursors instead of retaining unbounded old rings.
    if (!this.streams.has(workspaceId) && this.streams.size >= 8) {
      const oldestId = this.streams.keys().next().value!;
      for (const listener of [...this.listeners]) if (listener.scope.workspaceId === oldestId) listener.fail();
      this.streams.delete(oldestId);
    }
    const stream: Stream = { generation, id: randomUUID(), sequence: 0, oldest: 1, bytes: 0, ring: [] };
    this.streams.delete(workspaceId);
    this.streams.set(workspaceId, stream);
    return stream;
  }
  private register(scope: SnapshotScope, stream: Stream): Subscription {
    // The authenticated transport caps connections at eight. Enforce that limit here too.
    if (this.listeners.size >= 8) throw new Error('BUSY');
    const listener = new Subscription(scope, stream.id, this.unsentCount, this.unsentBytes, (item) => this.listeners.delete(item));
    this.listeners.add(listener);
    return listener;
  }
  private publish(event: ScopedHostEvent): void {
    if (this.disposed) return;
    const { workspaceId, workspaceGeneration } = event.origin;
    const prior = this.streams.get(workspaceId);
    if (prior && workspaceGeneration < prior.generation) return; // A disposed runtime cannot replace its successor.
    let stream = prior && prior.generation === workspaceGeneration ? prior : this.replace(workspaceId, workspaceGeneration);
    // Check serialized size before Zod clones a potentially huge Pi state/media
    // event. A dropped frame rotates the stream and forces a new bounded view.
    let sourceBytes: number;
    try { sourceBytes = Buffer.byteLength(JSON.stringify(event), 'utf8'); }
    catch { this.replace(workspaceId, workspaceGeneration); return; }
    if (sourceBytes > Math.min(EVENT_FRAME_BYTES, this.ringBytes, this.unsentBytes)) {
      this.replace(workspaceId, workspaceGeneration);
      return;
    }
    // A domain payload is validated before assigning a network sequence. JSON wire
    // bytes freeze its value before legacy batching can mutate a source delta.
    const validated = scopedEventSchema.safeParse(event);
    if (!validated.success) { this.replace(workspaceId, workspaceGeneration); return; }
    const sequence = stream.sequence + 1;
    if (!Number.isSafeInteger(sequence)) { this.replace(workspaceId, workspaceGeneration); return; }
    const wire = JSON.stringify({ version: 1, serverEpoch: this.serverEpoch, streamId: stream.id, sequence,
      origin: validated.data.origin, event: validated.data });
    const bytes = Buffer.byteLength(wire, 'utf8');
    if (bytes > EVENT_FRAME_BYTES || bytes > this.ringBytes || bytes > this.unsentBytes) {
      // This event cannot be delivered intact. Invalidate all previous cursors;
      // clients need a fresh bounded snapshot, not a fabricated gap filler.
      this.replace(workspaceId, workspaceGeneration);
      return;
    }
    const stored: Stored = { sequence, wire, bytes };
    stream.sequence = sequence;
    stream.ring.push(stored);
    stream.bytes += bytes;
    while (stream.ring.length > this.ringCount || stream.bytes > this.ringBytes) {
      stream.bytes -= stream.ring.shift()!.bytes;
    }
    stream.oldest = stream.ring[0]?.sequence ?? stream.sequence + 1;
    for (const listener of [...this.listeners]) {
      if (listener.scope.workspaceId === workspaceId && listener.streamId === stream.id) listener.push(stored);
    }
  }
}
