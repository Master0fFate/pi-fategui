import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { privateTestRoot } from '../v2/helpers/isolatedEnvironment';

/** Test the emitted Node entry, not Vitest's source-module URL or an injected static path. */
describe('T39 opt-in production web entry', () => {
  it('resolves its fixed dist/web sibling, leaves the ordinary listener API-only, and protects static/API routes', async () => {
    const output = path.resolve('.test-dist', `prod-web-${randomUUID()}`);
    const privateRoot = await mkdtemp(path.join(privateTestRoot(), 'prod-web-'));
    try {
      const home = path.join(privateRoot, 'home');
      const workspace = path.join(privateRoot, 'workspace');
      const web = path.join(output, 'web');
      await Promise.all([mkdir(home), mkdir(workspace), mkdir(path.join(web, 'assets'), { recursive: true })]);
      await writeFile(path.join(web, 'index.html'), '<!doctype html><title>BUILT_WEB_ENTRY</title>');
      await writeFile(path.join(web, 'assets', 'app.js'), '/* BUILT_WEB_ASSET */');
      await writeFile(path.join(workspace, 'private.txt'), 'WORKSPACE_PRIVATE_SENTINEL');
      await build({ configFile: path.resolve('vite.server.config.ts'), build: { outDir: path.join(output, 'server'), emptyOutDir: true } });
      const entry = pathToFileURL(path.join(output, 'server', 'main.js')).href;
      const config = { profile: { profileId: 'production-web', home }, workspaces: [workspace], host: '127.0.0.1',
        port: 48219, flags: { terminal: false, browser: false }, maxPermission: 'edit' };
      const script = `import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { request } from 'node:http';
const { startAuthenticatedNodeServer, startProductionWebNodeServer } = await import(${JSON.stringify(entry)});
const workspace = ${JSON.stringify(workspace)};
process.chdir(workspace); // A cwd-relative or workspace-relative web root must fail this check.
const config = ${JSON.stringify(config)};
const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    probe.close(() => resolve(address.port));
  });
});
config.port = await freePort();
const base = 'http://127.0.0.1:' + config.port;
const get = (target, headers = {}, rawPath) => new Promise((resolve, reject) => {
  const options = rawPath ? { headers, path: rawPath } : { headers };
  const probe = request(new URL(base + target), options, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.once('end', () => resolve({ status: response.statusCode, headers: response.headers,
      body: Buffer.concat(chunks).toString('utf8') }));
  });
  probe.once('error', reject); probe.end();
});
const rejected = await Promise.allSettled([startProductionWebNodeServer({ ...config, staticDirectory: workspace })]);
assert.equal(rejected[0].status, 'rejected'); // Caller cannot replace the fixed root.
const ordinary = await startAuthenticatedNodeServer(config);
try {
  const page = await get('/');
  assert.equal(page.status, 404);
  assert.doesNotMatch(page.body, /BUILT_WEB_ENTRY/);
} finally { assert.equal((await ordinary.stop()).status, 'settled'); }
const production = await startProductionWebNodeServer(config);
try {
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.body, /BUILT_WEB_ENTRY/);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  const asset = await get('/assets/app.js');
  assert.equal(asset.status, 200);
  assert.match(asset.body, /BUILT_WEB_ASSET/);
  const privateFile = await get('/private.txt');
  assert.equal(privateFile.status, 404);
  assert.doesNotMatch(privateFile.body, /WORKSPACE_PRIVATE_SENTINEL/);
  assert.equal((await get('/', {}, '/%2e%2e/workspace/private.txt')).status, 400);
  assert.equal((await get('/', { Origin: 'http://evil.example' })).status, 403);
  const missingApi = await get('/api/nope');
  assert.equal(missingApi.status, 404);
  assert.match(missingApi.headers['content-type'], /application\\/json/);
  assert.doesNotMatch(missingApi.body, /BUILT_WEB_ENTRY/);
  for (const route of ['/api/info', '/api/auth/session']) {
    const response = await get(route);
    assert.equal(response.status, 401);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  }
} finally { assert.equal((await production.stop()).status, 'settled'); }
console.log('PRODUCTION_WEB_ENTRY_OK');`;
      // The child uses the private test environment and only fixed numeric-loopback requests.
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: workspace, encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'),
          FATE_GUI_DATA_DIR: path.join(home, '.pi', 'desktop-data') },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('PRODUCTION_WEB_ENTRY_OK');
    } finally {
      await rm(output, { recursive: true, force: true, maxRetries: 3 });
      await rm(privateRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 120_000);
});
