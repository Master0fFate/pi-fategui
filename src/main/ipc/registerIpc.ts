import { app, BrowserWindow, dialog, ipcMain } from 'electron';
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
  type AppInfo,
} from '../../shared/contracts/ipc';
import { normalizeError, PiDesktopError } from '../pi/errors';
import type { PiRuntimeService } from '../pi/PiRuntimeService';
import type { ProjectService } from '../projects/ProjectService';

export interface IpcServices {
  runtime: PiRuntimeService;
  projects: ProjectService;
}

function register(channel: string, handler: (event: Electron.IpcMainInvokeEvent, input: unknown) => unknown | Promise<unknown>): void {
  ipcMain.handle(channel, async (event, input: unknown) => {
    try {
      return await handler(event, input);
    } catch (error) {
      const normalized = error instanceof PiDesktopError ? error.normalized : normalizeError(error);
      throw new Error(JSON.stringify(normalized));
    }
  });
}

export function registerIpc({ runtime, projects }: IpcServices): void {
  runtime.setEventSink((events) => {
    const batch = piEventBatchSchema.parse(events);
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(ipcChannels.runtimeEvents, batch);
  });

  register(ipcChannels.systemGetInfo, (_event, input): AppInfo => {
    getAppInfoInputSchema.parse(input);
    return appInfoSchema.parse({
      name: 'Pi Desktop',
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged,
    });
  });
  register(ipcChannels.projectSelect, async (event, input) => {
    emptyInputSchema.parse(input);
    const project = await projects.select(BrowserWindow.fromWebContents(event.sender) ?? undefined);
    if (project) await runtime.openProject(project);
    return runtimeStateSchema.parse(runtime.getState());
  });
  register(ipcChannels.projectSelectFile, async (event, input) => {
    emptyInputSchema.parse(input);
    const relativePath = await projects.selectFile(BrowserWindow.fromWebContents(event.sender) ?? undefined);
    return projectFileReferenceSchema.parse(relativePath);
  });
  register(ipcChannels.runtimeGetState, (_event, input) => {
    emptyInputSchema.parse(input);
    return runtimeStateSchema.parse(runtime.getState());
  });
  register(ipcChannels.runtimePrompt, async (_event, input) => {
    const accepted = await runtime.prompt(promptInputSchema.parse(input));
    return promptAcceptanceSchema.parse(accepted);
  });
  register(ipcChannels.runtimeAbort, async (_event, input) => {
    emptyInputSchema.parse(input);
    return abortResultSchema.parse(await runtime.abort());
  });
  register(ipcChannels.runtimeSetModel, async (_event, input) => {
    const parsed = setModelInputSchema.parse(input);
    return runtimeStateSchema.parse(await runtime.setModel(parsed.provider, parsed.id));
  });
  register(ipcChannels.runtimeSetThinking, (_event, input) => {
    const parsed = setThinkingInputSchema.parse(input);
    return runtimeStateSchema.parse(runtime.setThinkingLevel(parsed.level));
  });
  register(ipcChannels.runtimeNewSession, async (_event, input) => {
    emptyInputSchema.parse(input);
    return runtimeStateSchema.parse(await runtime.newSession());
  });
  register(ipcChannels.runtimeListSessions, async (_event, input) => {
    const parsed = sessionSearchInputSchema.parse(input);
    return sessionListSchema.parse(await runtime.listSessions(parsed.query));
  });
  register(ipcChannels.runtimeSwitchSession, async (_event, input) => {
    const parsed = sessionIdInputSchema.parse(input);
    return runtimeStateSchema.parse(await runtime.switchSession(parsed.sessionId));
  });
  register(ipcChannels.runtimeForkSession, async (_event, input) => {
    const parsed = sessionEntryInputSchema.parse(input);
    return runtimeStateSchema.parse(await runtime.forkSession(parsed.entryId));
  });
  register(ipcChannels.runtimeCloneSession, async (_event, input) => {
    emptyInputSchema.parse(input);
    return runtimeStateSchema.parse(await runtime.cloneSession());
  });
  register(ipcChannels.runtimeImportSession, async (event, input) => {
    emptyInputSchema.parse(input);
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: 'Import Pi session',
      properties: ['openFile'],
      filters: [{ name: 'Pi session', extensions: ['jsonl'] }],
    };
    const selected = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0]) return null;
    return runtimeStateSchema.parse(await runtime.importSession(selected.filePaths[0]));
  });
  register(ipcChannels.runtimeCompact, async (_event, input) => {
    const parsed = compactInputSchema.parse(input);
    return runtimeStateSchema.parse(await runtime.compact(parsed.instructions));
  });
}
