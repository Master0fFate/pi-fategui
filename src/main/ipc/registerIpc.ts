import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, webContents } from 'electron';
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
  gitRevertPathInputSchema,
  gitRevertPathResultSchema,
  recoveryNoticeResultSchema,
  sessionExportResultSchema,
  gitStatusSchema,
  gitWorktreeInputSchema,
  gitWorktreeListSchema,
  gitWorktreeSessionResultSchema,
  ipcChannels,
  imageSaveInputSchema,
  imageSaveResultSchema,
  localImageInputSchema,
  diagnosticsSchema,
  modelsDevAddInputSchema,
  modelsDevListResultSchema,
  modelsDevMutationResultSchema,
  modelsDevProviderDetailSchema,
  modelsDevRemoveInputSchema,
  logListSchema,
  musicClearResultSchema,
  musicDurationsEventSchema,
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
  promptOptimizationInputSchema,
  promptOptimizationResultSchema,
  queueMutationInputSchema,
  queueMutationResultSchema,
  runtimeImageSchema,
  runtimeStateSchema,
  automationSessionPreparationResultSchema,
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
  subagentControlInputSchema,
  setModelInputSchema,
  setPermissionInputSchema,
  providerLoginStartInputSchema,
  providerLoginRespondInputSchema,
  providerLogoutInputSchema,
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
  updateInstallStartedSchema,
  updateVersionInputSchema,
  windowControlInputSchema,
  windowStateSchema,
  type AppInfo,
  type ProjectState,
  type RuntimeImage,
  type RuntimeState,
} from '../../shared/contracts/ipc';
import { agentTeamControlInputSchema } from '../../shared/contracts/multiAgent';
import {
  automationCreateInputSchema,
  automationDefinitionSchema,
  automationDeleteResultSchema,
  automationIdInputSchema,
  automationLaunchRecordInputSchema,
  automationListSchema,
  automationUpdateInputSchema,
} from '../../shared/contracts/automations';
import {
  goalMaxClearResultSchema,
  goalMaxControlInputSchema,
  goalMaxCreateInputSchema,
  goalMaxEventBatchSchema,
  goalMaxStateSchema,
  goalMaxSteeringEditInputSchema,
  goalMaxSteeringRemoveInputSchema,
  goalMaxUpdateInputSchema,
  type GoalMaxEvent,
} from '../../shared/contracts/goalmaxxing';
import {
  taskCreateInputSchema,
  taskDeleteInputSchema,
  taskEventBatchSchema,
  taskListSchema,
  taskReorderInputSchema,
  taskUpdateInputSchema,
  type TaskEvent,
} from '../../shared/contracts/tasks';
import { normalizeError, PiDesktopError } from '../pi/errors';
import { enabledModelIdentity } from '../../shared/modelVisibility';
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
import type { GlobalHotkeyService } from '../speech/GlobalHotkeyService';
import type { UpdateService } from '../updates/UpdateService';
import type { RecoverySnapshotService } from '../bootstrap/RecoverySnapshot';
import { buildSessionExport } from '../pi/SessionExport';
import { isTrustedRendererUrl, type TrustedRendererPolicy } from '../security/trustedRenderer';
import type { BrowserHost } from '../browser/BrowserHost';
import type { MutationAttestationLedger } from '../pi/provenance/MutationAttestationLedger';
import {
  attestationQueryRequestSchema,
  attestationQueryResultSchema,
  type AttestationQueryRequest,
  type AttestationQueryResult,
} from '../../shared/contracts/mutationAttestation';
import type { AutomationRepository } from '../automations/AutomationRepository';
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
  browserHistoryInputSchema,
  browserLinkContextMenuInputSchema,
  browserLinkContextMenuResultSchema,
  browserNavigateInputSchema,
  browserNewTabInputSchema,
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
} from '../../shared/contracts/browser';

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
  music: Pick<MusicService, 'getStatus' | 'load' | 'resolveTrack' | 'clearQueue' | 'reset' | 'setDurationSink'>;
  speech: Pick<SpeechService, 'setEventSink' | 'setStreamSink' | 'getStatus' | 'download' | 'cancelDownload' | 'remove' | 'transcribe' | 'cancel' | 'streamStart' | 'streamFeed' | 'streamStop' | 'streamCancel'>;
  hotkey: GlobalHotkeyService;
  updates: Pick<UpdateService, 'check' | 'openDownload' | 'downloadAndInstall'>;
  recovery?: Pick<RecoverySnapshotService, 'remember' | 'consume' | 'peek' | 'markClean'>;
  browser: Pick<BrowserHost, 'ensure' | 'current' | 'setAppOverlay' | 'respondToConfirmation' | 'reset'>;
  automations: Pick<AutomationRepository, 'list' | 'create' | 'update' | 'remove' | 'recordLaunch'>;
  /** Read-only per-project attestation ledger; resolves only the current trusted project. */
  attestations: Pick<MutationAttestationLedger, 'query'>;
  /** Open another Fate UI window in this same process so it shares the live runtime. */
  newWindow?: () => void;
  rendererPolicy: TrustedRendererPolicy;
}

interface ProjectActivationServices {
  runtime: Pick<PiRuntimeService, 'getState' | 'openProject' | 'closeProject'> & {
    focusProject?: (project: ProjectState) => Promise<RuntimeState>;
  };
  files: Pick<FilesystemService, 'getRootOrNull' | 'setRoot' | 'clearRoot'>;
  settings: { load: () => Promise<Pick<Awaited<ReturnType<SettingsService['load']>>, 'thinkingLevel' | 'defaultModel'> & Partial<Pick<Awaited<ReturnType<SettingsService['load']>>, 'agentTeamMode' | 'disabledModels'>>> };
  terminal: Pick<TerminalService, 'disposeProjectTerminals'>;
  logs: Pick<AppLogService, 'write'>;
  browser?: Pick<BrowserHost, 'reset'>;
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
    // Switching the focused folder is safe while another folder streams; the
    // activation queue still serializes filesystem/runtime rewiring.
    const activation = await projects.prepareOpenPath(projectPath, owner);
    if (!activation) return runtimeStateSchema.parse(activationServices.runtime.getState());
    return runtimeStateSchema.parse(await activatePreparedProject(activation, activationServices, 'changing projects'));
  });
}

export function createProjectPathFocuser(
  projects: Pick<ProjectService, 'prepareOpenPath'>,
  activationServices: ProjectActivationServices,
  queueProjectActivation = createProjectActivationQueue(),
) {
  return (projectPath: string, owner?: BrowserWindow) => queueProjectActivation.run(async () => {
    const activation = await projects.prepareOpenPath(projectPath, owner);
    if (!activation) return runtimeStateSchema.parse(activationServices.runtime.getState());
    return runtimeStateSchema.parse(await activatePreparedProject(activation, activationServices, 'changing projects', 'focus'));
  });
}

export async function activatePreparedProject(
  activation: ProjectActivation,
  { runtime, files, settings, terminal, logs, browser }: ProjectActivationServices,
  action: string,
  runtimeAction: 'open' | 'focus' = 'open',
) {
  // Project switches keep background Pi runs alive. Worktree/session creation
  // remains guarded because it mutates the active project's execution context.
  if (action !== 'changing projects') assertProjectActivationIdle(runtime, action);
  const previousProject = runtime.getState(false).project;
  const previousRoot = files.getRootOrNull();
  const defaults = await settings.load();
  if (action !== 'changing projects') assertProjectActivationIdle(runtime, action);
  const activateRuntime = (project: ProjectState) => runtimeAction === 'focus' && runtime.focusProject
    ? runtime.focusProject(project)
    : runtime.openProject(project, { thinkingLevel: defaults.thinkingLevel, defaultModel: enabledModelIdentity(defaults.disabledModels, defaults.defaultModel), ...(defaults.agentTeamMode ? { agentTeamMode: defaults.agentTeamMode } : {}) });
  let rootAttempted = false;
  let runtimeAttempted = false;
  let activatedState: Awaited<ReturnType<PiRuntimeService['openProject']>>;
  try {
    rootAttempted = true;
    await files.setRoot(activation.project.path);
    runtimeAttempted = true;
    activatedState = await activateRuntime(activation.project);
    if (activatedState.status === 'error') throw new PiDesktopError(activatedState.error ?? { code: 'PI_RUNTIME_ERROR', message: 'Pi failed to activate the project.', retryable: true });
    await activation.commit();
  } catch (error) {
    const rollbackFailures: { label: string; error: unknown }[] = [];
    if (runtimeAttempted) {
      const closeProjectPath = (runtime as unknown as { closeProjectPath?: (projectPath: string) => Promise<void> }).closeProjectPath;
      if (runtimeAction !== 'focus' && closeProjectPath && previousProject && activation.project.path !== previousProject.path) {
        try { await closeProjectPath(activation.project.path); }
        catch (closeError) { rollbackFailures.push({ label: 'new runtime cleanup', error: closeError }); }
      }
      try {
        const restored = previousProject
          ? await activateRuntime(previousProject)
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
  if (browser) {
    try {
      await browser.reset();
    } catch (error) {
      logs.write('warn', 'browser', `The previous project browser could not be fully disposed: ${errorMessage(error)}`);
    }
  }
  try {
    terminal.disposeProjectTerminals();
  } catch (error) {
    logs.write('error', 'terminal', `Old project terminals could not be fully disposed after project activation: ${errorMessage(error)}`);
  }
  return activatedState;
}

/**
 * Resolve a renderer attestation query against the current TRUSTED project. The
 * project path is owned main-side; the renderer request never carries one. With
 * no trusted project the result is empty (truthful: nothing to report) so the
 * renderer has a single success path and an untrusted project never exposes its
 * ledger through this surface.
 */
export async function resolveAttestationQuery(
  runtime: Pick<PiRuntimeService, 'getState'>,
  ledger: Pick<MutationAttestationLedger, 'query'>,
  request: AttestationQueryRequest,
): Promise<AttestationQueryResult> {
  const project = runtime.getState(false).project;
  if (!project?.trusted) return { rows: [], truncated: false };
  return ledger.query({ projectPath: project.path, limit: request.limit, ...(request.pathPrefix ? { pathPrefix: request.pathPrefix } : {}) });
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

async function applyPendingRecovery(
  runtime: Pick<PiRuntimeService, 'getState' | 'switchSession'>,
  recovery: Pick<RecoverySnapshotService, 'peek' | 'markClean'> | undefined,
): Promise<void> {
  const pending = recovery?.peek();
  if (!pending?.sessionId || !pending.projectPath) return;
  const state = runtime.getState(false);
  if (state.project?.path !== pending.projectPath) return;
  if (state.sessionId !== pending.sessionId) {
    try {
      await runtime.switchSession(pending.sessionId);
    } catch {
      // Keep the dirty snapshot so a later successful open can retry the session restore.
      return;
    }
  }
  await recovery?.markClean();
}

export function registerIpc({ runtime, projects, files, git, settings, terminal, logs, music, speech, hotkey, updates, recovery, browser, automations, attestations, newWindow, rendererPolicy }: IpcServices) {
  runtime.setEventSink((events) => {
    try { recovery?.remember(runtime.getState(false)); } catch { /* Snapshot failures must never drop live events. */ }
    let batch: unknown;
    try {
      batch = piEventBatchSchema.parse(events);
    } catch (error) {
      // A batch that fails transport validation must never crash the main
      // process. Tell the renderer to resynchronize and keep running.
      logs.write('error', 'ipc', `A runtime event batch failed transport validation and was dropped: ${error instanceof Error ? error.message : String(error)}`);
      try {
        batch = piEventBatchSchema.parse([{
          type: 'error',
          error: { code: 'PI_RUNTIME_ERROR', message: 'A runtime update failed internal validation and was dropped. Refresh the session to resynchronize.', retryable: true },
          timestamp: Date.now(),
        }]);
      } catch {
        return;
      }
    }
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(ipcChannels.runtimeEvents, batch);
  });
  let pendingGoalEvents: GoalMaxEvent[] = [];
  let goalEventTimer: ReturnType<typeof setTimeout> | null = null;
  const flushGoalEvents = () => {
    if (goalEventTimer) clearTimeout(goalEventTimer);
    goalEventTimer = null;
    if (pendingGoalEvents.length === 0) return;
    let batch: unknown;
    try {
      batch = goalMaxEventBatchSchema.parse(pendingGoalEvents.splice(0, 50));
    } catch (error) {
      logs.write('error', 'ipc', `A goal event batch failed transport validation and was dropped: ${error instanceof Error ? error.message : String(error)}`);
      batch = null;
    }
    if (batch !== null) {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send(ipcChannels.runtimeGoalMaxEvents, batch);
    }
    if (pendingGoalEvents.length > 0) {
      goalEventTimer = setTimeout(flushGoalEvents, 0);
      goalEventTimer.unref?.();
    }
  };
  runtime.setGoalEventSink((event) => {
    pendingGoalEvents.push(event);
    if (pendingGoalEvents.length >= 50) flushGoalEvents();
    else if (!goalEventTimer) {
      goalEventTimer = setTimeout(flushGoalEvents, 16);
      goalEventTimer.unref?.();
    }
  });
  let pendingTaskEvents: TaskEvent[] = [];
  let taskEventTimer: ReturnType<typeof setTimeout> | null = null;
  const flushTaskEvents = () => {
    if (taskEventTimer) clearTimeout(taskEventTimer);
    taskEventTimer = null;
    if (pendingTaskEvents.length === 0) return;
    let taskBatch: unknown;
    try {
      taskBatch = taskEventBatchSchema.parse(pendingTaskEvents.splice(0, 50));
    } catch (error) {
      logs.write('error', 'ipc', `A task event batch failed transport validation and was dropped: ${error instanceof Error ? error.message : String(error)}`);
      taskBatch = null;
    }
    if (taskBatch !== null) {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send(ipcChannels.runtimeTaskEvents, taskBatch);
    }
    if (pendingTaskEvents.length > 0) {
      taskEventTimer = setTimeout(flushTaskEvents, 0);
      taskEventTimer.unref?.();
    }
  };
  runtime.setTaskEventSink((event) => {
    pendingTaskEvents.push(event);
    if (pendingTaskEvents.length >= 50) flushTaskEvents();
    else if (!taskEventTimer) {
      taskEventTimer = setTimeout(flushTaskEvents, 16);
      taskEventTimer.unref?.();
    }
  });
  terminal.setEventSink((ownerId, event) => {
    const owner = webContents.fromId(ownerId);
    if (owner && !owner.isDestroyed()) owner.send(ipcChannels.terminalEvents, terminalEventSchema.parse(event));
  });
  speech.setEventSink((progress) => {
    const payload = speechDownloadProgressSchema.parse(progress);
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(ipcChannels.speechEvents, payload);
  });
  speech.setStreamSink((update) => {
    const payload = speechStreamUpdateSchema.parse(update);
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(ipcChannels.speechStreamEvents, payload);
  });
  music.setDurationSink((updates) => {
    const payload = musicDurationsEventSchema.parse({ updates });
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(ipcChannels.musicDurations, payload);
  });

  const handle = (channel: string, handler: (event: Electron.IpcMainInvokeEvent, input: unknown) => unknown | Promise<unknown>) => register(channel, rendererPolicy, handler);
  const activationServices = { runtime, files, settings, terminal, logs, browser };
  const queueProjectActivation = createProjectActivationQueue();
  const openProjectPath = createProjectPathOpener(projects, activationServices, queueProjectActivation);
  const focusProjectPath = createProjectPathFocuser(projects, activationServices, queueProjectActivation);
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
  handle(ipcChannels.windowNew, () => {
    newWindow?.();
    return null;
  });
  const activeBrowser = async (event: Electron.IpcMainInvokeEvent) => browser.ensure(ownerWindow(event));
  const activeBrowserTab = async (event: Electron.IpcMainInvokeEvent) => {
    const service = await activeBrowser(event);
    const tabId = service.getState().activeTabId;
    if (!tabId) throw new PiDesktopError({ code: 'RUNTIME_NOT_READY', message: 'The built-in browser has no active tab.', retryable: true });
    return { service, tabId };
  };
  handle(ipcChannels.browserInitialize, async (event, input) => {
    emptyInputSchema.parse(input);
    return browserStateSchema.parse((await activeBrowser(event)).getState());
  });
  handle(ipcChannels.browserGetState, async (event, input) => {
    emptyInputSchema.parse(input);
    return browserStateSchema.parse((await activeBrowser(event)).getState());
  });
  handle(ipcChannels.browserSetBounds, async (event, input) => {
    const bounds = browserBoundsSchema.parse(input);
    const service = await activeBrowser(event);
    service.setBounds(bounds);
    return browserStateSchema.parse(service.getState());
  });
  handle(ipcChannels.browserSetVisible, async (event, input) => {
    const { visible } = browserVisibilityInputSchema.parse(input);
    const service = await activeBrowser(event);
    service.setVisible(visible);
    return browserStateSchema.parse(service.getState());
  });
  handle(ipcChannels.browserSetOverlay, async (event, input) => {
    const { blocked } = browserOverlayInputSchema.parse(input);
    const owner = ownerWindow(event);
    const service = await activeBrowser(event);
    browser.setAppOverlay(owner, blocked);
    return browserStateSchema.parse(service.getState());
  });
  handle(ipcChannels.browserNavigate, async (event, input) => {
    const { url } = browserNavigateInputSchema.parse(input);
    const { service, tabId } = await activeBrowserTab(event);
    await service.navigate(tabId, url, 'user');
    return browserStateSchema.parse(service.getState());
  });
  handle(ipcChannels.browserShowLinkContextMenu, (event, input) => {
    const { url } = browserLinkContextMenuInputSchema.parse(input);
    const owner = ownerWindow(event);
    Menu.buildFromTemplate([
      {
        label: 'Open in Browser workspace',
        click: () => {
          if (!owner.isDestroyed()) owner.webContents.send(ipcChannels.browserOpenLink, url);
        },
      },
      {
        label: 'Open in external browser',
        click: () => { void shell.openExternal(url).catch(() => undefined); },
      },
      { type: 'separator' },
      { label: 'Copy link', click: () => clipboard.writeText(url) },
    ]).popup({ window: owner });
    return browserLinkContextMenuResultSchema.parse({ shown: true });
  });
  handle(ipcChannels.browserOpenLocalFile, async (event, input) => {
    emptyInputSchema.parse(input);
    const owner = ownerWindow(event);
    const { service, tabId } = await activeBrowserTab(event);
    const projectPath = runtime.getState(false).project?.path;
    const result = await dialog.showOpenDialog(owner, {
      title: 'Open local page',
      ...(projectPath ? { defaultPath: projectPath } : {}),
      properties: ['openFile'],
      filters: [
        { name: 'Web pages', extensions: ['html', 'htm', 'xhtml', 'svg'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) return browserStateSchema.nullable().parse(null);
    await service.navigate(tabId, result.filePaths[0], 'user');
    return browserStateSchema.nullable().parse(service.getState());
  });
  handle(ipcChannels.browserNewTab, async (event, input) => {
    const { initialUrl } = browserNewTabInputSchema.parse(input);
    const service = await activeBrowser(event);
    await service.createUserTab(initialUrl ?? 'about:blank');
    return browserStateSchema.parse(service.getState());
  });
  handle(ipcChannels.browserActivateTab, async (event, input) => {
    const { tabId } = browserTabIdInputSchema.parse(input);
    const service = await activeBrowser(event);
    service.activateTab(tabId);
    return browserStateSchema.parse(service.getState());
  });
  handle(ipcChannels.browserCloseTab, async (event, input) => {
    const { tabId } = browserTabIdInputSchema.parse(input);
    const service = await activeBrowser(event);
    await service.closeTab(tabId);
    return browserStateSchema.parse(service.getState());
  });
  handle(ipcChannels.browserHistory, async (event, input) => {
    const { action } = browserHistoryInputSchema.parse(input);
    const { service, tabId } = await activeBrowserTab(event);
    if (action === 'back') service.back(tabId);
    else if (action === 'forward') service.forward(tabId);
    else if (action === 'reload') service.reload(tabId);
    else service.stop(tabId);
    return browserStateSchema.parse(service.getState());
  });
  handle(ipcChannels.browserSetMode, async (event, input) => {
    const { mode } = browserUiModeInputSchema.parse(input);
    const service = await activeBrowser(event);
    service.setMode(mode);
    return browserStateSchema.parse(service.getState());
  });
  handle(ipcChannels.browserSetControlLevel, async (event, input) => {
    const { level } = browserControlLevelInputSchema.parse(input);
    const service = await activeBrowser(event);
    service.setControlLevel(level);
    return browserStateSchema.parse(service.getState());
  });
  handle(ipcChannels.browserSetGrant, async (event, input) => {
    const grant = browserOriginGrantSchema.parse(input);
    const service = await activeBrowser(event);
    service.setOriginGrant(grant);
    return browserStateSchema.parse(service.getState());
  });
  handle(ipcChannels.browserRevokeGrant, async (event, input) => {
    const { origin } = browserOriginInputSchema.parse(input);
    const service = await activeBrowser(event);
    service.revokeOriginGrant(origin);
    return browserStateSchema.parse(service.getState());
  });
  handle(ipcChannels.browserSnapshot, async (event, input) => {
    const snapshotInput = browserSnapshotInputSchema.parse(input);
    const { service, tabId } = await activeBrowserTab(event);
    return semanticPageSnapshotSchema.parse(await service.snapshot(tabId, {
      mode: snapshotInput.mode,
      ...(snapshotInput.scopeRef ? { scopeRef: snapshotInput.scopeRef } : {}),
      ...(snapshotInput.query ? { query: snapshotInput.query } : {}),
    }));
  });
  handle(ipcChannels.browserSelectAnnotation, async (event, input) => {
    const annotation = browserAnnotationCreateInputSchema.parse(input);
    const { service, tabId } = await activeBrowserTab(event);
    return browserAnnotationSchema.parse(annotation.kind === 'element'
      ? await service.selectElementAnnotation(tabId, annotation.comment)
      : await service.selectRegionAnnotation(tabId, annotation.comment));
  });
  handle(ipcChannels.browserListAnnotations, async (event, input) => {
    emptyInputSchema.parse(input);
    const { service, tabId } = await activeBrowserTab(event);
    return browserAnnotationListSchema.parse(service.listAnnotations(tabId));
  });
  handle(ipcChannels.browserUpdateAnnotation, async (event, input) => {
    const update = browserAnnotationUpdateInputSchema.parse(input);
    const service = await activeBrowser(event);
    const annotation = service.updateAnnotationComment(update.id, update.comment);
    if (!annotation) throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'That browser annotation no longer exists.', retryable: true });
    return browserAnnotationSchema.parse(annotation);
  });
  handle(ipcChannels.browserRemoveAnnotation, async (event, input) => {
    const { id } = browserAnnotationRemoveInputSchema.parse(input);
    const service = await activeBrowser(event);
    return browserOperationResultSchema.parse({ ok: service.removeAnnotation(id) });
  });
  handle(ipcChannels.browserDismissAnnotations, async (event, input) => {
    const { ids } = browserAnnotationDismissInputSchema.parse(input);
    const service = await activeBrowser(event);
    await service.dismissAnnotationOverlays(ids);
    return browserOperationResultSchema.parse({ ok: true });
  });
  handle(ipcChannels.browserHighlightAnnotation, async (event, input) => {
    const { id } = browserAnnotationRemoveInputSchema.parse(input);
    const service = await activeBrowser(event);
    return browserOperationResultSchema.parse({ ok: await service.highlightAnnotation(id) });
  });
  handle(ipcChannels.browserRespondConfirmation, (event, input) => {
    const response = browserConfirmationResponseSchema.parse(input);
    const ok = browser.respondToConfirmation(ownerWindow(event), response.id, response.approved);
    return browserOperationResultSchema.parse({ ok });
  });
  const activeAutomationProject = (trusted = false) => {
    const project = runtime.getState(false).project;
    if (!project) throw new PiDesktopError({ code: 'RUNTIME_NOT_READY', message: 'Open a project before managing automations.', retryable: true });
    if (trusted && !project.trusted) throw new PiDesktopError({ code: 'PROJECT_NOT_TRUSTED', message: 'Trust the active project before opening an automation session.', retryable: false });
    return project.path;
  };
  handle(ipcChannels.automationsList, async (_event, input) => {
    emptyInputSchema.parse(input);
    return automationListSchema.parse(await automations.list(activeAutomationProject()));
  });
  handle(ipcChannels.automationsCreate, async (_event, input) => (
    automationDefinitionSchema.parse(await automations.create(activeAutomationProject(), automationCreateInputSchema.parse(input)))
  ));
  handle(ipcChannels.automationsUpdate, async (_event, input) => (
    automationDefinitionSchema.parse(await automations.update(activeAutomationProject(), automationUpdateInputSchema.parse(input)))
  ));
  handle(ipcChannels.automationsDelete, async (_event, input) => {
    const { id } = automationIdInputSchema.parse(input);
    await automations.remove(activeAutomationProject(), id);
    return automationDeleteResultSchema.parse({ deleted: true });
  });
  handle(ipcChannels.automationsRecordLaunch, async (_event, input) => {
    const { id, outcome } = automationLaunchRecordInputSchema.parse(input);
    return automationDefinitionSchema.parse(await automations.recordLaunch(activeAutomationProject(), id, outcome));
  });
  handle(ipcChannels.automationsPrepareSession, async (_event, input) => {
    const { id } = automationIdInputSchema.parse(input);
    const projectPath = activeAutomationProject(true);
    const automation = (await automations.list(projectPath)).find((candidate) => candidate.id === id);
    if (!automation) throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'That automation no longer exists in this project.', retryable: true });
    try {
      const state = await runtime.prepareAutomationSession(automation.name, automation.permissionLevel);
      const launched = await automations.recordLaunch(projectPath, id, 'accepted').catch(() => automation);
      return automationSessionPreparationResultSchema.parse({ state, automation: launched });
    } catch (error) {
      await automations.recordLaunch(projectPath, id, 'failed').catch(() => undefined);
      throw error;
    }
  });
  handle(ipcChannels.projectSelect, async (event, input) => {
    emptyInputSchema.parse(input);
    return queueProjectActivation.run(async () => {
      const activation = await projects.prepareSelect(BrowserWindow.fromWebContents(event.sender) ?? undefined);
      if (!activation) return runtimeStateSchema.parse(runtime.getState());
      await activatePreparedProject(activation, activationServices, 'changing projects');
      await applyPendingRecovery(runtime, recovery);
      return runtimeStateSchema.parse(runtime.getState());
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
  handle(ipcChannels.projectRevealPath, async (_event, input) => {
    const parsed = projectPathInputSchema.parse(input);
    return revealProjectResultSchema.parse(await projects.revealPath(parsed.projectPath));
  });
  handle(ipcChannels.projectOpenPath, async (event, input) => {
    const parsed = projectPathInputSchema.parse(input);
    await openProjectPath(parsed.projectPath, BrowserWindow.fromWebContents(event.sender) ?? undefined);
    await applyPendingRecovery(runtime, recovery);
    return runtimeStateSchema.parse(runtime.getState());
  });
  handle(ipcChannels.projectFocusPath, async (event, input) => {
    const parsed = projectPathInputSchema.parse(input);
    return runtimeStateSchema.parse(await focusProjectPath(parsed.projectPath, BrowserWindow.fromWebContents(event.sender) ?? undefined));
  });
  handle(ipcChannels.projectCloseRuntime, async (_event, input) => {
    const parsed = projectPathInputSchema.parse(input);
    const canonicalPath = await projects.prepareSessionListPath(parsed.projectPath);
    if (runtime.getState(false).project?.path === canonicalPath) {
      throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'The active project cannot be forgotten.', retryable: false });
    }
    const closeProjectPath = (runtime as unknown as { closeProjectPath?: (projectPath: string) => Promise<void> }).closeProjectPath;
    if (!closeProjectPath) throw new PiDesktopError({ code: 'RUNTIME_NOT_READY', message: 'Project runtime cleanup is unavailable.', retryable: true });
    await runRuntimeMutation('forgetting this project', () => closeProjectPath(canonicalPath));
  });
  handle(ipcChannels.projectListSessions, async (_event, input) => {
    const parsed = projectSessionListInputSchema.parse(input);
    const canonicalPath = await projects.prepareSessionListPath(parsed.projectPath);
    return sessionListSchema.parse(await runtime.listSessionsForPath(canonicalPath, parsed.query));
  });
  handle(ipcChannels.projectDeleteSessions, async (_event, input) => {
    const parsed = projectPathInputSchema.parse(input);
    const canonicalPath = await projects.prepareSessionListPath(parsed.projectPath);
    return projectDeleteSessionsResultSchema.parse(await runtime.deleteSessionsForPath(canonicalPath));
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
    const parsed = promptInputSchema.parse(input);
    const sessionReferences = parsed.sessionReferences
      ? await Promise.all(parsed.sessionReferences.map(async (reference) => ({
        ...reference,
        projectPath: await projects.prepareSessionListPath(reference.projectPath),
      })))
      : undefined;
    const accepted = await runtime.prompt({ ...parsed, ...(sessionReferences ? { sessionReferences } : {}) });
    return promptAcceptanceSchema.parse(accepted);
  }));
  handle(ipcChannels.runtimeOptimizePrompt, async (_event, input) => runRuntimeMutation('improving a prompt', async () => {
    const parsed = promptOptimizationInputSchema.parse(input);
    return promptOptimizationResultSchema.parse(await runtime.optimizePrompt(parsed.text, parsed.advanced));
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
    return runRuntimeMutation('changing permissions', async () => {
      const state = await runtime.setPermissionLevel(parsed.level);
      // Browser authority follows the selected session immediately; the host
      // emits a browser-state update when this changes.
      browser.current();
      return runtimeStateSchema.parse(state);
    });
  });
  handle(ipcChannels.runtimeProviderLoginInitialize, async (_event, input) => {
    emptyInputSchema.parse(input);
    return runRuntimeMutation('loading provider sign-in options', async () => runtimeStateSchema.parse(await runtime.initializeProviderLogin()));
  });
  handle(ipcChannels.runtimeProviderLoginStart, async (_event, input) => runRuntimeMutation('starting provider sign-in', async () => (
    runtimeStateSchema.parse(await runtime.startProviderLogin(providerLoginStartInputSchema.parse(input)))
  )));
  handle(ipcChannels.runtimeProviderLoginRespond, async (_event, input) => runRuntimeMutation('continuing provider sign-in', () => (
    runtimeStateSchema.parse(runtime.respondProviderLogin(providerLoginRespondInputSchema.parse(input)))
  )));
  handle(ipcChannels.runtimeProviderLoginCancel, async (_event, input) => {
    emptyInputSchema.parse(input);
    return runRuntimeMutation('cancelling provider sign-in', () => runtimeStateSchema.parse(runtime.cancelProviderLogin()));
  });
  handle(ipcChannels.runtimeProviderLogout, async (_event, input) => runRuntimeMutation('signing out of a provider', async () => (
    runtimeStateSchema.parse(await runtime.logoutProvider(providerLogoutInputSchema.parse(input).providerId))
  )));
  handle(ipcChannels.modelsDevList, async (_event, input) => {
    emptyInputSchema.parse(input);
    return runRuntimeMutation('loading the models.dev provider catalog', async () => (
      modelsDevListResultSchema.parse(await runtime.listModelsDevProviders())
    ));
  });
  handle(ipcChannels.modelsDevDetail, async (_event, input) => runRuntimeMutation('loading a models.dev provider', async () => (
    modelsDevProviderDetailSchema.parse(await runtime.getModelsDevProvider(modelsDevRemoveInputSchema.parse(input).providerId))
  )));
  handle(ipcChannels.modelsDevAdd, async (_event, input) => runRuntimeMutation('adding a provider', async () => (
    modelsDevMutationResultSchema.parse(await runtime.addModelsDevProvider(modelsDevAddInputSchema.parse(input)))
  )));
  handle(ipcChannels.modelsDevRemove, async (_event, input) => runRuntimeMutation('removing a provider', async () => (
    modelsDevMutationResultSchema.parse(await runtime.removeModelsDevProvider(modelsDevRemoveInputSchema.parse(input).providerId))
  )));
  handle(ipcChannels.runtimeMutateQueue, async (_event, input) => runRuntimeMutation('editing queued messages', async () => (
    queueMutationResultSchema.parse(await runtime.mutateQueuedMessage(queueMutationInputSchema.parse(input)))
  )));
  handle(ipcChannels.runtimeGoalMaxGet, async (_event, input) => {
    emptyInputSchema.parse(input);
    const goal = await runtime.getGoalMax();
    return goal === null ? null : goalMaxStateSchema.parse(goal);
  });
  handle(ipcChannels.runtimeGoalMaxCreate, async (_event, input) => runRuntimeMutation('creating a goal', async () => (
    goalMaxStateSchema.parse(await runtime.createGoalMax(goalMaxCreateInputSchema.parse(input)))
  )));
  handle(ipcChannels.runtimeGoalMaxControl, async (_event, input) => runRuntimeMutation('controlling a goal', async () => (
    goalMaxStateSchema.parse(await runtime.controlGoalMax(goalMaxControlInputSchema.parse(input)))
  )));
  handle(ipcChannels.runtimeGoalMaxUpdate, async (_event, input) => runRuntimeMutation('editing a goal', async () => (
    goalMaxStateSchema.parse(await runtime.updateGoalMax(goalMaxUpdateInputSchema.parse(input)))
  )));
  handle(ipcChannels.runtimeGoalMaxClear, async (_event, input) => runRuntimeMutation('clearing a goal', async () => {
    emptyInputSchema.parse(input);
    return goalMaxClearResultSchema.parse(await runtime.clearGoalMax());
  }));
  handle(ipcChannels.runtimeGoalMaxSteeringEdit, async (_event, input) => runRuntimeMutation('editing a goal update', async () => (
    goalMaxStateSchema.parse(await runtime.editGoalMaxSteering(goalMaxSteeringEditInputSchema.parse(input)))
  )));
  handle(ipcChannels.runtimeGoalMaxSteeringRemove, async (_event, input) => runRuntimeMutation('removing a goal update', async () => (
    goalMaxStateSchema.parse(await runtime.removeGoalMaxSteering(goalMaxSteeringRemoveInputSchema.parse(input)))
  )));
  handle(ipcChannels.runtimeTaskGet, async (_event, input) => {
    emptyInputSchema.parse(input);
    const list = await runtime.getTaskList();
    return list === null ? null : taskListSchema.parse(list);
  });
  handle(ipcChannels.runtimeTaskCreate, async (_event, input) => runRuntimeMutation('creating a task', async () => (
    taskListSchema.parse(await runtime.createTask(taskCreateInputSchema.parse(input)))
  )));
  handle(ipcChannels.runtimeTaskUpdate, async (_event, input) => runRuntimeMutation('updating a task', async () => (
    taskListSchema.parse(await runtime.updateTask(taskUpdateInputSchema.parse(input)))
  )));
  handle(ipcChannels.runtimeTaskReorder, async (_event, input) => runRuntimeMutation('reordering tasks', async () => (
    taskListSchema.parse(await runtime.reorderTasks(taskReorderInputSchema.parse(input)))
  )));
  handle(ipcChannels.runtimeTaskDelete, async (_event, input) => runRuntimeMutation('deleting a task', async () => (
    taskListSchema.parse(await runtime.deleteTask(taskDeleteInputSchema.parse(input)))
  )));
  handle(ipcChannels.runtimeTaskClear, async (_event, input) => runRuntimeMutation('clearing tasks', async () => {
    emptyInputSchema.parse(input);
    return taskListSchema.parse(await runtime.clearTasks());
  }));
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
  handle(ipcChannels.runtimeSendSessionMessage, async (_event, input) => {
    const parsed = sessionDirectMessageInputSchema.parse(input);
    return runRuntimeMutation('sending a direct session message', async () => runtimeStateSchema.parse(await runtime.sendSessionMessage(parsed.sessionId, parsed.text, parsed.behavior)));
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
  handle(ipcChannels.runtimeNavigateSessionBranch, async (_event, input) => {
    const parsed = sessionEntryInputSchema.parse(input);
    return runRuntimeMutation('switching conversation paths', async () => navigateSessionBranchResultSchema.parse(await runtime.navigateSessionBranch(parsed.entryId)));
  });
  handle(ipcChannels.runtimeDeleteSessionBranch, async (_event, input) => {
    const parsed = sessionEntryInputSchema.parse(input);
    return runRuntimeMutation('deleting a conversation path', async () => deleteSessionBranchResultSchema.parse(await runtime.deleteSessionBranch(parsed.entryId)));
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
  handle(ipcChannels.gitRevertPath, async (_event, input) => queueProjectActivation.runSerializedMutation(async () => {
    const parsed = gitRevertPathInputSchema.parse(input);
    return gitRevertPathResultSchema.parse({ path: parsed.path, status: await git.revertPath(parsed.path) });
  }));
  handle(ipcChannels.recoveryConsume, async (_event, input) => {
    emptyInputSchema.parse(input);
    await applyPendingRecovery(runtime, recovery);
    return recoveryNoticeResultSchema.parse(recovery ? recovery.consume() : null);
  });
  handle(ipcChannels.sessionExport, async (event, input) => {
    emptyInputSchema.parse(input);
    const state = runtime.getState();
    if (!state.sessionId) {
      throw new PiDesktopError({ code: 'RUNTIME_NOT_READY', message: 'Open a session before exporting it.', retryable: true });
    }
    const title = state.sessions?.find((session) => session.id === state.sessionId)?.title ?? state.sessionId;
    const artifact = buildSessionExport({
      sessionId: state.sessionId,
      title,
      projectPath: state.project?.path ?? null,
      model: state.model ? `${state.model.provider}/${state.model.id}` : null,
      permissionLevel: state.permissionLevel ?? null,
      messages: state.messages.map((message) => ({ role: message.role, text: message.text })),
      tools: (state.tools ?? []).map((tool) => ({ name: tool.name, status: tool.status, output: tool.output })),
      error: state.error?.message ?? null,
    });
    const result = await dialog.showSaveDialog(ownerWindow(event), {
      title: 'Export session',
      defaultPath: `session-${state.sessionId}.md`,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'JSON', extensions: ['json'] },
      ],
    });
    if (result.canceled || !result.filePath) return sessionExportResultSchema.parse({ saved: false });
    const markdown = result.filePath.toLocaleLowerCase().endsWith('.json') ? false : true;
    await fs.writeFile(result.filePath, markdown ? artifact.markdown : artifact.json, 'utf8');
    return sessionExportResultSchema.parse({ saved: true, path: result.filePath });
  });
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
    await hotkey.applySpeechSettings(saved.speech);
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
  handle(ipcChannels.updatesDownloadInstall, async (_event, input) => {
    const version = updateVersionInputSchema.parse(input).version;
    await updates.downloadAndInstall(version);
    return updateInstallStartedSchema.parse({ installing: true });
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
  handle(ipcChannels.speechStreamStart, async (_event, input) => {
    const { modelId, language, refine } = speechStreamStartInputSchema.parse(input);
    await speech.streamStart(modelId, language, refine);
  });
  handle(ipcChannels.speechStreamFeed, async (_event, input) => {
    const { audio } = speechStreamFeedInputSchema.parse(input);
    await speech.streamFeed(audio);
  });
  handle(ipcChannels.speechStreamStop, async (_event, input) => {
    emptyInputSchema.parse(input);
    await speech.streamStop();
    hotkey.resetActive();
  });
  handle(ipcChannels.speechStreamCancel, async (_event, input) => {
    emptyInputSchema.parse(input);
    await speech.streamCancel();
    hotkey.resetActive();
  });
  handle(ipcChannels.speechHotkeyStatus, (_event, input) => {
    emptyInputSchema.parse(input);
    return speechHotkeyStatusSchema.parse(hotkey.getStatus());
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
  handle(ipcChannels.attestationsQuery, async (_event, input) => {
    const request = attestationQueryRequestSchema.parse(input);
    return attestationQueryResultSchema.parse(await resolveAttestationQuery(runtime, attestations, request));
  });

  const openRecoveredProjectPath = async (projectPath: string, owner?: BrowserWindow) => {
    await openProjectPath(projectPath, owner);
    await applyPendingRecovery(runtime, recovery);
    return runtime.getState();
  };
  return { openProjectPath: openRecoveredProjectPath, focusProjectPath };
}
