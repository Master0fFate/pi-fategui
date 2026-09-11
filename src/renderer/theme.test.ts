import { afterEach, describe, expect, it, vi } from 'vitest';
import { builtInThemes } from '../shared/themes';
import { applyTheme, persistAppliedTheme, readStoredTheme, THEME_STORAGE_KEY } from './theme';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themeTone;
});

describe('theme boot persistence', () => {
  it('gives every built-in theme distinct current and last-active session colors', () => {
    for (const theme of builtInThemes) {
      expect(theme.colors.currentSession).toMatch(/^#[0-9a-f]{6}$/iu);
      expect(theme.colors.lastActiveSession).toMatch(/^#[0-9a-f]{6}$/iu);
      expect(theme.colors.currentSession).not.toBe(theme.colors.lastActiveSession);
    }
  });

  it('persists the applied theme and restores it unchanged', () => {
    const theme = builtInThemes[1]!;
    applyTheme(theme);

    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? 'null')).toEqual(theme);
    expect(readStoredTheme()).toEqual(theme);
  });

  it('skips persistence when explicitly disabled', () => {
    applyTheme(builtInThemes[0]!);
    localStorage.removeItem(THEME_STORAGE_KEY);

    applyTheme(builtInThemes[2]!, { persist: false });

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('persistAppliedTheme stores a theme without applying it', () => {
    persistAppliedTheme(builtInThemes[3]!);

    expect(readStoredTheme()).toEqual(builtInThemes[3]!);
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('skips repeated DOM events and storage writes for an unchanged palette', () => {
    const listener = vi.fn();
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    window.addEventListener('fate-theme-change', listener);

    applyTheme(builtInThemes[2]!);
    applyTheme(builtInThemes[2]!);

    expect(listener).toHaveBeenCalledOnce();
    expect(storageWrite).toHaveBeenCalledOnce();
    window.removeEventListener('fate-theme-change', listener);
  });

  it('repaints when a same-id theme changes colors', () => {
    const original = builtInThemes[2]!;
    const changed = { ...original, colors: { ...original.colors, canvas: '#010203' } };
    const listener = vi.fn();
    window.addEventListener('fate-theme-change', listener);

    applyTheme(original, { persist: false });
    applyTheme(changed, { persist: false });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(document.documentElement.dataset.theme).toBe(original.id);
    expect(document.documentElement.style.getPropertyValue('--theme-canvas')).toBe('#010203');
    window.removeEventListener('fate-theme-change', listener);
  });

  it('returns null for missing, malformed, or invalid storage', () => {
    expect(readStoredTheme()).toBeNull();

    localStorage.setItem(THEME_STORAGE_KEY, 'not json');
    expect(readStoredTheme()).toBeNull();

    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ id: 'broken' }));
    expect(readStoredTheme()).toBeNull();
  });
});
