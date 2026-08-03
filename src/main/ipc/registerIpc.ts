import { app, BrowserWindow, clipboard, dialog, ipcMain, webContents } from 'electron';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import packageManifest from '../../../package.json';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  abortResultSchema,
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
  diagnosticsSchema,
  logListSchema,
  musicClearResultSchema,
  musicLoadInputSchema,
  musicQueueResultSchema,
  musicQueueSchema,
  musicStatusSchema,
  musicStreamResultSchema,
  musicStreamSchema,
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
  type AppInfo,
  type RuntimeImage,
} from '../../shared/contracts/ipc';
import { agentTeamControlInputSchema } from '../../shared/contracts/multiAgent';
import { normalizeError, PiDesktopError } from '../pi/errors';
import { encodedImageSize, MAX_PROMPT_IMAGE_BYTES, MAX_PROMPT_IMAGE_DIMENSION, MAX_PROMPT_IMAGE_TOTAL_PIXELS } from '../pi/PiPromptImages';
import type { FilesystemService } from '../files/FilesystemService';
import type { GitService } from '../git/GitService';
import type { PiRuntimeService } from '../pi/PiRuntimeService';
import type { ProjectActivation, ProjectService } from '../projects/ProjectService';
import type { SettingsService } from '../settings/SettingsService';
import type { TerminalService } from '../terminal/TerminalService';
import type { AppLogService } from '../logging/AppLogService';
import type { MusicService } from '../music/MusicService';
import type { SpeechService } from '../speech/SpeechService';
import type { UpdateService } from '../updates/UpdateService';
import { isTrustedRendererUrl, type TrustedRendererPolicy } from '../security/trustedRenderer';

const imageSaveFormats: Record<RuntimeImage['mimeType'], { extension: string; name: string }> = {
  'image/png': { extension: 'png', name: 'PNG image' },
  'image/jpeg': { extension: 'jpg', name: 'JPEG image' },
  'image/gif': { extension: 'gif', name: 'GIF image' },
  'image/webp': { extension: 'webp', name: 'WebP image' },
};

function suggestedImageFileName(label: string, extension: string): string {
  const stem = label.normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[. ]+$/gu, '')
    .slice(0, 120)
    .trim();
  return `${stem || 'generated-image'}.${extension}`;
}

export interface IpcServices {
  runtime: PiRuntimeService;
  projects: ProjectService;
  files: FilesystemService;
  git: GitService;
  settings: SettingsService;
  terminal: TerminalService;
  logs: AppLogService;
  music: Pick<MusicService, 'getStatus' | 'load' | 'resolveTrack' | 'clearQueue' | 'reset'>;
  speech: Pick<SpeechService, 'setEventSink' | 'getStatus' | 'download' | 'cancelDownload' | 'remove' | 'transcribe' | 'cancel'>;
  updates: Pick<UpdateService, 'check' | 'openDownload'>;
  rendererPolicy: TrustedRendererPolicy;
}

interface ProjectActivationServices {
  runtime: Pick<PiRuntimeService, 'getState' | 'openProject' | 'closeProject'>;
  files: Pick<FilesystemService, 'getRootOrNull' | 'setRoot' | 'clearRoot'>;
  settings: { load: () => Promise<Pick<Awaited<ReturnType<SettingsService['load']>>, 'thinkingLevel' | 'defaultModel'> & Partial<Pick<Awaited<ReturnType<SettingsService['load']>>, 'agentTeamMode'>>> };
  terminal: Pick<TerminalService, 'disposeProjectTerminals'>;
  logs: Pick<AppLogService, 'write'>;
}

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) return [error.message, ...error.errors.map(errorMessage)].filter(Boolean).join(' ');
  return error instanceof Error ? error.message : String(error);
}

function activationError(primary: unknown, rollbackFailures: readonly { label: string; error: unknown }[]): PiDesktopError {
  const normalized = primary instanceof PiDesktopError ? primary.normalized : normalizeError(primary);
  if (rollbackFailures.length === 0) return new PiDesktopError(normalized);
  return new PiDesktopError({
    ...normalized,
    message: `${normalized.message} Rollback also failed: ${rollbackFailures.map(({ label, error }) => `${label}: ${errorMessage(error)}`).join('; ')}`,
  });
}

export function assertProjectActivationIdle(runtime: Pick<PiRuntimeService, 'getState'>, action: string): void {
  const state = runtime.getState(false);
  if ((state.runningSessionCount ?? (state.streaming ? 1 : 0)) > 0 || state.sessionOperation) {
    throw new PiDesktopError({ code: 'RUN_ACTIVE', message: `Stop all active Pi operations before ${action}.`, retryable: true });
  }
}

export async function discardCreatedWorktreeAfterFailure(primary: unknown, discard: () => Promise<void>): Promise<never> {
  try {
    await discard();
  } catch (cleanupError) {
    throw activationError(primary, [{ label: 'created worktree cleanup', error: cleanupError }]);
  }
  throw primary;
}

export function createProjectActivationQueue() {
  let queue: Promise<void> = Promise.resolve();
  let pendingActivations = 0;
  const enqueue = <T>(operation: () => Promise<T>, activation: boolean): Promise<T> => {
    if (activation) pendingActivations += 1;
    const execute = async () => {
      try { return await operation(); } finally {
        if (activation) pendingActivations -= 1;
      }
    };
    const result = queue.then(execute, execute);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      return enqueue(operation, true);
    },
    runSerializedMutation<T>(operation: () => T | Promise<T>): Promise<T> {
      return enqueue(async (): Promise<T> => operation(), false);
    },
    runRuntimeMutation<T>(action: string, operation: () => T | Promise<T>): Promise<T> {
      if (pendingActivations > 0) {
        return Promise.reject(new PiDesktopError({ code: 'RUN_ACTIVE', message: `Wait for the project change to finish before ${action}.`, retryable: true }));
      }
      return enqueue(async (): Promise<T> => operation(), false);
    },
  };
}

export function createProjectPathOpener(
  projects: Pick<ProjectService, 'prepareOpenPath'>,
  activationServices: ProjectActivationServices,
  queueProjectActivation = createProjectActivationQueue(),
) {
  return (projectPath: string, owner?: BrowserWindow) => queueProjectActivation.run(async () => {
    assertProjectActivationIdle(activationServices.runtime, 'changing projects');
    const activation = await projects.prepareOpenPath(projectPath, owner);
    if (!activation) return runtimeStateSchema.parse(activationServices.runtime.getState());
    return runtimeStateSchema.parse(await activatePreparedProject(activation, activationServices, 'changing projects'));
  });
}

export async function activatePreparedProject(
  activation: ProjectActivation,
  { runtime, files, settings, terminal, logs }: ProjectActivationServices,
  action: string,
) {
  assertProjectActivationIdle(runtime, action);
  const previousProject = runtime.getState(false).project;
  const previousRoot = files.getRootOrNull();
  const defaults = await settings.load();
  assertProjectActivationIdle(runtime, action);
  let rootAttempted = false;
  let runtimeAttempted = false;
  let activatedState: Awaited<ReturnType<PiRuntimeService['openProject']>>;
  try {
    rootAttempted = true;
    await files.setRoot(activation.project.path);
    runtimeAttempted = true;
    activatedState = await runtime.openProject(activation.project, { thinkingLevel: defaults.thinkingLevel, defaultModel: defaults.defaultModel, ...(defaults.agentTeamMode ? { agentTeamMode: defaults.agentTeamMode } : {}) });
    if (activatedState.status === 'error') throw new PiDesktopError(activatedState.error ?? { code: 'PI_RUNTIME_ERROR', message: 'Pi failed to activate the project.', retryable: true });
    await activation.commit();
  } catch (error) {
    const rollbackFailures: { label: string; error: unknown }[] = [];
    if (runtimeAttempted) {
      try {
        const restored = previousProject
          ? await runtime.openProject(previousProject, { thinkingLevel: defaults.thinkingLevel, defaultModel: defaults.defaultModel, ...(defaults.agentTeamMode ? { agentTeamMode: defaults.agentTeamMode } : {}) })
          : await runtime.closeProject();
        if (restored.status === 'error') throw new PiDesktopError(restored.error ?? { code: 'PI_RUNTIME_ERROR', message: 'Pi failed to restore the previous project.', retryable: true });
      } catch (rollbackError) {
        rollbackFailures.push({ label: 'runtime', error: rollbackError });
      }
    }
    if (rootAttempted) {
      try {
        if (previousRoot) await files.setRoot(previousRoot);
        else await files.clearRoot();
      } catch (rollbackError) {
        rollbackFailures.push({ label: 'filesystem', error: rollbackError });
      }
    }
    try {
      await activation.rollback();
    } catch (rollbackError) {
      rollbackFailures.push({ label: 'project persistence', error: rollbackError });
    }
    throw activationError(error, rollbackFailures);
  }
  try {
    terminal.disposeProjectTerminals();
  } catch (error) {
    logs.write('error', 'terminal', `Old project terminals could not be fully disposed after project activation: ${errorMessage(error)}`);
  }
  return activatedState;
}

function register(channel: string, rendererPolicy: TrustedRendererPolicy, handler: (event: Electron.IpcMainInvokeEvent, input: unknown) => unknown | Promise<unknown>): void {
  ipcMain.handle(channel, async (event, input: unknown) => {
    try {
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (event.senderFrame !== event.sender.mainFrame || !owner || owner.isDestroyed() || !isTrustedRendererUrl(event.senderFrame.url, rendererPolicy)) {
        throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'IPC is restricted to the application main frame.', retryable: false });
      }
      return await handler(event, input);
    } catch (error) {
      const normalized = error instanceof PiDesktopError ? error.normalized : normalizeError(error);
      throw new Error(JSON.stringify(normalized));
    }
  });
}

export function registerIpc({ runtime, projects, files, git, settings, terminal, logs, music, speech, updates, rendererPolicy }: IpcServices) {
  runtime.setEventSink((events) => {
    const batch = piEventBatchSchema.parse(events);
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(ipcChannels.runtimeEvents, batch);
  });
  terminal.setEventSink((ownerId, event) => {
    const owner = webContents.fromId(ownerId);
    if (owner && !owner.isDestroyed()) owner.send(ipcChannels.terminalEvents, terminalEventSchema.parse(event));
  });
  speech.setEventSink((progress) => {
    const payload = speechDownloadProgressSchema.parse(progress);
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(ipcChannels.speechEvents, payload);
  });

  const handle = (channel: string, handler: (event: Electron.IpcMainInvokeEvent, input: unknown) => unknown | Promise<unknown>) => register(channel, rendererPolicy, handler);
  const activationServices = { runtime, files, settings, terminal, logs };
  const queueProjectActivation = createProjectActivationQueue();
  const openProjectPath = createProjectPathOpener(projects, activationServices, queueProjectActivation);
  const runRuntimeMutation = <T>(action: string, operation: () => T | Promise<T>) => queueProjectActivation.runRuntimeMutation(action, operation);

  handle(ipcChannels.systemGetInfo, (_event, input): AppInfo => {
    getAppInfoInputSchema.parse(input);
    return appInfoSchema.parse({
      name: 'Fate UI',
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged,
    });
  });
  const windowState = (owner: BrowserWindow) => windowStateSchema.parse({
    maximized: !owner.isDestroyed() && owner.isMaximized(),
    minimized: !owner.isDestroyed() && owner.isMinimized(),
  });
  const ownerWindow = (event: Electron.IpcMainInvokeEvent) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed()) throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'The application window is unavailable.', retryable: false });
    return owner;
  };
  handle(ipcChannels.windowGetState, (event, input) => {
    emptyInputSchema.parse(input);
    return windowState(ownerWindow(event));
  });
  handle(ipcChannels.windowControl, (event, input) => {
    const { action } = windowControlInputSchema.parse(input);
    const owner = ownerWindow(event);
    if (action === 'minimize') owner.minimize();
    else if (action === 'toggle-maximize') {
      if (owner.isMaximized()) owner.unmaximize();
      else owner.maximize();
    }
    else owner.close();
    return windowState(owner);
  });
  handle(ipcChannels.projectSelect, async (event, input) => {
    emptyInputSchema.parse(input);
    return queueProjectActivation.run(async () => {
      assertProjectActivationIdle(runtime, 'changing projects');
      const activation = await projects.prepareSelect(BrowserWindow.fromWebContents(event.sender) ?? undefined);
      if (!activation) return runtimeStateSchema.parse(runtime.getState());
      return runtimeStateSchema.parse(await activatePreparedProject(activation, activationServices, 'changing projects'));
    });
  });
  handle(ipcChannels.projectSelectFile, async (event, input) => {
    emptyInputSchema.parse(input);
    const relativePath = await projects.selectFile(BrowserWindow.fromWebContents(event.sender) ?? undefined);
    return projectFileReferenceSchema.parse(relativePath);
  });
  handle(ipcChannels.projectReveal, async (_event, input) => {
    emptyInputSchema.parse(input);
    return revealProjectResultSchema.parse(await projects.revealCurrent());
  });
  handle(ipcChannels.imageReadLocal, async (_event, input) => {
    const parsed = localImageInputSchema.parse(input);
    return runtimeImageSchema.parse(await files.readLocalImage(parsed.path));
  });
  handle(ipcChannels.imageSaveAs, async (event, input) => {
    const parsed = imageSaveInputSchema.parse(input);
    const image = Buffer.from(parsed.data, 'base64');
    const dimensions = encodedImageSize(image, parsed.mimeType);
    if (
      image.toString('base64') !== parsed.data
      || !dimensions
      || image.length === 0
      || image.length > MAX_PROMPT_IMAGE_BYTES
      || dimensions.width <= 0
      || dimensions.height <= 0
      || dimensions.width > MAX_PROMPT_IMAGE_DIMENSION
      || dimensions.height > MAX_PROMPT_IMAGE_DIMENSION
      || dimensions.width * dimensions.height > MAX_PROMPT_IMAGE_TOTAL_PIXELS
    ) {
      throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'The image cannot be saved because its raster data is malformed or oversized.', retryable: false });
    }
    const format = imageSaveFormats[parsed.mimeType];
    const result = await dialog.showSaveDialog(ownerWindow(event), {
      title: 'Save image as',
      defaultPath: path.join(app.getPath('pictures'), suggestedImageFileName(parsed.suggestedName, format.extension)),
      filters: [{ name: format.name, extensions: [format.extension] }],
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (result.canceled || !result.filePath) return imageSaveResultSchema.parse({ saved: false });
    await fs.writeFile(result.filePath, image);
    return imageSaveResultSchema.parse({ saved: true, path: result.filePath });
  });
  handle(ipcChannels.clipboardWriteText, (_event, input) => {
    const { text } = clipboardTextInputSchema.parse(input);
    clipboard.writeText(text);
    return clipboardWriteResultSchema.parse({ written: true });
  });
  handle(ipcChannels.runtimeGetState, (_event, input) => {
    emptyInputSchema.parse(input);
    return runtimeStateSchema.parse(runtime.getHydrationState());
  });
  handle(ipcChannels.runtimePrompt, async (_event, input) => runRuntimeMutation('sending a prompt', async () => {
    const accepted = await runtime.prompt(promptInputSchema.parse(input));
    return promptAcceptanceSchema.parse(accepted);
  }));
  handle(ipcChannels.runtimeAbort, async (_event, input) => {
    emptyInputSchema.parse(input);
    return abortResultSchema.parse(await runtime.abort());
  });
  handle(ipcChannels.runtimeControlSubagent, async (_event, input) => runRuntimeMutation('controlling a child agent', async () => (
    runtimeStateSchema.parse(await runtime.controlSubagent(subagentControlInputSchema.parse(input)))
  )));
  handle(ipcChannels.runtimeControlAgentTeam, async (_event, input) => runRuntimeMutation('controlling an Agent Team node', async () => (
    runtimeStateSchema.parse(await runtime.controlAgentTeam(agentTeamControlInputSchema.parse(input)))
  )));
  handle(ipcChannels.runtimeSetModel, async (_event, input) => {
    const parsed = setModelInputSchema.parse(input);
    return runRuntimeMutation('changing the model', async () => runtimeStateSchema.parse(await runtime.setModel(parsed.provider, parsed.id)));
  });
  handle(ipcChannels.runtimeSetThinking, (_event, input) => {
    const parsed = setThinkingInputSchema.parse(input);
    return runRuntimeMutation('changing the reasoning level', () => runtimeStateSchema.parse(runtime.setThinkingLevel(parsed.level)));
  });
  handle(ipcChannels.runtimeSetPermission, async (_event, input) => {
    const parsed = setPermissionInputSchema.parse(input);
    return runRuntimeMutation('changing permissions', async () => runtimeStateSchema.parse(await runtime.setPermissionLevel(parsed.level)));
  });
  handle(ipcChannels.runtimeMutateQueue, async (_event, input) => runRuntimeMutation('editing queued messages', async () => (
    queueMutationResultSchema.parse(await runtime.mutateQueuedMessage(queueMutationInputSchema.parse(input)))
  )));
  handle(ipcChannels.runtimeNewSession, async (_event, input) => {
    emptyInputSchema.parse(input);
    return runRuntimeMutation('creating a session', async () => runtimeStateSchema.parse(await runtime.newSession()));
  });
  handle(ipcChannels.runtimeListSessions, async (_event, input) => {
    const parsed = sessionSearchInputSchema.parse(input);
    return sessionListSchema.parse(await runtime.listSessions(parsed.query));
  });
  handle(ipcChannels.runtimeSwitchSession, async (_event, input) => {
    const parsed = sessionIdInputSchema.parse(input);
    return runRuntimeMutation('switching sessions', async () => runtimeStateSchema.parse(await runtime.switchSession(parsed.sessionId)));
  });
  handle(ipcChannels.runtimeRenameSession, async (_event, input) => {
    const parsed = sessionRenameInputSchema.parse(input);
    return runRuntimeMutation('renaming a session', async () => runtimeStateSchema.parse(await runtime.renameSession(parsed.sessionId, parsed.name)));
  });
  handle(ipcChannels.runtimeDeleteSession, async (_event, input) => {
    const parsed = sessionIdInputSchema.parse(input);
    return runRuntimeMutation('deleting a session', async () => runtimeStateSchema.parse(await runtime.deleteSession(parsed.sessionId)));
  });
  handle(ipcChannels.runtimeForkSession, async (_event, input) => {
    const parsed = sessionEntryInputSchema.parse(input);
    return runRuntimeMutation('forking a session', async () => forkSessionResultSchema.parse(await runtime.forkSession(parsed.entryId)));
  });
  handle(ipcChannels.runtimeCloneSession, async (_event, input) => {
    emptyInputSchema.parse(input);
    return runRuntimeMutation('cloning a session', async () => runtimeStateSchema.parse(await runtime.cloneSession()));
  });
  handle(ipcChannels.runtimeImportSession, async (event, input) => {
    emptyInputSchema.parse(input);
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: 'Import Pi session',
      properties: ['openFile'],
      filters: [{ name: 'Pi session', extensions: ['jsonl'] }],
    };
    const selected = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0]) return null;
    return runRuntimeMutation('importing a session', async () => runtimeStateSchema.parse(await runtime.importSession(selected.filePaths[0]!)));
  });
  handle(ipcChannels.runtimeCompact, async (_event, input) => {
    const parsed = compactInputSchema.parse(input);
    return runRuntimeMutation('compacting context', async () => runtimeStateSchema.parse(await runtime.compact(parsed.instructions)));
  });
  handle(ipcChannels.filesList, async (_event, input) => {
    const parsed = fileListInputSchema.parse(input);
    return fileListSchema.parse(await files.list(parsed.path));
  });
  handle(ipcChannels.filesSearch, async (_event, input) => {
    const parsed = fileSearchInputSchema.parse(input);
    return fileSearchResultSchema.parse(await files.search(parsed.query, parsed.limit));
  });
  handle(ipcChannels.filesRead, async (_event, input) => {
    const parsed = filePathInputSchema.parse(input);
    return filePreviewSchema.parse(await files.read(parsed.path));
  });
  handle(ipcChannels.filesOpen, async (_event, input) => {
    const parsed = filePathInputSchema.parse(input);
    return openFileResultSchema.parse(await files.open(parsed.path));
  });
  handle(ipcChannels.gitStatus, async (_event, input) => {
    emptyInputSchema.parse(input);
    return gitStatusSchema.parse(await git.status());
  });
  handle(ipcChannels.gitDiff, async (_event, input) => {
    const parsed = filePathInputSchema.parse(input);
    return gitDiffSchema.parse(await git.diff(parsed.path));
  });
  handle(ipcChannels.gitCombinedDiff, async (_event, input) => {
    emptyInputSchema.parse(input);
    return gitCombinedDiffSchema.parse(await git.combinedDiff());
  });
  handle(ipcChannels.gitWorktrees, async (_event, input) => {
    emptyInputSchema.parse(input);
    return gitWorktreeListSchema.parse(await git.worktrees());
  });
  handle(ipcChannels.gitSwitchWorktree, async (event, input) => queueProjectActivation.run(async () => {
    assertProjectActivationIdle(runtime, 'changing worktrees');
    const current = runtime.getState(false);
    const selectedPath = await git.resolveWorktree(gitWorktreeInputSchema.parse(input).path);
    assertProjectActivationIdle(runtime, 'changing worktrees');
    if (current.project?.path === selectedPath) return runtimeStateSchema.parse(current);
    const activation = await projects.prepareOpenPath(selectedPath, BrowserWindow.fromWebContents(event.sender) ?? undefined);
    if (!activation) return runtimeStateSchema.parse(current);
    return runtimeStateSchema.parse(await activatePreparedProject(activation, activationServices, 'changing worktrees'));
  }));
  handle(ipcChannels.gitCreateWorktreeSession, async (_event, input) => queueProjectActivation.run(async () => {
    assertProjectActivationIdle(runtime, 'creating an isolated worktree session');
    const current = runtime.getState(false);
    if (!current.project?.trusted) {
      throw new PiDesktopError({ code: 'PROJECT_NOT_TRUSTED', message: 'Trust the active project before creating an isolated worktree session.', retryable: false });
    }
    const { entryId } = sessionEntryInputSchema.parse(input);
    const selectedText = runtime.forkPrompt(entryId);
    const sourceProjectPath = current.project.path;
    const worktree = await git.createWorktree(selectedText);
    try {
      const activation = await projects.prepareDerivedWorktree(worktree.path, sourceProjectPath);
      const state = await activatePreparedProject(activation, activationServices, 'creating an isolated worktree session');
      return gitWorktreeSessionResultSchema.parse({ state, selectedText, worktree: { ...worktree, current: true } });
    } catch (error) {
      return discardCreatedWorktreeAfterFailure(error, () => git.discardCreatedWorktree(worktree));
    }
  }));
  handle(ipcChannels.gitHistory, async (_event, input) => {
    emptyInputSchema.parse(input);
    return gitHistorySchema.parse(await git.history());
  });
  handle(ipcChannels.gitCommitDetails, async (_event, input) => {
    const parsed = gitCommitInputSchema.parse(input);
    return gitCommitDetailsSchema.parse(await git.commitDetails(parsed.hash));
  });
  handle(ipcChannels.gitOperation, async (_event, input) => queueProjectActivation.runSerializedMutation(async () => {
    const parsed = gitOperationInputSchema.parse(input);
    return gitOperationResultSchema.parse(await git.runOperation(parsed.operation));
  }));
  handle(ipcChannels.terminalCreate, (event, input) => {
    const parsed = terminalCreateInputSchema.parse(input);
    return terminalCreateResultSchema.parse(terminal.create(event.sender.id, parsed.cols, parsed.rows));
  });
  handle(ipcChannels.terminalWrite, (event, input) => {
    const parsed = terminalWriteInputSchema.parse(input);
    terminal.write(event.sender.id, parsed.id, parsed.data);
  });
  handle(ipcChannels.terminalAck, (event, input) => {
    const parsed = terminalAckInputSchema.parse(input);
    terminal.acknowledge(event.sender.id, parsed.id, parsed.characters);
  });
  handle(ipcChannels.terminalResize, (event, input) => {
    const parsed = terminalResizeInputSchema.parse(input);
    terminal.resize(event.sender.id, parsed.id, parsed.cols, parsed.rows);
  });
  handle(ipcChannels.terminalClose, (event, input) => {
    const parsed = terminalCloseInputSchema.parse(input);
    terminal.close(event.sender.id, parsed.id);
  });
  handle(ipcChannels.settingsGet, async (_event, input) => {
    emptyInputSchema.parse(input);
    return appSettingsSchema.parse(await settings.load());
  });
  handle(ipcChannels.settingsSet, async (_event, input) => {
    const saved = appSettingsSchema.parse(await settings.set(appSettingsSchema.parse(input)));
    if (!saved.musicPlayerEnabled) music.reset();
    return saved;
  });
  handle(ipcChannels.updatesCheck, async (_event, input) => {
    emptyInputSchema.parse(input);
    return updateCheckResultSchema.parse(await updates.check());
  });
  handle(ipcChannels.updatesOpenDownload, async (_event, input) => {
    emptyInputSchema.parse(input);
    await updates.openDownload();
    return openUpdateDownloadResultSchema.parse({ opened: true });
  });
  handle(ipcChannels.themesGet, async (_event, input) => {
    emptyInputSchema.parse(input);
    return themeCatalogSchema.parse(await settings.loadThemes(runtime.getState(false).project));
  });
  handle(ipcChannels.speechGetStatus, async (_event, input) => {
    emptyInputSchema.parse(input);
    return speechStatusSchema.parse(await speech.getStatus());
  });
  handle(ipcChannels.speechEnsureModel, async (_event, input) => {
    const { modelId } = speechModelInputSchema.parse(input);
    await speech.download(modelId);
  });
  handle(ipcChannels.speechDownloadModel, async (_event, input) => {
    const { modelId } = speechModelInputSchema.parse(input);
    await speech.download(modelId);
    return speechStatusSchema.parse(await speech.getStatus());
  });
  handle(ipcChannels.speechCancelDownload, (_event, input) => {
    const { modelId } = speechModelInputSchema.parse(input);
    return speechCancelResultSchema.parse({ cancelled: speech.cancelDownload(modelId) });
  });
  handle(ipcChannels.speechRemoveModel, async (_event, input) => {
    const { modelId } = speechModelInputSchema.parse(input);
    await speech.remove(modelId);
    return speechStatusSchema.parse(await speech.getStatus());
  });
  handle(ipcChannels.speechTranscribe, async (_event, input) => {
    const parsed = speechTranscribeInputSchema.parse(input);
    return speechTranscriptionSchema.parse(await speech.transcribe(parsed.modelId, parsed.audio, parsed.language));
  });
  handle(ipcChannels.speechCancel, (_event, input) => {
    emptyInputSchema.parse(input);
    return speechCancelResultSchema.parse({ cancelled: speech.cancel() });
  });
  const requireMusicEnabled = async () => {
    if (!(await settings.load()).musicPlayerEnabled) {
      throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'Enable the music player in Settings before loading media.', retryable: false });
    }
  };
  handle(ipcChannels.musicGetStatus, async (_event, input) => {
    emptyInputSchema.parse(input);
    await requireMusicEnabled();
    return musicStatusSchema.parse(await music.getStatus());
  });
  handle(ipcChannels.musicLoad, async (_event, input) => {
    const { url } = musicLoadInputSchema.parse(input);
    try {
      await requireMusicEnabled();
      return musicQueueResultSchema.parse({ ok: true, value: musicQueueSchema.parse(await music.load(url)) });
    } catch (error) {
      const normalized = error instanceof PiDesktopError ? error.normalized : normalizeError(error);
      return musicQueueResultSchema.parse({ ok: false, error: normalized });
    }
  });
  handle(ipcChannels.musicResolveTrack, async (_event, input) => {
    const { trackId } = musicTrackInputSchema.parse(input);
    try {
      await requireMusicEnabled();
      return musicStreamResultSchema.parse({ ok: true, value: musicStreamSchema.parse(await music.resolveTrack(trackId)) });
    } catch (error) {
      const normalized = error instanceof PiDesktopError ? error.normalized : normalizeError(error);
      return musicStreamResultSchema.parse({ ok: false, error: normalized });
    }
  });
  handle(ipcChannels.musicClearQueue, async (_event, input) => {
    emptyInputSchema.parse(input);
    try {
      await requireMusicEnabled();
      music.clearQueue();
      return musicClearResultSchema.parse({ ok: true });
    } catch (error) {
      const normalized = error instanceof PiDesktopError ? error.normalized : normalizeError(error);
      return musicClearResultSchema.parse({ ok: false, error: normalized });
    }
  });
  handle(ipcChannels.diagnosticsGet, (_event, input) => {
    emptyInputSchema.parse(input);
    const state = runtime.getState(false);
    return diagnosticsSchema.parse({
      appVersion: app.getVersion(), electronVersion: process.versions.electron ?? '', nodeVersion: process.versions.node,
      chromeVersion: process.versions.chrome ?? '', piVersion: packageManifest.dependencies['@earendil-works/pi-coding-agent'],
      platform: process.platform, arch: process.arch, agentDirectory: getAgentDir(), projectPath: state.project?.path ?? null,
      runtimeStatus: state.status, sessionId: state.sessionId, packaged: app.isPackaged,
    });
  });
  handle(ipcChannels.logsGet, (_event, input) => {
    emptyInputSchema.parse(input);
    return logListSchema.parse(logs.list());
  });

  return { openProjectPath };
}
