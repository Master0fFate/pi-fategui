import { z } from 'zod';
import { mutationRequestIdSchema, uuidSchema } from './requestIds';
import { errorCodeSchema } from './errors';
import { operationReceiptSchema } from './hostOperations';
const revisionSchema = z.number().int().nonnegative().safe();
const levelSchema = z.enum(['read-only', 'edit', 'full-access']);
/** Actual confirmed atomic-grant outcome, bound to the ORIGINAL challenge and admission tuple. */
export const permissionReceiptSchema = z.object({ kind: z.literal('permission'), requestId: mutationRequestIdSchema,
  durability: z.literal('journaled'), outcome: z.literal('applied'), challengeId: uuidSchema,
  workspaceId: uuidSchema, workspaceGeneration: revisionSchema, sessionId: uuidSchema,
  selectionRevision: revisionSchema, controlGeneration: revisionSchema, oldLevel: levelSchema, newLevel: levelSchema }).strict();

/** Bounded public outcome; never a RuntimeState, prompt, diff, or provider response. */
export const mutationReceiptSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('prompt'), requestId: mutationRequestIdSchema, durability: z.literal('journaled'), outcome: z.enum(['accepted', 'not-accepted']), sessionId: uuidSchema, runId: uuidSchema, viewRevision: revisionSchema }).strict(),
  z.object({ kind: z.literal('abort'), requestId: mutationRequestIdSchema, durability: z.literal('journaled'), outcome: z.enum(['abort-reported', 'nothing-to-abort']), sessionId: uuidSchema, viewRevision: revisionSchema }).strict(),
  z.object({ kind: z.literal('selection'), requestId: mutationRequestIdSchema, durability: z.literal('journaled'), outcome: z.literal('selected'), sessionId: uuidSchema, selectionRevision: revisionSchema, viewRevision: revisionSchema }).strict(),
  operationReceiptSchema.extend({ durability: z.literal('journaled') }).strict(),
  permissionReceiptSchema,
]);
export type MutationReceipt = z.infer<typeof mutationReceiptSchema>;
export const commandStatusSchema = z.object({ state: z.enum(['absent', 'reserved', 'admitted', 'settled', 'rejected', 'outcome_unknown']),
  receipt: mutationReceiptSchema.nullable(), rejectionCode: errorCodeSchema.nullable() }).strict().refine((status) =>
  (status.state === 'settled') === (status.receipt !== null) && (status.state === 'rejected') === (status.rejectionCode !== null));
export type CommandStatus = z.infer<typeof commandStatusSchema>;
