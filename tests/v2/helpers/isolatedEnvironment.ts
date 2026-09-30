import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function privateTestRoot(): string {
  const root = process.env.FATE_V2_TEST_ROOT;
  if (!root || !path.isAbsolute(root)) throw new Error('Use the isolated v2 launcher');
  return root;
}

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function assertPrivatePath(candidate: string): Promise<void> {
  const root = await realpath(privateTestRoot());
  if (!isWithin(root, await realpath(candidate))) throw new Error('Fixture path escapes private test root');
}

export interface RepositorySnapshot { head: string; sentinel: string; status: string }
export interface GitFixture {
  root: string;
  a: string;
  b: string;
  sessions: { a: string; b: string };
  goals: { a: string; b: string };
  before: { a: RepositorySnapshot; b: RepositorySnapshot };
  writes: { repository: string; relative: string; content: string }[];
  snapshot(repository: string): Promise<RepositorySnapshot>;
  write(repository: string, relative: string, content: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createGitFixture(): Promise<GitFixture> {
  const root = await mkdtemp(path.join(privateTestRoot(), 'repositories-'));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  const snapshot = async (repository: string): Promise<RepositorySnapshot> => ({
    head: git(repository, 'rev-parse', 'HEAD'),
    sentinel: await readFile(path.join(repository, 'sentinel.txt'), 'utf8'),
    status: git(repository, 'status', '--porcelain'),
  });
  const cleanup = () => rm(root, { recursive: true, force: true, maxRetries: 3 });
  try {
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    for (const [directory, text] of [[a, 'repository A only\n'], [b, 'repository B only\n']] as const) {
      await mkdir(directory);
      git(directory, 'init', '--quiet');
      git(directory, 'config', '--local', 'user.name', 'V2 Fixture');
      git(directory, 'config', '--local', 'user.email', 'v2-fixture@example.invalid');
      git(directory, 'config', '--local', 'commit.gpgSign', 'false');
      git(directory, 'config', '--local', 'core.autocrlf', 'false');
      await writeFile(path.join(directory, 'sentinel.txt'), text);
      git(directory, 'add', 'sentinel.txt');
      git(directory, 'commit', '--quiet', '-m', 'private fixture');
    }
    const writes: GitFixture['writes'] = [];
    return {
      root, a, b, sessions: { a: 'fixture-session-a', b: 'fixture-session-b' },
      goals: { a: 'fixture-goal-a', b: 'fixture-goal-b' },
      before: { a: await snapshot(a), b: await snapshot(b) }, writes, snapshot, cleanup,
      async write(repository, relative, content) {
        if (repository !== a && repository !== b) throw new Error('Unknown fixture repository');
        const target = path.resolve(repository, relative);
        if (!isWithin(repository, target)) throw new Error('Fixture write escapes repository');
        // Existing parents only: never follow an outside symlink while creating directories.
        const parent = await realpath(path.dirname(target));
        if (!isWithin(await realpath(repository), parent)) throw new Error('Fixture write escapes repository');
        await assertPrivatePath(parent);
        try {
          if (!isWithin(await realpath(repository), await realpath(target))) throw new Error('Fixture write escapes repository');
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        await writeFile(target, content);
        writes.push({ repository, relative, content });
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function withGitFixture<T>(run: (fixture: GitFixture) => Promise<T>): Promise<T> {
  const fixture = await createGitFixture();
  try { return await run(fixture); } finally { await fixture.cleanup(); }
}
