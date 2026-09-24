import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyFonts, interfaceFontOptions } from './fonts';

beforeEach(() => {
  delete document.documentElement.dataset.interfaceFont;
  delete document.documentElement.dataset.codeFont;
  document.documentElement.style.removeProperty('--font-interface');
  document.documentElement.style.removeProperty('--font-code');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('applyFonts', () => {
  it('offers Roboto Flex with local Roboto/Noto fallbacks while retaining the code font', () => {
    expect(interfaceFontOptions).toContainEqual(expect.objectContaining({ value: 'roboto-flex', label: 'Roboto Flex' }));
    applyFonts('roboto-flex', 'jetbrains-mono');
    expect(document.documentElement.dataset.interfaceFont).toBe('roboto-flex');
    expect(document.documentElement.style.getPropertyValue('--font-interface')).toMatch(/^"Roboto Flex Variable", "Roboto", "Noto Sans Variable"/u);
    expect(document.documentElement.dataset.codeFont).toBe('jetbrains-mono');
  });
  it('avoids repeat style writes and font-change events', () => {
    const styleWrite = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty');
    const listener = vi.fn();
    window.addEventListener('fate-font-change', listener);

    applyFonts('noto-sans', 'jetbrains-mono');
    const writesAfterFirstApply = styleWrite.mock.calls.length;
    applyFonts('noto-sans', 'jetbrains-mono');

    expect(styleWrite.mock.calls).toHaveLength(writesAfterFirstApply);
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener('fate-font-change', listener);
  });

  it('updates only the changed family and keeps code listeners quiet for interface-only changes', () => {
    applyFonts('noto-sans', 'jetbrains-mono');
    const listener = vi.fn();
    window.addEventListener('fate-font-change', listener);

    applyFonts('system', 'jetbrains-mono');

    expect(document.documentElement.dataset.interfaceFont).toBe('system');
    expect(document.documentElement.dataset.codeFont).toBe('jetbrains-mono');
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener('fate-font-change', listener);
  });
});
