import { describe, expect, it, vi } from 'vitest';
import { installWindowZoomShortcuts, nextWindowZoomLevel, resolveWindowZoomCommand } from './windowZoom';

const input = (overrides: Partial<Parameters<typeof resolveWindowZoomCommand>[0]> = {}) => ({
  type: 'keyDown',
  key: '',
  code: '',
  control: true,
  meta: false,
  alt: false,
  isComposing: false,
  ...overrides,
});

describe('window zoom shortcuts', () => {
  it('recognizes the physical Ctrl+Shift+= chord as zoom in on Windows and Linux', () => {
    expect(resolveWindowZoomCommand(input({ key: '+', code: 'Equal' }), 'win32')).toBe('in');
    expect(resolveWindowZoomCommand(input({ key: '=', code: 'Equal' }), 'linux')).toBe('in');
  });

  it('recognizes main-row, numpad, zoom-out, and reset keys', () => {
    expect(resolveWindowZoomCommand(input({ key: '+', code: 'NumpadAdd' }), 'win32')).toBe('in');
    expect(resolveWindowZoomCommand(input({ key: '-', code: 'Minus' }), 'win32')).toBe('out');
    expect(resolveWindowZoomCommand(input({ key: 'Subtract', code: 'NumpadSubtract' }), 'win32')).toBe('out');
    expect(resolveWindowZoomCommand(input({ key: '0', code: 'Digit0' }), 'win32')).toBe('reset');
  });

  it('uses Command on macOS and Control elsewhere', () => {
    expect(resolveWindowZoomCommand(input({ control: false, meta: true, key: '+', code: 'Equal' }), 'darwin')).toBe('in');
    expect(resolveWindowZoomCommand(input({ control: true, meta: false, key: '+', code: 'Equal' }), 'darwin')).toBeNull();
    expect(resolveWindowZoomCommand(input({ control: false, meta: true, key: '+', code: 'Equal' }), 'win32')).toBeNull();
  });

  it('ignores key-up, Alt-modified, composing, and unrelated input', () => {
    expect(resolveWindowZoomCommand(input({ type: 'keyUp', key: '+', code: 'Equal' }), 'win32')).toBeNull();
    expect(resolveWindowZoomCommand(input({ alt: true, key: '+', code: 'Equal' }), 'win32')).toBeNull();
    expect(resolveWindowZoomCommand(input({ isComposing: true, key: '+', code: 'Equal' }), 'win32')).toBeNull();
    expect(resolveWindowZoomCommand(input({ key: 'K', code: 'KeyK' }), 'win32')).toBeNull();
  });

  it('steps, resets, and clamps the zoom level', () => {
    expect(nextWindowZoomLevel(0, 'in')).toBe(0.5);
    expect(nextWindowZoomLevel(0, 'out')).toBe(-0.5);
    expect(nextWindowZoomLevel(2, 'reset')).toBe(0);
    expect(nextWindowZoomLevel(5, 'in')).toBe(5);
    expect(nextWindowZoomLevel(-5, 'out')).toBe(-5);
  });

  it('tears down safely after the BrowserWindow has been destroyed', () => {
    let destroyed = false;
    const webContents = {
      getZoomLevel: vi.fn(() => 0),
      isDestroyed: vi.fn(() => destroyed),
      on: vi.fn(),
      removeListener: vi.fn(),
      setZoomLevel: vi.fn(),
    };
    const window = {
      isDestroyed: () => destroyed,
      get webContents() {
        if (destroyed) throw new TypeError('Object has been destroyed');
        return webContents;
      },
    } as unknown as Parameters<typeof installWindowZoomShortcuts>[0];

    const removeShortcuts = installWindowZoomShortcuts(window);
    destroyed = true;

    expect(removeShortcuts).not.toThrow();
  });
});
