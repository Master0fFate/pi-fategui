import { ipcRenderer } from 'electron';
import {
  abortResultSchema,
  appCommandSchema,
  automationSessionPreparationResultSchema,
  appInfoSchema,
  appSettingsSchema,
  compactInputSchema,
  clipboardTextInputSchema,
  clipboardWriteResultSchema,
  emptyInputSchema,
  fileListInputSchema,
  fileListSchema,
  filePathInputSchema,
  filePreviewSchema,
  fileSearchInputSchema,
  fileSearchResultSchema,
  getAppInfoInputSchema,
  gitCombinedDiffSchema,
  gitCommitDetailsSchema,
  gitCommitInputSchema,
  gitDiffSchema,
  gitHistorySchema,
  gitOperationInputSchema,
  gitOperationResultSchema,
  gitStatusSchema,
  gitWorktreeInputSchema,
  gitWorktreeListSchema,
  gitWorktreeSessionResultSchema,
  ipcChannels,
  imageSaveInputSchema,
  imageSaveResultSchema,
  localImageInputSchema,
  logListSchema,
  musicClearResultSchema,
  musicDurationsEventSchema,
  musicLoadInputSchema,
  musicQueueResultSchema,
  musicStatusSchema,
  musicStreamResultSchema,
  musicTrackInputSchema,
  openUpdateDownloadResultSchema,
  updateDownloadProgressSchema,
  updateInstallStartedSchema,
  updateVersionInputSchema,
  piEventBatchSchema,
  openFileResultSchema,
  projectFileReferenceSchema,
  revealProjectResultSchema,
  promptAcceptanceSchema,
  promptInputSchema,
  promptOptimizationInputSchema,
  promptOptimizationResultSchema,
  queueMutationInputSchema,
  queueMutationResultSchema,
  runtimeImageSchema,
  runtimeStateSchema,
  sessionEntryInputSchema,
  sessionIdInputSchema,
  sessionRenameInputSchema,
  sessionDirectMessageInputSchema,
  forkSessionResultSchema,
  navigateSessionBranchResultSchema,
  deleteSessionBranchResultSchema,
  sessionListSchema,
  sessionSearchInputSchema,
  projectPathInputSchema,
  projectSessionListInputSchema,
  projectDeleteSessionsResultSchema,
  speechCancelResultSchema,
  speechDownloadProgressSchema,
  speechHotkeyStatusSchema,
  speechModelInputSchema,
  speechStatusSchema,
  speechStreamFeedInputSchema,
  speechStreamStartInputSchema,
  speechStreamUpdateSchema,
  speechTranscribeInputSchema,
  speechTranscriptionSchema,
  voiceHotkeyEventSchema,
  subagentControlInputSchema,
  setModelInputSchema,
  setPermissionInputSchema,
  providerLoginStartInputSchema,
  providerLoginRespondInputSchema,
  providerLogoutInputSchema,
  modelsDevAddInputSchema,
  modelsDevListResultSchema,
  modelsDevMutationResultSchema,
  modelsDevProviderDetailSchema,
  modelsDevRemoveInputSchema,
  setThinkingInputSchema,
  terminalAckInputSchema,
  terminalCloseInputSchema,
  terminalCreateInputSchema,
  terminalCreateResultSchema,
  terminalEventSchema,
  terminalResizeInputSchema,
  terminalWriteInputSchema,
  themeCatalogSchema,
  updateCheckResultSchema,
  windowControlInputSchema,
  windowStateSchema,
  diagnosticsSchema,
  type AppCommand,
  type AppSettings,
  type GitOperation,
  type ImageSaveInput,
  type MusicDurationsEvent,
  type ModelsDevAddInput,
  type PiDesktopApi,
  type SessionDirectMessageInput,
  type PiEvent,
  type TerminalEvent,
  type PromptInput,
  type PromptOptimizationOptions,
  type QueueMutationInput,
  type PermissionLevel,
  type ProviderLoginStartInput,
  type ProviderLoginRespondInput,
  type SpeechDownloadProgress,
  type SpeechHotkeyStatus,
  type SpeechModelId,
  type SpeechStreamUpdate,
  type SubagentControlInput,
  type ThinkingLevel,
  type VoiceHotkeyEvent,
  type WindowControlAction,
  type WindowState,
} from '../shared/contracts/ipc';
import { agentTeamControlInputSchema, type AgentTeamControlInput } from '../shared/contracts/multiAgent';
import {
  browserAnnotationCreateInputSchema,
  browserAnnotationDismissInputSchema,
  browserAnnotationListSchema,
  browserAnnotationRemoveInputSchema,
  browserAnnotationSchema,
  browserAnnotationUpdateInputSchema,
  browserBoundsSchema,
  browserConfirmationResponseSchema,
  browserControlLevelInputSchema,
  browserEventBatchSchema,
  browserHistoryInputSchema,
  browserLinkContextMenuInputSchema,
  browserLinkContextMenuResultSchema,
  browserNavigateInputSchema,
  browserNewTabInputSchema,
  browserWebUrlSchema,
  browserOperationResultSchema,
  browserOriginGrantSchema,
  browserOriginInputSchema,
  browserOverlayInputSchema,
  browserSnapshotInputSchema,
  browserStateSchema,
  browserTabIdInputSchema,
  browserUiModeInputSchema,
  browserVisibilityInputSchema,
  semanticPageSnapshotSchema,
  type BrowserBounds,
  type BrowserControlLevel,
  type BrowserEvent,
  type BrowserOriginGrant,
  type BrowserSnapshotMode,
  type BrowserUiMode,
} from '../shared/contracts/browser';
import {
  automationCreateInputSchema,
  automationDefinitionSchema,
  automationDeleteResultSchema,
  automationIdInputSchema,
  automationLaunchRecordInputSchema,
  automationListSchema,
  automationUpdateInputSchema,
  type AutomationCreateInput,
  type AutomationLaunchOutcome,
  type AutomationUpdateInput,
} from '../shared/contracts/automations';
import {
  goalMaxClearResultSchema,
  goalMaxControlInputSchema,
  goalMaxCreateInputSchema,
  goalMaxEventBatchSchema,
  goalMaxStateSchema,
  goalMaxSteeringEditInputSchema,
  goalMaxSteeringRemoveInputSchema,
  goalMaxUpdateInputSchema,
  type GoalMaxControlInput,
  type GoalMaxCreateInput,
  type GoalMaxEvent,
  type GoalMaxSteeringEditInput,
  type GoalMaxSteeringRemoveInput,
  type GoalMaxUpdateInput,
} from '../shared/contracts/goalmaxxing';
import {
  taskCreateInputSchema,
  taskDeleteInputSchema,
  taskEventBatchSchema,
  taskListSchema,
  taskReorderInputSchema,
  taskUpdateInputSchema,
  type TaskCreateInput,
  type TaskDeleteInput,
  type TaskEvent,
  type TaskList,
  type TaskReorderInput,
  type TaskUpdateInput,
} from '../shared/contracts/tasks';
import {
  attestationQueryRequestSchema,
  attestationQueryResultSchema,
  type AttestationQueryRequestInput,
  type AttestationQueryResult,
} from '../shared/contracts/mutationAttestation';

export const piDesktopApi: PiDesktopApi = Object.freeze({
  async getAppInfo() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.systemGetInfo, getAppInfoInputSchema.parse({}));
    return appInfoSchema.parse(result);
  },
  async controlWindow(action: WindowControlAction) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.windowControl, windowControlInputSchema.parse({ action }));
    return windowStateSchema.parse(result);
  },
  async getWindowState() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.windowGetState, emptyInputSchema.parse({}));
    return windowStateSchema.parse(result);
  },
  async newWindow() {
    await ipcRenderer.invoke(ipcChannels.windowNew, emptyInputSchema.parse({}));
  },
  onWindowState(listener: (state: WindowState) => void) {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(windowStateSchema.parse(payload));
    ipcRenderer.on(ipcChannels.windowState, handler);
    return () => ipcRenderer.removeListener(ipcChannels.windowState, handler);
  },
  async selectProject() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.projectSelect, emptyInputSchema.parse({}));
    return runtimeStateSchema.parse(result);
  },
  async openProject(projectPath: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.projectOpenPath, projectPathInputSchema.parse({ projectPath }));
    return runtimeStateSchema.parse(result);
  },
  async focusProject(projectPath: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.projectFocusPath, projectPathInputSchema.parse({ projectPath }));
    return runtimeStateSchema.parse(result);
  },
  async closeProjectRuntime(projectPath: string) {
    await ipcRenderer.invoke(ipcChannels.projectCloseRuntime, projectPathInputSchema.parse({ projectPath }));
  },
  async selectProjectFile() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.projectSelectFile, emptyInputSchema.parse({}));
    return projectFileReferenceSchema.parse(result);
  },
  async revealProject() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.projectReveal, emptyInputSchema.parse({}));
    return revealProjectResultSchema.parse(result);
  },
  async revealProjectPath(projectPath: string) {
    const input = projectPathInputSchema.parse({ projectPath });
    const result: unknown = await ipcRenderer.invoke(ipcChannels.projectRevealPath, input);
    return revealProjectResultSchema.parse(result);
  },
  async readLocalImage(path: string) {
    const input = localImageInputSchema.parse({ path });
    const result: unknown = await ipcRenderer.invoke(ipcChannels.imageReadLocal, input);
    return runtimeImageSchema.parse(result);
  },
  async saveImageAs(input: ImageSaveInput) {
    const parsed = imageSaveInputSchema.parse(input);
    const result: unknown = await ipcRenderer.invoke(ipcChannels.imageSaveAs, parsed);
    return imageSaveResultSchema.parse(result);
  },
  async writeClipboardText(text: string) {
    const input = clipboardTextInputSchema.parse({ text });
    const result: unknown = await ipcRenderer.invoke(ipcChannels.clipboardWriteText, input);
    clipboardWriteResultSchema.parse(result);
  },
  async initializeBrowser() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.browserInitialize, emptyInputSchema.parse({}));
    return browserStateSchema.parse(result);
  },
  async getBrowserState() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.browserGetState, emptyInputSchema.parse({}));
    return browserStateSchema.parse(result);
  },
  async setBrowserBounds(bounds: BrowserBounds) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.browserSetBounds, browserBoundsSchema.parse(bounds));
    return browserStateSchema.parse(result);
  },
  async setBrowserVisible(visible: boolean) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.browserSetVisible, browserVisibilityInputSchema.parse({ visible }));
    return browserStateSchema.parse(result);
  },
  async setBrowserOverlayBlocked(blocked: boolean) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.browserSetOverlay, browserOverlayInputSchema.parse({ blocked }));
    return browserStateSchema.parse(result);
  },
  async navigateBrowser(url: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.browserNavigate, browserNavigateInputSchema.parse({ url }));
    return browserStateSchema.parse(result);
  },
  async showBrowserLinkContextMenu(url: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.browserShowLinkContextMenu, browserLinkContextMenuInputSchema.parse({ url }));
    browserLinkContextMenuResultSchema.parse(result);
  },
  onBrowserLinkOpen(listener: (url: string) => void) {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(browserWebUrlSchema.parse(payload));
    ipcRenderer.on(ipcChannels.browserOpenLink, handler);
    return () => ipcRenderer.removeListener(ipcChannels.browserOpenLink, handler);
  },
  async openBrowserLocalFile() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.browserOpenLocalFile, emptyInputSchema.parse({}));
    return browserStateSchema.nullable().parse(result);
  },
  async createBrowserTab(initialUrl?: string) {
    const input = browserNewTabInputSchema.parse(initialUrl ? { initialUrl } : {});
    const result: unknown = await ipcRenderer.invoke(ipcChannels.browserNewTab, input);
    return browserStateSchema.parse(result);
  },
  async activateBrowserTab(tabId: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.browserActivateTab, browserTabIdInputSchema.parse({ tabId }));
    return browserStateSchema.parse(result);
  },
  async closeBrowserTab(tabId: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.browserCloseTab, browserTabIdInputSchema.parse({ tabId }));
    return browserStateSchema.parse(result);
  },
  async controlBrowserHistory(action: 'back' | 'forward' | 'reload' | 'stop') {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.browserHistory, browserHistoryInputSchema.parse({ action }));
    return browserStateSchema.parse(result);
  },
  async setBrowserMode(mode: BrowserUiMode) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.browserSetMode, browserUiModeInputSchema.parse({ mode }));
    return browserStateSchema.parse(result);
  },
  async setBrowserControlLevel(level: BrowserControlLevel) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.browserSetControlLevel, browserControlLevelInputSchema.parse({ level }));
    return browserStateSchema.parse(result);
  },
  async setBrowserOriginGrant(grant: BrowserOriginGrant) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.browserSetGrant, browserOriginGrantSchema.parse(grant));
    return browserStateSchema.parse(result);
  },
  async revokeBrowserOriginGrant(origin: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.browserRevokeGrant, browserOriginInputSchema.parse({ origin }));
    return browserStateSchema.parse(result);
  },
  async snapshotBrowser(input: { mode?: BrowserSnapshotMode; scopeRef?: string; query?: string } = {}) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.browserSnapshot, browserSnapshotInputSchema.parse(input));
    return semanticPageSnapshotSchema.parse(result);
  },
  async selectBrowserAnnotation(kind: 'element' | 'region', comment: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.browserSelectAnnotation, browserAnnotationCreateInputSchema.parse({ kind, comment }));
    return browserAnnotationSchema.parse(result);
  },
  async listBrowserAnnotations() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.browserListAnnotations, emptyInputSchema.parse({}));
    return browserAnnotationListSchema.parse(result);
  },
  async updateBrowserAnnotation(id: string, comment: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.browserUpdateAnnotation, browserAnnotationUpdateInputSchema.parse({ id, comment }));
    return browserAnnotationSchema.parse(result);
  },
  async removeBrowserAnnotation(id: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.browserRemoveAnnotation, browserAnnotationRemoveInputSchema.parse({ id }));
    return browserOperationResultSchema.parse(result).ok;
  },
  async dismissBrowserAnnotations(ids: string[]) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.browserDismissAnnotations, browserAnnotationDismissInputSchema.parse({ ids }));
    return browserOperationResultSchema.parse(result).ok;
  },
  async highlightBrowserAnnotation(id: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.browserHighlightAnnotation, browserAnnotationRemoveInputSchema.parse({ id }));
    return browserOperationResultSchema.parse(result).ok;
  },
  async respondToBrowserConfirmation(id: string, approved: boolean) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.browserRespondConfirmation, browserConfirmationResponseSchema.parse({ id, approved }));
    return browserOperationResultSchema.parse(result).ok;
  },
  onBrowserEvents(listener: (events: BrowserEvent[]) => void) {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(browserEventBatchSchema.parse(payload));
    ipcRenderer.on(ipcChannels.browserEvents, handler);
    return () => ipcRenderer.removeListener(ipcChannels.browserEvents, handler);
  },
  async listAutomations() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.automationsList, emptyInputSchema.parse({}));
    return automationListSchema.parse(result);
  },
  async createAutomation(input: AutomationCreateInput) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.automationsCreate, automationCreateInputSchema.parse(input));
    return automationDefinitionSchema.parse(result);
  },
  async updateAutomation(input: AutomationUpdateInput) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.automationsUpdate, automationUpdateInputSchema.parse(input));
    return automationDefinitionSchema.parse(result);
  },
  async deleteAutomation(id: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.automationsDelete, automationIdInputSchema.parse({ id }));
    automationDeleteResultSchema.parse(result);
  },
  async recordAutomationLaunch(id: string, outcome: AutomationLaunchOutcome) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.automationsRecordLaunch, automationLaunchRecordInputSchema.parse({ id, outcome }));
    return automationDefinitionSchema.parse(result);
  },
  async prepareAutomationSession(id: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.automationsPrepareSession, automationIdInputSchema.parse({ id }));
    return automationSessionPreparationResultSchema.parse(result);
  },
  async getRuntimeState() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeGetState, emptyInputSchema.parse({}));
    return runtimeStateSchema.parse(result);
  },
  async prompt(input: PromptInput) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimePrompt, promptInputSchema.parse(input));
    return promptAcceptanceSchema.parse(result);
  },
  async optimizePrompt(text: string, options?: PromptOptimizationOptions) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeOptimizePrompt, promptOptimizationInputSchema.parse({ text, advanced: options?.advanced ?? false }));
    return promptOptimizationResultSchema.parse(result);
  },
  async abort() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeAbort, emptyInputSchema.parse({}));
    return abortResultSchema.parse(result);
  },
  async controlSubagent(input: SubagentControlInput) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeControlSubagent, subagentControlInputSchema.parse(input));
    return runtimeStateSchema.parse(result);
  },
  async controlAgentTeam(input: AgentTeamControlInput) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeControlAgentTeam, agentTeamControlInputSchema.parse(input));
    return runtimeStateSchema.parse(result);
  },
  async setModel(provider: string, id: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeSetModel, setModelInputSchema.parse({ provider, id }));
    return runtimeStateSchema.parse(result);
  },
  async setThinkingLevel(level: ThinkingLevel) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeSetThinking, setThinkingInputSchema.parse({ level }));
    return runtimeStateSchema.parse(result);
  },
  async setPermissionLevel(level: PermissionLevel) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeSetPermission, setPermissionInputSchema.parse({ level }));
    return runtimeStateSchema.parse(result);
  },
  async initializeProviderLogin() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeProviderLoginInitialize, emptyInputSchema.parse({}));
    return runtimeStateSchema.parse(result);
  },
  async startProviderLogin(input: ProviderLoginStartInput) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeProviderLoginStart, providerLoginStartInputSchema.parse(input));
    return runtimeStateSchema.parse(result);
  },
  async respondProviderLogin(input: ProviderLoginRespondInput) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeProviderLoginRespond, providerLoginRespondInputSchema.parse(input));
    return runtimeStateSchema.parse(result);
  },
  async cancelProviderLogin() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeProviderLoginCancel, emptyInputSchema.parse({}));
    return runtimeStateSchema.parse(result);
  },
  async logoutProvider(providerId: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeProviderLogout, providerLogoutInputSchema.parse({ providerId }));
    return runtimeStateSchema.parse(result);
  },
  async listModelsDevProviders() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.modelsDevList, emptyInputSchema.parse({}));
    return modelsDevListResultSchema.parse(result);
  },
  async getModelsDevProvider(providerId: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.modelsDevDetail, modelsDevRemoveInputSchema.parse({ providerId }));
    return modelsDevProviderDetailSchema.parse(result);
  },
  async addModelsDevProvider(input: ModelsDevAddInput) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.modelsDevAdd, modelsDevAddInputSchema.parse(input));
    return modelsDevMutationResultSchema.parse(result);
  },
  async removeModelsDevProvider(providerId: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.modelsDevRemove, modelsDevRemoveInputSchema.parse({ providerId }));
    return modelsDevMutationResultSchema.parse(result);
  },
  async mutateQueuedMessage(input: QueueMutationInput) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeMutateQueue, queueMutationInputSchema.parse(input));
    return queueMutationResultSchema.parse(result);
  },
  async getGoalMax() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeGoalMaxGet, emptyInputSchema.parse({}));
    return result === null ? null : goalMaxStateSchema.parse(result);
  },
  async createGoalMax(input: GoalMaxCreateInput) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeGoalMaxCreate, goalMaxCreateInputSchema.parse(input));
    return goalMaxStateSchema.parse(result);
  },
  async controlGoalMax(input: GoalMaxControlInput) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeGoalMaxControl, goalMaxControlInputSchema.parse(input));
    return goalMaxStateSchema.parse(result);
  },
  async updateGoalMax(input: GoalMaxUpdateInput) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeGoalMaxUpdate, goalMaxUpdateInputSchema.parse(input));
    return goalMaxStateSchema.parse(result);
  },
  async clearGoalMax() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeGoalMaxClear, emptyInputSchema.parse({}));
    return goalMaxClearResultSchema.parse(result);
  },
  async editGoalMaxSteering(input: GoalMaxSteeringEditInput) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeGoalMaxSteeringEdit, goalMaxSteeringEditInputSchema.parse(input));
    return goalMaxStateSchema.parse(result);
  },
  async removeGoalMaxSteering(input: GoalMaxSteeringRemoveInput) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeGoalMaxSteeringRemove, goalMaxSteeringRemoveInputSchema.parse(input));
    return goalMaxStateSchema.parse(result);
  },
  async getTaskList() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeTaskGet, emptyInputSchema.parse({}));
    return result === null ? null : taskListSchema.parse(result);
  },
  async createTask(input: TaskCreateInput) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeTaskCreate, taskCreateInputSchema.parse(input));
    return taskListSchema.parse(result);
  },
  async updateTask(input: TaskUpdateInput) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeTaskUpdate, taskUpdateInputSchema.parse(input));
    return taskListSchema.parse(result);
  },
  async reorderTasks(input: TaskReorderInput) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeTaskReorder, taskReorderInputSchema.parse(input));
    return taskListSchema.parse(result);
  },
  async deleteTask(input: TaskDeleteInput) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeTaskDelete, taskDeleteInputSchema.parse(input));
    return taskListSchema.parse(result);
  },
  async clearTasks() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeTaskClear, emptyInputSchema.parse({}));
    return taskListSchema.parse(result);
  },
  onTaskEvents(listener: (events: TaskEvent[]) => void) {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(taskEventBatchSchema.parse(payload));
    ipcRenderer.on(ipcChannels.runtimeTaskEvents, handler);
    return () => ipcRenderer.removeListener(ipcChannels.runtimeTaskEvents, handler);
  },
  onGoalMaxEvents(listener: (events: GoalMaxEvent[]) => void) {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(goalMaxEventBatchSchema.parse(payload));
    ipcRenderer.on(ipcChannels.runtimeGoalMaxEvents, handler);
    return () => ipcRenderer.removeListener(ipcChannels.runtimeGoalMaxEvents, handler);
  },
  async newSession() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeNewSession, emptyInputSchema.parse({}));
    return runtimeStateSchema.parse(result);
  },
  async listSessions(query = '') {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeListSessions, sessionSearchInputSchema.parse({ query }));
    return sessionListSchema.parse(result);
  },
  async listProjectSessions(projectPath: string, query = '') {
    const input = projectSessionListInputSchema.parse({ projectPath, query });
    const result: unknown = await ipcRenderer.invoke(ipcChannels.projectListSessions, input);
    return sessionListSchema.parse(result);
  },
  async deleteProjectSessions(projectPath: string) {
    const input = projectPathInputSchema.parse({ projectPath });
    const result: unknown = await ipcRenderer.invoke(ipcChannels.projectDeleteSessions, input);
    return projectDeleteSessionsResultSchema.parse(result);
  },
  async switchSession(sessionId: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeSwitchSession, sessionIdInputSchema.parse({ sessionId }));
    return runtimeStateSchema.parse(result);
  },
  async sendSessionMessage(input: SessionDirectMessageInput) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeSendSessionMessage, sessionDirectMessageInputSchema.parse(input));
    return runtimeStateSchema.parse(result);
  },
  async renameSession(sessionId: string, name: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeRenameSession, sessionRenameInputSchema.parse({ sessionId, name }));
    return runtimeStateSchema.parse(result);
  },
  async deleteSession(sessionId: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeDeleteSession, sessionIdInputSchema.parse({ sessionId }));
    return runtimeStateSchema.parse(result);
  },
  async forkSession(entryId: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeForkSession, sessionEntryInputSchema.parse({ entryId }));
    return forkSessionResultSchema.parse(result);
  },
  async navigateSessionBranch(entryId: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeNavigateSessionBranch, sessionEntryInputSchema.parse({ entryId }));
    return navigateSessionBranchResultSchema.parse(result);
  },
  async deleteSessionBranch(entryId: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeDeleteSessionBranch, sessionEntryInputSchema.parse({ entryId }));
    return deleteSessionBranchResultSchema.parse(result);
  },
  async cloneSession() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeCloneSession, emptyInputSchema.parse({}));
    return runtimeStateSchema.parse(result);
  },
  async importSession() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeImportSession, emptyInputSchema.parse({}));
    return result === null ? null : runtimeStateSchema.parse(result);
  },
  async compact(instructions?: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeCompact, compactInputSchema.parse({ instructions }));
    return runtimeStateSchema.parse(result);
  },
  async listFiles(path = '') {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.filesList, fileListInputSchema.parse({ path }));
    return fileListSchema.parse(result);
  },
  async searchFiles(query: string, limit = 300) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.filesSearch, fileSearchInputSchema.parse({ query, limit }));
    return fileSearchResultSchema.parse(result);
  },
  async readFile(path: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.filesRead, filePathInputSchema.parse({ path }));
    return filePreviewSchema.parse(result);
  },
  async openFile(path: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.filesOpen, filePathInputSchema.parse({ path }));
    return openFileResultSchema.parse(result);
  },
  async getGitStatus() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.gitStatus, emptyInputSchema.parse({}));
    return gitStatusSchema.parse(result);
  },
  async getGitDiff(path: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.gitDiff, filePathInputSchema.parse({ path }));
    return gitDiffSchema.parse(result);
  },
  async getGitCombinedDiff() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.gitCombinedDiff, emptyInputSchema.parse({}));
    return gitCombinedDiffSchema.parse(result);
  },
  async listGitWorktrees() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.gitWorktrees, emptyInputSchema.parse({}));
    return gitWorktreeListSchema.parse(result);
  },
  async switchGitWorktree(path: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.gitSwitchWorktree, gitWorktreeInputSchema.parse({ path }));
    return runtimeStateSchema.parse(result);
  },
  async createWorktreeSession(entryId: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.gitCreateWorktreeSession, sessionEntryInputSchema.parse({ entryId }));
    return gitWorktreeSessionResultSchema.parse(result);
  },
  async getGitHistory() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.gitHistory, emptyInputSchema.parse({}));
    return gitHistorySchema.parse(result);
  },
  async getGitCommitDetails(hash: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.gitCommitDetails, gitCommitInputSchema.parse({ hash }));
    return gitCommitDetailsSchema.parse(result);
  },
  async runGitOperation(operation: GitOperation) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.gitOperation, gitOperationInputSchema.parse({ operation }));
    return gitOperationResultSchema.parse(result);
  },
  async createTerminal(cols: number, rows: number) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.terminalCreate, terminalCreateInputSchema.parse({ cols, rows }));
    return terminalCreateResultSchema.parse(result);
  },
  async writeTerminal(id: string, data: string) {
    await ipcRenderer.invoke(ipcChannels.terminalWrite, terminalWriteInputSchema.parse({ id, data }));
  },
  async acknowledgeTerminal(id: string, characters: number) {
    await ipcRenderer.invoke(ipcChannels.terminalAck, terminalAckInputSchema.parse({ id, characters }));
  },
  async resizeTerminal(id: string, cols: number, rows: number) {
    await ipcRenderer.invoke(ipcChannels.terminalResize, terminalResizeInputSchema.parse({ id, cols, rows }));
  },
  async closeTerminal(id: string) {
    await ipcRenderer.invoke(ipcChannels.terminalClose, terminalCloseInputSchema.parse({ id }));
  },
  async getSettings() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.settingsGet, emptyInputSchema.parse({}));
    return appSettingsSchema.parse(result);
  },
  async setSettings(settings: AppSettings) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.settingsSet, appSettingsSchema.parse(settings));
    return appSettingsSchema.parse(result);
  },
  async checkForUpdates() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.updatesCheck, emptyInputSchema.parse({}));
    return updateCheckResultSchema.parse(result);
  },
  async openUpdateDownload() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.updatesOpenDownload, emptyInputSchema.parse({}));
    openUpdateDownloadResultSchema.parse(result);
  },
  async downloadAndInstallUpdate(version: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.updatesDownloadInstall, updateVersionInputSchema.parse({ version }));
    updateInstallStartedSchema.parse(result);
  },
  onUpdatesProgress(listener: (progress: { downloaded: number; total: number; percent: number; version: string }) => void): () => void {
    const handler = (_event: unknown, progress: unknown) => {
      listener(updateDownloadProgressSchema.parse(progress));
    };
    ipcRenderer.on(ipcChannels.updatesProgress, handler);
    return () => ipcRenderer.off(ipcChannels.updatesProgress, handler);
  },
  async getThemes() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.themesGet, emptyInputSchema.parse({}));
    return themeCatalogSchema.parse(result);
  },
  async getSpeechStatus() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.speechGetStatus, emptyInputSchema.parse({}));
    return speechStatusSchema.parse(result);
  },
  async ensureSpeechModel(modelId: SpeechModelId) {
    await ipcRenderer.invoke(ipcChannels.speechEnsureModel, speechModelInputSchema.parse({ modelId }));
  },
  async downloadSpeechModel(modelId: SpeechModelId) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.speechDownloadModel, speechModelInputSchema.parse({ modelId }));
    return speechStatusSchema.parse(result);
  },
  async cancelSpeechModelDownload(modelId: SpeechModelId) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.speechCancelDownload, speechModelInputSchema.parse({ modelId }));
    return speechCancelResultSchema.parse(result).cancelled;
  },
  async removeSpeechModel(modelId: SpeechModelId) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.speechRemoveModel, speechModelInputSchema.parse({ modelId }));
    return speechStatusSchema.parse(result);
  },
  async transcribeSpeech(modelId: SpeechModelId, audio: ArrayBuffer, language?: string) {
    const input = speechTranscribeInputSchema.parse({ modelId, audio, language });
    const result: unknown = await ipcRenderer.invoke(ipcChannels.speechTranscribe, input);
    return speechTranscriptionSchema.parse(result);
  },
  async cancelSpeechTranscription() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.speechCancel, emptyInputSchema.parse({}));
    return speechCancelResultSchema.parse(result).cancelled;
  },
  async startSpeechStream(modelId: SpeechModelId, language?: string, refine?: boolean) {
    const input = speechStreamStartInputSchema.parse({ modelId, language, refine });
    await ipcRenderer.invoke(ipcChannels.speechStreamStart, input);
  },
  async feedSpeechStream(audio: ArrayBuffer) {
    const input = speechStreamFeedInputSchema.parse({ audio });
    await ipcRenderer.invoke(ipcChannels.speechStreamFeed, input);
  },
  async stopSpeechStream() {
    await ipcRenderer.invoke(ipcChannels.speechStreamStop, emptyInputSchema.parse({}));
  },
  async cancelSpeechStream() {
    await ipcRenderer.invoke(ipcChannels.speechStreamCancel, emptyInputSchema.parse({}));
  },
  async getSpeechHotkeyStatus() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.speechHotkeyStatus, emptyInputSchema.parse({}));
    return speechHotkeyStatusSchema.parse(result);
  },
  onSpeechDownload(listener: (progress: SpeechDownloadProgress) => void) {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(speechDownloadProgressSchema.parse(payload));
    ipcRenderer.on(ipcChannels.speechEvents, handler);
    return () => ipcRenderer.removeListener(ipcChannels.speechEvents, handler);
  },
  onSpeechStreamUpdate(listener: (update: SpeechStreamUpdate) => void) {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(speechStreamUpdateSchema.parse(payload));
    ipcRenderer.on(ipcChannels.speechStreamEvents, handler);
    return () => ipcRenderer.removeListener(ipcChannels.speechStreamEvents, handler);
  },
  onVoiceHotkey(listener: (event: VoiceHotkeyEvent) => void) {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(voiceHotkeyEventSchema.parse(payload));
    ipcRenderer.on(ipcChannels.voiceHotkey, handler);
    return () => ipcRenderer.removeListener(ipcChannels.voiceHotkey, handler);
  },
  async getMusicStatus() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.musicGetStatus, emptyInputSchema.parse({}));
    return musicStatusSchema.parse(result);
  },
  async loadMusic(url: string) {
    const input = musicLoadInputSchema.parse({ url });
    const result = musicQueueResultSchema.parse(await ipcRenderer.invoke(ipcChannels.musicLoad, input));
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value;
  },
  async resolveMusicTrack(trackId: string) {
    const input = musicTrackInputSchema.parse({ trackId });
    const result = musicStreamResultSchema.parse(await ipcRenderer.invoke(ipcChannels.musicResolveTrack, input));
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value;
  },
  async clearMusicQueue() {
    const result = musicClearResultSchema.parse(await ipcRenderer.invoke(ipcChannels.musicClearQueue, emptyInputSchema.parse({})));
    if (!result.ok) throw new Error(JSON.stringify(result.error));
  },
  onMusicDurations(handler: (event: MusicDurationsEvent) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => handler(musicDurationsEventSchema.parse(payload));
    ipcRenderer.on(ipcChannels.musicDurations, listener);
    return () => ipcRenderer.removeListener(ipcChannels.musicDurations, listener);
  },
  async getDiagnostics() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.diagnosticsGet, emptyInputSchema.parse({}));
    return diagnosticsSchema.parse(result);
  },
  async getLogs() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.logsGet, emptyInputSchema.parse({}));
    return logListSchema.parse(result);
  },
  async queryAttestations(request?: AttestationQueryRequestInput) {
    const parsed = attestationQueryRequestSchema.parse(request ?? {});
    const result: unknown = await ipcRenderer.invoke(ipcChannels.attestationsQuery, parsed);
    return attestationQueryResultSchema.parse(result);
  },
  onEvents(listener: (events: PiEvent[]) => void) {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      const parsed = piEventBatchSchema.safeParse(payload);
      if (!parsed.success) {
        console.error('[fate-ui] dropped a runtime event batch that failed validation', parsed.error.message);
        return;
      }
      listener(parsed.data);
    };
    ipcRenderer.on(ipcChannels.runtimeEvents, handler);
    return () => ipcRenderer.removeListener(ipcChannels.runtimeEvents, handler);
  },
  onTerminalEvent(listener: (event: TerminalEvent) => void) {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(terminalEventSchema.parse(payload));
    ipcRenderer.on(ipcChannels.terminalEvents, handler);
    return () => ipcRenderer.removeListener(ipcChannels.terminalEvents, handler);
  },
  onAppCommand(listener: (command: AppCommand) => void) {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(appCommandSchema.parse(payload));
    ipcRenderer.on(ipcChannels.appCommand, handler);
    return () => ipcRenderer.removeListener(ipcChannels.appCommand, handler);
  },
});
