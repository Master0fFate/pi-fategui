// Independent T07 host-vs-desktop authority separation regression.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectTrustService } from '../../src/core/projects/ProjectTrustService';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

it('does not convert host registration into remembered desktop GUI trust', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sol-host-registration-review-'));
  roots.push(root);
  const project = path.join(root, 'registered');
  const state = path.join(root, 'state');
  await fs.mkdir(project);
  const host = new ProjectTrustService(state);
  await (await host.prepareRegisteredProject(project, { isRegistered: () => true })).commit();

  const desktop = new ProjectTrustService(state);
  const decide = vi.fn(async () => 'cancel' as const);
  expect(await desktop.prepareProjectPath(project, { decide })).toBeNull();
  expect(decide).toHaveBeenCalledOnce();
});
