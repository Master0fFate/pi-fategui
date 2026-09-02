import { randomBytes } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { type Session } from 'electron';
import { BrowserError } from './BrowserErrors';
import { isPathInside } from './BrowserAddress';

export const LOCAL_PAGE_SCHEME = 'fate-local';
export const LOCAL_PAGE_CONTENT_SECURITY_POLICY = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');
const MAX_LOCAL_PAGES_PER_TAB = 12;
const MAX_BUFFERED_LOCAL_PAGE_BYTES = 8 * 1024 * 1024;

interface LocalPageCapability {
  token: string;
  tabId: string;
  root: string;
  entryPath: string;
  openedAt: number;
}

export interface LocalPageLocation {
  internalUrl: string;
  displayUrl: string;
  origin: string;
  entryPath: string;
}

export class LocalPageRegistry {
  private readonly capabilities = new Map<string, LocalPageCapability>();
  private readonly tokensByTab = new Map<string, string[]>();
  private readonly sessions = new Set<Session>();

  constructor(private readonly canonicalProjectPath: string) {}

  registerSession(session: Session): void {
    if (this.sessions.has(session)) return;
    if (session.protocol.isProtocolHandled(LOCAL_PAGE_SCHEME)) session.protocol.unhandle(LOCAL_PAGE_SCHEME);
    session.protocol.handle(LOCAL_PAGE_SCHEME, (request) => this.handle(request));
    this.sessions.add(session);
  }

  unregisterSessions(): void {
    for (const session of this.sessions) {
      if (session.protocol.isProtocolHandled(LOCAL_PAGE_SCHEME)) session.protocol.unhandle(LOCAL_PAGE_SCHEME);
    }
    this.sessions.clear();
  }

  async open(tabId: string, requestedPath: string, source: 'user' | 'agent'): Promise<LocalPageLocation> {
    const entryPath = await resolveLocalEntry(requestedPath);
    const projectRoot = await fs.realpath(this.canonicalProjectPath);
    const insideProject = isPathInside(projectRoot, entryPath);
    if (source === 'agent' && !insideProject) {
      throw new BrowserError('ACTION_BLOCKED', 'Agent-opened local pages must stay inside the trusted project.');
    }
    // Grant only the entry file's directory, even when it lives inside the
    // project. A preview must not turn one opened HTML file into read access to
    // unrelated source, credentials, or repository metadata.
    const root = path.dirname(entryPath);
    if (!isPathInside(root, entryPath)) throw new BrowserError('ACTION_BLOCKED', 'The local page escaped its authorized folder.');

    const token = randomBytes(24).toString('hex');
    const capability: LocalPageCapability = { token, tabId, root, entryPath, openedAt: Date.now() };
    this.capabilities.set(token, capability);
    const tokens = [...(this.tokensByTab.get(tabId) ?? []), token];
    while (tokens.length > MAX_LOCAL_PAGES_PER_TAB) {
      const expired = tokens.shift();
      if (expired) this.capabilities.delete(expired);
    }
    this.tokensByTab.set(tabId, tokens);

    const relative = path.relative(root, entryPath).split(path.sep).map(encodeURIComponent).join('/');
    const internalUrl = `${LOCAL_PAGE_SCHEME}://${token}/${relative}`;
    return {
      internalUrl,
      displayUrl: pathToFileURL(entryPath).href,
      origin: `${LOCAL_PAGE_SCHEME}://${token}`,
      entryPath,
    };
  }

  displayUrl(value: string, tabId?: string): string | null {
    const resolved = this.resolve(value, tabId);
    return resolved ? pathToFileURL(resolved.filePath).href : null;
  }

  isAuthorized(value: string, tabId?: string): boolean {
    return this.resolve(value, tabId) !== null;
  }

  revokeTab(tabId: string): void {
    for (const token of this.tokensByTab.get(tabId) ?? []) this.capabilities.delete(token);
    this.tokensByTab.delete(tabId);
  }

  retainForNavigation(tabId: string, value: string): void {
    const retained = this.resolve(value, tabId)?.capability.token ?? null;
    for (const token of this.tokensByTab.get(tabId) ?? []) {
      if (token !== retained) this.capabilities.delete(token);
    }
    if (retained) this.tokensByTab.set(tabId, [retained]);
    else this.tokensByTab.delete(tabId);
  }

  clear(): void {
    this.capabilities.clear();
    this.tokensByTab.clear();
    this.unregisterSessions();
  }

  private resolve(value: string, tabId?: string): { capability: LocalPageCapability; filePath: string } | null {
    try {
      const url = new URL(value);
      if (url.protocol !== `${LOCAL_PAGE_SCHEME}:` || url.username || url.password || url.port) return null;
      const capability = this.capabilities.get(url.hostname);
      if (!capability || (tabId && capability.tabId !== tabId)) return null;
      const decodedPath = decodePathname(url.pathname);
      const filePath = path.resolve(capability.root, `.${path.sep}${decodedPath}`);
      if (!isPathInside(capability.root, filePath)) return null;
      return { capability, filePath };
    } catch {
      return null;
    }
  }

  private async handle(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    const resolved = this.resolve(request.url);
    if (!resolved) return new Response('Local page capability not found', { status: 404 });
    if (request.referrer) {
      if (!isCapabilityReferrer(request.referrer, resolved.capability.token)) {
        return new Response('Cross-origin local page request blocked', { status: 403 });
      }
    } else if (
      !sameFilePath(resolved.filePath, resolved.capability.entryPath)
      && !isPreviewResourcePath(resolved.filePath)
      && !(request.headers.get('sec-fetch-site') === 'same-origin' && request.headers.get('sec-fetch-dest') !== 'document')
    ) {
      return new Response('A same-origin request is required for local preview resources', { status: 403 });
    }
    try {
      const canonical = await fs.realpath(resolved.filePath);
      if (!isPathInside(resolved.capability.root, canonical)) return new Response('Forbidden', { status: 403 });
      const info = await fs.stat(canonical);
      if (!info.isFile()) return new Response('Not found', { status: 404 });
      // Serve straight from Node's filesystem. Piping the request through a
      // nested net.fetch(file://…) inside protocol.handle never commits on
      // macOS — the load aborts before the response arrives — so the preview
      // tab silently dies on about:blank. A Node stream with an explicit
      // content type and length is the same shape the media protocol ships.
      const headers = new Headers({
        'Cache-Control': 'no-store',
        'Content-Length': String(info.size),
        'Content-Type': localPageContentType(canonical),
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
        'X-DNS-Prefetch-Control': 'off',
      });
      if (/\.(?:html?|xhtml|svg)$/iu.test(canonical)) {
        headers.set('Content-Security-Policy', LOCAL_PAGE_CONTENT_SECURITY_POLICY);
        headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=()');
      }
      const body = request.method === 'HEAD'
        ? null
        : info.size <= MAX_BUFFERED_LOCAL_PAGE_BYTES
          // Small previews buffer outright: streamed bodies through
          // protocol.handle die with ERR_FAILED on slow macOS runners, and a
          // local HTML preview is exactly the case that must never flake.
          ? new Uint8Array(await fs.readFile(canonical))
          : Readable.toWeb(createReadStream(canonical)) as ReadableStream<Uint8Array>;
      return new Response(body, { status: 200, statusText: 'OK', headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  }
}

async function resolveLocalEntry(requestedPath: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await fs.realpath(path.resolve(requestedPath));
  } catch {
    throw new BrowserError('INVALID_URL', 'That local file does not exist or cannot be opened.');
  }
  const info = await fs.stat(canonical).catch(() => null);
  if (!info) throw new BrowserError('INVALID_URL', 'That local file does not exist or cannot be opened.');
  if (info.isDirectory()) {
    const indexPath = await fs.realpath(path.join(canonical, 'index.html')).catch(() => null);
    if (!indexPath) throw new BrowserError('INVALID_URL', 'That folder does not contain an index.html file.');
    canonical = indexPath;
  } else if (!info.isFile()) {
    throw new BrowserError('INVALID_URL', 'Only local files can be opened in the browser.');
  }
  if (!/\.(?:html?|xhtml|svg)$/iu.test(canonical)) {
    throw new BrowserError('INVALID_URL', 'Choose an HTML, XHTML, or SVG file to preview.');
  }
  return canonical;
}

const LOCAL_PAGE_MEDIA_TYPES = new Map<string, string>([
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.ogg', 'audio/ogg'],
  ['.opus', 'audio/opus'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webm', 'video/webm'],
  ['.webp', 'image/webp'],
  ['.wasm', 'application/wasm'],
  ['.wav', 'audio/wav'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.xhtml', 'application/xhtml+xml'],
]);

function localPageContentType(filePath: string): string {
  return LOCAL_PAGE_MEDIA_TYPES.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

function isPreviewResourcePath(filePath: string): boolean {
  return /\.(?:avif|bmp|css|gif|html?|ico|jpe?g|js|json|map|mjs|mp3|mp4|ogg|opus|png|svg|webm|webp|wasm|wav|woff2?|xhtml)$/iu.test(filePath);
}

function sameFilePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.normalize(path.resolve(value));
    return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  };
  return normalize(left) === normalize(right);
}

function isCapabilityReferrer(value: string, token: string): boolean {
  try {
    const referrer = new URL(value);
    return referrer.protocol === `${LOCAL_PAGE_SCHEME}:` && referrer.hostname === token;
  } catch {
    return false;
  }
}

function decodePathname(value: string): string {
  const segments = value.split('/').filter(Boolean).map((segment) => {
    const decoded = decodeURIComponent(segment);
    if (!decoded || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
      throw new Error('Invalid path segment');
    }
    return decoded;
  });
  return segments.join(path.sep);
}
