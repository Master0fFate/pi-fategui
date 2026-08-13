import { afterEach, describe, expect, it } from 'vitest';
import { builtInThemes } from '../shared/themes';
import { applyTheme, persistAppliedTheme, readStoredTheme, THEME_STORAGE_KEY } from './theme';

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themeTone;
});

describe('theme boot persistence', () => {
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

  it('returns null for missing, malformed, or invalid storage', () => {
    expect(readStoredTheme()).toBeNull();

    localStorage.setItem(THEME_STORAGE_KEY, 'not json');
    expect(readStoredTheme()).toBeNull();

    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ id: 'broken' }));
    expect(readStoredTheme()).toBeNull();
  });
});
