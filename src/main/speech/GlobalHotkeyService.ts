import { globalShortcut } from 'electron';
import type { UiohookKeyboardEvent } from 'uiohook-napi';
import type { SpeechHotkeyStatus, VoiceHotkeyMode } from '../../shared/contracts/ipc';
import type { AppLogService } from '../logging/AppLogService';

type UiohookModule = typeof import('uiohook-napi');

interface KeyCombo {
  keycode: number;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

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

function eventMatches(event: UiohookKeyboardEvent, combo: KeyCombo): boolean {
  return event.keycode === combo.keycode
    && Boolean(event.ctrlKey) === combo.ctrl
    && Boolean(event.altKey) === combo.alt
    && Boolean(event.shiftKey) === combo.shift
    && Boolean(event.metaKey) === combo.meta;
}

/**
 * Global voice hotkey: toggle (Electron globalShortcut) or push-to-talk
 * (uiohook-napi, which sees key-down AND key-up while another app is focused).
 *
 * The native hook is loaded lazily and only for push-to-talk, so toggle users
 * never pay for it and never see an Input Monitoring prompt. If the hook cannot
 * load on a platform, push-to-talk reports unavailable and the caller can fall
 * back to toggle; the app never hard-crashes.
 */
export class GlobalHotkeyService {
  private readonly logs: AppLogService;
  private readonly onStart: () => void;
  private readonly onStop: () => void;
  private uiohookPromise: Promise<UiohookModule | null> | null = null;
  private pushToTalkAvailable = true;
  private unavailableReason: string | undefined;
  private current: { cleanup: () => void } | null = null;
  private combo: KeyCombo | null = null;
  private active = false;

  constructor(logs: AppLogService, onStart: () => void, onStop: () => void) {
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
    if (mode === 'toggle') {
      const registered = globalShortcut.register(accelerator, () => this.toggle());
      if (!registered) {
        return { pushToTalkAvailable: this.pushToTalkAvailable, reason: `The hotkey "${accelerator}" could not be registered. It may be in use by another application.` };
      }
      this.current = { cleanup: () => globalShortcut.unregister(accelerator) };
      this.logs.write('info', 'speech', `Voice toggle hotkey registered: ${accelerator}`);
      return this.getStatus();
    }

    const mod = await this.loadUiohook();
    if (!mod) return this.getStatus();
    const combo = parseAccelerator(accelerator, mod.UiohookKey);
    if (!combo) {
      return { pushToTalkAvailable: this.pushToTalkAvailable, reason: `The hotkey "${accelerator}" is not a recognizable key combination for push-to-talk.` };
    }
    this.combo = combo;
    const handler = (event: UiohookKeyboardEvent | { type: number }) => {
      if (!this.combo || event.type !== mod.EventType.EVENT_KEY_PRESSED && event.type !== mod.EventType.EVENT_KEY_RELEASED) return;
      const key = event as UiohookKeyboardEvent;
      if (event.type === mod.EventType.EVENT_KEY_PRESSED && eventMatches(key, this.combo)) {
        if (!this.active) { this.active = true; this.onStart(); }
      } else if (event.type === mod.EventType.EVENT_KEY_RELEASED && key.keycode === this.combo.keycode) {
        if (this.active) { this.active = false; this.onStop(); }
      }
    };
    mod.uIOhook.on('input', handler);
    this.current = { cleanup: () => { mod.uIOhook.removeListener('input', handler as (...args: unknown[]) => void); this.combo = null; } };
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
    this.unregister();
    void this.loadUiohook().then((mod) => { try { mod?.uIOhook.stop(); } catch { /* best-effort */ } });
  }

  private toggle(): void {
    if (this.active) { this.active = false; this.onStop(); }
    else { this.active = true; this.onStart(); }
  }

  private loadUiohook(): Promise<UiohookModule | null> {
    if (this.uiohookPromise) return this.uiohookPromise;
    this.uiohookPromise = (async () => {
      try {
        const mod = await import('uiohook-napi');
        mod.uIOhook.start();
        this.logs.write('info', 'speech', 'Global keyboard hook started for voice push-to-talk.');
        return mod;
      } catch (error) {
        this.pushToTalkAvailable = false;
        this.unavailableReason = 'The global keyboard hook could not load on this platform, so push-to-talk is unavailable. Toggle mode still works.';
        this.logs.write('warn', 'speech', `${this.unavailableReason} (${error instanceof Error ? error.message : String(error)})`);
        return null;
      }
    })();
    return this.uiohookPromise;
  }
}
