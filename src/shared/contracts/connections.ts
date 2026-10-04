import { z } from 'zod';
import { capabilitySchema, methodCatalog, publicWorkspaceSchema, type WireResultOf, type InputOf } from '../protocol/methods';
import { hostMethodCatalog, hostOperationJournalMethods } from '../protocol/hostOperations';
import { textUploadDisplaySchema } from '../protocol/attachments';
import { uuidSchema, mutationRequestIdSchema } from '../protocol/requestIds';
import { snapshotHeaderSchema, snapshotItemSchema } from '../protocol/snapshots';
import { responseEnvelopeSchema } from '../protocol/envelopes';
import type { MonitorReadInput } from './monitorDashboard';
import type { SaveSshProfile } from './connectionEditor';

const revision = z.number().int().nonnegative().safe();
const label = z.string().min(1).max(128).refine((value) => !/[\\/:\u0000-\u001f\u007f]/u.test(value)
  && !/(?:fo1|fc1|fb1|fs1|ft1|fx1)_/u.test(value));
export const connectionProfileSchema = z.object({ id: uuidSchema, label, hostId: uuidSchema }).strict();
export const connectionProfilesSchema = z.array(connectionProfileSchema).max(16);
export const connectionSelectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }).strict(),
  z.object({ kind: z.literal('remote'), profileId: uuidSchema }).strict(),
]);
export const connectionGenerationSchema = z.object({ generation: revision }).strict();
export const remoteScopeSchema = z.object({ generation: revision, profileId: uuidSchema, hostId: uuidSchema, serverEpoch: uuidSchema,
  workspaceId: uuidSchema, workspaceGeneration: revision, sessionId: uuidSchema.nullable(), selectionRevision: revision.nullable() }).strict();
export const remoteWorkspaceInputSchema = z.object({ generation: revision, workspace: publicWorkspaceSchema }).strict();
export const remoteReadInputSchema = z.object({ scope: remoteScopeSchema }).strict();
export const remoteMonitorInputSchema = remoteReadInputSchema.extend({ input: methodCatalog['workspace.monitor'].inputSchema }).strict();
export const remoteFileListInputSchema = remoteReadInputSchema.extend({ directoryId: uuidSchema.nullable() }).strict();
export const remotePreviewInputSchema = remoteReadInputSchema.extend({ fileId: uuidSchema }).strict();
export const remotePromptInputSchema = remoteReadInputSchema.extend({ input: methodCatalog['runtime.prompt'].inputSchema }).strict();
export const remoteHistoryInputSchema = remoteReadInputSchema.extend({ input: hostMethodCatalog['session.history'].inputSchema }).strict();
export const remoteSessionsInputSchema = remoteReadInputSchema.extend({ input: hostMethodCatalog['session.list'].inputSchema }).strict();
export const remoteGitDiffInputSchema = remoteReadInputSchema.extend({ input: hostMethodCatalog['git.diff'].inputSchema }).strict();
export const remoteGitCommitInputSchema = remoteReadInputSchema.extend({ input: hostMethodCatalog['git.commitDetails'].inputSchema }).strict();
export const remoteMonitorDetailInputSchema = remoteReadInputSchema.extend({ input: hostMethodCatalog['workspace.monitorDetail'].inputSchema }).strict();
export const remoteUploadInputSchema = remoteReadInputSchema.extend({ input: textUploadDisplaySchema }).strict();
export const remoteCancelTextInputSchema = remoteReadInputSchema.extend({ input: hostMethodCatalog['text.cancel'].inputSchema }).strict();
export const remoteOperationSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('session.create'), input: hostMethodCatalog['session.create'].inputSchema }).strict(),
  z.object({ method: z.literal('runtime.setModel'), input: hostMethodCatalog['runtime.setModel'].inputSchema }).strict(),
  z.object({ method: z.literal('runtime.setThinking'), input: hostMethodCatalog['runtime.setThinking'].inputSchema }).strict(),
  z.object({ method: z.literal('runtime.queue'), input: hostMethodCatalog['runtime.queue'].inputSchema }).strict(),
  z.object({ method: z.literal('goal.create'), input: hostMethodCatalog['goal.create'].inputSchema }).strict(),
  z.object({ method: z.literal('goal.control'), input: hostMethodCatalog['goal.control'].inputSchema }).strict(),
  z.object({ method: z.literal('goal.update'), input: hostMethodCatalog['goal.update'].inputSchema }).strict(),
  z.object({ method: z.literal('goal.clear'), input: hostMethodCatalog['goal.clear'].inputSchema }).strict(),
  z.object({ method: z.literal('goal.editSteering'), input: hostMethodCatalog['goal.editSteering'].inputSchema }).strict(),
  z.object({ method: z.literal('goal.removeSteering'), input: hostMethodCatalog['goal.removeSteering'].inputSchema }).strict(),
  z.object({ method: z.literal('task.create'), input: hostMethodCatalog['task.create'].inputSchema }).strict(),
  z.object({ method: z.literal('task.update'), input: hostMethodCatalog['task.update'].inputSchema }).strict(),
  z.object({ method: z.literal('task.reorder'), input: hostMethodCatalog['task.reorder'].inputSchema }).strict(),
  z.object({ method: z.literal('task.delete'), input: hostMethodCatalog['task.delete'].inputSchema }).strict(),
  z.object({ method: z.literal('task.clear'), input: hostMethodCatalog['task.clear'].inputSchema }).strict(),
  z.object({ method: z.literal('agent.control'), input: hostMethodCatalog['agent.control'].inputSchema }).strict(),
  z.object({ method: z.literal('team.control'), input: hostMethodCatalog['team.control'].inputSchema }).strict(),
  z.object({ method: z.literal('agent.workspace'), input: hostMethodCatalog['agent.workspace'].inputSchema }).strict(),
]);
export const remoteOperationInputSchema = remoteReadInputSchema.extend({ operation: remoteOperationSchema }).strict();
export type RemoteOperation = z.infer<typeof remoteOperationSchema>;
export type RemotePromptOptions = Omit<InputOf<'runtime.prompt'>, 'text'>;
export const remoteSessionInputSchema = remoteReadInputSchema.extend({ sessionId: uuidSchema }).strict();
export const remoteIssuePermissionInputSchema = remoteReadInputSchema.extend({ level: methodCatalog['permission.issue'].inputSchema.shape.newLevel }).strict();
export const remoteConfirmPermissionInputSchema = remoteReadInputSchema.extend({ challengeId: uuidSchema }).strict();
export const remoteStatusInputSchema = remoteReadInputSchema.extend({ requestId: mutationRequestIdSchema }).strict();
export const remoteSnapshotSchema = z.object({ scope: remoteScopeSchema, header: snapshotHeaderSchema,
  items: z.array(snapshotItemSchema).max(160_000) }).strict();
export const remoteMonitorSchema = z.object({ scope: remoteScopeSchema, dashboard: methodCatalog['workspace.monitor'].wireResultSchema }).strict();
export const remoteMutationSchema = z.object({ requestId: mutationRequestIdSchema,
  status: z.enum(['confirmed', 'not-started', 'outcome_unknown']), response: responseEnvelopeSchema.nullable() }).strict()
  .refine((value) => value.status !== 'confirmed' || value.response?.ok === true && value.response.requestId === value.requestId);
const permissionLevel = z.enum(['read-only', 'edit', 'full-access']);
const permissionObservationSchema = z.object({ sessionId: uuidSchema.nullable(), selectionRevision: revision.nullable(),
  level: permissionLevel, capturedAt: z.number().int().nonnegative().safe() }).strict();
export const pendingRemoteOutcomeSchema = z.object({ scope: remoteScopeSchema, requestId: mutationRequestIdSchema,
  method: z.enum([...hostOperationJournalMethods, 'permission.confirm']), sessionId: uuidSchema, selectionRevision: revision,
  status: z.enum(['sending', 'confirmed', 'not-started', 'outcome_unknown']),
  targetSessionId: uuidSchema.optional(),
  permission: z.object({ oldLevel: permissionLevel, newLevel: permissionLevel,
    // Optional only to load older uncertain records safely; no missing tuple can settle a grant.
    challengeId: uuidSchema.optional(), controlGeneration: revision.optional(),
    observed: permissionObservationSchema.nullable() }).strict().optional() }).strict()
  .refine((value) => value.requestId.startsWith(`${value.scope.serverEpoch}.`) && value.scope.sessionId === value.sessionId
    && value.scope.selectionRevision === value.selectionRevision
    && (value.targetSessionId === undefined || value.method === 'session.select')
    && (value.permission === undefined || value.method === 'permission.confirm'
      && (value.permission.challengeId === undefined) === (value.permission.controlGeneration === undefined)));
export const desktopConnectionStateSchema = z.object({ kind: z.enum(['local', 'remote']), generation: revision,
  profile: connectionProfileSchema.nullable(), serverEpoch: uuidSchema.nullable(), scope: remoteScopeSchema.nullable(),
  hostName: methodCatalog['host.info'].wireResultSchema.shape.hostName.nullable().optional(),
  serverTime: z.number().int().nonnegative().safe().nullable().optional(), takeoverAllowed: z.boolean().optional(),
  providerStatus: z.enum(['auth-required', 'unverified']).nullable().optional(),
  status: z.enum(['disconnected', 'connecting', 'authenticating', 'synchronizing', 'observing', 'controlling', 'reconnecting', 'incompatible', 'error']),
  capabilities: z.array(capabilitySchema).max(32), controlGeneration: revision.nullable(),
  permissionLevel: z.enum(['read-only', 'edit', 'full-access']).nullable(),
  lastConfirmedStatus: z.enum(['running', 'idle', 'unknown']), lastConfirmedAt: z.number().finite().nullable(),
  pending: z.array(pendingRemoteOutcomeSchema).max(128), outcomeStorage: z.enum(['ready', 'blocked']),
  message: z.enum(['local', 'selected', 'connecting', 'ready', 'disconnected', 'connection-failed', 'identity-mismatch', 'protocol-incompatible', 'refresh-required',
    'ssh-connecting', 'ssh-unavailable', 'ssh-host-verification-required', 'ssh-authentication-failed', 'ssh-port-collision', 'ssh-stop-pending',
    'profile-unhealthy', 'workspace-mismatch', 'provider-auth-required']),
}).strict();
export type ConnectionProfile = z.infer<typeof connectionProfileSchema>;
export type ConnectionSelection = z.infer<typeof connectionSelectSchema>;
export type RemoteScope = z.infer<typeof remoteScopeSchema>;
export type DesktopConnectionState = z.infer<typeof desktopConnectionStateSchema>;
export type RemoteSnapshot = z.infer<typeof remoteSnapshotSchema>;
export type RemoteMonitor = z.infer<typeof remoteMonitorSchema>;
export type RemoteMutation = z.infer<typeof remoteMutationSchema>;

/** A named, scoped bridge. No endpoint, credential, owner key, or host/config path is accepted. */
export interface DesktopConnectionApi {
  pickConnectionCredential?(): Promise<{ selectionId: string } | null>;
  saveSshConnectionProfile?(input: SaveSshProfile): Promise<ConnectionProfile>;
  listConnectionProfiles(): Promise<readonly ConnectionProfile[]>;
  getConnectionState(): Promise<DesktopConnectionState>;
  selectConnectionProfile(selection: ConnectionSelection): Promise<DesktopConnectionState>;
  connectConnection(generation: number): Promise<DesktopConnectionState>;
  disconnectConnection(generation: number): Promise<DesktopConnectionState>;
  onConnectionState(listener: (state: DesktopConnectionState) => void): () => void;
  remoteListWorkspaces(generation: number): Promise<readonly WireResultOf<'workspace.list'>['workspaces'][number][]>;
  remoteReadSnapshot(generation: number, workspace: z.infer<typeof publicWorkspaceSchema>): Promise<RemoteSnapshot>;
  remoteReadMonitor(scope: RemoteScope, input?: MonitorReadInput): Promise<RemoteMonitor>;
  remoteReadGoal(scope: RemoteScope): Promise<WireResultOf<'goal.get'>>;
  remoteReadTasks(scope: RemoteScope): Promise<WireResultOf<'task.list'>>;
  remoteReadGitStatus(scope: RemoteScope): Promise<WireResultOf<'git.status'>>;
  remoteReadGitHistory(scope: RemoteScope): Promise<WireResultOf<'git.history'>>;
  remoteReadHistory(scope: RemoteScope, pageId?: string): Promise<WireResultOf<'session.history'>>;
  remoteReadSessions(scope: RemoteScope, query: string): Promise<WireResultOf<'session.list'>>;
  remoteReadModels(scope: RemoteScope): Promise<WireResultOf<'runtime.models'>>;
  remoteReadQueue(scope: RemoteScope): Promise<WireResultOf<'runtime.queueRead'>>;
  remoteReadTeams(scope: RemoteScope): Promise<WireResultOf<'team.read'>>;
  remoteReadAgents(scope: RemoteScope): Promise<WireResultOf<'agent.read'>>;
  remoteReadGitDiff(scope: RemoteScope, path: string): Promise<WireResultOf<'git.diff'>>;
  remoteReadGitCombinedDiff(scope: RemoteScope): Promise<WireResultOf<'git.combinedDiff'>>;
  remoteReadGitCommitDetails(scope: RemoteScope, hash: string): Promise<WireResultOf<'git.commitDetails'>>;
  remoteReadMonitorDetail(scope: RemoteScope, id: string): Promise<WireResultOf<'workspace.monitorDetail'>>;
  remoteUploadText(scope: RemoteScope, input: z.infer<typeof textUploadDisplaySchema>): Promise<WireResultOf<'text.upload'>>;
  remoteCancelText(scope: RemoteScope, id: string): Promise<void>;
  remoteApplyOperation(scope: RemoteScope, operation: RemoteOperation): Promise<RemoteMutation>;
  remoteListFiles(scope: RemoteScope, directoryId: string | null): Promise<WireResultOf<'file.list'>>;
  remotePreviewText(scope: RemoteScope, fileId: string): Promise<WireResultOf<'file.previewText'>>;
  remoteClaimControl(scope: RemoteScope): Promise<WireResultOf<'control.claim'>>;
  remoteRenewControl(scope: RemoteScope): Promise<WireResultOf<'control.renew'>>;
  remoteTakeOverControl(scope: RemoteScope): Promise<WireResultOf<'control.takeover'>>;
  remoteReleaseControl(scope: RemoteScope): Promise<void>;
  remoteIssuePermission(scope: RemoteScope, level: InputOf<'permission.issue'>['newLevel']): Promise<WireResultOf<'permission.issue'>>;
  remoteConfirmPermission(scope: RemoteScope, challengeId: string): Promise<RemoteMutation>;
  remoteSendPrompt(scope: RemoteScope, text: string, options?: RemotePromptOptions): Promise<RemoteMutation>;
  remoteAbort(scope: RemoteScope): Promise<RemoteMutation>;
  remoteSelectSession(scope: RemoteScope, sessionId: string): Promise<RemoteMutation>;
  remoteReviewCommand(scope: RemoteScope, requestId: string): Promise<WireResultOf<'command.status'>>;
}

/** Explicit projection used by renderer adapters; never spread an arbitrary bridge. */
export function selectConnectionMethods(api: DesktopConnectionApi): DesktopConnectionApi {
  return { ...(api.pickConnectionCredential ? { pickConnectionCredential: api.pickConnectionCredential } : {}),
    ...(api.saveSshConnectionProfile ? { saveSshConnectionProfile: api.saveSshConnectionProfile } : {}),
    listConnectionProfiles: api.listConnectionProfiles, getConnectionState: api.getConnectionState,
    selectConnectionProfile: api.selectConnectionProfile, connectConnection: api.connectConnection,
    disconnectConnection: api.disconnectConnection, onConnectionState: api.onConnectionState,
    remoteListWorkspaces: api.remoteListWorkspaces, remoteReadSnapshot: api.remoteReadSnapshot,
    remoteReadMonitor: api.remoteReadMonitor, remoteReadGoal: api.remoteReadGoal, remoteReadTasks: api.remoteReadTasks,
    remoteReadGitStatus: api.remoteReadGitStatus, remoteReadGitHistory: api.remoteReadGitHistory,
    remoteReadHistory: api.remoteReadHistory,
    remoteReadSessions: api.remoteReadSessions, remoteReadModels: api.remoteReadModels, remoteReadQueue: api.remoteReadQueue,
    remoteReadTeams: api.remoteReadTeams, remoteReadAgents: api.remoteReadAgents, remoteReadGitDiff: api.remoteReadGitDiff,
    remoteReadGitCombinedDiff: api.remoteReadGitCombinedDiff, remoteReadGitCommitDetails: api.remoteReadGitCommitDetails,
    remoteReadMonitorDetail: api.remoteReadMonitorDetail, remoteUploadText: api.remoteUploadText,
    remoteCancelText: api.remoteCancelText, remoteApplyOperation: api.remoteApplyOperation,
    remoteListFiles: api.remoteListFiles, remotePreviewText: api.remotePreviewText,
    remoteClaimControl: api.remoteClaimControl, remoteRenewControl: api.remoteRenewControl,
    remoteTakeOverControl: api.remoteTakeOverControl, remoteReleaseControl: api.remoteReleaseControl,
    remoteIssuePermission: api.remoteIssuePermission, remoteConfirmPermission: api.remoteConfirmPermission,
    remoteSendPrompt: api.remoteSendPrompt, remoteAbort: api.remoteAbort, remoteSelectSession: api.remoteSelectSession,
    remoteReviewCommand: api.remoteReviewCommand };
}
