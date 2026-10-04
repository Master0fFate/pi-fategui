import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { sourceIdentity } from './source-identity.mjs';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fate-source-identity-'));
  roots.push(root);
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, stdio: 'pipe' });
  git(['init']);
  await writeFile(path.join(root, 'source.ts'), 'export const value = 1;\n');
  git(['add', 'source.ts']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'fixture']);
  return root;
}
it('binds uncommitted changes, additions and deletions without changing HEAD', async () => {
  const root = await fixture();
  const before = await sourceIdentity(root);
  await writeFile(path.join(root, 'source.ts'), 'export const value = 2;\n');
  const changed = await sourceIdentity(root);
  expect(changed.head).toBe(before.head);
  expect(changed.sha256).not.toBe(before.sha256);
  await writeFile(path.join(root, 'new.ts'), 'export const added = true;\n');
  const added = await sourceIdentity(root);
  expect(added.files).toBe(before.files + 1);
  expect(added.sha256).not.toBe(changed.sha256);
  await rm(path.join(root, 'source.ts'));
  expect((await sourceIdentity(root)).sha256).not.toBe(added.sha256);
});
it('ignores generated reports but includes build and license inputs', async () => {
  const root = await fixture();
  const before = await sourceIdentity(root);
  await mkdir(path.join(root, 'plans'));
  await writeFile(path.join(root, 'plans/report.md'), 'not source\n');
  expect(await sourceIdentity(root)).toEqual(before);
  await writeFile(path.join(root, 'LICENSE'), 'terms\n');
  expect((await sourceIdentity(root)).sha256).not.toBe(before.sha256);
});
