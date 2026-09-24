import type { BrowserWindow, Event, Input, WebContents } from 'electron';

type FullscreenShortcutInput = Pick<
  Input,
  'type' | 'key' | 'code' | 'control' | 'meta' | 'alt' | 'shift' | 'isAutoRepeat' | 'isComposing'
>;

/**
 * Resolve a bare F11 press — the universal browser fullscreen toggle.
 * Matching both the physical code and the produced key keeps this working on
 * layouts where F11 is remapped or produces no character. Modifier chords,
 * auto-repeat, and IME composition are ignored because a held key must not
 * thrash the window between fullscreen and restored.
 */
export function resolveWindowFullscreenToggle(input: FullscreenShortcutInput): boolean {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return false;
  if (input.control || input.meta || input.alt || input.shift || input.isComposing) return false;
  const key = input.key.toLocaleLowerCase();
  const code = input.code.toLocaleLowerCase();
  return key === 'f11' || code === 'f11';
}

/** Enter real OS fullscreen (not maximize), or leave it when already inside. */
export function toggleWindowFullScreen(window: BrowserWindow): void {
  window.setFullScreen(!window.isFullScreen());
}

/**
 * Install the F11 fullscreen toggle on one webContents, toggling `window`.
 * The split matters because the embedded browser is a WebContentsView: when a
 * browser tab owns keyboard focus, the window's own webContents never sees
 * the key, so browser tab contents need the same listener.
 */
export function installFullscreenShortcut(webContents: WebContents, window: BrowserWindow): () => void {
  const listener = (event: Event, input: Input): void => {
    if (!resolveWindowFullscreenToggle(input) || window.isDestroyed() || webContents.isDestroyed()) return;
    event.preventDefault();
    toggleWindowFullScreen(window);
  };
  webContents.on('before-input-event', listener);
  return () => {
    if (!webContents.isDestroyed()) webContents.removeListener('before-input-event', listener);
  };
}

/** Install the F11 fullscreen toggle for this window's own UI webContents. */
export function installWindowFullscreenShortcut(window: BrowserWindow): () => void {
  // Keep the WebContents reference: BrowserWindow.webContents throws after the window closes.
  const webContents = window.webContents;
  return installFullscreenShortcut(webContents, window);
}
