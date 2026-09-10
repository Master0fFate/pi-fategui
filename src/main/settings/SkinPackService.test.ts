import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SkinPackService } from './SkinPackService';
import { MAX_SKIN_MANIFEST_BYTES } from '../../shared/skins';

vi.mock('electron', () => ({ nativeImage: {} }));
let root: string;
const manifest = { schemaVersion: 1, id: 'test-pack', name: 'Test pack', version: '1.0.0', description: 'A validated pack.', base: 'dreamcore', layout: { contentWidth: 840 } };
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'fate-skin-pack-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
async function source(extra: Record<string, unknown> = {}) {
  const folder = path.join(root, `source-${Math.random().toString(16).slice(2)}`);
  await mkdir(folder);
  await writeFile(path.join(folder, 'skin.json'), JSON.stringify({ ...manifest, ...extra }));
  return folder;
}
const service = () => new SkinPackService(path.join(root, 'data'));

describe('skin pack filesystem boundary', () => {
  it('installs, discovers after restart, exports, and removes only its pack folder', async () => {
    const input = await source();
    await writeFile(path.join(input, 'README.md'), 'Pack credits');
    const packs = service();
    const result = await packs.importFolder(input);
    expect(result.importedId).toBe('pack:test-pack');
    expect(result.catalog.storagePath).toBe(path.join(root, 'data', 'skins'));
    expect(result.catalog.skins.find((skin) => skin.id === result.importedId)).toMatchObject({ base: 'dreamcore', origin: 'pack', layout: { contentWidth: 840 } });
    expect((await service().list()).skins).toHaveLength(3);
    const destination = path.join(root, 'export');
    await mkdir(destination);
    const exported = await packs.exportFolder(result.importedId, destination);
    expect(JSON.parse(await readFile(path.join(exported, 'skin.json'), 'utf8'))).toEqual(manifest);
    expect(await readFile(path.join(exported, 'README.md'), 'utf8')).toBe('Pack credits');
    await expect(packs.exportFolder(result.importedId, destination)).rejects.toThrow('already exists');
    await packs.remove(result.importedId);
    expect((await packs.list()).skins).toHaveLength(2);
    expect(await readdir(packs.storagePath)).toEqual([]);
    expect(JSON.parse(await readFile(path.join(input, 'skin.json'), 'utf8'))).toEqual(manifest);
    expect(await readFile(path.join(exported, 'README.md'), 'utf8')).toBe('Pack credits');
  });

  it('rejects duplicate/concurrent installs without overwriting an existing pack', async () => {
    const input = await source();
    const packs = service();
    const results = await Promise.allSettled([packs.importFolder(input), packs.importFolder(input)]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await packs.list()).skins.filter((skin) => skin.origin === 'pack')).toHaveLength(1);
  });

  it('normalizes image bytes once on import and exports the normalized asset', async () => {
    const png = await readFile(path.resolve('examples/skins/ashen-terminal/background.png'));
    const prepare = vi.fn(() => png);
    const packs = new SkinPackService(path.join(root, 'data'), prepare);
    const input = await source({ background: { file: 'background.png', opacity: 0.1 } });
    await writeFile(path.join(input, 'background.png'), png);
    await packs.importFolder(input);
    await packs.list();
    await packs.list();
    expect(prepare).toHaveBeenCalledOnce();
    const installed = await readFile(path.join(packs.storagePath, manifest.id, 'background.png'));
    expect(installed).toEqual(png);
    expect((await packs.list()).skins.at(-1)?.background?.data).toBe(png.toString('base64'));
  });

  it.each(['run.js', 'theme.css', 'index.html', 'nested'])('rejects unsupported entry %s', async (name) => {
    const input = await source();
    if (name === 'nested') await mkdir(path.join(input, name));
    else await writeFile(path.join(input, name), 'untrusted');
    const packs = service();
    await expect(packs.importFolder(input)).rejects.toThrow('Unsupported skin file');
    expect(await readdir(packs.storagePath)).toEqual([]);
  });

  it('rejects oversized files and PNG impersonation before copying anything', async () => {
    const input = await source();
    const packs = service();
    await writeFile(path.join(input, 'skin.json'), ' '.repeat(MAX_SKIN_MANIFEST_BYTES + 1));
    await expect(packs.importFolder(input)).rejects.toThrow('limit');
    const imageInput = await source({ background: { file: 'background.png' } });
    await writeFile(path.join(imageInput, 'background.png'), '<svg><script/></svg>');
    await expect(packs.importFolder(imageInput)).rejects.toThrow('real PNG');
    expect(await readdir(packs.storagePath)).toEqual([]);
  });

  it('rejects hard-linked files and linked source directories', async () => {
    const input = await source();
    await link(path.join(input, 'skin.json'), path.join(root, 'another-manifest.json'));
    await expect(service().importFolder(input)).rejects.toThrow('not links');
    const regular = await source();
    const linked = path.join(root, 'linked');
    await symlink(regular, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(service().importFolder(linked)).rejects.toThrow('symlink or junction');
  });

  it('refuses a symlinked installation root and preserves outside contents', async () => {
    const outside = path.join(root, 'outside');
    const data = path.join(root, 'data');
    await mkdir(outside); await mkdir(data);
    await writeFile(path.join(outside, 'keep.txt'), 'keep');
    await symlink(outside, path.join(data, 'skins'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(service().importFolder(await source())).rejects.toThrow();
    expect(await readdir(outside)).toEqual(['keep.txt']);
  });

  it('reports malformed and mismatched installed folders instead of loading them', async () => {
    const packs = service();
    await packs.list();
    const folder = path.join(packs.storagePath, 'wrong-pack');
    await mkdir(folder);
    await writeFile(path.join(folder, 'skin.json'), JSON.stringify(manifest));
    const result = await packs.list();
    expect(result.skins).toHaveLength(2);
    expect(result.diagnostics[0]).toContain('folder name must match');
    await expect(packs.remove('pack:wrong-pack')).rejects.toThrow('not the requested');
    await expect(packs.remove('default')).rejects.toThrow();
    await expect(packs.remove('pack:../outside')).rejects.toThrow();
    expect(await readdir(folder)).toEqual(['skin.json']);
  });
});
