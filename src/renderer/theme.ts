import { builtInThemes, type ThemeDefinition } from '../shared/themes';

const cssTokenNames = {
  canvas: '--theme-canvas', panel: '--theme-panel', raised: '--theme-raised', raisedHover: '--theme-raised-hover',
  border: '--theme-border', borderStrong: '--theme-border-strong', text: '--theme-text', textSoft: '--theme-text-soft',
  muted: '--theme-muted', subtle: '--theme-subtle', accent: '--theme-accent', accentHover: '--theme-accent-hover',
  accentSoft: '--theme-accent-soft', onAccent: '--theme-on-accent', success: '--theme-success', warning: '--theme-warning',
  danger: '--theme-danger', shadow: '--theme-shadow',
} as const;

export const fallbackThemes = [...builtInThemes];

export function applyTheme(theme: ThemeDefinition): void {
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  root.dataset.themeTone = theme.tone;
  root.style.colorScheme = theme.tone;
  for (const [key, variable] of Object.entries(cssTokenNames)) {
    root.style.setProperty(variable, theme.colors[key as keyof ThemeDefinition['colors']]);
  }
  window.dispatchEvent(new CustomEvent('fate-theme-change', { detail: theme }));
}

export function resolveTheme(themes: readonly ThemeDefinition[], id: string): ThemeDefinition {
  return themes.find((theme) => theme.id === id) ?? themes[0] ?? builtInThemes[0]!;
}
