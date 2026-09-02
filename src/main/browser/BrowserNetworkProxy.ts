import { createServer, request as requestHttp, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { connect as connectTcp, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { BrowserPolicy } from './BrowserPolicy';
import { isCloudMetadataHostname, isLoopbackHostname, isPrivateNetworkHostname } from './BrowserPolicy';

const DNS_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PROXY_URL_LENGTH = 8_192;

interface ResolvedTarget {
  url: URL;
  addresses: string[];
  port: number;
}

type BrowserHostResolver = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

type PrivateNetworkAuthorizer = (origin: string) => boolean;

/**
 * A loopback-only explicit proxy that resolves each destination itself and
 * connects to the vetted address. Chromium never performs a second, unpinned
 * DNS lookup, so a hostname cannot rebind to loopback or cloud metadata after
 * Fate's policy check.
 */
export class BrowserNetworkProxy {
  private readonly server = createServer((request, response) => {
    void this.forwardHttp(request, response).catch((error) => denyHttp(response, error));
  });
  private readonly controller = new AbortController();
  private readonly sockets = new Set<Socket>();
  private startPromise: Promise<string> | null = null;
  private proxyUrl: string | null = null;

  constructor(
    private readonly policy: BrowserPolicy,
    private readonly allowsPrivateNetwork: PrivateNetworkAuthorizer = () => false,
  ) {
    this.server.maxConnections = 256;
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = REQUEST_TIMEOUT_MS;
    this.server.on('connection', (socket) => this.track(socket));
    this.server.on('connect', (request, client, head) => {
      const socket = client as Socket;
      this.track(socket);
      void this.openTunnel(request.url ?? '', socket, head).catch((error) => {
        if (!socket.destroyed) socket.end(proxySocketError(error));
      });
    });
    this.server.on('upgrade', (request, client, head) => {
      const socket = client as Socket;
      this.track(socket);
      void this.forwardWebSocket(request, socket, head).catch((error) => {
        if (!socket.destroyed) socket.end(proxySocketError(error));
      });
    });
  }

  start(): Promise<string> {
    if (this.proxyUrl) return Promise.resolve(this.proxyUrl);
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<string>((resolve, reject) => {
      const failed = (error: Error) => {
        this.startPromise = null;
        reject(error);
      };
      this.server.once('error', failed);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', failed);
        const address = this.server.address() as AddressInfo | null;
        if (!address) {
          this.startPromise = null;
          reject(new Error('The browser safety proxy could not bind to loopback.'));
          return;
        }
        this.proxyUrl = `http://127.0.0.1:${address.port}`;
        resolve(this.proxyUrl);
      });
    });
    return this.startPromise;
  }

  resetConnections(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  dispose(): void {
    this.controller.abort();
    this.resetConnections();
    try { this.server.close(); } catch { /* It may be disposed before listen completes. */ }
  }

  private async forwardHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.controller.signal.aborted || !request.url || request.url.length > MAX_PROXY_URL_LENGTH) throw new Error('Proxy closed.');
    const parsed = new URL(request.url);
    if (parsed.protocol !== 'http:' || parsed.username || parsed.password) throw new Error('Only credential-free HTTP proxy requests are accepted.');
    const target = await resolveTarget(parsed, this.policy, this.controller.signal, undefined, this.allowsPrivateNetwork);
    const address = target.addresses[0];
    if (!address) throw new Error('No approved destination address.');
    const headers = safeForwardHeaders(request.headers, parsed.host);
    await new Promise<void>((resolve, reject) => {
      const upstream = requestHttp({
        host: address,
        family: isIP(address),
        port: target.port,
        method: request.method,
        path: `${parsed.pathname}${parsed.search}`,
        headers,
        signal: this.controller.signal,
        timeout: REQUEST_TIMEOUT_MS,
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers);
        upstreamResponse.pipe(response);
        upstreamResponse.once('end', resolve);
        upstreamResponse.once('error', reject);
      });
      upstream.once('socket', (socket) => this.track(socket));
      upstream.once('timeout', () => upstream.destroy(new Error('Browser proxy request timed out.')));
      upstream.once('error', reject);
      request.once('aborted', () => upstream.destroy(new Error('Browser request aborted.')));
      request.pipe(upstream);
    });
  }

  private async forwardWebSocket(request: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    if (this.controller.signal.aborted || request.method !== 'GET' || !request.url || request.url.length > MAX_PROXY_URL_LENGTH) {
      throw new Error('Invalid WebSocket proxy request.');
    }
    const parsed = new URL(request.url);
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    if (parsed.protocol !== 'http:' || parsed.username || parsed.password || request.headers.upgrade?.toLowerCase() !== 'websocket') {
      throw new Error('Only credential-free WebSocket upgrades are accepted.');
    }
    const target = await resolveTarget(parsed, this.policy, this.controller.signal, undefined, this.allowsPrivateNetwork);
    const upstream = await this.connectFirst(target.addresses, target.port);
    this.track(upstream);
    if (this.controller.signal.aborted || client.destroyed) {
      upstream.destroy();
      throw new Error('Proxy closed.');
    }
    const headers = safeForwardHeaders(request.headers, parsed.host);
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    upstream.write(serializeUpgradeRequest(`${parsed.pathname}${parsed.search}`, headers));
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => {
      if (!client.destroyed) client.end();
    });
  }

  private async openTunnel(authority: string, client: Socket, head: Buffer): Promise<void> {
    if (this.controller.signal.aborted || !authority || authority.length > 2_048) throw new Error('Proxy closed.');
    const parsed = new URL(`https://${authority}`);
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('Invalid CONNECT authority.');
    const target = await resolveTarget(parsed, this.policy, this.controller.signal, undefined, this.allowsPrivateNetwork);
    const upstream = await this.connectFirst(target.addresses, target.port);
    this.track(upstream);
    if (this.controller.signal.aborted || client.destroyed) {
      upstream.destroy();
      throw new Error('Proxy closed.');
    }
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
  }

  private async connectFirst(addresses: readonly string[], port: number): Promise<Socket> {
    let lastError: unknown;
    for (const address of addresses) {
      if (this.controller.signal.aborted) break;
      try {
        return await new Promise<Socket>((resolve, reject) => {
          const socket = connectTcp({ host: address, port, family: isIP(address) });
          this.track(socket);
          const timeout = setTimeout(() => socket.destroy(new Error('Browser proxy connection timed out.')), CONNECT_TIMEOUT_MS);
          timeout.unref?.();
          const failed = (error: Error) => {
            clearTimeout(timeout);
            reject(error);
          };
          socket.once('error', failed);
          socket.once('connect', () => {
            clearTimeout(timeout);
            socket.removeListener('error', failed);
            resolve(socket);
          });
        });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error('No approved browser address was reachable.');
  }

  private track(socket: Socket): void {
    if (this.sockets.has(socket)) return;
    this.sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => this.sockets.delete(socket));
  }
}

export async function resolveTarget(
  url: URL,
  policy: BrowserPolicy,
  signal?: AbortSignal,
  resolve: BrowserHostResolver = lookup as BrowserHostResolver,
  allowsPrivateNetwork: PrivateNetworkAuthorizer = () => false,
): Promise<ResolvedTarget> {
  if (signal?.aborted) throw new DOMException('Browser proxy resolution aborted.', 'AbortError');
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  if (isCloudMetadataHostname(hostname)) throw new Error('Cloud metadata endpoints are blocked.');
  const decision = policy.inspectUrl(url.href);
  const origin = decision.origin ?? url.origin;
  const privateNetworkAllowed = policy.allowsPrivateNetworkForOrigin(origin) || allowsPrivateNetwork(origin);
  if ((!decision.allowed && !(decision.privateNetwork && privateNetworkAllowed)) || !origin) throw new Error(decision.reason);
  const resolved = isIP(hostname)
    ? [{ address: hostname }]
    : await withTimeout(resolve(hostname, { all: true, verbatim: true }), DNS_TIMEOUT_MS, signal);
  const addresses = [...new Set(resolved.map(({ address }) => address.toLowerCase()))];
  if (!isIP(hostname) && isLoopbackHostname(hostname)) {
    for (const extra of ['127.0.0.1', '::1']) if (!addresses.includes(extra)) addresses.push(extra);
    addresses.sort((left, right) => Number(isIP(right) === 4) - Number(isIP(left) === 4));
  }
  if (addresses.length === 0 || addresses.some((address) => isCloudMetadataHostname(address))) {
    throw new Error('The browser destination did not resolve to an approved address.');
  }
  const privateAddress = addresses.some((address) => isPrivateNetworkHostname(address));
  if (privateAddress && !isLoopbackHostname(hostname) && !privateNetworkAllowed) {
    throw new Error('The browser destination resolved to a private address without permission. Open it in the built-in browser address bar, then press “Allow agent” on the access strip, or switch the session to Full access.');
  }
  return {
    url,
    addresses,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
  };
}

function safeForwardHeaders(headers: IncomingHttpHeaders, host: string): IncomingHttpHeaders {
  const connectionTokens = new Set((headers.connection ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  const blocked = new Set(['connection', 'proxy-authorization', 'proxy-connection', 'keep-alive', 'upgrade', 'te', 'trailer', 'transfer-encoding', ...connectionTokens]);
  const result: IncomingHttpHeaders = { host };
  for (const [name, value] of Object.entries(headers)) {
    if (!blocked.has(name.toLowerCase()) && value !== undefined) result[name] = value;
  }
  return result;
}

function serializeUpgradeRequest(requestPath: string, headers: IncomingHttpHeaders): Buffer {
  const lines = [`GET ${requestPath || '/'} HTTP/1.1`];
  for (const [name, rawValue] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) throw new Error('Invalid WebSocket header name.');
    for (const value of Array.isArray(rawValue) ? rawValue : [rawValue]) {
      if (value === undefined) continue;
      const serialized = String(value);
      if (/[\r\n]/u.test(serialized)) throw new Error('Invalid WebSocket header value.');
      lines.push(`${name}: ${serialized}`);
    }
  }
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
}

function denyHttp(response: ServerResponse, error?: unknown): void {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  const { status, body } = proxyError(error);
  response.writeHead(status, { Connection: 'close', 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
  response.end(body);
}

function proxySocketError(error: unknown): string {
  const { status, body } = proxyError(error);
  return `HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Bad Gateway'}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${body}`;
}

function proxyError(error: unknown): { status: number; body: string } {
  const message = error instanceof Error ? error.message : 'Browser destination blocked by Fate UI policy.';
  const policy = /permission|credentials are blocked|protocol is blocked|Cloud metadata|not a valid url|Only credential-free|did not resolve to an approved address/iu.test(message);
  return {
    status: policy ? 403 : 502,
    body: policy ? message : `Browser destination unreachable: ${message}`,
  };
}

function withTimeout<T>(operation: Promise<T>, milliseconds: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => finish(() => reject(new Error('Browser DNS resolution timed out.'))), milliseconds);
    timeout.unref?.();
    const aborted = () => finish(() => reject(new DOMException('Browser proxy resolution aborted.', 'AbortError')));
    const finish = (settle: () => void) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', aborted);
      settle();
    };
    signal?.addEventListener('abort', aborted, { once: true });
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}
