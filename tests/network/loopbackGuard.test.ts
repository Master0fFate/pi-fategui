import http from 'node:http';
import net from 'node:net';
import { expect, it } from 'vitest';

it('permits actual numeric loopback through Node normalized connect arguments without permitting any other destination', async () => {
  const server = http.createServer((_request, response) => response.end('private-loopback'));
  const sockets = new Set<net.Socket>();
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No numeric loopback listener.');
    for (const connect of [() => net.createConnection(address.port, '127.0.0.1'),
      () => net.createConnection({ port: address.port, host: '127.0.0.1' })]) {
      const client = connect();
      try {
        await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
        expect(client.remoteAddress).toBe('127.0.0.1');
      } finally { client.destroy(); }
    }
    const body = await new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${address.port}/`, (response) => {
        let text = ''; response.setEncoding('utf8'); response.on('data', (chunk: string) => { text += chunk; });
        response.once('end', () => resolve(text)); response.once('error', reject);
      }).once('error', reject);
    });
    expect(body).toBe('private-loopback');
    for (const host of ['localhost', '::1', '0.0.0.0', 'provider.invalid', '192.0.2.1']) {
      expect(() => net.createConnection(address.port, host)).toThrow('NETWORK_TEST_OUTBOUND_BLOCKED');
      expect(() => net.createConnection({ port: address.port, host })).toThrow('NETWORK_TEST_OUTBOUND_BLOCKED');
      if (host !== '::1') {
        expect(() => http.get(`http://${host}:${address.port}/`)).toThrow('NETWORK_TEST_OUTBOUND_BLOCKED');
        expect(() => http.request(new URL(`http://${host}:${address.port}/`))).toThrow('NETWORK_TEST_OUTBOUND_BLOCKED');
      }
    }
    expect(() => net.createConnection({ path: 'unapproved-socket' })).toThrow('NETWORK_TEST_OUTBOUND_BLOCKED');
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
