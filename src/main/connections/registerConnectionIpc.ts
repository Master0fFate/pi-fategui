import { z } from 'zod';
import { emptyInputSchema, ipcChannels } from '../../shared/contracts/ipc';
import { methodCatalog, publicWorkspaceSchema } from '../../shared/protocol/methods';
import { connectionProfilesSchema, connectionSelectSchema, connectionGenerationSchema, desktopConnectionStateSchema,
  remoteWorkspaceInputSchema, remoteReadInputSchema, remoteMonitorInputSchema, remoteFileListInputSchema,
  remotePreviewInputSchema, remotePromptInputSchema, remoteSessionInputSchema, remoteStatusInputSchema,
  remoteSnapshotSchema, remoteMonitorSchema, remoteMutationSchema, remoteSessionsInputSchema, remoteGitDiffInputSchema,
  remoteGitCommitInputSchema, remoteMonitorDetailInputSchema, remoteUploadInputSchema, remoteCancelTextInputSchema,
  remoteOperationInputSchema, remoteIssuePermissionInputSchema, remoteConfirmPermissionInputSchema } from '../../shared/contracts/connections';
import type { DesktopConnectionRouter } from './DesktopConnectionRouter';

type Register = (channel: string, handler: (event: Electron.IpcMainInvokeEvent, input: unknown) => unknown | Promise<unknown>) => void;
/** Uses registerIpc's trusted main-frame AND captured document guard, not a renderer-provided owner. */
export function registerConnectionIpc(handle: Register, router: DesktopConnectionRouter,
  trusted: (event: Electron.IpcMainInvokeEvent) => () => boolean): void {
  const named = <I extends z.ZodTypeAny, O extends z.ZodTypeAny>(channel: string, inputSchema: I, outputSchema: O,
    operation: (input: z.output<I>, guard: () => boolean) => unknown | Promise<unknown>) => {
    handle(channel, async (event, input) => {
      const guard = trusted(event);
      if (!guard()) throw new Error('The initiating renderer document is unavailable.');
      const result = await operation(inputSchema.parse(input), guard);
      if (!guard()) throw new Error('The initiating renderer document is unavailable.');
      return outputSchema.parse(result);
    });
  };
  named(ipcChannels.connectionProfiles, emptyInputSchema, connectionProfilesSchema, () => router.listProfiles());
  named(ipcChannels.connectionState, emptyInputSchema, desktopConnectionStateSchema, () => router.state);
  named(ipcChannels.connectionSelect, connectionSelectSchema, desktopConnectionStateSchema, (input) => router.select(input));
  named(ipcChannels.connectionConnect, connectionGenerationSchema, desktopConnectionStateSchema, (input, guard) => router.connect(input, guard));
  named(ipcChannels.connectionDisconnect, connectionGenerationSchema, desktopConnectionStateSchema, (input) => router.disconnect(input));
  named(ipcChannels.remoteWorkspaces, connectionGenerationSchema, z.array(publicWorkspaceSchema).max(8),
    (input, guard) => router.read(input.generation, guard, (client) => client.listWorkspaces()));
  named(ipcChannels.remoteSnapshot, remoteWorkspaceInputSchema, remoteSnapshotSchema,
    (input, guard) => router.read(input.generation, guard, (client) => client.readSnapshot(input.workspace)));
  named(ipcChannels.remoteMonitor, remoteMonitorInputSchema, remoteMonitorSchema,
    (input, guard) => router.read(input.scope.generation, guard, (client) => client.monitor(input.scope, input.input)));
  named(ipcChannels.remoteGoal, remoteReadInputSchema, methodCatalog['goal.get'].wireResultSchema,
    (input, guard) => router.read(input.scope.generation, guard, (client) => client.read(input.scope, 'goal.get', {})));
  named(ipcChannels.remoteTasks, remoteReadInputSchema, methodCatalog['task.list'].wireResultSchema,
    (input, guard) => router.read(input.scope.generation, guard, (client) => client.read(input.scope, 'task.list', {})));
  named(ipcChannels.remoteGitStatus, remoteReadInputSchema, methodCatalog['git.status'].wireResultSchema,
    (input, guard) => router.read(input.scope.generation, guard, (client) => client.read(input.scope, 'git.status', {})));
  named(ipcChannels.remoteGitHistory, remoteReadInputSchema, methodCatalog['git.history'].wireResultSchema,
    (input, guard) => router.read(input.scope.generation, guard, (client) => client.read(input.scope, 'git.history', {})));
  const richEmpty = (channel: string, method: 'runtime.models' | 'runtime.queueRead' | 'team.read' | 'agent.read' | 'git.combinedDiff') =>
    named(channel, remoteReadInputSchema, methodCatalog[method].wireResultSchema,
      (input, guard) => router.read(input.scope.generation, guard, (client) => client.read(input.scope, method, {})));
  richEmpty(ipcChannels.remoteModels, 'runtime.models'); richEmpty(ipcChannels.remoteQueue, 'runtime.queueRead');
  richEmpty(ipcChannels.remoteTeams, 'team.read'); richEmpty(ipcChannels.remoteAgents, 'agent.read');
  richEmpty(ipcChannels.remoteGitCombinedDiff, 'git.combinedDiff');
  named(ipcChannels.remoteSessions, remoteSessionsInputSchema, methodCatalog['session.list'].wireResultSchema,
    (input, guard) => router.read(input.scope.generation, guard, (client) => client.read(input.scope, 'session.list', input.input)));
  named(ipcChannels.remoteGitDiff, remoteGitDiffInputSchema, methodCatalog['git.diff'].wireResultSchema,
    (input, guard) => router.read(input.scope.generation, guard, (client) => client.read(input.scope, 'git.diff', input.input)));
  named(ipcChannels.remoteGitCommitDetails, remoteGitCommitInputSchema, methodCatalog['git.commitDetails'].wireResultSchema,
    (input, guard) => router.read(input.scope.generation, guard, (client) => client.read(input.scope, 'git.commitDetails', input.input)));
  named(ipcChannels.remoteMonitorDetail, remoteMonitorDetailInputSchema, methodCatalog['workspace.monitorDetail'].wireResultSchema,
    (input, guard) => router.read(input.scope.generation, guard, (client) => client.read(input.scope, 'workspace.monitorDetail', input.input)));
  named(ipcChannels.remoteTextUpload, remoteUploadInputSchema, methodCatalog['text.upload'].wireResultSchema,
    (input, guard) => router.read(input.scope.generation, guard, (client) => client.uploadText(input.scope, input.input)));
  named(ipcChannels.remoteTextCancel, remoteCancelTextInputSchema, z.null(), async (input, guard) => {
    await router.read(input.scope.generation, guard, (client) => client.read(input.scope, 'text.cancel', input.input)); return null;
  });
  named(ipcChannels.remoteFiles, remoteFileListInputSchema, methodCatalog['file.list'].wireResultSchema,
    (input, guard) => router.read(input.scope.generation, guard, (client) => client.read(input.scope, 'file.list', { directoryId: input.directoryId, limit: 200 })));
  named(ipcChannels.remotePreview, remotePreviewInputSchema, methodCatalog['file.previewText'].wireResultSchema,
    (input, guard) => router.read(input.scope.generation, guard, (client) => client.read(input.scope, 'file.previewText', { fileId: input.fileId, maxBytes: 32768 })));
  named(ipcChannels.remoteClaim, remoteReadInputSchema, methodCatalog['control.claim'].wireResultSchema,
    (input, guard) => router.read(input.scope.generation, guard, (client) => client.claim(input.scope, guard)));
  named(ipcChannels.remoteRenew, remoteReadInputSchema, methodCatalog['control.renew'].wireResultSchema,
    (input, guard) => router.read(input.scope.generation, guard, (client) => client.leaseAction(input.scope, 'control.renew', guard)));
  named(ipcChannels.remoteTakeOver, remoteReadInputSchema, methodCatalog['control.takeover'].wireResultSchema,
    (input, guard) => router.read(input.scope.generation, guard, (client) => client.leaseAction(input.scope, 'control.takeover', guard)));
  named(ipcChannels.remoteIssuePermission, remoteIssuePermissionInputSchema, methodCatalog['permission.issue'].wireResultSchema,
    (input, guard) => router.read(input.scope.generation, guard, (client) => client.issuePermission(input.scope, input.level, guard)));
  handle(ipcChannels.remoteConfirmPermission, async (event, value) => {
    const input = remoteConfirmPermissionInputSchema.parse(value);
    return remoteMutationSchema.parse(await router.confirmPermission(input.scope, trusted(event), input.challengeId));
  });
  named(ipcChannels.remoteRelease, remoteReadInputSchema, z.null(),
    async (input, guard) => { await router.read(input.scope.generation, guard, (client) => client.release(input.scope)); return null; });
  // Mutations intentionally do not use named's post-await document rejection. Once sent,
  // the renderer must receive the original-ID unknown DTO, never an uncorrelated IPC error.
  handle(ipcChannels.remotePrompt, async (event, value) => {
    const input = remotePromptInputSchema.parse(value);
    return remoteMutationSchema.parse(await router.mutate(input.scope, trusted(event), 'runtime.prompt', input.input));
  });
  handle(ipcChannels.remoteAbort, async (event, value) => {
    const input = remoteReadInputSchema.parse(value);
    return remoteMutationSchema.parse(await router.mutate(input.scope, trusted(event), 'runtime.abort', {}));
  });
  handle(ipcChannels.remoteSession, async (event, value) => {
    const input = remoteSessionInputSchema.parse(value);
    return remoteMutationSchema.parse(await router.mutate(input.scope, trusted(event), 'session.select', { sessionId: input.sessionId }));
  });
  handle(ipcChannels.remoteApplyOperation, async (event, value) => {
    const input = remoteOperationInputSchema.parse(value);
    return remoteMutationSchema.parse(await router.mutate(input.scope, trusted(event), input.operation.method, input.operation.input));
  });
  named(ipcChannels.remoteCommandStatus, remoteStatusInputSchema, methodCatalog['command.status'].wireResultSchema,
    (input, guard) => router.read(input.scope.generation, guard, (client) => client.review(input.scope, input.requestId)));
}
