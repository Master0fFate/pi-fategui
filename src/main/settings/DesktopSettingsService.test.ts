import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppLogService } from '../logging/AppLogService';

const native = vi.hoisted(() => ({ getPath: vi.fn(), createFromBuffer: vi.fn(), createFromBitmap: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: native.getPath }, nativeImage: native }));
import { createDesktopSettingsService } from './DesktopSettingsService';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it('preserves lazy desktop legacy migration and explicitly injects the real native preparer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fate-desktop-settings-'));
  roots.push(root);
  native.getPath.mockReset().mockReturnValue(root);
  const service = createDesktopSettingsService(new AppLogService(), {
    dataRoot: path.join(root, 'fate'), piAgentDir: path.join(root, 'pi'),
    piThemes: { discover: async () => ({ themes: [], diagnostics: [] }) },
  });
  expect(native.getPath).not.toHaveBeenCalled();
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({ ...service.get(), thinkingLevel: 'high' }));
  expect((await service.load()).thinkingLevel).toBe('high');
  expect(native.getPath).toHaveBeenCalledWith('userData');
  expect(JSON.parse(await readFile(service.getStoragePath(), 'utf8')).thinkingLevel).toBe('high');

  const source = path.join(root, 'source');
  await mkdir(source);
  const image = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(image);
  image.writeUInt32BE(13, 8); image.write('IHDR', 12, 'ascii');
  image.writeUInt32BE(1, 16); image.writeUInt32BE(1, 20);
  await writeFile(path.join(source, 'background.png'), image);
  await writeFile(path.join(source, 'skin.json'), JSON.stringify({ schemaVersion: 1, id: 'native-pack', name: 'Native', version: '1.0.0', description: 'Native test.', base: 'dreamcore', background: { file: 'background.png' } }));
  native.createFromBuffer.mockReturnValue({ isEmpty: () => false, resize: () => ({ toBitmap: () => Buffer.alloc(4) }) });
  native.createFromBitmap.mockReturnValue({ toPNG: () => image });
  await expect(service.skinPacks.importFolder(source)).resolves.toMatchObject({ importedId: 'pack:native-pack' });
  expect(native.createFromBuffer).toHaveBeenCalledWith(image);
  await service.flush();
});
