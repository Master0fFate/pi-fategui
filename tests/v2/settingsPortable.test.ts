import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppLogService } from '../../src/main/logging/AppLogService';
import { SettingsService } from '../../src/main/settings/SettingsService';
import { SkinPackService } from '../../src/main/settings/SkinPackService';
import { privateTestRoot } from './helpers/isolatedEnvironment';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(privateTestRoot(), 'portable-settings-'));
  roots.push(root);
  return root;
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('Node settings and skins without Electron', () => {
  it('constructs and loads defaults without native migration or provider-root creation', async () => {
    const root = await fixture();
    const dataRoot = path.join(root, 'data');
    const service = new SettingsService(new AppLogService(), dataRoot, undefined, path.join(root, 'pi'));
    await writeFile(path.join(root, 'settings.json'), JSON.stringify({ ...service.get(), thinkingLevel: 'high' }));
    expect((await service.load()).thinkingLevel).toBe('medium');
    await expect(access(dataRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await service.set({ ...service.get(), thinkingLevel: 'low' });
    await service.flush();
    expect(JSON.parse(await readFile(service.getStoragePath(), 'utf8')).thinkingLevel).toBe('low');
  });

  it('uses only the explicitly supplied host legacy path', async () => {
    const root = await fixture();
    const target = path.join(root, 'data');
    const service = new SettingsService(new AppLogService(), target, undefined, path.join(root, 'pi'), {
      legacySettingsPath: () => path.join(root, 'reviewed-legacy.json'),
    });
    await writeFile(path.join(root, 'reviewed-legacy.json'), JSON.stringify({ ...service.get(), thinkingLevel: 'high' }));
    await expect(service.load()).resolves.toMatchObject({ thinkingLevel: 'high' });
    expect(JSON.parse(await readFile(path.join(target, 'settings.json'), 'utf8')).thinkingLevel).toBe('high');
  });

  it('keeps portable pack validation but explicitly refuses image decoding without a host port', async () => {
    const root = await fixture();
    const source = path.join(root, 'source');
    await mkdir(source);
    const manifest = { schemaVersion: 1, id: 'node-pack', name: 'Node pack', version: '1.0.0', description: 'Fixture.', base: 'dreamcore' };
    const png = Buffer.alloc(33);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
    png.writeUInt32BE(13, 8); png.write('IHDR', 12, 'ascii'); png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20);
    await writeFile(path.join(source, 'skin.json'), JSON.stringify({ ...manifest, background: { file: 'background.png' } }));
    await writeFile(path.join(source, 'background.png'), png);
    const packs = new SkinPackService(path.join(root, 'data'));
    await expect(packs.importFolder(source)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', capability: 'skin-background-decoding' });
    expect(await readdir(packs.storagePath)).toEqual([]);
    await rm(path.join(source, 'background.png'));
    await writeFile(path.join(source, 'skin.json'), JSON.stringify(manifest));
    await expect(packs.importFolder(source)).resolves.toMatchObject({ importedId: 'pack:node-pack' });
    await packs.flush();
    expect((await packs.list()).skins.at(-1)?.id).toBe('pack:node-pack');
  });
});
