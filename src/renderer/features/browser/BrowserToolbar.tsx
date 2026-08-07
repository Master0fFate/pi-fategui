import {
  ArrowLeft,
  ArrowRight,
  Bot,
  FileCode2,
  Globe2,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  X,
} from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { AppTooltip } from '../../components/AppTooltip';
import { browserOrigin, currentBrowserTab, grantForOrigin, useBrowserStore } from '../../stores/browserStore';
import { useUiStore } from '../../stores/uiStore';
import type { BrowserUiMode } from '../../../shared/contracts/browser';

export function BrowserToolbar() {
  const state = useBrowserStore((store) => store.state);
  const pending = useBrowserStore((store) => store.pending);
  const error = useBrowserStore((store) => store.error);
  const tab = currentBrowserTab(state);
  const setBrowserOpen = useUiStore((store) => store.setBrowserOpen);
  const [address, setAddress] = useState(tab?.url === 'about:blank' ? '' : tab?.url ?? '');
  const [accessOpen, setAccessOpen] = useState(false);
  const addressFocused = useRef(false);
  const lastPromptedOrigin = useRef<string | null>(null);
  const currentOrigin = browserOrigin(tab?.url ?? '');
  const currentGrant = grantForOrigin(state, currentOrigin);
  const isLocalPage = tab?.url.startsWith('file:') ?? false;

  useEffect(() => {
    if (!addressFocused.current) setAddress(tab?.url === 'about:blank' ? '' : tab?.url ?? '');
  }, [tab?.id, tab?.url]);

  useEffect(() => {
    if (!currentOrigin) {
      lastPromptedOrigin.current = null;
      setAccessOpen(false);
      return;
    }
    if (state.mode !== 'agent' || state.sessionFullAccess || currentGrant?.interact) {
      setAccessOpen(false);
      return;
    }
    if (lastPromptedOrigin.current !== currentOrigin) {
      lastPromptedOrigin.current = currentOrigin;
      setAccessOpen(true);
    }
  }, [currentGrant?.interact, currentOrigin, state.mode, state.sessionFullAccess]);

  const run = async (label: string, operation: () => Promise<unknown>) => {
    if (!('piDesktop' in window) || pending) return;
    useBrowserStore.getState().setPending(label);
    useBrowserStore.getState().setError(null);
    try {
      const next = await operation();
      if (next && typeof next === 'object' && 'tabs' in next) useBrowserStore.getState().hydrate(next as typeof state);
    } catch (cause) {
      useBrowserStore.getState().setError(cause instanceof Error ? cause.message : `Browser ${label} failed.`);
    } finally {
      useBrowserStore.getState().setPending(null);
    }
  };

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    if (!address.trim()) {
      useBrowserStore.getState().setError('Enter a URL, search, or local HTML path.');
      return;
    }
    void run('navigation', () => window.piDesktop.navigateBrowser(address));
  };

  const setMode = (mode: BrowserUiMode) => {
    if (mode === 'agent' && currentOrigin && !state.sessionFullAccess && !currentGrant?.interact) setAccessOpen(true);
    void run('mode change', () => window.piDesktop.setBrowserMode(mode));
  };

  const grant = (interact: boolean) => {
    if (!currentOrigin) return;
    void run('agent access', async () => {
      const next = await window.piDesktop.setBrowserOriginGrant({
        origin: currentOrigin,
        read: true,
        interact,
        scope: 'task',
        allowPrivateNetwork: isPrivateAddress(tab?.url ?? ''),
      });
      setAccessOpen(false);
      return next;
    });
  };

  const openLocalFile = () => {
    void run('local file', async () => (await window.piDesktop.openBrowserLocalFile()) ?? state);
  };

  const closeBrowser = () => {
    setBrowserOpen(false);
    void window.piDesktop.setBrowserPaused(true).then((next) => useBrowserStore.getState().hydrate(next)).catch(() => undefined);
  };

  const canAnnotate = Boolean(tab && tab.url !== 'about:blank' && tab.semanticAvailable);
  const agentNeedsAccess = Boolean(currentOrigin && !state.sessionFullAccess && !currentGrant?.interact);

  return (
    <>
      <div className="browser-toolbar" role="toolbar" aria-label="Browser controls">
        <div className="browser-history-controls">
          <AppTooltip content="Back"><button type="button" aria-label="Go back" disabled={!tab?.canGoBack || Boolean(pending)} onClick={() => void run('back', () => window.piDesktop.controlBrowserHistory('back'))}><ArrowLeft size={15} /></button></AppTooltip>
          <AppTooltip content="Forward"><button type="button" aria-label="Go forward" disabled={!tab?.canGoForward || Boolean(pending)} onClick={() => void run('forward', () => window.piDesktop.controlBrowserHistory('forward'))}><ArrowRight size={15} /></button></AppTooltip>
          <AppTooltip content={tab?.loading ? 'Stop loading' : 'Reload'}><button type="button" aria-label={tab?.loading ? 'Stop loading' : 'Reload page'} disabled={!tab || Boolean(pending)} onClick={() => void run(tab?.loading ? 'stop' : 'reload', () => window.piDesktop.controlBrowserHistory(tab?.loading ? 'stop' : 'reload'))}>{tab?.loading ? <X size={14} /> : <RefreshCw size={14} />}</button></AppTooltip>
        </div>
        <form className="browser-address" onSubmit={navigate}>
          {isLocalPage ? <FileCode2 size={13} aria-hidden="true" /> : <Globe2 size={13} aria-hidden="true" />}
          <input
            value={address}
            aria-label="Browser address"
            placeholder="URL, search, or C:\\path\\to\\index.html"
            spellCheck={false}
            onFocus={(event) => { addressFocused.current = true; event.currentTarget.select(); }}
            onBlur={() => { addressFocused.current = false; }}
            onChange={(event) => setAddress(event.target.value)}
          />
          {pending && <LoaderCircle className="tool-spinner" size={13} aria-label="Browser busy" />}
        </form>
        <AppTooltip content="Open local HTML"><button type="button" className="browser-open-file" aria-label="Open local HTML file" disabled={Boolean(pending)} onClick={openLocalFile}><FileCode2 size={14} /></button></AppTooltip>
        <div className="browser-interaction-switch" aria-label="Browser mode">
          <ModeButton mode="agent" active={state.mode === 'agent'} label="Agent" icon={Bot} attention={agentNeedsAccess} onSelect={setMode} />
          <ModeButton mode="annotate" active={state.mode === 'annotate'} label="Annotate" icon={ScanSearch} disabled={!canAnnotate} onSelect={setMode} />
        </div>
        <AppTooltip content={state.paused ? 'Resume agent browser actions' : 'Pause agent browser actions'}>
          <button
            type="button"
            className="browser-pause"
            aria-label={state.paused ? 'Resume browser agent' : 'Pause browser agent'}
            disabled={state.mode !== 'agent' || Boolean(pending)}
            onClick={() => void run(state.paused ? 'resume' : 'pause', () => window.piDesktop.setBrowserPaused(!state.paused))}
          >
            {state.paused ? <Play size={14} /> : <Pause size={14} />}
          </button>
        </AppTooltip>
        <AppTooltip content="Close browser"><button type="button" className="browser-close" aria-label="Close browser" onClick={closeBrowser}><X size={14} /></button></AppTooltip>
      </div>
      {accessOpen && currentOrigin && (
        <div className="browser-grant-strip" role="status">
          <ShieldCheck size={14} aria-hidden="true" />
          <span><strong>Let Pi use this site?</strong><small>{currentOrigin}</small></span>
          <button type="button" onClick={() => grant(false)}>Read only</button>
          <button type="button" className="browser-grant-primary" onClick={() => grant(true)}>Allow agent</button>
          <button type="button" aria-label="Close agent access prompt" onClick={() => setAccessOpen(false)}><X size={12} /></button>
        </div>
      )}
      {error && <div className="browser-error-strip" role="alert"><span>{error}</span><button type="button" onClick={() => useBrowserStore.getState().setError(null)}>Dismiss</button></div>}
    </>
  );
}

function ModeButton({
  mode,
  active,
  label,
  icon: Icon,
  attention = false,
  disabled = false,
  onSelect,
}: {
  mode: BrowserUiMode;
  active: boolean;
  label: string;
  icon: typeof Bot;
  attention?: boolean;
  disabled?: boolean;
  onSelect: (mode: BrowserUiMode) => void;
}) {
  return (
    <button type="button" aria-label={label} aria-pressed={active} data-attention={attention || undefined} disabled={disabled} onClick={() => onSelect(mode)}>
      <Icon size={12} aria-hidden="true" /><span>{label}</span>
    </button>
  );
}

function isPrivateAddress(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^\[|\]$/gu, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
    if (/^127\./u.test(host) || /^10\./u.test(host) || /^192\.168\./u.test(host) || /^169\.254\./u.test(host)) return true;
    const match = /^172\.(\d+)\./u.exec(host);
    return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
  } catch {
    return false;
  }
}
