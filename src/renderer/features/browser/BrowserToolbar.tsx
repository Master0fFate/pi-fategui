import {
  ArrowLeft,
  ArrowRight,
  FileCode2,
  Globe2,
  LoaderCircle,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  Smartphone,
  X,
} from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { AppTooltip } from '../../components/AppTooltip';
import { browserOrigin, currentBrowserTab, grantForOrigin, useBrowserStore } from '../../stores/browserStore';
import { useUiStore } from '../../stores/uiStore';
import { DEFAULT_DEVICE_EMULATION } from './devicePresets';

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

  // Agent control is always on; the only reason to prompt for site access is
  // a missing origin grant, independent of the annotate picker.
  useEffect(() => {
    if (!currentOrigin) {
      lastPromptedOrigin.current = null;
      setAccessOpen(false);
      return;
    }
    if (state.sessionFullAccess || currentGrant?.interact) {
      setAccessOpen(false);
      return;
    }
    if (lastPromptedOrigin.current !== currentOrigin) {
      lastPromptedOrigin.current = currentOrigin;
      setAccessOpen(true);
    }
  }, [currentGrant?.interact, currentOrigin, state.sessionFullAccess]);

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

  // Annotate is a picker overlay on top of the always-on agent interaction.
  const toggleAnnotate = () => {
    void run('mode change', () => window.piDesktop.setBrowserMode(state.mode === 'annotate' ? 'agent' : 'annotate'));
  };

  // The device toolbar is a separate switch: it never changes the agent or
  // annotate state, only device emulation for phone-like testing.
  const toggleDevice = () => {
    void run('device toolbar', () => window.piDesktop.setBrowserDeviceEmulation(state.deviceEmulation ? null : DEFAULT_DEVICE_EMULATION));
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
  };

  const canAnnotate = Boolean(tab && tab.url !== 'about:blank' && tab.semanticAvailable);

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
        <div className="browser-tool-group" role="group" aria-label="Browser tools">
          <AppTooltip content={state.mode === 'annotate' ? 'Stop annotating (Esc)' : 'Annotate page elements'}>
            <button
              type="button"
              className="browser-tool-toggle"
              aria-label="Annotate"
              aria-pressed={state.mode === 'annotate'}
              disabled={!canAnnotate || Boolean(pending)}
              onClick={toggleAnnotate}
            ><ScanSearch size={15} /></button>
          </AppTooltip>
          <AppTooltip content={state.deviceEmulation ? 'Turn off device toolbar' : 'Toggle device toolbar'}>
            <button
              type="button"
              className="browser-tool-toggle"
              aria-label="Toggle device toolbar"
              aria-pressed={Boolean(state.deviceEmulation)}
              disabled={Boolean(pending)}
              onClick={toggleDevice}
            ><Smartphone size={15} /></button>
          </AppTooltip>
        </div>
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
