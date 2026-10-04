import { z } from 'zod';
import { permissionLevelSchema, thinkingLevelSchema } from '../contracts/ipc';
import { eventCursorSchema } from './events';

export const SNAPSHOT_PAGE_BYTES = 1024 * 1024;
export const SNAPSHOT_TOTAL_BYTES = 32 * SNAPSHOT_PAGE_BYTES;
export const SNAPSHOT_TTL_MS = 60_000;
const id = z.string().uuid();
export const snapshotScopeSchema = z.object({
  principalId: z.string().min(1).max(250), clientId: z.string().min(1).max(250),
  workspaceId: z.string().min(1).max(250), workspaceGeneration: z.number().int().nonnegative(),
  serverEpoch: z.string().min(1).max(250), sessionId: z.string().min(1).max(500),
  /** Provided by the trusted workspace adapter, never a client-controlled host path. */
  projectPath: z.string().min(1),
}).strict();
export const historyScopeSchema = snapshotScopeSchema.extend({ selectionRevision: z.number().int().nonnegative().safe().optional() });
export const snapshotItemSchema = z.object({
  kind: z.enum(['message', 'tool']), id: z.string().max(500), role: z.enum(['user', 'assistant', 'system']).optional(),
  name: z.string().max(200).optional(), status: z.string().max(40).optional(), text: z.string().max(16_384),
  timestamp: z.number().finite(), clipped: z.boolean(), mediaOmitted: z.boolean(), historyOmitted: z.number().int().nonnegative().optional(),
}).strict();
const summarySchema = z.object({ id: z.string().max(500), title: z.string().max(240), status: z.string().max(60),
  detail: z.string().max(300).optional(), required: z.boolean().optional(), verified: z.boolean().optional() }).strict();
export const snapshotHeaderSchema = z.object({
  version: z.literal(1), snapshotId: id, capturedAt: z.number().finite(), expiresAt: z.number().finite(),
  workspaceId: z.string().min(1).max(250), workspaceGeneration: z.number().int().nonnegative(), serverEpoch: z.string().min(1).max(250),
  sessionId: z.string().max(500).nullable(), eventCursor: z.number().int().nonnegative().nullable(),
  /** Host admission revision; required before a browser may form a session mutation. */
  selectionRevision: z.number().int().nonnegative().safe().optional(),
  /** Separate from the Pi eventCursor: identity and high-water of the network stream. */
  eventStream: eventCursorSchema.optional(),
  pageIds: z.array(id).min(1).max(32),
  controls: z.object({ status: z.enum(['disconnected', 'initializing', 'ready', 'auth-required', 'error']), streaming: z.boolean(), activeSessionRunning: z.boolean(), runningSessionCount: z.number().int().nonnegative(), permissionLevel: permissionLevelSchema, thinkingLevel: thinkingLevelSchema, model: z.object({ provider: z.string().max(200), id: z.string().max(500) }).strict().nullable(), pendingModel: z.object({ provider: z.string().max(200), id: z.string().max(500) }).strict().nullable(), pendingThinkingLevel: thinkingLevelSchema.nullable(), sessionOperation: z.boolean(), queue: z.object({ steering: z.number().int().nonnegative(), followUp: z.number().int().nonnegative(), pending: z.number().int().nonnegative(), held: z.number().int().nonnegative(), recovered: z.number().int().nonnegative() }).strict() }).strict(),
  goal: z.object({ id: z.string().max(500), revision: z.number().int().nonnegative(), status: z.string().max(60), phase: z.string().max(60),
    objective: z.string().max(500).optional(), executionState: z.string().max(60).optional(), continuationPending: z.boolean().optional(),
    criteria: z.array(summarySchema).max(32).optional() }).strict().nullable(),
  taskRevision: z.number().int().nonnegative().nullable(), tasks: z.array(summarySchema).max(200),
  agents: z.array(summarySchema).max(500),
  omissions: z.object({ history: z.boolean(), media: z.boolean(), clippedItems: z.number().int().nonnegative(), agentRows: z.boolean(), taskRows: z.boolean(),
    goalText: z.boolean(), taskText: z.boolean(), agentText: z.boolean(), queueContents: z.boolean() }).strict(),
  warnings: z.array(z.string().max(300)).max(12),
}).strict();
export const snapshotPageSchema = z.object({ version: z.literal(1), snapshotId: id, pageId: id, index: z.number().int().min(0).max(31),
  header: snapshotHeaderSchema.optional(), items: z.array(snapshotItemSchema).max(5_000), nextPageId: id.nullable(),
}).strict();
export const historyPageSchema = z.object({ version: z.literal(1), sessionId: z.string().min(1).max(500),
  items: z.array(snapshotItemSchema).max(128), nextPageId: id.nullable(), mediaOmitted: z.boolean(), oversizedItems: z.number().int().nonnegative(),
}).strict();
export type SnapshotScope = z.infer<typeof snapshotScopeSchema>;
export type HistoryScope = z.infer<typeof historyScopeSchema>;
export type SnapshotItem = z.infer<typeof snapshotItemSchema>;
export type SnapshotHeader = z.infer<typeof snapshotHeaderSchema>;
export type SnapshotPage = z.infer<typeof snapshotPageSchema>;
export type HistoryPage = z.infer<typeof historyPageSchema>;
