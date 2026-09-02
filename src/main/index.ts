import { app, BrowserWindow, dialog, protocol, session, shell, systemPreferences } from 'electron';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { runProductionSmoke } from './bootstrap/productionSmoke';
import { RecoverySnapshotService } from './bootstrap/RecoverySnapshot';
import { ShutdownCoordinator } from './bootstrap/shutdown';
import { BrowserHistoryRepository } from './browser/BrowserHistoryRepository';
import { BrowserHost } from './browser/BrowserHost';
import { LOCAL_PAGE_SCHEME } from './browser/LocalPageRegistry';
import { FilesystemService } from './files/FilesystemService';
import { GitService } from './git/GitService';
import { registerIpc } from './ipc/registerIpc';
import { parseLaunchProjectPath, hasNewInstanceFlag } from './launchProject';
import { acquireInstanceProfile } from './instanceProfile';
import { AppLogService } from './logging/AppLogService';
import { CrashTelemetryService } from './logging/CrashTelemetry';
import { AutomationRepository } from './automations/AutomationRepository';
import { MEDIA_SCHEME, MusicService, PublicHttpsProxy } from './music/MusicService';
import { BrowserRuntimeBridge } from './pi/BrowserRuntimeBridge';
import { MultiProjectPiRuntime } from './pi/MultiProjectPiRuntime';
import { PiRuntimeService } from './pi/PiRuntimeService';
import { prepareFateProviderStorage } from './pi/FateProviderStorage';
import { SessionPermissionStore } from './pi/SessionPermissionStore';
import { GoalMaxRepository } from './pi/goalmaxxing/GoalMaxRepository';
import { MutationAttestationLedger } from './pi/provenance/MutationAttestationLedger';
import { createMutationRecorder } from './pi/provenance/mutationRecorder';
import { ProjectService } from './projects/ProjectService';
import { createTrustedRendererPolicy, isTrustedAudioPermissionRequest } from './security/trustedRenderer';
import { SettingsService } from './settings/SettingsService';
import { SpeechService } from './speech/SpeechService';
import { configurePackagedSpeechLibrary } from './speech/packagedSpeechLibrary';
import { GlobalHotkeyService } from './speech/GlobalHotkeyService';
import { smokeTerminalRuntime, TerminalService } from './terminal/TerminalService';
import { UpdateService } from './updates/UpdateService';
import { createProductionUpdateInstallerAdapters, createUpdateInstaller } from './updates/installDownloadedUpdate';
import { runUpdaterSmoke } from './updates/updaterSmoke';
import { WindowStateService } from './windowState';
import { LaunchDispatcher } from './windows/launchDispatcher';
import { createAppWindowFactory, rememberWindowPlacement } from './windows/appWindows';
import { appCommandSchema, ipcChannels } from '../shared/contracts/ipc';
import { browserEventBatchSchema } from '../shared/contracts/browser';
import { enabledModelIdentity } from '../shared/modelVisibility';

protocol.registerSchemesAsPrivileged([{
  scheme: LOCAL_PAGE_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}, {
  // Streams prefetched music bytes from the main-process cache to the player.
  // It must be privileged so <audio> can stream and range-seek it directly
  // without routing through the network stack or the renderer proxy.
  scheme: MEDIA_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const developmentUrl = process.env.VITE_DEV_SERVER_URL;

let initialProjectPath: string | null = null;
let initialLaunchError: unknown = null;
try {
  initialProjectPath = parseLaunchProjectPath(process.argv, process.cwd());
} catch (error) {
  initialLaunchError = error;
}
// Fate UI is single-instance by default: a later `fate <folder>` launch hands
// its project path to the already-running app and exits. Set FATE_NEW_INSTANCE=1
// (or pass --new-instance) for a fully isolated second process with its own
// persistent Chromium profile slot. Pi sessions stay shared; Fate UI provider
// credentials and model configuration stay in its own SDK-owned store.
const newInstanceRequested = process.env.FATE_NEW_INSTANCE === '1' || hasNewInstanceFlag(process.argv);
const instanceProfile = acquireInstanceProfile(app, newInstanceRequested ? 'multi' : 'single');
// True for the running app (the primary single-instance lock holder, or any
// multi-instance process). A secondary single-instance launch is false and must
// never create a window — its project path was forwarded to the primary.
const instancePrimaryApp = instanceProfile.isPrimary;
if (instanceProfile.mode === 'single' && !instanceProfile.isPrimary) {
  // Another Fate UI already holds the primary lock; this process's --project
  // was forwarded to it through Electron's second-instance event. Exit now.
  app.quit();
}

configurePackagedSpeechLibrary({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  platform: process.platform,
  ...(process.env.TRANSCRIBE_LIBRARY ? { transcribeLibraryEnv: process.env.TRANSCRIBE_LIBRARY } : {}),
  exists: existsSync,
  readDir: (directoryPath) => readdirSync(directoryPath),
  setEnv: (value) => { process.env.TRANSCRIBE_LIBRARY = value; },
});

const logs = new AppLogService();
const recovery = new RecoverySnapshotService(RecoverySnapshotService.defaultFilePath(instanceProfile.slot));
const settings = new SettingsService(logs);
const crashTelemetry = new CrashTelemetryService(
  path.join(process.env.FATE_GUI_DATA_DIR ? path.resolve(process.env.FATE_GUI_DATA_DIR) : path.join(os.homedir(), '.pi', 'fateGUI'), 'crash-reports'),
  () => settings.get().crashTelemetryEnabled === true,
  () => app.getVersion(),
);
process.on('uncaughtException', (error) => {
  void crashTelemetry.record(error.stack ?? String(error)).catch(() => undefined);
});
process.on('unhandledRejection', (reason) => {
  const stack = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  void crashTelemetry.record(stack).catch(() => undefined);
});
app.on('render-process-gone', (_event, _contents, details) => {
  void crashTelemetry.record(`render-process-gone ${details.reason} ${details.exitCode}`).catch(() => undefined);
});
const automations = new AutomationRepository(logs);
let browserHost: BrowserHost | null = null;
const browserBridge = new BrowserRuntimeBridge(
  () => browserHost?.current() ?? null,
  async () => {
    const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ?? null;
    if (!browserHost || !owner) throw new Error('Open a Fate UI window before using browser tools.');
    const service = await browserHost.ensure(owner);
    service.setMode('agent');
    return service;
  },
);
const attestationLedger = new MutationAttestationLedger(logs, undefined, { instanceSlot: instanceProfile.slot });
const recordAttestation = createMutationRecorder(attestationLedger, logs);
const piRuntime = new MultiProjectPiRuntime({
  sessionPermissions: new SessionPermissionStore(logs),
  getImageGenerationSettings: () => settings.get().imageGeneration,
  getDisabledModels: () => settings.get().disabledModels ?? [],
  createGoalPersistence: () => new GoalMaxRepository(logs),
  browserIntegration: browserBridge,
  recordAttestation,
  notifySessionSettled: () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.isFocused()) window.flashFrame(true);
    }
  },
  defaults: async () => {
    const loaded = await settings.load();
    return {
      thinkingLevel: loaded.thinkingLevel,
      defaultModel: enabledModelIdentity(loaded.disabledModels, loaded.defaultModel),
      ...(loaded.agentTeamMode ? { agentTeamMode: loaded.agentTeamMode } : {}),
    };
  },
});
const runtime = piRuntime.asRouter();
const projects = new ProjectService();
const files = new FilesystemService();
const git = new GitService(files);
const updateInstaller = createUpdateInstaller(createProductionUpdateInstallerAdapters({
  quit: () => app.quit(),
  warn: (message) => logs.write('warn', 'updates', message),
}));
const updates = new UpdateService(path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'PRODVER'), {
  openExternal: (url) => shell.openExternal(url),
  downloadDir: app.getPath('temp'),
  reportProgress: (progress) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(ipcChannels.updatesProgress, progress);
    }
  },
  launchInstaller: (filePath, version) => updateInstaller.install(filePath, version),
});
const windowState = new WindowStateService(logs);
const music = new MusicService();
const rendererNetworkProxy = new PublicHttpsProxy();
const speech = new SpeechService(logs);
const emitVoiceHotkey = (action: 'start' | 'stop') => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(ipcChannels.voiceHotkey, { action, source: 'hotkey' });
  }
};
const hotkey = new GlobalHotkeyService(logs, () => emitVoiceHotkey('start'), () => emitVoiceHotkey('stop'));
const terminal = new TerminalService(files, runtime, settings, logs);

const rendererPath = path.join(currentDirectory, '../renderer/index.html');
const rendererPolicy = createTrustedRendererPolicy(rendererPath, developmentUrl);

// Fate UI supports more than one window in the same process. Every window
// shares one Pi runtime, and runtime events are broadcast to all of them, so
// two windows open on the same session stay in sync without a second process.
const dispatcher = new LaunchDispatcher<BrowserWindow>({
  isLive: (window) => !window.isDestroyed(),
  reportLaunchError,
  onLastWindowClosed: () => {
    void browserHost?.reset().catch((error: unknown) => {
      logs.write('warn', 'browser', `Browser shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  },
  onRestoreError: (error) => logs.write('warn', 'launcher', `The last project could not be restored: ${error instanceof Error ? error.message : String(error)}`),
});
dispatcher.setPendingProjectPath(initialProjectPath);

function consumeLaunchError(): unknown {
  const error = initialLaunchError;
  initialLaunchError = null;
  return error;
}

function reportLaunchError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  logs.write('error', 'launcher', `Could not open the requested project: ${message}`);
  const owner = dispatcher.activeHandle() ?? undefined;
  const options = {
    type: 'error' as const,
    title: 'Fate UI could not open this project',
    message: 'The requested project could not be opened.',
    detail: message,
    buttons: ['OK'],
  };
  void (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options));
}

const shutdown = new ShutdownCoordinator({
  onBeforeDispose: () => rememberWindowPlacement(dispatcher.activeHandle(), windowState),
  disposeSync: () => { terminal.dispose(); music.dispose(); rendererNetworkProxy.dispose(); },
  disposeAsync: () => [
    runtime.dispose().finally(() => attestationLedger.flush()).finally(() => recovery.markClean()),
    speech.dispose(),
    hotkey.dispose(),
    windowState.flush(),
    browserHost ? browserHost.reset() : Promise.resolve(),
  ],
  onError: (error) => logs.write('warn', 'app', `Application shutdown failed: ${error instanceof Error ? error.message : String(error)}`),
  onExit: () => app.exit(0),
});

function wireSmoke(window: BrowserWindow): void {
  window.webContents.once('did-finish-load', () => {
    void (async () => {
      const updaterSmokeDmg = process.env.FATE_UI_UPDATER_SMOKE;
      if (updaterSmokeDmg) {
        await runUpdaterSmoke({
          dmgPath: updaterSmokeDmg,
          installDir: process.env.FATE_UI_UPDATER_INSTALL_DIR ?? path.join(os.tmpdir(), 'fate-ui-updater-smoke'),
          log: (line) => console.log(line),
          error: (line) => console.error(line),
          exit: (code) => app.exit(code),
        });
      }
      await runProductionSmoke({
        speech,
        music,
        settings,
        smokeTerminalRuntime,
        cwd: process.cwd(),
        streamSmokeEnabled: process.env.PI_DESKTOP_SPEECH_STREAM_SMOKE === '1',
        now: () => performance.now(),
        log: (line) => console.log(line),
        error: (line) => console.error(line),
        quit: () => app.quit(),
        exit: (code) => app.exit(code),
      });
    })();
  });
}

const windows = createAppWindowFactory({
  logs,
  windowState,
  terminal,
  projects,
  dispatcher,
  reportLaunchError,
  consumeLaunchError,
  rendererPolicy,
  preloadPath: path.join(currentDirectory, '../preload/index.cjs'),
  rendererPath,
  ...(process.env.PI_DESKTOP_SMOKE === '1' ? { installSmoke: wireSmoke } : {}),
  ...(developmentUrl ? { developmentUrl } : {}),
});

// Register this before app readiness work begins. A second launch can arrive
// while the proxy, settings, or first window is still starting; the dispatcher
// keeps the latest project pending until the renderer can accept it.
if (instanceProfile.mode === 'single' && instancePrimaryApp) {
  app.on('second-instance', (_event, commandLine, workingDirectory) => {
    const window = dispatcher.activeHandle();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
    try {
      const forwardedProjectPath = parseLaunchProjectPath(commandLine, workingDirectory);
      if (forwardedProjectPath) dispatcher.dispatch(forwardedProjectPath);
    } catch (error) {
      reportLaunchError(error);
    }
  });
}

app.whenReady().then(async () => {
  if (!instancePrimaryApp) return;
  const providerStorage = await prepareFateProviderStorage();
  if (providerStorage.imported.length > 0) {
    logs.write('info', 'providers', `Imported Pi provider ${providerStorage.imported.join(' and ')} into Fate UI storage.`);
  }
  const proxyUrl = await rendererNetworkProxy.start();
  const browserHistory = new BrowserHistoryRepository();
  browserHost = new BrowserHost({
    currentProject: () => runtime.getState(false).project,
    currentPermissionLevel: () => runtime.getState(false).permissionLevel ?? 'full-access',
    bridge: browserBridge,
    history: browserHistory,
    emit: (owner, event) => {
      if (!owner.isDestroyed()) owner.webContents.send(ipcChannels.browserEvents, browserEventBatchSchema.parse([event]));
    },
    command: (owner, command) => {
      if (!owner.isDestroyed()) owner.webContents.send(ipcChannels.appCommand, appCommandSchema.parse(command));
    },
  });
  const developmentBypass = developmentUrl ? new URL(developmentUrl).host : null;
  session.defaultSession.protocol.handle(MEDIA_SCHEME, (request) => {
    const media = music.openMediaRequest(request.method, request.url, request.headers.get('range'));
    if (!('file' in media)) return new Response('Media unavailable', { status: media.status });
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Length': String(media.end - media.start + 1),
      'Content-Type': media.contentType,
      'X-Content-Type-Options': 'nosniff',
    });
    if (media.status === 206) headers.set('Content-Range', `bytes ${media.start}-${media.end}/${media.totalBytes}`);
    const body = media.headOnly
      ? null
      : Readable.toWeb(createReadStream(media.file, { start: media.start, end: media.end })) as ReadableStream<Uint8Array>;
    return new Response(body, { status: media.status, headers });
  });
  await session.defaultSession.setProxy({
    mode: 'fixed_servers',
    proxyRules: proxyUrl,
    // Chromium bypasses loopback implicitly. Remove that exception in packaged
    // builds so HTTPS redirects and DNS rebinding cannot reach local services;
    // development bypasses only Vite's exact host and port.
    proxyBypassRules: developmentBypass ? `<-loopback>,${developmentBypass}` : '<-loopback>',
  });
  await Promise.all([settings.load(), windowState.load()]);
  logs.write('info', 'app', `Fate UI ${app.getVersion()} started in instance slot ${instanceProfile.slot}.`);
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    callback(permission === 'media' && isTrustedAudioPermissionRequest(rendererPolicy, {
      documentUrl: webContents.getURL(),
      mediaTypes,
    }));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => (
    permission === 'media'
    && details.mediaType === 'audio'
    && isTrustedAudioPermissionRequest(rendererPolicy, {
      // Packaged pages report the broad `file://` origin; the exact WebContents URL is the security boundary.
      documentUrl: webContents?.getURL(),
      requestingOrigin,
      mediaTypes: ['audio'],
    })
  ));
  if (
    process.platform === 'darwin'
    && process.env.PI_DESKTOP_SMOKE !== '1'
    && systemPreferences.getMediaAccessStatus('microphone') === 'not-determined'
  ) {
    try {
      const granted = await systemPreferences.askForMediaAccess('microphone');
      if (!granted) logs.write('warn', 'microphone', 'Microphone permission was denied in macOS System Settings.');
    } catch (error) {
      logs.write('warn', 'microphone', `macOS microphone permission could not be requested: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await recovery.load();
  const mainCommands = registerIpc({ runtime, projects, files, git, settings, terminal, logs, music, speech, hotkey, updates, recovery, browser: browserHost, automations, attestations: attestationLedger, newWindow: () => windows.createWindow(), rendererPolicy });
  // Refresh every models.dev-managed provider's model list once per Fate GUI
  // start. Runs beside startup, never blocking it; offline keeps the cache.
  void runtime.refreshManagedModelsDevProviders().catch((error) => {
    logs.write('warn', 'providers', `models.dev catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  dispatcher.setOpener(mainCommands.openProjectPath);
  void hotkey.applySpeechSettings((await settings.load()).speech).then((status) => {
    if (!status.pushToTalkAvailable) logs.write('warn', 'speech', status.reason ?? 'Push-to-talk is unavailable on this platform.');
  });
  windows.installMenu();
  windows.createWindow({ initial: true });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) windows.createWindow({ initial: true });
  });
});

app.on('before-quit', (event) => {
  if (shutdown.requestShutdown()) event.preventDefault();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
