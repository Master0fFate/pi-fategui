import { createServer, request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserNetworkProxy, resolveTarget } from './BrowserNetworkProxy';
import { BrowserPolicy } from './BrowserPolicy';

const disposables: Array<() => void> = [];
afterEach(() => {
  while (disposables.length) disposables.pop()?.();
});

function interactivePolicy(): BrowserPolicy {
  const policy = new BrowserPolicy();
  policy.beginTask('network-test');
  return policy;
}

describe('BrowserNetworkProxy', () => {
  it('rejects a public hostname that resolves to a private address without an explicit grant', async () => {
    const policy = interactivePolicy();
    const resolver = async () => [{ address: '127.0.0.1', family: 4 as const }];
    await expect(resolveTarget(new URL('https://rebind.example/'), policy, undefined, resolver)).rejects.toThrow(/private address/u);

    policy.setGrant({
      origin: 'https://rebind.example', read: true, interact: false, scope: 'task', allowPrivateNetwork: true,
    });
    await expect(resolveTarget(new URL('https://rebind.example/'), policy, undefined, resolver)).resolves.toMatchObject({
      addresses: ['127.0.0.1'], port: 443,
    });
  });

  it('permits a private destination only through an explicit human-navigation authorizer', async () => {
    const policy = interactivePolicy();
    await expect(resolveTarget(new URL('http://127.0.0.1:4173/'), policy)).rejects.toThrow(/origin grant/u);
    await expect(resolveTarget(
      new URL('http://127.0.0.1:4173/'),
      policy,
      undefined,
      undefined,
      (origin) => origin === 'http://127.0.0.1:4173',
    )).resolves.toMatchObject({ addresses: ['127.0.0.1'], port: 4173 });
  });

  it('keeps localhost dev-server and HMR authorities open for a Full-access session', async () => {
    const policy = interactivePolicy();
    policy.setSessionFullAccess(true);

    await expect(resolveTarget(new URL('http://127.0.0.1:5173/@vite/client'), policy)).resolves.toMatchObject({
      addresses: ['127.0.0.1'], port: 5173,
    });
  });

  it('rejects hexadecimal IPv4-mapped IPv6 private and metadata addresses', async () => {
    const policy = interactivePolicy();
    const privateResolver = async () => [{ address: '::ffff:7f00:1', family: 6 as const }];
    const metadataResolver = async () => [{ address: '::ffff:a9fe:a9fe', family: 6 as const }];

    await expect(resolveTarget(new URL('https://mapped-private.example/'), policy, undefined, privateResolver)).rejects.toThrow(/private address/u);
    await expect(resolveTarget(new URL('https://mapped-metadata.example/'), policy, undefined, metadataResolver)).rejects.toThrow(/approved address/u);
  });

  it('rejects cloud metadata addresses even when a hostname has private-network permission', async () => {
    const policy = interactivePolicy();
    policy.setGrant({
      origin: 'https://metadata-alias.example', read: true, interact: false, scope: 'task', allowPrivateNetwork: true,
    });
    const resolver = async () => [{ address: '169.254.169.254', family: 4 as const }];
    await expect(resolveTarget(new URL('https://metadata-alias.example/'), policy, undefined, resolver)).rejects.toThrow(/approved address/u);
  });

  it('forwards explicitly granted loopback HTTP through a pinned destination', async () => {
    const target = createServer((incoming, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`proxied ${incoming.url}`);
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    disposables.push(() => target.close());
    const address = target.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
    const origin = `http://127.0.0.1:${address.port}`;

    const policy = interactivePolicy();
    policy.setGrant({ origin, read: true, interact: false, scope: 'task', allowPrivateNetwork: true });
    const proxy = new BrowserNetworkProxy(policy);
    disposables.push(() => proxy.dispose());
    const proxyUrl = new URL(await proxy.start());

    const body = await new Promise<string>((resolve, reject) => {
      const outgoing = request({
        host: proxyUrl.hostname,
        port: Number(proxyUrl.port),
        path: `${origin}/fixture?safe=1`,
        method: 'GET',
      }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { text += chunk; });
        response.on('end', () => response.statusCode === 200 ? resolve(text) : reject(new Error(`Proxy returned ${response.statusCode}`)));
      });
      outgoing.on('error', reject);
      outgoing.end();
    });
    expect(body).toBe('proxied /fixture?safe=1');
  });

  it('forwards an explicitly granted plain WebSocket upgrade through the pinned proxy', async () => {
    const target = createServer();
    let requestedPath = '';
    target.on('upgrade', (incoming, socket) => {
      requestedPath = incoming.url ?? '';
      socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    disposables.push(() => target.close());
    const address = target.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
    const origin = `http://127.0.0.1:${address.port}`;

    const policy = interactivePolicy();
    policy.setGrant({ origin, read: true, interact: false, scope: 'task', allowPrivateNetwork: true });
    const proxy = new BrowserNetworkProxy(policy);
    disposables.push(() => proxy.dispose());
    const proxyUrl = new URL(await proxy.start());

    await new Promise<void>((resolve, reject) => {
      const outgoing = request({
        host: proxyUrl.hostname,
        port: Number(proxyUrl.port),
        path: `ws://127.0.0.1:${address.port}/events?channel=safe`,
        method: 'GET',
        headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
      });
      outgoing.once('upgrade', (_response, socket) => {
        socket.destroy();
        resolve();
      });
      outgoing.once('response', (response) => reject(new Error(`Proxy returned ${response.statusCode}`)));
      outgoing.once('error', reject);
      outgoing.end();
    });

    expect(requestedPath).toBe('/events?channel=safe');
  });
});
