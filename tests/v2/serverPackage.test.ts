import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { privateTestRoot } from './helpers/isolatedEnvironment';

const root = path.resolve('.');
const packageScript = path.join(root, 'scripts/package-server.mjs');
const packageImport = pathToFileURL(packageScript).href;
const smokeImport = pathToFileURL(path.join(root, 'scripts/smoke-server-package.mjs')).href;
const fixtures: string[] = [];
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const projectionSchema = z.object({ roots: z.record(z.string()), snapshotCount: z.number().int().positive(),
  patches: z.record(z.string()), packageKeys: z.array(z.string()), devDependencies: z.literal(false),
  sourceHashes: z.object({ lock: z.string().regex(/^[a-f0-9]{64}$/u), workspace: z.string().regex(/^[a-f0-9]{64}$/u) }) });

function runNode(args: string[]) {
  return spawnSync(process.execPath, args, { cwd: root, env: process.env, encoding: 'utf8', timeout: 20_000 });
}
async function fixture() {
  const directory = await mkdtemp(path.join(privateTestRoot(), 'package-boundary-')); fixtures.push(directory); return directory;
}
afterEach(async () => { await Promise.all(fixtures.splice(0).map(directory => rm(directory, { recursive: true, force: true, maxRetries: 3 }))); });

describe('independent server package closure and artifact boundaries', () => {
  it('projects exact Pi/MCP/WebSocket versions and unchanged patches without desktop or development dependencies', async () => {
    const processResult = runNode([packageScript, '--inspect-lock', '--with-terminal']);
    expect(processResult.status, processResult.stderr).toBe(0);
    const result = projectionSchema.parse(JSON.parse(processResult.stdout));
    expect(result.roots).toEqual({ '@earendil-works/pi-ai': '0.87.1', '@earendil-works/pi-coding-agent': '0.87.1',
      '@modelcontextprotocol/sdk': '1.25.2', ws: '8.22.0', 'node-pty': '1.1.0' });
    expect(result.packageKeys).toContain('@earendil-works/pi-agent-core@0.87.1');
    expect(result.packageKeys.some(key => /^(electron|transcribe-cpp|uiohook-napi|koffi)(?:@|\/)/u.test(key))).toBe(false);
    expect(result.patches).toEqual({ '@earendil-works/pi-ai@0.87.1': 'patches/@earendil-works__pi-ai@0.87.1.patch',
      '@earendil-works/pi-coding-agent@0.87.1': 'patches/@earendil-works__pi-coding-agent@0.87.1.patch', 'node-pty@1.1.0': 'patches/node-pty@1.1.0.patch' });
    expect(result.sourceHashes.lock).toBe(sha(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')));
    expect(result.sourceHashes.workspace).toBe(sha(await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8')));
  });

  it('omits node-pty and its patch unless terminal packaging is explicit', () => {
    const processResult = runNode([packageScript, '--inspect-lock']); expect(processResult.status, processResult.stderr).toBe(0);
    const result = projectionSchema.parse(JSON.parse(processResult.stdout));
    expect(result.roots['node-pty']).toBeUndefined();
    expect(result.patches['node-pty@1.1.0']).toBeUndefined();
    expect(result.packageKeys).not.toContain('node-pty@1.1.0');
  });

  it('refuses unknown externals, nonliteral loaders and fake activation in production entries', async () => {
    const directory = await fixture(); const entry = path.join(directory, 'entry.mjs');
    const cases = ["import value from 'electron';", "import value from 'unlisted-package';", 'await import(process.env.TARGET);',
      'const selector = "FATE_FAKE_PROVIDER";'];
    for (const code of cases) {
      await writeFile(entry, code); const processResult = runNode([packageScript, '--audit-entry', entry]);
      expect(processResult.status, code).not.toBe(0);
    }
    await writeFile(entry, "import value from '@earendil-works/pi-coding-agent'; const terminal = () => import(  'node-pty');");
    const valid = runNode([packageScript, '--audit-entry', entry]); expect(valid.status, valid.stderr).toBe(0);
  });

  it('refuses a missing required locked snapshot instead of re-resolving it', async () => {
    const directory = await fixture(); await mkdir(path.join(directory, 'node_modules/@earendil-works'), { recursive: true });
    await symlink(await import('node:fs/promises').then(module => module.realpath(path.join(root, 'node_modules/@earendil-works/pi-coding-agent'))),
      path.join(directory, 'node_modules/@earendil-works/pi-coding-agent'), 'dir');
    await writeFile(path.join(directory, 'pnpm-workspace.yaml'), await readFile(path.join(root, 'pnpm-workspace.yaml')));
    const script = `import {createRuntimeProjection} from ${JSON.stringify(packageImport)};
import {createRequire} from 'node:module'; import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
const yaml=createRequire(realpathSync(${JSON.stringify(path.join(root, 'node_modules/@earendil-works/pi-coding-agent'))})+'/package.json')('yaml');
const lock=yaml.parse(readFileSync(${JSON.stringify(path.join(root, 'pnpm-lock.yaml'))},'utf8'));
delete lock.snapshots['ws@'+lock.importers['.'].dependencies.ws.version];
writeFileSync(${JSON.stringify(path.join(directory, 'pnpm-lock.yaml'))},yaml.stringify(lock));
await createRuntimeProjection(${JSON.stringify(directory)},true);`;
    const processResult = runNode(['--input-type=module', '-e', script]);
    expect(processResult.status).not.toBe(0); expect(processResult.stderr).toContain('no required snapshot');
  });

  it('detects changed and added files in a checksummed package', async () => {
    const directory = await fixture(); await writeFile(path.join(directory, 'data.txt'), 'original');
    const links = '[]\n'; await writeFile(path.join(directory, 'LINKS.json'), links);
    await writeFile(path.join(directory, 'SHA256SUMS'), `${sha('original')}  data.txt\n${sha(links)}  LINKS.json\n`);
    const script = `import {verifyPackage} from ${JSON.stringify(smokeImport)}; await verifyPackage(${JSON.stringify(directory)});`;
    const valid = runNode(['--input-type=module', '-e', script]); expect(valid.status, valid.stderr).toBe(0);
    await writeFile(path.join(directory, 'data.txt'), 'modified');
    const changed = runNode(['--input-type=module', '-e', script]); expect(changed.status).not.toBe(0); expect(changed.stderr).toContain('checksum mismatch');
    await writeFile(path.join(directory, 'data.txt'), 'original'); await writeFile(path.join(directory, 'extra.mjs'), 'export const extra = true;');
    const added = runNode(['--input-type=module', '-e', script]); expect(added.status).not.toBe(0); expect(added.stderr).toContain('file set does not match');
  });

  it('refuses dependency links outside the package even when the link map is checksummed', async () => {
    const parent = await fixture(); const directory = path.join(parent, 'artifact'); await mkdir(directory);
    const outside = path.join(parent, 'checkout-module.mjs'); await writeFile(outside, 'export const borrowed = true;');
    await symlink(outside, path.join(directory, 'module.mjs'));
    const links = JSON.stringify([{ path: 'module.mjs', target: outside }]) + '\n'; await writeFile(path.join(directory, 'LINKS.json'), links);
    await writeFile(path.join(directory, 'SHA256SUMS'), `${sha(links)}  LINKS.json\n`);
    const script = `import {verifyPackage} from ${JSON.stringify(smokeImport)}; await verifyPackage(${JSON.stringify(directory)});`;
    const processResult = runNode(['--input-type=module', '-e', script]);
    expect(processResult.status).not.toBe(0); expect(processResult.stderr).toContain('outside independent package');
  });
});
