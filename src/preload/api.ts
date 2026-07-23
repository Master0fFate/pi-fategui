import { ipcRenderer } from 'electron';
import {
  abortResultSchema,
  appInfoSchema,
  compactInputSchema,
  emptyInputSchema,
  getAppInfoInputSchema,
  ipcChannels,
  piEventBatchSchema,
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
  type PiDesktopApi,
  type PiEvent,
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
  onEvents(listener: (events: PiEvent[]) => void) {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(piEventBatchSchema.parse(payload));
    ipcRenderer.on(ipcChannels.runtimeEvents, handler);
    return () => ipcRenderer.removeListener(ipcChannels.runtimeEvents, handler);
  },
});
