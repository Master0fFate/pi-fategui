import type { WebFateApi } from './WebFateApi';

/** Public, credential-free workspace port shared by browser and main-owned desktop adapters.
 * No cookie, bearer, client ticket, raw command transport, native path or RuntimeState crosses it.
 * Authentication and transport lifetime stay with their owning platform adapter.
 */
export interface NetworkWorkspaceApi extends Pick<WebFateApi,
  | 'origin' | 'authenticatedSessionId' | 'serverEpoch' | 'isConnected' | 'reconnectError' | 'workspace' | 'control' | 'estimatedHostTime'
  | 'supports' | 'onInvalidate' | 'listWorkspaces' | 'readSnapshot' | 'readMonitor'
  | 'listFiles' | 'previewText' | 'readGoal' | 'readTasks' | 'readGitStatus' | 'readGitHistory'
  | 'readSessions' | 'readModels' | 'readQueue' | 'readTeams' | 'readAgents'
  | 'readGitDiff' | 'readGitCombinedDiff' | 'readGitCommitDetails' | 'readMonitorDetail'
  | 'uploadText' | 'cancelTextAttachment' | 'sendPrompt' | 'abort' | 'createSession' | 'selectSession'
  | 'setModel' | 'setThinking' | 'mutateQueue' | 'createGoal' | 'controlGoal' | 'updateGoal' | 'clearGoal'
  | 'editGoalSteering' | 'removeGoalSteering' | 'createTask' | 'updateTask' | 'reorderTasks' | 'deleteTask' | 'clearTasks'
  | 'controlAgent' | 'controlTeam' | 'agentWorkspace' | 'claimControl' | 'renewControl' | 'releaseControl' | 'takeOverControl'
  | 'requestPermissionApproval' | 'respondPermissionApproval' | 'pendingPromptReview' | 'rememberPendingPromptReview'
  | 'assertPendingReviewStorageAvailable' | 'clearPendingPromptReview' | 'reviewPromptStatus' | 'close'> {
  /** Optional authenticated/configured public host metadata, never inferred authority. */
  readonly hostId?: string | null;
  readonly hostName?: string | null;
  readonly takeoverAllowed?: boolean;
}
