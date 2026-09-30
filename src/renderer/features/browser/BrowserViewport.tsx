import { getFateApiOptional, getDesktopApi, getDesktopApiOptional } from '../../platform/api';
import { Globe2, ScanSearch } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { currentBrowserTab, useBrowserStore } from '../../stores/browserStore';
import { observeBrowserViewportBounds } from './browserViewportBounds';

export function BrowserViewport({ visible }: { visible: boolean }) {
  const reservation = useRef<HTMLDivElement>(null);
  const state = useBrowserStore((store) => store.state);
  const tab = currentBrowserTab(state);
  const requestedVisible = visible && Boolean(tab && tab.url !== 'about:blank');

  useLayoutEffect(() => {
    const node = reservation.current;
    if (!requestedVisible || !node || !getFateApiOptional() || typeof getDesktopApiOptional()?.setBrowserBounds !== 'function') return undefined;
    const desktop = getDesktopApi();
    return observeBrowserViewportBounds(node, (bounds) => desktop.setBrowserBounds(bounds), (error) => {
      useBrowserStore.getState().setError(error instanceof Error ? error.message : 'Browser viewport alignment failed.');
    });
  }, [requestedVisible]);

  useEffect(() => {
    if (!getFateApiOptional() || typeof getDesktopApiOptional()?.setBrowserVisible !== 'function') return undefined;
    const desktop = getDesktopApi();
    let active = true;
    void desktop.setBrowserVisible(requestedVisible).then((next) => {
      if (active) useBrowserStore.getState().hydrate(next);
    }).catch((error: unknown) => {
      if (active) useBrowserStore.getState().setError(error instanceof Error ? error.message : 'The browser view could not be shown.');
    });
    return () => {
      active = false;
      void desktop.setBrowserVisible(false).catch(() => undefined);
    };
  }, [requestedVisible]);

  return (
    <div ref={reservation} className="browser-viewport-reservation" aria-label="Built-in browser viewport">
      {!tab || tab.url === 'about:blank' ? (
        <div className="browser-blank-state">
          <span className="browser-blank-mark" aria-hidden="true"><Globe2 size={24} /></span>
          <div>
            <strong>Open a page or local HTML file</strong>
            <p>Paste a URL or filesystem path above, or use the local-file button. This is a real isolated Chromium profile.</p>
          </div>
          <span className="browser-blank-capability"><ScanSearch size={13} aria-hidden="true" /> Ready for Agent and Annotate</span>
        </div>
      ) : state.viewBlocked ? (
        <div className="browser-view-blocked" role="status">
          <strong>Browser hidden behind an app dialog</strong>
          <span>Close the dialog to bring the page back. Agent control stays fully available.</span>
        </div>
      ) : null}
    </div>
  );
}
