import { globalShortcut } from 'electron';
import type { SpeechHotkeyStatus, VoiceHotkeyMode } from '../../shared/contracts/ipc';
import type { AppLogService } from '../logging/AppLogService';
import { startKeyboardHookProcess, type KeyboardHook, type KeyCombo } from './keyboardHookProcess';

// Types only: the main process never loads the native hook module.
type UiohookModule = typeof import('uiohook-napi');

/** Accelerator modifier tokens (uppercased). `CommandOrControl` resolves to
 *  Meta on macOS and Control elsewhere, matching Electron's semantics, because
 *  the native hook observes whichever platform it runs on. */
const MODIFIER_TOKENS: Record<string, 'ctrl' | 'alt' | 'shift' | 'meta'> = {
  CONTROL: 'ctrl', CTRL: 'ctrl',
  ALT: 'alt', OPTION: 'alt', ALTGR: 'alt',
  SHIFT: 'shift',
  COMMAND: 'meta', CMD: 'meta', META: 'meta', SUPER: 'meta', WIN: 'meta',
};

/** Translate a single accelerator token to a uiohook keycode, if it is a key. */
function tokenToKeycode(token: string, key: UiohookModule['UiohookKey']): number | undefined {
  const table = key as unknown as Record<string, number>;
  const specials: Record<string, number> = {
    SPACE: key.Space, ENTER: key.Enter, RETURN: key.Enter, TAB: key.Tab,
    ESC: key.Escape, ESCAPE: key.Escape, BACKSPACE: key.Backspace,
    DELETE: key.Delete, INSERT: key.Insert, HOME: key.Home, END: key.End,
    PAGEUP: key.PageUp, PAGEDOWN: key.PageDown,
    PRTSC: key.PrintScreen, PRINTSCREEN: key.PrintScreen,
    NUMLOCK: key.NumLock, SCROLLLOCK: key.ScrollLock, CAPSLOCK: key.CapsLock,
    LEFT: key.ArrowLeft, RIGHT: key.ArrowRight, UP: key.ArrowUp, DOWN: key.ArrowDown,
    ARROWLEFT: key.ArrowLeft, ARROWRIGHT: key.ArrowRight, ARROWUP: key.ArrowUp, ARROWDOWN: key.ArrowDown,
    PLUS: key.Equal, EQUAL: key.Equal, MINUS: key.Minus, COMMA: key.Comma, PERIOD: key.Period,
    SLASH: key.Slash, BACKSLASH: key.Backslash, SEMICOLON: key.Semicolon, QUOTE: key.Quote,
    BACKQUOTE: key.Backquote, BRACKETLEFT: key.BracketLeft, BRACKETRIGHT: key.BracketRight,
  };
  if (token in specials) return specials[token];
  if (/^F([1-9]|1\d|2[0-4])$/.test(token)) {
    const code = table[token];
    if (code !== undefined) return code;
  }
  if (/^[A-Z]$/.test(token)) return table[token];
  if (/^[0-9]$/.test(token)) return table[token];
  return undefined;
}

/** Parse an Electron-style accelerator into the uiohook combo the hook matches.
 *  Returns null when the accelerator has no key or an unrecognized token. */
export function parseAccelerator(accelerator: string, key: UiohookModule['UiohookKey']): KeyCombo | null {
  const tokens = accelerator.split('+').map((part) => part.trim().toUpperCase()).filter(Boolean);
  if (tokens.length === 0) return null;
  const isMac = process.platform === 'darwin';
  const combo: KeyCombo = { keycode: 0, ctrl: false, alt: false, shift: false, meta: false };
  let hasKey = false;
  for (const token of tokens) {
    if (token === 'COMMANDORCONTROL' || token === 'CMDORCTRL') {
      if (isMac) combo.meta = true; else combo.ctrl = true;
    } else if (token in MODIFIER_TOKENS) {
      const modifier = MODIFIER_TOKENS[token];
      if (modifier) combo[modifier] = true;
    } else {
      const keycode = tokenToKeycode(token, key);
      if (keycode === undefined) return null;
      combo.keycode = keycode;
      hasKey = true;
    }
  }
  return hasKey ? combo : null;
}

/**
 * Global voice hotkey: toggle (Electron globalShortcut) or push-to-talk
 * (uiohook-napi, which sees key-down AND key-up while another app is focused).
 *
 * The native hook is started lazily and only for push-to-talk, so toggle users
 * never pay for it and never see an Input Monitoring prompt. It runs in a helper
 * process (see keyboardHookProcess): a hook that hangs or fails cannot freeze or
 * crash the application. Push-to-talk then reports unavailable and the caller can
 * fall back to toggle.
 */
export class GlobalHotkeyService {
  private readonly logs: AppLogService;
  private readonly onStart: () => void;
  private readonly onStop: () => void;
  private uiohookPromise: Promise<KeyboardHook | null> | null = null;
  private pushToTalkAvailable = true;
  private unavailableReason: string | undefined;
  private current: { cleanup: () => void } | null = null;
  private combo: KeyCombo | null = null;
  private active = false;
  private disposed = false;

  constructor(logs: AppLogService, onStart: () => void, onStop: () => void,
    private readonly startHook: (listener: (event: 'down' | 'up') => void) => Promise<KeyboardHook | null> = startKeyboardHookProcess) {
    this.logs = logs;
    this.onStart = onStart;
    this.onStop = onStop;
  }

  getStatus(): SpeechHotkeyStatus {
    return this.pushToTalkAvailable
      ? { pushToTalkAvailable: true }
      : { pushToTalkAvailable: false, reason: this.unavailableReason };
  }

  /** Register a hotkey. Toggle uses globalShortcut; push-to-talk uses the native
   *  hook. Returns the resulting status (push-to-talk may be unavailable). */
  async register(accelerator: string, mode: VoiceHotkeyMode): Promise<SpeechHotkeyStatus> {
    this.unregister();
    // A settings save or a late startup step can arrive during quit. Nothing registers then.
    if (this.disposed) return this.getStatus();
    if (mode === 'toggle') {
      const registered = globalShortcut.register(accelerator, () => this.toggle());
      if (!registered) {
        return { pushToTalkAvailable: this.pushToTalkAvailable, reason: `The hotkey "${accelerator}" could not be registered. It may be in use by another application.` };
      }
      this.current = { cleanup: () => globalShortcut.unregister(accelerator) };
      this.logs.write('info', 'speech', `Voice toggle hotkey registered: ${accelerator}`);
      return this.getStatus();
    }

    const hook = await this.loadHook();
    if (!hook || this.disposed) return this.getStatus();
    const combo = parseAccelerator(accelerator, hook.keys as unknown as UiohookModule['UiohookKey']);
    if (!combo) {
      return { pushToTalkAvailable: this.pushToTalkAvailable, reason: `The hotkey "${accelerator}" is not a recognizable key combination for push-to-talk.` };
    }
    this.combo = combo;
    hook.setCombo(combo);
    this.current = { cleanup: () => { hook.setCombo(null); this.combo = null; } };
    this.logs.write('info', 'speech', `Voice push-to-talk hotkey registered: ${accelerator}`);
    return this.getStatus();
  }

  /** Apply the voice settings: register when a hotkey is set and voice is
   *  enabled, otherwise unregister. Called on startup and whenever speech
   *  settings change. */
  async applySpeechSettings(speech: { enabled: boolean; voiceHotkey: string | null; voiceHotkeyMode: VoiceHotkeyMode }): Promise<SpeechHotkeyStatus> {
    if (!speech.enabled || !speech.voiceHotkey) {
      this.unregister();
      return this.getStatus();
    }
    return this.register(speech.voiceHotkey, speech.voiceHotkeyMode);
  }

  /** Drop the active hotkey registration (keeps push-to-talk availability). */
  unregister(): void {
    this.current?.cleanup();
    this.current = null;
    this.combo = null;
    this.active = false;
  }

  /** Push-to-talk toggle-state debounce, and keeps toggle in sync when recording
   *  stops for any reason (hotkey or on-screen button). */
  resetActive(): void {
    this.active = false;
  }

  /** Release every registration and stop the native hook if it was started. */
  dispose(): void {
    this.disposed = true;
    this.unregister();
    // Only a hook that push-to-talk started is stopped. Loading it here would start the global
    // keyboard hook on every quit only to stop it, and that native start can block the main
    // thread for good (it did on macOS: the application then never quit).
    const started = this.uiohookPromise;
    if (!started) return;
    void started.then((hook) => { hook?.stop(); });
  }

  private toggle(): void {
    if (this.active) { this.active = false; this.onStop(); }
    else { this.active = true; this.onStart(); }
  }

  /** The helper reports only that the registered combination went down or up. */
  private onHookEvent(event: 'down' | 'up'): void {
    if (!this.combo) return;
    if (event === 'down') {
      if (!this.active) { this.active = true; this.onStart(); }
    } else if (this.active) { this.active = false; this.onStop(); }
  }

  private loadHook(): Promise<KeyboardHook | null> {
    if (this.uiohookPromise) return this.uiohookPromise;
    if (this.disposed) return Promise.resolve(null);
    this.uiohookPromise = this.startHook((event) => this.onHookEvent(event)).catch(() => null).then((hook) => {
      // Quit began while the helper was starting: it must not stay.
      if (hook && this.disposed) { hook.stop(); return null; }
      if (hook) this.logs.write('info', 'speech', 'Global keyboard hook started for voice push-to-talk.');
      else if (!this.disposed) {
        this.pushToTalkAvailable = false;
        this.unavailableReason = 'The global keyboard hook could not start on this platform, so push-to-talk is unavailable. Toggle mode still works.';
        this.logs.write('warn', 'speech', this.unavailableReason);
      }
      return hook;
    });
    return this.uiohookPromise;
  }
}
