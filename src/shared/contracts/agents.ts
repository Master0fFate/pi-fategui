import { z } from 'zod';

const id = z.string().uuid();
const time = z.number().int().safe().nonnegative();
const revision = z.number().int().positive().safe();
const name = z.string().trim().min(1).max(80).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'Names cannot contain control characters.');
export const agentPermissionSchema = z.enum(['read-only', 'edit']);
export const agentModelSchema = z.object({ provider: z.string().min(1).max(200), id: z.string().min(1).max(500) }).strict();
export const agentDefaultsSchema = z.object({
  model: agentModelSchema.nullable(),
  thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  permission: agentPermissionSchema,
  workspace: z.enum(['shared', 'worktree']),
}).strict();
export const agentDraftSchema = z.object({
  scope: z.enum(['user', 'project']), name, description: z.string().max(1000),
  instructions: z.string().max(65_536), skillRefs: z.array(z.string().min(1).max(200)).max(50),
  defaults: agentDefaultsSchema, enabled: z.boolean(),
}).strict();
export const agentDefinitionSchema = agentDraftSchema.extend({
  schemaVersion: z.literal(1), id, projectPath: z.string().nullable(), revision, createdAt: time, updatedAt: time, deleted: z.boolean(),
}).passthrough();
export const taskTemplateDraftSchema = z.object({
  scope: z.enum(['user', 'project']), name, prompt: z.string().min(1).max(200_000),
  permissionCeiling: agentPermissionSchema, enabled: z.boolean(),
}).strict();
export const taskTemplateSchema = taskTemplateDraftSchema.extend({
  schemaVersion: z.literal(1), id, projectPath: z.string().nullable(), revision, createdAt: time, updatedAt: time, deleted: z.boolean(),
  automationSource: z.object({ sourceId: id, source: z.string().max(2_000_000), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().nullable(),
}).passthrough();
export const routineDraftSchema = z.object({
  name, agentId: id, taskTemplateId: id, intervalMinutes: z.number().int().min(1).max(10_080),
  timeZone: z.string().min(1).max(100).refine((value) => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Choose a valid IANA timezone.'),
  permissionCeiling: agentPermissionSchema, enabled: z.boolean(), notify: z.boolean(), osNotify: z.boolean(),
}).strict();
export const routineDefinitionSchema = routineDraftSchema.extend({
  schemaVersion: z.literal(1), id, projectPath: z.string().min(1), revision, createdAt: time, updatedAt: time, deleted: z.boolean(),
}).passthrough();
export const agentStateSchema = z.object({
  schemaVersion: z.literal(1), agentId: id, revision, homeSessionId: z.string().nullable(), homeProjectPath: z.string().nullable(),
  appliedRevision: z.number().int().nonnegative(), lastOpenedAt: time.nullable(), lastRunAt: time.nullable(),
}).strict().refine((state) => state.homeSessionId === null ? state.homeProjectPath === null && state.appliedRevision === 0 : state.homeProjectPath !== null && state.appliedRevision > 0, 'Home ownership and applied revision must be complete.');
export const agentRunSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().min(1).max(200), agentId: id, agentRevision: revision, taskTemplateId: id, taskTemplateRevision: revision,
  routineId: id.nullable(), routineRevision: revision.nullable(), projectPath: z.string().min(1),
  scheduledFor: time, startedAt: time.nullable(), finishedAt: time.nullable(),
  status: z.enum(['queued', 'running', 'needs-attention', 'succeeded', 'failed', 'skipped']),
  sessionId: z.string().nullable(), resultSummary: z.string().max(4000), error: z.string().max(8000).nullable(),
  inputs: z.object({}).strict(), permission: agentPermissionSchema,
  approvals: z.array(z.object({ id: z.string(), digest: z.string(), revision, action: z.string().max(1_000_000), expiresAt: time, status: z.enum(['pending', 'approved', 'denied', 'expired', 'uncertain']) }).strict()).max(100),
}).strict();
export const savedAgentSessionSchema = z.object({
  schemaVersion: z.literal(1), agentId: id, revision, name, instructions: z.string().max(65_536),
  skillRefs: z.array(z.string().min(1).max(200)).max(50), defaults: agentDefaultsSchema,
  background: z.boolean(), runId: z.string().nullable(), projectPath: z.string().min(1),
}).strict();
export const agentLibrarySchema = z.object({
  agents: z.array(agentDefinitionSchema).max(500), tasks: z.array(taskTemplateSchema).max(500),
  routines: z.array(routineDefinitionSchema).max(500), runs: z.array(agentRunSchema).max(1000),
  states: z.array(agentStateSchema).max(500), diagnostics: z.array(z.string()).max(500),
  nextDue: z.record(z.number().nullable()),
}).strict();
const expected = z.object({ revision, digest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export const agentSaveSchema = z.object({ id: id.optional(), expected: expected.nullable(), value: agentDraftSchema }).strict();
export const taskTemplateSaveSchema = z.object({ id: id.optional(), expected: expected.nullable(), value: taskTemplateDraftSchema }).strict();
export const routineSaveSchema = z.object({ id: id.optional(), expected: expected.nullable(), value: routineDraftSchema }).strict();
export const libraryItemSchema = z.object({ kind: z.enum(['agent', 'task', 'routine']), id, expected }).strict();
export const agentOpenSchema = z.object({ agentId: id, mode: z.enum(['home', 'new']) }).strict();
export const agentRunInputSchema = z.object({ agentId: id, taskTemplateId: id, routineId: id.optional() }).strict();
export const agentApprovalInputSchema = z.object({ runId: z.string().min(1).max(200), approvalId: z.string().min(1).max(100), approved: z.boolean(), expected }).strict();
export const automationCopyInputSchema = z.object({ automationId: id, sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export const agentItemRevisionSchema = z.object({ id, revision, digest: z.string() }).strict();
export const agentOpenResultSchema = z.object({ sessionId: z.string(), appliedRevision: revision }).strict();
export const automationCopyPreviewSchema = z.object({ sourceId: id, sourceDigest: z.string(), name: z.string(), prompt: z.string(), permissionCeiling: agentPermissionSchema, archivedFields: z.array(z.string()), existingTaskId: id.nullable() }).strict();
export const legacyImportItemSchema = automationCopyPreviewSchema.extend({ error: z.string().max(8_000).optional() });
export const legacyImportListSchema = z.array(legacyImportItemSchema).max(500);
export const agentsLegacyListInputSchema = z.object({}).strict();
export type LegacyImportItem = z.infer<typeof legacyImportItemSchema>;
export const agentRevisionsSchema = z.record(expected);
export const agentLibraryResultSchema = agentLibrarySchema.extend({ revisions: agentRevisionsSchema }).strict();

export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type AgentDraft = z.infer<typeof agentDraftSchema>;
export type AgentState = z.infer<typeof agentStateSchema>;
export type TaskTemplate = z.infer<typeof taskTemplateSchema>;
export type RoutineDefinition = z.infer<typeof routineDefinitionSchema>;
export type AgentRun = z.infer<typeof agentRunSchema>;
export type SavedAgentSession = z.infer<typeof savedAgentSessionSchema>;
export type AgentLibrary = z.infer<typeof agentLibraryResultSchema>;
export type AgentSave = z.infer<typeof agentSaveSchema>;
export type TaskTemplateSave = z.infer<typeof taskTemplateSaveSchema>;
export type RoutineSave = z.infer<typeof routineSaveSchema>;
export type AgentApprovalInput = z.infer<typeof agentApprovalInputSchema>;

export const agentChannels = {
  agentsList: 'agents:list', agentsSave: 'agents:save', agentsSaveTask: 'agents:save-task', agentsSaveRoutine: 'agents:save-routine',
  agentsDelete: 'agents:delete', agentsOpen: 'agents:open', agentsRun: 'agents:run', agentsApprove: 'agents:approve',
  agentsCancel: 'agents:cancel', agentsOpenRun: 'agents:open-run', agentsPreviewCopy: 'agents:preview-copy', agentsCopy: 'agents:copy',
  agentsRollbackCopy: 'agents:rollback-copy', agentsLegacyList: 'agents:legacy-list', agentsChanged: 'agents:changed',
} as const;
export const agentListInputSchema = z.object({ routineId: id.optional() }).strict();
export const agentRunIdSchema = z.object({ runId: z.string().min(1).max(200) }).strict();
export const agentIdSchema = z.object({ id }).strict();
export const agentRollbackSchema = z.object({ taskId: id, expected }).strict();
export const agentChangedSchema = z.object({ projectPath: z.string(), runId: z.string().optional(), status: agentRunSchema.shape.status.optional(), message: z.string().max(8000).optional(), focus: z.boolean().optional() }).strict();
export interface AgentsApi {
  getAgentLibrary(input?: z.infer<typeof agentListInputSchema>): Promise<AgentLibrary>;
  saveAgentDefinition(input: AgentSave): Promise<AgentDefinition>;
  saveTaskTemplate(input: TaskTemplateSave): Promise<TaskTemplate>;
  saveRoutineDefinition(input: RoutineSave): Promise<RoutineDefinition>;
  deleteAgentLibraryItem(input: z.infer<typeof libraryItemSchema>): Promise<void>;
  openAgentConversation(input: z.infer<typeof agentOpenSchema>): Promise<z.infer<typeof agentOpenResultSchema>>;
  runAgentTask(input: z.infer<typeof agentRunInputSchema>): Promise<AgentRun>;
  decideAgentApproval(input: AgentApprovalInput): Promise<void>;
  cancelAgentRun(input: z.infer<typeof agentRunIdSchema>): Promise<void>;
  openAgentRunSession(input: z.infer<typeof agentRunIdSchema>): Promise<void>;
  previewAutomationCopy(input: z.infer<typeof agentIdSchema>): Promise<z.infer<typeof automationCopyPreviewSchema>>;
  listLegacyAutomations(input: z.infer<typeof agentsLegacyListInputSchema>): Promise<LegacyImportItem[]>;
  copyAutomationToTask(input: z.infer<typeof automationCopyInputSchema>): Promise<TaskTemplate>;
  rollbackAutomationCopy(input: z.infer<typeof agentRollbackSchema>): Promise<void>;
  onAgentLibraryChanged(listener: (event: z.infer<typeof agentChangedSchema>) => void): () => void;
}
