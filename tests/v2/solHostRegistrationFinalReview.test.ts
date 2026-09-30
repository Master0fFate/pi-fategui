// Reviewer-only T07 same-root separation and native-persistence regression.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectTrustService, canonicalizeProjectPath } from '../../src/core/projects/ProjectTrustService';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

it('keeps removed host registration out of fresh desktop trust while native trust still persists', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sol-host-trust-final-'));
  roots.push(root);
  const project = path.join(root, 'project');
  const state = path.join(root, 'same-state-root');
  await fs.mkdir(project);
  const canonical = await canonicalizeProjectPath(project);
  let registered = true;
  const port = { isRegistered: (candidate: string) => registered && candidate === canonical };
  const host = new ProjectTrustService(state);
  await (await host.prepareRegisteredProject(project, port)).commit();
  expect(host.getCurrent()).toMatchObject({ path: canonical, trusted: true });
  await expect(fs.stat(state)).rejects.toMatchObject({ code: 'ENOENT' });
  registered = false;
  await expect(host.prepareRegisteredProject(project, port))
    .rejects.toMatchObject({ normalized: { code: 'PROJECT_NOT_TRUSTED' } });

  const desktop = new ProjectTrustService(state);
  const cancel = vi.fn(async () => 'cancel' as const);
  expect(await desktop.prepareProjectPath(project, { decide: cancel })).toBeNull();
  expect(cancel).toHaveBeenCalledOnce();
  const trust = vi.fn(async () => 'trust' as const);
  const native = await desktop.prepareProjectPath(project, { decide: trust });
  expect(native?.project.trusted).toBe(true);
  await native?.commit();
  expect(trust).toHaveBeenCalledOnce();
  const grants = JSON.parse(await fs.readFile(path.join(state, 'trusted-projects.json'), 'utf8')) as { paths: string[] };
  const recent = JSON.parse(await fs.readFile(path.join(state, 'recent-project.json'), 'utf8')) as { path: string };
  expect(grants.paths).toContain(canonical);
  expect(recent.path).toBe(canonical);
  const reopened = await new ProjectTrustService(state).prepareProjectPath(project, { decide: cancel });
  expect(reopened?.project.trusted).toBe(true);
  expect(cancel).toHaveBeenCalledOnce();
});
