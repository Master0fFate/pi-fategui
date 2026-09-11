import { describe, expect, it } from 'vitest';
import { appSettingsSchema } from './contracts/ipc';
import { builtInSkins, skinPackManifestSchema, type SkinDefinition } from './skins';
import { overrideSkinAppearance, removePackFontPreferences, resetSkinAppearance, resolveSkinAppearance } from './skinAppearance';

const baseline = () => appSettingsSchema.parse({ appearance: 'dark', defaultModel: null, thinkingLevel: 'medium', confirmRiskyCommands: true, terminalShell: null, reduceMotion: false, interfaceFont: 'poppins', skinId: 'dreamcore' });
describe('effective skin appearance', () => {
  it('shows Angelcore defaults without losing base preferences and honors explicit per-skin overrides', () => {
    const settings = baseline();
    expect(resolveSkinAppearance(settings, builtInSkins).interfaceFont).toBe('jetbrains-mono');
    expect(settings.interfaceFont).toBe('poppins');
    const overridden = overrideSkinAppearance(settings, { interfaceFont: 'inter', compactMode: true });
    expect(resolveSkinAppearance(overridden, builtInSkins)).toMatchObject({ interfaceFont: 'inter', compactMode: true });
    expect(resolveSkinAppearance({ ...overridden, skinId: 'default' }, builtInSkins).interfaceFont).toBe('poppins');
    expect(resolveSkinAppearance(resetSkinAppearance(overridden), builtInSkins).interfaceFont).toBe('jetbrains-mono');
  });
  it('inherits component-base defaults and falls back when an imported font disappears', () => {
    const pack: SkinDefinition = { id: 'pack:font-pack', name: 'Font pack', description: 'Fixture', base: 'dreamcore', origin: 'pack', appearance: { codeFont: 'skin-font:font-pack:mono' } };
    expect(resolveSkinAppearance({ ...baseline(), skinId: pack.id }, [...builtInSkins, pack])).toMatchObject({ interfaceFont: 'jetbrains-mono', codeFont: 'jetbrains-mono' });
    const settings = overrideSkinAppearance(baseline(), { interfaceFont: 'skin-font:font-pack:mono' });
    expect(removePackFontPreferences(settings, pack.id).skinAppearanceOverrides?.dreamcore?.interfaceFont).toBeUndefined();
  });
  it('accepts v2 local fonts and style states, but never operational defaults', () => {
    const pack = { schemaVersion: 2, id: 'font-pack', name: 'Font pack', version: '1.0.0', description: 'Fixture', base: 'dreamcore', fonts: [{ id: 'mono', name: 'My Mono', file: 'mono.woff2', monospace: true }], appearance: { interfaceFont: 'local:mono', codeFont: 'local:mono', compactMode: true }, styles: { normal: { tooltips: { surfaceRadius: 4 } }, compact: { music: { padding: 6 } }, compactSessions: { sidebar: { rowHeight: 26 } } } };
    expect(skinPackManifestSchema.parse(pack).schemaVersion).toBe(2);
    expect(skinPackManifestSchema.safeParse({ ...pack, schemaVersion: 1 }).success).toBe(false);
    expect(skinPackManifestSchema.safeParse({ ...pack, appearance: { ...pack.appearance, confirmRiskyCommands: false } }).success).toBe(false);
    expect(skinPackManifestSchema.safeParse({ ...pack, appearance: { codeFont: 'local:missing' } }).success).toBe(false);
    expect(skinPackManifestSchema.safeParse({ ...pack, fonts: [{ ...pack.fonts[0], monospace: false }] }).success).toBe(false);
    expect(skinPackManifestSchema.safeParse({ ...pack, styles: { normal: { tooltips: { display: 'none' } } } }).success).toBe(false);
  });
});
