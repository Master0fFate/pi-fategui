// @vitest-environment node
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilesystemService, MAX_FILE_PREVIEW_BYTES, rasterImageMimeType } from '../../src/main/files/FilesystemService';
import { GitService } from '../../src/main/git/GitService';

// No Electron mock: this module and its image helpers must import in a real Node process.
const roots: string[] = [];
async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-portable-files-'));
  roots.push(root);
  return root;
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

describe('portable file service', () => {
  it('keeps two bound roots and their paired Git service independent', async () => {
    const firstRoot = await directory();
    const secondRoot = await directory();
    await fs.writeFile(path.join(firstRoot, 'sentinel.txt'), 'workspace A');
    await fs.writeFile(path.join(secondRoot, 'sentinel.txt'), 'workspace B');
    const [first, second] = await Promise.all([FilesystemService.forRoot(firstRoot), FilesystemService.forRoot(secondRoot)]);
    const firstGit = new GitService(first);
    const secondGit = new GitService(second);
    expect(firstGit).not.toBe(secondGit);
    for (const root of [firstRoot, secondRoot]) {
      execFileSync('git', ['init', '-q', root]);
      execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'root'], { cwd: root });
    }
    await fs.writeFile(path.join(firstRoot, 'only-a.txt'), 'A');
    await fs.writeFile(path.join(secondRoot, 'only-b.txt'), 'B');
    const [firstStatus, secondStatus] = await Promise.all([firstGit.status(), secondGit.status()]);
    expect(firstStatus.changes.map((change) => change.path)).toContain('only-a.txt');
    expect(firstStatus.changes.map((change) => change.path)).not.toContain('only-b.txt');
    expect(secondStatus.changes.map((change) => change.path)).toContain('only-b.txt');
    expect(secondStatus.changes.map((change) => change.path)).not.toContain('only-a.txt');
    const [a, b] = await Promise.all([first.read('sentinel.txt'), second.read('sentinel.txt')]);
    expect(a).toMatchObject({ state: 'text', content: 'workspace A' });
    expect(b).toMatchObject({ state: 'text', content: 'workspace B' });
    await expect(first.setRoot(secondRoot)).rejects.toThrow('bound file service');
    await expect(first.clearRoot()).rejects.toThrow('bound file service');
    expect(first.getRoot()).toBe(await fs.realpath(firstRoot));
    expect(second.getRoot()).toBe(await fs.realpath(secondRoot));
  });

  it('reports unsupported local opening explicitly rather than a success no-op', async () => {
    const root = await directory();
    await fs.writeFile(path.join(root, 'notes.txt'), 'hello');
    const files = await FilesystemService.forRoot(root);
    await expect(files.open('notes.txt')).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(files.revealLink('notes.txt')).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect((await files.read('notes.txt')).state).toBe('text');
  });

  it('uses only the injected port after canonical confinement and extension checks', async () => {
    const root = await directory();
    await fs.writeFile(path.join(root, 'notes.txt'), 'hello');
    await fs.writeFile(path.join(root, 'payload.cmd'), 'echo unsafe');
    const actions = { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() };
    const files = await FilesystemService.forRoot(root, { localFileActions: actions });
    await expect(files.open('notes.txt')).resolves.toEqual({ opened: true });
    expect(actions.openPath).toHaveBeenCalledWith({ origin: 'local', path: await fs.realpath(path.join(root, 'notes.txt')) });
    await expect(files.open('payload.cmd')).resolves.toMatchObject({ opened: false });
    await expect(files.open('notes.txt', 'remote')).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(files.revealLink('notes.txt', 'remote')).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(actions.openPath).toHaveBeenCalledOnce();
    expect(actions.showItemInFolder).not.toHaveBeenCalled();
  });

  it('preserves traversal, null-byte, absolute-path, and escaping-symlink refusal', async () => {
    const root = await directory();
    const outside = await directory();
    await fs.writeFile(path.join(outside, 'secret.txt'), 'private');
    await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const files = await FilesystemService.forRoot(root);
    for (const reference of ['../secret.txt', './secret.txt', 'bad\0.txt', 'C:\\secret.txt', '//host/share/secret.txt', path.join(outside, 'secret.txt'), 'escape/secret.txt']) {
      await expect(files.read(reference)).rejects.toThrow();
    }
    await expect(files.confinePath('escape/missing.txt')).rejects.toThrow('outside the active project');
    expect((await files.list()).entries).toEqual([]);
  });

  it('keeps preview limits and missing/non-directory root errors', async () => {
    const root = await directory();
    const file = path.join(root, 'large.txt');
    await fs.writeFile(file, Buffer.alloc(MAX_FILE_PREVIEW_BYTES + 1, 65));
    const files = await FilesystemService.forRoot(root);
    await expect(files.read('large.txt')).resolves.toMatchObject({ state: 'large', size: MAX_FILE_PREVIEW_BYTES + 1 });
    await expect(new FilesystemService().list()).rejects.toMatchObject({ normalized: { code: 'RUNTIME_NOT_READY' } });
    await expect(FilesystemService.forRoot(file)).rejects.toThrow('directory');
    await expect(FilesystemService.forRoot(path.join(root, 'missing'))).rejects.toThrow();
    expect(rasterImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  });
});
