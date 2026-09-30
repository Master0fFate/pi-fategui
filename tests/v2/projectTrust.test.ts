// @vitest-environment node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalizeProjectPath, ProjectTrustService } from '../../src/core/projects/ProjectTrustService';
import type { ProjectTrustPort } from '../../src/core/ports';

// Intentionally no Electron mock or native adapter in this suite.
const roots: string[] = [];
const trust: ProjectTrustPort = { decide: async () => 'trust' };
async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-portable-trust-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('portable project trust', () => {
  it('admits only host-registered canonical paths without asking a native dialog', async () => {
    const root = await directory();
    const project = await directory();
    const canonical = await canonicalizeProjectPath(project);
    const isRegistered = vi.fn((candidate: string) => candidate === canonical);
    const store = new ProjectTrustService(root);
    const activation = await store.prepareRegisteredProject(project, { isRegistered });
    expect(activation.project).toMatchObject({ path: canonical, trusted: true });
    expect(store.getCurrent()).toBeNull();
    await expect(fs.stat(path.join(root, 'trusted-projects.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await activation.commit();
    expect(store.getCurrent()).toEqual(activation.project);
    expect(isRegistered).toHaveBeenCalledWith(canonical);
  });

  it('does not substitute prior desktop trust for host registration', async () => {
    const root = await directory();
    const project = await directory();
    const store = new ProjectTrustService(root);
    await (await store.prepareProjectPath(project, trust))?.commit();
    await expect(store.prepareRegisteredProject(project, { isRegistered: () => false }))
      .rejects.toMatchObject({ normalized: { code: 'PROJECT_NOT_TRUSTED' } });
  });

  it('refuses a host registration revoked before activation commit', async () => {
    const root = await directory();
    const project = await directory();
    let registered = true;
    const store = new ProjectTrustService(root);
    const activation = await store.prepareRegisteredProject(project, { isRegistered: () => registered });
    registered = false;
    await expect(activation.commit()).rejects.toMatchObject({ normalized: { code: 'PROJECT_NOT_TRUSTED' } });
    await activation.rollback();
    expect(store.getCurrent()).toBeNull();
    await expect(fs.stat(path.join(root, 'trusted-projects.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('canonicalizes aliases consistently using execution-host path rules', async () => {
    const root = await directory();
    const project = path.join(root, 'Project');
    const alias = path.join(root, 'alias');
    await fs.mkdir(project);
    await fs.symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const canonical = await canonicalizeProjectPath(project);
    expect(await canonicalizeProjectPath(alias)).toBe(canonical);
    if (process.platform === 'win32') expect(await canonicalizeProjectPath(project.toUpperCase())).toBe(canonical);
    const store = new ProjectTrustService(path.join(root, 'state'));
    await (await store.prepareProjectPath(project, trust))?.commit();
    const decide = vi.fn(async () => 'cancel' as const);
    expect((await store.prepareProjectPath(alias, { decide }))?.project.trusted).toBe(true);
    expect(decide).not.toHaveBeenCalled();
  });

  it('cancel and open-without-Pi never persist project trust or load project resources', async () => {
    const root = await directory();
    const project = path.join(root, 'project');
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, 'trusted-projects.json'), JSON.stringify({ version: 1, paths: [project] }));
    const state = path.join(root, 'state');
    const store = new ProjectTrustService(state);
    expect(await store.prepareProjectPath(project, { decide: async () => 'cancel' })).toBeNull();
    expect(store.getCurrent()).toBeNull();
    await expect(fs.stat(state)).rejects.toMatchObject({ code: 'ENOENT' });
    const activation = await store.prepareProjectPath(project, { decide: async () => 'open-without-pi' });
    expect(activation?.project.trusted).toBe(false);
    await activation?.commit();
    await expect(fs.stat(path.join(state, 'trusted-projects.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await new ProjectTrustService(state).lastTrustedProjectPath()).toBeNull();
    // Active does not mean trusted: listing, session references and deletion all
    // use these gates even when Pi was never initialized for this project.
    await expect(store.prepareSessionListPath(project)).rejects.toMatchObject({ normalized: { code: 'PROJECT_NOT_TRUSTED' } });
    await expect(store.prepareKnownProjectCleanupPath(project)).rejects.toMatchObject({ normalized: { code: 'PROJECT_NOT_TRUSTED' } });
  });

  it('fails closed on malformed, oversized, and too-many-record trust stores', async () => {
    const root = await directory();
    const project = await directory();
    for (const contents of ['{bad json', 'x'.repeat(256 * 1024 + 1), JSON.stringify({ version: 1, paths: Array(2001).fill(project) })]) {
      await fs.writeFile(path.join(root, 'trusted-projects.json'), contents);
      const decide = vi.fn(async () => 'cancel' as const);
      expect(await new ProjectTrustService(root).prepareProjectPath(project, { decide })).toBeNull();
      expect(decide).toHaveBeenCalledOnce();
    }
  });

  it('does not grant trust when the state grows beyond its read bound between inspection and open', async () => {
    const root = await directory();
    const project = await directory();
    const file = path.join(root, 'trusted-projects.json');
    await fs.writeFile(file, JSON.stringify({ version: 1, paths: [await canonicalizeProjectPath(project)] }));
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (args[0] === file) await fs.appendFile(file, 'X'.repeat(256 * 1024));
      return open(...args);
    });
    const decide = vi.fn(async () => 'cancel' as const);
    expect(await new ProjectTrustService(root).prepareProjectPath(project, { decide })).toBeNull();
    expect(decide).toHaveBeenCalledOnce();
  });

  it('does not trust a valid path from a partly malformed trust record', async () => {
    const root = await directory();
    const project = await directory();
    await fs.writeFile(path.join(root, 'trusted-projects.json'), JSON.stringify({
      version: 1, paths: [await canonicalizeProjectPath(project), '../not-a-canonical-host-path'],
    }));
    const decide = vi.fn(async () => 'cancel' as const);
    expect(await new ProjectTrustService(root).prepareProjectPath(project, { decide })).toBeNull();
    expect(decide).toHaveBeenCalledOnce();
  });

  it('restores prior project and trusted state when a trust save fails', async () => {
    const root = await directory();
    const first = await directory();
    const second = await directory();
    const store = new ProjectTrustService(root);
    const firstActivation = (await store.prepareProjectPath(first, trust))!;
    await firstActivation.commit();
    const activation = (await store.prepareProjectPath(second, trust))!;
    const rename = fs.rename.bind(fs);
    let failed = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (!failed && destination === path.join(root, 'trusted-projects.json')) {
        failed = true;
        throw new Error('fixture trust save failed');
      }
      return rename(source, destination);
    });
    await expect(activation.commit()).rejects.toThrow('fixture trust save failed');
    await activation.rollback();
    expect(store.getCurrent()).toEqual(firstActivation.project);
    expect(JSON.parse(await fs.readFile(path.join(root, 'trusted-projects.json'), 'utf8')).paths).toEqual([firstActivation.project.path]);
    expect(await new ProjectTrustService(root).lastTrustedProjectPath()).toBe(firstActivation.project.path);
    const decide = vi.fn(async () => 'cancel' as const);
    expect(await store.prepareProjectPath(second, { decide })).toBeNull();
    expect(decide).toHaveBeenCalledOnce();
  });

  it('does not add trust when a prepared activation is abandoned before persistence commit', async () => {
    const root = await directory();
    const first = await directory();
    const second = await directory();
    const store = new ProjectTrustService(root);
    const firstActivation = (await store.prepareProjectPath(first, trust))!;
    await firstActivation.commit();
    const candidate = (await store.prepareProjectPath(second, trust))!;
    await candidate.rollback(); // Desktop runtime-failure integration is covered in ProjectService.test.ts.
    expect(store.getCurrent()).toEqual(firstActivation.project);
    expect(JSON.parse(await fs.readFile(path.join(root, 'trusted-projects.json'), 'utf8')).paths).toEqual([firstActivation.project.path]);
  });

  it('rolls back newly added trust after commit but retains prior trust', async () => {
    const root = await directory();
    const first = await directory();
    const second = await directory();
    const store = new ProjectTrustService(root);
    await (await store.prepareProjectPath(first, trust))?.commit();
    const current = store.getCurrent();
    const candidate = (await store.prepareProjectPath(second, trust))!;
    await candidate.commit();
    await expect(candidate.commit()).rejects.toThrow('already used');
    await candidate.rollback();
    expect(store.getCurrent()).toEqual(current);
    expect(JSON.parse(await fs.readFile(path.join(root, 'trusted-projects.json'), 'utf8')).paths).toEqual([current?.path]);
    expect((await store.prepareProjectPath(first, { decide: async () => 'cancel' }))?.project.trusted).toBe(true);
  });
});
