import { app, BrowserWindow, dialog, Menu, screen, session, shell, systemPreferences } from 'electron';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FilesystemService } from './files/FilesystemService';
import { GitService } from './git/GitService';
import { registerIpc } from './ipc/registerIpc';
import { parseLaunchProjectPath } from './launchProject';
import { acquireInstanceProfile } from './instanceProfile';
import { AppLogService } from './logging/AppLogService';
import { MusicService, PublicHttpsProxy } from './music/MusicService';
import { PiRuntimeService } from './pi/PiRuntimeService';
import { SessionPermissionStore } from './pi/SessionPermissionStore';
import { GoalMaxRepository } from './pi/goalmaxxing/GoalMaxRepository';
import { ProjectService } from './projects/ProjectService';
import { secureWebPreferences } from './security/windowOptions';
import { createTrustedRendererPolicy, isExternalHttpsUrl, isTrustedAudioPermissionRequest, isTrustedRendererUrl } from './security/trustedRenderer';
import { SettingsService } from './settings/SettingsService';
import { SpeechService } from './speech/SpeechService';
import { TerminalService } from './terminal/TerminalService';
import { UpdateService } from './updates/UpdateService';
import { MINIMUM_WINDOW_SIZE, WindowStateService, type WindowPlacement } from './windowState';
import { installWindowZoomShortcuts } from './windowZoom';
import { appCommandSchema, ipcChannels, windowStateSchema, type AppCommand } from '../shared/contracts/ipc';

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

let initialProjectPath: string | null = null;
let initialLaunchError: unknown = null;
try {
  initialProjectPath = parseLaunchProjectPath(process.argv, process.cwd());
} catch (error) {
  initialLaunchError = error;
}
// Every process gets the first available persistent Electron profile slot.
// This keeps Chromium storage isolated while allowing independent Fate UI
// runtimes and projects to run side by side.
const instanceProfile = acquireInstanceProfile(app);

configurePackagedSpeechLibrary();
const logs = new AppLogService();
const settings = new SettingsService(logs);
const runtime = new PiRuntimeService(
  undefined,
  undefined,
  new SessionPermissionStore(logs),
  undefined,
  () => settings.get().imageGeneration,
  new GoalMaxRepository(logs),
);
const projects = new ProjectService();
const files = new FilesystemService();
const git = new GitService(files);
const updates = new UpdateService(path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'PRODVER'), {
  openExternal: (url) => shell.openExternal(url),
});
const windowState = new WindowStateService(logs);
const music = new MusicService();
const rendererNetworkProxy = new PublicHttpsProxy();
const speech = new SpeechService(logs);
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

function installMenu(): void {
  const menu = Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => sendCommand('open-project') },
      { label: 'New Session', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('new-session') },
      { type: 'separator' },
      { role: 'quit' },
    ] },
    { label: 'View', submenu: [
      { label: 'Command Palette', accelerator: 'CmdOrCtrl+K', click: () => sendCommand('open-palette') },
      { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => sendCommand('toggle-sidebar') },
      { label: 'Toggle Inspector', accelerator: 'CmdOrCtrl+Shift+B', click: () => sendCommand('toggle-inspector') },
      { label: 'Toggle Terminal', accelerator: 'CmdOrCtrl+`', click: () => sendCommand('open-terminal') },
      { type: 'separator' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { role: 'resetZoom' },
      { type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools', visible: !app.isPackaged },
    ] },
    { label: 'Agent', submenu: [
      { label: 'Focus Composer', accelerator: 'CmdOrCtrl+L', click: () => sendCommand('focus-composer') },
      { label: 'Stop Generation', click: () => sendCommand('stop-generation') },
    ] },
    { label: 'Help', submenu: [{ label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => sendCommand('open-settings') }] },
  ]);
  Menu.setApplicationMenu(menu);
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
    if (pendingProjectPath) {
      const projectPath = pendingProjectPath;
      pendingProjectPath = null;
      dispatchProjectPath(projectPath);
    }
  });

  if (process.env.PI_DESKTOP_SMOKE === '1') {
    window.webContents.once('did-finish-load', () => {
      void Promise.all([speech.getStatus(), music.getStatus(), settings.loadThemes()]).then(([speechStatus, musicStatus, themes]) => {
        if (!musicStatus.available) throw new Error(musicStatus.message ?? 'Bundled yt-dlp is unavailable.');
        if (!themes.some((theme) => theme.name === 'Pi · dark') || !themes.some((theme) => theme.name === 'Pi · light')) {
          throw new Error('Bundled Pi themes are unavailable.');
        }
        console.log(`PI_DESKTOP_SPEECH_OK ${speechStatus.backend}`);
        console.log(`PI_DESKTOP_YT_DLP_OK ${musicStatus.version}`);
        console.log('PI_DESKTOP_THEMES_OK');
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
      mainWindow = null;
      rendererReady = false;
    }
  });
  return window;
}

app.whenReady().then(async () => {
  const proxyUrl = await rendererNetworkProxy.start();
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
  const mainCommands = registerIpc({ runtime, projects, files, git, settings, terminal, logs, music, speech, updates, rendererPolicy });
  projectPathOpener = mainCommands.openProjectPath;
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
    Promise.all([runtime.dispose(), speech.dispose(), windowState.flush()]).then(() => undefined),
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
