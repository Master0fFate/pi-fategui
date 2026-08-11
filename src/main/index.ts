import { app, BrowserWindow, dialog, Menu, protocol, screen, session, shell, systemPreferences } from 'electron';
import { existsSync, readdirSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FilesystemService } from './files/FilesystemService';
import { GitService } from './git/GitService';
import { registerIpc } from './ipc/registerIpc';
import { parseLaunchProjectPath, hasNewInstanceFlag } from './launchProject';
import { acquireInstanceProfile } from './instanceProfile';
import { AppLogService } from './logging/AppLogService';
import { AutomationRepository } from './automations/AutomationRepository';
import { MusicService, PublicHttpsProxy } from './music/MusicService';
import { BrowserHost } from './browser/BrowserHost';
import { BrowserHistoryRepository } from './browser/BrowserHistoryRepository';
import { LOCAL_PAGE_SCHEME } from './browser/LocalPageRegistry';
import { PiRuntimeService } from './pi/PiRuntimeService';
import { MultiProjectPiRuntime } from './pi/MultiProjectPiRuntime';
import { BrowserRuntimeBridge } from './pi/BrowserRuntimeBridge';
import { SessionPermissionStore } from './pi/SessionPermissionStore';
import { GoalMaxRepository } from './pi/goalmaxxing/GoalMaxRepository';
import { ProjectService } from './projects/ProjectService';
import { secureWebPreferences } from './security/windowOptions';
import { createTrustedRendererPolicy, isExternalHttpsUrl, isTrustedAudioPermissionRequest, isTrustedRendererUrl } from './security/trustedRenderer';
import { SettingsService } from './settings/SettingsService';
import { SpeechService } from './speech/SpeechService';
import { GlobalHotkeyService } from './speech/GlobalHotkeyService';
import { smokeTerminalRuntime, TerminalService } from './terminal/TerminalService';
import { UpdateService } from './updates/UpdateService';
import { MINIMUM_WINDOW_SIZE, WindowStateService, type WindowPlacement } from './windowState';
import { installWindowZoomShortcuts } from './windowZoom';
import { appCommandSchema, ipcChannels, windowStateSchema, type AppCommand } from '../shared/contracts/ipc';
import { browserEventBatchSchema } from '../shared/contracts/browser';

protocol.registerSchemesAsPrivileged([{
  scheme: LOCAL_PAGE_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

function configurePackagedSpeechLibrary(): void {
  if (!app.isPackaged || process.env.TRANSCRIBE_LIBRARY) return;
  const libraryName = process.platform === 'win32' ? 'transcribe.dll' : process.platform === 'darwin' ? 'libtranscribe.dylib' : 'libtranscribe.so';
  const providers = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@transcribe-cpp');
  if (!existsSync(providers)) return;
  const library = readdirSync(providers)
    .map((provider) => path.join(providers, provider, libraryName))
    .find((candidate) => existsSync(candidate));
  if (library) process.env.TRANSCRIBE_LIBRARY = library;
}

/** Opt-in packaged-runtime check for native Parakeet streaming. Six seconds of
 *  silence are sufficient to exercise the buffered window, worker-thread feed
 *  queue, finalize path, and CPU fallback without a microphone or Max model. */
async function smokeParakeetStream(): Promise<void> {
  await speech.download('balanced');
  await speech.streamStart('balanced', 'en');
  try {
    const feeds = Array.from({ length: 38 }, () => speech.streamFeed(new Float32Array(16_000 * 0.16).buffer));
    const stopping = speech.streamStop();
    await Promise.all([...feeds, stopping]);
  } catch (error) {
    await speech.streamCancel().catch(() => undefined);
    throw error;
  }
}

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
// Chromium profile and credentials.
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

configurePackagedSpeechLibrary();
const logs = new AppLogService();
const settings = new SettingsService(logs);
const automations = new AutomationRepository(logs);
let browserHost: BrowserHost | null = null;
const browserBridge = new BrowserRuntimeBridge(() => browserHost?.current() ?? null);
const piRuntime = new MultiProjectPiRuntime({
  sessionPermissions: new SessionPermissionStore(logs),
  getImageGenerationSettings: () => settings.get().imageGeneration,
  createGoalPersistence: () => new GoalMaxRepository(logs),
  browserIntegration: browserBridge,
  defaults: async () => {
    const loaded = await settings.load();
    return {
      thinkingLevel: loaded.thinkingLevel,
      defaultModel: loaded.defaultModel,
      ...(loaded.agentTeamMode ? { agentTeamMode: loaded.agentTeamMode } : {}),
    };
  },
});
const runtime = piRuntime.asRouter();
const projects = new ProjectService();
const files = new FilesystemService();
const git = new GitService(files);
const updates = new UpdateService(path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'PRODVER'), {
  openExternal: (url) => shell.openExternal(url),
  downloadDir: app.getPath('temp'),
  reportProgress: (progress) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(ipcChannels.updatesProgress, progress);
    }
  },
  launchInstaller: (filePath, version) => installDownloadedUpdate(filePath, version),
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
let mainWindow: BrowserWindow | null = null;
let rendererReady = false;
let quitReady = false;
let shutdown: Promise<void> | null = null;
let projectPathOpener: ((projectPath: string, owner?: BrowserWindow) => Promise<unknown>) | null = null;
let pendingProjectPath = initialProjectPath;
const rendererPath = path.join(currentDirectory, '../renderer/index.html');
const rendererPolicy = createTrustedRendererPolicy(rendererPath, process.env.VITE_DEV_SERVER_URL);

function sendCommand(command: AppCommand): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ipcChannels.appCommand, appCommandSchema.parse(command));
}

function reportLaunchError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  logs.write('error', 'launcher', `Could not open the requested project: ${message}`);
  const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const options = {
    type: 'error' as const,
    title: 'Fate UI could not open this project',
    message: 'The requested project could not be opened.',
    detail: message,
    buttons: ['OK'],
  };
  void (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options));
}

function dispatchProjectPath(projectPath: string): void {
  if (!projectPathOpener || !rendererReady || !mainWindow || mainWindow.isDestroyed()) {
    pendingProjectPath = projectPath;
    return;
  }
  void projectPathOpener(projectPath, mainWindow).catch(reportLaunchError);
}

// Installs a downloaded updater for this platform, then relaunches and quits.
// Windows: runs the NSIS installer (silent) which replaces the app.
// macOS: mounts the DMG, copies the .app over /Applications, then relaunches.
// Linux: replaces the running AppImage at its path, then relaunches it.
const MACOS_APP_NAME = 'Fate UI.app';
const MACOS_INSTALL_DIR = '/Applications';
function relaunchDetached(command: string, args: readonly string[] = []): void {
  const child = spawn(command, [...args], { detached: true, stdio: 'ignore' });
  child.unref();
}
async function installDownloadedUpdate(filePath: string, _version: string): Promise<void> {
  if (process.platform === 'win32') {
    // NSIS installer (/S = silent). Detach so it survives this process quitting.
    relaunchDetached(filePath, ['/S']);
    setTimeout(() => app.quit(), 800);
    return;
  }
  if (process.platform === 'darwin') {
    const mountPoint = path.join(tmpdir(), `fate-ui-update-${Date.now()}`);
    await new Promise<void>((resolve, reject) => {
      execFile('hdiutil', ['attach', filePath, '-nobrowse', '-mountpoint', mountPoint], (error) => error ? reject(error) : resolve());
    });
    try {
      const sourceApp = path.join(mountPoint, MACOS_APP_NAME);
      const targetApp = path.join(MACOS_INSTALL_DIR, MACOS_APP_NAME);
      // Replace the installed bundle (a running app keeps its old inode).
      await rm(targetApp, { recursive: true, force: true }).catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        execFile('cp', ['-R', sourceApp, targetApp], (error) => error ? reject(error) : resolve());
      });
      await new Promise<void>((resolve) => execFile('xattr', ['-dr', 'com.apple.quarantine', targetApp], () => resolve()));
    } finally {
      await new Promise<void>((resolve) => execFile('hdiutil', ['detach', mountPoint], () => resolve()));
    }
    relaunchDetached(path.join(MACOS_INSTALL_DIR, MACOS_APP_NAME, 'Contents', 'MacOS', 'fate-ui'));
    setTimeout(() => app.quit(), 800);
    return;
  }
  if (process.platform === 'linux') {
    // AppImage: replace the running binary, then relaunch it.
    const target = process.execPath;
    await new Promise<void>((resolve, reject) => {
      execFile('chmod', ['+x', filePath], (error) => error ? reject(error) : resolve());
    });
    await copyFile(filePath, target);
    relaunchDetached(target);
    setTimeout(() => app.quit(), 800);
    return;
  }
  throw new Error(`Auto-update is not supported on ${process.platform}.`);
}

// Register this before app readiness work begins. A second launch can arrive
// while the proxy, settings, or first window is still starting; dispatch keeps
// the latest project pending until the renderer can accept it.
if (instanceProfile.mode === 'single' && instancePrimaryApp) {
  app.on('second-instance', (_event, commandLine, workingDirectory) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    try {
      const forwardedProjectPath = parseLaunchProjectPath(commandLine, workingDirectory);
      if (forwardedProjectPath) dispatchProjectPath(forwardedProjectPath);
    } catch (error) {
      reportLaunchError(error);
    }
  });
}

function installMenu(): void {
  const menu = Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => sendCommand('open-project') },
      { label: 'New Session', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('new-session') },
      { type: 'separator' },
      { role: 'quit' },
    ] },
    // The Edit submenu is required for clipboard/edit keyboard shortcuts to work
    // on every platform. On macOS, Cmd+C/Cmd+V/Cmd+X/Cmd+A/Cmd+Z are only routed
    // to the focused field when role menu items exist; Windows and Linux route
    // them natively, and the roles are harmless there.
    { label: 'Edit', submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ] },
    { label: 'View', submenu: [
      { label: 'Command Palette', accelerator: 'CmdOrCtrl+K', click: () => sendCommand('open-palette') },
      { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => sendCommand('toggle-sidebar') },
      { label: 'Toggle Browser', accelerator: 'CmdOrCtrl+Shift+B', click: () => sendCommand('toggle-browser') },
      { label: 'Toggle Inspector', click: () => sendCommand('toggle-inspector') },
      { label: 'Toggle Terminal', accelerator: 'CmdOrCtrl+`', click: () => sendCommand('open-terminal') },
      { type: 'separator' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { role: 'resetZoom' },
      { type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools', visible: !app.isPackaged },
    ] },
    { label: 'Agent', submenu: [
      { label: 'Focus Browser Address / Composer', accelerator: 'CmdOrCtrl+L', click: () => sendCommand('focus-address') },
      { label: 'Stop Generation', click: () => sendCommand('stop-generation') },
    ] },
    { label: 'Help', submenu: [{ label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => sendCommand('open-settings') }] },
  ]);
  Menu.setApplicationMenu(menu);
}

function buildEditorContextMenu(params: Electron.ContextMenuParams): Menu {
  return Menu.buildFromTemplate([
    { role: 'undo', enabled: params.editFlags.canUndo },
    { role: 'redo', enabled: params.editFlags.canRedo },
    { type: 'separator' },
    { role: 'cut', enabled: params.editFlags.canCut },
    { role: 'copy', enabled: params.editFlags.canCopy },
    { role: 'paste', enabled: params.editFlags.canPaste },
    { type: 'separator' },
    { role: 'selectAll', enabled: params.editFlags.canSelectAll },
  ]);
}

function rememberWindowPlacement(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return;
  const placement: WindowPlacement = {
    bounds: window.getNormalBounds(),
    maximized: window.isMaximized(),
  };
  windowState.save(placement);
}

function createWindow(): BrowserWindow {
  rendererReady = false;
  const preload = path.join(currentDirectory, '../preload/index.cjs');
  const placement = windowState.resolve(screen.getAllDisplays(), screen.getPrimaryDisplay());
  const window = new BrowserWindow({
    ...placement.bounds,
    minWidth: MINIMUM_WINDOW_SIZE.width,
    minHeight: MINIMUM_WINDOW_SIZE.height,
    show: false,
    backgroundColor: '#11111b',
    title: 'Fate UI',
    frame: false,
    webPreferences: {
      ...secureWebPreferences,
      preload,
      devTools: !app.isPackaged,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpsUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, rendererPolicy)) event.preventDefault();
  });
  // Right-click edit menu (Cut/Copy/Paste/Select All + undo/redo). This gives a
  // consistent clipboard menu on Windows, macOS and Linux. Monaco and the
  // embedded browser render their own menus (they cancel the native event), so
  // this never duplicates them; it only shows for editable fields and selected
  // text in the app's own UI.
  window.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable && !params.selectionText) return;
    buildEditorContextMenu(params).popup({ window });
  });
  const removeWindowZoomShortcuts = installWindowZoomShortcuts(window);
  window.once('ready-to-show', () => {
    if (placement.maximized) window.maximize();
    window.show();
  });
  const sendWindowState = () => {
    if (!window.isDestroyed()) window.webContents.send(ipcChannels.windowState, windowStateSchema.parse({ maximized: window.isMaximized(), minimized: window.isMinimized() }));
  };
  window.on('maximize', sendWindowState);
  window.on('unmaximize', sendWindowState);
  window.on('minimize', sendWindowState);
  window.on('restore', sendWindowState);
  window.webContents.on('did-fail-load', (_event, code, description) => {
    if (code === -3 || window.isDestroyed()) return;
    void dialog.showMessageBox(window, {
      type: 'error',
      title: 'Fate UI could not start',
      message: 'The application interface failed to load.',
      detail: `${description} (${code})`,
      buttons: ['Quit'],
    }).finally(() => app.quit());
  });

  window.webContents.once('did-finish-load', () => {
    if (mainWindow !== window) return;
    rendererReady = true;
    if (initialLaunchError) {
      const error = initialLaunchError;
      initialLaunchError = null;
      reportLaunchError(error);
    }
    const explicitProjectPath = pendingProjectPath;
    pendingProjectPath = null;
    if (explicitProjectPath) {
      dispatchProjectPath(explicitProjectPath);
    } else {
      // A normal desktop launch has no argv project. Restore the last project
      // without showing a second trust prompt; previews can still render while
      // the Pi runtime initializes.
      void projects.lastTrustedProjectPath().then((recentProjectPath) => {
        const projectPath = pendingProjectPath ?? recentProjectPath;
        pendingProjectPath = null;
        if (projectPath) dispatchProjectPath(projectPath);
      }).catch((error: unknown) => {
        logs.write('warn', 'launcher', `The last project could not be restored: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  });

  if (process.env.PI_DESKTOP_SMOKE === '1') {
    window.webContents.once('did-finish-load', () => {
      void Promise.all([speech.getStatus(), music.getStatus(), settings.loadThemes(), smokeTerminalRuntime(process.cwd())]).then(async ([speechStatus, musicStatus, themes, terminalShell]) => {
        if (!musicStatus.available) throw new Error(musicStatus.message ?? 'Bundled yt-dlp is unavailable.');
        if (!themes.some((theme) => theme.name === 'Pi · dark') || !themes.some((theme) => theme.name === 'Pi · light')) {
          throw new Error('Bundled Pi themes are unavailable.');
        }
        if (process.env.PI_DESKTOP_SPEECH_STREAM_SMOKE === '1') {
          await smokeParakeetStream();
          console.log('PI_DESKTOP_PARAKEET_STREAM_OK');
        }
        console.log(`PI_DESKTOP_SPEECH_OK ${speechStatus.backend}`);
        console.log(`PI_DESKTOP_YT_DLP_OK ${musicStatus.version}`);
        console.log('PI_DESKTOP_THEMES_OK');
        console.log(`PI_DESKTOP_TERMINAL_OK ${terminalShell}`);
        console.log('PI_DESKTOP_SMOKE_OK');
        setTimeout(() => app.quit(), 100);
      }).catch((error: unknown) => {
        console.error(`PI_DESKTOP_RUNTIME_SMOKE_FAILED ${error instanceof Error ? error.message : String(error)}`);
        app.exit(1);
      });
    });
  }

  const developmentUrl = process.env.VITE_DEV_SERVER_URL;
  if (developmentUrl) void window.loadURL(developmentUrl);
  else void window.loadFile(rendererPath);

  const ownerId = window.webContents.id;
  window.webContents.on('destroyed', () => terminal.disposeOwner(ownerId));
  window.on('close', () => rememberWindowPlacement(window));
  window.on('closed', () => {
    removeWindowZoomShortcuts();
    if (mainWindow === window) {
      void browserHost?.reset().catch((error: unknown) => {
        logs.write('warn', 'browser', `Browser shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      mainWindow = null;
      rendererReady = false;
    }
  });
  return window;
}

app.whenReady().then(async () => {
  if (!instancePrimaryApp) return;
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
  const developmentUrl = process.env.VITE_DEV_SERVER_URL;
  const developmentBypass = developmentUrl ? new URL(developmentUrl).host : null;
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
  const mainCommands = registerIpc({ runtime, projects, files, git, settings, terminal, logs, music, speech, hotkey, updates, browser: browserHost, automations, rendererPolicy });
  projectPathOpener = mainCommands.openProjectPath;
  void hotkey.applySpeechSettings((await settings.load()).speech).then((status) => {
    if (!status.pushToTalkAvailable) logs.write('warn', 'speech', status.reason ?? 'Push-to-talk is unavailable on this platform.');
  });
  installMenu();
  mainWindow = createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('before-quit', (event) => {
  if (quitReady) return;
  event.preventDefault();
  if (shutdown) return;
  rememberWindowPlacement(mainWindow);
  terminal.dispose();
  music.dispose();
  rendererNetworkProxy.dispose();
  shutdown = Promise.race([
    Promise.all([runtime.dispose(), speech.dispose(), hotkey.dispose(), windowState.flush(), browserHost?.reset()]).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]).catch((error: unknown) => {
    logs.write('warn', 'app', `Application shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
  }).finally(() => {
    quitReady = true;
    app.exit(0);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
