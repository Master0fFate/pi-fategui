// Independent adversarial reviewer probes, now retained as regressions.
// Alternate module loader APIs are prohibited rather than incompletely resolved.
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const checker = fileURLToPath(new URL('../../scripts/check-v2-boundaries.mjs', import.meta.url));
const roots: string[] = [];
async function probe(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sol-v2-boundary-'));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const destination = path.join(root, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, source);
  }
  return spawnSync(process.execPath, [checker, '--root', root, '--json'], { encoding: 'utf8' });
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

it('rejects an Electron type exported through an indirect public host port', async () => {
  const result = await probe({
    'src/core/ports.ts': "export type { NativePort } from '../hidden/bridge';",
    'src/hidden/bridge.ts': "import type { BrowserWindow } from 'electron'; export type NativePort = BrowserWindow;",
  });
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout).toContain('Native types cannot appear in portable host ports');
});

it('rejects a native dependency loaded by an aliased require in a protected closure', async () => {
  const result = await probe({
    'src/core/service.ts': "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); export const native = load('electron');",
  });
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout).toContain('Module loader APIs are forbidden');
  expect(JSON.parse(result.stdout).failures).toContainEqual(expect.objectContaining({ specifier: 'node:module' }));
});
