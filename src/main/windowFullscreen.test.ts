import { describe, expect, it, vi } from 'vitest';
import { installFullscreenShortcut, installWindowFullscreenShortcut, resolveWindowFullscreenToggle, toggleWindowFullScreen } from './windowFullscreen';

const input = (overrides: Partial<Parameters<typeof resolveWindowFullscreenToggle>[0]> = {}) => ({
  type: 'keyDown',
  key: 'F11',
  code: 'F11',
  control: false,
  meta: false,
  alt: false,
  shift: false,
  isAutoRepeat: false,
  isComposing: false,
  ...overrides,
});

describe('window fullscreen shortcut', () => {
  it('recognizes a bare F11 press by key or physical code', () => {
    expect(resolveWindowFullscreenToggle(input())).toBe(true);
    expect(resolveWindowFullscreenToggle(input({ key: '', code: 'F11' }))).toBe(true);
    expect(resolveWindowFullscreenToggle(input({ key: 'f11', code: '' }))).toBe(true);
  });

  it('ignores key-up, modifier chords, auto-repeat, composing, and unrelated keys', () => {
    expect(resolveWindowFullscreenToggle(input({ type: 'keyUp' }))).toBe(false);
    expect(resolveWindowFullscreenToggle(input({ control: true }))).toBe(false);
    expect(resolveWindowFullscreenToggle(input({ meta: true }))).toBe(false);
    expect(resolveWindowFullscreenToggle(input({ alt: true }))).toBe(false);
    expect(resolveWindowFullscreenToggle(input({ shift: true }))).toBe(false);
    expect(resolveWindowFullscreenToggle(input({ isAutoRepeat: true }))).toBe(false);
    expect(resolveWindowFullscreenToggle(input({ isComposing: true }))).toBe(false);
    expect(resolveWindowFullscreenToggle(input({ key: 'F12', code: 'F12' }))).toBe(false);
    expect(resolveWindowFullscreenToggle(input({ key: 'Escape', code: 'Escape' }))).toBe(false);
  });

  it('flips between fullscreen and restored instead of maximizing', () => {
    let fullScreen = false;
    const window = {
      isFullScreen: () => fullScreen,
      setFullScreen: vi.fn((next: boolean) => {
        fullScreen = next;
      }),
    } as unknown as Parameters<typeof toggleWindowFullScreen>[0];

    toggleWindowFullScreen(window);
    expect(window.setFullScreen).toHaveBeenCalledWith(true);
    toggleWindowFullScreen(window);
    expect(window.setFullScreen).toHaveBeenLastCalledWith(false);
  });

  it('toggles the window from a before-input-event and swallows the key', () => {
    const listeners = new Map<string, (event: { preventDefault: () => void }, input: unknown) => void>();
    const webContents = {
      isDestroyed: vi.fn(() => false),
      on: vi.fn((name: string, listener: (event: { preventDefault: () => void }, input: unknown) => void) => listeners.set(name, listener)),
      removeListener: vi.fn((name: string) => listeners.delete(name)),
    };
    const window = {
      isDestroyed: vi.fn(() => false),
      isFullScreen: vi.fn(() => false),
      setFullScreen: vi.fn(),
      webContents,
    } as unknown as Parameters<typeof installWindowFullscreenShortcut>[0];

    const removeShortcut = installWindowFullscreenShortcut(window);
    expect(webContents.on).toHaveBeenCalledWith('before-input-event', expect.any(Function));

    const preventDefault = vi.fn();
    listeners.get('before-input-event')?.({ preventDefault }, input());
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(window.setFullScreen).toHaveBeenCalledWith(true);

    listeners.get('before-input-event')?.({ preventDefault }, input({ key: 'a', code: 'KeyA' }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(window.setFullScreen).toHaveBeenCalledOnce();

    removeShortcut();
    listeners.get('before-input-event')?.({ preventDefault }, input());
    expect(window.setFullScreen).toHaveBeenCalledOnce();
  });

  it('binds a browser tab webContents to the owning window', () => {
    const listeners = new Map<string, (event: { preventDefault: () => void }, input: unknown) => void>();
    const webContents = {
      isDestroyed: vi.fn(() => false),
      on: vi.fn((name: string, listener: (event: { preventDefault: () => void }, input: unknown) => void) => listeners.set(name, listener)),
      removeListener: vi.fn(),
    };
    const window = {
      isDestroyed: vi.fn(() => false),
      isFullScreen: vi.fn(() => true),
      setFullScreen: vi.fn(),
      webContents: {},
    } as unknown as Parameters<typeof installFullscreenShortcut>[1];

    const removeShortcut = installFullscreenShortcut(webContents as never, window);
    listeners.get('before-input-event')?.({ preventDefault: vi.fn() }, input());
    expect(window.setFullScreen).toHaveBeenCalledWith(false);
    expect(removeShortcut).not.toThrow();
  });

  it('tears down safely after the window and webContents have been destroyed', () => {
    let destroyed = false;
    const webContents = {
      isDestroyed: vi.fn(() => destroyed),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const window = {
      isDestroyed: () => destroyed,
      get webContents() {
        if (destroyed) throw new TypeError('Object has been destroyed');
        return webContents;
      },
    } as unknown as Parameters<typeof installWindowFullscreenShortcut>[0];

    const removeShortcut = installWindowFullscreenShortcut(window);
    destroyed = true;

    expect(removeShortcut).not.toThrow();
  });
});
