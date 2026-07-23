import { ipcRenderer } from 'electron';
import {
  abortResultSchema,
  appCommandSchema,
  appInfoSchema,
  appSettingsSchema,
  compactInputSchema,
  emptyInputSchema,
  fileListInputSchema,
  fileListSchema,
  filePathInputSchema,
  filePreviewSchema,
  fileSearchInputSchema,
  fileSearchResultSchema,
  getAppInfoInputSchema,
  gitDiffSchema,
  gitStatusSchema,
  ipcChannels,
  logListSchema,
  piEventBatchSchema,
  openFileResultSchema,
  projectFileReferenceSchema,
  promptAcceptanceSchema,
  promptInputSchema,
  runtimeStateSchema,
  sessionEntryInputSchema,
  sessionIdInputSchema,
  sessionListSchema,
  sessionSearchInputSchema,
  setModelInputSchema,
  setThinkingInputSchema,
  terminalCloseInputSchema,
  terminalCreateInputSchema,
  terminalCreateResultSchema,
  terminalEventSchema,
  terminalResizeInputSchema,
  terminalWriteInputSchema,
  diagnosticsSchema,
  type AppCommand,
  type AppSettings,
  type PiDesktopApi,
  type PiEvent,
  type TerminalEvent,
  type PromptInput,
  type ThinkingLevel,
} from '../shared/contracts/ipc';

export const piDesktopApi: PiDesktopApi = Object.freeze({
  async getAppInfo() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.systemGetInfo, getAppInfoInputSchema.parse({}));
    return appInfoSchema.parse(result);
  },
  async selectProject() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.projectSelect, emptyInputSchema.parse({}));
    return runtimeStateSchema.parse(result);
  },
  async selectProjectFile() {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.projectSelectFile, emptyInputSchema.parse({}));
    return projectFileReferenceSchema.parse(result);
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
  async setModel(provider: string, id: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeSetModel, setModelInputSchema.parse({ provider, id }));
    return runtimeStateSchema.parse(result);
  },
  async setThinkingLevel(level: ThinkingLevel) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeSetThinking, setThinkingInputSchema.parse({ level }));
    return runtimeStateSchema.parse(result);
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
  async forkSession(entryId: string) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.runtimeForkSession, sessionEntryInputSchema.parse({ entryId }));
    return runtimeStateSchema.parse(result);
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
  async createTerminal(cols: number, rows: number) {
    const result: unknown = await ipcRenderer.invoke(ipcChannels.terminalCreate, terminalCreateInputSchema.parse({ cols, rows }));
    return terminalCreateResultSchema.parse(result);
  },
  async writeTerminal(id: string, data: string) {
    await ipcRenderer.invoke(ipcChannels.terminalWrite, terminalWriteInputSchema.parse({ id, data }));
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
