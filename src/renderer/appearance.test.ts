import { afterEach, describe, expect, it } from 'vitest';
import type { AppSettings } from '../shared/contracts/ipc';
import { applyVisualSettings } from './appearance';
import { fallbackThemes } from './theme';

type VisualSettings = Pick<AppSettings, 'appearance' | 'codeFont' | 'holyShitMode' | 'interfaceFont' | 'performanceMode' | 'reduceMotion' | 'themeId'>;

const visualSettings = (overrides: Partial<VisualSettings> = {}): VisualSettings => ({
  appearance: 'dark',
  codeFont: 'jetbrains-mono',
  holyShitMode: false,
  interfaceFont: 'noto-sans',
  performanceMode: false,
  reduceMotion: false,
  themeId: 'midnight',
  ...overrides,
});

afterEach(() => {
  delete document.documentElement.dataset.holyShitMode;
  delete document.documentElement.dataset.performanceMode;
  delete document.documentElement.dataset.reduceMotion;
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
});
