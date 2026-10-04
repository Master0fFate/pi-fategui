import { describe, expect, it, vi } from 'vitest';
import { UiohookKey } from 'uiohook-napi';
import { GlobalHotkeyService, parseAccelerator } from './GlobalHotkeyService';

// Parsing accelerators must not load or download an Electron executable.
vi.mock('electron', () => ({ globalShortcut: {} }));

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

describe('GlobalHotkeyService native hook lifetime', () => {
  function fixture() {
    const uIOhook = { start: vi.fn(), stop: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
    const load = vi.fn(async () => ({ uIOhook, UiohookKey, EventType: { EVENT_KEY_PRESSED: 4, EVENT_KEY_RELEASED: 5 } }));
    const service = new GlobalHotkeyService({ write: vi.fn() } as never, () => undefined, () => undefined, load as never);
    return { uIOhook, load, service };
  }
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it('does not load or start the keyboard hook on quit when push-to-talk never used it', async () => {
    const { uIOhook, load, service } = fixture();
    service.dispose();
    await settle();
    expect(load).not.toHaveBeenCalled();
    expect(uIOhook.start).not.toHaveBeenCalled();
    expect(uIOhook.stop).not.toHaveBeenCalled();
  });

  it('stops the keyboard hook on quit after push-to-talk started it, without a second start', async () => {
    const { uIOhook, load, service } = fixture();
    await expect(service.register('Control+Space', 'push-to-talk')).resolves.toEqual({ pushToTalkAvailable: true });
    expect(load).toHaveBeenCalledOnce();
    expect(uIOhook.start).toHaveBeenCalledOnce();
    service.dispose();
    await settle();
    expect(uIOhook.stop).toHaveBeenCalledOnce();
    expect(uIOhook.start).toHaveBeenCalledOnce();
    expect(uIOhook.removeListener).toHaveBeenCalledOnce();
  });
});
