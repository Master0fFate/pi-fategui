import type { BrowserWindow, Input } from 'electron';

export type WindowZoomCommand = 'in' | 'out' | 'reset';

type ZoomShortcutInput = Pick<
  Input,
  'type' | 'key' | 'code' | 'control' | 'meta' | 'alt' | 'isComposing'
>;

const zoomStep = 0.5;
const minimumZoomLevel = -5;
const maximumZoomLevel = 5;

/**
 * Resolve native zoom shortcuts from the physical key and the produced character.
 * Matching both matters because `+` is `Shift+=` on many keyboard layouts.
 */
export function resolveWindowZoomCommand(
  input: ZoomShortcutInput,
  platform: NodeJS.Platform = process.platform,
): WindowZoomCommand | null {
  const primaryModifier = platform === 'darwin' ? input.meta : input.control;
  if (input.type !== 'keyDown' || !primaryModifier || input.alt || input.isComposing) return null;

  const key = input.key.toLocaleLowerCase();
  const code = input.code.toLocaleLowerCase();

  if (key === '+' || key === '=' || key === 'add' || code === 'equal' || code === 'numpadadd') {
    return 'in';
  }
  if (key === '-' || key === '_' || key === 'subtract' || code === 'minus' || code === 'numpadsubtract') {
    return 'out';
  }
  if (key === '0' || code === 'digit0' || code === 'numpad0') return 'reset';
  return null;
}

export function nextWindowZoomLevel(currentLevel: number, command: WindowZoomCommand): number {
  if (command === 'reset') return 0;
  const delta = command === 'in' ? zoomStep : -zoomStep;
  return Math.min(maximumZoomLevel, Math.max(minimumZoomLevel, currentLevel + delta));
}

/** Install layout-independent Cmd/Ctrl zoom shortcuts for this window. */
export function installWindowZoomShortcuts(window: BrowserWindow): () => void {
  // Keep the WebContents reference: BrowserWindow.webContents throws after the window closes.
  const webContents = window.webContents;
  const listener = (event: Electron.Event, input: Input): void => {
    const command = resolveWindowZoomCommand(input);
    if (command === null || window.isDestroyed() || webContents.isDestroyed()) return;

    event.preventDefault();
    const currentLevel = webContents.getZoomLevel();
    webContents.setZoomLevel(nextWindowZoomLevel(currentLevel, command));
  };

  webContents.on('before-input-event', listener);
  return () => {
    if (!webContents.isDestroyed()) webContents.removeListener('before-input-event', listener);
  };
}
