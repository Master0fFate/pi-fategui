import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { ProtocolFault, safeError, type ErrorCode } from '../../shared/protocol/errors';
import { responseEnvelopeSchema, type ProtocolResponse } from '../../shared/protocol/envelopes';
import { executeAdminMethod } from '../admin/adminMethods';
import type { ProviderAdminPort } from '../admin/providerMethods';
import type { RedactedLog } from '../logging/RedactedLog';
import type { Diagnostic } from '../../shared/protocol/diagnostics';
import type { AuthService, BrowserPrincipal, ClientPrincipal } from '../auth/AuthService';
import { apiPath, boundedJsonBody, boundedTextBody, guardRequest, oneHeader, type HttpGuardConfig } from './requestGuards';
import { createStaticAssetHandler } from './staticAssets';

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CONNECTIONS = 8;

export interface HttpServiceOptions {
  readonly auth: AuthService;
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly profileId: string;
  readonly allowedOrigins?: readonly string[];
  readonly serverEpoch: string;
  readonly ready: () => boolean;
  readonly logger?: RedactedLog;
  /** Host composition only; never accepted from request JSON. */
  readonly providerAdmin?: ProviderAdminPort;
  /** Trusted host opt-in only. Never a workspace or a request-supplied path. */
  readonly staticDirectory?: string;
  readonly onCommand?: (body: string, principal: AuthenticatedPrincipal, ticket: string, origin: string | null) => Promise<ProtocolResponse>;
  readonly onUpgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer,
    config: HttpGuardConfig, cookieName: string) => void;
}
export interface HttpService {
  readonly port: number;
  readonly server: Server;
  stop(): Promise<void>;
}
export type AuthenticatedPrincipal = BrowserPrincipal | ClientPrincipal;

function respond(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  if (body === undefined || Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) throw new ProtocolFault('RESULT_TOO_LARGE');
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", ...headers });
  response.end(body);
}
function refusal(response: ServerResponse, error: unknown): void {
  if (response.headersSent) { response.destroy(); return; }
  const code: ErrorCode = error instanceof ProtocolFault ? error.code : 'INTERNAL_ERROR';
  const status = code === 'UNAUTHENTICATED' ? 401 : code === 'FORBIDDEN' ? 403
    : code === 'INVALID_REQUEST' ? 400 : code === 'BUSY' ? 429 : 503;
  respond(response, status, { error: safeError(code) });
}
function bearer(request: IncomingMessage): string | null {
  const authorization = oneHeader(request, 'authorization');
  if (!authorization) return null;
  const match = /^Bearer (\S{1,128})$/u.exec(authorization);
  if (!match) throw new ProtocolFault('UNAUTHENTICATED');
  return match[1]!;
}
function cookieToken(request: IncomingMessage, name: string): string | null {
  const header = oneHeader(request, 'cookie');
  if (!header) return null;
  const tokens = header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => part.split('='));
  const matching = tokens.filter((parts) => parts.length === 2 && parts[0] === name);
  if (matching.length !== 1) throw new ProtocolFault('UNAUTHENTICATED');
  return matching[0]![1] ?? null;
}
export function authenticate(request: IncomingMessage, auth: AuthService, cookieName: string): { principal: AuthenticatedPrincipal; sessionToken: string | null } {
  const token = bearer(request);
  const cookie = cookieToken(request, cookieName);
  // A native key cannot be combined with a browser cookie to bypass Origin/CSRF.
  if (token && cookie) throw new ProtocolFault('FORBIDDEN');
  if (cookie) {
    const principal = auth.authenticateBrowser(cookie);
    if (!principal) throw new ProtocolFault('UNAUTHENTICATED');
    return { principal, sessionToken: cookie };
  }
  const principal = token && auth.authenticateClient(token);
  if (!principal) throw new ProtocolFault('UNAUTHENTICATED');
  return { principal, sessionToken: null };
}

/** Bind only loopback after ownership, auth-store health, and request guards are ready. */
export async function createHttpServer(options: HttpServiceOptions): Promise<HttpService> {
  if (options.host !== '127.0.0.1' || !Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) throw new ProtocolFault('INVALID_REQUEST');
  const allowed = options.allowedOrigins ?? [`http://${options.host}:${options.port}`];
  if (!allowed.length || allowed.length > 8 || allowed.some((origin) => !/^http:\/\/(?:127\.0\.0\.1|localhost):[1-9][0-9]{0,4}$/u.test(origin)
    || Number(origin.slice(origin.lastIndexOf(':') + 1)) > 65_535)) throw new ProtocolFault('INVALID_REQUEST');
  const allowedHosts = new Set([`${options.host}:${options.port}`, ...allowed.map((origin) => new URL(origin).host)]);
  const config: HttpGuardConfig = { host: options.host, port: options.port, allowedOrigins: new Set(allowed), allowedHosts };
  const cookieName = `fate_${createHash('sha256').update(options.profileId).digest('hex').slice(0, 16)}_session`;
  const staticAssets = options.staticDirectory === undefined ? null : await createStaticAssetHandler(options.staticDirectory);
  const cookies = new Set<Socket>();
  const server = createServer((request, response) => {
    const started = Date.now();
    const route: Diagnostic['method'] = request.url === '/healthz' ? 'health'
      : request.url === '/api/auth/exchange' ? 'auth.exchange'
      : request.url === '/api/auth/session' ? 'auth.session'
      : request.url === '/api/auth/logout' ? 'auth.logout'
      : request.url === '/api/admin' ? 'admin' : request.url === '/api/info' ? 'info'
      : request.url === '/api/command' ? 'command' : 'other';
    let requestId: string | null = null;
    let workspaceId: string | null = null;
    let diagnosticCode: Diagnostic['code'] | null = null;
    response.once('finish', () => { options.logger?.write({ method: route, requestId, workspaceId,
      code: diagnosticCode ?? (response.statusCode === 200 ? 'OK' : response.statusCode === 401 ? 'UNAUTHENTICATED'
        : response.statusCode === 403 ? 'FORBIDDEN' : response.statusCode === 429 ? 'BUSY'
          : response.statusCode === 400 || response.statusCode === 404 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR'),
      durationMs: Math.max(0, Date.now() - started), count: 1 }); });
    void (async () => {
      const path = apiPath(request);
      const origin = guardRequest(request, config, { browserMutation: path === '/api/auth/exchange' || path === '/api/auth/logout'
        || path === '/api/command' && oneHeader(request, 'cookie') !== null,
        ownerAdmin: path === '/api/admin' });
      if (path === '/healthz' && request.method === 'GET') {
        respond(response, 200, { ready: options.ready() });
        return;
      }
      if (!path.startsWith('/api/')) {
        if (staticAssets && (request.method === 'GET' || request.method === 'HEAD')) {
          if (!options.ready()) throw new ProtocolFault('BUSY');
          await staticAssets(path, oneHeader(request, 'host')!, response);
        } else respond(response, 404, { error: safeError('INVALID_REQUEST') });
        return;
      }
      if (!options.ready()) throw new ProtocolFault('BUSY');
      if (path === '/api/auth/exchange' && request.method === 'POST') {
        if (oneHeader(request, 'cookie') || oneHeader(request, 'authorization')) throw new ProtocolFault('FORBIDDEN');
        const body = await boundedJsonBody(request, MAX_JSON_BYTES);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !('code' in body) || typeof body.code !== 'string') throw new ProtocolFault('INVALID_REQUEST');
        const exchanged = await options.auth.exchange(body.code, request.socket.remoteAddress ?? '');
        respond(response, 200, { session: exchanged.session }, { 'Set-Cookie': `${cookieName}=${exchanged.sessionToken}; HttpOnly; SameSite=Strict; Path=/api` });
        return;
      }
      if (path === '/api/admin' && request.method === 'POST') {
        const ownerCredential = bearer(request);
        if (!ownerCredential) throw new ProtocolFault('UNAUTHENTICATED');
        // Authentication is evaluated before parsing admin payloads. The method catalog is fixed.
        options.auth.authorizeAdmin({ ownerCredential, origin, cookiePresented: oneHeader(request, 'cookie') !== null });
        const result = await executeAdminMethod(options.auth, { ownerCredential, origin, cookiePresented: false },
          await boundedJsonBody(request, MAX_JSON_BYTES), options.providerAdmin);
        respond(response, 200, result);
        return;
      }
      if (path === '/api/auth/session' && request.method === 'GET') {
        if (bearer(request)) throw new ProtocolFault('FORBIDDEN');
        const token = cookieToken(request, cookieName);
        if (!token) throw new ProtocolFault('UNAUTHENTICATED');
        respond(response, 200, { session: options.auth.sessionInfo(token) });
        return;
      }
      if (path === '/api/auth/logout' && request.method === 'POST') {
        if (bearer(request)) throw new ProtocolFault('FORBIDDEN');
        const token = cookieToken(request, cookieName);
        if (!token) throw new ProtocolFault('UNAUTHENTICATED');
        await options.auth.logout(token, oneHeader(request, 'x-fate-csrf') ?? '');
        respond(response, 200, { loggedOut: true }, { 'Set-Cookie': `${cookieName}=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0` });
        return;
      }
      if (path === '/api/info' && request.method === 'GET') {
        const { principal } = authenticate(request, options.auth, cookieName);
        respond(response, 200, { protocol: 1, serverEpoch: options.serverEpoch, serverTime: Date.now(),
          kind: principal.kind, capabilities: ['host.info', 'workspace.list'], workspaceCount: principal.workspaceRoots.length });
        return;
      }
      if (path === '/api/command' && request.method === 'POST') {
        if (!options.onCommand) throw new ProtocolFault('DISPATCH_DISABLED');
        const { principal, sessionToken } = authenticate(request, options.auth, cookieName);
        if (sessionToken) options.auth.assertBrowserCsrf(sessionToken, oneHeader(request, 'x-fate-csrf') ?? '');
        const ticket = oneHeader(request, 'x-fate-client-ticket');
        if (!ticket) throw new ProtocolFault('UNAUTHENTICATED');
        const result = responseEnvelopeSchema.parse(await options.onCommand(await boundedTextBody(request, MAX_JSON_BYTES), principal, ticket, origin));
        requestId = result.requestId;
        workspaceId = result.scope?.workspaceId ?? null;
        diagnosticCode = result.ok ? 'OK' : result.error.code;
        respond(response, 200, result);
        return;
      }
      respond(response, 404, { error: safeError('INVALID_REQUEST') });
    })().catch((error: unknown) => {
      diagnosticCode = error instanceof ProtocolFault ? error.code : 'INTERNAL_ERROR';
      try { refusal(response, error); } catch { response.destroy(); }
    });
  });
  server.on('upgrade', (request, socket, head) => {
    if (!options.onUpgrade) { socket.destroy(); return; }
    try { options.onUpgrade(request, socket, head, config, cookieName); }
    catch { socket.destroy(); }
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.on('connection', (socket) => { cookies.add(socket); socket.on('close', () => { cookies.delete(socket); }); });
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(options.port, options.host);
    });
    const bound = server.address() as AddressInfo | null;
    if (!bound || bound.address !== options.host || bound.port !== options.port) throw new Error('Loopback listener address changed.');
    return { server, port: bound.port, stop: async () => {
      // Close any live sockets before releasing the core's profile-owner lock.
      for (const socket of cookies) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } };
  } catch (error) {
    for (const socket of cookies) socket.destroy();
    server.close();
    throw error;
  }
}
