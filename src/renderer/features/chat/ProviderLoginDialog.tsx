import * as Dialog from '@radix-ui/react-dialog';
import { ExternalLink, KeyRound, LoaderCircle, LogOut, Search, ShieldCheck, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ProviderLoginProvider, ProviderLoginState } from '../../../shared/contracts/ipc';

interface ProviderLoginDialogProps {
  open: boolean;
  state: ProviderLoginState | undefined;
  onOpenChange: (open: boolean) => void;
}

function methodsFor(provider: ProviderLoginProvider): readonly ('oauth' | 'api_key')[] {
  return provider.methods;
}

export function ProviderLoginDialog({ open, state, onOpenChange }: ProviderLoginDialogProps) {
  const [providerId, setProviderId] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [started, setStarted] = useState(false);
  const [query, setQuery] = useState('');
  // Optimistic bridge between clicking a sign-in method and the main process
  // reporting `working`; without it the provider list flashes back for one frame.
  const [pendingStart, setPendingStart] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // Auto-close may only fire after the dialog observed the login flow go active
  // (working / awaiting-input) and settle back to idle. Without this guard, the
  // stale pre-start `idle` snapshot plus an already-configured provider closes
  // the dialog immediately after the click, hiding the SDK's follow-up prompt.
  const sawActiveLoginRef = useRef(false);
  const login = state ?? { status: 'idle', providers: [], providerId: null, providerName: null, method: null, prompt: null, message: null, deviceCode: null };
  const selected = login.providers.find((provider) => provider.id === providerId) ?? null;
  const trimmedQuery = query.trim().toLowerCase();
  const visibleProviders = trimmedQuery
    ? login.providers.filter((provider) => provider.name.toLowerCase().includes(trimmedQuery) || provider.id.toLowerCase().includes(trimmedQuery))
    : login.providers;
  const showProviderSearch = login.providers.length > 6;

  useEffect(() => {
    if (!open) { setProviderId(null); setValue(''); setStarted(false); setQuery(''); setPendingStart(false); setStartError(null); sawActiveLoginRef.current = false; return; }
    if (login.status === 'working' || login.status === 'awaiting-input') sawActiveLoginRef.current = true;
    if (started && sawActiveLoginRef.current && login.status === 'idle' && login.providers.some((provider) => provider.configured)) onOpenChange(false);
  }, [login.providers, login.status, onOpenChange, open, started]);

  const close = () => {
    if (login.status === 'working' || login.status === 'awaiting-input' || pendingStart) void window.piDesktop?.cancelProviderLogin();
    onOpenChange(false);
  };
  const start = (method: 'oauth' | 'api_key') => {
    if (!selected || !window.piDesktop) return;
    setStarted(true);
    setValue('');
    setStartError(null);
    setPendingStart(true);
    void window.piDesktop.startProviderLogin({ providerId: selected.id, method })
      .catch((error: unknown) => { setStartError(error instanceof Error ? error.message : 'Provider sign-in could not start. Try again.'); })
      .finally(() => { setPendingStart(false); });
  };
  const respond = () => {
    if (!login.prompt || !window.piDesktop) return;
    const answer = value;
    setValue('');
    void window.piDesktop.respondProviderLogin({ promptId: login.prompt.id, value: answer }).catch(() => undefined);
  };

  const blockingPrompt = login.status === 'awaiting-input' && login.prompt && login.prompt.type !== 'manual_code' ? login.prompt : null;
  const working = pendingStart || login.status === 'working' || (login.status === 'awaiting-input' && login.prompt?.type === 'manual_code');
  const manualPrompt = login.prompt?.type === 'manual_code' ? login.prompt : null;
  const workingTitle = login.providerName ?? selected?.name ?? 'Provider';
  const workingMessage = pendingStart && login.status === 'idle'
    ? 'Starting secure provider sign-in…'
    : login.message ?? 'Working…';

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="provider-login-dialog" aria-describedby="provider-login-description">
          <header>
            <span className="provider-login-mark" aria-hidden="true"><ShieldCheck size={17} /></span>
            <span><Dialog.Title>Connect a provider</Dialog.Title><Dialog.Description id="provider-login-description">Fate UI uses the bundled Pi SDK. Your credentials stay in Fate UI’s local provider store.</Dialog.Description></span>
            <button type="button" className="provider-login-close" aria-label="Close provider sign-in" onClick={close}><X size={16} /></button>
          </header>
          {blockingPrompt ? (
            <form onSubmit={(event) => { event.preventDefault(); respond(); }}>
              <p className="provider-login-status">{blockingPrompt.message}</p>
              {blockingPrompt.type === 'select' ? (
                <label className="provider-login-field"><span>Choose an option</span><select value={value} autoFocus onChange={(event) => setValue(event.target.value)}><option value="" disabled>Select…</option>{blockingPrompt.options?.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
              ) : (
                <label className="provider-login-field"><span>{blockingPrompt.type === 'secret' ? 'Credential' : 'Response'}</span><input autoFocus type={blockingPrompt.type === 'secret' ? 'password' : 'text'} value={value} maxLength={20_000} placeholder={blockingPrompt.placeholder} autoComplete="off" onChange={(event) => setValue(event.target.value)} /></label>
              )}
              <footer><button type="button" onClick={close}>Cancel</button><button className="provider-login-primary" type="submit" disabled={!value}>Continue</button></footer>
            </form>
          ) : working ? (
            <>
              <section className="provider-login-progress" aria-live="polite"><LoaderCircle className="tool-spinner" size={17} /><div><strong>{workingTitle} sign-in</strong><p>{workingMessage}</p>{login.deviceCode ? <code>{login.deviceCode.userCode}</code> : null}</div><button type="button" onClick={close}>Cancel</button></section>
              {manualPrompt && (
                <details className="provider-login-manual">
                  <summary>Browser sign-in did not finish automatically</summary>
                  <form onSubmit={(event) => { event.preventDefault(); respond(); }}>
                    <p>{manualPrompt.message}</p>
                    <label className="provider-login-field"><span>Authorization code or redirect URL</span><input type="text" value={value} maxLength={20_000} placeholder={manualPrompt.placeholder} autoComplete="off" onChange={(event) => setValue(event.target.value)} /></label>
                    <footer><button className="provider-login-primary" type="submit" disabled={!value}>Submit code</button></footer>
                  </form>
                </details>
              )}
            </>
          ) : (
            <section className="provider-login-providers">
              {login.status === 'error' && <p className="provider-login-error" role="alert">{login.message}</p>}
              {startError && <p className="provider-login-error" role="alert">{startError}</p>}
              <p>Choose a provider, then its available sign-in method.</p>
              {showProviderSearch && (
                <div className="provider-login-search">
                  <Search size={13} aria-hidden="true" />
                  <input type="text" value={query} placeholder={`Search ${login.providers.length} providers…`} aria-label="Search providers" autoComplete="off" onChange={(event) => setQuery(event.target.value)} />
                  {trimmedQuery && <button type="button" className="provider-login-search-clear" aria-label="Clear search" onClick={() => setQuery('')}>×</button>}
                </div>
              )}
              <div className="provider-login-list">
                {visibleProviders.map((provider) => <button key={provider.id} type="button" data-active={provider.id === selected?.id} onClick={() => setProviderId(provider.id)}><span><strong>{provider.name}</strong><small>{provider.configured ? 'Connected' : provider.methods.includes('oauth') ? 'OAuth or API key' : 'API key'}</small></span>{provider.configured ? <ShieldCheck size={15} /> : null}</button>)}
                {trimmedQuery && !visibleProviders.length && <p className="provider-login-empty">No providers match “{query.trim()}”.</p>}
              </div>
              {selected && <div className="provider-login-methods">{methodsFor(selected).map((method) => <button key={method} type="button" className="provider-login-method" onClick={() => start(method)}>{method === 'oauth' ? <ExternalLink size={15} /> : <KeyRound size={15} />}<span><strong>{method === 'oauth' ? 'Sign in in browser' : 'Use an API key'}</strong><small>{method === 'oauth' ? 'Continue with the provider’s secure sign-in page' : 'Send a one-time credential to Fate UI’s local provider store'}</small></span></button>)}{selected.configured && <button type="button" className="provider-login-logout" onClick={() => void window.piDesktop?.logoutProvider(selected.id).catch(() => undefined)}><LogOut size={14} /> Sign out of {selected.name}</button>}</div>}
              {!login.providers.length && <p className="provider-login-error">Fate UI could not load a provider sign-in method. Check your connection or SDK configuration, then select Connect your AI again.</p>}
            </section>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
