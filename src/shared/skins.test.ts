import { describe, expect, it } from 'vitest';
import { builtInSkins, skinDefinitionSchema, skinPackManifestSchema, skinPackIdSchema, skinIdSchema } from './skins';

const pack = { schemaVersion: 1, id: 'test-pack', name: 'Test pack', version: '1.0.0', description: 'An inert test pack.', base: 'dreamcore' };
describe('declarative skin contracts', () => {
  it('accepts known presets and bounded layout options', () => {
    expect(skinPackManifestSchema.parse({ ...pack, layout: { contentWidth: 840, contentPadding: 32, controlRadius: 0, ruleContrast: 'strong' } }).base).toBe('dreamcore');
    for (const skin of builtInSkins) expect(skinDefinitionSchema.parse(skin)).toEqual(skin);
    expect(builtInSkins.find((skin) => skin.id === 'dreamcore')?.name).toBe('Angelcore');
    expect(skinIdSchema.parse('pack:test-pack')).toBe('pack:test-pack');
    expect(skinIdSchema.parse('legacy-missing')).toBe('default');
  });
  it.each(['../outside', '/absolute', 'C:\\outside', 'CON', 'con', 'aux', 'com1', 'dreamcore', 'angelcore', 'a.b'])('rejects unsafe or reserved folder ID %s', (id) => {
    expect(skinPackManifestSchema.safeParse({ ...pack, id }).success).toBe(false);
    expect(skinPackIdSchema.safeParse(`pack:${id}`).success).toBe(false);
  });
  it.each([{ css: '*{display:none}' }, { script: 'run.js' }, { schemaVersion: 2 }, { base: 'custom-react' }, { layout: { contentWidth: 1 } }, { layout: { opacity: 0 } }, { background: { file: '../secret.png' } }, { background: { file: 'https://example.com/a.png' } }])('rejects unsupported or executable fields %j', (extra) => {
    expect(skinPackManifestSchema.safeParse({ ...pack, ...extra }).success).toBe(false);
  });
});
