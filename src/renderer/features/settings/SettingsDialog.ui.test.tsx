import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, PiDesktopApi, SpeechDownloadProgress, SpeechStatus } from '../../../shared/contracts/ipc';
import { useUiStore } from '../../stores/uiStore';
import { SettingsDialog } from './SettingsDialog';

const settings: AppSettings = {
  appearance: 'dark',
  defaultModel: null,
  thinkingLevel: 'medium',
  confirmRiskyCommands: true,
  terminalShell: null,
  reduceMotion: false,
  performanceMode: false,
  musicPlayerEnabled: false,
  sendMessageWithModifier: false,
  themeId: 'catppuccin-mocha',
  interfaceFont: 'noto-sans',
  codeFont: 'jetbrains-mono',
  speech: { enabled: true, modelId: 'mini', language: 'auto', inputDeviceId: null },
};

let speechListener: ((progress: SpeechDownloadProgress) => void) | null = null;

const speechStatus: SpeechStatus = {
  backend: 'Test Vulkan GPU', accelerated: true,
  models: [
    { id: 'mini', tier: 'mini', name: 'Mini', model: 'Parakeet 110M', description: 'Light', detail: '101 MB', bytes: 101, installed: true, downloadedBytes: 101 },
    { id: 'balanced', tier: 'balanced', name: 'Medium', model: 'Parakeet 0.6B', description: 'Balanced', detail: '475 MB', bytes: 475, installed: false, downloadedBytes: 0 },
    { id: 'max', tier: 'max', name: 'Max', model: 'Whisper Turbo', description: 'Maximum', detail: '536 MB', bytes: 536, installed: false, downloadedBytes: 0 },
  ],
};

function installBridge(setSettings: (value: AppSettings) => Promise<AppSettings>, loadedSettings: AppSettings = settings) {
  Object.defineProperty(window, 'piDesktop', {
    configurable: true,
    value: {
      getSettings: vi.fn(async () => loadedSettings),
      setSettings,
      getDiagnostics: vi.fn(async () => null),
      getLogs: vi.fn(async () => []),
      getSpeechStatus: vi.fn(async () => speechStatus),
      downloadSpeechModel: vi.fn(async () => speechStatus),
      cancelSpeechModelDownload: vi.fn(async () => true),
      removeSpeechModel: vi.fn(async () => speechStatus),
      onSpeechDownload: vi.fn((listener: (progress: SpeechDownloadProgress) => void) => { speechListener = listener; return () => { speechListener = null; }; }),
    } as unknown as PiDesktopApi,
  });
}

beforeEach(() => {
  speechListener = null;
  useUiStore.setState({ settingsOpen: true, sendMessageWithModifier: false, speechDownload: null });
  document.documentElement.dataset.performanceMode = 'false';
  document.documentElement.dataset.reduceMotion = 'false';
});

afterEach(() => {
  Reflect.deleteProperty(window, 'piDesktop');
  useUiStore.setState({ settingsOpen: false });
  document.documentElement.dataset.performanceMode = 'false';
  document.documentElement.dataset.reduceMotion = 'false';
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

  it('selects and downloads one of the three local voice power tiers', async () => {
    const setSettings = vi.fn(async (value: AppSettings) => value);
    installBridge(setSettings);
    const user = userEvent.setup();
    render(<SettingsDialog />);

    await user.click(await screen.findByRole('tab', { name: /Voice/ }));
    expect(await screen.findByText('GPU acceleration active')).toBeInTheDocument();
    expect(screen.getByLabelText('Voice transcription models').querySelectorAll('.voice-model-row')).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Download Medium voice model' }));
    expect(window.piDesktop.downloadSpeechModel).toHaveBeenCalledWith('balanced');
    speechListener?.({ modelId: 'balanced', state: 'downloading', downloadedBytes: 238, totalBytes: 475 });
    expect(await screen.findByText('50%')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel Medium voice model download' }));
    expect(window.piDesktop.cancelSpeechModelDownload).toHaveBeenCalledWith('balanced');
    speechListener?.({ modelId: 'balanced', state: 'cancelled', downloadedBytes: 238, totalBytes: 475 });
    await user.click(screen.getByRole('button', { name: /Parakeet 0.6B/ }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ speech: expect.objectContaining({ modelId: 'balanced' }) }));
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
