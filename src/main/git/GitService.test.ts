// @vitest-environment node
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { FilesystemService } from '../files/FilesystemService';
import { GitService, parseNumstat, parsePorcelainStatus } from './GitService';

const run = promisify(execFile);
const temporary: string[] = [];

async function repository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-desktop-git-'));
  temporary.push(root);
  await run('git', ['init'], { cwd: root });
  await run('git', ['config', 'user.email', 'pi-desktop@example.test'], { cwd: root });
  await run('git', ['config', 'user.name', 'Pi Desktop Test'], { cwd: root });
  return root;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('GitService', () => {
  it('parses NUL-delimited Unicode, spaced, and renamed paths without shell tokenization', () => {
    const status = parsePorcelainStatus('## main...origin/main [ahead 2, behind 1]\0 M hello world ü.txt\0R  新 name.ts\0旧 name.ts\0');
    expect(status).toMatchObject({ branch: 'main', ahead: 2, behind: 1 });
    expect(status.changes).toEqual([
      { path: 'hello world ü.txt', indexStatus: ' ', workTreeStatus: 'M' },
      { path: '新 name.ts', oldPath: '旧 name.ts', indexStatus: 'R', workTreeStatus: ' ' },
    ]);
    expect(parseNumstat('3\t2\thello world ü.txt\0-\t-\timage file.png\0').get('image file.png')).toEqual({ additions: null, deletions: null, binary: true });
  });

  it('returns changed-file counts and bounded previews for Unicode and spaced paths', async () => {
    const root = await repository();
    const tracked = 'hello world ü.ts';
    await fs.writeFile(path.join(root, tracked), 'const value = 1;\n');
    await run('git', ['add', '--', tracked], { cwd: root });
    await run('git', ['commit', '-m', 'initial'], { cwd: root });
    await fs.writeFile(path.join(root, tracked), 'const value = 2;\nconst 世界 = true;\n');
    await fs.writeFile(path.join(root, '新 file.ts'), 'export {};\n');

    const files = new FilesystemService();
    await files.setRoot(root);
    const git = new GitService(files);
    const status = await git.status();
    expect(status.repository).toBe(true);
    expect(status.changes.map((change) => change.path)).toEqual(expect.arrayContaining([tracked, '新 file.ts']));
    expect(status.changes.find((change) => change.path === tracked)).toMatchObject({ additions: 2, deletions: 1 });
    expect(status.changes.find((change) => change.path === '新 file.ts')).toMatchObject({ additions: 1, deletions: 0 });
    expect(status.additions).toBe(3);
    expect(status.deletions).toBe(1);

    const diff = await git.diff(tracked);
    expect(diff).toMatchObject({ state: 'text', language: 'typescript', original: 'const value = 1;\n', modified: 'const value = 2;\nconst 世界 = true;\n' });
    await expect(git.diff('../outside')).rejects.toThrow('outside the active project');
  });
});
