import '@fontsource-variable/noto-sans/wght.css';
import '@fontsource-variable/noto-sans-mono/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import React, { useEffect, useRef, useState, type FormEvent, type ComponentType } from 'react';
import ReactDOM from 'react-dom/client';
import { exchangeBrowserCode, recoverBrowserSession, WebFateApi, type BrowserSession } from '../client/WebFateApi';
import { installWebFateApi } from './platform/api';
import { SkinProvider } from './skins/SkinProvider';
import './styles/global.css';
import './styles/skins/angelcore-surfaces.css';
import './styles/action-surfaces.css';

// A bootstrap code is entered in the form, never consumed from a link. Scrub
// accidental query/hash secrets before a view or later navigation can keep them.
if (window.location.search || window.location.hash) window.history.replaceState(null, '', window.location.pathname);

interface GatewayView { readonly phase: 'recovering' | 'login' | 'connecting' | 'workspace' | 'error' | 'incompatible' | 'logout-uncertain'; readonly message?: string }

function WebGateway() {
  const [view, setView] = useState<GatewayView>({ phase: 'recovering' });
  const [code, setCode] = useState('');
  const [AppComponent, setAppComponent] = useState<ComponentType | null>(null);
  const current = useRef<{ web: WebFateApi; uninstall: () => void } | null>(null);
  const serial = useRef(0);

  const dispose = () => {
    current.current?.uninstall();
    current.current = null;
    setAppComponent(null);
  };
  const launch = async (session: BrowserSession, attempt: number) => {
    const web = new WebFateApi(window.location.origin, session, { onAuthenticationLost: () => {
      if (serial.current !== attempt) return;
      dispose();
      setView({ phase: 'login', message: 'Your session expired. Get a new one-time code on the host.' });
    } });
    try {
      await web.connect();
      if (serial.current !== attempt) { web.close(); return; }
      const uninstall = installWebFateApi(web);
      current.current = { web, uninstall };
      // App/stores are evaluated only after the web adapter is injected.
      const { App } = await import('./app/App');
      if (serial.current !== attempt) { uninstall(); return; }
      setAppComponent(() => App);
      setView({ phase: 'workspace' });
    } catch (reason) {
      web.close();
      if (serial.current !== attempt) return;
      dispose();
      const message = reason instanceof Error ? reason.message : 'The host is unavailable.';
      setView({ phase: /expired|authentication required/iu.test(message) ? 'login'
        : /protocol|incompatible/iu.test(message) ? 'incompatible' : 'error', message });
    }
  };
  const recover = async () => {
    const attempt = ++serial.current;
    dispose();
    setView({ phase: 'recovering' });
    try {
      const session = await recoverBrowserSession(window.location.origin);
      if (serial.current !== attempt) return;
      if (!session) { setView({ phase: 'login' }); return; }
      setView({ phase: 'connecting' });
      await launch(session, attempt);
    } catch (reason) {
      if (serial.current === attempt) setView({ phase: 'error', message: reason instanceof Error ? reason.message : 'Could not recover your session.' });
    }
  };
  useEffect(() => {
    void recover();
    return () => { serial.current++; current.current?.uninstall(); current.current = null; };
  }, []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const oneTimeCode = code.trim();
    setCode('');
    if (!oneTimeCode) return;
    const attempt = ++serial.current;
    setView({ phase: 'connecting' });
    try {
      const session = await exchangeBrowserCode(window.location.origin, oneTimeCode);
      if (serial.current === attempt) await launch(session, attempt);
    } catch (reason) {
      if (serial.current === attempt) setView({ phase: 'login', message: reason instanceof Error ? reason.message : 'Could not sign in.' });
    }
  };
  const signOut = async () => {
    const attempt = ++serial.current;
    const active = current.current;
    current.current = null;
    setAppComponent(null);
    setView({ phase: 'connecting' });
    if (!active) { setView({ phase: 'logout-uncertain', message: 'No active connection. Ask the host to revoke this browser session.' }); return; }
    try {
      await active.web.logout();
      if (serial.current === attempt) setView({ phase: 'login', message: 'Server confirmed sign-out. Request a new code to return.' });
    } catch {
      // The request might have reached the server. Closing the local socket is
      // not proof that its HttpOnly cookie was revoked.
      if (serial.current === attempt) setView({ phase: 'logout-uncertain',
        message: 'Sign-out was not confirmed. The server session may still be active. Reconnect and try again, or ask the host to revoke it.' });
    } finally { active.uninstall(); }
  };

  if (view.phase === 'workspace' && AppComponent) return <><button className="web-signout" type="button" onClick={() => void signOut()}>Sign out</button><AppComponent /></>;
  return <main className="monitor-dashboard" aria-label="Fate browser login">
    <h1>Fate UI</h1>
    {view.phase === 'recovering' || view.phase === 'connecting' ? <p role="status">{view.phase === 'recovering' ? 'Checking your browser session…' : 'Connecting to the authenticated host…'}</p> : null}
    {view.phase === 'login' ? <form onSubmit={(event) => void submit(event)} autoComplete="off">
      <p>Enter a one-time code from the Fate host. This browser gets observer access, not host administration.</p>
      <label htmlFor="fate-bootstrap-code">One-time code</label>
      <input id="fate-bootstrap-code" type="password" value={code} onChange={(event) => setCode(event.target.value)}
        autoComplete="off" spellCheck={false} required />
      <button type="submit">Sign in</button>
    </form> : null}
    {view.phase === 'error' || view.phase === 'incompatible' || view.phase === 'logout-uncertain'
      ? <button type="button" onClick={() => void recover()}>Reconnect to check the server session</button> : null}
    {view.message ? <p role="alert">{view.message}</p> : null}
    {view.phase === 'incompatible' ? <p>Server protocol is incompatible. No workspace request was made.</p> : null}
  </main>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Browser root was not found.');
ReactDOM.createRoot(root).render(<React.StrictMode><SkinProvider><WebGateway /></SkinProvider></React.StrictMode>);
