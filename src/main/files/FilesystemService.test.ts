// @vitest-environment node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilesystemService, MAX_FILE_PREVIEW_BYTES } from './FilesystemService';

const temporary: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-desktop-files-'));
  temporary.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('FilesystemService confinement', () => {
  it('rejects absolute paths, traversal, and symlinks escaping the root', async () => {
    const root = await tempDirectory();
    const outside = await tempDirectory();
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const service = new FilesystemService();
    await service.setRoot(root);

    await expect(service.read(path.join(root, 'absolute.txt'))).rejects.toThrow('outside the active project');
    await expect(service.read('../secret.txt')).rejects.toThrow('outside the active project');
    await expect(service.read('escape/secret.txt')).rejects.toThrow('outside the active project');
    await expect(service.confinePath('escape/missing.txt')).rejects.toThrow('outside the active project');
    expect((await service.list()).entries).toEqual([]);
  });

  it('lists incrementally and reports text, binary, and large files honestly', async () => {
    const root = await tempDirectory();
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'hello world.ts'), 'export const hello = "世界";');
    await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    await fs.writeFile(path.join(root, 'large.txt'), Buffer.alloc(MAX_FILE_PREVIEW_BYTES + 1, 65));
    const service = new FilesystemService();
    await service.setRoot(root);

    expect((await service.list()).entries.map((entry) => entry.name)).toEqual(['binary.bin', 'large.txt', 'src']);
    expect((await service.list('src')).entries[0]?.path).toBe('src/hello world.ts');
    expect(await service.read('src/hello world.ts')).toMatchObject({ state: 'text', language: 'typescript', content: 'export const hello = "世界";' });
    expect(await service.read('binary.bin')).toMatchObject({ state: 'binary' });
    expect(await service.read('large.txt')).toMatchObject({ state: 'large' });
    expect((await service.search('hello')).entries[0]?.path).toBe('src/hello world.ts');
  });
});
