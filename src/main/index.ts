import { app, BrowserWindow, Menu, session, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FilesystemService } from './files/FilesystemService';
import { GitService } from './git/GitService';
import { registerIpc } from './ipc/registerIpc';
import { AppLogService } from './logging/AppLogService';
import { PiRuntimeService } from './pi/PiRuntimeService';
import { ProjectService } from './projects/ProjectService';
import { secureWebPreferences } from './security/windowOptions';
import { SettingsService } from './settings/SettingsService';
import { TerminalService } from './terminal/TerminalService';
import { appCommandSchema, ipcChannels, type AppCommand } from '../shared/contracts/ipc';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtime = new PiRuntimeService();
const projects = new ProjectService();
const files = new FilesystemService();
const git = new GitService(files);
const logs = new AppLogService();
const settings = new SettingsService(logs);
const terminal = new TerminalService(files, runtime, settings, logs);
let mainWindow: BrowserWindow | null = null;

function sendCommand(command: AppCommand): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ipcChannels.appCommand, appCommandSchema.parse(command));
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
      { type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools', visible: !app.isPackaged },
    ] },
    { label: 'Agent', submenu: [
      { label: 'Focus Composer', accelerator: 'CmdOrCtrl+L', click: () => sendCommand('focus-composer') },
      { label: 'Stop Generation', accelerator: 'Esc', click: () => sendCommand('stop-generation') },
    ] },
    { label: 'Help', submenu: [{ label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => sendCommand('open-settings') }] },
  ]);
  Menu.setApplicationMenu(menu);
}

function createWindow(): BrowserWindow {
  const preload = path.join(currentDirectory, '../preload/index.cjs');
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#090b12',
    title: 'Pi Desktop',
    titleBarStyle: 'hidden',
    ...(process.platform !== 'darwin'
      ? { titleBarOverlay: { color: '#090b12', symbolColor: '#9aa3b7', height: 38 } }
      : {}),
    webPreferences: {
      ...secureWebPreferences,
      preload,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const allowedOrigin = process.env.VITE_DEV_SERVER_URL;
    if (allowedOrigin && url.startsWith(allowedOrigin)) return;
    if (url.startsWith('file:')) return;
    event.preventDefault();
  });
  window.once('ready-to-show', () => window.show());

  if (process.env.PI_DESKTOP_SMOKE === '1') {
    window.webContents.once('did-finish-load', () => {
      console.log('PI_DESKTOP_SMOKE_OK');
      setTimeout(() => app.quit(), 100);
    });
  }

  const developmentUrl = process.env.VITE_DEV_SERVER_URL;
  if (developmentUrl) void window.loadURL(developmentUrl);
  else void window.loadFile(path.join(currentDirectory, '../renderer/index.html'));

  const ownerId = window.webContents.id;
  window.webContents.on('destroyed', () => terminal.disposeOwner(ownerId));
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  return window;
}

app.whenReady().then(async () => {
  await settings.load();
  logs.write('info', 'app', `Pi Desktop ${app.getVersion()} started.`);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  registerIpc({ runtime, projects, files, git, settings, terminal, logs });
  installMenu();
  mainWindow = createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('before-quit', () => {
  terminal.dispose();
  void runtime.dispose();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
