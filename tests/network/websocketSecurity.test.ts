import { createServer as createNetServer } from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createFateCore } from '../../src/core/createFateCore';
import { ownerCredentialPath } from '../../src/server/auth/AuthStore';
import { startAuthenticatedNodeServerWithFactory } from '../../src/server/http/startAuthenticatedNodeServer';
import { FakePiSdkAdapter } from '../v2/helpers/fakePi';
import { MultiProjectPiRuntime } from '../../src/main/pi/MultiProjectPiRuntime';
import { privateTestRoot } from '../v2/helpers/isolatedEnvironment';

const roots: string[] = [];
async function freePort(): Promise<number> {
  const probe = createNetServer();
  return new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    if (!address || typeof address === 'string') { probe.close(); reject(new Error('No port')); return; }
    probe.close(() => resolve(address.port));
  }).once('error', reject));
}
async function fixture(terminal = false) {
  const root = await fs.mkdtemp(path.join(privateTestRoot(), 'ws-security-'));
  roots.push(root);
  const home = path.join(root, 'home'); const workspace = path.join(root, 'workspace');
  await fs.mkdir(home); await fs.mkdir(workspace);
  const port = await freePort();
  const adapter = new FakePiSdkAdapter();
  const server = await startAuthenticatedNodeServerWithFactory({ profile: { profileId: 'ws', home }, workspaces: [workspace],
    host: '127.0.0.1', port, flags: { terminal, ...(terminal ? { terminalWarningAccepted: true } : {}), browser: false } },
  (options) => createFateCore({ ...options, adapter,
    createRuntime: (deps) => new MultiProjectPiRuntime({ ...deps,
      createSessionTitleGenerator: () => ({ generate: async () => null }) }) }));
  const url = `http://127.0.0.1:${port}`;
  const owner = await fs.readFile(ownerCredentialPath(server.core.paths), 'utf8');
  const code = await server.auth.createBootstrapCode(owner);
  const exchange = await fetch(`${url}/api/auth/exchange`, { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code.code }) });
  expect(exchange.status).toBe(200);
  const cookie = exchange.headers.get('set-cookie')?.split(';')[0];
  const body = await exchange.json() as { session: { csrfToken: string; sessionId: string } };
  if (!cookie) throw new Error('Missing test cookie');
  return { server, adapter, url, cookie, csrf: body.session.csrfToken, sessionId: body.session.sessionId, workspace };
}
function firstMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No first frame')), 3_000);
    socket.once('message', (bytes) => { clearTimeout(timeout); try { resolve(JSON.parse(bytes.toString('utf8')) as unknown); } catch (error) { reject(error); } });
  });
}
function closed(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket was not closed')), 3_000);
    socket.once('close', () => { clearTimeout(timeout); resolve(); });
  });
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }))); });

describe('AUTH-04 authenticated event sockets', () => {
  it('does not issue a ticket before browser CSRF and revokes it on disconnect', async () => {
    const { server, adapter, url, cookie, csrf, sessionId } = await fixture();
    const wsUrl = `${url.replace('http:', 'ws:')}/api/events`;
    const socket = new WebSocket(wsUrl, { headers: { Cookie: cookie, Origin: url }, perMessageDeflate: false });
    try {
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      expect(server.tickets).toBeDefined();
      const ready = firstMessage(socket);
      socket.send(JSON.stringify({ protocol: 1, type: 'hello', csrf }));
      const frame = await ready as { type: string; ticket: string; clientId: string; serverEpoch: string };
      expect(frame.type).toBe('ready');
      const principal = server.auth.authenticateBrowser(cookie.split('=')[1] ?? '');
      expect(principal?.sessionId).toBe(sessionId);
      if (!principal) throw new Error('No browser principal');
      expect(server.tickets.verify(frame.ticket, principal, frame.serverEpoch, url).clientId).toBe(frame.clientId);
      const completion = closed(socket);
      socket.close(); await completion;
      await expect.poll(() => {
        try { server.tickets.verify(frame.ticket, principal, frame.serverEpoch, url); return false; }
        catch { return true; }
      }).toBe(true);
    } finally { socket.terminate(); expect((await server.stop()).status).toBe('settled'); await adapter.dispose(); }
  });
  it('refuses manual terminal frames when the host capability is off', async () => {
    const { server, adapter, url, cookie, csrf } = await fixture();
    const socket = new WebSocket(`${url.replace('http:', 'ws:')}/api/events`, { headers: { Cookie: cookie, Origin: url } });
    try {
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      const ready = firstMessage(socket);
      socket.send(JSON.stringify({ protocol: 1, type: 'hello', csrf }));
      expect((await ready as { type: string }).type).toBe('ready');
      const completion = closed(socket);
      socket.send(JSON.stringify({ protocol: 1, type: 'terminal.create', workspaceId: crypto.randomUUID(),
        workspaceGeneration: 0, controlGeneration: 0, cols: 80, rows: 24 }));
      await completion;
    } finally { socket.terminate(); expect((await server.stop()).status).toBe('settled'); await adapter.dispose(); }
  });
  it('binds an enabled terminal frame to the live socket; guessed IDs cannot write', async () => {
    const { server, adapter, url, cookie, csrf } = await fixture(true);
    const socket = new WebSocket(`${url.replace('http:', 'ws:')}/api/events`, { headers: { Cookie: cookie, Origin: url } });
    try {
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      const ready = firstMessage(socket);
      socket.send(JSON.stringify({ protocol: 1, type: 'hello', csrf }));
      expect((await ready as { type: string }).type).toBe('ready');
      const completion = closed(socket);
      socket.send(JSON.stringify({ protocol: 1, type: 'terminal.write', id: crypto.randomUUID(), data: 'not authorized' }));
      await completion;
    } finally { socket.terminate(); expect((await server.stop()).status).toBe('settled'); await adapter.dispose(); }
  });
  it('rejects cookie sockets without the CSRF first frame and refuses foreign origins', async () => {
    const { server, adapter, url, cookie } = await fixture();
    const wsUrl = `${url.replace('http:', 'ws:')}/api/events`;
    const hostile = new WebSocket(wsUrl, { headers: { Cookie: cookie, Origin: 'http://evil.example' } });
    let bad: WebSocket | null = null;
    try {
      const denial = new Promise<void>((resolve) => { hostile.once('error', () => resolve()); hostile.once('close', () => resolve()); });
      await denial;
      bad = new WebSocket(wsUrl, { headers: { Cookie: cookie, Origin: url } });
      await new Promise<void>((resolve, reject) => { bad!.once('open', resolve); bad!.once('error', reject); });
      const completion = closed(bad);
      bad.send(JSON.stringify({ protocol: 1, type: 'subscribe', workspaceId: crypto.randomUUID(), workspaceGeneration: 1 }));
      await completion;
      expect(server.core.events.subscriberCount).toBe(0);
    } finally { hostile.terminate(); bad?.terminate(); expect((await server.stop()).status).toBe('settled'); await adapter.dispose(); }
  });
});
