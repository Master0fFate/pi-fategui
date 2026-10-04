import { z } from 'zod';
import { emptyInputSchema, thinkingLevelSchema, queueMutationInputSchema, subagentControlInputSchema,
  gitCommitSummarySchema, gitCommitFileSchema } from '../contracts/ipc';
import { goalMaxCreateInputSchema, goalMaxControlInputSchema, goalMaxUpdateInputSchema,
  goalMaxSteeringEditInputSchema, goalMaxSteeringRemoveInputSchema } from '../contracts/goalmaxxing';
import { taskCreateInputSchema, taskUpdateInputSchema, taskReorderInputSchema, taskDeleteInputSchema } from '../contracts/tasks';
import { agentTeamControlInputSchema, agentTeamNodeStatusSchema, workspaceReviewSchema } from '../contracts/multiAgent';
import { uuidSchema, mutationRequestIdSchema } from './requestIds';
import { textAttachmentInputSchema, textAttachmentIdSchema, textAttachmentReceiptSchema } from './attachments';
import { historyPageSchema, SNAPSHOT_PAGE_BYTES } from './snapshots';

const revision = z.number().int().nonnegative().safe();
const domainId = z.string().min(1).max(160).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
export const projectRelativePathSchema = z.string().min(1).max(4096).refine((value) => !value.includes('\\')
  && !value.startsWith('/') && !value.includes(':') && !/[\u0000-\u001f\u007f]/u.test(value)
  && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'));
export const operationMethodSchema = z.enum(['session.create', 'runtime.setModel', 'runtime.setThinking', 'runtime.queue',
  'goal.create', 'goal.control', 'goal.update', 'goal.clear', 'goal.editSteering', 'goal.removeSteering',
  'task.create', 'task.update', 'task.reorder', 'task.delete', 'task.clear', 'agent.control', 'team.control', 'agent.workspace']);
export type OperationMethod = z.infer<typeof operationMethodSchema>;
export const operationDomainSchema = z.object({ sessionId: uuidSchema, viewRevision: revision }).strict();
/** A truthful bounded outcome, not an invented RuntimeState or a completion certificate. */
export const operationReceiptSchema = z.object({ kind: z.literal('operation'), operation: operationMethodSchema,
  requestId: mutationRequestIdSchema, durability: z.enum(['not-journaled', 'journaled']),
  outcome: z.literal('applied'), sessionId: uuidSchema, viewRevision: revision }).strict();
const selection = { sessionId: uuidSchema, selectionRevision: revision };
const model = z.object({ provider: z.string().min(1).max(200), id: z.string().min(1).max(500),
  name: z.string().min(1).max(500), reasoning: z.boolean(), contextWindow: z.number().int().positive().safe(), supportsImages: z.boolean().optional() }).strict();
export const modelReadSchema = z.object({ ...selection, models: z.array(model).max(2000) }).strict();
export const sessionReadSchema = z.object({ ...selection, sessions: z.array(z.object({ id: uuidSchema,
  title: z.string().min(1).max(200), createdAt: z.string().datetime(), modifiedAt: z.string().datetime(),
  messageCount: revision, active: z.boolean() }).strict()).max(1000) }).strict();
const queueRow = z.object({ id: uuidSchema, behavior: z.enum(['steer', 'followUp']), text: z.string().min(1).max(200_000),
  createdAt: z.number().finite(), mediaOmitted: z.boolean(), contextOmitted: z.boolean() }).strict();
export const queueReadSchema = z.object({ ...selection, items: z.array(queueRow).max(100), held: z.array(queueRow).max(100),
  recovered: z.array(queueRow).max(100) }).strict();
const node = z.object({ id: domainId, parentNodeId: domainId.nullable(), path: z.string().max(512),
  handle: z.string().max(64), status: agentTeamNodeStatusSchema, permissionLevel: z.enum(['read-only', 'edit', 'full-access']),
  writer: z.boolean(), unreadMessages: revision, currentTaskId: domainId.optional(),
  workspace: z.object({ mode: z.enum(['shared', 'worktree']), state: z.enum(['ready', 'removed']),
    branch: z.string().max(240).optional(), review: workspaceReviewSchema.optional() }).strict().optional() }).strict();
export const teamReadSchema = z.object({ ...selection, teams: z.array(z.object({ id: domainId,
  rootNodeId: domainId, status: z.enum(['active', 'paused', 'settling', 'closing', 'closed', 'released', 'restored-interrupted']),
  selected: z.boolean(), activeTurns: revision, writerNodeId: domainId.nullable(), nodes: z.array(node).max(500),
  nodesTruncated: z.boolean() }).strict()).max(64), truncated: z.boolean() }).strict();
export const agentReadSchema = z.object({ ...selection, agents: z.array(z.object({ id: domainId,
  status: z.string().min(1).max(60), updatedAt: z.number().finite(), workflowId: domainId.optional() }).strict()).max(500),
  truncated: z.boolean() }).strict();
export const gitDiffReadSchema = z.object({ path: projectRelativePathSchema, state: z.enum(['text', 'binary', 'large', 'unavailable']),
  original: z.string().max(500_000).optional(), modified: z.string().max(500_000).optional(), language: z.string().max(100),
  mediaOmitted: z.boolean() }).strict();
export const gitCombinedReadSchema = z.object({ patch: z.string().max(500_000), truncated: z.boolean() }).strict();
export const gitCommitReadSchema = gitCommitSummarySchema.extend({ filesChanged: revision, additions: revision, deletions: revision,
  files: z.array(gitCommitFileSchema.extend({ path: projectRelativePathSchema, oldPath: projectRelativePathSchema.optional() }).strict()).max(500),
  filesTruncated: z.boolean() }).strict();
export const monitorDetailSchema = z.object({ ...selection, id: z.string().regex(/^[a-f0-9]{32}$/u),
  kind: z.enum(['run', 'team-node', 'task', 'event']), state: z.enum(['normal', 'active', 'attention']),
  updatedAt: z.number().finite(), title: z.string().max(240), detail: z.string().max(2000), redacted: z.boolean(),
  target: z.union([z.object({ kind: z.literal('task'), taskId: domainId }).strict(),
    z.object({ kind: z.literal('team-node'), teamId: domainId, nodeId: domainId }).strict(),
    z.object({ kind: z.literal('goal-criterion'), goalId: domainId, criterionId: domainId }).strict()]).optional() }).strict();
const teamOptions = agentTeamControlInputSchema.options;
const teamControl = z.discriminatedUnion('action', [teamOptions[0], teamOptions[1], teamOptions[2], teamOptions[3],
  teamOptions[4], teamOptions[5], teamOptions[6], teamOptions[7], teamOptions[9], teamOptions[10], teamOptions[11],
  teamOptions[12], teamOptions[13], teamOptions[14]]);
// Transport operation identity is host-derived; callers may not override executor idempotency keys.
export const networkTeamControlSchema = teamControl.superRefine((input, context) => {
  if (input.operationId !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['operationId'], message: 'Operation identity is host-owned.' });
});
export const workspaceControlSchema = z.object({ teamId: domainId, target: domainId,
  operation: z.enum(['review', 'checkpoint', 'integrate', 'cleanup']), message: z.string().trim().min(1).max(2000).optional(),
  strategy: z.enum(['ff-only', 'cherry-pick']).optional(), commits: z.array(z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u)).min(1).max(128).optional(),
  expectedSourceHead: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u).optional(),
  expectedTargetHead: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u).optional() }).strict().superRefine((value, context) => {
  if (value.operation === 'integrate' && (!value.expectedSourceHead || !value.expectedTargetHead || !value.strategy)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Integration requires reviewed source/target heads and strategy.' });
  }
});
const read = <N extends string, S extends z.ZodType<unknown>, R extends z.ZodType<unknown>, C extends string>(name: N, inputSchema: S, result: R, capability: C, bytes = 512 * 1024) => ({
  name, inputSchema, domainResultSchema: result, wireResultSchema: result, scope: 'workspace-read' as const,
  authorization: 'workspace-member' as const, capability, permission: 'read' as const, mutation: 'read' as const,
  retry: 'read-again' as const, handlerDestination: `trustedHost.${name}`, maxDomainBytes: bytes, maxWireBytes: bytes,
});
const mutation = <N extends OperationMethod, S extends z.ZodType<unknown>, C extends string>(name: N, inputSchema: S, capability: C) => ({
  name, inputSchema, domainResultSchema: operationDomainSchema, wireResultSchema: operationReceiptSchema,
  scope: 'session-control' as const, authorization: 'workspace-controller' as const, capability,
  permission: 'prompt' as const, mutation: 'runtime' as const, retry: 'same-envelope-only-no-automatic-replay' as const,
  handlerDestination: `trustedHost.${name}`, maxDomainBytes: 2048, maxWireBytes: 2048,
});
export const hostMethodCatalog = {
  'session.history': read('session.history', z.object({ pageId: uuidSchema.optional() }).strict(), historyPageSchema, 'session.history', SNAPSHOT_PAGE_BYTES),
  'session.list': read('session.list', z.object({ query: z.string().max(500).default('') }).strict(), sessionReadSchema, 'session.read'),
  'runtime.models': read('runtime.models', emptyInputSchema, modelReadSchema, 'runtime.configure'),
  'runtime.queueRead': read('runtime.queueRead', emptyInputSchema, queueReadSchema, 'queue.read', 1024 * 1024),
  'team.read': read('team.read', emptyInputSchema, teamReadSchema, 'agent.read', 1024 * 1024),
  'agent.read': read('agent.read', emptyInputSchema, agentReadSchema, 'agent.read'),
  'git.diff': read('git.diff', z.object({ path: projectRelativePathSchema }).strict(), gitDiffReadSchema, 'git.read', 1536 * 1024),
  'git.combinedDiff': read('git.combinedDiff', emptyInputSchema, gitCombinedReadSchema, 'git.read', 1536 * 1024),
  'git.commitDetails': read('git.commitDetails', z.object({ hash: z.string().regex(/^[0-9a-f]{40,64}$/u) }).strict(), gitCommitReadSchema, 'git.read'),
  'workspace.monitorDetail': read('workspace.monitorDetail', z.object({ id: z.string().regex(/^[a-f0-9]{32}$/u) }).strict(), monitorDetailSchema, 'workspace.monitor', 16 * 1024),
  'text.upload': read('text.upload', textAttachmentInputSchema, textAttachmentReceiptSchema, 'text.context', 2048),
  'text.cancel': read('text.cancel', z.object({ attachmentId: textAttachmentIdSchema }).strict(), z.object({ canceled: z.literal(true) }).strict(), 'text.context', 2048),
  'session.create': mutation('session.create', emptyInputSchema, 'session.select'),
  'runtime.setModel': mutation('runtime.setModel', z.object({ provider: z.string().min(1).max(200), id: z.string().min(1).max(500) }).strict(), 'runtime.configure'),
  'runtime.setThinking': mutation('runtime.setThinking', z.object({ level: thinkingLevelSchema }).strict(), 'runtime.configure'),
  'runtime.queue': mutation('runtime.queue', queueMutationInputSchema, 'queue.control'),
  'goal.create': mutation('goal.create', goalMaxCreateInputSchema, 'goal.control'),
  'goal.control': mutation('goal.control', goalMaxControlInputSchema, 'goal.control'),
  'goal.update': mutation('goal.update', goalMaxUpdateInputSchema, 'goal.control'),
  'goal.clear': mutation('goal.clear', emptyInputSchema, 'goal.control'),
  'goal.editSteering': mutation('goal.editSteering', goalMaxSteeringEditInputSchema, 'goal.control'),
  'goal.removeSteering': mutation('goal.removeSteering', goalMaxSteeringRemoveInputSchema, 'goal.control'),
  'task.create': mutation('task.create', taskCreateInputSchema, 'task.control'),
  'task.update': mutation('task.update', taskUpdateInputSchema, 'task.control'),
  'task.reorder': mutation('task.reorder', taskReorderInputSchema, 'task.control'),
  'task.delete': mutation('task.delete', taskDeleteInputSchema, 'task.control'),
  'task.clear': mutation('task.clear', emptyInputSchema, 'task.control'),
  'agent.control': mutation('agent.control', subagentControlInputSchema, 'agent.control'),
  'team.control': mutation('team.control', networkTeamControlSchema, 'agent.control'),
  'agent.workspace': mutation('agent.workspace', workspaceControlSchema, 'agent.control'),
} as const;
export type HostMethodName = keyof typeof hostMethodCatalog;
export type HostReadMethod = { [M in HostMethodName]: (typeof hostMethodCatalog)[M]['mutation'] extends 'read' ? M : never }[HostMethodName];
export const hostOperationJournalMethods = ['runtime.prompt', 'runtime.abort', 'session.select', ...operationMethodSchema.options, 'permission.confirm'] as const;
