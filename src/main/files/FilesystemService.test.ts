// @vitest-environment node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({ openPath: vi.fn() }));

vi.mock('electron', () => ({ shell: { openPath: electronMocks.openPath } }));

import { FilesystemService, MAX_FILE_PREVIEW_BYTES } from './FilesystemService';

const temporary: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-desktop-files-'));
  temporary.push(directory);
  return directory;
}

afterEach(async () => {
  vi.useRealTimers();
  electronMocks.openPath.mockReset();
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

    if (process.platform !== 'win32') {
      await fs.writeFile(path.join(root, 'payload.cmd'), 'echo unsafe');
      await fs.symlink(path.join(root, 'payload.cmd'), path.join(root, 'notes.txt'));
      await expect(service.open('notes.txt')).resolves.toMatchObject({ opened: false, error: expect.stringMatching(/linked files/i) });
    }
  });

  it('bounds searches even when a project contains an extreme number of entries', async () => {
    const root = await tempDirectory();
    await Promise.all(Array.from({ length: 51 }, (_value, index) => fs.writeFile(path.join(root, `file-${index}.txt`), '')));
    const service = new FilesystemService(50);
    await service.setRoot(root);

    await expect(service.search('not-present')).resolves.toMatchObject({ entries: [], truncated: true });
  });

  it('makes the latest concurrent root request win deterministically', async () => {
    const firstRoot = await tempDirectory();
    const secondRoot = await tempDirectory();
    const service = new FilesystemService();
    const first = service.setRoot(firstRoot);
    const second = service.setRoot(secondRoot);

    await expect(first).rejects.toThrow('superseded');
    await expect(second).resolves.toBeUndefined();
    expect(service.getRoot()).toBe(await fs.realpath(secondRoot));
  });

  it('exposes and restores an explicit no-root state for activation rollback', async () => {
    const root = await tempDirectory();
    const service = new FilesystemService();
    expect(service.getRootOrNull()).toBeNull();

    await service.setRoot(root);
    expect(service.getRootOrNull()).toBe(await fs.realpath(root));
    await service.clearRoot();

    expect(service.getRootOrNull()).toBeNull();
    expect(() => service.getRoot()).toThrow('Open a project');
  });

  it('streams huge directories into a bounded alphabetic result set', async () => {
    const root = await tempDirectory();
    await Promise.all(Array.from({ length: 2_005 }, (_value, index) => fs.writeFile(path.join(root, `file-${String(index).padStart(4, '0')}.txt`), '')));
    const service = new FilesystemService();
    await service.setRoot(root);

    const listing = await service.list();
    expect(listing.entries).toHaveLength(2_000);
    expect(listing.entries[0]?.name).toBe('file-0000.txt');
    expect(listing.entries.at(-1)?.name).toBe('file-1999.txt');
    expect(listing.truncated).toBe(true);
  }, 15_000);

  it('releases the bounded search index after the idle cache window', async () => {
    vi.useFakeTimers();
    const root = await tempDirectory();
    await fs.writeFile(path.join(root, 'app.ts'), '');
    const service = new FilesystemService();
    await service.setRoot(root);
    const opendir = vi.spyOn(fs, 'opendir');

    await service.search('app');
    await service.search('ap');
    expect(opendir).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_001);
    await service.search('app');
    expect(opendir).toHaveBeenCalledTimes(2);
  });

  it('keeps only the best bounded fuzzy matches instead of stopping before later exact hits', async () => {
    const root = await tempDirectory();
    await Promise.all([
      ...Array.from({ length: 100 }, (_value, index) => fs.writeFile(path.join(root, `target-helper-${index}.ts`), '')),
      fs.writeFile(path.join(root, 'target.ts'), ''),
    ]);
    const service = new FilesystemService();
    await service.setRoot(root);

    const result = await service.search('target', 3);
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]?.path).toBe('target.ts');
    expect(result.truncated).toBe(true);
  });

  it('cancels stale index builds and scoring when the project or query changes', async () => {
    const firstRoot = await tempDirectory();
    const secondRoot = await tempDirectory();
    await Promise.all(Array.from({ length: 600 }, (_value, index) => fs.writeFile(path.join(firstRoot, `old-${index}.ts`), '')));
    await Promise.all(Array.from({ length: 600 }, (_value, index) => fs.writeFile(path.join(secondRoot, `file-${index}.ts`), '')));
    const service = new FilesystemService();
    await service.setRoot(firstRoot);

    const staleProjectSearch = service.search('old');
    await service.setRoot(secondRoot);
    await expect(staleProjectSearch).rejects.toThrow('superseded');

    const staleQuery = service.search('target');
    const currentQuery = service.search('file-599');
    await expect(staleQuery).rejects.toThrow('superseded');
    const currentResult = await currentQuery;
    expect(currentResult.entries[0]?.path).toBe('file-599.ts');
  });

  it('rejects stale reads and listings when the root changes during filesystem work', async () => {
    const firstRoot = await tempDirectory();
    const secondRoot = await tempDirectory();
    await fs.writeFile(path.join(firstRoot, 'notes.txt'), 'first');
    await fs.writeFile(path.join(secondRoot, 'notes.txt'), 'second');
    const service = new FilesystemService();
    await service.setRoot(firstRoot);

    const originalOpen = fs.open.bind(fs);
    let releaseOpen: (() => void) | undefined;
    let openStarted: (() => void) | undefined;
    const startedOpen = new Promise<void>((resolve) => { openStarted = resolve; });
    vi.spyOn(fs, 'open').mockImplementationOnce(async (filePath, flags, mode) => {
      openStarted?.();
      await new Promise<void>((resolve) => { releaseOpen = resolve; });
      return originalOpen(filePath, flags, mode);
    });
    const staleRead = service.read('notes.txt');
    await startedOpen;
    await service.setRoot(secondRoot);
    releaseOpen?.();
    await expect(staleRead).rejects.toThrow('active project changed');

    await service.setRoot(firstRoot);
    const originalOpenDirectory = fs.opendir.bind(fs);
    let releaseDirectory: (() => void) | undefined;
    let directoryStarted: (() => void) | undefined;
    const startedDirectory = new Promise<void>((resolve) => { directoryStarted = resolve; });
    vi.spyOn(fs, 'opendir').mockImplementationOnce(async (directoryPath, options) => {
      directoryStarted?.();
      await new Promise<void>((resolve) => { releaseDirectory = resolve; });
      return originalOpenDirectory(directoryPath, options);
    });
    const staleList = service.list();
    await startedDirectory;
    await service.setRoot(secondRoot);
    releaseDirectory?.();
    await expect(staleList).rejects.toThrow('active project changed');
  });

  it('holds a root transition until an external open finishes', async () => {
    const firstRoot = await tempDirectory();
    const secondRoot = await tempDirectory();
    await fs.writeFile(path.join(firstRoot, 'notes.txt'), 'first');
    await fs.writeFile(path.join(secondRoot, 'notes.txt'), 'second');
    const service = new FilesystemService();
    await service.setRoot(firstRoot);
    let releaseShell: (() => void) | undefined;
    let shellStarted: (() => void) | undefined;
    const startedShell = new Promise<void>((resolve) => { shellStarted = resolve; });
    electronMocks.openPath.mockImplementationOnce(async () => {
      shellStarted?.();
      await new Promise<void>((resolve) => { releaseShell = resolve; });
      return '';
    });

    const externalOpen = service.open('notes.txt');
    await startedShell;
    const originalStat = fs.stat.bind(fs);
    let preflightFinished: (() => void) | undefined;
    const finishedPreflight = new Promise<void>((resolve) => { preflightFinished = resolve; });
    vi.spyOn(fs, 'stat').mockImplementationOnce(async (target) => {
      const result = await originalStat(target);
      preflightFinished?.();
      return result;
    });
    let rootChangeSettled = false;
    const rootChange = service.setRoot(secondRoot).finally(() => { rootChangeSettled = true; });
    await finishedPreflight;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(rootChangeSettled).toBe(false);
    expect(service.getRoot()).toBe(await fs.realpath(firstRoot));
    releaseShell?.();

    await expect(externalOpen).resolves.toEqual({ opened: true });
    await expect(rootChange).resolves.toBeUndefined();
    expect(service.getRoot()).toBe(await fs.realpath(secondRoot));
  });

  it('reads a referenced raster image outside the active project', async () => {
    const root = await tempDirectory();
    const outside = await tempDirectory();
    const png = Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
    png.writeUInt32BE(1, 16);
    png.writeUInt32BE(1, 20);
    const imagePath = path.join(outside, 'chakra-video-section.png');
    await fs.writeFile(imagePath, png);
    const service = new FilesystemService();
    await service.setRoot(root);

    await expect(service.readLocalImage(imagePath)).resolves.toEqual({
      data: png.toString('base64'),
      mimeType: 'image/png',
      alt: 'chakra-video-section.png',
    });
  });

  it('detects bounded raster previews by file signature while keeping SVG as text', async () => {
    const root = await tempDirectory();
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('preview-bytes')]);
    await fs.writeFile(path.join(root, 'icon.asset'), png);
    await fs.writeFile(path.join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><circle /></svg>');
    const service = new FilesystemService();
    await service.setRoot(root);

    expect(await service.read('icon.asset')).toMatchObject({
      state: 'image',
      mimeType: 'image/png',
      content: png.toString('base64'),
    });
    expect(await service.read('icon.svg')).toMatchObject({ state: 'text', language: 'xml' });
  });

  it('lists incrementally and reports text, binary, and large files honestly', async () => {
    const root = await tempDirectory();
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'hello world.ts'), 'export const hello = "世界";');
    await fs.writeFile(path.join(root, 'src', 'ConversationTimeline.tsx'), 'export const Timeline = () => null;');
    await fs.writeFile(path.join(root, 'src', 'project-settings.ts'), 'export const settings = {};');
    await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    await fs.writeFile(path.join(root, 'large.txt'), Buffer.alloc(MAX_FILE_PREVIEW_BYTES + 1, 65));
    const service = new FilesystemService();
    await service.setRoot(root);

    expect((await service.list()).entries.map((entry) => entry.name)).toEqual(['binary.bin', 'large.txt', 'src']);
    expect((await service.list('src')).entries.map((entry) => entry.path)).toContain('src/hello world.ts');
    expect(await service.read('src/hello world.ts')).toMatchObject({ state: 'text', language: 'typescript', content: 'export const hello = "世界";' });
    expect(await service.read('binary.bin')).toMatchObject({ state: 'binary' });
    expect(await service.read('large.txt')).toMatchObject({ state: 'large' });
    const opendirSpy = vi.spyOn(fs, 'opendir');
    expect((await service.search('hello')).entries[0]?.path).toBe('src/hello world.ts');
    const indexingCalls = opendirSpy.mock.calls.length;
    expect((await service.search('conversaton')).entries[0]?.path).toBe('src/ConversationTimeline.tsx');
    expect((await service.search('prjct settng')).entries[0]?.path).toBe('src/project-settings.ts');
    expect(opendirSpy).toHaveBeenCalledTimes(indexingCalls);
  });
});
