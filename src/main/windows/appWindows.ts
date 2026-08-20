import { app, BrowserWindow, dialog, Menu, screen, shell } from 'electron';
import { AppLogService } from '../logging/AppLogService';
import { ProjectService } from '../projects/ProjectService';
import { secureWebPreferences } from '../security/windowOptions';
import { createTrustedRendererPolicy, isExternalHttpsUrl, isTrustedRendererUrl } from '../security/trustedRenderer';
import { TerminalService } from '../terminal/TerminalService';
import { MINIMUM_WINDOW_SIZE, WindowStateService, type WindowPlacement } from '../windowState';
import { installWindowZoomShortcuts } from '../windowZoom';
import { appCommandSchema, ipcChannels, windowStateSchema, type AppCommand } from '../../shared/contracts/ipc';
import { LaunchDispatcher } from './launchDispatcher';

export interface AppWindowFactoryDeps {
  logs: AppLogService;
  windowState: WindowStateService;
  terminal: TerminalService;
  projects: ProjectService;
  dispatcher: LaunchDispatcher<BrowserWindow>;
  reportLaunchError: (error: unknown) => void;
  /** Consume and clear the launch-time argv parse error (once). */
  consumeLaunchError: () => unknown | null;
  rendererPolicy: ReturnType<typeof createTrustedRendererPolicy>;
  preloadPath: string;
  rendererPath: string;
  /** Optional production smoke wired on the initial window's first load. */
  installSmoke?: (window: BrowserWindow) => void;
  developmentUrl?: string;
}

export interface AppWindowFactory {
  createWindow(options?: { initial?: boolean }): BrowserWindow;
  installMenu(): void;
}

export function rememberWindowPlacement(window: BrowserWindow | null, windowState: WindowStateService): void {
  if (!window || window.isDestroyed()) return;
  const placement: WindowPlacement = {
    bounds: window.getNormalBounds(),
    maximized: window.isMaximized(),
  };
  windowState.save(placement);
}

export function createAppWindowFactory(deps: AppWindowFactoryDeps): AppWindowFactory {
  function sendCommand(command: AppCommand): void {
    const window = deps.dispatcher.activeHandle();
    if (window) window.webContents.send(ipcChannels.appCommand, appCommandSchema.parse(command));
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

  function createWindow(options: { initial?: boolean } = {}): BrowserWindow {
    const placement = deps.windowState.resolve(screen.getAllDisplays(), screen.getPrimaryDisplay());
    // Additional windows cascade so they do not stack exactly on top of the
    // first one. Every window hydrates from the same shared runtime.
    const offset = options.initial ? 0 : 28 * ((deps.dispatcher.openWindowCount() % 8) + 1);
    const bounds = { ...placement.bounds, x: placement.bounds.x + offset, y: placement.bounds.y + offset };
    const window = new BrowserWindow({
      ...bounds,
      minWidth: MINIMUM_WINDOW_SIZE.width,
      minHeight: MINIMUM_WINDOW_SIZE.height,
      show: false,
      backgroundColor: '#11111b',
      title: 'Fate UI',
      frame: false,
      webPreferences: {
        ...secureWebPreferences,
        preload: deps.preloadPath,
        devTools: !app.isPackaged,
      },
    });

    deps.dispatcher.register(window);
    window.on('focus', () => deps.dispatcher.setFocused(window));

    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isExternalHttpsUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (!isTrustedRendererUrl(url, deps.rendererPolicy)) event.preventDefault();
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
      // Only the first window owns launch-time restore. Extra windows simply
      // hydrate from the shared runtime like any reconnecting renderer.
      if (!options.initial) return;
      deps.dispatcher.runInitialRestore({
        restoreLastTrustedProject: () => deps.projects.lastTrustedProjectPath(),
        consumeLaunchError: deps.consumeLaunchError,
      });
    });

    if (options.initial && deps.installSmoke) deps.installSmoke(window);

    if (deps.developmentUrl) void window.loadURL(deps.developmentUrl);
    else void window.loadFile(deps.rendererPath);

    const ownerId = window.webContents.id;
    window.webContents.on('destroyed', () => deps.terminal.disposeOwner(ownerId));
    window.on('close', () => rememberWindowPlacement(window, deps.windowState));
    window.on('closed', () => {
      removeWindowZoomShortcuts();
      // The browser host is shared across every window; the dispatcher's
      // onLastWindowClosed tears it down when the last window leaves so a
      // remaining window keeps its embedded browser.
      deps.dispatcher.close(window);
    });
    return window;
  }

  function installMenu(): void {
    const menu = Menu.buildFromTemplate([
      { label: 'File', submenu: [
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => sendCommand('open-project') },
        { label: 'New Session', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('new-session') },
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow() },
        { label: 'Export Session…', click: () => sendCommand('export-session') },
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

  return { createWindow, installMenu };
}
