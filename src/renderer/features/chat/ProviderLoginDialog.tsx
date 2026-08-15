import * as Dialog from '@radix-ui/react-dialog';
import { ExternalLink, KeyRound, LoaderCircle, LogOut, ShieldCheck, X } from 'lucide-react';
import { useEffect, useState } from 'react';
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
  const login = state ?? { status: 'idle', providers: [], providerId: null, providerName: null, method: null, prompt: null, message: null, deviceCode: null };
  const selected = login.providers.find((provider) => provider.id === providerId) ?? null;

  useEffect(() => {
    if (!open) { setProviderId(null); setValue(''); setStarted(false); return; }
    if (started && login.status === 'idle' && login.providers.some((provider) => provider.configured)) onOpenChange(false);
  }, [login.providers, login.status, onOpenChange, open, started]);

  const close = () => {
    if (login.status === 'working' || login.status === 'awaiting-input') void window.piDesktop?.cancelProviderLogin();
    onOpenChange(false);
  };
  const start = (method: 'oauth' | 'api_key') => {
    if (!selected || !window.piDesktop) return;
    setStarted(true);
    setValue('');
    void window.piDesktop.startProviderLogin({ providerId: selected.id, method }).catch(() => undefined);
  };
  const respond = () => {
    if (!login.prompt || !window.piDesktop) return;
    const answer = value;
    setValue('');
    void window.piDesktop.respondProviderLogin({ promptId: login.prompt.id, value: answer }).catch(() => undefined);
  };

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
          {login.status === 'awaiting-input' && login.prompt ? (
            <form onSubmit={(event) => { event.preventDefault(); respond(); }}>
              <p className="provider-login-status">{login.prompt.message}</p>
              {login.prompt.type === 'select' ? (
                <label className="provider-login-field"><span>Choose an option</span><select value={value} autoFocus onChange={(event) => setValue(event.target.value)}><option value="" disabled>Select…</option>{login.prompt.options?.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
              ) : (
                <label className="provider-login-field"><span>{login.prompt.type === 'secret' ? 'Credential' : 'Response'}</span><input autoFocus type={login.prompt.type === 'secret' ? 'password' : 'text'} value={value} maxLength={20_000} placeholder={login.prompt.placeholder} autoComplete="off" onChange={(event) => setValue(event.target.value)} /></label>
              )}
              <footer><button type="button" onClick={close}>Cancel</button><button className="provider-login-primary" type="submit" disabled={!value}>Continue</button></footer>
            </form>
          ) : login.status === 'working' ? (
            <section className="provider-login-progress" aria-live="polite"><LoaderCircle className="tool-spinner" size={17} /><div><strong>{login.providerName ?? 'Provider'} sign-in</strong><p>{login.message ?? 'Working…'}</p>{login.deviceCode ? <code>{login.deviceCode.userCode}</code> : null}</div><button type="button" onClick={close}>Cancel</button></section>
          ) : (
            <section className="provider-login-providers">
              {login.status === 'error' && <p className="provider-login-error" role="alert">{login.message}</p>}
              <p>Choose a provider, then its available sign-in method.</p>
              <div className="provider-login-list">
                {login.providers.map((provider) => <button key={provider.id} type="button" data-active={provider.id === selected?.id} onClick={() => setProviderId(provider.id)}><span><strong>{provider.name}</strong><small>{provider.configured ? 'Connected' : provider.methods.includes('oauth') ? 'OAuth or API key' : 'API key'}</small></span>{provider.configured ? <ShieldCheck size={15} /> : null}</button>)}
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
