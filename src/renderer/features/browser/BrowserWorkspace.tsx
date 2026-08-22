import { AlertTriangle, Check, FileCode2, Globe2, LoaderCircle, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { BrowserDeviceToolbar } from './BrowserDeviceToolbar';
import { BrowserToolbar } from './BrowserToolbar';
import { BrowserViewport } from './BrowserViewport';

export function BrowserWorkspace({ visible = true }: { visible?: boolean }) {
  const state = useBrowserStore((store) => store.state);
  const pending = useBrowserStore((store) => store.pending);

  const run = async (label: string, operation: () => Promise<typeof state>) => {
    if (!('piDesktop' in window) || pending) return;
    useBrowserStore.getState().setPending(label);
    try {
      useBrowserStore.getState().hydrate(await operation());
    } catch (error) {
      useBrowserStore.getState().setError(error instanceof Error ? error.message : `Browser ${label} failed.`);
    } finally {
      useBrowserStore.getState().setPending(null);
    }
  };

  return (
    <section className="browser-workspace" aria-label="Built-in browser" data-testid="browser-workspace">
      <div className="browser-tab-strip" role="tablist" aria-label="Browser tabs">
        {state.tabs.map((tab) => {
          const active = tab.id === state.activeTabId;
          const local = tab.url.startsWith('file:');
          return (
            <div className={`browser-tab ${active ? 'browser-tab--active' : ''}`} key={tab.id}>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                title={tab.url}
                disabled={Boolean(pending)}
                onClick={() => void run('tab switch', () => window.piDesktop.activateBrowserTab(tab.id))}
              >
                {local ? <FileCode2 size={12} aria-hidden="true" /> : <Globe2 size={12} aria-hidden="true" />}
                <span>{tab.title || localFileName(tab.url) || (tab.url === 'about:blank' ? 'New tab' : tab.url)}</span>
                {tab.loading && <LoaderCircle className="tool-spinner" size={11} aria-label="Loading tab" />}
              </button>
              <button
                type="button"
                className="browser-tab-close"
                aria-label={`Close ${tab.title || 'browser tab'}`}
                disabled={Boolean(pending)}
                onClick={() => void run('tab close', () => window.piDesktop.closeBrowserTab(tab.id))}
              ><X size={11} /></button>
            </div>
          );
        })}
        <button
          type="button"
          className="browser-new-tab"
          aria-label="New browser tab"
          disabled={Boolean(pending) || state.tabs.length >= 16}
          onClick={() => void run('new tab', () => window.piDesktop.createBrowserTab())}
        ><Plus size={13} /></button>
      </div>
      <BrowserToolbar />
      <BrowserDeviceToolbar state={state} />
      {state.mode === 'annotate' && (
        <div className="browser-annotation-hint" role="status">
          <span><span className="browser-annotation-cursor" aria-hidden="true" /> Hover and click any page element</span>
          <kbd>Esc</kbd><small>to stop annotating</small>
        </div>
      )}
      {state.mode === 'annotate' && !state.tabs.find((tab) => tab.id === state.activeTabId)?.semanticAvailable && (
        <div className="browser-error-strip" role="alert"><span>Element selection is unavailable for this page.</span></div>
      )}
      {state.activeTabId ? (
        <div
          className={`browser-device-stage${state.deviceEmulation ? ' browser-device-stage--active' : ''}`}
          data-testid={state.deviceEmulation ? 'browser-device-stage' : undefined}
        >
          <div
            className="browser-device-frame"
            style={state.deviceEmulation ? { width: `${state.deviceEmulation.width}px`, height: `${state.deviceEmulation.height}px` } : undefined}
          >
            <BrowserViewport visible={visible} />
          </div>
        </div>
      ) : (
        <div className="browser-blank-state"><strong>Opening Chromium…</strong></div>
      )}
      <BrowserConfirmationBanner />
    </section>
  );
}

function BrowserConfirmationBanner() {
  const confirmation = useBrowserStore((store) => store.confirmation);
  const [busy, setBusy] = useState(false);
  if (!confirmation) return null;
  const target = confirmation.action.targetName || confirmation.action.targetRole || confirmation.action.kind;
  const respond = async (approved: boolean) => {
    if (busy || !('piDesktop' in window)) return;
    setBusy(true);
    try {
      await window.piDesktop.respondToBrowserConfirmation(confirmation.id, approved);
    } catch (error) {
      useBrowserStore.getState().setError(error instanceof Error ? error.message : 'The browser confirmation expired.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="browser-confirmation" role="alertdialog" aria-label="Confirm browser action" aria-describedby="browser-confirmation-reason">
      <AlertTriangle size={16} aria-hidden="true" />
      <span>
        <strong>Allow this browser action?</strong>
        <small id="browser-confirmation-reason">{target} · {confirmation.reason}</small>
      </span>
      <button type="button" disabled={busy} onClick={() => void respond(false)}><X size={13} /> Deny</button>
      <button type="button" className="browser-confirmation-approve" disabled={busy} onClick={() => void respond(true)}><Check size={13} /> Allow once</button>
    </div>
  );
}

function localFileName(value: string): string {
  if (!value.startsWith('file:')) return '';
  try {
    return decodeURIComponent(new URL(value).pathname.split('/').filter(Boolean).at(-1) ?? 'Local page');
  } catch {
    return 'Local page';
  }
}
