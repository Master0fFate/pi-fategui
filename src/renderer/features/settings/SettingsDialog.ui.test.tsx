import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, PiDesktopApi, SpeechDownloadProgress, SpeechStatus, UpdateCheckResult } from '../../../shared/contracts/ipc';
import { builtInThemes, type ThemeDefinition } from '../../../shared/themes';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { SettingsDialog } from './SettingsDialog';

const settings: AppSettings = {
  appearance: 'dark',
  defaultModel: null,
  thinkingLevel: 'medium',
  agentTeamMode: 'legacy',
  confirmRiskyCommands: true,
  terminalShell: null,
  reduceMotion: false,
  performanceMode: false,
  holyShitMode: false,
  musicPlayerEnabled: false,
  sendMessageWithModifier: false,
  compactSessions: false,
  advancedPromptImprovement: false,
  themeId: 'catppuccin-mocha',
  interfaceFont: 'noto-sans',
  codeFont: 'jetbrains-mono',
  imageGeneration: { provider: 'auto', model: null, customProvider: null },
  speech: { enabled: true, modelId: 'canary-flash', language: 'auto', inputDeviceId: null, liveTranscription: true, finalAccuracyPass: false, voiceHotkey: null, voiceHotkeyMode: 'toggle' },
};

let speechListener: ((progress: SpeechDownloadProgress) => void) | null = null;

const speechStatus: SpeechStatus = {
  backend: 'Test Vulkan GPU', accelerated: true,
  models: [
    { id: 'canary-flash', tier: 'mini', name: 'Mini', model: 'Canary 180M', description: 'Light', detail: '101 MB', bytes: 101, installed: true, downloadedBytes: 101, streaming: false },
    { id: 'parakeet-unified', tier: 'balanced', name: 'English Live', model: 'Parakeet Unified', description: 'Balanced', detail: '475 MB', bytes: 475, installed: false, downloadedBytes: 0, streaming: true },
    { id: 'cohere-transcribe', tier: 'max', name: 'Max Accuracy', model: 'Cohere Transcribe', description: 'Maximum', detail: '536 MB', bytes: 536, installed: false, downloadedBytes: 0, streaming: false },
  ],
};

function installBridge(
  setSettings: (value: AppSettings) => Promise<AppSettings>,
  loadedSettings: AppSettings = settings,
  loadedThemes: ThemeDefinition[] = [...builtInThemes],
) {
  const bridge = {
    getSettings: vi.fn(async () => loadedSettings),
    getThemes: vi.fn(async () => loadedThemes),
    setSettings,
    getDiagnostics: vi.fn(async () => null),
    getLogs: vi.fn(async () => []),
    getSpeechStatus: vi.fn(async () => speechStatus),
    downloadSpeechModel: vi.fn(async () => speechStatus),
    cancelSpeechModelDownload: vi.fn(async () => true),
    removeSpeechModel: vi.fn(async () => speechStatus),
    onSpeechDownload: vi.fn((listener: (progress: SpeechDownloadProgress) => void) => { speechListener = listener; return () => { speechListener = null; }; }),
    checkForUpdates: vi.fn<() => Promise<UpdateCheckResult>>(async () => ({
      status: 'current',
      message: 'FateGUI is up to date. Installed version: 1.4.0',
      installedVersion: '1.4.0',
      productionVersion: '1.4.0',
    })),
    openUpdateDownload: vi.fn(async () => undefined),
    downloadAndInstallUpdate: vi.fn(async () => undefined),
    onUpdatesProgress: vi.fn(() => () => {}),
  };
  Object.defineProperty(window, 'piDesktop', {
    configurable: true,
    value: bridge as unknown as PiDesktopApi,
  });
  return bridge;
}

beforeEach(() => {
  speechListener = null;
  useRuntimeStore.getState().setRuntime({
    status: 'disconnected', project: null, sessionId: null, sessionFile: null, streaming: false,
    model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null,
  });
  useUiStore.setState({ settingsOpen: true, sendMessageWithModifier: false, speechDownload: null });
  document.documentElement.dataset.performanceMode = 'false';
  document.documentElement.dataset.reduceMotion = 'false';
  document.documentElement.dataset.holyShitMode = 'false';
});

afterEach(() => {
  Reflect.deleteProperty(window, 'piDesktop');
  useUiStore.setState({ settingsOpen: false });
  document.documentElement.dataset.performanceMode = 'false';
  document.documentElement.dataset.reduceMotion = 'false';
  document.documentElement.dataset.holyShitMode = 'false';
  delete document.documentElement.dataset.interfaceFont;
  delete document.documentElement.dataset.codeFont;
  document.documentElement.style.removeProperty('--font-interface');
  document.documentElement.style.removeProperty('--font-code');
});

describe('SettingsDialog feedback', () => {
  it('keeps Save changes geometrically stable and confirms success in a themed toast', async () => {
    let finishSave: ((value: AppSettings) => void) | undefined;
    const setSettings = vi.fn(() => new Promise<AppSettings>((resolve) => { finishSave = resolve; }));
    installBridge(setSettings);
    const user = userEvent.setup();
    render(<SettingsDialog />);

    const save = await screen.findByRole('button', { name: 'Save changes' });
    await user.click(save);
    expect(save).toHaveTextContent('Save changes');
    expect(save).not.toHaveTextContent('Saving');
    expect(save).toHaveAttribute('aria-busy', 'true');

    finishSave?.(settings);
    expect(await screen.findByRole('status')).toHaveTextContent('Settings saved');
    expect(save).toHaveAttribute('aria-busy', 'false');
  });

  it('previews and saves a discovered Pi theme through the existing theme picker', async () => {
    const piTheme = { ...builtInThemes[2]!, id: 'pi-terminal-0123456789ab', name: 'Pi · Terminal' };
    const selected = { ...settings, themeId: piTheme.id };
    const setSettings = vi.fn(async (value: AppSettings) => value);
    installBridge(setSettings, selected, [...builtInThemes, piTheme]);
    const user = userEvent.setup();
    render(<SettingsDialog themeCatalog={[...builtInThemes, piTheme]} />);

    expect(await screen.findByRole('combobox', { name: 'Interface theme' })).toHaveTextContent('Pi · Terminal');
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe(piTheme.id));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ themeId: piTheme.id }));
    expect(screen.getByText(/Pi themes.*trust the project/iu)).toBeInTheDocument();
  });

  it('loads bundled font preferences and exposes the extended Unicode preview', async () => {
    installBridge(vi.fn(async (value) => value), { ...settings, interfaceFont: 'poppins', codeFont: 'noto-sans-mono' });
    render(<SettingsDialog />);

    const interfaceFont = await screen.findByRole('combobox', { name: 'Interface font' });
    expect(interfaceFont).toHaveTextContent('Poppins');
    expect(screen.getByRole('combobox', { name: 'Code and terminal font' })).toHaveTextContent('Noto Sans Mono');
    await waitFor(() => expect(document.documentElement.dataset.interfaceFont).toBe('poppins'));
    expect(document.documentElement.style.getPropertyValue('--font-interface')).toContain('Poppins');
    expect(document.documentElement.dataset.codeFont).toBe('noto-sans-mono');
    expect(screen.getByLabelText('Extended Unicode font preview')).toHaveTextContent('Čć Đđ Šš Žž');
    expect(screen.getByLabelText('Extended Unicode font preview')).toHaveTextContent('中文');
  });

  it('describes agent settings as initial project fallbacks rather than new-session defaults', async () => {
    installBridge(vi.fn(async (value) => value));
    const user = userEvent.setup();
    render(<SettingsDialog />);

    await user.click(await screen.findByRole('tab', { name: /Agent/ }));
    expect(screen.getByText(/Fallbacks for the first Pi session opened in a project/)).toBeInTheDocument();
    expect(screen.getByText(/Initial reasoning effort when a project starts without an active session/)).toBeInTheDocument();
    expect(screen.queryByText('Sets the default reasoning effort for new sessions.')).not.toBeInTheDocument();
  });

  it('configures a custom image route only when a compatible driver and model ID are present', async () => {
    useRuntimeStore.getState().setRuntime({
      status: 'ready', project: { path: '/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: null, streaming: false,
      model: null,
      models: [
        { provider: 'mixed-images', id: 'chat', name: 'Chat', api: 'anthropic-messages', reasoning: false, contextWindow: 10_000 },
        { provider: 'mixed-images', id: 'driver', name: 'Driver', api: 'openai-responses', reasoning: false, contextWindow: 10_000 },
      ],
      thinkingLevel: 'medium', messages: [], commands: [], error: null,
    });
    installBridge(vi.fn(async (value) => value), {
      ...settings,
      imageGeneration: { provider: 'custom', model: null, customProvider: 'mixed-images' },
    });
    const user = userEvent.setup();
    render(<SettingsDialog />);

    await user.click(await screen.findByRole('tab', { name: /Agent/ }));
    expect(screen.getByRole('combobox', { name: 'Custom image provider' })).toHaveTextContent('Mixed Images');
    expect(screen.getByText('Choose an image model ID')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Image model ID' }), 'deployed-image');
    expect(screen.getByText('Ready through Fate UI')).toBeInTheDocument();
  });

  it('configures a dedicated Gemini image route without exposing credential inputs', async () => {
    installBridge(vi.fn(async (value) => value), {
      ...settings,
      imageGeneration: { provider: 'google', model: 'gemini-3.1-flash-image', customProvider: null },
    });
    const user = userEvent.setup();
    render(<SettingsDialog />);

    await user.click(await screen.findByRole('tab', { name: /Agent/ }));

    expect(screen.getByRole('combobox', { name: 'Image generation provider' })).toHaveTextContent('Google Gemini');
    expect(screen.getByRole('combobox', { name: 'Image generation model' })).toHaveTextContent('Nano Banana 2');
    expect(screen.getByText('generativelanguage.googleapis.com/v1beta/interactions')).toBeInTheDocument();
    expect(screen.getByText(/Fate UI never displays the credential/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/API key/iu)).not.toBeInTheDocument();
  });


  it('checks for updates only on click and reports the installed version', async () => {
    const bridge = installBridge(vi.fn(async (value) => value));
    const user = userEvent.setup();
    render(<SettingsDialog />);

    await screen.findByRole('combobox', { name: 'Interface font' });
    expect(bridge.checkForUpdates).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Check for Updates' }));

    expect(bridge.checkForUpdates).toHaveBeenCalledOnce();
    expect(await screen.findByRole('status')).toHaveTextContent('FateGUI is up to date. Installed version: 1.4.0');
  });

  it('prevents duplicate checks and opens the releases page only from an available-update result', async () => {
    const bridge = installBridge(vi.fn(async (value) => value));
    let finishCheck: ((result: Awaited<ReturnType<PiDesktopApi['checkForUpdates']>>) => void) | undefined;
    bridge.checkForUpdates.mockImplementationOnce(() => new Promise((resolve) => { finishCheck = resolve; }));
    const user = userEvent.setup();
    render(<SettingsDialog />);

    const check = await screen.findByRole('button', { name: 'Check for Updates' });
    await user.click(check);
    expect(check).toBeDisabled();
    await user.click(check);
    expect(bridge.checkForUpdates).toHaveBeenCalledOnce();

    finishCheck?.({
      status: 'available',
      message: 'Update available. Click to download.',
      installedVersion: '0.4.1-beta1',
      productionVersion: '0.4.1-beta2',
    });
    const download = await screen.findByRole('button', { name: 'Download & install 0.4.1-beta2' });
    await user.click(download);
    expect(bridge.downloadAndInstallUpdate).toHaveBeenCalledWith('0.4.1-beta2');
  });

  it('defers diagnostics and logs until the System section is opened', async () => {
    installBridge(vi.fn(async (value) => value));
    const user = userEvent.setup();
    render(<SettingsDialog />);

    await screen.findByRole('combobox', { name: 'Interface font' });
    expect(window.piDesktop.getDiagnostics).not.toHaveBeenCalled();
    expect(window.piDesktop.getLogs).not.toHaveBeenCalled();

    await user.click(screen.getByRole('tab', { name: /System/ }));
    await waitFor(() => expect(window.piDesktop.getDiagnostics).toHaveBeenCalledOnce());
    expect(window.piDesktop.getLogs).toHaveBeenCalledOnce();
  });

  it('persists modifier-only sending from the workspace settings', async () => {
    const setSettings = vi.fn(async (value: AppSettings) => value);
    installBridge(setSettings);
    const user = userEvent.setup();
    render(<SettingsDialog />);

    await user.click(await screen.findByRole('tab', { name: /Workspace/ }));
    const modifierSending = screen.getByRole('checkbox', { name: /Ctrl\/⌘ Enter to send/ });
    await user.click(modifierSending);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ sendMessageWithModifier: true }));
    await waitFor(() => expect(useUiStore.getState().sendMessageWithModifier).toBe(true));
  });

  it('persists advanced improve-prompt mode from the workspace settings', async () => {
    const setSettings = vi.fn(async (value: AppSettings) => value);
    installBridge(setSettings);
    const user = userEvent.setup();
    render(<SettingsDialog />);

    await user.click(await screen.findByRole('tab', { name: /Workspace/ }));
    await user.click(screen.getByRole('checkbox', { name: /Advanced improve prompt/ }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ advancedPromptImprovement: true }));
    await waitFor(() => expect(useUiStore.getState().advancedPromptImprovement).toBe(true));
    useUiStore.setState({ advancedPromptImprovement: false });
  });

  it('selects and downloads one of the three local voice power tiers', async () => {
    const setSettings = vi.fn(async (value: AppSettings) => value);
    installBridge(setSettings);
    const user = userEvent.setup();
    render(<SettingsDialog />);

    await user.click(await screen.findByRole('tab', { name: /Voice/ }));
    expect(await screen.findByText('GPU acceleration active')).toBeInTheDocument();
    expect(screen.getByLabelText('Voice transcription models').querySelectorAll('.voice-model-row')).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Download English Live voice model' }));
    expect(window.piDesktop.downloadSpeechModel).toHaveBeenCalledWith('parakeet-unified');
    speechListener?.({ modelId: 'parakeet-unified', state: 'downloading', downloadedBytes: 238, totalBytes: 475 });
    expect(await screen.findByText('50%')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel English Live voice model download' }));
    expect(window.piDesktop.cancelSpeechModelDownload).toHaveBeenCalledWith('parakeet-unified');
    speechListener?.({ modelId: 'parakeet-unified', state: 'cancelled', downloadedBytes: 238, totalBytes: 475 });
    await user.click(screen.getByRole('button', { name: /Parakeet Unified/ }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ speech: expect.objectContaining({ modelId: 'parakeet-unified' }) }));
  });

  it('folds Reduced Motion into Performance mode and restores visuals after Holy sh*t is disabled', async () => {
    const setSettings = vi.fn(async (value: AppSettings) => value);
    installBridge(setSettings);
    const user = userEvent.setup();
    render(<SettingsDialog />);

    const performanceMode = await screen.findByRole('checkbox', { name: /Performance mode/ });
    const holyShitMode = screen.getByRole('checkbox', { name: /Holy sh\*t/ });
    expect(screen.queryByRole('checkbox', { name: /^Reduce motion/iu })).not.toBeInTheDocument();

    await user.click(performanceMode);
    await waitFor(() => {
      expect(document.documentElement.dataset.performanceMode).toBe('true');
      expect(document.documentElement.dataset.reduceMotion).toBe('true');
    });

    await user.click(holyShitMode);
    await waitFor(() => expect(document.documentElement.dataset.holyShitMode).toBe('true'));
    await user.click(performanceMode);
    expect(document.documentElement.dataset.performanceMode).toBe('true');
    await user.click(holyShitMode);
    await waitFor(() => {
      expect(document.documentElement.dataset.holyShitMode).toBe('false');
      expect(document.documentElement.dataset.performanceMode).toBe('false');
      expect(document.documentElement.dataset.reduceMotion).toBe('false');
    });

    await user.click(performanceMode);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({
      performanceMode: true,
      reduceMotion: true,
      holyShitMode: false,
    }));
  });

  it('shows a recoverable error toast and applies performance settings live', async () => {
    installBridge(vi.fn(async () => { throw new Error('Disk is read-only.'); }));
    const user = userEvent.setup();
    render(<SettingsDialog />);

    const performanceMode = await screen.findByRole('checkbox', { name: /Performance mode/ });
    await user.click(performanceMode);
    await waitFor(() => expect(document.documentElement.dataset.performanceMode).toBe('true'));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Settings error');
    expect(alert).toHaveTextContent('Disk is read-only.');

    await user.click(screen.getByRole('button', { name: 'Close settings' }));
    await waitFor(() => expect(document.documentElement.dataset.performanceMode).toBe('false'));
  });
});

describe('SettingsDialog providers card (models.dev)', () => {
  it('shows provider rows with logos and a key-needed badge for managed providers without credentials', async () => {
    installBridge(vi.fn(async () => settings));
    useRuntimeStore.getState().setRuntime({
      status: 'ready', project: null, sessionId: null, sessionFile: null, streaming: false,
      model: null,
      models: [
        { provider: 'crof', id: 'kimi-k3', name: 'CrofAI: Kimi K3', reasoning: true, contextWindow: 1_000_000 },
        { provider: 'anthropic', id: 'claude-x', name: 'Claude X', reasoning: true, contextWindow: 200_000 },
      ],
      thinkingLevel: 'medium', messages: [], commands: [], error: null,
      modelsDevManaged: [{ id: 'crof', name: 'CrofAI', baseUrl: 'https://crof.ai/v1', envVar: 'CROF_API_KEY', api: 'openai-completions', modelCount: 1, addedAt: 1, checkedAt: 1, credentialConfigured: false }],
    });
    const user = userEvent.setup();
    render(<SettingsDialog />);
    await user.click(screen.getByRole('tab', { name: /agent/i }));

    const addProvider = await screen.findByRole('button', { name: /add provider/i });
    expect(addProvider).toBeInTheDocument();
    expect(screen.getByText('CrofAI')).toBeInTheDocument();
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText('key needed')).toBeInTheDocument();
    // Only the managed provider gets a remove control.
    expect(screen.getByRole('button', { name: 'Remove CrofAI from Fate UI' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Anthropic from Fate UI' })).not.toBeInTheDocument();
    // Logos paint as currentColor masks from models.dev; no <img> elements.
    const crofRow = screen.getByText('CrofAI').closest('.settings-provider-row')!;
    const logo = crofRow.querySelector<HTMLElement>('.settings-provider-pick .provider-logo');
    expect(logo).not.toBeNull();
    expect(logo!.querySelector('img')).toBeNull();
  });

  it('removes a managed provider through the row control and toasts the result', async () => {
    const bridge = installBridge(vi.fn(async () => settings));
    (bridge as unknown as Record<string, unknown>).removeModelsDevProvider = vi.fn(async () => ({
      providerId: 'crof', providerName: 'CrofAI', modelCount: 1,
      state: { status: 'ready', project: null, sessionId: null, sessionFile: null, streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null },
    }));
    useRuntimeStore.getState().setRuntime({
      status: 'ready', project: null, sessionId: null, sessionFile: null, streaming: false,
      model: null,
      models: [{ provider: 'crof', id: 'kimi-k3', name: 'CrofAI: Kimi K3', reasoning: true, contextWindow: 1_000_000 }],
      thinkingLevel: 'medium', messages: [], commands: [], error: null,
      modelsDevManaged: [{ id: 'crof', name: 'CrofAI', baseUrl: 'https://crof.ai/v1', envVar: 'CROF_API_KEY', api: 'openai-completions', modelCount: 1, addedAt: 1, checkedAt: 1, credentialConfigured: true }],
    });
    const user = userEvent.setup();
    render(<SettingsDialog />);
    await user.click(screen.getByRole('tab', { name: /agent/i }));
    await user.click(await screen.findByRole('button', { name: 'Remove CrofAI from Fate UI' }));
    expect(await screen.findByRole('status')).toHaveTextContent('CrofAI removed');
  });
});
