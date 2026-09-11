import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { applyFonts, getFontOptions, getFontStatus } from './fonts';
import { setSkinDefinitions } from './skin';
import { builtInSkins, type SkinDefinition } from '../shared/skins';

const pack: SkinDefinition = { id: 'pack:font-test', name: 'Font test', description: 'Fixture', origin: 'pack', base: 'dreamcore', fonts: [{ id: 'skin-font:font-test:mono', name: 'Fixture Mono', format: 'woff2', monospace: true, data: 'AAAA' }] };
let oldFonts: PropertyDescriptor | undefined;
let load: ReturnType<typeof vi.fn>;
beforeEach(() => {
  oldFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
  Object.defineProperty(document, 'fonts', { configurable: true, value: { add: vi.fn(), delete: vi.fn() } });
  load = vi.fn(async function(this: unknown) { return this; });
  vi.stubGlobal('FontFace', class { load = load; constructor(public family: string) {} });
  setSkinDefinitions([...builtInSkins, pack]);
});
afterEach(() => {
  setSkinDefinitions(builtInSkins);
  applyFonts('noto-sans', 'jetbrains-mono');
  if (oldFonts) Object.defineProperty(document, 'fonts', oldFonts);
  else Reflect.deleteProperty(document, 'fonts');
  vi.unstubAllGlobals();
});
it('offers bundled fonts in both pickers and loads a shared face only once', async () => {
  expect(getFontOptions([...builtInSkins, pack], 'interface')).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Fixture Mono' })]));
  expect(getFontOptions([...builtInSkins, pack], 'code')).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Fixture Mono' })]));
  applyFonts(pack.fonts![0]!.id, pack.fonts![0]!.id);
  await waitFor(() => expect(getFontStatus().pending).toEqual([]));
  expect(load).toHaveBeenCalledOnce();
  expect(document.documentElement.style.getPropertyValue('--font-interface')).toContain('FateSkin_skin_font_font_test_mono');
  applyFonts(pack.fonts![0]!.id, pack.fonts![0]!.id);
  expect(load).toHaveBeenCalledOnce();
});
it('reports a failed font and keeps the actual fallback through later appearance changes', async () => {
  load.mockRejectedValue(new Error('Invalid font'));
  applyFonts(pack.fonts![0]!.id, 'jetbrains-mono');
  await waitFor(() => expect(getFontStatus().fallback.interface).toBe('noto-sans'));
  applyFonts(pack.fonts![0]!.id, 'jetbrains-mono');
  expect(document.documentElement.dataset.interfaceFont).toBe('noto-sans');
  expect(document.documentElement.style.getPropertyValue('--font-interface')).not.toContain('FateSkin_');
});
