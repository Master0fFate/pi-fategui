import { afterEach, describe, expect, it } from 'vitest';
import type { AppSettings } from '../shared/contracts/ipc';
import { applyNonThemeVisualSettings, applyVisualSettings } from './appearance';
import { fallbackThemes, resolveTheme } from './theme';

type VisualSettings = Pick<AppSettings, 'appearance' | 'codeFont' | 'compactMode' | 'holyShitMode' | 'interfaceFont' | 'performanceMode' | 'reduceMotion' | 'skinId' | 'themeId'>;

const visualSettings = (overrides: Partial<VisualSettings> = {}): VisualSettings => ({
  appearance: 'dark',
  codeFont: 'jetbrains-mono',
  compactMode: false,
  holyShitMode: false,
  interfaceFont: 'noto-sans',
  performanceMode: false,
  reduceMotion: false,
  skinId: 'default',
  themeId: 'midnight',
  ...overrides,
});

afterEach(() => {
  delete document.documentElement.dataset.holyShitMode;
  delete document.documentElement.dataset.performanceMode;
  delete document.documentElement.dataset.reduceMotion;
  delete document.documentElement.dataset.compactMode;
  delete document.documentElement.dataset.skin;
});

describe('applyVisualSettings', () => {
  it('treats a legacy Reduced Motion preference as Performance mode', () => {
    applyVisualSettings(visualSettings({ reduceMotion: true }), fallbackThemes);

    expect(document.documentElement.dataset.performanceMode).toBe('true');
    expect(document.documentElement.dataset.reduceMotion).toBe('true');
    expect(document.documentElement.dataset.holyShitMode).toBe('false');
  });

  it('makes Holy sh*t fully effective and fully reversible', () => {
    applyVisualSettings(visualSettings({ holyShitMode: true }), fallbackThemes);
    expect(document.documentElement.dataset.holyShitMode).toBe('true');
    expect(document.documentElement.dataset.performanceMode).toBe('true');
    expect(document.documentElement.dataset.reduceMotion).toBe('true');

    applyVisualSettings(visualSettings(), fallbackThemes);
    expect(document.documentElement.dataset.holyShitMode).toBe('false');
    expect(document.documentElement.dataset.performanceMode).toBe('false');
    expect(document.documentElement.dataset.reduceMotion).toBe('false');
  });

  it('writes Compact mode as a single root flag', () => {
    applyVisualSettings(visualSettings({ compactMode: true }), fallbackThemes);
    expect(document.documentElement.dataset.compactMode).toBe('true');
    applyVisualSettings(visualSettings(), fallbackThemes);
    expect(document.documentElement.dataset.compactMode).toBe('false');
  });

  it('keeps skin and palette independent in either direction', () => {
    applyVisualSettings(visualSettings({ skinId: 'dreamcore', themeId: 'daylight' }), fallbackThemes);
    expect(document.documentElement.dataset.skin).toBe('dreamcore');
    expect(document.documentElement.dataset.theme).toBe('daylight');

    applyVisualSettings(visualSettings({ skinId: 'default', themeId: 'daylight' }), fallbackThemes);
    expect(document.documentElement.dataset.skin).toBe('default');
    expect(document.documentElement.dataset.theme).toBe('daylight');
  });

  it('applies non-theme settings without repainting the theme', () => {
    applyVisualSettings(visualSettings({ themeId: 'midnight' }), fallbackThemes);
    const midnight = resolveTheme(fallbackThemes, 'midnight');
    expect(document.documentElement.dataset.theme).toBe('midnight');
    expect(document.documentElement.style.getPropertyValue('--theme-canvas')).toBe(midnight.colors.canvas);

    applyNonThemeVisualSettings(visualSettings({ themeId: 'daylight', reduceMotion: true }));

    // The theme stays exactly as painted; only motion/font attributes changed.
    expect(document.documentElement.dataset.theme).toBe('midnight');
    expect(document.documentElement.dataset.reduceMotion).toBe('true');
    expect(document.documentElement.style.getPropertyValue('--theme-canvas')).toBe(midnight.colors.canvas);
  });
});
