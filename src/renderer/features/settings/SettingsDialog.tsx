import * as Dialog from '@radix-ui/react-dialog';
import {
  Activity,
  Bot,
  Check,
  CheckCircle2,
  CircleAlert,
  Gauge,
  Keyboard,
  ImageIcon,
  LockKeyhole,
  Monitor,
  Music2,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  TerminalSquare,
  Type,
  Mic2,
  Download,
  Trash2,
  LoaderCircle,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { AppSettings, Diagnostics, LogEntry, ModelInfo, SpeechDownloadProgress, SpeechHotkeyStatus, SpeechModelId, SpeechStatus, SpeechTier, UpdateCheckResult, VoiceHotkeyMode } from '../../../shared/contracts/ipc';
import { defaultSpeechSettings } from '../../../shared/contracts/ipc';
import type { ThemeDefinition } from '../../../shared/themes';
import {
  defaultImageGenerationModel,
  imageGenerationPreset,
  imageGenerationProviderPresets,
  isOpenAICompatibleImageApi,
  type ImageGenerationProviderId,
} from '../../../shared/imageGeneration';
import { applyVisualSettings } from '../../appearance';
import { AppTooltip } from '../../components/AppTooltip';
import { SelectControl } from '../../components/SelectControl';
import { codeFontOptions, interfaceFontOptions } from '../../fonts';
import { fallbackThemes } from '../../theme';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { enumerateMicrophones, microphoneAccessError, requestMicrophoneDevices, type MicrophoneDevice } from './microphoneDevices';

const fallback: AppSettings = {
  appearance: 'dark', defaultModel: null, thinkingLevel: 'medium', agentTeamMode: 'legacy', confirmRiskyCommands: true,
  terminalShell: null, reduceMotion: false, performanceMode: false, holyShitMode: false, musicPlayerEnabled: false, sendMessageWithModifier: false, compactSessions: false, themeId: 'midnight',
  interfaceFont: 'noto-sans', codeFont: 'jetbrains-mono',
  imageGeneration: { provider: 'auto', model: null, customProvider: null },
  speech: defaultSpeechSettings,
};

type SettingsSection = 'general' | 'agent' | 'voice' | 'workspace' | 'system';
type SettingsToast = { kind: 'success' | 'error'; title: string; message: string };

const sections = [
  { id: 'general', label: 'General', detail: 'Look & performance', icon: SlidersHorizontal },
  { id: 'agent', label: 'Agent', detail: 'Models & reasoning', icon: Bot },
  { id: 'voice', label: 'Voice', detail: 'Local speech-to-text', icon: Mic2 },
  { id: 'workspace', label: 'Workspace', detail: 'Trust & terminal', icon: ShieldCheck },
  { id: 'system', label: 'System', detail: 'Health & logs', icon: Activity },
] as const;

const providerNames: Record<string, string> = {
  anthropic: 'Anthropic', google: 'Google', openai: 'OpenAI', 'openai-codex': 'OpenAI Codex', openrouter: 'OpenRouter',
};

export const formatProviderName = (provider: string) => providerNames[provider.toLowerCase()]
  ?? provider.split(/[-_\s]+/).filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join(' ');

export const groupModelsByProvider = (models: readonly ModelInfo[]) => {
  const grouped = new Map<string, ModelInfo[]>();
  for (const model of models) grouped.set(model.provider, [...(grouped.get(model.provider) ?? []), model]);
  return [...grouped.entries()]
    .map(([provider, providerModels]) => ({
      provider,
      title: formatProviderName(provider),
      models: providerModels.sort((left, right) => left.name.localeCompare(right.name)),
    }))
    .sort((left, right) => left.title.localeCompare(right.title));
};

const SPECIAL_KEY_CODES: Record<string, string> = {
  Space: 'Space', Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace',
  Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
};

/** Translate a captured keyboard event into an Electron accelerator string
 *  (e.g. "CommandOrControl+Shift+Space"). Returns null for modifier-only presses. */
function acceleratorFromEvent(event: KeyboardEvent): string | null {
  const isMac = navigator.platform.toLowerCase().includes('mac');
  const tokens: string[] = [];
  const primary = isMac ? event.metaKey : event.ctrlKey;
  if (primary) tokens.push('CommandOrControl');
  if (isMac && event.ctrlKey) tokens.push('Control');
  if (!isMac && event.metaKey) tokens.push('Command');
  if (event.altKey) tokens.push('Alt');
  if (event.shiftKey) tokens.push('Shift');
  let key: string | null = null;
  const code = event.code;
  if (/^Key([A-Z])$/.test(code)) key = code.slice('Key'.length);
  else if (/^Digit([0-9])$/.test(code)) key = code.slice('Digit'.length);
  else if (/^F([1-9]|1\d|2[0-4])$/.test(code)) key = code;
  else key = SPECIAL_KEY_CODES[code] ?? null;
  if (!key) return null;
  tokens.push(key);
  return tokens.join('+');
}

export function SettingsDialog({ themeCatalog = fallbackThemes }: { themeCatalog?: ThemeDefinition[] }) {
  const open = useUiStore((state) => state.settingsOpen);
  const setOpen = useUiStore((state) => state.setSettingsOpen);
  const setMusicPlayerEnabled = useUiStore((state) => state.setMusicPlayerEnabled);
  const setSendMessageWithModifier = useUiStore((state) => state.setSendMessageWithModifier);
  const setCompactSessions = useUiStore((state) => state.setCompactSessions);
  const setSpeech = useUiStore((state) => state.setSpeech);
  const models = useRuntimeStore((state) => state.runtime.models);
  const providerGroups = useMemo(() => groupModelsByProvider(models), [models]);
  const imageCompatibleProviderGroups = useMemo(
    () => providerGroups.filter((group) => group.models.some((model) => isOpenAICompatibleImageApi(model.api))),
    [providerGroups],
  );
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');
  const [selectedProvider, setSelectedProvider] = useState('');
  const [settings, setSettings] = useState<AppSettings>(fallback);
  const [persistedSettings, setPersistedSettings] = useState<AppSettings>(fallback);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [toast, setToast] = useState<SettingsToast | null>(null);
  const [saving, setSaving] = useState(false);
  const [checkingForUpdates, setCheckingForUpdates] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [updateProgress, setUpdateProgress] = useState<{ percent: number; version: string } | null>(null);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const updateProgressPending = useRef(false);
  const [speechStatus, setSpeechStatus] = useState<SpeechStatus | null>(null);
  const [speechBusy, setSpeechBusy] = useState<SpeechModelId | null>(null);
  const [speechProgress, setSpeechProgress] = useState<SpeechDownloadProgress | null>(null);
  const [speechStatusError, setSpeechStatusError] = useState<string | null>(null);
  const [capturingHotkey, setCapturingHotkey] = useState(false);
  const [hotkeyStatus, setHotkeyStatus] = useState<SpeechHotkeyStatus | null>(null);
  const [systemLoading, setSystemLoading] = useState(false);
  const [inputDevices, setInputDevices] = useState<MicrophoneDevice[]>([]);
  const [inputDevicesError, setInputDevicesError] = useState<string | null>(null);
  const [inputDevicesLoading, setInputDevicesLoading] = useState(false);
  const settingsScroll = useRef<HTMLDivElement>(null);
  const systemLoadStarted = useRef(false);
  const updateCheckPending = useRef(false);

  useEffect(() => {
    if (!open || !('piDesktop' in window)) return;
    let active = true;
    setSettingsLoaded(false);
    setDiagnostics(null); setDiagnosticsError(null);
    setLogs([]); setLogsError(null); setStatus(null); setToast(null);
    setUpdateResult(null);
    systemLoadStarted.current = false;
    setSystemLoading(false);
    setSpeechStatus(null); setSpeechStatusError(null);
    setInputDevices([]); setInputDevicesError(null); setInputDevicesLoading(false);
    const activeDownload = useUiStore.getState().speechDownload;
    setSpeechBusy(activeDownload?.modelId ?? null);
    setSpeechProgress(activeDownload);
    void window.piDesktop.getSettings()
      .then((nextSettings) => {
        if (!active) return;
        setSettings(nextSettings);
        setPersistedSettings(nextSettings);
        setSelectedProvider(nextSettings.defaultModel?.split('/')[0] ?? '');
        setSettingsLoaded(true);
      })
      .catch((error: unknown) => { if (active) setStatus(error instanceof Error ? error.message : 'Settings could not load.'); });
    const speechAvailable = typeof window.piDesktop.getSpeechStatus === 'function' && typeof window.piDesktop.onSpeechDownload === 'function';
    const removeSpeechListener = speechAvailable ? window.piDesktop.onSpeechDownload((progress) => {
      if (!active) return;
      setSpeechProgress(progress);
      setSpeechBusy((current) => progress.state === 'downloading' || progress.state === 'verifying'
        ? progress.modelId
        : current === progress.modelId ? null : current);
      setSpeechStatus((current) => current ? {
        ...current,
        models: current.models.map((model) => model.id === progress.modelId ? {
          ...model,
          downloadedBytes: progress.downloadedBytes,
          installed: progress.state === 'installed' ? true : model.installed,
        } : model),
      } : current);
    }) : () => undefined;
    return () => { active = false; removeSpeechListener(); };
  }, [open]);

  useEffect(() => {
    if (!open || activeSection !== 'voice' || !('piDesktop' in window) || typeof window.piDesktop.getSpeechStatus !== 'function') return;
    let active = true;
    setSpeechStatusError(null);
    void window.piDesktop.getSpeechStatus()
      .then((value) => { if (active) setSpeechStatus(value); })
      .catch((error: unknown) => {
        if (!active) return;
        setSpeechStatus(null);
        setSpeechStatusError(error instanceof Error ? error.message : 'Voice model status could not be loaded.');
      });
    return () => { active = false; };
  }, [activeSection, open]);

  useEffect(() => {
    if (!open || activeSection !== 'voice' || !('piDesktop' in window) || typeof window.piDesktop.getSpeechHotkeyStatus !== 'function') return;
    let active = true;
    window.piDesktop.getSpeechHotkeyStatus().then((status) => { if (active) setHotkeyStatus(status); }).catch(() => undefined);
    return () => { active = false; };
  }, [activeSection, open]);

  useEffect(() => {
    if (!capturingHotkey) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const accelerator = acceleratorFromEvent(event);
      if (!accelerator) return;
      setSettings((current) => ({ ...current, speech: { ...current.speech, voiceHotkey: accelerator } }));
      setCapturingHotkey(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [capturingHotkey]);

  useEffect(() => {
    if (!open || activeSection !== 'system' || systemLoadStarted.current || !('piDesktop' in window)) return;
    let active = true;
    systemLoadStarted.current = true;
    setSystemLoading(true);
    const diagnosticsRequest = window.piDesktop.getDiagnostics()
      .then((value) => { if (active) setDiagnostics(value); })
      .catch((error: unknown) => { if (active) setDiagnosticsError(error instanceof Error ? error.message : 'Diagnostics could not load.'); });
    const logsRequest = window.piDesktop.getLogs()
      .then((value) => { if (active) setLogs(value); })
      .catch((error: unknown) => { if (active) setLogsError(error instanceof Error ? error.message : 'Application logs could not load.'); });
    void Promise.allSettled([diagnosticsRequest, logsRequest]).then(() => { if (active) setSystemLoading(false); });
    return () => { active = false; };
  }, [activeSection, open]);

  useEffect(() => {
    if (!open || activeSection !== 'voice') return undefined;
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices || !mediaDevices.getUserMedia) {
      setInputDevices([]);
      setInputDevicesError('Microphone recording is not supported on this system.');
      setInputDevicesLoading(false);
      return undefined;
    }
    let active = true;
    const refresh = (requestAccess: boolean) => {
      if (requestAccess) setInputDevicesLoading(true);
      setInputDevicesError(null);
      const operation = requestAccess
        ? requestMicrophoneDevices(mediaDevices)
        : enumerateMicrophones(mediaDevices);
      void operation.then((devices) => {
        if (!active) return;
        setInputDevices(devices);
      }).catch((error: unknown) => {
        if (!active) return;
        setInputDevices([]);
        setInputDevicesError(microphoneAccessError(error));
      }).finally(() => {
        if (active && requestAccess) setInputDevicesLoading(false);
      });
    };
    const handleDeviceChange = () => refresh(false);
    const handleFocus = () => refresh(true);
    refresh(true);
    mediaDevices.addEventListener?.('devicechange', handleDeviceChange);
    window.addEventListener('focus', handleFocus);
    return () => {
      active = false;
      mediaDevices.removeEventListener?.('devicechange', handleDeviceChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [activeSection, open]);

  useEffect(() => {
    if (!open || !settingsLoaded) return;
    applyVisualSettings(settings, themeCatalog);
  }, [
    open,
    settings.appearance,
    settings.codeFont,
    settings.interfaceFont,
    settings.performanceMode,
    settings.reduceMotion,
    settings.holyShitMode,
    settings.themeId,
    settingsLoaded,
    themeCatalog,
  ]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), toast.kind === 'success' ? 3_200 : 6_000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const save = async () => {
    if (!('piDesktop' in window) || !settingsLoaded || saving) return;
    setSaving(true);
    setStatus('Saving changes…');
    setToast(null);
    try {
      const saved = await window.piDesktop.setSettings(settings);
      setSettings(saved);
      setPersistedSettings(saved);
      applyVisualSettings(saved, themeCatalog);
      setMusicPlayerEnabled(saved.musicPlayerEnabled);
      setSendMessageWithModifier(saved.sendMessageWithModifier);
      setCompactSessions(saved.compactSessions);
      setSpeech(saved.speech);
      setStatus(null);
      setToast({ kind: 'success', title: 'Settings saved', message: 'Your preferences are active.' });
    } catch (error) {
      setStatus(null);
      setToast({
        kind: 'error',
        title: 'Settings error',
        message: error instanceof Error ? error.message : 'Settings could not be saved. Try again.',
      });
    } finally {
      setSaving(false);
    }
  };

  const checkForUpdates = async () => {
    if (!('piDesktop' in window) || updateCheckPending.current || typeof window.piDesktop.checkForUpdates !== 'function') return;
    updateCheckPending.current = true;
    setCheckingForUpdates(true);
    setUpdateResult(null);
    try {
      setUpdateResult(await window.piDesktop.checkForUpdates());
    } catch {
      setUpdateResult({
        status: 'remote-unavailable',
        message: 'Unable to check for updates. Please check your internet connection and try again.',
      });
    } finally {
      updateCheckPending.current = false;
      setCheckingForUpdates(false);
    }
  };

  const openUpdateDownload = async () => {
    if (!('piDesktop' in window) || typeof window.piDesktop.openUpdateDownload !== 'function') return;
    try {
      await window.piDesktop.openUpdateDownload();
    } catch (error) {
      setToast({
        kind: 'error',
        title: 'Could not open releases',
        message: error instanceof Error ? error.message : 'Open the Fate UI releases page in your browser and try again.',
      });
    }
  };

  useEffect(() => {
    if (!('piDesktop' in window) || typeof window.piDesktop.onUpdatesProgress !== 'function') return;
    const unsubscribe = window.piDesktop.onUpdatesProgress((progress) => {
      setUpdateProgress({ percent: progress.percent, version: progress.version });
    });
    return unsubscribe;
  }, []);

  const downloadAndInstallUpdate = async () => {
    const version = updateResult?.productionVersion;
    if (!version || !('piDesktop' in window) || typeof window.piDesktop.downloadAndInstallUpdate !== 'function' || updateProgressPending.current) return;
    updateProgressPending.current = true;
    setUpdateInstalling(true);
    setUpdateProgress({ percent: 0, version });
    try {
      await window.piDesktop.downloadAndInstallUpdate(version);
      // The installer launches and the app quits; this line runs only if the
      // download finished but the launcher deferred the quit.
      setUpdateProgress({ percent: 1, version });
    } catch (error) {
      setUpdateInstalling(false);
      setUpdateProgress(null);
      setToast({
        kind: 'error',
        title: 'Update failed',
        message: error instanceof Error ? error.message : 'The update could not be downloaded. Try again or open the releases page.',
      });
    } finally {
      updateProgressPending.current = false;
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && settingsLoaded) applyVisualSettings(persistedSettings, themeCatalog);
    setOpen(nextOpen);
  };

  const chooseSection = (section: SettingsSection) => {
    setActiveSection(section);
    if (settingsScroll.current) settingsScroll.current.scrollTop = 0;
  };

  const selectedGroup = providerGroups.find((group) => group.provider === selectedProvider);
  const selectedModel = models.find((model) => `${model.provider}/${model.id}` === settings.defaultModel);
  const chooseProvider = (provider: string) => {
    setSelectedProvider(provider);
    const firstModel = providerGroups.find((group) => group.provider === provider)?.models[0];
    setSettings({ ...settings, defaultModel: firstModel ? `${firstModel.provider}/${firstModel.id}` : null });
  };

  const imageSettings = settings.imageGeneration;
  const imagePreset = imageGenerationPreset(imageSettings.provider);
  const imageProviderId = imageSettings.provider === 'custom' ? imageSettings.customProvider : imagePreset?.providerId ?? null;
  const selectedCustomImageProvider = imageCompatibleProviderGroups.find((group) => group.provider === imageSettings.customProvider);
  const unavailableCustomImageProvider = imageSettings.provider === 'custom' && imageSettings.customProvider && !selectedCustomImageProvider
    ? { value: imageSettings.customProvider, label: formatProviderName(imageSettings.customProvider), detail: 'Unavailable or not OpenAI-compatible' }
    : null;
  const customImageModelReady = Boolean(imageSettings.model?.trim());
  const imageProviderReady = imageSettings.provider === 'auto'
    ? imageGenerationProviderPresets.some((preset) => models.some((model) => model.provider === preset.providerId))
    : imageSettings.provider === 'custom'
      ? Boolean(selectedCustomImageProvider && customImageModelReady)
      : Boolean(imageProviderId && models.some((model) => model.provider === imageProviderId));
  const chooseImageProvider = (provider: string) => {
    const nextProvider = provider as ImageGenerationProviderId;
    setSettings({
      ...settings,
      imageGeneration: {
        provider: nextProvider,
        model: defaultImageGenerationModel(nextProvider),
        customProvider: nextProvider === 'custom' ? imageSettings.customProvider : null,
      },
    });
  };

  const refreshSpeech = async () => {
    if (!('piDesktop' in window)) return;
    setSpeechStatus(await window.piDesktop.getSpeechStatus());
  };

  const downloadSpeechModel = async (modelId: SpeechModelId) => {
    if (!('piDesktop' in window) || speechBusy) return;
    setSpeechBusy(modelId);
    setSpeechProgress(null);
    try {
      setSpeechStatus(await window.piDesktop.downloadSpeechModel(modelId));
      setToast({ kind: 'success', title: 'Voice model ready', message: 'The verified model is available for local transcription.' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The model could not be downloaded.';
      if (!message.toLowerCase().includes('cancel')) setToast({ kind: 'error', title: 'Model download failed', message });
      await refreshSpeech().catch(() => undefined);
    } finally {
      setSpeechBusy(null);
    }
  };

  const cancelSpeechDownload = async (modelId: SpeechModelId) => {
    if (!('piDesktop' in window)) return;
    try {
      await window.piDesktop.cancelSpeechModelDownload(modelId);
    } catch (error) {
      setToast({ kind: 'error', title: 'Could not cancel download', message: error instanceof Error ? error.message : 'The model download could not be cancelled.' });
    }
  };

  const removeSpeechModel = async (modelId: SpeechModelId) => {
    if (!('piDesktop' in window) || speechBusy) return;
    setSpeechBusy(modelId);
    try {
      setSpeechStatus(await window.piDesktop.removeSpeechModel(modelId));
    } catch (error) {
      setToast({ kind: 'error', title: 'Could not remove model', message: error instanceof Error ? error.message : 'The model could not be removed.' });
    } finally {
      setSpeechBusy(null);
    }
  };

  const speechTierLabels: Record<SpeechTier, string> = {
    mini: 'Fastest — instant results',
    balanced: 'Balanced — speed and accuracy',
    max: 'Highest accuracy',
  };
  const speechBackendLabel = !speechStatus
    ? 'Detecting acceleration…'
    : speechStatus.accelerated ? 'GPU acceleration active' : 'CPU fallback ready';
  const selectedInputUnavailable = Boolean(
    settings.speech.inputDeviceId
    && !inputDevices.some((device) => device.deviceId === settings.speech.inputDeviceId),
  );
  const inputDeviceDetail = inputDevicesError
    ?? (inputDevicesLoading
      ? 'Requesting microphone permission…'
      : inputDevices.length > 0
        ? `${inputDevices.length} ${inputDevices.length === 1 ? 'microphone' : 'microphones'} available.`
        : 'No named microphone inputs were detected.');
  const inputDeviceOptions = [
    { value: '', label: 'System default' },
    ...(selectedInputUnavailable && settings.speech.inputDeviceId
      ? [{ value: settings.speech.inputDeviceId, label: 'Unavailable microphone' }]
      : []),
    ...inputDevices.map((device) => ({
      value: device.deviceId,
      label: device.label || 'Unnamed microphone',
    })),
  ];

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="settings-dialog" aria-describedby="settings-description">
          <header className="settings-header">
            <div><Dialog.Title>Settings</Dialog.Title><Dialog.Description id="settings-description">Appearance, agent, voice, and workspace preferences.</Dialog.Description></div>
            <Dialog.Close aria-label="Close settings"><X size={17} /></Dialog.Close>
          </header>

          <div className="settings-layout">
            <nav className="settings-nav" aria-label="Settings categories" role="tablist" aria-orientation="vertical">
              {sections.map(({ id, label, detail, icon: Icon }) => (
                <button key={id} type="button" role="tab" id={`settings-tab-${id}`} aria-selected={activeSection === id} aria-controls={`settings-panel-${id}`} onClick={() => chooseSection(id)}>
                  <Icon size={16} aria-hidden="true" />
                  <span><strong>{label}</strong><small>{detail}</small></span>
                  {activeSection === id && <Check className="settings-nav-check" size={13} aria-hidden="true" />}
                </button>
              ))}
            </nav>

            <div ref={settingsScroll} className="settings-scroll">
              {activeSection === 'general' && (
                <div className="settings-panel" role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general">
                  <div className="settings-title"><span><Monitor size={17} /></span><div><h3>Interface</h3><p>Theme, type, and visual behavior across Fate UI.</p></div></div>
                  <div className="settings-group">
                    <div className="settings-theme-row"><div><strong>Theme</strong><small>Built-in, Fate custom, and Pi themes. Project themes load only after you trust the project.</small></div><SelectControl label="Interface theme" value={settings.themeId} className="settings-theme-select" options={themeCatalog.map((theme) => ({ value: theme.id, label: theme.name, detail: theme.tone === 'light' ? 'Light' : 'Dark' }))} onValueChange={(themeId) => setSettings({ ...settings, themeId })} /></div>
                  </div>
                  <div className="settings-group">
                    <label className="settings-toggle"><div><strong>Compact sessions</strong><small>Group sessions by project folder and show them as one-line rows with actions in a ⋯ menu. Turn off for detailed session cards.</small></div><input type="checkbox" checked={settings.compactSessions} onChange={(event) => setSettings({ ...settings, compactSessions: event.target.checked })} /><span aria-hidden="true" /></label>
                  </div>
                  <div className="settings-title settings-title--spaced"><span><Type size={17} /></span><div><h3>Typography</h3><p>Bundled typefaces with a Noto fallback chain for extended Unicode.</p></div></div>
                  <div className="settings-group settings-font-group">
                    <div className="settings-theme-row"><div><strong>Interface font</strong><small>Applies across navigation, settings, and conversation text.</small></div><SelectControl label="Interface font" value={settings.interfaceFont} className="settings-font-select" options={interfaceFontOptions} onValueChange={(interfaceFont) => setSettings({ ...settings, interfaceFont: interfaceFont as AppSettings['interfaceFont'] })} /></div>
                    <div className="settings-theme-row"><div><strong>Code & terminal</strong><small>Used for code, tool output, diffs, and the integrated terminal.</small></div><SelectControl label="Code and terminal font" value={settings.codeFont} className="settings-font-select" options={codeFontOptions} onValueChange={(codeFont) => setSettings({ ...settings, codeFont: codeFont as AppSettings['codeFont'] })} /></div>
                    <div className="settings-font-preview" aria-label="Extended Unicode font preview"><span lang="hr">Čć Đđ Šš Žž</span><span lang="ru">Привет</span><span lang="hi">नमस्ते</span><span lang="he" dir="rtl">שלום</span><span lang="zh-Hans">中文</span></div>
                  </div>
                  <div className="settings-title settings-title--spaced"><span><Gauge size={17} /></span><div><h3>Performance</h3><p>Lower rendering cost without disabling any app capability.</p></div></div>
                  <div className="settings-group">
                    <label className="settings-toggle"><div><strong>Performance mode</strong><small>Includes Reduced Motion and disables transitions, entrance motion, ambient gradients, blur, and deep shadows.</small></div><input type="checkbox" checked={settings.performanceMode || settings.reduceMotion} onChange={(event) => setSettings({ ...settings, performanceMode: event.target.checked, reduceMotion: event.target.checked })} /><span aria-hidden="true" /></label>
                    <label className="settings-toggle"><div><strong>Holy sh*t</strong><small>Bare-bones fallback for very weak hardware: removes gradients, shadows, blur, animation, and smooth scrolling. Turn it off to restore your visual settings.</small></div><input type="checkbox" checked={settings.holyShitMode} onChange={(event) => setSettings({ ...settings, holyShitMode: event.target.checked })} /><span aria-hidden="true" /></label>
                  </div>
                  <div className="settings-title settings-title--spaced"><span><Music2 size={17} /></span><div><h3>Ambient audio</h3><p>An optional player that stays separate from Pi and your project.</p></div></div>
                  <div className="settings-group">
                    <label className="settings-toggle"><div><strong>Music player</strong><small>Shows the minimal lower-right dock. Requires yt-dlp on PATH and accepts user-supplied HTTPS links or playlists.</small></div><input type="checkbox" checked={settings.musicPlayerEnabled} onChange={(event) => setSettings({ ...settings, musicPlayerEnabled: event.target.checked })} /><span aria-hidden="true" /></label>
                  </div>
                </div>
              )}

              {activeSection === 'agent' && (
                <div className="settings-panel" role="tabpanel" id="settings-panel-agent" aria-labelledby="settings-tab-agent">
                  <div className="settings-title"><span><Bot size={17} /></span><div><h3>Agent defaults</h3><p>Fallbacks for the first Pi session opened in a project. Later sessions inherit the active composer settings.</p></div></div>
                  <div className="settings-model-picker">
                    <div className="settings-model-heading"><div><strong>Default model</strong><small>Models are separated by provider so the catalog stays clear as it grows.</small></div>{selectedProvider && <span>{formatProviderName(selectedProvider)}</span>}</div>
                    <div className="settings-model-controls">
                      <div className="settings-select-field"><span>Provider</span><SelectControl label="Default provider" value={selectedProvider} options={[{ value: '', label: 'Automatic · Pi default' }, ...providerGroups.map((group) => ({ value: group.provider, label: group.title, detail: `${group.models.length} ${group.models.length === 1 ? 'model' : 'models'}` }))]} onValueChange={chooseProvider} /></div>
                      <div className="settings-select-field"><span>Model</span><SelectControl label="Default model" value={settings.defaultModel ?? ''} disabled={!selectedGroup} options={[{ value: '', label: 'Select a model' }, ...(selectedGroup?.models.map((model) => ({ value: `${model.provider}/${model.id}`, label: model.name, ...(model.name === model.id ? {} : { detail: model.id }) })) ?? [])]} onValueChange={(value) => setSettings({ ...settings, defaultModel: value || null })} /></div>
                    </div>
                    <div className="settings-model-meta">{selectedModel ? <><span>{selectedModel.reasoning ? 'Reasoning' : 'Standard'}</span><span>{Math.round(selectedModel.contextWindow / 1000)}k context</span>{selectedModel.supportsImages && <span>Images</span>}</> : <span>Pi chooses the active provider and model.</span>}</div>
                  </div>
                  <div className="settings-select-row"><div><strong>Thinking level</strong><small>Initial reasoning effort when a project starts without an active session.</small></div><SelectControl label="Default thinking level" value={settings.thinkingLevel} className="settings-thinking-select" options={['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((level) => ({ value: level, label: level === 'xhigh' ? 'Extra high' : `${level[0]?.toUpperCase() ?? ''}${level.slice(1)}` }))} onValueChange={(value) => setSettings({ ...settings, thinkingLevel: value as AppSettings['thinkingLevel'] })} /></div>
                  <div className="settings-select-row"><div><strong>Agent orchestration</strong><small>Agent Teams V2 enables recursive child/grandchild delegation with durable context and hard safety limits. Applies when the project is reopened.</small></div><SelectControl label="Agent orchestration mode" value={settings.agentTeamMode} options={[{ value: 'legacy', label: 'Legacy subagents', detail: 'Flat managed agents and deterministic workflows' }, { value: 'v2', label: 'Agent Teams V2 (beta)', detail: 'Recursive provider-neutral teams' }]} onValueChange={(value) => setSettings({ ...settings, agentTeamMode: value as AppSettings['agentTeamMode'] })} /></div>

                  <div className="settings-title settings-title--spaced"><span><ImageIcon size={17} /></span><div><h3>Image generation</h3><p>A dedicated image route, independent from the chat model and secured by Pi’s existing provider authentication.</p></div></div>
                  <div className="image-provider-config">
                    <div className="settings-model-controls">
                      <div className="settings-select-field"><span>Provider route</span><SelectControl label="Image generation provider" value={imageSettings.provider} options={[{ value: 'auto', label: 'Automatic', detail: 'Best authenticated Pi provider' }, ...imageGenerationProviderPresets.map((preset) => ({ value: preset.id, label: preset.name, detail: preset.auth })), { value: 'custom', label: 'Custom Pi provider', detail: 'OpenAI-compatible Images API' }]} onValueChange={chooseImageProvider} /></div>
                      {imageSettings.provider === 'custom' ? (
                        <div className="settings-select-field"><span>Pi provider</span><SelectControl label="Custom image provider" value={imageSettings.customProvider ?? ''} options={[{ value: '', label: 'Select an OpenAI-compatible provider' }, ...(unavailableCustomImageProvider ? [unavailableCustomImageProvider] : []), ...imageCompatibleProviderGroups.map((group) => ({ value: group.provider, label: group.title, detail: 'Base URL and auth inherited from Pi' }))]} onValueChange={(customProvider) => setSettings({ ...settings, imageGeneration: { ...imageSettings, customProvider: customProvider || null } })} /></div>
                      ) : (
                        <div className="settings-select-field"><span>Image model</span><SelectControl label="Image generation model" value={imageSettings.model ?? ''} disabled={imageSettings.provider === 'auto'} options={imageSettings.provider === 'auto' ? [{ value: '', label: 'Chosen automatically' }] : (imagePreset?.models.map((model) => ({ value: model.id, label: model.name, detail: model.detail })) ?? [])} onValueChange={(model) => setSettings({ ...settings, imageGeneration: { ...imageSettings, model: model || null } })} /></div>
                      )}
                    </div>
                    {imageSettings.provider === 'custom' && (
                      <label className="image-model-input"><span>Image model ID</span><input value={imageSettings.model ?? ''} placeholder="Your deployed image model" onChange={(event) => setSettings({ ...settings, imageGeneration: { ...imageSettings, model: event.target.value || null } })} /></label>
                    )}
                    <div className="image-provider-status" data-ready={imageProviderReady}>
                      <LockKeyhole size={15} aria-hidden="true" />
                      <div><strong>{imageSettings.provider === 'auto' ? imageProviderReady ? 'Pi chooses at generation time' : 'No image provider authenticated in Pi' : imageProviderReady ? 'Ready through Pi' : imageSettings.provider === 'custom' && selectedCustomImageProvider && !customImageModelReady ? 'Choose an image model ID' : 'Provider not authenticated in Pi'}</strong><span>{imagePreset?.description ?? (imageSettings.provider === 'custom' ? 'The base URL and credential come from ~/.pi/agent/models.json; only /images/generations is appended.' : 'Priority: ChatGPT OAuth, OpenAI, Gemini, then OpenRouter.')}</span></div>
                    </div>
                    <dl className="image-provider-route">
                      <div><dt>Authentication</dt><dd>{imagePreset?.auth ?? (imageSettings.provider === 'custom' ? 'Pi-managed provider credential' : 'Automatic · no credentials exposed')}</dd></div>
                      <div><dt>Endpoint</dt><dd><code>{imagePreset?.endpoint ?? (imageSettings.provider === 'custom' ? 'Pi base URL + /images/generations' : 'Selected Pi provider endpoint')}</code></dd></div>
                    </dl>
                    {!imageProviderReady && <p className="image-provider-help">{imageSettings.provider === 'custom' && selectedCustomImageProvider && !customImageModelReady ? 'Enter the exact image model ID deployed by this provider.' : <>Authenticate a supported provider with Pi <code>/login</code>, or configure it in <code>~/.pi/agent/models.json</code>. Fate UI never stores or displays the credential.</>}</p>}
                  </div>
                </div>
              )}

              {activeSection === 'voice' && (
                <div className="settings-panel" role="tabpanel" id="settings-panel-voice" aria-labelledby="settings-tab-voice">
                  <div className="settings-title"><span><Mic2 size={17} /></span><div><h3>Voice input</h3><p>Private, on-device speech-to-text for the message composer.</p></div></div>
                  <div className="settings-group">
                    <label className="settings-toggle"><div><strong>Microphone button</strong><small>Show voice input beside Send. Audio stays on this device.</small></div><input type="checkbox" checked={settings.speech.enabled} onChange={(event) => setSettings({ ...settings, speech: { ...settings.speech, enabled: event.target.checked } })} /><span aria-hidden="true" /></label>
                  </div>
                  <div className="settings-title settings-title--spaced"><span><Mic2 size={17} /></span><div><h3>Input device</h3><p>Choose the microphone used for voice prompts on this computer.</p></div></div>
                  <div className="settings-group voice-device-group">
                    <div className="settings-theme-row">
                      <div><strong>Microphone</strong><small>{inputDeviceDetail}</small></div>
                      <SelectControl label="Voice input device" value={settings.speech.inputDeviceId ?? ''} className="voice-device-select" disabled={inputDevicesLoading} options={inputDeviceOptions} onValueChange={(inputDeviceId) => setSettings({ ...settings, speech: { ...settings.speech, inputDeviceId: inputDeviceId || null } })} />
                    </div>
                  </div>
                  <div className="voice-backend-status" data-accelerated={speechStatus?.accelerated ?? false}>
                    <Gauge size={15} aria-hidden="true" />
                    <div><strong>{speechBackendLabel}</strong><span>{speechStatus?.backend ?? 'Selecting the best available local backend…'}</span></div>
                  </div>
                  <div className="settings-title settings-title--spaced"><span><Download size={17} /></span><div><h3>Model power</h3><p>Pick a model per accuracy tier. Mini downloads automatically on first use. “Live” models show words while you speak.</p></div></div>
                  <div className="voice-model-list" aria-label="Voice transcription models">
                    {speechStatus?.models.reduce<React.ReactElement[]>((rows, model, index, models) => {
                      const previous = models[index - 1];
                      if (!previous || previous.tier !== model.tier) {
                        rows.push(<div className="voice-model-tier-group" key={`tier-${model.tier}`}>{speechTierLabels[model.tier]}</div>);
                      }
                      const selected = settings.speech.modelId === model.id;
                      const activeProgress = speechProgress?.modelId === model.id && (speechProgress.state === 'downloading' || speechProgress.state === 'verifying') ? speechProgress : null;
                      const percent = activeProgress ? Math.min(100, Math.round(activeProgress.downloadedBytes / activeProgress.totalBytes * 100)) : 0;
                      rows.push(
                        <div className="voice-model-row" data-selected={selected} key={model.id}>
                          <button className="voice-model-choice" type="button" aria-pressed={selected} onClick={() => setSettings({ ...settings, speech: { ...settings.speech, modelId: model.id } })}>
                            <span className="voice-model-tier">{model.name}{model.streaming ? <em className="voice-model-live">live</em> : null}</span>
                            <span className="voice-model-copy"><strong>{model.model}</strong><small>{model.description}</small><AppTooltip content={model.detail}><em>{model.detail}</em></AppTooltip></span>
                          </button>
                          <div className="voice-model-action">
                            {speechBusy === model.id ? <AppTooltip content="Cancel download" sideOffset={7}><button type="button" className="voice-download-cancel" aria-label={`Cancel ${model.name} voice model download`} onClick={() => void cancelSpeechDownload(model.id)}><LoaderCircle className="voice-download-spinner" size={15} /><X className="voice-download-x" size={15} /><span className="icon-label">{activeProgress?.state === 'verifying' ? 'Verifying' : `${percent}%`}</span></button></AppTooltip> : model.installed ? <AppTooltip content="Remove downloaded model"><button type="button" aria-label={`Remove ${model.name} voice model`} onClick={() => void removeSpeechModel(model.id)}><Trash2 size={14} /><span className="icon-label">Installed</span></button></AppTooltip> : <button type="button" aria-label={`Download ${model.name} voice model`} onClick={() => void downloadSpeechModel(model.id)}><Download size={14} /><span className="icon-label">Download</span></button>}
                          </div>
                          {activeProgress && speechBusy === model.id && <progress aria-label={`${model.name} model download`} max={activeProgress.totalBytes} value={activeProgress.downloadedBytes} />}
                        </div>,
                      );
                      return rows;
                    }, []) ?? (speechStatusError
                      ? <div className="voice-model-error" role="alert"><CircleAlert size={15} /><span className="icon-label">{speechStatusError}</span></div>
                      : <div className="settings-skeleton"><span /><span /><span /></div>)}
                  </div>
                  <p className="voice-license-note">Models download from pinned Hugging Face releases, are SHA-256 verified before installation, and retain their upstream licenses. Supported hardware acceleration is used when stable; otherwise transcription uses CPU safety mode.</p>
                  <div className="settings-title settings-title--spaced"><span><Keyboard size={17} /></span><div><h3>Live transcription &amp; hotkey</h3><p>See voice input as you speak. Trigger it from any application with a global hotkey.</p></div></div>
                  <div className="settings-group">
                    <label className="settings-toggle"><div><strong>Live transcription</strong><small>Show words in the composer while you speak when the selected model supports it. Silence is filtered before decoding, so pauses cost no CPU.</small></div><input type="checkbox" checked={settings.speech.liveTranscription} onChange={(event) => setSettings({ ...settings, speech: { ...settings.speech, liveTranscription: event.target.checked } })} /><span aria-hidden="true" /></label>
                    <label className="settings-toggle"><div><strong>Final accuracy pass</strong><small>After you stop speaking, re-run the whole recording once for a cleaner transcript. Costs extra time and CPU; off by default.</small></div><input type="checkbox" checked={settings.speech.finalAccuracyPass} onChange={(event) => setSettings({ ...settings, speech: { ...settings.speech, finalAccuracyPass: event.target.checked } })} /><span aria-hidden="true" /></label>
                  </div>
                  <div className="settings-theme-row voice-hotkey-row">
                    <div><strong>Voice hotkey</strong><small>{settings.speech.voiceHotkey ? `Press ${settings.speech.voiceHotkey} ${settings.speech.voiceHotkeyMode === 'push-to-talk' ? 'and hold to talk' : 'to toggle recording'}.` : 'Off — use the microphone button in the composer instead.'}</small></div>
                    <div className="voice-hotkey-controls">
                      <button type="button" className="voice-hotkey-capture" data-active={capturingHotkey || undefined} aria-pressed={capturingHotkey} onClick={() => setCapturingHotkey((value) => !value)}>{capturingHotkey ? 'Press keys…' : (settings.speech.voiceHotkey ?? 'Record')}</button>
                      {settings.speech.voiceHotkey && <button type="button" className="voice-hotkey-clear" aria-label="Clear voice hotkey" onClick={() => setSettings({ ...settings, speech: { ...settings.speech, voiceHotkey: null } })}><X size={14} /></button>}
                      <SelectControl label="Voice hotkey mode" value={settings.speech.voiceHotkeyMode} options={[{ value: 'toggle', label: 'Toggle' }, { value: 'push-to-talk', label: 'Push to talk' }]} onValueChange={(value) => setSettings({ ...settings, speech: { ...settings.speech, voiceHotkeyMode: value as VoiceHotkeyMode } })} />
                    </div>
                  </div>
                  {hotkeyStatus && !hotkeyStatus.pushToTalkAvailable && settings.speech.voiceHotkeyMode === 'push-to-talk' && (
                    <div className="voice-model-error" role="alert"><CircleAlert size={15} /><span className="icon-label">{hotkeyStatus.reason ?? 'Push-to-talk is unavailable on this platform. Toggle mode still works.'}</span></div>
                  )}
                </div>
              )}

              {activeSection === 'workspace' && (
                <div className="settings-panel" role="tabpanel" id="settings-panel-workspace" aria-labelledby="settings-tab-workspace">
                  <div className="settings-title"><span><ShieldCheck size={17} /></span><div><h3>Project trust</h3><p>Clear boundaries between Pi actions and your manual tools.</p></div></div>
                  <div className="settings-notice"><ShieldCheck size={17} /><div><strong>Project-confined by default</strong><p>Read only and Edit files stay inside the trusted project. Full access explicitly unlocks host files and shell execution, is saved per session, and is not sandboxed.</p></div></div>
                  <div className="settings-title settings-title--spaced"><span><TerminalSquare size={17} /></span><div><h3>Terminal</h3><p>Choose the shell opened by the manual integrated terminal.</p></div></div>
                  <label className="settings-input-row"><span>Shell executable</span><input value={settings.terminalShell ?? ''} onChange={(event) => setSettings({ ...settings, terminalShell: event.target.value || null })} placeholder="System default" /></label>
                  <div className="settings-title settings-title--spaced"><span><Keyboard size={17} /></span><div><h3>Message composer</h3><p>Choose whether sending uses the primary modifier key.</p></div></div>
                  <div className="settings-group">
                    <label className="settings-toggle"><div><strong>Ctrl/⌘ Enter to send</strong><small>When enabled, Enter inserts a new line. When off, Enter sends and Shift+Enter inserts a new line.</small></div><input type="checkbox" checked={settings.sendMessageWithModifier} onChange={(event) => setSettings({ ...settings, sendMessageWithModifier: event.target.checked })} /><span aria-hidden="true" /></label>
                  </div>
                  <div className="settings-title settings-title--spaced"><span><Keyboard size={17} /></span><div><h3>Keyboard shortcuts</h3><p>Fast paths that work anywhere in the workspace.</p></div></div>
                  <dl className="settings-shortcuts"><div><dt>Command palette</dt><dd>Ctrl/⌘ K</dd></div><div><dt>Terminal</dt><dd>Ctrl/⌘ `</dd></div><div><dt>New session</dt><dd>Ctrl/⌘ N</dd></div><div><dt>Settings</dt><dd>Ctrl/⌘ ,</dd></div><div><dt>Stop generation</dt><dd>Esc</dd></div></dl>
                </div>
              )}

              {activeSection === 'system' && (
                <div className="settings-panel" role="tabpanel" id="settings-panel-system" aria-labelledby="settings-tab-system">
                  <div className="settings-title"><span><Activity size={17} /></span><div><h3>Pi diagnostics</h3><p>Local runtime details for troubleshooting.</p></div></div>
                  {diagnosticsError
                    ? <p className="settings-error">{diagnosticsError}</p>
                    : diagnostics
                      ? <dl className="settings-diagnostics">{Object.entries(diagnostics).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value === null ? '—' : String(value)}</dd></div>)}</dl>
                      : systemLoading || !systemLoadStarted.current
                        ? <div className="settings-skeleton" aria-label="Loading diagnostics"><span /><span /><span /></div>
                        : <p className="settings-empty">No diagnostics were returned.</p>}
                  <div className="settings-title settings-title--spaced"><span><Activity size={17} /></span><div><h3>Application logs</h3><p>The latest local events, newest first.</p></div></div>
                  <div className="settings-logs">{logsError ? <p className="settings-error">{logsError}</p> : logs.length ? logs.slice(-100).reverse().map((entry) => <div key={`${entry.timestamp}-${entry.message}`}><time>{new Date(entry.timestamp).toLocaleTimeString()}</time><strong>{entry.level}</strong><span>{entry.scope}: {entry.message}</span></div>) : <p>{systemLoading ? 'Loading application logs…' : 'No application logs yet.'}</p>}</div>
                </div>
              )}
            </div>
          </div>

          {toast && (
            <div className={`settings-toast settings-toast--${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
              {toast.kind === 'success' ? <CheckCircle2 size={17} aria-hidden="true" /> : <CircleAlert size={17} aria-hidden="true" />}
              <div><strong>{toast.title}</strong><span>{toast.message}</span></div>
              <button type="button" aria-label="Dismiss settings notification" onClick={() => setToast(null)}><X size={13} /></button>
            </div>
          )}

          <footer>
            <div className="settings-footer-status" aria-live="polite">
              <span>{status ?? (settingsLoaded ? 'Changes apply after saving.' : 'Loading settings…')}</span>
              {updateResult && (updateResult.status === 'available'
                ? (updateInstalling && updateProgress
                    ? <span className="update-check-result" role="status">Installing {updateProgress.version}… {Math.round(updateProgress.percent * 100)}%</span>
                    : <button type="button" className="update-download-link" disabled={updateInstalling} onClick={() => void downloadAndInstallUpdate()}>Download &amp; install {updateResult.productionVersion ?? 'update'}</button>)
                : <span className="update-check-result" role="status">{updateResult.message}</span>)}
            </div>
            <div className="settings-footer-actions">
              <button type="button" className="update-check-link" aria-busy={checkingForUpdates} disabled={checkingForUpdates} onClick={() => void checkForUpdates()}>{checkingForUpdates ? 'Checking for updates…' : 'Check for Updates'}</button>
              <button type="button" className="primary-button" aria-busy={saving} disabled={!settingsLoaded || saving} onClick={() => void save()}><Save size={14} /><span className="icon-label">Save changes</span></button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
