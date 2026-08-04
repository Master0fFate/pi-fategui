import { ipcRenderer } from 'electron';
import {
  abortResultSchema,
  appCommandSchema,
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
  musicLoadInputSchema,
  musicQueueResultSchema,
  musicStatusSchema,
  musicStreamResultSchema,
  musicTrackInputSchema,
  openUpdateDownloadResultSchema,
  piEventBatchSchema,
  openFileResultSchema,
  projectFileReferenceSchema,
  revealProjectResultSchema,
  promptAcceptanceSchema,
  promptInputSchema,
  queueMutationInputSchema,
  queueMutationResultSchema,
  runtimeImageSchema,
  runtimeStateSchema,
  sessionEntryInputSchema,
  sessionIdInputSchema,
  sessionRenameInputSchema,
  forkSessionResultSchema,
  sessionListSchema,
  sessionSearchInputSchema,
  speechCancelResultSchema,
  speechDownloadProgressSchema,
  speechModelInputSchema,
  speechStatusSchema,
  speechTranscribeInputSchema,
  speechTranscriptionSchema,
  subagentControlInputSchema,
  setModelInputSchema,
  setPermissionInputSchema,
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
  type PiDesktopApi,
  type PiEvent,
  type TerminalEvent,
  type PromptInput,
  type QueueMutationInput,
  type PermissionLevel,
  type SpeechDownloadProgress,
  type SpeechModelId,
  type SubagentControlInput,
  type ThinkingLevel,
  type WindowControlAction,
  type WindowState,
} from '../shared/contracts/ipc';
import { agentTeamControlInputSchema, type AgentTeamControlInput } from '../shared/contracts/multiAgent';
import {
  goalMaxClearResultSchema,
  goalMaxControlInputSchema,
  goalMaxCreateInputSchema,
  goalMaxEventBatchSchema,
  goalMaxStateSchema,
  goalMaxUpdateInputSchema,
  type GoalMaxControlInput,
  type GoalMaxCreateInput,
  type GoalMaxEvent,
  type GoalMaxUpdateInput,
} from '../shared/contracts/goalmaxxing';

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
  onWindowState(listener: (state: WindowState) => void) {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(windowStateSchema.parse(payload));
    ipcRenderer.on(ipcChannels.windowState, handler);
    return () => ipcRenderer.removeListener(ipcChannels.windowState, handler);
  },
  async selectProject() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.projectSelect, emptyInputSchema.parse({}));
    return runtimeStateSchema.parse(result);
  },
  async selectProjectFile() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.projectSelectFile, emptyInputSchema.parse({}));
    return projectFileReferenceSchema.parse(result);
  },
  async revealProject() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.projectReveal, emptyInputSchema.parse({}));
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
  async getRuntimeState() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeGetState, emptyInputSchema.parse({}));
    return runtimeStateSchema.parse(result);
  },
  async prompt(input: PromptInput) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimePrompt, promptInputSchema.parse(input));
    return promptAcceptanceSchema.parse(result);
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
  async switchSession(sessionId: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeSwitchSession, sessionIdInputSchema.parse({ sessionId }));
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
  onSpeechDownload(listener: (progress: SpeechDownloadProgress) => void) {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(speechDownloadProgressSchema.parse(payload));
    ipcRenderer.on(ipcChannels.speechEvents, handler);
    return () => ipcRenderer.removeListener(ipcChannels.speechEvents, handler);
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
  async getDiagnostics() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.diagnosticsGet, emptyInputSchema.parse({}));
    return diagnosticsSchema.parse(result);
  },
  async getLogs() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.logsGet, emptyInputSchema.parse({}));
    return logListSchema.parse(result);
  },
  onEvents(listener: (events: PiEvent[]) => void) {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(piEventBatchSchema.parse(payload));
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
