import type { AppSettings } from '../shared/contracts/ipc';
import type { ThemeDefinition } from '../shared/themes';
import { applyFonts } from './fonts';
import { applyTheme, resolveTheme } from './theme';

type VisualSettings = Pick<
  AppSettings,
  'appearance' | 'codeFont' | 'holyShitMode' | 'interfaceFont' | 'performanceMode' | 'reduceMotion' | 'themeId'
>;

export function applyNonThemeVisualSettings(settings: VisualSettings): void {
  const root = document.documentElement;
  const performanceMode = settings.performanceMode || settings.reduceMotion || settings.holyShitMode;
  root.dataset.reduceMotion = String(performanceMode);
  root.dataset.performanceMode = String(performanceMode);
  root.dataset.holyShitMode = String(settings.holyShitMode);
  root.dataset.appearance = settings.appearance;
  applyFonts(settings.interfaceFont, settings.codeFont);
}

export function applyVisualSettings(
  settings: VisualSettings,
  themes: readonly ThemeDefinition[],
  options: { persistTheme?: boolean } = {},
): void {
  applyNonThemeVisualSettings(settings);
  applyTheme(resolveTheme(themes, settings.themeId), { persist: options.persistTheme });
}
