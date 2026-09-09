import { z } from 'zod';

export const LEARNING_LIMITS = {
  sources: 6, evidenceBytes: 16 * 1024, extractionBytes: 32 * 1024,
  noteBytes: 2 * 1024, procedureBytes: 8 * 1024, contextBytes: 6 * 1024,
  tokens: 1500, attached: 3, lessons: 100, drafts: 100, revisions: 10,
  snapshotBytes: 8 * 1024 * 1024, manifests: 500, retentionMs: 30 * 86400_000,
  sessionBytes: 16 * 1024 * 1024, sourceFileBytes: 1024 * 1024, timeoutMs: 60_000, sourceTimeoutMs: 5000,
  progressReviewMs: 7 * 86400_000,
} as const;
export const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
const text = (bytes: number, minimum = 0) => z.string().min(minimum).max(bytes).refine((value) => utf8Bytes(value) <= bytes, 'UTF-8 byte limit exceeded');
const id = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const short = text(500);
const lines = z.array(text(1000, 1)).max(20);
export const learningScopeSchema = z.enum(['global', 'project']);
export const defaultMemoryLearning = { enabled: false, global: true, project: true };
export const memoryLearningSettingsSchema = z.object({
  enabled: z.boolean(),
  global: z.boolean().default(true),
  project: z.boolean().default(true),
  scope: learningScopeSchema.optional(),
}).transform(({ enabled, global, project }) => ({ enabled, global, project })).default(defaultMemoryLearning);
export const learningStateInputSchema = z.object({ scope: learningScopeSchema.optional() }).strict();
export const learningModeSchema = z.enum(['off', 'manual', 'automatic']);
export const learningPathSchema = z.string().min(1).max(500).refine((value) => !value.startsWith('/') && !/[\\:\x00-\x1f*?]/u.test(value) && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'), 'Use an exact project-relative path');
export const activationSchema = z.object({
  relativePaths: z.array(learningPathSchema).max(12), symbols: z.array(short).max(12),
  keywords: z.array(text(80)).max(12), branchRestriction: text(200).nullable(),
}).strict();
export const emptyActivation = { relativePaths: [], symbols: [], keywords: [], branchRestriction: null };
const noteBody = z.object({ guidance: text(1800, 1), rationale: text(1000), exceptions: lines }).strict();
const procedureBody = z.object({ purpose: text(500, 1), useWhen: lines.min(1), doNotUseWhen: lines, preconditions: lines, steps: lines.min(1), verification: lines.min(1), stopConditions: lines.min(1) }).strict();
export const memoryKindSchema = z.enum(['note', 'procedure', 'user-profile', 'project-brief']);
const userProfileBody = z.object({ communication: lines, workflow: lines, codingPreferences: lines, designPreferences: lines, decisionMaking: lines, learningStyle: lines, likes: lines, dislikes: lines }).strict();
const projectBriefBody = z.object({ overview: text(800, 1), architecture: lines, decisions: lines, currentWork: lines, nextSteps: lines }).strict();
export const lessonContentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user-profile'), title: text(160, 1), body: userProfileBody, activation: activationSchema }).strict(),
  z.object({ kind: z.literal('project-brief'), title: text(160, 1), body: projectBriefBody, activation: activationSchema }).strict(),
  z.object({ kind: z.literal('note'), title: text(160, 1), body: noteBody, activation: activationSchema }).strict(),
  z.object({ kind: z.literal('procedure'), title: text(160, 1), body: procedureBody, activation: activationSchema }).strict(),
]).superRefine((value, ctx) => {
  if (utf8Bytes(JSON.stringify(value.body)) > (value.kind === 'procedure' ? LEARNING_LIMITS.procedureBytes : LEARNING_LIMITS.noteBytes)) ctx.addIssue({ code: 'custom', message: 'Lesson body exceeds its byte budget' });
  if (value.kind === 'user-profile' && !Object.values(value.body).some((items) => items.length)) ctx.addIssue({ code: 'custom', message: 'Add at least one explicit user preference' });
  if ((value.kind === 'user-profile' || value.kind === 'project-brief') && (value.activation.relativePaths.length || value.activation.symbols.length || value.activation.keywords.length || (value.kind === 'user-profile' && value.activation.branchRestriction))) ctx.addIssue({ code: 'custom', message: 'Core memories apply across tasks; use ordinary project notes for path, symbol, or keyword activation' });
});
export const learningBindingSchema = z.object({ projectKey: digest, sessionId: z.string().min(1).max(500).nullable(), runtimeGeneration: z.number().int().nonnegative(), scope: learningScopeSchema }).strict();
export const evidenceSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual'), text: text(LEARNING_LIMITS.evidenceBytes) }).strict(),
  z.object({ kind: z.literal('entry'), entryId: text(500, 1), leafId: text(500, 1) }).strict(),
  z.object({ kind: z.literal('file'), path: learningPathSchema, startLine: z.number().int().min(1).max(100_000), endLine: z.number().int().min(1).max(100_000) }).strict(),
]);
export const evidenceSchema = z.object({
  id, projectKey: digest, createdAt: z.number().int(), schemaVersion: z.literal(1),
  source: z.object({ kind: z.enum(['manual', 'entry', 'file']), sessionId: short.nullable(), entryId: short.nullable(), leafId: short.nullable(), path: learningPathSchema.nullable(), fileDigest: digest.nullable(), toolCallId: short.nullable() }).strict(),
  codeState: z.object({ commit: short.nullable(), dirty: z.boolean().nullable() }).strict(),
  text: text(LEARNING_LIMITS.evidenceBytes), omitted: z.boolean(), redacted: z.boolean(),
  basis: z.enum(['runtime-observed', 'user-asserted', 'unknown']), verification: z.object({ command: short, exitStatus: z.number().int().nullable(), association: z.literal('unknown') }).strict().nullable(), digest,
}).strict();
export const captureSchema = z.object({ id, evidence: z.array(evidenceSchema).min(1).max(LEARNING_LIMITS.sources), digest, createdAt: z.number().int() }).strict();
export const draftSchema = z.object({
  id, lessonId: id.nullable(), version: z.number().int().positive(), state: z.enum(['pending', 'approved', 'rejected']),
  content: lessonContentSchema, evidenceIds: z.array(id).max(6), digest, createdAt: z.number().int(), uncertainty: lines,
}).strict();
export const lessonRevisionSchema = z.object({
  id, lessonId: id, revisionNumber: z.number().int().positive(), content: lessonContentSchema, evidenceIds: z.array(id).max(6), contentDigest: digest,
  approvedAt: z.number().int(), approvalSource: z.literal('local-user'), createdFromDraftId: id, supersedesRevisionId: id.nullable(),
}).strict();
export const lessonSchema = z.object({
  id, activeRevisionId: id, enabled: z.boolean(), freshness: z.enum(['current', 'needs-review', 'unverifiable']), conflict: z.boolean(), createdAt: z.number().int(), updatedAt: z.number().int(),
}).strict();
export const learningPinSchema = z.object({ lessonId: id, revisionId: id, scope: learningScopeSchema.optional() }).strict();
export const learningTurnSchema = z.object({ binding: learningBindingSchema, pins: z.array(learningPinSchema).max(3), excluded: z.array(id).max(100) }).strict();
const selectedSchema = learningPinSchema.extend({ contentDigest: digest, title: text(160), reasons: z.array(short).max(6) }).strict();
export const selectionSchema = z.object({ selected: z.array(selectedSchema).max(3), skipped: z.array(z.object({ lessonId: id, reason: short }).strict()).max(100), bytes: z.number().int().nonnegative(), estimatedTokens: z.number().int().nonnegative(), tokenMethod: z.literal('ceil(UTF-8 bytes / 4); estimate only') }).strict();
export const manifestSchema = z.object({
  dispatchId: id, projectKey: digest, sessionId: short, scope: learningScopeSchema, policyVersion: z.union([z.literal(1), z.literal(2)]), mode: learningModeSchema, createdAt: z.number().int(),
  contextModes: z.object({ global: learningModeSchema.nullable(), project: learningModeSchema.nullable() }).strict().optional(),
  items: z.array(selectedSchema.omit({ title: true })).max(3), skipped: selectionSchema.shape.skipped,
  contextDigest: digest, bytes: z.number().int().nonnegative(), estimatedTokens: z.number().int().nonnegative(), tokenMethod: selectionSchema.shape.tokenMethod,
  state: z.enum(['prepared', 'handed-to-runtime', 'not-sent', 'uncertain']),
}).strict();
export const generationUsageSchema = z.object({ requestId: id, provider: short, model: short, createdAt: z.number().int(), outcome: z.enum(['draft', 'no_lesson', 'failed', 'cancelled']), inputTokens: z.number().nonnegative().nullable(), outputTokens: z.number().nonnegative().nullable(), costUsd: z.number().nonnegative().nullable() }).strict();
export const learningSnapshotSchema = z.object({
  schemaVersion: z.literal(1), scope: learningScopeSchema, projectKey: z.string().min(1).max(64), canonicalRoot: z.string().max(32768).nullable(),
  epoch: id, revision: z.number().int().nonnegative(), mode: learningModeSchema,
  lessons: z.array(lessonSchema).max(100), revisions: z.array(lessonRevisionSchema).max(1000), drafts: z.array(draftSchema).max(100),
  evidence: z.array(evidenceSchema).max(1200), manifests: z.array(manifestSchema).max(500), generationUsage: z.array(generationUsageSchema).max(100),
}).strict();
export const learningStateSchema = z.object({
  binding: learningBindingSchema.nullable(), projectName: short, enabled: z.boolean(),
  snapshot: learningSnapshotSchema.nullable(), diagnostic: short.nullable(), recoveryDigest: digest.nullable(),
  provider: z.object({ provider: short, model: short }).strict().nullable(),
  recentUse: z.array(manifestSchema).max(500).optional(),
  contextModes: z.object({ global: learningModeSchema.nullable(), project: learningModeSchema.nullable() }).strict().optional(),
  sources: z.array(z.object({ entryId: short, leafId: short, role: z.enum(['user', 'assistant', 'toolResult']), preview: text(300) }).strict()).max(100),
}).strict();
const mutationBase = { binding: learningBindingSchema, epoch: id, expectedRevision: z.number().int().nonnegative() };
export const learningMutationSchema = z.discriminatedUnion('action', [
  z.object({ ...mutationBase, action: z.literal('save-draft'), id: id.optional(), lessonId: id.optional(), content: lessonContentSchema, evidenceIds: z.array(id).max(6), captureId: id.optional() }).strict(),
  z.object({ ...mutationBase, action: z.literal('approve'), id, digest }).strict(),
  z.object({ ...mutationBase, action: z.literal('reject'), id }).strict(),
  z.object({ ...mutationBase, action: z.literal('delete-draft'), id }).strict(),
  z.object({ ...mutationBase, action: z.literal('set-enabled'), id, enabled: z.boolean() }).strict(),
  z.object({ ...mutationBase, action: z.literal('set-conflict'), id, conflict: z.boolean() }).strict(),
  z.object({ ...mutationBase, action: z.literal('delete-lesson'), id }).strict(),
  z.object({ ...mutationBase, action: z.literal('delete-evidence'), id }).strict(),
  z.object({ ...mutationBase, action: z.literal('set-mode'), mode: learningModeSchema }).strict(),
  z.object({ ...mutationBase, action: z.literal('reset'), confirmation: z.literal('DELETE LEARNING') }).strict(),
]);
export const previewEvidenceInputSchema = z.object({ binding: learningBindingSchema, requestId: id.optional(), sources: z.array(evidenceSourceSchema).min(1).max(6) }).strict();
export const reviewCaptureInputSchema = z.object({ binding: learningBindingSchema, captureId: id, excerpts: z.array(z.object({ id, text: text(LEARNING_LIMITS.evidenceBytes) }).strict()).min(1).max(6) }).strict();
export const generateDraftInputSchema = z.object({ ...mutationBase, kind: memoryKindSchema.optional(), requestId: id, captureId: id, captureDigest: digest, correction: text(4000), provider: text(500, 1), model: text(500, 1), consent: z.literal(true) }).strict();
export const cancelLearningInputSchema = z.object({ binding: learningBindingSchema, id }).strict();
export const recoveryInputSchema = z.object({ binding: learningBindingSchema, digest, action: z.enum(['reset-store', 'recover-lock']), confirmation: z.literal('DELETE LEARNING').optional() }).strict();
export const previewSelectionInputSchema = z.object({ binding: learningBindingSchema, text: text(200_000), pins: z.array(learningPinSchema).max(3), excluded: z.array(id).max(100) }).strict();
export const modelDraftResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('no_lesson'), reason: text(500, 1) }).strict(),
  z.object({ outcome: z.literal('draft'), content: lessonContentSchema, evidenceIds: z.array(id).min(1).max(6), uncertainty: lines }).strict(),
]);
export const generationResultSchema = z.object({ outcome: z.enum(['draft', 'no_lesson']), reason: short.nullable(), state: learningStateSchema }).strict();
export const learningChangedSchema = z.object({ projectKey: z.string().max(64), scope: learningScopeSchema, revision: z.number().int().nonnegative() }).strict();
export type LearningScope = z.infer<typeof learningScopeSchema>;
export type MemoryLearningSettings = z.infer<typeof memoryLearningSettingsSchema>;
export type LearningBinding = z.infer<typeof learningBindingSchema>;
export type LearningSnapshot = z.infer<typeof learningSnapshotSchema>;
export type LearningState = z.infer<typeof learningStateSchema>;
export type LearningMutation = z.infer<typeof learningMutationSchema>;
export type LessonContent = z.infer<typeof lessonContentSchema>;
export type LessonRevision = z.infer<typeof lessonRevisionSchema>;
export type LearningEvidence = z.infer<typeof evidenceSchema>;
export type LearningCapture = z.infer<typeof captureSchema>;
export type LearningTurn = z.infer<typeof learningTurnSchema>;
export type LearningSelection = z.infer<typeof selectionSchema>;
export type LearningManifest = z.infer<typeof manifestSchema>;
export type GenerateDraftInput = z.infer<typeof generateDraftInputSchema>;
export type PreviewEvidenceInput = z.infer<typeof previewEvidenceInputSchema>;
export type ReviewCaptureInput = z.infer<typeof reviewCaptureInputSchema>;
export type PreviewSelectionInput = z.infer<typeof previewSelectionInputSchema>;
export type LearningRecoveryInput = z.infer<typeof recoveryInputSchema>;
export const learningStorageSchema = z.object({ settingsFile: z.string().max(32768), globalFile: z.string().max(32768), projectFile: z.string().max(32768).nullable() }).strict();
export type LearningStorage = z.infer<typeof learningStorageSchema>;
export interface LearningApi {
  getLearningStorage(): Promise<LearningStorage>;
  getLearningState(scope?: LearningScope): Promise<LearningState>;
  mutateLearning(input: LearningMutation): Promise<LearningState>;
  previewLearningEvidence(input: PreviewEvidenceInput): Promise<LearningCapture>;
  reviewLearningCapture(input: ReviewCaptureInput): Promise<LearningCapture>;
  generateLearningDraft(input: GenerateDraftInput): Promise<z.infer<typeof generationResultSchema>>;
  cancelLearning(input: z.infer<typeof cancelLearningInputSchema>): Promise<void>;
  recoverLearning(input: LearningRecoveryInput): Promise<LearningState>;
  previewLearningSelection(input: PreviewSelectionInput): Promise<LearningSelection>;
  onLearningChanged(listener: (event: z.infer<typeof learningChangedSchema>) => void): () => void;
}
