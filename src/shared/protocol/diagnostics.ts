import { z } from 'zod';
import { eventCursorSchema, type EventCursor, type EventEnvelope } from './events';
import { requestIdSchema, uuidSchema } from './requestIds';
import { errorCodeSchema } from './errors';
import { monitorDashboardSchema, type MonitorDashboard, type MonitorItem } from '../contracts/monitorDashboard';

const id = uuidSchema;
const time = z.number().int().nonnegative().safe();
export const diagnosticSchema = z.object({
  method: z.enum(['health', 'auth.exchange', 'auth.session', 'auth.logout', 'admin', 'info', 'command', 'events', 'other']),
  requestId: requestIdSchema.nullable(), workspaceId: id.nullable(), code: z.union([z.literal('OK'), errorCodeSchema]),
  durationMs: time, count: z.number().int().nonnegative().max(100_000),
}).strict();
export type Diagnostic = z.infer<typeof diagnosticSchema>;

/** M3 exposes only operation metadata over WebSocket. A private transcript,
 * tool result, model/provider error, monitor title or raw runtime state is NOT a diagnostic.
 * Keep stream identity and sequence so a subscriber can still detect gaps. */
export const networkEventSchema = z.object({
  version: z.literal(1), serverEpoch: id, streamId: id, sequence: z.number().int().positive().safe(),
  origin: z.object({ workspaceId: id, workspaceGeneration: z.number().int().nonnegative(), sessionId: id.nullable() }).strict(),
  category: z.enum(['pi', 'goal', 'task', 'control']),
  eventType: z.string().min(1).max(64).regex(/^[a-z][a-z.-]*$/u),
  controlGeneration: z.number().int().positive().safe().optional(),
}).strict().refine((event) => event.category === 'control'
  ? event.eventType === 'control.changed' && event.controlGeneration !== undefined : event.controlGeneration === undefined);
export type NetworkEvent = z.infer<typeof networkEventSchema>;

export class NetworkEventReplayGate {
  private sequence: number;
  private readonly cursor: EventCursor;
  constructor(highWater: EventCursor) {
    this.cursor = eventCursorSchema.parse(highWater);
    this.sequence = this.cursor.sequence;
  }
  accept(input: NetworkEvent): NetworkEvent | null {
    const event = networkEventSchema.parse(input);
    if (event.serverEpoch !== this.cursor.serverEpoch || event.streamId !== this.cursor.streamId
      || event.origin.workspaceId !== this.cursor.workspaceId
      || event.origin.workspaceGeneration !== this.cursor.workspaceGeneration) throw new Error('RESYNC_REQUIRED');
    if (event.sequence <= this.sequence) return null;
    if (event.sequence !== this.sequence + 1) throw new Error('RESYNC_REQUIRED');
    this.sequence = event.sequence;
    return event;
  }
}

export function projectNetworkEvent(input: EventEnvelope): NetworkEvent {
  // WorkspaceEventHub has already validated the source before assigning this
  // sequence. Parse only the small allowlisted projection, not its raw body.
  return networkEventSchema.parse({ version: 1, serverEpoch: input.serverEpoch, streamId: input.streamId,
    sequence: input.sequence, origin: input.origin, category: input.event.kind, eventType: input.event.event.type,
    ...(input.event.kind === 'control' ? { controlGeneration: input.event.event.generation } : {}) });
}

const monitorItem = z.object({ id: z.string().regex(/^[a-f0-9]{32}$/u), source: z.enum(['runs', 'teams', 'tasks', 'activity']),
  state: z.enum(['normal', 'active', 'attention']), title: z.string().max(32), updatedAt: z.number().finite(),
  navigation: z.object({ kind: z.enum(['run', 'team-node', 'task', 'event']), expiresAt: time }).strict().optional() }).strict();
export const networkMonitorSchema = z.object({ revision: z.string().min(1).max(80), sessionId: z.string().min(1).max(500),
  selectionRevision: z.number().int().nonnegative().safe(), checkedAt: z.number().finite(),
  overall: z.enum(['normal', 'active', 'attention', 'unknown']),
  sources: monitorDashboardSchema.shape.sources,
  sourceCheckedAt: monitorDashboardSchema.shape.sourceCheckedAt,
  counts: monitorDashboardSchema.shape.counts,
  section: monitorDashboardSchema.shape.section, total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(), limit: z.number().int().positive(), unchanged: z.boolean(),
  items: z.array(monitorItem).max(100),
}).strict();
export type NetworkMonitor = z.infer<typeof networkMonitorSchema>;

const sourceLabel = { runs: 'Run', teams: 'Agent', tasks: 'Task', activity: 'Activity' } as const;
/** This is a page-row key, NOT a durable object ID or authorization token.
 * Hash only public scope/page/position metadata; never hash raw IDs into a
 * dictionary-searchable wire value. A changed page revision invalidates its keys. */
async function scopedRowKey(scope: readonly [string, number, string, string, number]): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(scope)));
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
/** Compact, explicit allowlist. Source order, state, times, and fixed action
 * guidance survive; no source title/detail/path/ID/ref can cross. Selection
 * and revision bind these display-only row keys, not a navigation capability. */
export async function projectMonitorForNetwork(input: MonitorDashboard, selection: { sessionId: string; selectionRevision: number },
  issueNavigation?: (item: MonitorItem) => { id: string; kind: MonitorItem['ref']['kind']; expiresAt: number }): Promise<NetworkMonitor> {
  const dashboard = monitorDashboardSchema.parse(input);
  if (dashboard.sessionId !== selection.sessionId) throw new Error('Monitor dashboard session does not match its authenticated scope.');
  const selectionRevision = z.number().int().nonnegative().safe().parse(selection.selectionRevision);
  const revision = `${selectionRevision.toString(36)}:${dashboard.revision}`;
  const items = await Promise.all(dashboard.items.map(async (item, index) => {
    // The authenticated host supplies an authoritative opaque source-ref binding.
    // Standalone diagnostic callers retain display-only keys, NEVER a navigation grant.
    const navigation = issueNavigation?.(item);
    return { id: navigation?.id ?? await scopedRowKey([selection.sessionId, selectionRevision, revision, dashboard.section, dashboard.offset + index]),
      source: item.source, state: item.state, title: sourceLabel[item.source], updatedAt: item.updatedAt,
      ...(navigation ? { navigation: { kind: navigation.kind, expiresAt: navigation.expiresAt } } : {}) };
  }));
  return networkMonitorSchema.parse({ revision, sessionId: selection.sessionId, selectionRevision, checkedAt: dashboard.checkedAt,
    overall: dashboard.overall, sources: dashboard.sources, sourceCheckedAt: dashboard.sourceCheckedAt,
    counts: dashboard.counts, section: dashboard.section, total: dashboard.total, offset: dashboard.offset,
    limit: dashboard.limit, unchanged: dashboard.unchanged, items });
}
