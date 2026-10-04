import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OwnerLock, OwnershipConflict, canonicalFuturePath, findOwnerRecord, lockName } from '../../src/core/ownership/OwnerLock';
import { CheckoutOwnership } from '../../src/core/ownership/CheckoutOwnership';
import { AgentWorkspaceGitService } from '../../src/main/git/AgentWorkspaceGitService';
import { createFateCore } from '../../src/core/createFateCore';
import { FatePaths } from '../../src/core/FatePaths';
import { hostCheckoutLockRoot, hostCheckoutOwnership } from '../../src/core/ownership/CheckoutOwnership';
import { FakePiSdkAdapter } from './helpers/fakePi';
import { createDesktopFatePaths } from '../../src/core/FatePaths';
import { createServerProfile } from '../../src/core/storage/ServerProfile';
import { GitService } from '../../src/main/git/GitService';
import { FilesystemService } from '../../src/main/files/FilesystemService';

const children: ChildProcessWithoutNullStreams[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.stdin.end(); child.kill();
      await exited;
    }
  }));
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const temp = async () => { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-ownership-')); roots.push(root); return root; };

async function bundle(root: string): Promise<string> {
  const require = createRequire(import.meta.url);
  const esbuildPath = require.resolve('esbuild', { paths: [require.resolve('vite')] });
  const esbuild = require(esbuildPath) as { build(options: object): Promise<unknown> };
  const source = fileURLToPath(new URL('../../src/core/ownership/CheckoutOwnership.ts', import.meta.url));
  const ownerSource = fileURLToPath(new URL('../../src/core/ownership/OwnerLock.ts', import.meta.url));
  const gitSource = fileURLToPath(new URL('../../src/main/git/GitService.ts', import.meta.url));
  const filesSource = fileURLToPath(new URL('../../src/main/files/FilesystemService.ts', import.meta.url));
  await fs.symlink(path.join(process.cwd(), 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const entry = path.join(root, 'entry.ts');
  await fs.writeFile(entry, `export { CheckoutOwnership } from ${JSON.stringify(source)};\nexport { OwnerLock } from ${JSON.stringify(ownerSource)};\nexport { GitService } from ${JSON.stringify(gitSource)};\nexport { FilesystemService } from ${JSON.stringify(filesSource)};\n`);
  const output = path.join(root, 'ownership.mjs');
  await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: output, packages: 'external' });
  return output;
}

async function profileContender(module: string, paths: FatePaths, namespace: string, resource: string): Promise<number | null> {
  const script = `import { OwnerLock, CheckoutOwnership } from ${JSON.stringify(pathToFileURL(module).href)};
    const profile = await OwnerLock.acquire(process.argv[1], 'profile', process.argv[2]);
    try { const checkout = await new CheckoutOwnership(process.argv[3]).checkout(process.argv[4]); await checkout.release(); process.exitCode = 0; }
    catch (error) { process.exitCode = error?.message?.includes('already in use') ? 2 : 3; }
    finally { await profile.release(); }`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, paths.lockRoot, await canonicalFuturePath(path.dirname(paths.dataRoot)), namespace, resource], { stdio: 'pipe', env: { ...process.env, PI_OFFLINE: '1' } });
  children.push(child);
  return new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
}

async function contender(module: string, namespace: string, resource: string, kind: 'profile' | 'checkout'): Promise<number | null> {
  const script = `import { OwnerLock, CheckoutOwnership } from ${JSON.stringify(pathToFileURL(module).href)};
    try { const lock = process.argv[3] === 'checkout' ? await new CheckoutOwnership(process.argv[1]).checkout(process.argv[2]) : await OwnerLock.acquire(process.argv[1], 'profile', process.argv[2]); await lock.release(); process.exit(0); }
    catch (error) { process.exit(error?.message?.includes('already in use') ? 2 : 3); }`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, namespace, resource, kind], { stdio: 'pipe', env: { ...process.env, PI_OFFLINE: '1' } });
  children.push(child);
  return new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
}

async function owner(module: string, namespace: string, resource: string, kind: 'profile' | 'checkout' = 'profile'): Promise<ChildProcessWithoutNullStreams> {
  const code = `import { OwnerLock, CheckoutOwnership } from ${JSON.stringify(pathToFileURL(module).href)};
    const lock = process.argv[3] === 'checkout' ? await new CheckoutOwnership(process.argv[1]).checkout(process.argv[2]) : await OwnerLock.acquire(process.argv[1], 'profile', process.argv[2]);
    process.stdout.write('READY\\n');
    process.stdin.once('data', () => lock.release().then(() => process.exit(0), () => process.exit(3)));
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, namespace, resource, kind], { stdio: 'pipe', env: { ...process.env, PI_OFFLINE: '1' } });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    let output = '';
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.includes('READY')) resolve(); });
    child.once('exit', (status) => reject(new Error(`Child exited before ownership: ${status}; ${stderr.slice(0, 2000)}`)));
    child.once('error', reject);
  });
  return child;
}

describe('real Node process ownership', () => {
  it('locks the real legacy desktop open before the registry and shares a host namespace with custom server profiles', async () => {
    const root = await temp(); const module = await bundle(root);
    const repo = path.join(root, 'project'); await fs.mkdir(repo);
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-config') } });
    git(repo, 'init'); git(repo, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'initial');
    const desktop = createDesktopFatePaths({ home: root, dataRoot: path.join(root, 'desktop-data'), piAgentDir: path.join(root, 'desktop-pi') });
    const server = await createServerProfile({ home: root, profileId: 'first' });
    const customRoot = path.join(root, 'custom-profile'); await fs.mkdir(customRoot, { mode: 0o700 });
    const custom = await createServerProfile({ home: root, profileId: 'other', profileRoot: customRoot });
    expect(new Set([desktop.lockRoot, server.lockRoot, custom.lockRoot]).size).toBeGreaterThan(1);
    expect(hostCheckoutLockRoot()).not.toBe(path.join(path.dirname(path.dirname(custom.lockRoot)), 'fate-v2-checkouts'));
    const desktopAdapter = new FakePiSdkAdapter();
    const core = await createFateCore({ adapter: desktopAdapter, paths: desktop });
    try {
      // Same path as native desktop focus/open; no registry is present.
      await core.runtime.openProject({ path: repo, name: 'project', trusted: true });
      const namespace = hostCheckoutLockRoot();
      expect(await profileContender(module, server, namespace, repo)).toBe(2);
      const secondAdapter = new FakePiSdkAdapter();
      const second = await createFateCore({ adapter: secondAdapter, paths: custom, workspaceRegistration: { isRegistered: (candidate) => candidate === repo }, workspaceMembership: () => true });
      try { await expect(second.workspaces!.registerHostPath(repo)).rejects.toThrow(/already in use/u); }
      finally { await second.dispose(); await secondAdapter.dispose(); }
      await core.runtime.closeProjectPath(repo);
      expect(await contender(module, namespace, repo, 'checkout')).toBe(0);
    } finally { await core.dispose(); await desktopAdapter.dispose(); }
  }, 12_000);
  it('serializes desktop legacy worktree creation and rollback against Team Git mutation in another process/profile', async () => {
    const root = await temp(); const module = await bundle(root);
    const repo = path.join(root, 'repo'); await fs.mkdir(repo);
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-config') } });
    git(repo, 'init'); git(repo, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'initial');
    const a = path.join(root, 'team-parent'); git(repo, 'worktree', 'add', '-b', 'team-parent', a);
    const adapter = new FakePiSdkAdapter();
    const desktop = createDesktopFatePaths({ home: root, dataRoot: path.join(root, 'desktop-data'), piAgentDir: path.join(root, 'desktop-pi') });
    const core = await createFateCore({ adapter, paths: desktop });
    try {
      await core.runtime.openProject({ path: a, name: 'team-parent', trusted: true });
      const namespace = hostCheckoutLockRoot();
      const code = `import { CheckoutOwnership, OwnerLock, FilesystemService, GitService } from ${JSON.stringify(pathToFileURL(module).href)};
        const [repo, managed, hooks, namespace, profileLocks, profile] = process.argv.slice(1);
        const owner = await OwnerLock.acquire(profileLocks, 'profile', profile);
        const checkout = await new CheckoutOwnership(namespace).checkout(repo);
        try { const files = await FilesystemService.forRoot(repo); const git = new GitService(files, managed, hooks, new CheckoutOwnership(namespace));
          const tree = await git.createWorktree('legacy-child'); await git.discardCreatedWorktree(tree); process.stdout.write('DONE\\n');
        } finally { await checkout.release(); await owner.release(); }`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, repo, path.join(root, 'legacy-managed'), path.join(root, 'legacy-hooks'), namespace, path.join(root, 'child-profile-locks'), path.join(root, 'child-profile')], { stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-config'), PI_OFFLINE: '1' } });
      children.push(child);
      const childResult = new Promise<void>((resolve, reject) => { let stdout = ''; let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.once('exit', (code) => code === 0 && stdout.includes('DONE') ? resolve() : reject(new Error(`Desktop Git child exit ${code}: ${stderr.slice(0, 1500)}`)));
        child.once('error', reject);
      });
      const team = new AgentWorkspaceGitService(path.join(root, 'team-managed'), path.join(root, 'team-hooks'), hostCheckoutOwnership());
      const created = await team.create(a, 'team-child', undefined, 'team-owner');
      const owned = await hostCheckoutOwnership().checkout(created.path);
      await childResult;
      await team.cleanup(a, created.path);
      await owned.release();
      expect((git(repo, 'worktree', 'list', '--porcelain').toString().match(/worktree /gu) ?? []).length).toBe(2);
    } finally { await core.dispose(); await adapter.dispose(); }
  }, 20_000);

  it('retains profile and checkout after a provider refuses to stop; partial startup releases only a settled checkout', async () => {
    const root = await temp(); const module = await bundle(root);
    const repo = path.join(root, 'project'); await fs.mkdir(repo);
    execFileSync('git', ['init', '-q', repo], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-config') } });
    const paths = new FatePaths({ profileKind: 'server', profileId: 'test', dataRoot: path.join(root, 'profile', 'data'), piAgentDir: path.join(root, 'profile', 'pi'), sessionsRoot: path.join(root, 'profile', 'pi', 'sessions'), attachmentRoot: path.join(root, 'attachments'), lockRoot: path.join(root, 'locks') });
    const adapter = new FakePiSdkAdapter(); const registered = new Set([repo]);
    const core = await createFateCore({ paths, adapter, workspaceRegistration: { isRegistered: (candidate) => registered.has(candidate) }, workspaceMembership: () => true });
    const registry = core.workspaces!;
    const hostLocks = hostCheckoutLockRoot();
    try {
      const originalAcquire = core.runtime.acquireWorkspace.bind(core.runtime);
      const acquire = vi.spyOn(core.runtime, 'acquireWorkspace').mockRejectedValueOnce(new Error('before runtime creation'));
      await expect(registry.registerHostPath(repo)).rejects.toThrow('before runtime creation');
      expect(await contender(module, hostLocks, repo, 'checkout')).toBe(0);
      acquire.mockImplementation(async (candidate) => { const live = await originalAcquire(candidate); registered.delete(repo); return live; });
      await expect(registry.registerHostPath(repo)).rejects.toThrow('registration changed');
      expect(await contender(module, hostLocks, repo, 'checkout')).toBe(0);
      acquire.mockRestore(); registered.add(repo);
      const handle = await registry.registerHostPath(repo);
      const stop = vi.spyOn(handle.runtime, 'dispose').mockRejectedValue(new Error('provider refused to stop'));
      const failed = core.dispose();
      await expect(failed).rejects.toThrow(/shutdown was incomplete/u);
      expect(core.dispose()).toBe(failed);
      expect(await contender(module, paths.lockRoot, await canonicalFuturePath(path.dirname(paths.dataRoot)), 'profile')).toBe(2);
      expect(await contender(module, hostLocks, repo, 'checkout')).toBe(2);
      stop.mockRestore();
    } finally {
      vi.restoreAllMocks();
      // This is a synthetic provider: settle it before temp-root test cleanup.
      await core.runtime.dispose();
      expect(core.runtime.peekWorkspace(repo)).toBeNull();
      await adapter.dispose();
    }
  });
  it('contends for a profile before provider data exists; does not steal a slow owner or reused PID', async () => {
    const root = await temp();
    const module = await bundle(root);
    const namespace = path.join(root, 'private-locks');
    const profile = await canonicalFuturePath(path.join(root, 'profile', 'data'));
    const first = await owner(module, namespace, profile);
    await expect(fs.stat(path.join(root, 'profile', 'data'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await contender(module, namespace, profile, 'profile')).toBe(2);
    await expect(OwnerLock.acquire(namespace, 'profile', profile)).rejects.toBeInstanceOf(OwnershipConflict);
    await new Promise((resolve) => setTimeout(resolve, 90)); // A slow owner stays exclusive.
    await expect(OwnerLock.acquire(namespace, 'profile', profile)).rejects.toThrow(/operator recovery/u);
    first.stdin.write('done\n');
    await new Promise<void>((resolve) => first.once('exit', () => resolve()));
    const next = await OwnerLock.acquire(namespace, 'profile', profile);
    await fs.writeFile(next.recordPath, JSON.stringify({ ...next.record, pid: process.pid, startedAt: 1, startIdentity: 'old', token: 'not-the-owner' }));
    await expect(next.release()).rejects.toThrow(/token changed/u);
    await expect(OwnerLock.acquire(namespace, 'profile', profile)).rejects.toBeInstanceOf(OwnershipConflict);
  });

  it('contends for a canonical checkout across profiles; distinct worktrees share only short Git metadata lock', async () => {
    const root = await temp(); const module = await bundle(root);
    const namespace = path.join(root, 'host-locks'); const repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-config') } });
    git(repo, 'init'); git(repo, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'initial');
    const a = path.join(root, 'a'); const b = path.join(root, 'b');
    git(repo, 'worktree', 'add', '-b', 'child-a', a); git(repo, 'worktree', 'add', '-b', 'child-b', b);
    const first = await owner(module, namespace, repo, 'checkout');
    const second = await owner(module, namespace, a, 'checkout');
    expect(await contender(module, namespace, repo, 'checkout')).toBe(2);
    await expect(new CheckoutOwnership(namespace).checkout(repo)).rejects.toBeInstanceOf(OwnershipConflict);
    const ownership = new CheckoutOwnership(namespace);
    expect(await ownership.commonGitDirectory(repo)).toBe(await ownership.commonGitDirectory(a));
    const events: string[] = [];
    await Promise.all([ownership.mutation(a, async () => { events.push('a-start'); await new Promise((resolve) => setTimeout(resolve, 60)); events.push('a-end'); }), ownership.mutation(b, async () => { events.push('b-start'); events.push('b-end'); })]);
    expect(events.indexOf('a-end') < events.indexOf('b-start') || events.indexOf('b-end') < events.indexOf('a-start')).toBe(true);
    const third = await ownership.checkout(b);
    await ownership.mutation(a, async () => { git(a, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'child'); });
    const service = new AgentWorkspaceGitService(path.join(root, 'managed'), path.join(root, 'hooks'), ownership);
    const nested = await service.create(a, 'nested-child', undefined, 'test-owner');
    const nestedLock = await ownership.checkout(nested.path); // checkout after Git mutation settled
    git(nested.path, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'nested');
    const review = await service.review(nested.path, a, nested.baseCommit);
    expect(await service.integrate(nested.path, a, review.sourceHead, review.targetHead, 'ff-only')).toBe(review.sourceHead);
    await service.cleanup(a, nested.path);
    await nestedLock.release();
    await third.release();
    const stopped = [first, second].map((child) => new Promise<void>((resolve) => child.once('exit', () => resolve())));
    first.stdin.write('release\n'); second.stdin.write('release\n');
    await Promise.all(stopped);
  }, 15_000);
});

describe('recovery after the owner process stopped', () => {
  /** A real owner in another process that is then killed, so it cannot release its lock. */
  async function stoppedOwner(): Promise<{ module: string; namespace: string; profile: string; lockPath: string; recordFile: string; content: string }> {
    const root = await temp();
    const module = await bundle(root);
    const namespace = path.join(root, 'private-locks');
    const profile = await canonicalFuturePath(path.join(root, 'profile', 'data'));
    const crashed = await owner(module, namespace, profile);
    const lockPath = path.join(namespace, `profile-${lockName(path.normalize(profile))}.lock`);
    const recordFile = (await findOwnerRecord(lockPath))!;
    const content = await fs.readFile(recordFile, 'utf8');
    const record = JSON.parse(content) as { token: string };
    expect(record).toMatchObject({ pid: crashed.pid, host: os.hostname(), platform: process.platform });
    // The name of the record is the token of its owner.
    expect(path.basename(recordFile)).toBe(`owner-${record.token}.json`);
    // A running owner is never taken, whatever its record says.
    await expect(OwnerLock.acquire(namespace, 'profile', profile)).rejects.toBeInstanceOf(OwnershipConflict);
    const exited = new Promise<void>((resolve) => crashed.once('exit', () => resolve()));
    crashed.kill('SIGKILL');
    await exited;
    expect(await fs.readdir(lockPath)).toEqual([path.basename(recordFile)]);
    return { module, namespace, profile, lockPath, recordFile, content };
  }

  it('takes the lock of an owner that was killed and leaves no remains', async () => {
    const stopped = await stoppedOwner();
    const next = await OwnerLock.acquire(stopped.namespace, 'profile', stopped.profile);
    expect(next.record.pid).toBe(process.pid);
    expect(next.recordPath).not.toBe(stopped.recordFile);
    expect(await fs.readdir(stopped.namespace)).toEqual([path.basename(stopped.lockPath)]);
    expect(await fs.readdir(stopped.lockPath)).toEqual([path.basename(next.recordPath)]);
    await next.release();
    expect(await fs.readdir(stopped.namespace)).toEqual([]);
  });

  it('lets exactly one of several simultaneous starts take the lock of a stopped owner', async () => {
    const stopped = await stoppedOwner();
    // Each contender is a separate process that takes the lock and keeps it.
    const starts = await Promise.allSettled(Array.from({ length: 6 }, () => owner(stopped.module, stopped.namespace, stopped.profile)));
    const winners = starts.filter((start) => start.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    const winner = (winners[0] as PromiseFulfilledResult<ChildProcessWithoutNullStreams>).value;
    const records = await fs.readdir(stopped.lockPath);
    expect(records).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(path.join(stopped.lockPath, records[0]!), 'utf8'))).toMatchObject({ pid: winner.pid });
    await expect(OwnerLock.acquire(stopped.namespace, 'profile', stopped.profile)).rejects.toBeInstanceOf(OwnershipConflict);
  });

  it('keeps every stopped owner lock that it cannot prove safe to take', async () => {
    const stopped = await stoppedOwner();
    const record = JSON.parse(stopped.content) as Record<string, unknown>;
    const { recordFile, lockPath } = stopped;
    const write = (value: unknown): Promise<void> => fs.writeFile(recordFile, typeof value === 'string' ? value : JSON.stringify(value));
    const original = (): Promise<void> => write(stopped.content);
    const moved = (name: string): [() => Promise<void>, () => Promise<void>] => [
      () => fs.rename(recordFile, path.join(lockPath, name)), () => fs.rename(path.join(lockPath, name), recordFile)];
    const variants: Array<[string, () => Promise<void>, () => Promise<void>]> = [
      ['another host', () => write({ ...record, host: `${String(record.host)}-other` }), original],
      ['another platform', () => write({ ...record, platform: 'another-system' }), original],
      ['a record without a platform', () => write({ ...record, platform: undefined }), original],
      ['a PID that is not a process number', () => write({ ...record, pid: 0 }), original],
      ['a negative PID', () => write({ ...record, pid: -1 }), original],
      ['a token that is not the one in the record name', () => write({ ...record, token: '11111111-2222-4333-8444-555555555555' }), original],
      ['a malformed record', () => write('{'), original],
      ['an oversized record', () => write({ ...record, padding: 'x'.repeat(5000) }), original],
      ['a record under a fixed name', ...moved('owner.json')],
      ['a record under the name of another token', ...moved('owner-11111111-2222-4333-8444-555555555555.json')],
      ['an operator review marker', () => fs.writeFile(path.join(lockPath, 'review-required.json'), '{}'), () => fs.unlink(path.join(lockPath, 'review-required.json'))],
      ['an unknown entry', () => fs.writeFile(path.join(lockPath, 'note.txt'), 'x'), () => fs.unlink(path.join(lockPath, 'note.txt'))],
      ['no record', () => fs.unlink(recordFile), original],
      ['the claim of a recovery that did not finish', () => fs.link(recordFile, path.join(lockPath, `recovering-${String(record.token)}`)),
        () => fs.unlink(path.join(lockPath, `recovering-${String(record.token)}`))],
    ];
    if (process.platform === 'linux') {
      const linux = record.linux as Record<string, string>;
      variants.push(['another PID namespace', () => write({ ...record, linux: { ...linux, pidNamespace: 'pid:[1]' } }), original]);
      // A different boot identity is a restart only when the machine is provably the same.
      variants.push(['another machine with the same name', () => write({ ...record, linux: { ...linux, machineId: 'another-machine', bootId: 'another-boot' } }), original]);
      variants.push(['another boot without a machine identity', () => write({ ...record, linux: { ...linux, machineId: '', bootId: 'another-boot' } }), original]);
      variants.push(['a record without the Linux identity', () => write({ ...record, linux: undefined }), original]);
    } else {
      // Without a kernel start time a live PID is always the owner, this process included.
      variants.push(['this process as the owner', () => write({ ...record, pid: process.pid }), original]);
    }
    for (const [label, change, restore] of variants) {
      await change();
      await expect(OwnerLock.acquire(stopped.namespace, 'profile', stopped.profile), label).rejects.toBeInstanceOf(OwnershipConflict);
      expect(await fs.readdir(stopped.namespace), label).toEqual([path.basename(lockPath)]);
      await restore();
    }
    // The untouched record of the stopped owner is still recoverable afterwards.
    const next = await OwnerLock.acquire(stopped.namespace, 'profile', stopped.profile);
    await next.release();
  });

  it('keeps a lock that its owner marked for operator review, also from that owner', async () => {
    const root = await temp();
    const namespace = path.join(root, 'private-locks');
    const profile = await canonicalFuturePath(path.join(root, 'profile', 'data'));
    const lock = await OwnerLock.acquire(namespace, 'profile', profile);
    const expected = [path.basename(lock.recordPath), 'review-required.json'];
    await lock.requireOperatorReview();
    expect((await fs.readdir(lock.lockPath)).sort()).toEqual(expected);
    await expect(lock.release()).rejects.toThrow(/retained for operator review/u);
    expect((await fs.readdir(lock.lockPath)).sort()).toEqual(expected);
  });

  it.runIf(process.platform === 'linux')('tells a reused PID from the owner by the kernel start time', async () => {
    const root = await temp();
    const module = await bundle(root);
    const namespace = path.join(root, 'private-locks');
    const profile = await canonicalFuturePath(path.join(root, 'profile', 'data'));
    const running = await owner(module, namespace, profile);
    const recordFile = (await findOwnerRecord(path.join(namespace, `profile-${lockName(path.normalize(profile))}.lock`)))!;
    const record = JSON.parse(await fs.readFile(recordFile, 'utf8')) as { linux: Record<string, string> };
    // The PID is alive, but the record belongs to an earlier process that had the same PID.
    await fs.writeFile(recordFile, JSON.stringify({ ...record, linux: { ...record.linux, startTicks: '1' } }));
    const next = await OwnerLock.acquire(namespace, 'profile', profile);
    expect(running.exitCode).toBeNull();
    await next.release();
  });
});
