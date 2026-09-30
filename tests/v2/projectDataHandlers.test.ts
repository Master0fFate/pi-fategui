import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFateCore } from '../../src/core/createFateCore';
import { FatePaths } from '../../src/core/FatePaths';
import { createLocalIpcContext } from '../../src/core/dispatch/RequestContext';
import { createScopedFileHandlers } from '../../src/core/handlers/fileHandlers';
import { createScopedGitHandlers } from '../../src/core/handlers/gitHandlers';
import { methodCatalog, unsupportedNetworkGitMutations } from '../../src/shared/protocol/methods';
import { clientPreferencesSchema, projectClientPreferences, updateClientPreferences } from '../../src/shared/protocol/clientPreferences';
import { FakePiSdkAdapter } from './helpers/fakePi';
import { privateTestRoot } from './helpers/isolatedEnvironment';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 }))); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
async function fixture() {
  const root = await mkdtemp(path.join(privateTestRoot(), 'project-data-')); roots.push(root);
  const a = path.join(root, 'A'), b = path.join(root, 'B');
  for (const [directory, text] of [[a, 'A-only'], [b, 'B-only']] as const) {
    await mkdir(directory); git(directory, 'init', '--quiet');
    git(directory, 'config', '--local', 'user.name', 'Test');
    git(directory, 'config', '--local', 'user.email', 'test@example.invalid');
    git(directory, 'config', '--local', 'commit.gpgSign', 'false');
    git(directory, 'config', '--local', 'core.autocrlf', 'false');
    await writeFile(path.join(directory, 'sentinel.txt'), `${text}\n`);
    git(directory, 'add', 'sentinel.txt'); git(directory, 'commit', '--quiet', '-m', text);
    await writeFile(path.join(directory, 'changes.txt'), `${text} changed\n`);
  }
  const adapter = new FakePiSdkAdapter();
  const identity = createLocalIpcContext({ principalId: '099981d4-a8f7-414d-8feb-f9d4b4a91aa5', clientId: 'bacdd2b3-3c8e-4c1f-9832-f1ae91e67eda', expiresAt: Date.now() + 60_000 });
  const members = new Set<string>();
  const core = await createFateCore({ adapter, paths: new FatePaths({ dataRoot: path.join(root, 'data'), piAgentDir: path.join(root, 'pi'), sessionsRoot: path.join(root, 'pi', 'sessions'), attachmentRoot: path.join(root, 'attachments'), lockRoot: path.join(root, 'locks'), profileId: 'test' }),
    workspaceRegistration: { isRegistered: (canonical) => canonical === a || canonical === b },
    workspaceMembership: (client, workspaceId) => client === identity && members.has(workspaceId) });
  await core.runtime.openProject({ path: a, name: 'A', trusted: true });
  const ha = await core.workspaces!.registerHostPath(a); members.add(ha.id);
  await core.runtime.openProject({ path: b, name: 'B', trusted: true });
  const hb = await core.workspaces!.registerHostPath(b); members.add(hb.id);
  let permission = true, controlGeneration = 1;
  const authorize = (handle: typeof ha) => () => {
    core.workspaces!.resolve(identity, handle.id, handle.generation);
    return { currentGeneration: handle.generation, permission, controlGeneration };
  };
  const command = (handle: typeof ha) => ({ workspaceGeneration: handle.generation,
    expectedSessionId: handle.admission.snapshot().selectedSessionId,
    selectionRevision: handle.admission.snapshot().selectionRevision, controlGeneration: 1 });
  return { a, b, core, adapter, ha, hb, members, authorize, command,
    revoke: () => { permission = false; }, revokeControl: () => { controlGeneration += 1; },
    dispose: async () => { await core.dispose(); await adapter.dispose(); } };
}

describe('T18 workspace-bound project data and client preferences', () => {
  it('keeps concurrent A/B file and Git results under their respective registered handles', async () => {
    const f = await fixture();
    try {
      const fa = createScopedFileHandlers(f.ha, f.authorize(f.ha)), fb = createScopedFileHandlers(f.hb, f.authorize(f.hb));
      const ga = createScopedGitHandlers(f.ha, f.authorize(f.ha)), gb = createScopedGitHandlers(f.hb, f.authorize(f.hb));
      const [a, b, as, bs, ah, bh] = await Promise.all([
        fa.read({ path: 'sentinel.txt' }), fb.read({ path: 'sentinel.txt' }), ga.status({}), gb.status({}), ga.history({}), gb.history({}),
      ]);
      expect(a.content).toBe('A-only\n'); expect(b.content).toBe('B-only\n');
      expect(as.changes.map((change) => change.path)).toContain('changes.txt');
      expect(bs.changes.map((change) => change.path)).toContain('changes.txt');
      expect(ah.commits[0]?.subject).toBe('A-only'); expect(bh.commits[0]?.subject).toBe('B-only');
      const [ad, bd] = await Promise.all([ga.diff({ path: 'changes.txt' }), gb.diff({ path: 'changes.txt' })]);
      expect(ad.modified).toContain('A-only'); expect(bd.modified).toContain('B-only');
      expect(JSON.stringify([a, as, ah, ad])).not.toContain('B-only');
      expect(JSON.stringify([b, bs, bh, bd])).not.toContain('A-only');
    } finally { await f.dispose(); }
  });

  it('rejects unregistered relative paths, absolute paths, escapes, and unknown resource IDs', async () => {
    const f = await fixture();
    try {
      const files = createScopedFileHandlers(f.ha, f.authorize(f.ha));
      const gitA = createScopedGitHandlers(f.ha, f.authorize(f.ha));
      await expect(files.read({ path: '../B/sentinel.txt' })).rejects.toThrow();
      await expect(files.read({ path: f.b + '/sentinel.txt' })).rejects.toThrow();
      await expect(gitA.diff({ path: '../B/sentinel.txt' })).rejects.toThrow();
      await expect(files.previewTextResource({ fileId: 'ecf84746-5912-4bba-b219-df122e13d212', maxBytes: 20 })).rejects.toThrow();
      const listing = await files.listResource({ directoryId: null, limit: 20 });
      expect(JSON.stringify(listing)).not.toContain(f.a);
      const sentinel = listing.entries.find((entry) => entry.name === 'sentinel.txt')!;
      expect(await files.previewTextResource({ fileId: sentinel.resourceId, maxBytes: 20 })).toMatchObject({ content: 'A-only\n', truncated: false });
    } finally { await f.dispose(); }
  });

  it('does not return outside bytes when a checked directory becomes a junction before open', async () => {
    const f = await fixture();
    try {
      const inside = path.join(f.a, 'safe'), outside = path.join(path.dirname(f.a), 'outside');
      await mkdir(inside); await mkdir(outside);
      await writeFile(path.join(inside, 'note.txt'), 'safe content');
      await writeFile(path.join(outside, 'note.txt'), 'PRIVATE OUTSIDE');
      const original = f.ha.files.resolvePath.bind(f.ha.files);
      vi.spyOn(f.ha.files, 'resolvePath').mockImplementationOnce(async (relative, allowRoot) => {
        const resolved = await original(relative, allowRoot);
        await rm(inside, { recursive: true });
        await symlink(outside, inside, process.platform === 'win32' ? 'junction' : 'dir');
        return resolved;
      });
      await expect(createScopedFileHandlers(f.ha, f.authorize(f.ha)).read({ path: 'safe/note.txt' })).rejects.toThrow();
    } finally { await f.dispose(); }
  });

  it('does not read an outside Git diff after its canonical path is replaced', async () => {
    const f = await fixture();
    try {
      const inside = path.join(f.a, 'safe'), outside = path.join(path.dirname(f.a), 'outside-git');
      await mkdir(inside); await mkdir(outside);
      const target = path.join(inside, 'note.txt');
      await writeFile(target, 'inside'); await writeFile(path.join(outside, 'note.txt'), 'PRIVATE OUTSIDE');
      const realpath = fs.realpath.bind(fs);
      let calls = 0;
      const spy = vi.spyOn(fs, 'realpath').mockImplementation(async (...args) => {
        const resolved = await realpath(...args);
        if (String(args[0]) === target && ++calls === 2) {
          await rm(inside, { recursive: true });
          await symlink(outside, inside, process.platform === 'win32' ? 'junction' : 'dir');
        }
        return resolved;
      });
      try { await expect(createScopedGitHandlers(f.ha, f.authorize(f.ha)).diff({ path: 'safe/note.txt' })).rejects.toThrow(); }
      finally { spy.mockRestore(); }
    } finally { await f.dispose(); }
  });

  it('offers only scoped Git reads; approved managed child-worktree operations stay under separate controller/Team gates, not native Git mutation', async () => {
    const f = await fixture();
    try {
      const a = createScopedGitHandlers(f.ha, f.authorize(f.ha));
      const b = createScopedGitHandlers(f.hb, f.authorize(f.hb));
      for (const handler of [a, b]) {
        for (const name of ['revertPath', 'commit', 'cleanup', 'runOperation', 'worktrees', 'integrate']) {
          expect(name in handler).toBe(false);
        }
      }
      expect(unsupportedNetworkGitMutations).toContain('git.revert');
      const gitReads = Object.values(methodCatalog).filter((entry) => entry.name.startsWith('git.'));
      expect(gitReads.map((entry) => entry.name).sort()).toEqual(['git.status', 'git.history', 'git.diff', 'git.combinedDiff', 'git.commitDetails'].sort());
      for (const descriptor of gitReads) expect(descriptor).toMatchObject({ mutation: 'read', authorization: 'workspace-member', permission: 'read' });
      expect(methodCatalog['agent.workspace']).toMatchObject({ scope: 'session-control', mutation: 'runtime', authorization: 'workspace-controller',
        permission: 'prompt', retry: 'same-envelope-only-no-automatic-replay' });
      const worktree = methodCatalog['agent.workspace'].inputSchema;
      expect(worktree.safeParse({ teamId: 'team', target: 'child', operation: 'review' }).success).toBe(true);
      expect(worktree.safeParse({ teamId: 'team', target: 'child', operation: 'integrate' }).success).toBe(false);
      expect(worktree.safeParse({ teamId: 'team', target: 'child', operation: 'cleanup', path: f.a }).success).toBe(false);
      for (const method of ['git.revert', 'git.commit', 'git.runOperation', 'git.cleanup', 'git.integrate']) expect(method in methodCatalog).toBe(false);
      f.revoke(); f.revokeControl();
      expect((await a.status({})).changes.some((change) => change.path === 'changes.txt')).toBe(true);
      expect(await readFile(path.join(f.a, 'changes.txt'), 'utf8')).toContain('A-only');
      expect(await readFile(path.join(f.b, 'changes.txt'), 'utf8')).toContain('B-only');
    } finally { await f.dispose(); }
  });

  it('binds reads to the registered root identity, not a replacement ordinary directory at the same name', async () => {
    const f = await fixture();
    try {
      const old = path.join(path.dirname(f.a), 'old-A');
      await fs.rename(f.a, old);
      await mkdir(f.a);
      await writeFile(path.join(f.a, 'sentinel.txt'), 'REPLACED PRIVATE DATA');
      const files = createScopedFileHandlers(f.ha, f.authorize(f.ha));
      const gitA = createScopedGitHandlers(f.ha, f.authorize(f.ha));
      await expect(files.read({ path: 'sentinel.txt' })).rejects.toThrow();
      await expect(files.listResource({ directoryId: null, limit: 20 })).rejects.toThrow();
      await expect(gitA.status({})).rejects.toThrow();
      await expect(gitA.history({})).rejects.toThrow();
    } finally { await f.dispose(); }
  });

  it('treats Git history as repository-wide across linked worktrees while file/status roots stay local', async () => {
    const f = await fixture();
    try {
      const linked = path.join(path.dirname(f.a), 'A-linked');
      git(f.a, 'worktree', 'add', '--quiet', '-b', 'linked-feature', linked);
      git(linked, 'config', '--local', 'user.name', 'Test');
      git(linked, 'config', '--local', 'user.email', 'test@example.invalid');
      await writeFile(path.join(linked, 'linked-only.txt'), 'linked branch data');
      git(linked, 'add', 'linked-only.txt'); git(linked, 'commit', '--quiet', '-m', 'linked-only-commit');
      const linkedHash = git(linked, 'rev-parse', 'HEAD');
      const scoped = createScopedGitHandlers(f.ha, f.authorize(f.ha));
      const history = await scoped.history({});
      expect(history.commits.some((commit) => commit.hash === linkedHash && commit.subject === 'linked-only-commit')).toBe(true);
      expect((await scoped.commitDetails({ hash: linkedHash })).subject).toBe('linked-only-commit');
      expect((await scoped.status({})).changes.some((change) => change.path === 'linked-only.txt')).toBe(false);
      await expect(createScopedFileHandlers(f.ha, f.authorize(f.ha)).read({ path: 'linked-only.txt' })).rejects.toThrow();
    } finally { await f.dispose(); }
  });

  it('does not report a corrupt Git history as an empty healthy repository', async () => {
    const f = await fixture();
    try {
      const branch = git(f.a, 'branch', '--show-current');
      await writeFile(path.join(f.a, '.git', 'refs', 'heads', branch), `${'0'.repeat(40)}\n`);
      const scoped = createScopedGitHandlers(f.ha, f.authorize(f.ha));
      await expect(scoped.history({})).rejects.toThrow();
      await rm(path.join(f.a, '.git'), { recursive: true });
      expect(await scoped.history({})).toEqual({ head: null, commits: [], truncated: false });
    } finally { await f.dispose(); }
  });

  it('rejects a settings payload that tries to set host cap or credential file', async () => {
    const f = await fixture();
    try {
      const original = f.core.settings.get();
      const publicView = projectClientPreferences({ ...original, terminalShell: 'PRIVATE_SHELL_CONFIG',
        defaultModel: 'provider/PRIVATE_MODEL_TOKEN' });
      expect(publicView).not.toHaveProperty('agentWorkspace');
      expect(publicView).not.toHaveProperty('terminalShell');
      expect(publicView).not.toHaveProperty('imageGeneration');
      expect(() => updateClientPreferences(publicView, { themeId: 'catppuccin-latte', hostMaximumPermission: 'full-access' })).toThrow();
      expect(() => updateClientPreferences(publicView, { themeId: 'catppuccin-latte', agentWorkspace: { preferredMode: 'shared' } })).toThrow();
      expect(() => clientPreferencesSchema.parse({ ...publicView, credentialFile: path.join(f.a, 'secret.json') })).toThrow();
      expect(JSON.stringify(publicView)).not.toMatch(/PRIVATE_|credential|terminalShell|defaultModel/u);
      const changed = updateClientPreferences(publicView, { themeId: 'catppuccin-latte' });
      expect(changed.themeId).toBe('catppuccin-latte');
      expect(f.core.settings.get()).toEqual(original);
      expect(JSON.stringify(changed)).not.toContain(f.a);
    } finally { await f.dispose(); }
  });
});
