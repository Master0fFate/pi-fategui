import { app, BrowserWindow, dialog, ipcMain, webContents } from 'electron';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import packageManifest from '../../../package.json';
import {
  abortResultSchema,
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
  diagnosticsSchema,
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
  type AppInfo,
} from '../../shared/contracts/ipc';
import { normalizeError, PiDesktopError } from '../pi/errors';
import type { FilesystemService } from '../files/FilesystemService';
import type { GitService } from '../git/GitService';
import type { PiRuntimeService } from '../pi/PiRuntimeService';
import type { ProjectService } from '../projects/ProjectService';
import type { SettingsService } from '../settings/SettingsService';
import type { TerminalService } from '../terminal/TerminalService';
import type { AppLogService } from '../logging/AppLogService';

export interface IpcServices {
  runtime: PiRuntimeService;
  projects: ProjectService;
  files: FilesystemService;
  git: GitService;
  settings: SettingsService;
  terminal: TerminalService;
  logs: AppLogService;
}

function register(channel: string, handler: (event: Electron.IpcMainInvokeEvent, input: unknown) => unknown | Promise<unknown>): void {
  ipcMain.handle(channel, async (event, input: unknown) => {
    try {
      if (event.senderFrame !== event.sender.mainFrame) {
        throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'IPC is restricted to the application main frame.', retryable: false });
      }
      return await handler(event, input);
    } catch (error) {
      const normalized = error instanceof PiDesktopError ? error.normalized : normalizeError(error);
      throw new Error(JSON.stringify(normalized));
    }
  });
}

export function registerIpc({ runtime, projects, files, git, settings, terminal, logs }: IpcServices): void {
  runtime.setEventSink((events) => {
    const batch = piEventBatchSchema.parse(events);
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(ipcChannels.runtimeEvents, batch);
  });
  terminal.setEventSink((ownerId, event) => {
    const owner = webContents.fromId(ownerId);
    if (owner && !owner.isDestroyed()) owner.send(ipcChannels.terminalEvents, terminalEventSchema.parse(event));
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
    if (project) {
      await files.setRoot(project.path);
      const opened = await runtime.openProject(project);
      if (opened.status === 'ready') {
        const defaults = await settings.load();
        try {
          runtime.setThinkingLevel(defaults.thinkingLevel);
          if (defaults.defaultModel) {
            const separator = defaults.defaultModel.indexOf('/');
            if (separator > 0) await runtime.setModel(defaults.defaultModel.slice(0, separator), defaults.defaultModel.slice(separator + 1));
          }
        } catch (error) {
          logs.write('warn', 'settings', `A saved agent default could not be applied: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
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
  register(ipcChannels.filesList, async (_event, input) => {
    const parsed = fileListInputSchema.parse(input);
    return fileListSchema.parse(await files.list(parsed.path));
  });
  register(ipcChannels.filesSearch, async (_event, input) => {
    const parsed = fileSearchInputSchema.parse(input);
    return fileSearchResultSchema.parse(await files.search(parsed.query, parsed.limit));
  });
  register(ipcChannels.filesRead, async (_event, input) => {
    const parsed = filePathInputSchema.parse(input);
    return filePreviewSchema.parse(await files.read(parsed.path));
  });
  register(ipcChannels.filesOpen, async (_event, input) => {
    const parsed = filePathInputSchema.parse(input);
    return openFileResultSchema.parse(await files.open(parsed.path));
  });
  register(ipcChannels.gitStatus, async (_event, input) => {
    emptyInputSchema.parse(input);
    return gitStatusSchema.parse(await git.status());
  });
  register(ipcChannels.gitDiff, async (_event, input) => {
    const parsed = filePathInputSchema.parse(input);
    return gitDiffSchema.parse(await git.diff(parsed.path));
  });
  register(ipcChannels.terminalCreate, (event, input) => {
    const parsed = terminalCreateInputSchema.parse(input);
    return terminalCreateResultSchema.parse(terminal.create(event.sender.id, parsed.cols, parsed.rows));
  });
  register(ipcChannels.terminalWrite, (event, input) => {
    const parsed = terminalWriteInputSchema.parse(input);
    terminal.write(event.sender.id, parsed.id, parsed.data);
  });
  register(ipcChannels.terminalResize, (event, input) => {
    const parsed = terminalResizeInputSchema.parse(input);
    terminal.resize(event.sender.id, parsed.id, parsed.cols, parsed.rows);
  });
  register(ipcChannels.terminalClose, (event, input) => {
    const parsed = terminalCloseInputSchema.parse(input);
    terminal.close(event.sender.id, parsed.id);
  });
  register(ipcChannels.settingsGet, async (_event, input) => {
    emptyInputSchema.parse(input);
    return appSettingsSchema.parse(await settings.load());
  });
  register(ipcChannels.settingsSet, async (_event, input) => appSettingsSchema.parse(await settings.set(appSettingsSchema.parse(input))));
  register(ipcChannels.diagnosticsGet, (_event, input) => {
    emptyInputSchema.parse(input);
    const state = runtime.getState(false);
    return diagnosticsSchema.parse({
      appVersion: app.getVersion(), electronVersion: process.versions.electron ?? '', nodeVersion: process.versions.node,
      chromeVersion: process.versions.chrome ?? '', piVersion: packageManifest.dependencies['@earendil-works/pi-coding-agent'],
      platform: process.platform, arch: process.arch, agentDirectory: getAgentDir(), projectPath: state.project?.path ?? null,
      runtimeStatus: state.status, sessionId: state.sessionId, packaged: app.isPackaged,
    });
  });
  register(ipcChannels.logsGet, (_event, input) => {
    emptyInputSchema.parse(input);
    return logListSchema.parse(logs.list());
  });
}
