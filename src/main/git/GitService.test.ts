// @vitest-environment node
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilesystemService } from '../files/FilesystemService';
import { GitService, githubRepositoryUrl, parseCredentialConfig, parseGitDecorations, parseGitHistory, parseGitWorktrees, parseNumstat, parsePorcelainStatus } from './GitService';

const run = promisify(execFile);
const temporary: string[] = [];
const servers: Server[] = [];

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(', ') : value ?? '';
}

async function smartHttpServer(repositoriesRoot: string): Promise<number> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      const child = spawn('git', ['http-backend'], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: repositoriesRoot,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: requestUrl.pathname,
          QUERY_STRING: requestUrl.search.slice(1),
          REQUEST_METHOD: request.method ?? 'GET',
          CONTENT_TYPE: headerValue(request.headers['content-type']),
          CONTENT_LENGTH: headerValue(request.headers['content-length']) || String(chunks.reduce((total, chunk) => total + chunk.length, 0)),
          HTTP_GIT_PROTOCOL: headerValue(request.headers['git-protocol']),
          REMOTE_ADDR: '127.0.0.1',
        },
        stdio: 'pipe',
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', (error) => {
        response.statusCode = 500;
        response.end(error.message);
      });
      child.once('exit', (code) => {
        if (response.writableEnded) return;
        if (code !== 0) {
          response.statusCode = 500;
          response.end(Buffer.concat(stderr));
          return;
        }
        const output = Buffer.concat(stdout);
        const separator = output.indexOf('\r\n\r\n');
        if (separator < 0) {
          response.statusCode = 500;
          response.end('Malformed git http-backend response.');
          return;
        }
        for (const header of output.subarray(0, separator).toString('utf8').split('\r\n')) {
          const colon = header.indexOf(':');
          if (colon < 1) continue;
          const name = header.slice(0, colon);
          const value = header.slice(colon + 1).trim();
          if (name.toLowerCase() === 'status') response.statusCode = Number.parseInt(value, 10);
          else response.setHeader(name, value);
        }
        response.end(output.subarray(separator + 4));
      });
      child.stdin.end(Buffer.concat(chunks));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start the loopback smart-HTTP server.');
  return address.port;
}

async function repository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-desktop-git-'));
  temporary.push(root);
  await run('git', ['init'], { cwd: root });
  await run('git', ['config', 'user.email', 'pi-desktop@example.test'], { cwd: root });
  await run('git', ['config', 'user.name', 'Pi Desktop Test'], { cwd: root });
  return root;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
  await Promise.all(temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
}, 60_000);

// These integration tests launch real Git processes. Loaded cross-platform CI
// runners can take more than Vitest's 5-second unit-test default to spawn them.
describe('GitService', { timeout: 30_000 }, () => {
  it('parses NUL-delimited Unicode, spaced, and renamed paths without shell tokenization', () => {
    const status = parsePorcelainStatus('## main...origin/main [ahead 2, behind 1]\0 M hello world ü.txt\0R  新 name.ts\0旧 name.ts\0');
    expect(status).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 });
    expect(status.changes).toEqual([
      { path: 'hello world ü.txt', indexStatus: ' ', workTreeStatus: 'M' },
      { path: '新 name.ts', oldPath: '旧 name.ts', indexStatus: 'R', workTreeStatus: ' ' },
    ]);
    expect(parseNumstat('3\t2\thello world ü.txt\0-\t-\timage file.png\0').get('image file.png')).toEqual({ additions: null, deletions: null, binary: true });
  });

  it('parses bounded history, decorations, worktrees, and GitHub remote forms', () => {
    const hash = 'a'.repeat(40);
    const parent = 'b'.repeat(40);
    const history = parseGitHistory([hash, parent, 'Ada', 'ada@example.test', '2026-07-23T06:02:08+02:00', 'Ship graph', 'HEAD -> refs/heads/main, refs/remotes/origin/main', ''].join('\0'));
    expect(history.commits[0]).toMatchObject({ hash, parents: [parent], authorName: 'Ada', subject: 'Ship graph' });
    expect(history.commits[0]?.refs).toEqual([
      { name: 'main', kind: 'head' },
      { name: 'origin/main', kind: 'remote' },
    ]);
    expect(parseGitDecorations('tag: refs/tags/v1, refs/heads/release')).toEqual([
      { name: 'v1', kind: 'tag' },
      { name: 'release', kind: 'local' },
    ]);
    expect(parseGitWorktrees(`worktree C:/repo\0HEAD ${hash}\0branch refs/heads/main\0\0worktree C:/repo-two\0HEAD ${parent}\0detached\0\0`, 'C:/repo')).toEqual([
      { path: path.normalize('C:/repo'), branch: 'main', head: hash, detached: false, bare: false, current: true },
      { path: path.normalize('C:/repo-two'), branch: null, head: parent, detached: true, bare: false, current: false },
    ]);
    expect(githubRepositoryUrl('git@github.com:owner/repo.git')).toBe('https://github.com/owner/repo');
    expect(githubRepositoryUrl('https://gitlab.com/owner/repo.git')).toBeNull();
  });

  it('replays trusted generic and URL-specific credential configuration', () => {
    const config = [
      'credential.helper\nmanager',
      'credential.https://github.com.helper\n',
      "credential.https://github.com.helper\n!'C:\\Program Files\\GitHub CLI\\gh.exe' auth git-credential",
      'credential.https://dev.azure.com.usehttppath\ntrue',
      'credential.password\nsecret',
      'core.askpass\nuntrusted',
      '',
    ].join('\0');
    expect(parseCredentialConfig(config)).toEqual([
      '-c', 'credential.helper=manager',
      '-c', 'credential.https://github.com.helper=',
      '-c', "credential.https://github.com.helper=!'C:\\Program Files\\GitHub CLI\\gh.exe' auth git-credential",
      '-c', 'credential.https://dev.azure.com.usehttppath=true',
    ]);
  });

  it('rejects a repository subdirectory before Git can treat it as the work tree', async () => {
    const root = await repository();
    const nested = path.join(root, 'nested');
    await fs.mkdir(nested);
    await fs.writeFile(path.join(root, 'tracked.txt'), 'repository root\n');
    await fs.writeFile(path.join(nested, 'nested.txt'), 'nested project\n');
    await run('git', ['add', '.'], { cwd: root });
    await run('git', ['commit', '-m', 'initial'], { cwd: root });

    const files = new FilesystemService();
    await files.setRoot(nested);
    const error = await new GitService(files).status().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Open the repository root instead:');
    expect((error as Error).message).toContain(await fs.realpath(root));
    await expect(run('git', ['status', '--porcelain'], { cwd: root })).resolves.toMatchObject({ stdout: '' });
  });

  it('accepts Git boolean aliases for inherited line-ending configuration', async () => {
    const root = await repository();
    await run('git', ['config', 'core.autocrlf', 'yes'], { cwd: root });
    const files = new FilesystemService();
    await files.setRoot(root);
    await expect(new GitService(files).status()).resolves.toMatchObject({ repository: true });
  });

  it('disables repository-configured fsmonitor programs during automatic inspection', async () => {
    const root = await repository();
    const marker = path.join(root, 'fsmonitor-ran');
    const hook = path.join(root, 'fsmonitor-hook');
    await fs.writeFile(hook, '#!/bin/sh\nprintf hit > fsmonitor-ran\nprintf "\\n"\n');
    await fs.chmod(hook, 0o755);
    await run('git', ['config', 'core.fsmonitor', './fsmonitor-hook'], { cwd: root });

    // Prove the repository configuration is executable under an ordinary Git call.
    await run('git', ['status', '--porcelain'], { cwd: root }).catch(() => undefined);
    expect(await fs.readFile(marker, 'utf8')).toBe('hit');
    await fs.rm(marker);

    const filterMarker = path.join(root, 'filter-ran');
    const filteredPath = 'tracked # file.txt';
    await fs.writeFile(path.join(root, '.gitattributes'), `"${filteredPath}" benign="x filter=evil tail="\n`);
    await fs.writeFile(path.join(root, filteredPath), 'before\n');
    await run('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: root });
    await run('git', ['config', '--worktree', 'filter.evil.clean', 'printf hit > filter-ran && cat'], { cwd: root });
    await run('git', ['add', '.gitattributes', filteredPath], { cwd: root });
    await run('git', ['commit', '-m', 'filters'], { cwd: root });
    await fs.rm(filterMarker, { force: true });
    await fs.writeFile(path.join(root, filteredPath), 'after changed and deliberately longer\n');
    await run('git', ['add', '--renormalize', filteredPath], { cwd: root });
    expect(await fs.readFile(filterMarker, 'utf8')).toBe('hit');
    await run('git', ['reset', 'HEAD', '--', filteredPath], { cwd: root });
    await fs.rm(filterMarker);
    await fs.rm(marker, { force: true });
    // The index still carries filter=evil after the worktree attributes file is
    // removed. Automatic inspection must sanitize that indexed driver too.
    await fs.rm(path.join(root, '.gitattributes'));
    const files = new FilesystemService();
    await files.setRoot(root);
    await new GitService(files).status();
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(filterMarker)).rejects.toMatchObject({ code: 'ENOENT' });

    const outsideWorktree = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-desktop-git-worktree-'));
    temporary.push(outsideWorktree);
    await run('git', ['config', 'core.worktree', outsideWorktree], { cwd: root });
    await expect(new GitService(files).status()).rejects.toThrow('Open the repository root instead:');
  }, 20_000);

  it('does not enter dirty submodules during automatic status inspection', async () => {
    const root = await repository();
    const source = await repository();
    await fs.writeFile(path.join(source, 'tracked.txt'), 'before\n');
    await run('git', ['add', 'tracked.txt'], { cwd: source });
    await run('git', ['commit', '-m', 'submodule source'], { cwd: source });
    await run('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--', source, 'module'], { cwd: root });
    await run('git', ['commit', '-m', 'add submodule'], { cwd: root });

    const moduleRoot = path.join(root, 'module');
    const marker = path.join(moduleRoot, 'submodule-filter-ran');
    const infoAttributesRaw = String((await run('git', ['rev-parse', '--git-path', 'info/attributes'], { cwd: moduleRoot })).stdout).trim();
    const infoAttributes = path.isAbsolute(infoAttributesRaw) ? infoAttributesRaw : path.join(moduleRoot, infoAttributesRaw);
    await fs.mkdir(path.dirname(infoAttributes), { recursive: true });
    await fs.writeFile(infoAttributes, '*.txt filter=evil\n');
    await run('git', ['config', 'filter.evil.clean', 'printf hit > submodule-filter-ran && cat'], { cwd: moduleRoot });
    await fs.writeFile(path.join(moduleRoot, 'tracked.txt'), 'dirty and longer\n');

    const files = new FilesystemService();
    await files.setRoot(root);
    await new GitService(files).status();
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns bounded raster previews for changed images', async () => {
    const root = await repository();
    const original = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from([0, 0, 0, 1]), Buffer.from('original')]);
    const modified = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from([0, 0, 0, 1]), Buffer.from('modified')]);
    await fs.writeFile(path.join(root, 'icon.png'), original);
    await run('git', ['add', '--', 'icon.png'], { cwd: root });
    await run('git', ['commit', '-m', 'image'], { cwd: root });
    await fs.writeFile(path.join(root, 'icon.png'), modified);
    await fs.writeFile(path.join(root, 'new-icon.png'), modified);

    const files = new FilesystemService();
    await files.setRoot(root);
    const git = new GitService(files);
    const status = await git.status();
    expect(status.changes.find((change) => change.path === 'icon.png')).toMatchObject({ binary: true, additions: null, deletions: null });
    expect(status.changes.find((change) => change.path === 'new-icon.png')).toMatchObject({ binary: true, additions: null, deletions: null });
    expect(await git.diff('icon.png')).toMatchObject({
      state: 'image',
      mimeType: 'image/png',
      imageData: modified.toString('base64'),
    });
  });

  it('returns bounded worktrees, history, lazy commit details, and a combined working diff', async () => {
    const root = await repository();
    const tracked = 'src file.ts';
    await fs.writeFile(path.join(root, tracked), 'const value = 1;\n');
    await run('git', ['add', '--', tracked], { cwd: root });
    await run('git', ['commit', '-m', 'initial commit'], { cwd: root });
    await run('git', ['remote', 'add', 'origin', 'git@github.com:owner/repo.git'], { cwd: root });
    const secondWorktree = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-desktop-worktree-'));
    temporary.push(secondWorktree);
    await fs.rm(secondWorktree, { recursive: true, force: true });
    await run('git', ['worktree', 'add', '-b', 'second', secondWorktree], { cwd: root });
    await fs.writeFile(path.join(root, tracked), 'const value = 2;\n');
    await fs.writeFile(path.join(root, 'new file.ts'), 'export const added = true;\n');

    const files = new FilesystemService();
    await files.setRoot(root);
    const managedWorktrees = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-ui-managed-worktrees-'));
    temporary.push(managedWorktrees);
    const git = new GitService(files, managedWorktrees);
    await expect(git.status()).resolves.toMatchObject({ pushTarget: expect.stringMatching(/^origin\//u) });
    const repositoryKey = `${path.basename(root)}-${createHash('sha256').update(await fs.realpath(root)).digest('hex').slice(0, 10)}`;
    const staleDestination = path.join(managedWorktrees, repositoryKey, 'fate-repair-push-and-pull-workflow');
    await fs.mkdir(staleDestination, { recursive: true });
    await fs.writeFile(path.join(staleDestination, 'keep.txt'), 'keep');
    const isolated = await git.createWorktree('Repair push and pull workflow');
    expect(isolated).toMatchObject({ branch: 'fate/repair-push-and-pull-workflow', detached: false, current: false });
    expect(isolated.path.startsWith(await fs.realpath(managedWorktrees))).toBe(true);
    expect(isolated.path).not.toBe(await fs.realpath(staleDestination));
    await expect(fs.readFile(path.join(staleDestination, 'keep.txt'), 'utf8')).resolves.toBe('keep');
    const worktrees = await git.worktrees();
    expect(worktrees).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: await fs.realpath(root), branch: expect.any(String), current: true }),
      expect.objectContaining({ path: await fs.realpath(secondWorktree), branch: 'second', current: false }),
      expect.objectContaining({ path: isolated.path, branch: 'fate/repair-push-and-pull-workflow', current: false }),
    ]));
    await expect(git.resolveWorktree(secondWorktree)).resolves.toBe(await fs.realpath(secondWorktree));
    await expect(git.resolveWorktree(path.dirname(root))).rejects.toThrow('registered worktree');

    const history = await git.history();
    expect(history.head).toBe(history.commits[0]?.hash);
    expect(history.commits[0]).toMatchObject({ subject: 'initial commit', authorName: 'Pi Desktop Test' });
    const details = await git.commitDetails(history.head!);
    expect(details).toMatchObject({ filesChanged: 1, additions: 1, deletions: 0, githubUrl: `https://github.com/owner/repo/commit/${history.head}` });
    expect(details.files[0]).toMatchObject({ path: tracked, status: 'A' });

    const combined = await git.combinedDiff();
    expect(combined.patch).toContain(`diff --git a/${tracked} b/${tracked}`);
    expect(combined.patch).toContain('diff --git a/new file.ts b/new file.ts');
    expect(combined.patch).toContain('+export const added = true;');
  });

  it('suppresses checkout hooks, filters, and unsafe protocols for managed worktrees', async () => {
    const root = await repository();
    await fs.writeFile(path.join(root, '.gitattributes'), '*.txt filter=evil\n');
    await fs.writeFile(path.join(root, 'tracked.txt'), 'value\n');
    await run('git', ['add', '.gitattributes', 'tracked.txt'], { cwd: root });
    await run('git', ['commit', '-m', 'initial'], { cwd: root });
    await run('git', ['config', 'filter.evil.smudge', 'printf hit > filter-ran && cat'], { cwd: root });
    await run('git', ['config', 'filter.evil.required', 'true'], { cwd: root });
    await run('git', ['config', 'protocol.file.allow', 'always'], { cwd: root });
    const hook = path.join(root, '.git', 'hooks', 'post-checkout');
    await fs.writeFile(hook, '#!/bin/sh\nprintf hit > post-checkout-ran\n');
    await fs.chmod(hook, 0o755);

    const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-ui-managed-worktrees-'));
    temporary.push(managedRoot);
    const files = new FilesystemService();
    await files.setRoot(root);
    const isolated = await new GitService(files, managedRoot).createWorktree('safe checkout');
    const checkedOut = await fs.readFile(path.join(isolated.path, 'tracked.txt'), 'utf8');
    expect(checkedOut.replace(/\r\n/gu, '\n')).toBe('value\n');
    await expect(fs.stat(path.join(isolated.path, 'filter-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(isolated.path, 'post-checkout-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('confines worktrees when the old predictable repository location is a symlink', async () => {
    const root = await repository();
    await fs.writeFile(path.join(root, 'tracked.txt'), 'value\n');
    await run('git', ['add', 'tracked.txt'], { cwd: root });
    await run('git', ['commit', '-m', 'initial'], { cwd: root });
    const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-ui-managed-worktrees-'));
    temporary.push(managedRoot);
    const externalTarget = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-ui-external-worktrees-'));
    temporary.push(externalTarget);
    const repositoryKey = `${path.basename(root)}-${createHash('sha256').update(await fs.realpath(root)).digest('hex').slice(0, 10)}`;
    const predictableLocation = path.join(managedRoot, repositoryKey);
    await fs.symlink(externalTarget, predictableLocation, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.writeFile(path.join(externalTarget, 'keep.txt'), 'untouched');

    const files = new FilesystemService();
    await files.setRoot(root);
    const isolated = await new GitService(files, managedRoot).createWorktree('symlink confinement');
    const canonicalManagedRoot = await fs.realpath(managedRoot);
    const relative = path.relative(canonicalManagedRoot, isolated.path);
    expect(relative).not.toBe('');
    expect(relative).not.toContain(path.sep);
    expect(await fs.realpath(isolated.path)).toBe(isolated.path);
    await expect(fs.readFile(path.join(externalTarget, 'keep.txt'), 'utf8')).resolves.toBe('untouched');
    expect((await fs.lstat(predictableLocation)).isSymbolicLink()).toBe(true);
  });

  it('aggregates primary and owned rollback failures during worktree creation', async () => {
    const root = await repository();
    await fs.writeFile(path.join(root, 'tracked.txt'), 'value\n');
    await run('git', ['add', 'tracked.txt'], { cwd: root });
    await run('git', ['commit', '-m', 'initial'], { cwd: root });
    const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-ui-managed-worktrees-'));
    temporary.push(managedRoot);
    const canonicalManagedRoot = await fs.realpath(managedRoot);
    const files = new FilesystemService();
    await files.setRoot(root);
    const realpath = vi.spyOn(fs, 'realpath')
      .mockResolvedValueOnce(canonicalManagedRoot)
      .mockImplementationOnce(async (candidate) => {
        await fs.writeFile(path.join(String(candidate), 'block'), 'occupied');
        return String(candidate);
      });
    const remove = vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('simulated cleanup failure'));
    const git = new GitService(files, managedRoot);

    const failure = await git.createWorktree('aggregate rollback').catch((error: unknown) => error);
    realpath.mockRestore();
    remove.mockRestore();
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    await expect(run('git', ['show-ref', '--verify', 'refs/heads/fate/aggregate-rollback'], { cwd: root })).rejects.toThrow();
  });

  it('does not swallow managed worktree branch deletion failures', async () => {
    const root = await repository();
    await fs.writeFile(path.join(root, 'tracked.txt'), 'value\n');
    await run('git', ['add', 'tracked.txt'], { cwd: root });
    await run('git', ['commit', '-m', 'initial'], { cwd: root });
    const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-ui-managed-worktrees-'));
    temporary.push(managedRoot);
    const files = new FilesystemService();
    await files.setRoot(root);
    const git = new GitService(files, managedRoot);
    const isolated = await git.createWorktree('delete failure');

    await expect(git.discardCreatedWorktree({ ...isolated, branch: 'invalid..branch' })).rejects.toThrow();
    await expect(run('git', ['show-ref', '--verify', `refs/heads/${isolated.branch}`], { cwd: root })).resolves.toBeDefined();
  });

  it('rejects branch sync with actionable detached, missing-remote, and missing-upstream errors', async () => {
    const root = await repository();
    await fs.writeFile(path.join(root, 'tracked.txt'), 'value\n');
    await run('git', ['add', 'tracked.txt'], { cwd: root });
    await run('git', ['commit', '-m', 'initial'], { cwd: root });
    const files = new FilesystemService();
    await files.setRoot(root);
    const git = new GitService(files);

    await expect(git.runOperation('push')).rejects.toThrow('no Git remote is configured');
    await run('git', ['remote', 'add', 'origin', root], { cwd: root });
    await expect(git.runOperation('pull')).rejects.toThrow('no upstream configured');
    await run('git', ['checkout', '--detach'], { cwd: root });
    await expect(git.runOperation('push')).rejects.toThrow('detached HEAD');
  });

  it('uses pushRemote then remote.pushDefault for status and actual loopback pushes, and pulls ff-only', async () => {
    const root = await repository();
    await fs.writeFile(path.join(root, 'tracked.txt'), 'one\n');
    await run('git', ['add', 'tracked.txt'], { cwd: root });
    await run('git', ['commit', '-m', 'initial'], { cwd: root });
    const branch = String((await run('git', ['branch', '--show-current'], { cwd: root })).stdout).trim();
    const remotesRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-desktop-git-remotes-'));
    temporary.push(remotesRoot);
    for (const name of ['origin.git', 'default.git', 'preferred.git']) {
      await run('git', ['init', '--bare', name], { cwd: remotesRoot });
    }
    for (const name of ['origin.git', 'default.git', 'preferred.git']) {
      await run('git', ['config', 'http.receivepack', 'true'], { cwd: path.join(remotesRoot, name) });
    }
    const port = await smartHttpServer(remotesRoot);
    const remoteUrl = (name: string) => `http://127.0.0.1:${port}/${name}.git`;
    await run('git', ['remote', 'add', 'origin', remoteUrl('origin')], { cwd: root });
    await run('git', ['remote', 'add', 'publish', remoteUrl('default')], { cwd: root });
    await run('git', ['remote', 'add', 'preferred', remoteUrl('preferred')], { cwd: root });
    await run('git', ['config', `branch.${branch}.remote`, 'origin'], { cwd: root });
    await run('git', ['config', `branch.${branch}.merge`, 'refs/heads/release'], { cwd: root });
    await run('git', ['config', 'remote.pushDefault', 'publish'], { cwd: root });
    await run('git', ['config', `branch.${branch}.pushRemote`, 'preferred'], { cwd: root });
    const marker = path.join(root, 'pre-push-ran');
    const hook = path.join(root, '.git', 'hooks', 'pre-push');
    await fs.writeFile(hook, '#!/bin/sh\nprintf hit > pre-push-ran\n');
    await fs.chmod(hook, 0o755);

    const files = new FilesystemService();
    await files.setRoot(root);
    const git = new GitService(files);
    await expect(git.status()).resolves.toMatchObject({ pushTarget: 'preferred/release' });
    await expect(git.runOperation('push')).resolves.toMatchObject({ operation: 'push', status: { pushTarget: 'preferred/release' } });
    await expect(run('git', ['rev-parse', '--verify', 'refs/heads/release'], { cwd: path.join(remotesRoot, 'preferred.git') })).resolves.toBeDefined();
    await expect(run('git', ['rev-parse', '--verify', 'refs/heads/release'], { cwd: path.join(remotesRoot, 'default.git') })).rejects.toThrow();
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });

    await fs.writeFile(path.join(root, 'tracked.txt'), 'two\n');
    await run('git', ['add', 'tracked.txt'], { cwd: root });
    await run('git', ['commit', '-m', 'second'], { cwd: root });
    await run('git', ['config', '--unset', `branch.${branch}.pushRemote`], { cwd: root });
    await expect(git.status()).resolves.toMatchObject({ pushTarget: 'publish/release' });
    await expect(git.runOperation('push')).resolves.toMatchObject({ operation: 'push', status: { pushTarget: 'publish/release' } });
    await expect(run('git', ['rev-parse', '--verify', 'refs/heads/release'], { cwd: path.join(remotesRoot, 'default.git') })).resolves.toBeDefined();
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });

    await fs.rm(hook);
    await run('git', ['push', 'origin', 'HEAD:refs/heads/release'], { cwd: root });
    const updater = path.join(remotesRoot, 'updater');
    await run('git', ['clone', '--branch', 'release', remoteUrl('origin'), updater], { cwd: remotesRoot });
    await run('git', ['config', 'user.email', 'pi-desktop@example.test'], { cwd: updater });
    await run('git', ['config', 'user.name', 'Pi Desktop Test'], { cwd: updater });
    await fs.writeFile(path.join(updater, 'tracked.txt'), 'three\n');
    await run('git', ['add', 'tracked.txt'], { cwd: updater });
    await run('git', ['commit', '-m', 'third'], { cwd: updater });
    await run('git', ['push', 'origin', 'release'], { cwd: updater });
    await expect(git.runOperation('pull')).resolves.toMatchObject({ operation: 'pull' });
    const pulled = await fs.readFile(path.join(root, 'tracked.txt'), 'utf8');
    expect(pulled.replace(/\r\n/gu, '\n')).toBe('three\n');
  }, 60_000);

  it('rejects fetches without remotes and unsafe local remote protocols without running repository hooks', async () => {
    const root = await repository();
    await fs.writeFile(path.join(root, 'tracked.txt'), 'value\n');
    await run('git', ['add', 'tracked.txt'], { cwd: root });
    await run('git', ['commit', '-m', 'initial'], { cwd: root });
    const marker = path.join(root, 'pre-push-ran');
    const hook = path.join(root, '.git', 'hooks', 'pre-push');
    await fs.writeFile(hook, '#!/bin/sh\nprintf hit > pre-push-ran\n');
    await fs.chmod(hook, 0o755);

    const files = new FilesystemService();
    await files.setRoot(root);
    const git = new GitService(files);
    await expect(git.runOperation('fetch')).rejects.toThrow('Cannot fetch because no Git remote is configured. Add a remote, then try again.');
    await run('git', ['remote', 'add', 'origin', root], { cwd: root });
    await expect(git.runOperation('push')).rejects.toThrow();
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps status and untracked diff reads pinned to the operation root across project switches', async () => {
    const first = await repository();
    const second = await repository();
    await fs.writeFile(path.join(first, 'same.txt'), 'first root\n');
    await fs.writeFile(path.join(second, 'same.txt'), 'second root\nsecond line\n');
    const files = new FilesystemService();
    await files.setRoot(first);
    const git = new GitService(files);

    const statusRequest = git.status();
    await files.setRoot(second);
    const status = await statusRequest;
    expect(status.changes.find((change) => change.path === 'same.txt')).toMatchObject({ additions: 1, binary: false });

    await files.setRoot(first);
    const diffGit = new GitService(files);
    const diffRequest = diffGit.combinedDiff();
    await files.setRoot(second);
    const combined = await diffRequest;
    expect(combined.patch).toContain('+first root');
    expect(combined.patch).not.toContain('+second root');
  });

  it('rejects a diff when the project switches during root-scoped working-file lookup', async () => {
    const first = await repository();
    const second = await repository();
    await fs.writeFile(path.join(first, 'same.txt'), 'first committed\n');
    await run('git', ['add', 'same.txt'], { cwd: first });
    await run('git', ['commit', '-m', 'first'], { cwd: first });
    await fs.writeFile(path.join(first, 'same.txt'), 'first working\n');
    await fs.writeFile(path.join(second, 'same.txt'), 'second committed\n');
    await run('git', ['add', 'same.txt'], { cwd: second });
    await run('git', ['commit', '-m', 'second'], { cwd: second });
    await fs.writeFile(path.join(second, 'same.txt'), 'second working\n');

    const files = new FilesystemService();
    await files.setRoot(first);
    const firstCanonical = path.normalize(await fs.realpath(first));
    const originalLstat = fs.lstat.bind(fs);
    const lstat = vi.spyOn(fs, 'lstat').mockImplementation(async (filePath, ...args) => {
      const result = await originalLstat(filePath, ...args as Parameters<typeof fs.lstat> extends [unknown, ...infer Rest] ? Rest : never);
      if (path.normalize(String(filePath)) === path.join(firstCanonical, 'same.txt')) await files.setRoot(second);
      return result;
    });
    await expect(new GitService(files).diff('same.txt')).rejects.toThrow('active project changed');
    lstat.mockRestore();
  });

  it('marks oversized and failed untracked reads incomplete while continuing available entries', async () => {
    const root = await repository();
    await fs.writeFile(path.join(root, 'a-failed.txt'), 'unavailable text\n');
    await fs.writeFile(path.join(root, 'b-large.txt'), 'x'.repeat(1_048_577));
    await fs.writeFile(path.join(root, 'z-available.txt'), 'available text\n');
    const canonicalRoot = path.normalize(await fs.realpath(root));
    const originalOpen = fs.open.bind(fs);
    const open = vi.spyOn(fs, 'open').mockImplementation((filePath, ...args) => {
      if (path.normalize(String(filePath)) === path.join(canonicalRoot, 'a-failed.txt')) return Promise.reject(new Error('simulated read failure'));
      return originalOpen(filePath, ...args as Parameters<typeof fs.open> extends [unknown, ...infer Rest] ? Rest : never);
    });
    const files = new FilesystemService();
    await files.setRoot(root);
    const combined = await new GitService(files).combinedDiff();
    open.mockRestore();

    expect(combined.truncated).toBe(true);
    expect(combined.patch).toContain('diff --git a/z-available.txt b/z-available.txt');
    expect(combined.patch).toContain('+available text');
    expect(combined.patch).not.toContain('diff --git a/a-failed.txt');
    expect(combined.patch).not.toContain('diff --git a/b-large.txt');
    expect(combined.patch).not.toContain('Binary file added');
  });

  it('enforces the combined diff UTF-8 byte cap on a code-point boundary', async () => {
    const root = await repository();
    await fs.writeFile(path.join(root, 'large.txt'), 'before\n');
    await run('git', ['add', 'large.txt'], { cwd: root });
    await run('git', ['commit', '-m', 'initial'], { cwd: root });
    await fs.writeFile(path.join(root, 'large.txt'), '😀'.repeat(1_100_000));
    const files = new FilesystemService();
    await files.setRoot(root);
    const combined = await new GitService(files).combinedDiff();
    expect(combined.truncated).toBe(true);
    expect(Buffer.byteLength(combined.patch, 'utf8')).toBeLessThanOrEqual(4_000_000);
    expect(combined.patch).not.toContain('�');
  });

  it('marks Git output overflow as a truncated combined diff', async () => {
    const root = await repository();
    await fs.writeFile(path.join(root, 'overflow.txt'), 'before\n');
    await run('git', ['add', 'overflow.txt'], { cwd: root });
    await run('git', ['commit', '-m', 'initial'], { cwd: root });
    await fs.writeFile(path.join(root, 'overflow.txt'), 'x'.repeat(9 * 1_048_576));
    const files = new FilesystemService();
    await files.setRoot(root);
    await expect(new GitService(files).combinedDiff()).resolves.toMatchObject({ truncated: true });
  });

  it('propagates the status change cap into combined diff truncation', async () => {
    const root = await repository();
    for (let start = 0; start <= 10_000; start += 250) {
      const end = Math.min(10_001, start + 250);
      await Promise.all(Array.from({ length: end - start }, (_, offset) => fs.writeFile(path.join(root, `file-${String(start + offset).padStart(5, '0')}.txt`), '')));
    }
    const files = new FilesystemService();
    await files.setRoot(root);
    const git = new GitService(files);
    await expect(git.status()).resolves.toMatchObject({ truncated: true });
    await expect(git.combinedDiff()).resolves.toMatchObject({ truncated: true });
  }, 60_000);

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
