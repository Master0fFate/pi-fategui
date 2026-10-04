import { z } from 'zod';
import { abortResultSchema, emptyInputSchema, fileEntrySchema, promptAcceptanceSchema } from '../contracts/ipc';
import { millisecondsSchema, mutationRequestIdSchema, uuidSchema } from './requestIds';
import { commandStatusSchema } from './commandOutcomes';
import { snapshotPageSchema, SNAPSHOT_PAGE_BYTES } from './snapshots';
import { networkMonitorSchema } from './diagnostics';
import { monitorReadInputSchema } from '../contracts/monitorDashboard';
import { goalMaxStatusSchema, goalMaxPhaseSchema, goalMaxExecutionStateSchema, goalMaxCriterionSchema, goalMaxEvidenceKindSchema, goalMaxSteeringSchema } from '../contracts/goalmaxxing';
import { taskSchema } from '../contracts/tasks';
import { gitChangeSchema, gitCommitSummarySchema } from '../contracts/ipc';
import { hostMethodCatalog } from './hostOperations';
import { networkPromptInputSchema, projectFileReferenceSchema } from './attachments';

export const MAX_COMMAND_BYTES = 1024 * 1024;
export const MAX_RESULT_BYTES = 2 * 1024 * 1024;
export const revisionSchema = z.number().int().nonnegative().safe();
export const capabilitySchema = z.enum(['host.info', 'workspace.list', 'file.read', 'workspace.snapshot', 'workspace.monitor', 'goal.read', 'task.read', 'git.read', 'workspace.control', 'permission.approve', 'runtime.prompt', 'runtime.abort', 'session.select', 'terminal.manual', 'session.read', 'session.history', 'runtime.configure', 'goal.control', 'task.control', 'queue.read', 'queue.control', 'agent.read', 'agent.control', 'text.context']);
export type Capability = z.infer<typeof capabilitySchema>;

// Resource IDs are issued and resolved by the host. No raw/relative paths enter this initial surface.
// Labels are presentation names, not absolute paths. Contents are authorized plain text, never HTML/media.
const labelSchema = z.string().min(1).max(128).refine((text) => !/[\\/:\u0000-\u001f\u007f]/u.test(text));
export const publicWorkspaceSchema = z.object({ workspaceId: uuidSchema, workspaceGeneration: revisionSchema, label: labelSchema }).strict();
export const publicHostReadinessSchema = z.object({ ready: z.boolean(), profileLock: z.enum(['held', 'unavailable']),
  workspaceRegistry: z.enum(['ready', 'unavailable']), permissionStore: z.enum(['healthy', 'unhealthy']),
  commandJournal: z.enum(['healthy', 'unhealthy']), authentication: z.enum(['ready', 'unavailable']),
  requiredServices: z.enum(['ready', 'unavailable']), provider: z.enum(['auth-required', 'unverified']),
}).strict();
export type PublicHostReadiness = z.infer<typeof publicHostReadinessSchema>;
const hostInfoSchema = z.object({
  hostId: uuidSchema,
  hostName: labelSchema.optional(),
  takeoverAllowed: z.boolean().optional(),
  protocol: z.literal(1),
  serverEpoch: uuidSchema,
  serverTime: millisecondsSchema,
  appVersion: z.string().min(1).max(32).regex(/^[0-9A-Za-z.+-]+$/u),
  capabilities: z.array(capabilitySchema).max(32).refine((items) => new Set(items).size === items.length),
  networkDispatchEnabled: z.boolean(),
  readiness: publicHostReadinessSchema.optional(),
}).strict();
const workspaceListSchema = z.object({ workspaces: z.array(publicWorkspaceSchema).max(8) }).strict()
  .refine(({ workspaces }) => new Set(workspaces.map((item) => item.workspaceId)).size === workspaces.length);
const fileListSchema = z.object({
  directoryId: uuidSchema.nullable(),
  entries: z.array(z.object({ resourceId: uuidSchema, name: labelSchema, kind: fileEntrySchema.shape.kind,
    relativePath: projectFileReferenceSchema.optional() }).strict()).max(200),
  truncated: z.boolean(),
}).strict().refine(({ entries }) => new Set(entries.map((item) => item.resourceId)).size === entries.length);
/** Host-scoped views deliberately omit host paths, goal evidence text/commands, and Git remotes.
 * Limits fail closed instead of silently turning a complete result into a partial one. */
export const goalReadSchema = z.object({ sessionId: uuidSchema, selectionRevision: revisionSchema, goal: z.object({
  id: z.string().min(1).max(160), revision: revisionSchema, objective: z.string().max(12_000),
  status: goalMaxStatusSchema, phase: goalMaxPhaseSchema, executionState: goalMaxExecutionStateSchema,
  criteria: z.array(goalMaxCriterionSchema).max(32),
  evidence: z.array(z.object({ id: z.string().min(1).max(160), kind: goalMaxEvidenceKindSchema,
    criterionIds: z.array(z.string().min(1).max(160)).max(32), source: z.enum(['runtime', 'root-tool', 'child-tool', 'verifier', 'user', 'workspace']),
    current: z.boolean(), timestamp: millisecondsSchema }).strict()).max(256),
  steering: z.array(goalMaxSteeringSchema.extend({ textClipped: z.boolean() }).strict()).max(32).optional(),
  steeringTruncated: z.boolean().optional(), continuationPending: z.boolean(), updatedAt: millisecondsSchema,
}).strict().nullable() }).strict();
export const taskReadSchema = z.object({ sessionId: uuidSchema, selectionRevision: revisionSchema,
  list: z.object({ schemaVersion: z.literal(1), revision: revisionSchema, goalId: z.string().min(1).max(160).nullable(),
    currentTaskId: z.string().min(1).max(160).nullable(), updatedAt: millisecondsSchema,
    tasks: z.array(taskSchema).max(200) }).strict().nullable() }).strict();
const scopedGitPathSchema = z.string().min(1).max(4096).refine((value) => !value.includes('\\')
  && !value.startsWith('/') && !/^[A-Za-z]:/u.test(value)
  && !/[\u0000-\u001f\u007f]/u.test(value)
  && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'));
export const gitStatusReadSchema = z.object({ repository: z.boolean(), branch: z.string().max(1000),
  ahead: revisionSchema, behind: revisionSchema, changes: z.array(gitChangeSchema.extend({
    path: scopedGitPathSchema, oldPath: scopedGitPathSchema.optional() }).strict()).max(200),
  additions: revisionSchema, deletions: revisionSchema, truncated: z.boolean() }).strict();
export const gitHistoryReadSchema = z.object({ head: z.string().regex(/^[0-9a-f]{40,64}$/u).nullable(),
  commits: z.array(gitCommitSummarySchema).max(100), truncated: z.boolean() }).strict();
const textPreviewSchema = z.object({
  fileId: uuidSchema,
  content: z.string().max(32_768),
  truncated: z.boolean(),
}).strict();

// Reuse only portable pieces. In particular, never reuse RuntimeState, raw file DTOs,
// rich prompt attachments/sessionReferences, provider settings, or session path inputs.
const promptDomainSchema = promptAcceptanceSchema.extend({ runId: uuidSchema, sessionId: uuidSchema, viewRevision: revisionSchema }).strict();
const abortDomainSchema = abortResultSchema.extend({ sessionId: uuidSchema, viewRevision: revisionSchema }).strict();
const selectDomainSchema = z.object({ sessionId: uuidSchema, selectionRevision: revisionSchema, viewRevision: revisionSchema }).strict();
/** Leases are volatile server state, not durable command outcomes or client-selected identities. */
const controlResultSchema = z.object({ generation: revisionSchema, expiresAt: millisecondsSchema.nullable() }).strict();
const permissionActionSchema = z.literal('runtime.setPermission');
const permissionLevelSchema = z.enum(['read-only', 'edit', 'full-access']);
const approvalTargetFields = { sessionId: uuidSchema, action: permissionActionSchema,
  oldLevel: permissionLevelSchema, newLevel: permissionLevelSchema };
const approvalChallengeResultSchema = z.object({ challengeId: uuidSchema, sessionId: uuidSchema,
  oldLevel: permissionLevelSchema, newLevel: permissionLevelSchema, expiresAt: millisecondsSchema }).strict();
const approvalConfirmationResultSchema = z.object({ applied: z.literal(true), sessionId: uuidSchema,
  level: permissionLevelSchema }).strict();
const receiptFields = { requestId: mutationRequestIdSchema, durability: z.enum(['not-journaled', 'journaled']), sessionId: uuidSchema, viewRevision: revisionSchema };
const promptReceiptSchema = z.object({ ...receiptFields, kind: z.literal('prompt'), outcome: z.enum(['accepted', 'not-accepted']), runId: uuidSchema }).strict();
const abortReceiptSchema = z.object({ ...receiptFields, kind: z.literal('abort'), outcome: z.enum(['abort-reported', 'nothing-to-abort']) }).strict();
const selectReceiptSchema = z.object({ ...receiptFields, kind: z.literal('selection'), outcome: z.literal('selected'), selectionRevision: revisionSchema }).strict();

interface Descriptor {
  readonly name: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly domainResultSchema: z.ZodType<unknown>;
  readonly wireResultSchema: z.ZodType<unknown>;
  readonly scope: 'host' | 'resource' | 'workspace-read' | 'workspace-control' | 'session-approval' | 'session-control';
  readonly authorization: 'authenticated' | 'workspace-member' | 'workspace-controller';
  readonly capability: Capability;
  readonly permission: 'none' | 'read' | 'prompt' | 'abort' | 'select';
  readonly mutation: 'read' | 'control' | 'grant' | 'runtime' | 'selection';
  readonly retry: 'read-again' | 'new-action-only' | 'same-envelope-only-no-automatic-replay';
  readonly handlerDestination: string;
  readonly maxDomainBytes: number;
  readonly maxWireBytes: number;
}

/** No settings.get/set descriptor: clientPreferences is client-owned presentation, while host settings and secrets stay local-native. */
export const networkSettingsSupport = Object.freeze({ clientAppearance: 'client-owned', hostSettings: 'unsupported' } as const);
/** Only a one-use, ticket-bound confirmation may invoke the runtime's durable save-before-activation transaction. */
export const networkPermissionApprovalsEnabled = true;
/** Deliberately absent from methodCatalog: local Git revert uses no expected-HEAD review or safe restore filter policy. */
export const unsupportedNetworkGitMutations = Object.freeze(['git.commit', 'git.revert', 'git.worktreeCleanup', 'git.fetch', 'git.pull', 'git.push'] as const);

/** Explicit preparation catalog, NOT a reflection/export of the 179-method desktop API. */
export const methodCatalog = Object.freeze({
  ...hostMethodCatalog,
  'host.info': Object.freeze({
    name: 'host.info', inputSchema: emptyInputSchema, domainResultSchema: hostInfoSchema, wireResultSchema: hostInfoSchema,
    scope: 'host', authorization: 'authenticated', capability: 'host.info', permission: 'none', mutation: 'read', retry: 'read-again',
    handlerDestination: 'trustedHost.publicInfo', maxDomainBytes: 4096, maxWireBytes: 4096,
  }),
  'workspace.list': Object.freeze({
    name: 'workspace.list', inputSchema: emptyInputSchema, domainResultSchema: workspaceListSchema, wireResultSchema: workspaceListSchema,
    scope: 'host', authorization: 'authenticated', capability: 'workspace.list', permission: 'none', mutation: 'read', retry: 'read-again',
    handlerDestination: 'trustedHost.memberWorkspaces', maxDomainBytes: 8192, maxWireBytes: 8192,
  }),
  'workspace.snapshot': Object.freeze({
    name: 'workspace.snapshot', inputSchema: emptyInputSchema, domainResultSchema: snapshotPageSchema, wireResultSchema: snapshotPageSchema,
    scope: 'workspace-read', authorization: 'workspace-member', capability: 'workspace.snapshot', permission: 'read', mutation: 'read', retry: 'read-again',
    handlerDestination: 'trustedHost.scopedSnapshot.capture', maxDomainBytes: SNAPSHOT_PAGE_BYTES, maxWireBytes: SNAPSHOT_PAGE_BYTES,
  }),
  'workspace.snapshotPage': Object.freeze({
    name: 'workspace.snapshotPage', inputSchema: z.object({ pageId: uuidSchema }).strict(), domainResultSchema: snapshotPageSchema, wireResultSchema: snapshotPageSchema,
    scope: 'workspace-read', authorization: 'workspace-member', capability: 'workspace.snapshot', permission: 'read', mutation: 'read', retry: 'read-again',
    handlerDestination: 'trustedHost.scopedSnapshot.page', maxDomainBytes: SNAPSHOT_PAGE_BYTES, maxWireBytes: SNAPSHOT_PAGE_BYTES,
  }),
  'goal.get': Object.freeze({
    name: 'goal.get', inputSchema: emptyInputSchema, domainResultSchema: goalReadSchema, wireResultSchema: goalReadSchema,
    scope: 'workspace-read', authorization: 'workspace-member', capability: 'goal.read', permission: 'read', mutation: 'read', retry: 'read-again',
    handlerDestination: 'trustedHost.scopedGoal.get', maxDomainBytes: 128 * 1024, maxWireBytes: 128 * 1024,
  }),
  'task.list': Object.freeze({
    name: 'task.list', inputSchema: emptyInputSchema, domainResultSchema: taskReadSchema, wireResultSchema: taskReadSchema,
    scope: 'workspace-read', authorization: 'workspace-member', capability: 'task.read', permission: 'read', mutation: 'read', retry: 'read-again',
    handlerDestination: 'trustedHost.scopedTask.get', maxDomainBytes: 512 * 1024, maxWireBytes: 512 * 1024,
  }),
  'git.status': Object.freeze({
    name: 'git.status', inputSchema: emptyInputSchema, domainResultSchema: gitStatusReadSchema, wireResultSchema: gitStatusReadSchema,
    scope: 'workspace-read', authorization: 'workspace-member', capability: 'git.read', permission: 'read', mutation: 'read', retry: 'read-again',
    handlerDestination: 'trustedHost.scopedGit.status', maxDomainBytes: 512 * 1024, maxWireBytes: 512 * 1024,
  }),
  'git.history': Object.freeze({
    name: 'git.history', inputSchema: emptyInputSchema, domainResultSchema: gitHistoryReadSchema, wireResultSchema: gitHistoryReadSchema,
    scope: 'workspace-read', authorization: 'workspace-member', capability: 'git.read', permission: 'read', mutation: 'read', retry: 'read-again',
    handlerDestination: 'trustedHost.scopedGit.history', maxDomainBytes: 256 * 1024, maxWireBytes: 256 * 1024,
  }),
  'workspace.monitor': Object.freeze({
    name: 'workspace.monitor', inputSchema: monitorReadInputSchema, domainResultSchema: networkMonitorSchema, wireResultSchema: networkMonitorSchema,
    scope: 'workspace-read', authorization: 'workspace-member', capability: 'workspace.monitor', permission: 'read', mutation: 'read', retry: 'read-again',
    handlerDestination: 'trustedHost.scopedMonitor.read', maxDomainBytes: 64 * 1024, maxWireBytes: 64 * 1024,
  }),
  'control.claim': Object.freeze({
    name: 'control.claim', inputSchema: emptyInputSchema, domainResultSchema: controlResultSchema, wireResultSchema: controlResultSchema,
    scope: 'workspace-control', authorization: 'workspace-member', capability: 'workspace.control', permission: 'none', mutation: 'control', retry: 'new-action-only',
    handlerDestination: 'trustedHost.workspaceControl.claim', maxDomainBytes: 256, maxWireBytes: 256,
  }),
  'control.renew': Object.freeze({
    name: 'control.renew', inputSchema: z.object({ generation: revisionSchema }).strict(), domainResultSchema: controlResultSchema, wireResultSchema: controlResultSchema,
    scope: 'workspace-control', authorization: 'workspace-member', capability: 'workspace.control', permission: 'none', mutation: 'control', retry: 'new-action-only',
    handlerDestination: 'trustedHost.workspaceControl.renew', maxDomainBytes: 256, maxWireBytes: 256,
  }),
  'control.release': Object.freeze({
    name: 'control.release', inputSchema: z.object({ generation: revisionSchema }).strict(), domainResultSchema: controlResultSchema, wireResultSchema: controlResultSchema,
    scope: 'workspace-control', authorization: 'workspace-member', capability: 'workspace.control', permission: 'none', mutation: 'control', retry: 'new-action-only',
    handlerDestination: 'trustedHost.workspaceControl.release', maxDomainBytes: 256, maxWireBytes: 256,
  }),
  'control.takeover': Object.freeze({
    name: 'control.takeover', inputSchema: emptyInputSchema, domainResultSchema: controlResultSchema, wireResultSchema: controlResultSchema,
    scope: 'workspace-control', authorization: 'workspace-member', capability: 'workspace.control', permission: 'none', mutation: 'control', retry: 'new-action-only',
    handlerDestination: 'trustedHost.workspaceControl.takeover', maxDomainBytes: 256, maxWireBytes: 256,
  }),
  'permission.issue': Object.freeze({
    name: 'permission.issue', inputSchema: z.object(approvalTargetFields).strict(),
    domainResultSchema: approvalChallengeResultSchema, wireResultSchema: approvalChallengeResultSchema,
    scope: 'session-approval', authorization: 'workspace-controller', capability: 'permission.approve', permission: 'none', mutation: 'control', retry: 'new-action-only',
    handlerDestination: 'trustedHost.approvalChallenges.issue', maxDomainBytes: 512, maxWireBytes: 512,
  }),
  'permission.confirm': Object.freeze({
    name: 'permission.confirm', inputSchema: z.object({ ...approvalTargetFields, challengeId: uuidSchema }).strict(),
    domainResultSchema: approvalConfirmationResultSchema, wireResultSchema: approvalConfirmationResultSchema,
    scope: 'session-approval', authorization: 'workspace-controller', capability: 'permission.approve', permission: 'none', mutation: 'grant', retry: 'same-envelope-only-no-automatic-replay',
    handlerDestination: 'trustedHost.approvalChallenges.confirmDurably', maxDomainBytes: 512, maxWireBytes: 512,
  }),
  'command.status': Object.freeze({
    name: 'command.status', inputSchema: z.object({ requestId: mutationRequestIdSchema }).strict(), domainResultSchema: commandStatusSchema, wireResultSchema: commandStatusSchema,
    scope: 'session-control', authorization: 'workspace-member', capability: 'workspace.list', permission: 'read', mutation: 'read', retry: 'read-again',
    handlerDestination: 'commandJournal.status', maxDomainBytes: 2048, maxWireBytes: 2048,
  }),
  'file.list': Object.freeze({
    name: 'file.list', inputSchema: z.object({ directoryId: uuidSchema.nullable(), limit: z.number().int().min(1).max(200) }).strict(),
    domainResultSchema: fileListSchema, wireResultSchema: fileListSchema,
    scope: 'resource', authorization: 'workspace-member', capability: 'file.read', permission: 'read', mutation: 'read', retry: 'read-again',
    handlerDestination: 'trustedHost.scopedFiles.listResource', maxDomainBytes: 64 * 1024, maxWireBytes: 64 * 1024,
  }),
  'file.previewText': Object.freeze({
    name: 'file.previewText', inputSchema: z.object({ fileId: uuidSchema, maxBytes: z.number().int().min(1).max(32_768) }).strict(),
    domainResultSchema: textPreviewSchema, wireResultSchema: textPreviewSchema,
    scope: 'resource', authorization: 'workspace-member', capability: 'file.read', permission: 'read', mutation: 'read', retry: 'read-again',
    handlerDestination: 'trustedHost.scopedFiles.previewTextResource', maxDomainBytes: 64 * 1024, maxWireBytes: 64 * 1024,
  }),
  'runtime.prompt': Object.freeze({
    name: 'runtime.prompt', inputSchema: networkPromptInputSchema, domainResultSchema: promptDomainSchema, wireResultSchema: promptReceiptSchema,
    scope: 'session-control', authorization: 'workspace-controller', capability: 'runtime.prompt', permission: 'prompt', mutation: 'runtime', retry: 'same-envelope-only-no-automatic-replay',
    handlerDestination: 'trustedHost.capturedSession.prompt', maxDomainBytes: 4096, maxWireBytes: 2048,
  }),
  'runtime.abort': Object.freeze({
    name: 'runtime.abort', inputSchema: emptyInputSchema, domainResultSchema: abortDomainSchema, wireResultSchema: abortReceiptSchema,
    scope: 'session-control', authorization: 'workspace-controller', capability: 'runtime.abort', permission: 'abort', mutation: 'runtime', retry: 'same-envelope-only-no-automatic-replay',
    handlerDestination: 'trustedHost.capturedSession.abort', maxDomainBytes: 4096, maxWireBytes: 2048,
  }),
  'session.select': Object.freeze({
    name: 'session.select', inputSchema: z.object({ sessionId: uuidSchema }).strict(), domainResultSchema: selectDomainSchema, wireResultSchema: selectReceiptSchema,
    scope: 'session-control', authorization: 'workspace-controller', capability: 'session.select', permission: 'select', mutation: 'selection', retry: 'same-envelope-only-no-automatic-replay',
    handlerDestination: 'trustedHost.capturedWorkspace.selectSession', maxDomainBytes: 4096, maxWireBytes: 2048,
  }),
} as const satisfies Record<string, Descriptor>);

export type MethodName = keyof typeof methodCatalog;
export type InputOf<M extends MethodName> = z.output<(typeof methodCatalog)[M]['inputSchema']>;
export type DomainResultOf<M extends MethodName> = z.output<(typeof methodCatalog)[M]['domainResultSchema']>;
export type WireResultOf<M extends MethodName> = z.output<(typeof methodCatalog)[M]['wireResultSchema']>;
export type MutationMethodName = { [M in MethodName]: (typeof methodCatalog)[M]['mutation'] extends 'runtime' | 'selection' ? M : never }[MethodName];
