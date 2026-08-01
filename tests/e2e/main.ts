import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppSettings, ProjectState, TerminalEvent } from '../../src/shared/contracts/ipc';
import { FilesystemService } from '../../src/main/files/FilesystemService';
import { GitService } from '../../src/main/git/GitService';
import { registerIpc } from '../../src/main/ipc/registerIpc';
import type { AppLogService } from '../../src/main/logging/AppLogService';
import type { MusicService } from '../../src/main/music/MusicService';
import type { PiRuntimeService } from '../../src/main/pi/PiRuntimeService';
import type { ProjectActivation, ProjectService } from '../../src/main/projects/ProjectService';
import { secureWebPreferences } from '../../src/main/security/windowOptions';
import { createTrustedRendererPolicy } from '../../src/main/security/trustedRenderer';
import type { SettingsService } from '../../src/main/settings/SettingsService';
import type { SpeechService } from '../../src/main/speech/SpeechService';
import type { TerminalService } from '../../src/main/terminal/TerminalService';
import { installWindowZoomShortcuts } from '../../src/main/windowZoom';
import { FakePiRuntimeService } from './FakePiRuntimeService';

const directory = path.dirname(fileURLToPath(import.meta.url));
const projectPath = process.env.PI_DESKTOP_E2E_PROJECT;
if (!projectPath) throw new Error('PI_DESKTOP_E2E_PROJECT is required');
if (process.env.PI_DESKTOP_E2E_USER_DATA) app.setPath('userData', process.env.PI_DESKTOP_E2E_USER_DATA);

const runtime = new FakePiRuntimeService();
const files = new FilesystemService();
const git = new GitService(files);
const project = { path: projectPath, name: path.basename(projectPath), trusted: true };
const activation = (candidate: ProjectState): ProjectActivation => ({ project: candidate, commit: async () => candidate, rollback: async () => undefined });
const projects = {
  prepareSelect: async () => activation(project),
  prepareOpenPath: async (selectedPath: string) => activation({ path: selectedPath, name: path.basename(selectedPath), trusted: true }),
  prepareDerivedWorktree: async (worktreePath: string, sourceProjectPath: string) => activation({ path: worktreePath, name: path.basename(sourceProjectPath), trusted: true }),
  selectFile: async () => 'src/example.ts',
} as unknown as ProjectService;
const profileVisualMode = process.env.FATE_GUI_PROFILE_VISUAL_MODE;
let settingsValue: AppSettings = { appearance: 'dark', defaultModel: 'test/deterministic', thinkingLevel: 'medium', agentTeamMode: 'legacy', confirmRiskyCommands: true, terminalShell: null, reduceMotion: profileVisualMode === 'performance', performanceMode: profileVisualMode === 'performance', holyShitMode: profileVisualMode === 'holy', musicPlayerEnabled: false, sendMessageWithModifier: false, themeId: 'midnight', interfaceFont: 'noto-sans', codeFont: 'jetbrains-mono', speech: { enabled: true, modelId: 'mini', language: 'auto', inputDeviceId: null } };
const settings = { load: async () => settingsValue, get: () => settingsValue, set: async (value: AppSettings) => { settingsValue = value; return value; } } as unknown as SettingsService;
const logs = { list: () => [], write: () => undefined } as unknown as AppLogService;
const music = {
  getStatus: async () => ({ available: false, version: null, message: 'yt-dlp is unavailable in the E2E harness.' }),
  load: async () => { throw new Error('Music loading is disabled in the E2E harness.'); },
  resolveTrack: async () => { throw new Error('Music loading is disabled in the E2E harness.'); },
  clearQueue: () => undefined,
  reset: () => undefined,
} as unknown as MusicService;
const speechModels = [
  { id: 'mini', tier: 'mini', name: 'Mini', model: 'Test Mini', description: 'Test model', detail: '1 MB', bytes: 1, installed: true, downloadedBytes: 1 },
  { id: 'balanced', tier: 'balanced', name: 'Medium', model: 'Test Medium', description: 'Test model', detail: '2 MB', bytes: 2, installed: false, downloadedBytes: 0 },
  { id: 'max', tier: 'max', name: 'Max', model: 'Test Max', description: 'Test model', detail: '3 MB', bytes: 3, installed: false, downloadedBytes: 0 },
] as const;
const speech = {
  setEventSink: () => undefined,
  getStatus: async () => ({ models: speechModels, backend: 'E2E CPU', accelerated: false }),
  download: async () => undefined,
  cancelDownload: () => false,
  remove: async () => undefined,
  transcribe: async () => ({ text: 'voice test', language: 'en', backend: 'E2E CPU', accelerated: false }),
  cancel: () => false,
} as unknown as SpeechService;
const updates = {
  check: async () => ({ status: 'current' as const, message: 'FateGUI is up to date.' }),
  openDownload: async () => undefined,
};
const terminal = {
  setEventSink: (_sink: (ownerId: number, event: TerminalEvent) => void) => undefined,
  create: () => ({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', shell: 'test-shell', cwd: projectPath }),
  write: () => undefined, resize: () => undefined, close: () => undefined, disposeOwner: () => undefined,
  disposeProjectTerminals: () => undefined, dispose: () => undefined,
} as unknown as TerminalService;

let window: BrowserWindow | null = null;
app.whenReady().then(() => {
  const rendererPath = path.resolve(directory, '../../dist/renderer/index.html');
  registerIpc({
    runtime: runtime as unknown as PiRuntimeService,
    projects,
    files,
    git,
    settings,
    terminal,
    logs,
    music,
    speech,
    updates,
    rendererPolicy: createTrustedRendererPolicy(rendererPath),
  });
  window = new BrowserWindow({
    width: 1280, height: 720, show: false, frame: false, backgroundColor: '#11111b',
    webPreferences: { ...secureWebPreferences, preload: path.resolve(directory, '../../dist/preload/index.cjs') },
  });
  installWindowZoomShortcuts(window);
  window.once('ready-to-show', () => window?.show());
  void window.loadFile(rendererPath);
});
app.on('window-all-closed', () => app.quit());
