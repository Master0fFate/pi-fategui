import { createServer as createNetServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthService } from '../../src/server/auth/AuthService';
import { createHttpServer, type HttpService } from '../../src/server/http/createHttpServer';

const fixtures: string[] = [];
const servers: HttpService[] = [];
async function freePort(): Promise<number> {
  const probe = createNetServer();
  return new Promise<number>((resolve, reject) => probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    if (!address || typeof address === 'string') { probe.close(); reject(new Error('No port')); return; }
    probe.close(() => resolve(address.port));
  }).once('error', reject));
}
async function fixture(enabled = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-web-static-'));
  fixtures.push(root);
  const built = path.join(root, 'built-web');
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(built); await fs.mkdir(workspace);
  await fs.writeFile(path.join(built, 'index.html'), '<!doctype html><title>Built app</title>');
  await fs.writeFile(path.join(built, 'app.js'), 'console.log("built")');
  await fs.mkdir(path.join(built, 'assets'));
  await fs.writeFile(path.join(built, 'assets', 'web-CuZ0_C5T.css'), 'body{color:white}');
  await fs.writeFile(path.join(workspace, 'private.txt'), 'NEVER_SERVE_WORKSPACE');
  const port = await freePort();
  const server = await createHttpServer({ auth: {} as AuthService, host: '127.0.0.1', port, profileId: 'test',
    serverEpoch: 'epoch', ready: () => true, ...(enabled ? { staticDirectory: built } : {}) });
  servers.push(server);
  return { url: `http://127.0.0.1:${port}`, built, workspace, root };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(fixtures.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('WEB-01 fixed opt-in static directory', () => {
  it('is disabled by default and never turns an API miss into HTML', async () => {
    const { url } = await fixture(false);
    const page = await fetch(url);
    expect(page.status).toBe(404);
    expect(await page.text()).not.toContain('Built app');
    const api = await fetch(`${url}/api/no-such-command`);
    expect(api.status).toBe(404);
    expect(api.headers.get('content-type')).toContain('application/json');
    expect(await api.text()).not.toContain('Built app');
    expect(api.headers.get('cache-control')).toBe('no-store');
  });

  it('serves only regular files with security headers and keeps auth responses non-cacheable', async () => {
    const { url } = await fixture();
    for (const target of ['/', '/app.js', '/assets/web-CuZ0_C5T.css']) {
      const response = await fetch(`${url}${target}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
      expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    const page = await fetch(url);
    expect(await page.text()).toContain('Built app');
    expect((await fetch(`${url}/app.js`)).headers.get('content-type')).toContain('javascript');
    const auth = await fetch(`${url}/api/auth/session`);
    expect(auth.status).toBe(401);
    expect(auth.headers.get('cache-control')).toBe('no-store');
    expect(auth.headers.get('x-content-type-options')).toBe('nosniff');
    expect(auth.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('rejects raw or encoded traversal and never serves a workspace path', async () => {
    const { url, workspace } = await fixture();
    for (const target of ['/%2e%2e/workspace/private.txt', '/%252e%252e/workspace/private.txt',
      '/%2fworkspace/private.txt', '/..%5cworkspace/private.txt', '/%ZZ', '/../workspace/private.txt']) {
      const result = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const request = httpRequest(url, { path: target }, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.once('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        request.once('error', reject);
        request.end();
      });
      expect(result.status).toBe(400);
      expect(result.body).not.toContain('NEVER_SERVE_WORKSPACE');
    }
    for (const target of ['/workspace/private.txt', '/api/nope', '/missing']) {
      const response = await fetch(`${url}${target}`);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('NEVER_SERVE_WORKSPACE');
    }
    expect(workspace).not.toContain('built-web');
  });

  it('keeps Host and Origin guards before static delivery', async () => {
    const { url } = await fixture();
    const foreignOrigin = await fetch(url, { headers: { Origin: 'http://foreign.example' } });
    expect(foreignOrigin.status).toBe(403);
    const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(url, { headers: { Host: 'foreign.example' } }, (response) => {
        response.resume(); response.once('end', () => resolve(response.statusCode));
      });
      request.once('error', reject); request.end();
    });
    expect(foreignHost).toBe(403);
  });

  it('refuses a symlink from the built tree to another file, including a workspace file', async () => {
    const { url, built, workspace } = await fixture();
    const link = path.join(built, 'private.txt');
    let target = '/private.txt';
    try {
      await fs.symlink(path.join(workspace, 'private.txt'), link);
    } catch (error) {
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      // Ordinary Windows accounts can create a directory junction without the
      // privilege required for file symlinks. This tests the same escape path.
      await fs.symlink(workspace, path.join(built, 'outside'), 'junction');
      target = '/outside/private.txt';
    }
    const response = await fetch(`${url}${target}`);
    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toContain('NEVER_SERVE_WORKSPACE');
  });
});
