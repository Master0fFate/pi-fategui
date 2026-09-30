import net from 'node:net';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFateCore } from '../../src/core/createFateCore';
import { MultiProjectPiRuntime } from '../../src/main/pi/MultiProjectPiRuntime';
import { ownerCredentialPath } from '../../src/server/auth/AuthStore';
import { startAuthenticatedNodeServerWithFactory } from '../../src/server/http/startAuthenticatedNodeServer';
import { FakePiSdkAdapter } from '../v2/helpers/fakePi';
import { privateTestRoot } from '../v2/helpers/isolatedEnvironment';
import { RemoteCoreClient } from '../../src/main/connections/RemoteCoreClient';
import { createServer } from 'node:http';
import { createNativeForwardedFetch } from '../../src/main/connections/NativeForwardedHttp';

async function freePort(): Promise<number> {
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port is unavailable.');
  await new Promise<void>((resolve) => probe.close(() => resolve())); return address.port;
}

describe('real loopback relay HTTP/WS header and host-health checks; not OpenSSH acceptance', () => {
  it('rejects bodyless and redirected command responses without following another route', async () => {
    let status = 204; const urls: Array<string | undefined> = [];
    const server = createServer((request, response) => { urls.push(request.url); response.writeHead(status, { Location: '/different' }); response.end(); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture port is unavailable.');
    const origin = `http://127.0.0.1:${address.port}`, send = createNativeForwardedFetch(origin, '127.0.0.1:49332');
    const input: RequestInit = { method: 'POST', body: '{}', credentials: 'omit', redirect: 'error',
      headers: { Authorization: `Bearer fc1_${'a'.repeat(43)}`, 'X-Fate-Client-Ticket': `ft1_${'b'.repeat(43)}` } };
    try {
      await expect(send(`${origin}/api/command`, input)).rejects.toThrow(/transport/u);
      status = 302; await expect(send(`${origin}/api/command`, input)).rejects.toThrow(/transport/u);
      expect(urls).toEqual(['/api/command', '/api/command']);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it('keeps the original Host guard and verifies host identity/readiness through a different local port', async () => {
    const root = await fs.mkdtemp(path.join(privateTestRoot(), 'forwarded-host-'));
    const home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
    await fs.mkdir(home, { mode: 0o700 }); await fs.mkdir(workspace, { mode: 0o700 });
    const port = await freePort(), adapter = new FakePiSdkAdapter();
    const server = await startAuthenticatedNodeServerWithFactory({ profile: { profileId: 'forwarded', home }, workspaces: [workspace],
      host: '127.0.0.1', port, flags: { terminal: false, browser: false }, maxPermission: 'edit' },
    (options) => createFateCore({ ...options, adapter,
      createRuntime: (dependencies) => new MultiProjectPiRuntime({ ...dependencies,
        createSessionTitleGenerator: () => ({ generate: async () => null }) }) }), () => undefined);
    const sockets = new Set<net.Socket>(), observedHosts: string[] = [];
    const relay = net.createServer((socket) => {
      const upstream = net.connect(port, '127.0.0.1'); sockets.add(socket); sockets.add(upstream);
      socket.once('data', (chunk: Buffer) => { const host = /\r\nHost:\s*([^\r\n]+)/iu.exec(chunk.toString('utf8'))?.[1]; if (host) observedHosts.push(host); });
      socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
      socket.on('close', () => { sockets.delete(socket); upstream.destroy(); }); upstream.on('close', () => { sockets.delete(upstream); socket.destroy(); });
      socket.pipe(upstream); upstream.pipe(socket);
    });
    relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
    const local = relay.address(); if (!local || typeof local === 'string') throw new Error('Fixture relay is unavailable.');
    const baseUrl = `http://127.0.0.1:${local.port}`, forwardedHost = `127.0.0.1:${port}`;
    const owner = await fs.readFile(ownerCredentialPath(server.core.paths), 'utf8');
    const issued = await server.auth.issueClientCredential(owner, [workspace]);
    const hostId = await fs.readFile(path.join(path.dirname(server.core.paths.dataRoot), 'host-id'), 'utf8');
    const origin = server.core.runtime.workspaceOrigin(workspace); if (!origin) throw new Error('Registered fixture workspace is unavailable.');
    const client = new RemoteCoreClient({ id: randomUUID(), approved: true, label: 'Fixture host', hostId, baseUrl,
      credentialRef: path.join(root, 'unused-fixture-reference') }, issued.credential, 1, () => undefined, [], {
      forwardedHost, handshake: { hostId, ...origin }, outcomeStorage: true, saveOutcomes: async () => undefined,
    });
    try {
      // The relay's port remains unauthorized. This is the unchanged real Host guard.
      expect((await fetch(`${baseUrl}/healthz`)).status).toBe(403);
      await client.connect(() => true); expect(client.state.status).toBe('observing');
      expect(client.state.scope).toMatchObject({ ...origin, hostId, serverEpoch: server.serverEpoch });
      expect(client.state.providerStatus).toBe('auth-required');
      expect(observedHosts.filter((value) => value === forwardedHost).length).toBeGreaterThanOrEqual(2);
      const journal = path.join(server.core.paths.dataRoot, 'commands', 'v1');
      await fs.mkdir(journal, { recursive: true, mode: 0o700 }); await fs.writeFile(path.join(journal, 'unknown.json'), '{}', { mode: 0o600 });
      const unhealthy = new RemoteCoreClient({ ...client.profile, id: randomUUID() }, issued.credential, 2, () => undefined, [], {
        forwardedHost, handshake: { hostId, ...origin }, outcomeStorage: true, saveOutcomes: async () => undefined,
      });
      try { await unhealthy.connect(() => true); expect(unhealthy.state.message).toBe('profile-unhealthy'); expect(unhealthy.state.scope).toBeNull(); }
      finally { unhealthy.close(); await fs.rm(path.join(journal, 'unknown.json')); }
    } finally {
      client.close(); for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      expect((await server.stop()).status).toBe('settled'); await adapter.dispose(); await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
