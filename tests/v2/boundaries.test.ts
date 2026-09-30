// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const checker = fileURLToPath(new URL('../../scripts/check-v2-boundaries.mjs', import.meta.url));
const roots: string[] = [];
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fate-boundaries-'));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, source);
  }
  return root;
}
function check(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [checker, '--root', root, ...args, '--json'], { encoding: 'utf8' });
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('parsed v2 import graph', () => {
  it('rejects indirect Electron through re-exports and literal dynamic imports', async () => {
    const root = await fixture({
      'src/core/entry.ts': "export { load } from '../reusable/barrel';",
      'src/reusable/barrel.ts': "export { load } from './helper';",
      'src/reusable/helper.ts': "export async function load() { return import('electron'); }",
    });
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('electron');
    expect(JSON.parse(result.stdout).failures[0].chain).toEqual(['src/core/entry.ts', 'src/reusable/barrel.ts', 'src/reusable/helper.ts']);
  });

  it('understands true type-only edges but rejects mixed runtime bindings', async () => {
    const root = await fixture({
      'src/core/entry.ts': "import type { BrowserWindow } from 'electron'; import { type A } from '../native'; export { type A } from '../native'; type B = import('electron').BrowserWindow;",
      'src/native.ts': "import { shell } from 'electron'; export interface A {}",
    });
    expect(check(root).status).toBe(0);
    await writeFile(path.join(root, 'src/core/entry.ts'), "import { type A, run } from '../native'; run();");
    expect(check(root).status).toBe(1);
  });

  it.each([
    "import('electron')", "import(`electron`)", "require('electron')",
    "import('uiohook-napi')", "import('transcribe-cpp')", "import('binding.node')",
  ])('checks executable dependencies: %s', async (source) => {
    const root = await fixture({ 'src/core/entry.ts': source });
    expect(check(root).status).toBe(1);
  });

  it('rejects indirect desktop implementation paths even when they do not import Electron yet', async () => {
    const root = await fixture({
      'src/core/entry.ts': "import '../helper';",
      'src/helper.ts': "export * from './main/speech/futureNative';",
      'src/main/speech/futureNative.ts': 'export const native = true;',
    });
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Forbidden headless dependency');
  });

  it('rejects nonliteral dynamic imports in the entire protected closure', async () => {
    const root = await fixture({
      'src/core/entry.ts': "export * from '../helper';",
      'src/helper.ts': 'export const load = (name: string) => import(name);',
    });
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Nonliteral dynamic import');
  });

  it.each(['Document', 'Window', 'HTMLElement', 'globalThis.Document'])('rejects ambient %s types in portable host ports without import edges', async (typeName) => {
    const root = await fixture({ 'src/core/ports.ts': `export interface HostPort { owner: ${typeName}; }` });
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Ambient DOM/native type');
  });

  it('does not expose Electron types in portable host ports', async () => {
    const root = await fixture({ 'src/core/ports.ts': "export type { BrowserWindow } from 'electron';" });
    expect(check(root).stdout).toContain('Native types cannot appear in portable host ports');
  });

  it.each(['node:fs', 'fs/promises', 'electron', '@earendil-works/pi-coding-agent'])('bans %s through browser re-exports, including native contract types', async (dependency) => {
    const root = await fixture({
      'src/client/entry.ts': "export type { Value } from '../helper';",
      'src/helper.ts': `import type { Value } from '${dependency}'; export type { Value };`,
    });
    expect(check(root).status).toBe(1);
  });

  it('resolves browser aliases and rejects host services', async () => {
    const root = await fixture({
      'src/client/entry.ts': "export * from '@shared/helper';",
      'src/shared/helper.ts': "export * from '../main/service';",
      'src/main/service.ts': 'export const value = 1;',
    });
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Forbidden browser dependency');
  });

  it('fails unresolved local imports rather than losing a graph edge', async () => {
    const root = await fixture({ 'src/core/entry.ts': "import './missing';" });
    expect(check(root).stdout).toContain('Unresolved local import');
  });

  it('checks the real portable file/trust/raster closure with no Electron alias', () => {
    const result = check(fileURLToPath(new URL('../..', import.meta.url)));
    expect(result.status, result.stderr + result.stdout).toBe(0);
  });
});
