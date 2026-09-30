import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServerProfile } from '../../src/core/storage/ServerProfile';
import { prepareFateProviderStorage } from '../../src/main/pi/FateProviderStorage';
import { createFateCore } from '../../src/core/createFateCore';
import { createDesktopFatePaths } from '../../src/core/FatePaths';
import { privateTestRoot } from './helpers/isolatedEnvironment';
import { createPiSdkAdapter } from '../../src/main/pi/PiRuntimeService';
import { projectSessionDirectory } from '../../src/main/pi/PiSessionRepository';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function sandbox(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), 'fate-profile-test-')); roots.push(root); return root; }

describe('profile path isolation', () => {
  it('does not infer server/desktop security policy from profile ID', async () => {
    const home = await sandbox();
    const server = await createServerProfile({ home, profileId: 'desktop' });
    expect(server.profileKind).toBe('server');
    const customDesktop = createDesktopFatePaths({ home, profileId: 'other-desktop' });
    expect(customDesktop.profileKind).toBe('desktop');
    expect(customDesktop.profileId).toBe('other-desktop');
    await mkdir(server.piAgentDir, { recursive: true });
    await writeFile(path.join(server.piAgentDir, 'auth.json'), '{"server-pi":"must-not-import"}');
    const core = await createFateCore({ paths: server });
    try {
      await expect(readFile(path.join(server.dataRoot, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await core.dispose(); }
  });

  it('separates two profile queues and settings after writes, never reading another profile sentinel', async () => {
    const home = await sandbox();
    const a = await createServerProfile({ home, profileId: 'alpha' });
    const b = await createServerProfile({ home, profileId: 'beta' });
    const { SessionQueueRepository } = await import('../../src/main/pi/SessionQueueRepository');
    const queueA = new SessionQueueRepository(path.join(a.dataRoot, 'session-queues', 'v1'), 1);
    const queueB = new SessionQueueRepository(path.join(b.dataRoot, 'session-queues', 'v1'), 1);
    const project = path.join(home, 'workspace');
    const session = 'same-id';
    const marker = { id: randomUUID(), text: 'alpha-only', behavior: 'followUp' as const, createdAt: 1 };
    await queueA.save(project, session, [marker]);
    expect(await queueB.load(project, session)).toEqual([]);
    await queueB.save(project, session, [{ ...marker, id: randomUUID(), text: 'beta-only' }]);
    expect((await queueA.load(project, session))[0]?.text).toBe('alpha-only');
    expect((await queueB.load(project, session))[0]?.text).toBe('beta-only');
    const coreA = await createFateCore({ paths: a });
    const coreB = await createFateCore({ paths: b });
    try {
      await coreA.settings.set({ ...coreA.settings.get(), themeId: 'light' });
      await coreB.settings.set({ ...coreB.settings.get(), themeId: 'dark' });
      expect(await readFile(coreA.settings.getStoragePath(), 'utf8')).toContain('light');
      expect(await readFile(coreB.settings.getStoragePath(), 'utf8')).toContain('dark');
    } finally { await coreB.dispose(); await coreA.dispose(); }
  });
  it('binds the real Pi SDK model, resource and session managers to two explicit profiles, offline', async () => {
    expect(process.env.PI_OFFLINE).toBe('1');
    const root = await sandbox();
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    await mkdir(home);
    await mkdir(project);
    const ambientAgent = path.join(privateTestRoot(), 'pi', 'agent');
    const ambientAuth = path.join(ambientAgent, 'auth.json');
    await mkdir(ambientAgent, { recursive: true });
    await writeFile(ambientAuth, '{"desktop":"sentinel"}');
    try {
      for (const id of ['alpha', 'beta']) {
        const paths = await createServerProfile({ home, profileId: id });
        const adapter = createPiSdkAdapter(paths);
        const runtime = await adapter.createRuntime(project, await adapter.createModelRuntime(), true);
        try {
          expect(runtime.services.agentDir).toBe(paths.piAgentDir);
          expect(runtime.session.sessionManager.getSessionDir()).toBe(projectSessionDirectory(project, paths.sessionsRoot));
          expect(await readFile(path.join(paths.dataRoot, 'auth.json'), 'utf8')).not.toContain('desktop');
        } finally { await runtime.dispose(); }
      }
      expect(await readFile(ambientAuth, 'utf8')).toContain('sentinel');
    } finally { await rm(ambientAuth, { force: true }); }
  });

  it('starts two real default SDK cores offline with separate Pi/session/credential/settings roots', async () => {
    expect(process.env.PI_OFFLINE).toBe('1');
    const root = await sandbox();
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    await mkdir(home);
    await mkdir(project);
    const ambientAgent = path.join(privateTestRoot(), 'pi', 'agent');
    await mkdir(ambientAgent, { recursive: true });
    const ambientAuth = path.join(ambientAgent, 'auth.json');
    await writeFile(ambientAuth, '{"desktop":"sentinel"}');
    try {
      for (const id of ['alpha', 'beta']) {
        const paths = await createServerProfile({ home, profileId: id });
        const core = await createFateCore({ paths });
        try {
          expect(core.runtime.getFocused().getState(false).project).toBeNull();
          const state = await core.runtime.openProject({ path: project, name: 'synthetic', trusted: true });
          expect(state.status).toBe('auth-required'); // No credentials or provider call; an honest offline state.
          await core.settings.set({ ...core.settings.get(), themeId: id === 'alpha' ? 'light' : 'dark' });
          const saved = await readFile(core.settings.getStoragePath(), 'utf8');
          expect(saved).toContain(id === 'alpha' ? 'light' : 'dark');
          expect(await readFile(path.join(paths.dataRoot, 'auth.json'), 'utf8')).not.toContain('desktop');
          expect(await lstat(paths.sessionsRoot)).toMatchObject({ isDirectory: expect.any(Function) });
        } finally { await core.dispose(); }
      }
      expect(await readFile(ambientAuth, 'utf8')).toContain('sentinel');
    } finally { await rm(ambientAuth, { force: true }); }
  });
  it('uses distinct canonical private server roots, independent of ambient Pi/Fate variables, without precreating provider root', async () => {
    const home = await sandbox();
    const first = await createServerProfile({ home, profileId: 'one' });
    const second = await createServerProfile({ home, profileId: 'two' });
    expect(first.dataRoot).not.toBe(second.dataRoot);
    expect(first.piAgentDir).not.toBe(second.piAgentDir);
    expect(first.sessionsRoot).not.toBe(second.sessionsRoot);
    expect(first.lockRoot).not.toBe(first.dataRoot);
    expect(first.dataRoot).toBe(path.join(home, '.pi', 'fate-server', 'one', 'data'));
    await expect(lstat(first.dataRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(createServerProfile({ home, profileId: '../desktop' })).rejects.toThrow();
    await expect(createServerProfile({ home, profileId: 'unsafe', profileRoot: path.join(home, '.pi', 'agent') })).rejects.toThrow('overlap desktop');
  });

  it('never imports legacy files for a server, even on first run; desktop retains first-run import', async () => {
    const home = await sandbox();
    const legacy = path.join(home, 'desktop-pi');
    await mkdir(legacy);
    await writeFile(path.join(legacy, 'auth.json'), '{"secret":"desktop"}');
    const server = await createServerProfile({ home, profileId: 'new' });
    const result = await prepareFateProviderStorage({ dataRoot: server.dataRoot, piAgentDir: legacy, legacyImport: false });
    expect(result).toMatchObject({ firstRun: true, imported: [] });
    await expect(readFile(result.paths.authPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const desktop = await prepareFateProviderStorage({ dataRoot: path.join(home, 'desktop-fate'), piAgentDir: legacy });
    expect(desktop.imported).toContain('auth.json');
    expect(await readFile(desktop.paths.authPath, 'utf8')).toContain('desktop');
  });

  it('rejects existing symlink roots and symlink credential files; accepts an empty existing private root', async () => {
    const home = await sandbox();
    const root = path.join(home, 'custom');
    const other = path.join(home, 'other');
    await mkdir(other);
    await symlink(other, root, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(createServerProfile({ home, profileId: 'new', profileRoot: root })).rejects.toThrow();
    await rm(root);
    await mkdir(root, { mode: 0o700 });
    const profile = await createServerProfile({ home, profileId: 'new', profileRoot: root });
    await mkdir(profile.dataRoot);
    const result = await prepareFateProviderStorage({ dataRoot: profile.dataRoot, piAgentDir: other, legacyImport: false });
    expect(result.firstRun).toBe(false);
    await writeFile(path.join(other, 'auth.json'), 'sentinel');
    // Windows junctions need no Developer Mode privilege; both link kinds must fail.
    await symlink(process.platform === 'win32' ? other : path.join(other, 'auth.json'), result.paths.authPath, process.platform === 'win32' ? 'junction' : 'file');
    await expect(prepareFateProviderStorage({ dataRoot: profile.dataRoot, legacyImport: false })).rejects.toThrow('regular file');
  });
});
