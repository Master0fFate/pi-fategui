import { app, BrowserWindow, ipcMain } from 'electron';
import {
  abortResultSchema,
  appInfoSchema,
  emptyInputSchema,
  getAppInfoInputSchema,
  ipcChannels,
  piEventBatchSchema,
  promptAcceptanceSchema,
  promptInputSchema,
  runtimeStateSchema,
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
}
