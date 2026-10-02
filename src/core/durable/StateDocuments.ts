import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { defineDoc, defineDocFamily } from '@earendil-works/pi-durable';
import type { JsonRepresentation } from '@earendil-works/chord';
import { queuedMessageSchema } from '../../shared/contracts/ipc';
import { taskListSchema } from '../../shared/contracts/tasks';
import { GOALMAX_BRIEF_LIMIT, goalMaxStateSchema } from '../../shared/contracts/goalmaxxing';

export const QUEUE_MAX_BYTES = 64 * 1024 * 1024;
export const TASK_MAX_BYTES = 1024 * 1024;
export const GOAL_MAX_BYTES = 4 * 1024 * 1024;
export const BRIEF_MAX_BYTES = GOALMAX_BRIEF_LIMIT * 4;
export const GOAL_DOCUMENT_MAX_BYTES = 32 * 1024 * 1024;
export const IMPORT_MAX_BYTES = 256 * 1024 * 1024;
export const MAX_ARCHIVES = 10_000;

export const identitySchema = z.object({ projectPath: z.string().min(1).max(32_768), sessionId: z.string().min(1).max(500) }).strict();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const briefsSchema = z.record(z.string().regex(/^brief-[a-f0-9-]+\.txt$/u), z.string().max(GOALMAX_BRIEF_LIMIT));
export const goalEventSchema = z.object({ goalId: z.string().min(1).max(160), revision: z.number().int().positive().safe(), status: z.string().min(1).max(80), phase: z.string().min(1).max(80).optional(), timestamp: z.number().int().nonnegative().safe() }).strict();
export const queueDocumentSchema = identitySchema.extend({ schemaVersion: z.literal(1), instanceSlot: z.number().int().nonnegative().safe(), messages: z.array(queuedMessageSchema).max(100) }).strict();
export const taskDocumentSchema = identitySchema.extend({ schemaVersion: z.literal(1), state: taskListSchema.nullable() }).strict();
export const goalDocumentSchema = identitySchema.extend({ schemaVersion: z.literal(1), state: goalMaxStateSchema.nullable(), briefs: briefsSchema, archives: z.array(digestSchema).max(MAX_ARCHIVES), events: z.array(goalEventSchema).max(1000) }).strict();
export const archiveDocumentSchema = identitySchema.extend({ schemaVersion: z.literal(1), state: goalMaxStateSchema, briefs: briefsSchema }).strict();

export const durableSessionImportSchema = identitySchema.extend({
  queues: z.array(z.object({ instanceSlot: z.number().int().nonnegative().safe(), messages: z.array(queuedMessageSchema).max(100) }).strict()).max(1000),
  tasks: taskListSchema.nullable(), goal: goalMaxStateSchema.nullable(), briefs: briefsSchema,
  archives: z.array(z.object({ state: goalMaxStateSchema, briefs: briefsSchema }).strict()).max(MAX_ARCHIVES),
  goalEvents: z.array(goalEventSchema).max(1000).optional(),
}).strict();
export type DurableSessionImport = z.infer<typeof durableSessionImportSchema>;
export const importPlanSchema = z.object({ requestId: z.string().min(1).max(200), sourceDigest: digestSchema, sessions: z.array(z.object({ key: digestSchema, digest: digestSchema }).strict()).max(100_000) }).strict();
export type DurableImportPlan = z.infer<typeof importPlanSchema>;
export const manifestSchema = z.object({ formatVersion: z.literal(1), status: z.enum(['ready', 'importing']), plan: importPlanSchema.nullable(), completed: z.record(digestSchema, digestSchema) }).strict();

type Identity = z.infer<typeof identitySchema>;
type QueueDocument = JsonRepresentation<z.infer<typeof queueDocumentSchema>>;
type TaskDocument = JsonRepresentation<z.infer<typeof taskDocumentSchema>>;
type GoalDocument = JsonRepresentation<z.infer<typeof goalDocumentSchema>>;
type ArchiveDocument = JsonRepresentation<z.infer<typeof archiveDocumentSchema>>;
export const StateManifest = defineDoc<z.infer<typeof manifestSchema>>({ kind: 'fate.state.profile', version: 1, scope: 'session', initial: () => ({ formatVersion: 1, status: 'importing', plan: null, completed: {} }), checkpointWhen: () => true });
export const QueueState = defineDocFamily<QueueDocument, Identity & { instanceSlot: number }>({ kind: 'fate.state.queue', version: 1, scope: 'session', family: true, initial: (seed) => ({ ...seed, schemaVersion: 1, messages: [] }), checkpointWhen: () => true });
export const TaskState = defineDocFamily<TaskDocument, Identity>({ kind: 'fate.state.tasks', version: 1, scope: 'session', family: true, initial: (seed) => ({ ...seed, schemaVersion: 1, state: null }), checkpointWhen: () => true });
export const GoalState = defineDocFamily<GoalDocument, Identity>({ kind: 'fate.state.goal', version: 1, scope: 'session', family: true, initial: (seed) => ({ ...seed, schemaVersion: 1, state: null, briefs: {}, archives: [], events: [] }), checkpointWhen: () => true });
export const GoalArchive = defineDocFamily<ArchiveDocument, ArchiveDocument>({ kind: 'fate.state.goal-archive', version: 1, scope: 'session', family: true, initial: (seed) => seed, checkpointWhen: () => true });

export function canonicalProjectPath(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
export function identity(projectPath: string, sessionId: string): Identity {
  return identitySchema.parse({ projectPath: canonicalProjectPath(projectPath), sessionId });
}
export function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function durableSessionKey(projectPath: string, sessionId: string): string {
  const value = identity(projectPath, sessionId);
  return hash(`${value.projectPath}\0${value.sessionId}`);
}
export function queueKey(projectPath: string, sessionId: string, slot: number): string {
  return hash(`${canonicalProjectPath(projectPath).normalize('NFC')}\0${sessionId}\0${slot}`);
}
export function archiveKey(projectPath: string, sessionId: string, goalId: string, revision: number): string {
  return hash(`${durableSessionKey(projectPath, sessionId)}\0${goalId}\0${revision}`);
}
export function assertIdentity(value: Identity, expected: Identity): void {
  if (canonicalProjectPath(value.projectPath) !== expected.projectPath || value.sessionId !== expected.sessionId) throw new Error('Native durable state belongs to another session.');
}
export function assertBytes(value: unknown, maximum: number, label: string): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximum) throw new Error(`${label} exceeds its size limit; previous committed state is preserved.`);
}
/** JSON round-trip intentionally removes undefined optional fields before Chord. */
export function detached<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
/** Narrow Zod's optional `undefined` union to the actual strict-JSON representation. */
export function jsonValue<T>(value: T): JsonRepresentation<T> { return JSON.parse(JSON.stringify(value)) as JsonRepresentation<T>; }
export function validateBriefs(briefs: Record<string, string>): void {
  briefsSchema.parse(briefs);
  for (const [ref, text] of Object.entries(briefs)) {
    if (Buffer.byteLength(text, 'utf8') > BRIEF_MAX_BYTES || !ref.endsWith(`-${hash(text).slice(0, 16)}.txt`)) throw new Error('Native durable goal brief exceeds its limit or failed its integrity check.');
  }
}
export function validateGoalBrief(state: z.infer<typeof goalMaxStateSchema> | null, briefs: Record<string, string>): void {
  validateBriefs(briefs);
  if (state?.originalBriefRef) {
    const brief = briefs[state.originalBriefRef];
    if (brief === undefined || hash(brief) !== state.originalBriefHash) throw new Error('Native durable goal source brief is missing or failed its integrity check.');
  }
}
function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, item]) => [key, sortedJson(item)]));
  return value;
}
export function normalizedImport(snapshot: DurableSessionImport): DurableSessionImport {
  const parsed = detached(durableSessionImportSchema.parse(snapshot));
  const expected = identity(parsed.projectPath, parsed.sessionId);
  parsed.projectPath = expected.projectPath;
  const slots = new Set<number>();
  for (const queue of parsed.queues) {
    if (slots.has(queue.instanceSlot)) throw new Error('Duplicate imported queue instance slot.');
    slots.add(queue.instanceSlot);
    assertBytes({ ...expected, version: 1, messages: queue.messages }, QUEUE_MAX_BYTES, 'Imported message queue');
  }
  if (parsed.tasks) { assertIdentity(parsed.tasks, expected); assertBytes(parsed.tasks, TASK_MAX_BYTES, 'Imported task list'); }
  if (parsed.goal) { assertIdentity(parsed.goal, expected); assertBytes(parsed.goal, GOAL_MAX_BYTES, 'Imported goal snapshot'); }
  validateGoalBrief(parsed.goal, parsed.briefs);
  const archives = new Set<string>();
  for (const archive of parsed.archives) {
    assertIdentity(archive.state, expected);
    assertBytes(archive.state, GOAL_MAX_BYTES, 'Imported goal archive');
    validateGoalBrief(archive.state, archive.briefs);
    const key = archiveKey(expected.projectPath, expected.sessionId, archive.state.id, archive.state.revision);
    if (archives.has(key)) throw new Error('Duplicate imported goal archive.');
    archives.add(key);
  }
  assertBytes(parsed, IMPORT_MAX_BYTES, 'Imported session');
  return parsed;
}
export function durableImportDigest(snapshot: DurableSessionImport): string { return hash(JSON.stringify(sortedJson(normalizedImport(snapshot)))); }
