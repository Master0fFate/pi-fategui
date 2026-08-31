import { z } from 'zod';

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex color such as #7c6cff');

export const themeColorsSchema = z.object({
  canvas: hexColor,
  panel: hexColor,
  raised: hexColor,
  raisedHover: hexColor,
  border: hexColor,
  borderStrong: hexColor,
  text: hexColor,
  textSoft: hexColor,
  muted: hexColor,
  subtle: hexColor,
  accent: hexColor,
  accentHover: hexColor,
  accentSoft: hexColor,
  /** Background for the session that receives the next prompt. */
  currentSession: hexColor.optional(),
  /** Background for a session remembered as active in another project. */
  lastActiveSession: hexColor.optional(),
  onAccent: hexColor,
  success: hexColor,
  warning: hexColor,
  danger: hexColor,
  shadow: hexColor,
}).strict().transform((colors) => ({
  ...colors,
  // Themes created before session states were separate keep a clear fallback.
  currentSession: colors.currentSession ?? colors.accentSoft,
  lastActiveSession: colors.lastActiveSession ?? colors.raised,
}));

export const themeDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,47}$/),
  name: z.string().trim().min(2).max(48),
  tone: z.enum(['dark', 'light']),
  colors: themeColorsSchema,
}).strict();

export const themeCatalogSchema = z.array(themeDefinitionSchema).min(1).max(128);
export const customThemeFileSchema = z.union([
  z.array(themeDefinitionSchema).max(24),
  z.object({ themes: z.array(themeDefinitionSchema).max(24) }).strict().transform((value) => value.themes),
]);

export type ThemeDefinition = z.infer<typeof themeDefinitionSchema>;
export type ThemeColors = z.infer<typeof themeColorsSchema>;

export const builtInThemes: readonly ThemeDefinition[] = [
  {
    id: 'catppuccin-mocha', name: 'Catppuccin Mocha', tone: 'dark',
    colors: { canvas: '#11111b', panel: '#181825', raised: '#1e1e2e', raisedHover: '#313244', border: '#313244', borderStrong: '#45475a', text: '#cdd6f4', textSoft: '#bac2de', muted: '#a6adc8', subtle: '#6c7086', accent: '#cba6f7', accentHover: '#b4befe', accentSoft: '#313244', currentSession: '#39334d', lastActiveSession: '#1e1e2e', onAccent: '#11111b', success: '#a6e3a1', warning: '#f9e2af', danger: '#f38ba8', shadow: '#000000' },
  },
  {
    id: 'catppuccin-latte', name: 'Catppuccin Latte', tone: 'light',
    colors: { canvas: '#dce0e8', panel: '#e6e9ef', raised: '#eff1f5', raisedHover: '#ccd0da', border: '#ccd0da', borderStrong: '#bcc0cc', text: '#4c4f69', textSoft: '#5c5f77', muted: '#6c6f85', subtle: '#9ca0b0', accent: '#8839ef', accentHover: '#7287fd', accentSoft: '#e6e9ef', currentSession: '#e8e2f2', lastActiveSession: '#eff1f5', onAccent: '#eff1f5', success: '#40a02b', warning: '#df8e1d', danger: '#d20f39', shadow: '#9ca0b0' },
  },
  {
    id: 'midnight', name: 'Midnight', tone: 'dark',
    colors: { canvas: '#090b12', panel: '#0f121c', raised: '#171b28', raisedHover: '#202536', border: '#292f3e', borderStrong: '#3b4357', text: '#eef0f7', textSoft: '#c4c9d4', muted: '#8992a7', subtle: '#626c80', accent: '#7c6cff', accentHover: '#9589ff', accentSoft: '#24213f', currentSession: '#282746', lastActiveSession: '#171b28', onAccent: '#ffffff', success: '#55c78a', warning: '#d2a94b', danger: '#e35d6a', shadow: '#020308' },
  },
  {
    id: 'daylight', name: 'Daylight', tone: 'light',
    colors: { canvas: '#f5f7fb', panel: '#ffffff', raised: '#edf1f7', raisedHover: '#e2e7f0', border: '#d5dbe6', borderStrong: '#b7c0d0', text: '#171b26', textSoft: '#343b4b', muted: '#59657a', subtle: '#7c8799', accent: '#5f50d8', accentHover: '#4d40bd', accentSoft: '#e8e5ff', currentSession: '#d4d1f0', lastActiveSession: '#edf1f7', onAccent: '#ffffff', success: '#237a4b', warning: '#8a6508', danger: '#b33b4a', shadow: '#63708a' },
  },
  {
    id: 'graphite', name: 'Graphite', tone: 'dark',
    colors: { canvas: '#111214', panel: '#17191c', raised: '#202328', raisedHover: '#2a2e34', border: '#343941', borderStrong: '#4b535f', text: '#f1f2f4', textSoft: '#c9cdd2', muted: '#9299a3', subtle: '#69717c', accent: '#79a7ff', accentHover: '#98bbff', accentSoft: '#202d43', currentSession: '#2a3443', lastActiveSession: '#202328', onAccent: '#0c1524', success: '#66c993', warning: '#d6ae61', danger: '#e67882', shadow: '#050607' },
  },
  {
    id: 'forest', name: 'Forest', tone: 'dark',
    colors: { canvas: '#09110f', panel: '#0e1916', raised: '#15231f', raisedHover: '#1d302a', border: '#284139', borderStrong: '#3c5d52', text: '#edf5f1', textSoft: '#c2d3cc', muted: '#819a90', subtle: '#5d776d', accent: '#62c79a', accentHover: '#7bd8ad', accentSoft: '#173a2d', currentSession: '#243b34', lastActiveSession: '#15231f', onAccent: '#07140f', success: '#68d391', warning: '#d8b45f', danger: '#e47a7f', shadow: '#020806' },
  },
  {
    id: 'ember', name: 'Ember', tone: 'light',
    colors: { canvas: '#faf6f2', panel: '#fffdfb', raised: '#f2eae3', raisedHover: '#eaded4', border: '#ddcfc3', borderStrong: '#c3ad9c', text: '#2a211c', textSoft: '#493b33', muted: '#716158', subtle: '#918078', accent: '#b94f33', accentHover: '#9e3f27', accentSoft: '#f6ddd3', currentSession: '#f1d6cf', lastActiveSession: '#f2eae3', onAccent: '#ffffff', success: '#327452', warning: '#8b650c', danger: '#af3f47', shadow: '#806b5d' },
  },
] as const;
