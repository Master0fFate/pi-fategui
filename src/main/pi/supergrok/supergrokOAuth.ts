import crypto from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * SuperGrok / xAI OAuth flow.
 *
 * Vendored and adapted from pi-supergrok 0.2.2 (MIT, David Cournapeau /
 * github.com/dvcrn/pi-supergrok) for Fate UI's embedded Pi SDK runtime.
 * The flow is the xAI "Grok CLI" public desktop OAuth client: OIDC discovery
 * against auth.x.ai, PKCE + state + nonce, a loopback HTTP callback server,
 * and refresh tokens packed with their token endpoint for later refreshes.
 */

export const XAI_API_BASE_URL = 'https://api.x.ai/v1';
const XAI_OAUTH_ISSUER = 'https://auth.x.ai';
const XAI_OAUTH_AUTHORIZE_URL = `${XAI_OAUTH_ISSUER}/oauth2/authorize`;
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
// Public desktop OAuth client ID used by xAI/Grok CLI style clients. Not a secret.
const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access';

const REDIRECT_HOST = '127.0.0.1';
const REDIRECT_PORT = 56121;
const REDIRECT_PATH = '/callback';
const CALLBACK_TIMEOUT_MS = 3 * 60 * 1000;
const REFRESH_SKEW_MS = 2 * 60 * 1000;
const REFRESH_PREFIX = 'xai:';
const REQUEST_TIMEOUT_MS = 15_000;

/** Minimal callback surface Fate needs from the SDK login interaction. */
export interface SuperGrokLoginCallbacks {
  readonly onAuth: (info: { url: string; instructions?: string }) => void;
  readonly onManualCodeInput?: () => Promise<string>;
  readonly signal?: AbortSignal;
}

export interface SuperGrokCredentials {
  readonly refresh: string;
  readonly access: string;
  readonly expires: number;
}

interface XaiDiscovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

interface XaiTokenPayload {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface XaiRefreshParts {
  refreshToken: string;
  tokenEndpoint?: string | undefined;
  redirectUri?: string | undefined;
}

interface OAuthListener {
  redirectUri: string;
  waitForCallback(timeoutMs: number): Promise<URL>;
  close(): Promise<void>;
}

/** Test seam: the fetch implementation used for all xAI HTTP calls. */
export type SuperGrokFetch = (url: string, init?: RequestInit) => Promise<Response>;
export const defaultSuperGrokFetch: SuperGrokFetch = (url, init) => fetch(url, init);

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function validateXaiOAuthEndpoint(url: string, field = 'endpoint'): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error(`xAI OAuth discovery returned a non-HTTPS ${field}: ${url}`);
  const host = parsed.hostname.toLowerCase();
  if (host !== 'x.ai' && !host.endsWith('.x.ai')) throw new Error(`xAI OAuth discovery ${field} host ${host} is not on xAI's origin.`);
  return url;
}

export async function discoverXaiOAuth(fetchImpl: SuperGrokFetch = defaultSuperGrokFetch): Promise<XaiDiscovery> {
  const response = await fetchImpl(XAI_OAUTH_DISCOVERY_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`xAI OIDC discovery failed with HTTP ${response.status}.`);
  const payload = (await response.json()) as Record<string, unknown>;
  const authorizationEndpoint = String(payload.authorization_endpoint ?? '').trim();
  const tokenEndpoint = String(payload.token_endpoint ?? '').trim();
  if (!authorizationEndpoint || !tokenEndpoint) throw new Error('xAI OIDC discovery did not include authorization and token endpoints.');
  return {
    authorizationEndpoint: validateXaiOAuthEndpoint(authorizationEndpoint, 'authorization_endpoint'),
    tokenEndpoint: validateXaiOAuthEndpoint(tokenEndpoint, 'token_endpoint'),
  };
}

export function buildXaiAuthorizeUrl(input: { authorizationEndpoint: string; redirectUri: string; codeChallenge: string; state: string; nonce: string }): string {
  validateXaiOAuthEndpoint(input.authorizationEndpoint, 'authorization_endpoint');
  // The Hermes/SuperGrok flow expects /oauth2/authorize and referrer=hermes-agent.
  const url = new URL(XAI_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', XAI_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', XAI_OAUTH_SCOPE);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', input.state);
  url.searchParams.set('nonce', input.nonce);
  url.searchParams.set('plan', 'generic');
  url.searchParams.set('referrer', 'hermes-agent');
  return url.toString();
}

async function parseTokenResponse(response: Response, startedAt: number, errorPrefix: string, fallbackRefreshToken = ''): Promise<XaiTokenPayload> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${errorPrefix} (HTTP ${response.status}).${text ? ` Response: ${text}` : ''}`);
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${errorPrefix}: response was not valid JSON.`);
  }
  const accessToken = String(payload.access_token ?? '').trim();
  const refreshToken = String(payload.refresh_token ?? fallbackRefreshToken).trim();
  if (!accessToken) throw new Error(`${errorPrefix}: response did not include access_token.`);
  if (!refreshToken) throw new Error(`${errorPrefix}: response did not include refresh_token.`);
  return { accessToken, refreshToken, expiresAt: calculateTokenExpiry(startedAt, payload.expires_in, accessToken) };
}

function calculateTokenExpiry(requestTimeMs: number, expiresInSeconds: unknown, accessToken?: string): number {
  if (typeof expiresInSeconds === 'number' && Number.isFinite(expiresInSeconds) && expiresInSeconds > 0) return requestTimeMs + expiresInSeconds * 1000;
  return getJwtExpiry(accessToken) ?? requestTimeMs + 3_600 * 1000;
}

function getJwtExpiry(token?: string): number | undefined {
  if (!token?.includes('.')) return undefined;
  try {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const exp = parsed.exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

async function exchangeXaiCodeForTokens(input: { tokenEndpoint: string; code: string; redirectUri: string; codeVerifier: string; codeChallenge: string }, fetchImpl: SuperGrokFetch): Promise<XaiTokenPayload> {
  const tokenEndpoint = validateXaiOAuthEndpoint(input.tokenEndpoint, 'token_endpoint');
  const startedAt = Date.now();
  const response = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: XAI_OAUTH_CLIENT_ID,
      code_verifier: input.codeVerifier,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return parseTokenResponse(response, startedAt, 'xAI token exchange failed');
}

export async function refreshXaiTokens(credentials: SuperGrokCredentials, fetchImpl: SuperGrokFetch = defaultSuperGrokFetch, signal?: AbortSignal): Promise<SuperGrokCredentials> {
  const parts = parseXaiRefresh(credentials.refresh);
  if (!parts.refreshToken) throw new Error('xAI OAuth refresh token is missing. Sign in again.');
  const tokenEndpoint = parts.tokenEndpoint ?? (await discoverXaiOAuth(fetchImpl)).tokenEndpoint;
  const startedAt = Date.now();
  const response = await fetchImpl(validateXaiOAuthEndpoint(tokenEndpoint, 'token_endpoint'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: XAI_OAUTH_CLIENT_ID, refresh_token: parts.refreshToken }),
    signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const refreshed = await parseTokenResponse(response, startedAt, 'xAI token refresh failed', parts.refreshToken);
  return {
    refresh: packXaiRefresh({ refreshToken: refreshed.refreshToken, tokenEndpoint, redirectUri: parts.redirectUri }),
    access: refreshed.accessToken,
    expires: refreshed.expiresAt - REFRESH_SKEW_MS,
  };
}

export function packXaiRefresh(parts: XaiRefreshParts): string {
  return `${REFRESH_PREFIX}${Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url')}`;
}

export function parseXaiRefresh(refresh: string): XaiRefreshParts {
  const value = (refresh ?? '').trim();
  if (!value) return { refreshToken: '' };
  if (!value.startsWith(REFRESH_PREFIX)) return { refreshToken: value };
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(REFRESH_PREFIX.length), 'base64url').toString('utf8')) as Record<string, unknown>;
    return {
      refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : '',
      tokenEndpoint: typeof parsed.tokenEndpoint === 'string' ? parsed.tokenEndpoint : undefined,
      redirectUri: typeof parsed.redirectUri === 'string' ? parsed.redirectUri : undefined,
    };
  } catch {
    return { refreshToken: '' };
  }
}

/** Parse a callback URL or pasted authorization code against the expected state. */
export function parseOAuthCallbackInput(input: string, expectedState: string): { code: string } | { error: string } {
  const raw = input.trim();
  if (!raw) return { error: 'Missing authorization code.' };
  try {
    const url = new URL(raw);
    const oauthError = url.searchParams.get('error');
    if (oauthError) return { error: url.searchParams.get('error_description') ?? oauthError };
    const code = url.searchParams.get('code') ?? '';
    const state = url.searchParams.get('state') ?? '';
    if (!code) return { error: 'Missing authorization code in callback.' };
    if (state !== expectedState) return { error: 'OAuth state mismatch.' };
    return { code };
  } catch {
    return raw ? { code: raw } : { error: 'Missing authorization code.' };
  }
}

const ALLOWED_CALLBACK_ORIGINS = new Set(['https://accounts.x.ai', 'https://auth.x.ai']);

function handleCallbackRequest(req: IncomingMessage, res: ServerResponse, onCallback: (url: URL) => void): void {
  const origin = req.headers.origin;
  const allowOrigin = typeof origin === 'string' && ALLOWED_CALLBACK_ORIGINS.has(origin) ? origin : '';
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const host = req.headers.host ?? `${REDIRECT_HOST}:${REDIRECT_PORT}`;
  const url = new URL(req.url ?? '/', `http://${host}`);
  if (req.method !== 'GET' || url.pathname !== REDIRECT_PATH) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found.');
    return;
  }
  onCallback(url);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  const failed = url.searchParams.has('error');
  res.end(`<html><body><h1>${failed ? 'xAI authorization failed.' : 'xAI authorization received.'}</h1><p>You can close this tab and return to Fate UI.</p></body></html>`);
}

function listenWithFallback(server: http.Server, preferredPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, allowFallback: boolean) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (allowFallback && error.code === 'EADDRINUSE') {
          tryListen(0, false);
          return;
        }
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Could not determine the xAI OAuth callback port.'));
          return;
        }
        resolve(address.port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, REDIRECT_HOST);
    };
    tryListen(preferredPort, preferredPort !== 0);
  });
}

/** Loopback HTTP server that waits for the browser OAuth redirect. */
export async function startXaiOAuthListener(preferredPort = REDIRECT_PORT): Promise<OAuthListener> {
  let resolveCallback: ((url: URL) => void) | undefined;
  let rejectCallback: ((error: Error) => void) | undefined;
  const callbackPromise = new Promise<URL>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  const server = http.createServer((req, res) => handleCallbackRequest(req, res, (url) => resolveCallback?.(url)));
  const port = await listenWithFallback(server, preferredPort);
  const redirectUri = `http://${REDIRECT_HOST}:${port}${REDIRECT_PATH}`;
  return {
    redirectUri,
    waitForCallback(timeoutMs: number) {
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => rejectCallback?.(new Error('Timed out waiting for the xAI OAuth callback.')), timeoutMs);
      });
      return Promise.race([callbackPromise, timeout]);
    },
    close() {
      return new Promise<void>((resolve) => {
        rejectCallback = undefined;
        server.close(() => resolve());
      });
    },
  };
}

/** Full interactive login: discovery, loopback listener, browser auth, code exchange. */
export async function loginXai(callbacks: SuperGrokLoginCallbacks, fetchImpl: SuperGrokFetch = defaultSuperGrokFetch): Promise<SuperGrokCredentials> {
  const discovery = await discoverXaiOAuth(fetchImpl);
  const listener = await startXaiOAuthListener();
  const pkce = generatePkce();
  const state = crypto.randomBytes(24).toString('hex');
  const nonce = crypto.randomBytes(24).toString('hex');
  const authorizationUrl = buildXaiAuthorizeUrl({
    authorizationEndpoint: discovery.authorizationEndpoint,
    redirectUri: listener.redirectUri,
    codeChallenge: pkce.challenge,
    state,
    nonce,
  });
  callbacks.onAuth({ url: authorizationUrl, instructions: 'If the browser shows a code instead of redirecting, paste the code when prompted.' });
  try {
    const candidates: Promise<string>[] = [
      listener.waitForCallback(CALLBACK_TIMEOUT_MS).then((callbackUrl) => {
        const params = parseOAuthCallbackInput(callbackUrl.toString(), state);
        if ('error' in params) throw new Error(params.error);
        return params.code;
      }),
    ];
    if (callbacks.onManualCodeInput) {
      candidates.push(callbacks.onManualCodeInput().then((raw) => {
        const trimmed = raw.trim();
        if (!trimmed) throw new Error('Empty authorization code.');
        return trimmed;
      }));
    }
    const code = await Promise.any(candidates);
    const tokenPayload = await exchangeXaiCodeForTokens({
      tokenEndpoint: discovery.tokenEndpoint,
      code,
      redirectUri: listener.redirectUri,
      codeVerifier: pkce.verifier,
      codeChallenge: pkce.challenge,
    }, fetchImpl);
    return {
      refresh: packXaiRefresh({ refreshToken: tokenPayload.refreshToken, tokenEndpoint: discovery.tokenEndpoint, redirectUri: listener.redirectUri }),
      access: tokenPayload.accessToken,
      expires: tokenPayload.expiresAt - REFRESH_SKEW_MS,
    };
  } finally {
    await listener.close().catch(() => undefined);
  }
}
