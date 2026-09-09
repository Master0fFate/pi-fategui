// @vitest-environment node
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentWorkspaceGitService } from './AgentWorkspaceGitService';

const run = promisify(execFile);
const temporary: string[] = [];
async function git(root: string, ...args: string[]): Promise<string> {
  return (await run('git', args, { cwd: root })).stdout.trim();
}
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-agent-workspace-'));
  temporary.push(directory);
  const root = path.join(directory, 'project');
  const managed = path.join(directory, 'managed');
  await fs.mkdir(root);
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.email', 'agent@example.test');
  await git(root, 'config', 'user.name', 'Agent Test');
  await git(root, 'config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(root, 'file.txt'), 'base\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'base');
  return { directory, root, managed, service: new AgentWorkspaceGitService(managed) };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })));
});

describe('AgentWorkspaceGitService', { timeout: 30_000 }, () => {
  it('keeps committed and uncommitted parent files untouched until explicit integration', async () => {
    const { root, service } = await fixture();
    await fs.writeFile(path.join(root, 'parent-only.txt'), 'local');
    const source = await service.create(root, 'agents/isolated');
    await expect(fs.stat(path.join(source.path, 'parent-only.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.writeFile(path.join(source.path, 'file.txt'), 'child\n');
    await expect(fs.readFile(path.join(root, 'file.txt'), 'utf8')).resolves.toBe('base\n');
    await service.checkpoint(source.path, 'child change');
    const dirty = await service.review(source.path, root, source.baseCommit);
    expect(dirty.targetDirty).toBe(true);
    await expect(service.integrate(source.path, root, dirty.sourceHead, dirty.targetHead, 'ff-only')).rejects.toThrow('clean');
    await fs.rm(path.join(root, 'parent-only.txt'));
    const review = await service.review(source.path, root, source.baseCommit);
    expect(review).toMatchObject({ dirty: false, targetDirty: false, targetBranch: 'main', commits: [expect.objectContaining({ subject: 'child change' })] });
    await service.integrate(source.path, root, review.sourceHead, review.targetHead, 'ff-only');
    await expect(fs.readFile(path.join(root, 'file.txt'), 'utf8')).resolves.toBe('child\n');
  });

  it('freezes base refs and rejects invalid refs or collisions without deleting the existing branch', async () => {
    const { root, service, managed } = await fixture();
    const base = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'branch', 'approved-base');
    const source = await service.create(root, 'agents/custom', 'approved-base');
    await git(root, 'commit', '--allow-empty', '-m', 'advance');
    await git(root, 'branch', '-f', 'approved-base', 'HEAD');
    expect((await service.status(source.path)).head).toBe(base);
    await expect(service.create(root, '--upload-pack=evil')).rejects.toThrow('invalid');
    await expect(service.create(root, 'agents/ref', '--upload-pack=evil')).rejects.toThrow('base ref');
    await expect(service.create(root, 'agents/custom')).rejects.toThrow();
    expect(await git(root, 'rev-parse', 'agents/custom')).toBe(base);
    expect(await fs.readdir(managed)).toHaveLength(1);
  });

  it('orders selected cherry-picks oldest first and excludes unselected changes', async () => {
    const { root, service } = await fixture();
    const source = await service.create(root, 'agents/selected');
    await fs.writeFile(path.join(source.path, 'one.txt'), 'one');
    const one = await service.checkpoint(source.path, 'first');
    await fs.writeFile(path.join(source.path, 'one.txt'), 'two');
    const two = await service.checkpoint(source.path, 'second');
    await fs.writeFile(path.join(source.path, 'skip.txt'), 'not selected');
    await service.checkpoint(source.path, 'third');
    await fs.writeFile(path.join(root, 'parent.txt'), 'parent');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'parent');
    const review = await service.review(source.path, root, source.baseCommit);
    expect(review.diff).not.toContain('-parent');
    await service.integrate(source.path, root, review.sourceHead, review.targetHead, 'cherry-pick', [two, one], source.baseCommit);
    await expect(fs.readFile(path.join(root, 'one.txt'), 'utf8')).resolves.toBe('two');
    await expect(fs.stat(path.join(root, 'skip.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(root, 'parent.txt'), 'utf8')).resolves.toBe('parent');
  });

  it('aborts the entire cherry-pick sequence when a later commit conflicts', async () => {
    const { root, service } = await fixture();
    const source = await service.create(root, 'agents/conflict');
    await fs.writeFile(path.join(source.path, 'first.txt'), 'first');
    const first = await service.checkpoint(source.path, 'first succeeds');
    await fs.writeFile(path.join(source.path, 'file.txt'), 'child\n');
    const second = await service.checkpoint(source.path, 'second conflicts');
    await fs.writeFile(path.join(root, 'file.txt'), 'parent\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'parent conflict');
    const review = await service.review(source.path, root, source.baseCommit);
    await expect(service.integrate(source.path, root, review.sourceHead, review.targetHead, 'cherry-pick', [first, second], source.baseCommit)).rejects.toThrow('sequence was aborted');
    await expect(service.status(root)).resolves.toMatchObject({ head: review.targetHead, dirty: false });
    await expect(fs.stat(path.join(root, 'first.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(root, 'file.txt'), 'utf8')).resolves.toBe('parent\n');
  });

  it('refuses stale heads, detached targets and pre-existing Git operations without changing files', async () => {
    const { root, service } = await fixture();
    const source = await service.create(root, 'agents/stale');
    const review = await service.review(source.path, root, source.baseCommit);
    await fs.writeFile(path.join(source.path, 'new.txt'), 'new');
    await service.checkpoint(source.path, 'new');
    await expect(service.integrate(source.path, root, review.sourceHead, review.targetHead, 'ff-only')).rejects.toThrow('changed since review');
    await git(root, 'checkout', '--detach');
    const current = await service.review(source.path, root, source.baseCommit);
    await expect(service.integrate(source.path, root, current.sourceHead, current.targetHead, 'ff-only')).rejects.toThrow('checked-out');
    await fs.mkdir(path.join(root, '.git', 'rebase-merge'));
    await expect(service.checkpoint(root, 'unsafe')).rejects.toThrow('existing Git operation');
  });

  it('validates registration, branch, base and common repository identity before accepting a workspace', async () => {
    const { root, service, directory } = await fixture();
    const source = await service.create(root, 'agents/identity');
    await expect(service.validate(source.path, root, source.branch, source.baseCommit, source.commonDirectory)).resolves.toBe(source.path);
    await expect(service.validate(source.path, root, 'wrong', source.baseCommit)).rejects.toThrow('registration or branch');
    await expect(service.validate(source.path, root, source.branch, source.baseCommit, directory)).rejects.toThrow('identity changed');
    const other = await fixture();
    await expect(service.validate(source.path, other.root, source.branch, source.baseCommit)).rejects.toThrow('different Git repositories');
    const alias = path.join(path.dirname(source.path), 'linked-worktree');
    await fs.symlink(source.path, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(service.validate(alias, root, source.branch, source.baseCommit)).rejects.toThrow('Linked');
  });

  it('retains dirty and ignored files and preserves the branch after explicit clean cleanup', async () => {
    const { root, service } = await fixture();
    const source = await service.create(root, 'agents/retained');
    await fs.writeFile(path.join(source.path, 'untracked.txt'), 'retain');
    const review = await service.review(source.path, root, source.baseCommit);
    expect(review).toMatchObject({ dirty: true, truncated: true });
    expect(review.diff).toContain('untracked.txt');
    await expect(service.cleanup(root, source.path)).rejects.toThrow('clean');
    await fs.rm(path.join(source.path, 'untracked.txt'));
    await fs.writeFile(path.join(source.path, '.gitignore'), '*.secret\n');
    await service.checkpoint(source.path, 'ignore local files');
    await fs.writeFile(path.join(source.path, 'local.secret'), 'retain');
    await expect(service.cleanup(root, source.path)).rejects.toThrow('ignored files');
    await fs.rm(path.join(source.path, 'local.secret'));
    await service.cleanup(root, source.path);
    expect(await git(root, 'rev-parse', 'agents/retained')).toMatch(/^[0-9a-f]+$/u);
    await expect(fs.stat(source.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never runs repository hooks, signing programs, filters or configured merge drivers', async () => {
    const { root, service, directory } = await fixture();
    await fs.writeFile(path.join(root, '.gitattributes'), '*.txt filter=evil merge=evil\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'attributes');
    const marker = path.join(directory, 'unsafe-ran');
    const script = path.join(directory, 'unsafe.sh');
    await fs.writeFile(script, `#!/bin/sh\nprintf hit > '${marker.replaceAll('\\', '/')}'\nexit 1\n`, { mode: 0o755 });
    await git(root, 'config', 'gpg.program', script);
    await git(root, 'config', 'commit.gpgSign', 'true');
    await expect(git(root, 'commit', '--allow-empty', '-m', 'signing probe')).rejects.toThrow();
    await expect(fs.readFile(marker, 'utf8')).resolves.toBe('hit');
    await fs.rm(marker);
    for (const hook of ['post-checkout', 'pre-commit', 'post-commit', 'post-merge']) await fs.copyFile(script, path.join(root, '.git', 'hooks', hook));
    const markerCommand = `printf hit > '${marker.replaceAll('\\', '/')}' && cat`;
    await git(root, 'config', 'filter.evil.clean', markerCommand);
    await git(root, 'config', 'filter.evil.smudge', markerCommand);
    await git(root, 'config', 'merge.evil.driver', markerCommand);
    const source = await service.create(root, 'agents/safe');
    await fs.writeFile(path.join(source.path, 'file.txt'), 'child\n');
    await service.checkpoint(source.path, 'safe checkpoint');
    const review = await service.review(source.path, root, source.baseCommit);
    await service.integrate(source.path, root, review.sourceHead, review.targetHead, 'cherry-pick', review.commits.map((commit) => commit.hash), source.baseCommit);
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('binds managed paths to immutable agent ownership and rolls back failed spawns without deleting unrelated refs', async () => {
    const { root, service } = await fixture();
    const source = await service.create(root, 'agents/owned', undefined, 'session/team/node');
    await expect(service.validate(source.path, root, source.branch, source.baseCommit, source.commonDirectory, 'different/team/node')).rejects.toThrow('different agent owner');
    await service.discardCreated(root, source, 'session/team/node');
    await expect(git(root, 'show-ref', '--verify', 'refs/heads/agents/owned')).rejects.toThrow();
    await expect(fs.stat(source.path)).rejects.toMatchObject({ code: 'ENOENT' });
    const changed = await service.create(root, 'agents/changed', undefined, 'session/team/changed');
    await fs.writeFile(path.join(changed.path, 'work.txt'), 'retain work');
    await expect(service.discardCreated(root, changed, 'session/team/changed')).rejects.toThrow('retained for review');
    await expect(fs.readFile(path.join(changed.path, 'work.txt'), 'utf8')).resolves.toBe('retain work');
  });

  it('marks oversized diffs incomplete rather than pretending they are empty', async () => {
    const { root, service } = await fixture();
    const source = await service.create(root, 'agents/large');
    await fs.writeFile(path.join(source.path, 'large.txt'), 'large line\n'.repeat(110_000));
    await service.checkpoint(source.path, 'large change');
    const review = await service.review(source.path, root, source.baseCommit);
    expect(review.truncated).toBe(true);
    expect(review.diff).toContain('exceeds the review limit');
  });
});
