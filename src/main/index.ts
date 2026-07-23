import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpc } from './ipc/registerIpc';
import { secureWebPreferences } from './security/windowOptions';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;

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

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  return window;
}

app.whenReady().then(() => {
  registerIpc();
  mainWindow = createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
