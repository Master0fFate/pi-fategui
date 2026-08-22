import { Hand, RotateCcw } from 'lucide-react';
import { useEffect, useState, type ChangeEvent } from 'react';
import { AppTooltip } from '../../components/AppTooltip';
import { useBrowserStore } from '../../stores/browserStore';
import type { BrowserState } from '../../../shared/contracts/ipc';
import {
  DEVICE_PRESETS,
  MAX_DEVICE_HEIGHT,
  MAX_DEVICE_WIDTH,
  MIN_DEVICE_HEIGHT,
  MIN_DEVICE_WIDTH,
  clampDeviceHeight,
  clampDeviceWidth,
  matchPreset,
} from './devicePresets';

/**
 * Chrome-style device toolbar row. Shown while device emulation is on: pick a
 * preset or type exact dimensions, rotate between portrait and landscape, and
 * see that mouse input is translated into touch (finger swipe).
 */
export function BrowserDeviceToolbar({ state }: { state: BrowserState }) {
  const emulation = state.deviceEmulation;
  const [widthText, setWidthText] = useState(String(emulation?.width ?? 390));
  const [heightText, setHeightText] = useState(String(emulation?.height ?? 844));

  // Keep the inputs in sync when the committed emulation changes elsewhere
  // (rotate, preset pick, or a state event from the main process).
  useEffect(() => {
    setWidthText(String(emulation?.width ?? 390));
    setHeightText(String(emulation?.height ?? 844));
  }, [emulation?.width, emulation?.height]);

  if (!emulation) return null;

  const commit = (width: number, height: number) => {
    void window.piDesktop.setBrowserDeviceEmulation({
      width: clampDeviceWidth(width),
      height: clampDeviceHeight(height),
      mobile: emulation.mobile,
      touch: emulation.touch,
    }).then((next) => useBrowserStore.getState().hydrate(next))
      .catch((error: unknown) => useBrowserStore.getState().setError(error instanceof Error ? error.message : 'Device emulation failed.'));
  };

  const onPreset = (event: ChangeEvent<HTMLSelectElement>) => {
    const preset = DEVICE_PRESETS.find((candidate) => candidate.id === event.target.value);
    if (preset) commit(preset.width, preset.height);
  };

  const onWidthBlur = () => {
    const width = clampDeviceWidth(Number(widthText));
    setWidthText(String(width));
    if (width !== emulation.width) commit(width, emulation.height);
  };

  const onHeightBlur = () => {
    const height = clampDeviceHeight(Number(heightText));
    setHeightText(String(height));
    if (height !== emulation.height) commit(emulation.width, height);
  };

  const rotate = () => commit(emulation.height, emulation.width);

  return (
    <div className="browser-device-toolbar" role="toolbar" aria-label="Device toolbar">
      <label className="browser-device-preset">
        <span className="visually-hidden">Device preset</span>
        <select value={matchPreset(emulation).id} onChange={onPreset}>
          {DEVICE_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>{preset.label}</option>
          ))}
        </select>
      </label>
      <div className="browser-device-size" aria-label="Emulated size">
        <label className="visually-hidden" htmlFor="browser-device-width">Width in pixels</label>
        <input
          id="browser-device-width"
          type="number"
          inputMode="numeric"
          min={MIN_DEVICE_WIDTH}
          max={MAX_DEVICE_WIDTH}
          value={widthText}
          onChange={(event) => setWidthText(event.target.value)}
          onBlur={onWidthBlur}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
        />
        <span aria-hidden="true">×</span>
        <label className="visually-hidden" htmlFor="browser-device-height">Height in pixels</label>
        <input
          id="browser-device-height"
          type="number"
          inputMode="numeric"
          min={MIN_DEVICE_HEIGHT}
          max={MAX_DEVICE_HEIGHT}
          value={heightText}
          onChange={(event) => setHeightText(event.target.value)}
          onBlur={onHeightBlur}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
        />
      </div>
      <AppTooltip content="Rotate viewport">
        <button type="button" aria-label="Rotate viewport" onClick={rotate}><RotateCcw size={13} /></button>
      </AppTooltip>
      <span className="browser-device-touch-hint" title="Mouse input is translated into touch events">
        <Hand size={11} aria-hidden="true" /> Touch
      </span>
    </div>
  );
}
