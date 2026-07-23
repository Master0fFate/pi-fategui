import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppSettings, TerminalEvent } from '../../src/shared/contracts/ipc';
import { FilesystemService } from '../../src/main/files/FilesystemService';
import { GitService } from '../../src/main/git/GitService';
import { registerIpc } from '../../src/main/ipc/registerIpc';
import type { AppLogService } from '../../src/main/logging/AppLogService';
import type { PiRuntimeService } from '../../src/main/pi/PiRuntimeService';
import type { ProjectService } from '../../src/main/projects/ProjectService';
import { secureWebPreferences } from '../../src/main/security/windowOptions';
import type { SettingsService } from '../../src/main/settings/SettingsService';
import type { TerminalService } from '../../src/main/terminal/TerminalService';
import { FakePiRuntimeService } from './FakePiRuntimeService';

const directory = path.dirname(fileURLToPath(import.meta.url));
const projectPath = process.env.PI_DESKTOP_E2E_PROJECT;
if (!projectPath) throw new Error('PI_DESKTOP_E2E_PROJECT is required');
if (process.env.PI_DESKTOP_E2E_USER_DATA) app.setPath('userData', process.env.PI_DESKTOP_E2E_USER_DATA);

const runtime = new FakePiRuntimeService();
const files = new FilesystemService();
const git = new GitService(files);
const project = { path: projectPath, name: path.basename(projectPath), trusted: true };
const projects = { select: async () => project, selectFile: async () => 'src/example.ts' } as unknown as ProjectService;
let settingsValue: AppSettings = { appearance: 'dark', defaultModel: null, thinkingLevel: 'medium', confirmRiskyCommands: true, terminalShell: null, reduceMotion: false };
const settings = { load: async () => settingsValue, get: () => settingsValue, set: async (value: AppSettings) => { settingsValue = value; return value; } } as unknown as SettingsService;
const logs = { list: () => [], write: () => undefined } as unknown as AppLogService;
const terminal = {
  setEventSink: (_sink: (ownerId: number, event: TerminalEvent) => void) => undefined,
  create: () => ({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', shell: 'test-shell', cwd: projectPath }),
  write: () => undefined, resize: () => undefined, close: () => undefined, disposeOwner: () => undefined, dispose: () => undefined,
} as unknown as TerminalService;

let window: BrowserWindow | null = null;
app.whenReady().then(() => {
  registerIpc({ runtime: runtime as unknown as PiRuntimeService, projects, files, git, settings, terminal, logs });
  window = new BrowserWindow({
    width: 1440, height: 900, show: false, backgroundColor: '#090b12',
    webPreferences: { ...secureWebPreferences, preload: path.resolve(directory, '../../dist/preload/index.cjs') },
  });
  window.once('ready-to-show', () => window?.show());
  void window.loadFile(path.resolve(directory, '../../dist/renderer/index.html'));
});
app.on('window-all-closed', () => app.quit());
