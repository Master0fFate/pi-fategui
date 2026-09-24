import { Copy, Minus, Square, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { WindowControlAction, WindowState } from '../../shared/contracts/ipc';

type Platform = 'win32' | 'darwin' | 'linux';
type BridgeStatus = 'connecting' | 'ready' | 'error';

const initialWindowState: WindowState = { maximized: false, minimized: false, fullScreen: false };

export function WindowChrome() {
  const [platform, setPlatform] = useState<Platform>('win32');
  const [windowState, setWindowState] = useState<WindowState>(initialWindowState);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>('connecting');
  const bridge = 'piDesktop' in window ? window.piDesktop : null;

  useEffect(() => {
    if (!bridge?.controlWindow || !bridge.getAppInfo) {
      setBridgeStatus('error');
      return;
    }
    let active = true;
    const unsubscribe = bridge.onWindowState?.((state) => {
      if (active) setWindowState(state);
    });
    const stateRequest = bridge.getWindowState ? bridge.getWindowState() : Promise.resolve(initialWindowState);
    void Promise.all([bridge.getAppInfo(), stateRequest]).then(([info, state]) => {
      if (!active) return;
      setPlatform(info.platform);
      setWindowState(state);
      setBridgeStatus('ready');
    }).catch((error: unknown) => {
      console.error('Window control bridge failed to initialize.', error);
      if (active) setBridgeStatus('error');
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [bridge]);

  const control = async (action: WindowControlAction) => {
    if (!bridge?.controlWindow) {
      setBridgeStatus('error');
      return;
    }
    try {
      setWindowState(await bridge.controlWindow(action));
      setBridgeStatus('ready');
    } catch (error) {
      console.error(`Window action “${action}” failed.`, error);
      setBridgeStatus('error');
    }
  };

  // Inside F11 fullscreen the square button leaves fullscreen first; browsers
  // treat maximize and fullscreen as separate window states.
  const maximizeAction: WindowControlAction = windowState.fullScreen ? 'toggle-fullscreen' : 'toggle-maximize';
  const maximizeLabel = windowState.fullScreen ? 'Exit full screen' : windowState.maximized ? 'Restore window' : 'Maximize window';

  const status = bridgeStatus === 'error'
    ? <output className="window-control-error" role="status">Window controls disconnected — restart Fate UI.</output>
    : null;

  if (platform === 'darwin') {
    return (
      <>
        <div className="window-controls window-controls--darwin" aria-label="Window controls" data-bridge-status={bridgeStatus} data-minimized={windowState.minimized} data-fullscreen={windowState.fullScreen}>
          <button className="window-control window-control--close" type="button" aria-label="Close window" onClick={() => void control('close')}><X size={8} /></button>
          <button className="window-control window-control--minimize" type="button" aria-label="Minimize window" onClick={() => void control('minimize')}><Minus size={8} /></button>
          <button className="window-control window-control--maximize" type="button" aria-label={maximizeLabel} onClick={() => void control(maximizeAction)}>{windowState.maximized ? <Copy size={7} /> : <span aria-hidden="true" />}</button>
        </div>
        {status}
      </>
    );
  }

  return (
    <>
      <div className={`window-controls window-controls--${platform}`} aria-label="Window controls" data-bridge-status={bridgeStatus} data-minimized={windowState.minimized} data-fullscreen={windowState.fullScreen}>
        <button className="window-control window-control--minimize" type="button" aria-label="Minimize window" onClick={() => void control('minimize')}><Minus size={14} /></button>
        <button className="window-control window-control--maximize" type="button" aria-label={maximizeLabel} onClick={() => void control(maximizeAction)}>{windowState.maximized ? <Copy size={12} /> : <Square size={11} />}</button>
        <button className="window-control window-control--close" type="button" aria-label="Close window" onClick={() => void control('close')}><X size={15} /></button>
      </div>
      {status}
    </>
  );
}
