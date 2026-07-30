import * as Dialog from '@radix-ui/react-dialog';
import {
  Activity,
  Bot,
  Check,
  CheckCircle2,
  CircleAlert,
  Gauge,
  Keyboard,
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
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, Diagnostics, LogEntry, ModelInfo, SpeechDownloadProgress, SpeechModelId, SpeechStatus } from '../../../shared/contracts/ipc';
import type { ThemeDefinition } from '../../../shared/themes';
import { applyVisualSettings } from '../../appearance';
import { AppTooltip } from '../../components/AppTooltip';
import { SelectControl } from '../../components/SelectControl';
import { codeFontOptions, interfaceFontOptions } from '../../fonts';
import { fallbackThemes } from '../../theme';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { enumerateMicrophones, microphoneAccessError, requestMicrophoneDevices, type MicrophoneDevice } from './microphoneDevices';

const fallback: AppSettings = {
  appearance: 'dark', defaultModel: null, thinkingLevel: 'medium', confirmRiskyCommands: true,
  terminalShell: null, reduceMotion: false, performanceMode: false, holyShitMode: false, musicPlayerEnabled: false, sendMessageWithModifier: false, themeId: 'midnight',
  interfaceFont: 'noto-sans', codeFont: 'jetbrains-mono',
  speech: { enabled: true, modelId: 'mini', language: 'auto', inputDeviceId: null },
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
  anthropic: 'Anthropic', google: 'Google', openai: 'OpenAI', openrouter: 'OpenRouter',
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

export function SettingsDialog() {
  const open = useUiStore((state) => state.settingsOpen);
  const setOpen = useUiStore((state) => state.setSettingsOpen);
  const setMusicPlayerEnabled = useUiStore((state) => state.setMusicPlayerEnabled);
  const setSendMessageWithModifier = useUiStore((state) => state.setSendMessageWithModifier);
  const setSpeech = useUiStore((state) => state.setSpeech);
  const models = useRuntimeStore((state) => state.runtime.models);
  const providerGroups = useMemo(() => groupModelsByProvider(models), [models]);
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');
  const [selectedProvider, setSelectedProvider] = useState('');
  const [settings, setSettings] = useState<AppSettings>(fallback);
  const [persistedSettings, setPersistedSettings] = useState<AppSettings>(fallback);
  const [themes, setThemes] = useState<ThemeDefinition[]>(fallbackThemes);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [toast, setToast] = useState<SettingsToast | null>(null);
  const [saving, setSaving] = useState(false);
  const [speechStatus, setSpeechStatus] = useState<SpeechStatus | null>(null);
  const [speechBusy, setSpeechBusy] = useState<SpeechModelId | null>(null);
  const [speechProgress, setSpeechProgress] = useState<SpeechDownloadProgress | null>(null);
  const [speechStatusError, setSpeechStatusError] = useState<string | null>(null);
  const [systemLoading, setSystemLoading] = useState(false);
  const [inputDevices, setInputDevices] = useState<MicrophoneDevice[]>([]);
  const [inputDevicesError, setInputDevicesError] = useState<string | null>(null);
  const [inputDevicesLoading, setInputDevicesLoading] = useState(false);
  const settingsScroll = useRef<HTMLDivElement>(null);
  const systemLoadStarted = useRef(false);

  useEffect(() => {
    if (!open || !('piDesktop' in window)) return;
    let active = true;
    setSettingsLoaded(false);
    setDiagnostics(null); setDiagnosticsError(null);
    setLogs([]); setLogsError(null); setStatus(null); setToast(null);
    systemLoadStarted.current = false;
    setSystemLoading(false);
    setSpeechStatus(null); setSpeechStatusError(null);
    setInputDevices([]); setInputDevicesError(null); setInputDevicesLoading(false);
    const activeDownload = useUiStore.getState().speechDownload;
    setSpeechBusy(activeDownload?.modelId ?? null);
    setSpeechProgress(activeDownload);
    const themesPromise = typeof window.piDesktop.getThemes === 'function'
      ? window.piDesktop.getThemes().catch(() => fallbackThemes)
      : Promise.resolve(fallbackThemes);
    void Promise.all([window.piDesktop.getSettings(), themesPromise])
      .then(([nextSettings, nextThemes]) => {
        if (!active) return;
        setThemes(nextThemes);
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
    applyVisualSettings(settings, themes);
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
    themes,
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
      applyVisualSettings(saved, themes);
      setMusicPlayerEnabled(saved.musicPlayerEnabled);
      setSendMessageWithModifier(saved.sendMessageWithModifier);
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

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && settingsLoaded) applyVisualSettings(persistedSettings, themes);
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
                    <div className="settings-theme-row"><div><strong>Theme</strong><small>Built-in themes and validated custom themes from ~/.pi/fateGUI/themes.json.</small></div><SelectControl label="Interface theme" value={settings.themeId} className="settings-theme-select" options={themes.map((theme) => ({ value: theme.id, label: theme.name, detail: theme.tone === 'light' ? 'Light' : 'Dark' }))} onValueChange={(themeId) => setSettings({ ...settings, themeId })} /></div>
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
                  <div className="settings-title settings-title--spaced"><span><Download size={17} /></span><div><h3>Model power</h3><p>Choose one local accuracy tier. Mini downloads automatically on first use.</p></div></div>
                  <div className="voice-model-list" aria-label="Voice transcription models">
                    {speechStatus?.models.map((model) => {
                      const selected = settings.speech.modelId === model.id;
                      const activeProgress = speechProgress?.modelId === model.id && (speechProgress.state === 'downloading' || speechProgress.state === 'verifying') ? speechProgress : null;
                      const percent = activeProgress ? Math.min(100, Math.round(activeProgress.downloadedBytes / activeProgress.totalBytes * 100)) : 0;
                      return (
                        <div className="voice-model-row" data-selected={selected} key={model.id}>
                          <button className="voice-model-choice" type="button" aria-pressed={selected} onClick={() => setSettings({ ...settings, speech: { ...settings.speech, modelId: model.id } })}>
                            <span className="voice-model-tier">{model.name}</span>
                            <span className="voice-model-copy"><strong>{model.model}</strong><small>{model.description}</small><AppTooltip content={model.detail}><em>{model.detail}</em></AppTooltip></span>
                          </button>
                          <div className="voice-model-action">
                            {speechBusy === model.id ? <AppTooltip content="Cancel download" sideOffset={7}><button type="button" className="voice-download-cancel" aria-label={`Cancel ${model.name} voice model download`} onClick={() => void cancelSpeechDownload(model.id)}><LoaderCircle className="voice-download-spinner" size={15} /><X className="voice-download-x" size={15} /><span className="icon-label">{activeProgress?.state === 'verifying' ? 'Verifying' : `${percent}%`}</span></button></AppTooltip> : model.installed ? <AppTooltip content="Remove downloaded model"><button type="button" aria-label={`Remove ${model.name} voice model`} onClick={() => void removeSpeechModel(model.id)}><Trash2 size={14} /><span className="icon-label">Installed</span></button></AppTooltip> : <button type="button" aria-label={`Download ${model.name} voice model`} onClick={() => void downloadSpeechModel(model.id)}><Download size={14} /><span className="icon-label">Download</span></button>}
                          </div>
                          {activeProgress && speechBusy === model.id && <progress aria-label={`${model.name} model download`} max={activeProgress.totalBytes} value={activeProgress.downloadedBytes} />}
                        </div>
                      );
                    }) ?? (speechStatusError
                      ? <div className="voice-model-error" role="alert"><CircleAlert size={15} /><span className="icon-label">{speechStatusError}</span></div>
                      : <div className="settings-skeleton"><span /><span /><span /></div>)}
                  </div>
                  <p className="voice-license-note">Models download from pinned Hugging Face releases, are SHA-256 verified before installation, and retain their upstream licenses. Supported hardware acceleration is used when stable; otherwise transcription uses CPU safety mode.</p>
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

          <footer><span aria-live="polite">{status ?? (settingsLoaded ? 'Changes apply after saving.' : 'Loading settings…')}</span><button type="button" className="primary-button" aria-busy={saving} disabled={!settingsLoaded || saving} onClick={() => void save()}><Save size={14} /><span className="icon-label">Save changes</span></button></footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
