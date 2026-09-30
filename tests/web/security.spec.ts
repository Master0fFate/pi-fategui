import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import WebSocket from 'ws';
import { test, expect, object } from './fixture';

async function rawHttp(port: number, headers: Record<string, string>, method = 'GET', path = '/api/info', body?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, method, headers, agent: false }, (response) => {
      response.resume(); response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.setTimeout(5_000, () => request.destroy(new Error('Raw HTTP guard probe timed out.')));
    request.once('error', reject); request.end(body);
  });
}
async function rejectedHandshake(port: number, headers: Record<string, string>): Promise<{ opened: boolean; received: number }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/events`, { headers, perMessageDeflate: false });
    let opened = false;
    let received = 0;
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Rejected WebSocket did not close within its finite probe.')); }, 5_000);
    socket.on('open', () => { opened = true; socket.close(); });
    socket.on('message', () => { received++; });
    socket.on('error', () => { /* The guarded server deliberately destroys invalid upgrades. */ });
    socket.on('close', () => { clearTimeout(timer); resolve({ opened, received }); });
  });
}
async function rejectedFirstFrame(port: number, headers: Record<string, string>, frame: object): Promise<{ opened: boolean; ready: boolean; code: number }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/events`, { headers, perMessageDeflate: false });
    let opened = false;
    let ready = false;
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Invalid authenticated first frame did not close.')); }, 6_000);
    socket.on('open', () => { opened = true; socket.send(JSON.stringify(frame)); });
    socket.on('message', (bytes) => { if (object(JSON.parse(bytes.toString())).type === 'ready') ready = true; });
    socket.on('error', () => { /* Closure is asserted below, not treated as a passing assertion alone. */ });
    socket.on('close', (code) => { clearTimeout(timer); resolve({ opened, ready, code }); });
  });
}

test('real HTTP and WebSocket guards reject unauthorized, hostile/null/missing Origin, wrong Host and cookie-only impersonation', async ({ host, browser }) => {
  const client = await host.login();
  const anonymous = await browser.newContext({ baseURL: host.origin, serviceWorkers: 'block' });
  try {
    for (const endpoint of ['/api/info', '/api/auth/session']) expect((await anonymous.request.get(endpoint)).status()).toBe(401);
    expect((await anonymous.request.post('/api/command', { headers: { Origin: host.origin }, data: { protocol: 1 } })).status()).toBe(401);
    const cookie = (await client.context.cookies(`${host.origin}/api/auth/session`)).map((entry) => `${entry.name}=${entry.value}`).join('; ');
    expect(cookie).not.toBe('');
    const recovered = await client.context.request.get('/api/auth/session');
    expect(recovered.headers()['cache-control']).toContain('no-store');
    const session = object(object(await recovered.json()).session);
    expect(session).toMatchObject({ sessionId: client.sessionId, csrfToken: client.csrf });
    const nativeBody = JSON.stringify({ protocol: 1, requestId: randomUUID(), serverEpoch: host.ready.serverEpoch,
      issuedAt: Date.now(), method: 'host.info', input: {} });
    const backendHost = `127.0.0.1:${host.ready.port}`;
    // Probe the listener directly for Host checks. The fault proxy correctly
    // rewrites Host for forwarding and must not manufacture these rejections.
    expect(await rawHttp(host.ready.port, { Host: 'evil.example', Origin: host.origin })).toBe(403);
    for (const origin of ['http://evil.example', 'null']) {
      expect(await rawHttp(host.ready.port, { Host: backendHost, Origin: origin, Cookie: cookie })).toBe(403);
      expect(await rawHttp(host.ready.port, { Host: backendHost, Origin: origin, Cookie: cookie,
        'Content-Type': 'application/json', 'X-Fate-Csrf': client.csrf }, 'POST', '/api/command', nativeBody)).toBe(403);
      expect(await rejectedHandshake(host.ready.port, { Host: backendHost, Origin: origin, Cookie: cookie }))
        .toEqual({ opened: false, received: 0 });
    }
    expect(await rawHttp(host.ready.port, { Host: backendHost, Cookie: cookie, 'Content-Type': 'application/json',
      'X-Fate-Csrf': client.csrf }, 'POST', '/api/command', nativeBody)).toBe(403);
    const captured = host.captured(client, 'workspace.snapshot');
    const ticket = captured.headers['x-fate-client-ticket'];
    if (typeof ticket !== 'string') throw new Error('Actual event client ticket was not captured.');
    const withoutCsrf = await client.context.request.post('/api/command', { headers: { Origin: host.origin,
      'X-Fate-Client-Ticket': ticket }, data: JSON.parse(nativeBody) });
    expect(withoutCsrf.status()).toBe(403);
    // Missing Origin cannot turn a cookie into native bearer authority.
    expect(await rejectedHandshake(host.ready.port, { Host: backendHost, Cookie: cookie })).toEqual({ opened: false, received: 0 });
    expect(await rejectedHandshake(host.ready.port, { Host: backendHost, Origin: host.origin })).toEqual({ opened: false, received: 0 });
    expect(await rejectedHandshake(host.ready.port, { Host: 'evil.example', Origin: host.origin, Cookie: cookie })).toEqual({ opened: false, received: 0 });
    expect(await rejectedFirstFrame(host.ready.port, { Host: backendHost, Origin: host.origin, Cookie: cookie },
      { protocol: 1, type: 'hello' })).toEqual({ opened: true, ready: false, code: 1008 });
    expect(await rejectedFirstFrame(host.ready.port, { Host: backendHost, Origin: host.origin, Cookie: cookie },
      { protocol: 1, type: 'hello', csrf: 'fx1_invalid' })).toEqual({ opened: true, ready: false, code: 1008 });
    const admin = await client.context.request.post('/api/admin', { headers: { Origin: host.origin, 'X-Fate-Csrf': client.csrf }, data: {} });
    expect(admin.status()).toBe(403);
    const reused = await anonymous.request.post('/api/auth/exchange', { headers: { Origin: host.origin }, data: { code: client.code } });
    expect(reused.status()).toBe(401);
    // Traversal/query refusal must not accidentally expose either workspace.
    expect((await anonymous.request.get('/?code=never-retain-this')).status()).toBe(400);
    expect((await anonymous.request.get('/sentinel.txt')).status()).toBe(404);
    expect((await anonymous.request.get('/api/does-not-exist', { headers: { Origin: host.origin } })).status()).toBe(404);
    expect(host.proxy.commands.filter((entry) => entry.method === 'runtime.prompt')).toHaveLength(0);
    expect((await host.inspect()).sentinel).toBe(host.repositories.before.a.sentinel);
  } finally { await anonymous.close(); }
});

test('confirmed browser logout revokes the actual cookie and event authorization rather than merely closing its UI', async ({ host }) => {
  const client = await host.login();
  const cookie = (await client.context.cookies(`${host.origin}/api/auth/session`)).map((entry) => `${entry.name}=${entry.value}`).join('; ');
  await client.page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(client.page.getByLabel('One-time code')).toBeVisible();
  expect((await client.context.request.get('/api/auth/session')).status()).toBe(401);
  expect(await rawHttp(host.ready.port, { Host: `127.0.0.1:${host.ready.port}`, Origin: host.origin, Cookie: cookie })).toBe(401);
  expect(await rejectedHandshake(host.ready.port, { Host: `127.0.0.1:${host.ready.port}`, Origin: host.origin, Cookie: cookie }))
    .toEqual({ opened: false, received: 0 });
  expect((await host.inspect()).invocations.filter((entry) => entry.kind === 'prompt')).toHaveLength(0);
});
