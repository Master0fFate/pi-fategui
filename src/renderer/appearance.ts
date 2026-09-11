import type { AppSettings } from '../shared/contracts/ipc';
import type { ThemeDefinition } from '../shared/themes';
import { applyFonts } from './fonts';
import { applySkin } from './skin';
import { applyTheme, resolveTheme } from './theme';

type VisualSettings = Pick<
  AppSettings,
  'appearance' | 'codeFont' | 'compactMode' | 'holyShitMode' | 'interfaceFont' | 'performanceMode' | 'reduceMotion' | 'skinId' | 'themeId'
>;

function setDatasetValue(root: HTMLElement, key: string, value: string): void {
  if (root.dataset[key] !== value) root.dataset[key] = value;
}

export function applyNonThemeVisualSettings(
  settings: VisualSettings,
  options: { persistSkin?: boolean | undefined } = {},
): void {
  const root = document.documentElement;
  const performanceMode = settings.performanceMode || settings.reduceMotion || settings.holyShitMode;
  setDatasetValue(root, 'reduceMotion', String(performanceMode));
  setDatasetValue(root, 'performanceMode', String(performanceMode));
  setDatasetValue(root, 'holyShitMode', String(settings.holyShitMode));
  setDatasetValue(root, 'compactMode', String(settings.compactMode));
  setDatasetValue(root, 'appearance', settings.appearance);
  applySkin(settings.skinId, { persist: options.persistSkin });
  applyFonts(settings.interfaceFont, settings.codeFont);
}

export function applyVisualSettings(
  settings: VisualSettings,
  themes: readonly ThemeDefinition[],
  options: { persistSkin?: boolean | undefined; persistTheme?: boolean | undefined } = {},
): void {
  applyNonThemeVisualSettings(settings, { persistSkin: options.persistSkin });
  applyTheme(resolveTheme(themes, settings.themeId), { persist: options.persistTheme });
}
