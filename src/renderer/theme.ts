import { builtInThemes, themeDefinitionSchema, type ThemeDefinition } from '../shared/themes';

const cssTokenNames = {
  canvas: '--theme-canvas', panel: '--theme-panel', raised: '--theme-raised', raisedHover: '--theme-raised-hover',
  border: '--theme-border', borderStrong: '--theme-border-strong', text: '--theme-text', textSoft: '--theme-text-soft',
  muted: '--theme-muted', subtle: '--theme-subtle', accent: '--theme-accent', accentHover: '--theme-accent-hover',
  accentSoft: '--theme-accent-soft', currentSession: '--theme-current-session', lastActiveSession: '--theme-last-active-session',
  onAccent: '--theme-on-accent', success: '--theme-success', warning: '--theme-warning',
  danger: '--theme-danger', shadow: '--theme-shadow',
} as const;

export const fallbackThemes = [...builtInThemes];

/**
 * Persisted snapshot of the last applied theme. The renderer restores it
 * synchronously at boot so the window never flashes the default palette while
 * settings and the Pi theme catalog load asynchronously.
 */
export const THEME_STORAGE_KEY = 'fate:theme:last-applied';

export function persistAppliedTheme(theme: ThemeDefinition): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme));
  } catch {
    // Storage can be unavailable (blocked storage, privacy mode, tests). The
    // theme still applies for this session; boot restore is best-effort only.
  }
}

/** Restore the persisted theme snapshot, or null when absent or invalid. */
export function readStoredTheme(): ThemeDefinition | null {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return null;
    return themeDefinitionSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function applyTheme(theme: ThemeDefinition, options: { persist?: boolean | undefined } = {}): void {
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  root.dataset.themeTone = theme.tone;
  root.style.colorScheme = theme.tone;
  for (const [key, variable] of Object.entries(cssTokenNames)) {
    root.style.setProperty(variable, theme.colors[key as keyof ThemeDefinition['colors']]);
  }
  window.dispatchEvent(new CustomEvent('fate-theme-change', { detail: theme }));
  if (options.persist !== false) persistAppliedTheme(theme);
}

export function resolveTheme(themes: readonly ThemeDefinition[], id: string): ThemeDefinition {
  return themes.find((theme) => theme.id === id) ?? themes[0] ?? builtInThemes[0]!;
}
