import { builtInSkins, type SkinDefinition } from './skins';
import { builtInCodeFontSchema, builtInInterfaceFontSchema } from './skinFonts';
import type { SkinAppearance } from './skinStyles';

type AppearanceSettings = {
  skinId: string; interfaceFont: string; codeFont: string;
  compactMode: boolean; compactSessions?: boolean; reduceMotion: boolean; performanceMode: boolean; holyShitMode: boolean;
  skinAppearanceOverrides?: Record<string, SkinAppearance> | undefined;
};

export function resolveSkinAppearance<T extends AppearanceSettings>(settings: T, catalog: readonly SkinDefinition[]): T {
  const skin = catalog.find((entry) => entry.id === settings.skinId) ?? builtInSkins[0]!;
  const base = builtInSkins.find((entry) => entry.id === skin.base);
  const result = { ...settings, ...base?.appearance, ...skin.appearance, ...settings.skinAppearanceOverrides?.[skin.id] };
  const fonts = catalog.flatMap((entry) => entry.fonts ?? []);
  if (!builtInInterfaceFontSchema.safeParse(result.interfaceFont).success && !fonts.some((font) => font.id === result.interfaceFont)) {
    result.interfaceFont = skin.base === 'dreamcore' ? 'jetbrains-mono' : 'noto-sans';
  }
  if (!builtInCodeFontSchema.safeParse(result.codeFont).success && !fonts.some((font) => font.id === result.codeFont && font.monospace)) result.codeFont = 'jetbrains-mono';
  return result;
}

export function overrideSkinAppearance<T extends AppearanceSettings>(settings: T, override: SkinAppearance): T {
  return { ...settings, skinAppearanceOverrides: { ...settings.skinAppearanceOverrides, [settings.skinId]: { ...settings.skinAppearanceOverrides?.[settings.skinId], ...override } } };
}

export function resetSkinAppearance<T extends AppearanceSettings>(settings: T): T {
  const overrides = { ...settings.skinAppearanceOverrides };
  delete overrides[settings.skinId];
  return { ...settings, skinAppearanceOverrides: overrides };
}

export function removePackFontPreferences<T extends AppearanceSettings>(settings: T, packId: string): T {
  const prefix = `skin-font:${packId.slice(5)}:`;
  const overrides = Object.fromEntries(Object.entries(settings.skinAppearanceOverrides ?? {}).map(([id, value]) => {
    const next = { ...value };
    if (next.interfaceFont?.startsWith(prefix)) delete next.interfaceFont;
    if (next.codeFont?.startsWith(prefix)) delete next.codeFont;
    return [id, next];
  }));
  return {
    ...settings,
    interfaceFont: settings.interfaceFont.startsWith(prefix) ? 'noto-sans' : settings.interfaceFont,
    codeFont: settings.codeFont.startsWith(prefix) ? 'jetbrains-mono' : settings.codeFont,
    ...(settings.skinAppearanceOverrides ? { skinAppearanceOverrides: overrides } : {}),
  };
}
