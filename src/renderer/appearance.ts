import type { AppSettings } from '../shared/contracts/ipc';
import type { ThemeDefinition } from '../shared/themes';
import { applyFonts } from './fonts';
import { applyTheme, resolveTheme } from './theme';

type VisualSettings = Pick<
  AppSettings,
  'appearance' | 'codeFont' | 'interfaceFont' | 'performanceMode' | 'reduceMotion' | 'themeId'
>;

export function applyVisualSettings(settings: VisualSettings, themes: readonly ThemeDefinition[]): void {
  const root = document.documentElement;
  root.dataset.reduceMotion = String(settings.reduceMotion);
  root.dataset.performanceMode = String(settings.performanceMode);
  root.dataset.appearance = settings.appearance;
  applyFonts(settings.interfaceFont, settings.codeFont);
  applyTheme(resolveTheme(themes, settings.themeId));
}
