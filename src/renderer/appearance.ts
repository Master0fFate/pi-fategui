import type { AppSettings } from '../shared/contracts/ipc';
import type { ThemeDefinition } from '../shared/themes';
import { applyFonts } from './fonts';
import { applySkin, getAppliedSkin, getSkinDefinitions } from './skin';
import { resolveSkinAppearance } from '../shared/skinAppearance';
import { applySurfaceStyles } from './skins/surfaceStyles';
import { applyTheme, resolveTheme } from './theme';

type VisualSettings = Pick<
  AppSettings,
  'appearance' | 'codeFont' | 'compactMode' | 'holyShitMode' | 'interfaceFont' | 'performanceMode' | 'reduceMotion' | 'skinId' | 'themeId'
> & Partial<Pick<AppSettings, 'compactSessions' | 'skinAppearanceOverrides'>>;

function setDatasetValue(root: HTMLElement, key: string, value: string): void {
  if (root.dataset[key] !== value) root.dataset[key] = value;
}

export function applyNonThemeVisualSettings(
  settings: VisualSettings,
  options: { persistSkin?: boolean | undefined } = {},
): void {
  settings = resolveSkinAppearance(settings, getSkinDefinitions());
  const root = document.documentElement;
  const performanceMode = settings.performanceMode || settings.reduceMotion || settings.holyShitMode;
  setDatasetValue(root, 'reduceMotion', String(performanceMode));
  setDatasetValue(root, 'performanceMode', String(performanceMode));
  setDatasetValue(root, 'holyShitMode', String(settings.holyShitMode));
  setDatasetValue(root, 'compactMode', String(settings.compactMode));
  setDatasetValue(root, 'compactSessions', String(settings.compactSessions ?? false));
  setDatasetValue(root, 'appearance', settings.appearance);
  applySkin(settings.skinId, { persist: options.persistSkin });
  applySurfaceStyles(getAppliedSkin(), settings.compactMode, settings.compactSessions ?? false);
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
