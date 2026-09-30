import { createServer as createNetServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFateCore } from '../../src/core/createFateCore';
import { ownerCredentialPath } from '../../src/server/auth/AuthStore';
import { startAuthenticatedNodeServerWithFactory } from '../../src/server/http/startAuthenticatedNodeServer';
import { FakePiSdkAdapter } from '../v2/helpers/fakePi';
import { privateTestRoot } from '../v2/helpers/isolatedEnvironment';
import { MultiProjectPiRuntime } from '../../src/main/pi/MultiProjectPiRuntime';

const roots: string[] = [];
async function freePort(): Promise<number> {
  const probe = createNetServer();
  return new Promise<number>((resolve, reject) => probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    if (!address || typeof address === 'string') { probe.close(); reject(new Error('No test port')); return; }
    probe.close(() => resolve(address.port));
  }).once('error', reject));
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(privateTestRoot(), 'http-guard-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(home); await fs.mkdir(workspace);
  const port = await freePort();
  const adapter = new FakePiSdkAdapter();
  const logs: string[] = [];
  const server = await startAuthenticatedNodeServerWithFactory({ profile: { profileId: 'test', home }, workspaces: [workspace],
    host: '127.0.0.1', port, flags: { terminal: false, browser: false }, maxPermission: 'edit' },
  (options) => createFateCore({ ...options, adapter,
    createRuntime: (dependencies) => new MultiProjectPiRuntime({ ...dependencies,
      createSessionTitleGenerator: () => ({ generate: async () => null }) }) }), (entry) => { logs.push(entry); });
  const owner = await fs.readFile(ownerCredentialPath(server.core.paths), 'utf8');
  const url = `http://127.0.0.1:${port}`;
  const origin = url;
  return { server, adapter, owner, url, origin, logs }; 
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }))); });

describe('AUTH-02/AUTH-03 guarded loopback routes', () => {
  it('keeps info private, refuses foreign Host/Origin, and does not grant owner access to a client or cookie', async () => {
    const { server, adapter, owner, url, origin, logs } = await fixture();
    try {
      expect((await fetch(`${url}/healthz`)).status).toBe(200);
      expect((await fetch(`${url}/api/info`)).status).toBe(401);
      // Fetch can replace forbidden Host headers. Use the raw client to send
      // the exact malicious Host field that the server must reject.
      const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
        const req = httpRequest(new URL(`${url}/api/info`), { headers: { Host: 'evil.example' } }, (res) => {
          res.resume(); res.once('end', () => resolve(res.statusCode));
        });
        req.once('error', reject); req.end();
      });
      expect(badHostStatus).toBe(403);
      const deniedOrigin = await fetch(`${url}/api/auth/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: JSON.stringify({ code: 'not-a-code' }) });
      expect(deniedOrigin.status).toBe(403);
      const sentinel = 'FAKE_PROVIDER_SSH_OWNER_SECRET_1144';
      const rejectedSecret = await fetch(`${url}/api/auth/exchange`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ code: sentinel }) });
      expect(rejectedSecret.status).toBe(401);
      expect(await rejectedSecret.text()).not.toContain(sentinel);
      expect(logs.join('\n')).not.toContain(sentinel);
      expect(logs.some((line) => JSON.parse(line).code === 'UNAUTHENTICATED')).toBe(true);
      const ownerHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${owner}` };
      const issued = await fetch(`${url}/api/admin`, { method: 'POST', headers: ownerHeaders,
        body: JSON.stringify({ method: 'client.issue', input: { workspaceRoots: [server.readiness.host] } }) });
      // The path above is deliberately not a registered root; admin must validate host-owned scope.
      expect(issued.status).toBe(400);
      const codeResponse = await fetch(`${url}/api/admin`, { method: 'POST', headers: ownerHeaders,
        body: JSON.stringify({ method: 'auth.bootstrap.create', input: {} }) });
      expect(codeResponse.status).toBe(200);
      const codeBody = await codeResponse.json() as { result: { code: string } };
      const browser = await fetch(`${url}/api/auth/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ code: codeBody.result.code }) });
      expect(browser.status).toBe(200);
      const cookie = browser.headers.get('set-cookie');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect((await fetch(`${url}/api/admin`, { method: 'POST', headers: { ...ownerHeaders, Cookie: cookie ?? '' },
        body: JSON.stringify({ method: 'auth.status', input: {} }) })).status).toBe(403);
      expect((await fetch(`${url}/api/admin`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${codeBody.result.code}` },
        body: JSON.stringify({ method: 'auth.status', input: {} }) })).status).toBe(401);
      const noCsrf = await fetch(`${url}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie ?? '', Origin: origin } });
      expect(noCsrf.status).toBe(403);
    } finally { expect((await server.stop()).status).toBe('settled'); await adapter.dispose(); }
  });
});
