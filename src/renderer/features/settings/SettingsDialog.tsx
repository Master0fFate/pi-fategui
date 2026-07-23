import * as Dialog from '@radix-ui/react-dialog';
import { Activity, Keyboard, Monitor, Save, ShieldCheck, TerminalSquare, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AppSettings, Diagnostics, LogEntry } from '../../../shared/contracts/ipc';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';

const fallback: AppSettings = {
  appearance: 'dark', defaultModel: null, thinkingLevel: 'medium', confirmRiskyCommands: true,
  terminalShell: null, reduceMotion: false,
};

export function SettingsDialog() {
  const open = useUiStore((state) => state.settingsOpen);
  const setOpen = useUiStore((state) => state.setSettingsOpen);
  const models = useRuntimeStore((state) => state.runtime.models);
  const [settings, setSettings] = useState<AppSettings>(fallback);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !('piDesktop' in window)) return;
    let active = true;
    void Promise.all([window.piDesktop.getSettings(), window.piDesktop.getDiagnostics(), window.piDesktop.getLogs()])
      .then(([nextSettings, nextDiagnostics, nextLogs]) => {
        if (!active) return;
        setSettings(nextSettings); setDiagnostics(nextDiagnostics); setLogs(nextLogs);
      })
      .catch((error: unknown) => { if (active) setStatus(error instanceof Error ? error.message : 'Settings could not load.'); });
    return () => { active = false; };
  }, [open]);

  const save = async () => {
    if (!('piDesktop' in window)) return;
    setStatus('Saving…');
    try {
      const saved = await window.piDesktop.setSettings(settings);
      setSettings(saved);
      document.documentElement.dataset.reduceMotion = String(saved.reduceMotion);
      document.documentElement.dataset.appearance = saved.appearance;
      setStatus('Saved');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Settings could not be saved.');
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="settings-dialog" aria-describedby="settings-description">
          <header><div><Dialog.Title>Settings</Dialog.Title><Dialog.Description id="settings-description">Pi Desktop preferences and local diagnostics</Dialog.Description></div><Dialog.Close aria-label="Close settings"><X size={17} /></Dialog.Close></header>
          <div className="settings-scroll">
            <section><h3><Monitor size={15} />Appearance</h3><label>Theme<select value={settings.appearance} onChange={(event) => setSettings({ ...settings, appearance: event.target.value as AppSettings['appearance'] })}><option value="dark">Dark</option><option value="system">Follow system (dark-first)</option></select></label><label className="check"><input type="checkbox" checked={settings.reduceMotion} onChange={(event) => setSettings({ ...settings, reduceMotion: event.target.checked })} />Reduce nonessential motion</label></section>
            <section><h3><Activity size={15} />Agent defaults</h3><label>Default model<select value={settings.defaultModel ?? ''} onChange={(event) => setSettings({ ...settings, defaultModel: event.target.value || null })}><option value="">Use Pi default</option>{models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name}</option>)}</select></label><label>Thinking level<select value={settings.thinkingLevel} onChange={(event) => setSettings({ ...settings, thinkingLevel: event.target.value as AppSettings['thinkingLevel'] })}>{['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((level) => <option key={level}>{level}</option>)}</select></label></section>
            <section><h3><ShieldCheck size={15} />Project trust & safety</h3><label className="check"><input type="checkbox" checked={settings.confirmRiskyCommands} onChange={(event) => setSettings({ ...settings, confirmRiskyCommands: event.target.checked })} />Confirm risky GUI-launched commands</label><p>Pi-generated tools remain governed by Pi and are shown separately from the manual terminal.</p></section>
            <section><h3><TerminalSquare size={15} />Terminal</h3><label>Shell executable<input value={settings.terminalShell ?? ''} onChange={(event) => setSettings({ ...settings, terminalShell: event.target.value || null })} placeholder="System default" /></label></section>
            <section><h3><Keyboard size={15} />Keyboard shortcuts</h3><dl><div><dt>Command palette</dt><dd>Ctrl/⌘ K</dd></div><div><dt>Terminal</dt><dd>Ctrl/⌘ `</dd></div><div><dt>New session</dt><dd>Ctrl/⌘ N</dd></div><div><dt>Settings</dt><dd>Ctrl/⌘ ,</dd></div><div><dt>Stop generation</dt><dd>Esc</dd></div></dl></section>
            <section><h3><Activity size={15} />Pi diagnostics</h3>{diagnostics ? <dl className="diagnostics">{Object.entries(diagnostics).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value === null ? '—' : String(value)}</dd></div>)}</dl> : <p>Loading diagnostics…</p>}</section>
            <section><h3><Activity size={15} />Application logs</h3><div className="settings-logs">{logs.length ? logs.slice(-100).reverse().map((entry) => <div key={`${entry.timestamp}-${entry.message}`}><time>{new Date(entry.timestamp).toLocaleTimeString()}</time><strong>{entry.level}</strong><span>{entry.scope}: {entry.message}</span></div>) : <p>No application logs yet.</p>}</div></section>
          </div>
          <footer><span aria-live="polite">{status}</span><button type="button" className="primary-button" onClick={() => void save()}><Save size={14} />Save settings</button></footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
