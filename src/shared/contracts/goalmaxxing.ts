import { z } from 'zod';

export const GOALMAX_OBJECTIVE_LIMIT = 12_000;
export const GOALMAX_BRIEF_LIMIT = 200_000;
export const GOALMAX_MAX_CRITERIA = 32;
export const GOALMAX_MAX_EVIDENCE = 256;
export const GOALMAX_MAX_ASSIGNMENTS = 64;
export const GOALMAX_MAX_STEERING = 32;
export const GOALMAX_STEERING_TEXT_LIMIT = 12_000;
export const GOALMAX_MAX_TIMELINE_EVENTS = 256;

const boundedIdSchema = z.string().min(1).max(160).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'Identifiers cannot contain control characters.');
const boundedTextSchema = z.string().trim().min(1).max(4_000);
const permissionSchema = z.enum(['read-only', 'edit', 'full-access']);
const thinkingSchema = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const modelSchema = z.object({
  provider: z.string().min(1).max(200),
  id: z.string().min(1).max(500),
  name: z.string().min(1).max(500),
}).strict();

export const goalMaxStatusSchema = z.enum([
  'normalising',
  'active',
  'paused',
  'blocked',
  'verifying',
  'completed',
  'cancelled',
  'budget-limited',
  'usage-limited',
  'failed',
]);
export const goalMaxPhaseSchema = z.enum(['intake', 'planning', 'research', 'implementation', 'validation', 'verification', 'handoff']);
export const goalMaxExecutionStateSchema = z.enum(['idle', 'running-root', 'running-children', 'waiting']);
export const goalMaxVerificationLevelSchema = z.enum(['normal', 'strict']);
export const goalMaxAgentStrategySchema = z.enum(['auto', 'off', 'read-only']);

export const goalMaxCriterionSchema = z.object({
  id: boundedIdSchema,
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(2_000),
  required: z.boolean(),
  status: z.enum(['pending', 'active', 'satisfied', 'failed', 'waived']),
  evidenceIds: z.array(boundedIdSchema).max(64),
  ownerNodeIds: z.array(boundedIdSchema).max(64),
  updatedAt: z.number().int().nonnegative().safe(),
}).strict();

export const goalMaxBudgetSchema = z.object({
  tokenLimit: z.number().int().positive().safe().nullable(),
  timeLimitMs: z.number().int().positive().safe().max(365 * 24 * 60 * 60 * 1_000).nullable(),
  source: z.enum(['user-explicit', 'system-hard-limit']).nullable(),
}).strict().superRefine((budget, context) => {
  const hasLimit = budget.tokenLimit !== null || budget.timeLimitMs !== null;
  if (hasLimit !== (budget.source !== null)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Budget source must match an explicit limit.' });
});

export const goalMaxPermissionSnapshotSchema = z.object({
  permissionLevel: permissionSchema,
  projectTrusted: z.boolean(),
  revision: z.number().int().nonnegative().safe(),
  resolvedAt: z.number().int().nonnegative().safe(),
}).strict();

export const goalMaxProgressSchema = z.object({
  meaningfulTurnCount: z.number().int().nonnegative().safe(),
  noProgressTurnCount: z.number().int().nonnegative().safe(),
  repeatedFailureCount: z.number().int().nonnegative().safe(),
  planningOnlyTurnCount: z.number().int().nonnegative().safe(),
  changedFileCount: z.number().int().nonnegative().safe(),
  baselineWorkspaceFingerprint: z.string().max(128),
  latestWorkspaceFingerprint: z.string().max(128),
  latestEvidenceAt: z.number().int().nonnegative().safe().nullable(),
  latestMeaningfulProgressAt: z.number().int().nonnegative().safe().nullable(),
  lastFailureFingerprint: z.string().max(128).nullable(),
}).strict();

export const goalMaxEvidenceKindSchema = z.enum([
  'file',
  'git-diff',
  'command',
  'test',
  'build',
  'lint',
  'screenshot',
  'runtime',
  'subagent',
  'user-approval',
  'verification',
]);
export const goalMaxEvidenceSchema = z.object({
  id: boundedIdSchema,
  kind: goalMaxEvidenceKindSchema,
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().max(8_000),
  criterionIds: z.array(boundedIdSchema).max(GOALMAX_MAX_CRITERIA),
  source: z.enum(['runtime', 'root-tool', 'child-tool', 'verifier', 'user', 'workspace']),
  timestamp: z.number().int().nonnegative().safe(),
  current: z.boolean(),
  path: z.string().max(4_096).optional(),
  command: z.string().max(8_000).optional(),
  exitCode: z.number().int().min(-2_147_483_648).max(2_147_483_647).optional(),
  fingerprint: z.string().max(128).optional(),
  output: z.string().max(8_000).optional(),
}).strict();

export const goalMaxContinuationSchema = z.object({
  pending: z.boolean(),
  attempt: z.number().int().nonnegative().safe(),
  lastScheduledAt: z.number().int().nonnegative().safe().nullable(),
  lastSettledAt: z.number().int().nonnegative().safe().nullable(),
  reason: z.string().max(1_000).nullable(),
}).strict();

export const goalMaxSteeringSchema = z.object({
  id: boundedIdSchema,
  text: z.string().trim().min(1).max(GOALMAX_STEERING_TEXT_LIMIT),
  behavior: z.enum(['prompt', 'steer', 'followUp']),
  timestamp: z.number().int().nonnegative().safe(),
  revision: z.number().int().positive().safe(),
}).strict();

export const goalMaxChildAssignmentSchema = z.object({
  id: boundedIdSchema,
  goalId: boundedIdSchema,
  nodeId: boundedIdSchema,
  teamId: boundedIdSchema.optional(),
  label: z.string().trim().min(1).max(160),
  lane: z.enum(['research', 'implementation', 'tests', 'review', 'verification', 'documentation', 'general']),
  objective: z.string().trim().min(1).max(4_000),
  criterionIds: z.array(boundedIdSchema).max(GOALMAX_MAX_CRITERIA),
  status: z.enum(['pending', 'running', 'blocked', 'completed', 'failed', 'cancelled']),
  requestedModel: modelSchema.nullable(),
  effectiveModel: modelSchema.nullable(),
  requestedThinking: thinkingSchema.nullable(),
  effectiveThinking: thinkingSchema.nullable(),
  permissionLevel: permissionSchema,
  evidenceIds: z.array(boundedIdSchema).max(64),
  startedAt: z.number().int().nonnegative().safe().nullable(),
  endedAt: z.number().int().nonnegative().safe().nullable(),
}).strict();

export const goalMaxTimelineEventSchema = z.object({
  id: boundedIdSchema,
  type: z.enum([
    'goal.created', 'goal.updated', 'goal.paused', 'goal.resumed', 'goal.blocked', 'goal.cancelled', 'goal.completed',
    'goal.recovered', 'goal.cleared', 'phase.changed', 'continuation.scheduled', 'continuation.settled', 'checkpoint.created',
    'steering.recorded', 'verification.started', 'verification.passed', 'verification.failed', 'evidence.added', 'assignment.updated', 'budget.reached',
  ]),
  summary: z.string().trim().min(1).max(1_000),
  timestamp: z.number().int().nonnegative().safe(),
  revision: z.number().int().nonnegative().safe(),
}).strict();

export const goalMaxStateSchema = z.object({
  schemaVersion: z.literal(2),
  id: boundedIdSchema,
  sessionId: z.string().min(1).max(500),
  projectPath: z.string().min(1).max(32_768),
  revision: z.number().int().positive().safe(),
  objective: z.string().trim().min(1).max(GOALMAX_OBJECTIVE_LIMIT),
  originalBriefRef: z.string().max(4_096).nullable(),
  originalBriefHash: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
  status: goalMaxStatusSchema,
  phase: goalMaxPhaseSchema,
  executionState: goalMaxExecutionStateSchema,
  verificationLevel: goalMaxVerificationLevelSchema,
  agentStrategy: goalMaxAgentStrategySchema,
  criteria: z.array(goalMaxCriterionSchema).min(1).max(GOALMAX_MAX_CRITERIA),
  budget: goalMaxBudgetSchema,
  permission: goalMaxPermissionSnapshotSchema,
  progress: goalMaxProgressSchema,
  evidence: z.array(goalMaxEvidenceSchema).max(GOALMAX_MAX_EVIDENCE),
  continuation: goalMaxContinuationSchema,
  steering: z.array(goalMaxSteeringSchema).max(GOALMAX_MAX_STEERING),
  childAssignments: z.array(goalMaxChildAssignmentSchema).max(GOALMAX_MAX_ASSIGNMENTS),
  tokensUsed: z.number().int().nonnegative().safe(),
  tokenBaseline: z.number().int().nonnegative().safe(),
  elapsedMs: z.number().int().nonnegative().safe(),
  timeline: z.array(goalMaxTimelineEventSchema).max(GOALMAX_MAX_TIMELINE_EVENTS),
  createdAt: z.number().int().nonnegative().safe(),
  updatedAt: z.number().int().nonnegative().safe(),
  startedAt: z.number().int().nonnegative().safe().nullable(),
  completedAt: z.number().int().nonnegative().safe().nullable(),
  blockedReason: z.string().max(4_000).nullable(),
  failure: z.object({ code: z.string().min(1).max(100), message: z.string().min(1).max(4_000), retryable: z.boolean() }).strict().nullable(),
}).strict().superRefine((goal, context) => {
  const criterionIds = new Set(goal.criteria.map((criterion) => criterion.id));
  const evidenceIds = new Set(goal.evidence.map((evidence) => evidence.id));
  const assignmentIds = new Set(goal.childAssignments.map((assignment) => assignment.id));
  const assignmentNodeIds = new Set(goal.childAssignments.map((assignment) => assignment.nodeId));
  const steeringIds = new Set(goal.steering.map((item) => item.id));
  const evidenceById = new Map(goal.evidence.map((evidence) => [evidence.id, evidence]));
  if ((goal.originalBriefRef === null) !== (goal.originalBriefHash === null)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Original brief references and hashes must be stored together.' });
  if (criterionIds.size !== goal.criteria.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Goal criterion IDs must be unique.' });
  if (evidenceIds.size !== goal.evidence.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Goal evidence IDs must be unique.' });
  if (assignmentIds.size !== goal.childAssignments.length || assignmentNodeIds.size !== goal.childAssignments.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Goal child assignments must be unique by assignment and node.' });
  if (goal.childAssignments.some((assignment) => assignment.goalId !== goal.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Child assignments must belong to the current goal.' });
  if (steeringIds.size !== goal.steering.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Goal steering IDs must be unique.' });
  if (goal.steering.some((item) => item.revision > goal.revision)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Goal steering cannot reference a future revision.' });
  if (goal.criteria.some((criterion) => criterion.evidenceIds.some((id) => !evidenceIds.has(id)))) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Criteria must reference retained goal evidence.' });
  if (goal.criteria.some((criterion) => criterion.evidenceIds.some((id) => !evidenceById.get(id)?.criterionIds.includes(criterion.id)))) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Criterion evidence links must be acknowledged by the evidence record.' });
  if (goal.evidence.some((evidence) => evidence.criterionIds.some((id) => !criterionIds.has(id)))) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Evidence must reference retained criteria.' });
  if (goal.status === 'completed') {
    const currentEvidenceIds = new Set(goal.evidence.filter((evidence) => evidence.current && evidence.source !== 'verifier').map((evidence) => evidence.id));
    if (goal.criteria.some((criterion) => criterion.required && criterion.status !== 'waived' && (
      criterion.status !== 'satisfied' || !criterion.evidenceIds.some((id) => currentEvidenceIds.has(id))
    ))) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Completed goals require current non-verifier evidence for every required criterion.' });
  }
});

export const goalMaxCreateInputSchema = z.object({
  objective: z.string().trim().min(1).max(GOALMAX_BRIEF_LIMIT),
  verificationLevel: goalMaxVerificationLevelSchema.default('normal'),
  agentStrategy: goalMaxAgentStrategySchema.default('auto'),
  tokenLimit: z.number().int().positive().safe().nullable().default(null),
  timeLimitMs: z.number().int().positive().safe().max(365 * 24 * 60 * 60 * 1_000).nullable().default(null),
}).strict();

export const goalMaxControlInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause'), reason: z.string().trim().min(1).max(500).optional() }).strict(),
  z.object({ action: z.literal('resume') }).strict(),
  z.object({ action: z.literal('checkpoint') }).strict(),
  z.object({ action: z.literal('verify') }).strict(),
  z.object({ action: z.literal('cancel'), reason: z.string().trim().min(1).max(500).optional() }).strict(),
]);

export const goalMaxUpdateInputSchema = z.object({
  expectedRevision: z.number().int().positive().safe(),
  objective: z.string().trim().min(1).max(GOALMAX_BRIEF_LIMIT).optional(),
  criteria: z.array(z.object({
    id: boundedIdSchema.optional(),
    title: z.string().trim().min(1).max(240),
    description: z.string().trim().max(2_000).default(''),
    required: z.boolean().default(true),
  }).strict()).min(1).max(GOALMAX_MAX_CRITERIA).optional(),
  tokenLimit: z.number().int().positive().safe().nullable().optional(),
  timeLimitMs: z.number().int().positive().safe().max(365 * 24 * 60 * 60 * 1_000).nullable().optional(),
  verificationLevel: goalMaxVerificationLevelSchema.optional(),
  agentStrategy: goalMaxAgentStrategySchema.optional(),
}).strict().refine((input) => Object.keys(input).some((key) => key !== 'expectedRevision'), 'At least one goal field must change.');

export const goalMaxClearResultSchema = z.object({ cleared: z.boolean(), archivedGoalId: boundedIdSchema.nullable() }).strict();

const goalEventBase = z.object({ projectPath: z.string().min(1).max(32_768), sessionId: z.string().min(1).max(500), timestamp: z.number().int().nonnegative().safe() }).strict();
export const goalMaxEventSchema = z.discriminatedUnion('type', [
  goalEventBase.extend({ type: z.literal('goalmax.snapshot'), goal: goalMaxStateSchema }),
  goalEventBase.extend({ type: z.literal('goalmax.status'), goalId: boundedIdSchema, revision: z.number().int().positive().safe(), status: goalMaxStatusSchema, executionState: goalMaxExecutionStateSchema, blockedReason: z.string().max(4_000).nullable() }),
  goalEventBase.extend({ type: z.literal('goalmax.phase'), goalId: boundedIdSchema, revision: z.number().int().positive().safe(), phase: goalMaxPhaseSchema }),
  goalEventBase.extend({ type: z.literal('goalmax.criterion'), goalId: boundedIdSchema, revision: z.number().int().positive().safe(), criterion: goalMaxCriterionSchema }),
  goalEventBase.extend({ type: z.literal('goalmax.evidence'), goalId: boundedIdSchema, revision: z.number().int().positive().safe(), evidence: goalMaxEvidenceSchema }),
  goalEventBase.extend({ type: z.literal('goalmax.assignment'), goalId: boundedIdSchema, revision: z.number().int().positive().safe(), assignment: goalMaxChildAssignmentSchema }),
  goalEventBase.extend({ type: z.literal('goalmax.usage'), goalId: boundedIdSchema, revision: z.number().int().positive().safe(), tokensUsed: z.number().int().nonnegative().safe(), elapsedMs: z.number().int().nonnegative().safe() }),
  goalEventBase.extend({ type: z.literal('goalmax.cleared'), goalId: boundedIdSchema }),
]);
export const goalMaxEventBatchSchema = z.array(goalMaxEventSchema).min(1).max(50);

export type GoalMaxStatus = z.infer<typeof goalMaxStatusSchema>;
export type GoalMaxPhase = z.infer<typeof goalMaxPhaseSchema>;
export type GoalMaxCriterion = z.infer<typeof goalMaxCriterionSchema>;
export type GoalMaxBudget = z.infer<typeof goalMaxBudgetSchema>;
export type GoalMaxEvidence = z.infer<typeof goalMaxEvidenceSchema>;
export type GoalMaxSteering = z.infer<typeof goalMaxSteeringSchema>;
export type GoalMaxChildAssignment = z.infer<typeof goalMaxChildAssignmentSchema>;
export type GoalMaxTimelineEvent = z.infer<typeof goalMaxTimelineEventSchema>;
export type GoalMaxState = z.infer<typeof goalMaxStateSchema>;
export type GoalMaxCreateInput = z.infer<typeof goalMaxCreateInputSchema>;
export type GoalMaxControlInput = z.infer<typeof goalMaxControlInputSchema>;
export type GoalMaxUpdateInput = z.infer<typeof goalMaxUpdateInputSchema>;
export type GoalMaxClearResult = z.infer<typeof goalMaxClearResultSchema>;
export type GoalMaxEvent = z.infer<typeof goalMaxEventSchema>;
