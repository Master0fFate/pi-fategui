import { describe, expect, it } from 'vitest';
import { UiohookKey } from 'uiohook-napi';
import { parseAccelerator } from './GlobalHotkeyService';

describe('GlobalHotkeyService.parseAccelerator', () => {
  it('maps a CommandOrControl combo to the platform primary modifier', () => {
    // CommandOrControl resolves to Control everywhere except macOS, where it
    // resolves to Command; the assertion must follow the running platform.
    const isMac = process.platform === 'darwin';
    const combo = parseAccelerator('CommandOrControl+Shift+Space', UiohookKey);
    expect(combo).not.toBeNull();
    expect(combo).toMatchObject(isMac
      ? { keycode: UiohookKey.Space, ctrl: false, shift: true, meta: true, alt: false }
      : { keycode: UiohookKey.Space, ctrl: true, shift: true, meta: false, alt: false });
  });

  it('maps explicit Command and Control tokens', () => {
    expect(parseAccelerator('Command+Space', UiohookKey)).toMatchObject({ keycode: UiohookKey.Space, meta: true, ctrl: false });
    expect(parseAccelerator('Control+Alt+N', UiohookKey)).toMatchObject({ keycode: UiohookKey.N, ctrl: true, alt: true });
  });

  it('maps letters, digits, and function keys', () => {
    expect(parseAccelerator('A', UiohookKey)).toMatchObject({ keycode: UiohookKey.A, ctrl: false });
    expect(parseAccelerator('5', UiohookKey)).toMatchObject({ keycode: (UiohookKey as unknown as Record<string, number>)['5'] });
    expect(parseAccelerator('Shift+F5', UiohookKey)).toMatchObject({ keycode: UiohookKey.F5, shift: true });
  });

  it('rejects modifier-only and unrecognized accelerators', () => {
    expect(parseAccelerator('Shift', UiohookKey)).toBeNull();
    expect(parseAccelerator('Ctrl+Alt+Nonsense', UiohookKey)).toBeNull();
    expect(parseAccelerator('', UiohookKey)).toBeNull();
  });
});
