import { app, BrowserWindow, protocol } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appCommandSchema, ipcChannels, type AppSettings, type ProjectState, type TerminalEvent } from '../../src/shared/contracts/ipc';
import { browserEventBatchSchema } from '../../src/shared/contracts/browser';
import { builtInThemes } from '../../src/shared/themes';
import { AutomationRepository } from '../../src/main/automations/AutomationRepository';
import { FilesystemService } from '../../src/main/files/FilesystemService';
import { GitService } from '../../src/main/git/GitService';
import { BrowserHost } from '../../src/main/browser/BrowserHost';
import { LOCAL_PAGE_SCHEME } from '../../src/main/browser/LocalPageRegistry';
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
import { MINIMUM_WINDOW_SIZE } from '../../src/main/windowState';
import { FakePiRuntimeService } from './FakePiRuntimeService';

protocol.registerSchemesAsPrivileged([{
  scheme: LOCAL_PAGE_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

const directory = path.dirname(fileURLToPath(import.meta.url));
const projectPath = process.env.PI_DESKTOP_E2E_PROJECT;
if (!projectPath) throw new Error('PI_DESKTOP_E2E_PROJECT is required');
if (process.env.PI_DESKTOP_E2E_USER_DATA) app.setPath('userData', process.env.PI_DESKTOP_E2E_USER_DATA);

const runtime = new FakePiRuntimeService();
const files = new FilesystemService();
const git = new GitService(files);
const project = { path: projectPath, name: path.basename(projectPath), trusted: true };
const secondProjectPath = process.env.PI_DESKTOP_E2E_SECOND_PROJECT;
const secondProject = secondProjectPath ? { path: secondProjectPath, name: path.basename(secondProjectPath), trusted: true } : null;
let projectSelectionCount = 0;
const activation = (candidate: ProjectState): ProjectActivation => ({ project: candidate, commit: async () => candidate, rollback: async () => undefined });
const projects = {
  prepareSelect: async () => {
    const selected = secondProject && projectSelectionCount > 0 ? secondProject : project;
    projectSelectionCount += 1;
    return activation(selected);
  },
  prepareOpenPath: async (selectedPath: string) => activation({ path: selectedPath, name: path.basename(selectedPath), trusted: true }),
  prepareSessionListPath: async (selectedPath: string) => selectedPath,
  prepareDerivedWorktree: async (worktreePath: string, sourceProjectPath: string) => activation({ path: worktreePath, name: path.basename(sourceProjectPath), trusted: true }),
  selectFile: async () => 'src/example.ts',
} as unknown as ProjectService;
const profileVisualMode = process.env.FATE_GUI_PROFILE_VISUAL_MODE;
let settingsValue: AppSettings = { appearance: 'dark', defaultModel: 'test/deterministic', thinkingLevel: 'medium', agentTeamMode: 'legacy', confirmRiskyCommands: true, terminalShell: null, reduceMotion: profileVisualMode === 'performance', performanceMode: profileVisualMode === 'performance', holyShitMode: profileVisualMode === 'holy', musicPlayerEnabled: false, sendMessageWithModifier: false, compactMode: false, compactSessions: false, advancedPromptImprovement: false, crashTelemetryEnabled: false, themeId: 'midnight', interfaceFont: 'noto-sans', codeFont: 'jetbrains-mono', imageGeneration: { provider: 'auto', model: null, customProvider: null }, speech: { enabled: true, modelId: 'canary-flash', language: 'auto', inputDeviceId: null, liveTranscription: true, finalAccuracyPass: false, voiceHotkey: null, voiceHotkeyMode: 'toggle' } };
const e2ePiTheme = { ...builtInThemes[4]!, id: 'pi-e2e-theme-0123456789ab', name: 'Pi · E2E Theme' };
const settings = {
  load: async () => settingsValue,
  get: () => settingsValue,
  set: async (value: AppSettings) => { settingsValue = value; return value; },
  loadThemes: async () => [...builtInThemes, e2ePiTheme],
} as unknown as SettingsService;
const logs = { list: () => [], write: () => undefined } as unknown as AppLogService;
const automations = new AutomationRepository(logs, path.join(process.env.PI_DESKTOP_E2E_USER_DATA ?? app.getPath('userData'), 'automations'));
const music = {
  getStatus: async () => ({ available: false, version: null, message: 'yt-dlp is unavailable in the E2E harness.' }),
  load: async () => { throw new Error('Music loading is disabled in the E2E harness.'); },
  resolveTrack: async () => { throw new Error('Music loading is disabled in the E2E harness.'); },
  clearQueue: () => undefined,
  reset: () => undefined,
  setDurationSink: () => undefined,
} as unknown as MusicService;
const speechModels = [
  { id: 'mini', tier: 'mini', name: 'Mini', model: 'Test Mini', description: 'Test model', detail: '1 MB', bytes: 1, installed: true, downloadedBytes: 1, streaming: true },
  { id: 'balanced', tier: 'balanced', name: 'Medium', model: 'Test Medium', description: 'Test model', detail: '2 MB', bytes: 2, installed: false, downloadedBytes: 0, streaming: false },
  { id: 'max', tier: 'max', name: 'Max', model: 'Test Max', description: 'Test model', detail: '3 MB', bytes: 3, installed: false, downloadedBytes: 0, streaming: false },
] as const;
const speech = {
  setEventSink: () => undefined,
  setStreamSink: () => undefined,
  getStatus: async () => ({ models: speechModels, backend: 'E2E CPU', accelerated: false }),
  download: async () => undefined,
  cancelDownload: () => false,
  remove: async () => undefined,
  transcribe: async () => ({ text: 'voice test', language: 'en', backend: 'E2E CPU', accelerated: false }),
  cancel: () => false,
  streamStart: async () => undefined,
  streamFeed: async () => undefined,
  streamStop: async () => undefined,
  streamCancel: async () => undefined,
} as unknown as SpeechService;
const updates = {
  check: async () => ({ status: 'current' as const, message: 'FateGUI is up to date.' }),
  openDownload: async () => undefined,
  downloadAndInstall: async () => undefined,
};
let browser: BrowserHost;
browser = new BrowserHost({
  currentProject: () => runtime.getState().project,
  currentPermissionLevel: () => runtime.getState().permissionLevel ?? 'full-access',
  bridge: {
    currentRoot: () => {
      const state = runtime.getState();
      return state.project && state.sessionId ? { projectPath: state.project.path, sessionId: state.sessionId } : null;
    },
    syncService: () => {
      const service = browser.current();
      const sessionId = runtime.getState().sessionId;
      if (!service || !sessionId) return;
      service.beginTask(sessionId);
      service.lease.acquire(sessionId);
    },
  },
  emit: (owner, event) => {
    if (!owner.isDestroyed()) owner.webContents.send(ipcChannels.browserEvents, browserEventBatchSchema.parse([event]));
  },
  command: (owner, command) => {
    if (!owner.isDestroyed()) owner.webContents.send(ipcChannels.appCommand, appCommandSchema.parse(command));
  },
});
const terminal = {
  setEventSink: (_sink: (ownerId: number, event: TerminalEvent) => void) => undefined,
  create: () => ({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', shell: 'test-shell', cwd: projectPath }),
  write: () => undefined, resize: () => undefined, close: () => undefined, disposeOwner: () => undefined,
  disposeProjectTerminals: () => undefined, dispose: () => undefined,
} as unknown as TerminalService;

let window: BrowserWindow | null = null;
let quitReady = false;
let shutdown: Promise<void> | null = null;
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
    hotkey: { getStatus: () => ({ pushToTalkAvailable: true }), applySpeechSettings: async () => ({ pushToTalkAvailable: true }), register: async () => ({ pushToTalkAvailable: true }), unregister() {}, resetActive() {}, dispose() {} } as never,
    updates,
    browser,
    automations,
    attestations: { query: async () => ({ rows: [], truncated: false }) },
    rendererPolicy: createTrustedRendererPolicy(rendererPath),
  });
  window = new BrowserWindow({
    width: 1280, height: 720,
    minWidth: MINIMUM_WINDOW_SIZE.width, minHeight: MINIMUM_WINDOW_SIZE.height,
    show: false, frame: false, backgroundColor: '#11111b',
    webPreferences: { ...secureWebPreferences, preload: path.resolve(directory, '../../dist/preload/index.cjs') },
  });
  installWindowZoomShortcuts(window);
  window.once('ready-to-show', () => window?.show());
  void window.loadFile(rendererPath);
});
app.on('before-quit', (event) => {
  if (quitReady) return;
  event.preventDefault();
  if (shutdown) return;
  shutdown = Promise.race([
    browser.reset(),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]).catch(() => undefined).finally(() => {
    quitReady = true;
    app.exit(0);
  });
});
app.on('window-all-closed', () => app.quit());
