import { z } from 'zod';
import { piEventSchema } from '../contracts/ipc';
import { goalMaxEventSchema } from '../contracts/goalmaxxing';
import { taskEventSchema } from '../contracts/tasks';

export const EVENT_FRAME_BYTES = 1024 * 1024;
export const EVENT_RING_BYTES = 16 * 1024 * 1024;
export const EVENT_RING_COUNT = 10_000;
export const EVENT_UNSENT_BYTES = 8 * 1024 * 1024;
export const EVENT_UNSENT_COUNT = 2_000;

const epoch = z.string().min(1).max(250);
const workspace = z.string().min(1).max(250);
const generation = z.number().int().nonnegative().safe();
const sequence = z.number().int().nonnegative().safe();
const origin = z.object({ workspaceId: workspace, workspaceGeneration: generation, sessionId: z.string().max(500).nullable() }).strict();
export const scopedEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pi'), origin, event: piEventSchema }).strict(),
  z.object({ kind: z.literal('goal'), origin, event: goalMaxEventSchema }).strict(),
  z.object({ kind: z.literal('task'), origin, event: taskEventSchema }).strict(),
  // Host control metadata is not a fabricated Pi/domain event and carries no controller identity.
  z.object({ kind: z.literal('control'), origin, event: z.object({ type: z.literal('control.changed'),
    generation: z.number().int().positive().safe(), timestamp: z.number().int().nonnegative().safe() }).strict() }).strict(),
]);
export type ScopedHostEvent = z.infer<typeof scopedEventSchema>;
export const eventCursorSchema = z.object({ serverEpoch: epoch, workspaceId: workspace, workspaceGeneration: generation,
  streamId: z.string().uuid(), sequence }).strict();
export const eventEnvelopeSchema = z.object({ version: z.literal(1), serverEpoch: epoch, streamId: z.string().uuid(),
  sequence: sequence.positive(), origin, event: scopedEventSchema }).strict().refine(
  (value) => value.origin.workspaceId === value.event.origin.workspaceId
    && value.origin.workspaceGeneration === value.event.origin.workspaceGeneration
    && value.origin.sessionId === value.event.origin.sessionId,
  { message: 'Event origin does not match the envelope.' },
);
export type EventCursor = z.infer<typeof eventCursorSchema>;
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/** Client-side network envelope deduplication, outside existing Pi hydration.
 * A jump in Pi's own cursor is legal after a merged delta; only the network
 * sequence is required to be consecutive. Reset this gate after a new snapshot. */
export class EventReplayGate {
  private readonly base: EventCursor;
  private sequence: number;
  constructor(highWater: EventCursor) {
    this.base = eventCursorSchema.parse(highWater);
    this.sequence = this.base.sequence;
  }
  accept(input: EventEnvelope): EventEnvelope | null {
    const event = eventEnvelopeSchema.parse(input);
    if (event.serverEpoch !== this.base.serverEpoch || event.origin.workspaceId !== this.base.workspaceId
      || event.origin.workspaceGeneration !== this.base.workspaceGeneration || event.streamId !== this.base.streamId) {
      throw new Error('RESYNC_REQUIRED');
    }
    if (event.sequence <= this.sequence) return null;
    if (event.sequence !== this.sequence + 1) throw new Error('RESYNC_REQUIRED');
    this.sequence = event.sequence;
    return event;
  }
}
