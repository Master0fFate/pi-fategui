import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { Resolver } from 'node:dns';
import { existsSync, realpathSync, statSync, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent, type RequestOptions } from 'node:https';
import { BlockList, connect as connectTcp, isIP, type Socket } from 'node:net';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { connect as connectTls, type TLSSocket } from 'node:tls';
import type { MusicDurationUpdate, MusicQueue, MusicStatus, MusicStream, MusicTrack } from '../../shared/contracts/ipc';

const MAX_TRACKS = 200;
const METADATA_TIMEOUT_MS = 45_000;
const STREAM_TIMEOUT_MS = 30_000;
const DNS_TIMEOUT_MS = 5_000;
const JSON_BUFFER_BYTES = 8 * 1024 * 1024;
const DURATION_BATCH_SIZE = 8;
const DURATION_BACKOFF_MS = 150;
const DURATION_MAX_FAILURES = 2;
// Signed CDN stream URLs are short-lived; keep resolved URLs reusable for
// instant track switches but never long enough to serve a dead link.
const STREAM_CACHE_TTL_MS = 90 * 60 * 1000;
// Background prefetch keeps only a small share of the connection for itself
// while the current track keeps downloading at full speed in the player.
const PREFETCH_BYTES_PER_SECOND = 256 * 1024;
const PREFETCH_MAX_FILE_BYTES = 64 * 1024 * 1024;
const PREFETCH_CACHE_MAX_BYTES = 192 * 1024 * 1024;
const PREFETCH_CACHE_MAX_FILES = 6;
const PREFETCH_CONNECT_TIMEOUT_MS = 10_000;
const PREFETCH_IDLE_TIMEOUT_MS = 30_000;
const PREFETCH_PACE_CHUNK_BYTES = 64 * 1024;
const DOWNLOAD_REDIRECT_LIMIT = 3;
const MEDIA_TOKEN_BYTES = 16;
const COMMON_ARGS = [
  '--ignore-config',
  '--no-plugin-dirs',
  '--no-warnings',
  '--no-progress',
  '--no-color',
  '--socket-timeout', '10',
  '--retries', '1',
  '--extractor-retries', '1',
] as const;

export const MEDIA_SCHEME = 'fate-media';

interface RunnerLimits {
  timeoutMs: number;
  maxBuffer: number;
}

export interface MusicProcessRunner {
  getVersion(): Promise<string>;
  run(args: readonly string[], limits: RunnerLimits): Promise<string>;
  dispose(): void;
}

export type MusicHostResolver = (hostname: string, signal?: AbortSignal) => Promise<readonly string[]>;

export interface AudioDownloadRequest {
  url: string;
  destination: string;
  bytesPerSecond: number;
  maxBytes: number;
  signal: AbortSignal;
  proxyUrl: string;
}

export interface AudioDownloadResult {
  contentType: string | null;
  bytes: number;
}

export type AudioDownloader = (request: AudioDownloadRequest) => Promise<AudioDownloadResult>;

export type MediaRequestResult =
  | { status: 405 | 404 | 416 }
  | { status: 200 | 206; contentType: string; totalBytes: number; file: string; start: number; end: number; headOnly: boolean };

type ProcessFailure = 'not-found' | 'timeout' | 'failed';

class MusicProcessError extends Error {
  constructor(readonly kind: ProcessFailure) {
    super(kind);
    this.name = 'MusicProcessError';
  }
}

export function executableCandidates(): string[] {
  const resourceRoot = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const executableName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const configured = process.env.YT_DLP_PATH?.trim();
  const candidates: string[] = configured && path.isAbsolute(configured) ? [configured] : [];
  if (resourceRoot) candidates.push(path.join(resourceRoot, executableName));
  if (process.platform === 'win32') {
    candidates.push(path.join(homedir(), 'scoop', 'shims', 'yt-dlp.exe'));
    const locator = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');
    try {
      candidates.push(...execFileSync(locator, ['yt-dlp'], { cwd: homedir(), encoding: 'utf8', windowsHide: true }).split(/\r?\n/u));
    } catch { /* Conventional absolute locations are still checked. */ }
  } else {
    candidates.push(path.join(homedir(), '.local', 'bin', 'yt-dlp'), '/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp');
    try {
      candidates.push(...execFileSync('/usr/bin/which', ['yt-dlp'], { cwd: homedir(), encoding: 'utf8' }).split(/\r?\n/u));
    } catch { /* Conventional absolute locations are still checked. */ }
  }
  const launchRoot = path.resolve(process.cwd());
  return [...new Set(candidates.flatMap((candidate) => {
    if (!candidate || !path.isAbsolute(candidate) || !existsSync(candidate)) return [];
    const canonical = realpathSync(candidate);
    const relative = path.relative(launchRoot, canonical);
    const insideLaunchRoot = relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    const resourceRelative = resourceRoot ? path.relative(path.resolve(resourceRoot), canonical) : '..';
    const insideTrustedResources = resourceRoot !== undefined
      && (resourceRelative === '' || (resourceRelative !== '..' && !resourceRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(resourceRelative)));
    if ((insideLaunchRoot && !insideTrustedResources) || !statSync(canonical).isFile()) return [];
    return [canonical];
  }))];
}

export class YtDlpProcessRunner implements MusicProcessRunner {
  private executable: string | null = null;
  private readonly children = new Set<ChildProcess>();

  async getVersion(): Promise<string> {
    if (this.executable) {
      return this.runWith(this.executable, [...COMMON_ARGS, '--version'], { timeoutMs: 5_000, maxBuffer: 64_000 });
    }
    for (const candidate of executableCandidates()) {
      try {
        const version = await this.runWith(candidate, [...COMMON_ARGS, '--version'], { timeoutMs: 5_000, maxBuffer: 64_000 });
        this.executable = candidate;
        return version;
      } catch {
        // Try the next conventional cross-platform install location.
      }
    }
    throw new MusicProcessError('not-found');
  }

  async run(args: readonly string[], limits: RunnerLimits): Promise<string> {
    if (!this.executable) await this.getVersion();
    return this.runWith(this.executable!, [...COMMON_ARGS, ...args], limits);
  }

  dispose(): void {
    for (const child of this.children) child.kill();
    this.children.clear();
  }

  private runWith(executable: string, args: readonly string[], limits: RunnerLimits): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(executable, [...args], {
        encoding: 'utf8',
        timeout: limits.timeoutMs,
        maxBuffer: limits.maxBuffer,
        windowsHide: true,
        shell: false,
      }, (error, stdout) => {
        this.children.delete(child);
        if (!error) {
          resolve(stdout);
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') reject(new MusicProcessError('not-found'));
        else if (error.killed || code === 'ETIMEDOUT') reject(new MusicProcessError('timeout'));
        else reject(new MusicProcessError('failed'));
      });
      this.children.add(child);
    });
  }
}

const defaultHostResolver: MusicHostResolver = (hostname, signal) => new Promise((resolve, reject) => {
  const resolver = new Resolver();
  const addresses: string[] = [];
  let pending = 2;
  let failures = 0;
  let settled = false;
  const finish = (error: NodeJS.ErrnoException | null, values: readonly string[] | undefined) => {
    if (settled) return;
    if (error) failures += 1;
    else if (values) addresses.push(...values);
    pending -= 1;
    if (pending > 0) return;
    settled = true;
    signal?.removeEventListener('abort', abort);
    if (addresses.length > 0) resolve(addresses);
    else reject(new Error(failures > 0 ? 'DNS lookup failed' : 'DNS returned no addresses'));
  };
  const abort = () => {
    if (settled) return;
    settled = true;
    resolver.cancel();
    reject(new Error('DNS lookup cancelled'));
  };
  if (signal?.aborted) { abort(); return; }
  signal?.addEventListener('abort', abort, { once: true });
  resolver.resolve4(hostname, finish);
  resolver.resolve6(hostname, finish);
});

const nonPublicIpv4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) nonPublicIpv4.addSubnet(network, prefix, 'ipv4');

const nonPublicIpv6 = new BlockList();
for (const [network, prefix] of [
  ['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['3fff::', 20], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) nonPublicIpv6.addSubnet(network, prefix, 'ipv6');

export function isPublicIpAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return !nonPublicIpv4.check(address, 'ipv4');
  if (kind === 6) return !nonPublicIpv6.check(address, 'ipv6');
  return false;
}

function parseHttpsUrl(rawUrl: string, maximumLength: number): URL {
  if (rawUrl.length > maximumLength) throw new Error('The media link is too long.');
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Enter a complete HTTPS media link.');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || (parsed.port && parsed.port !== '443')
    || !hostname
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.home.arpa')
  ) {
    throw new Error('Only public HTTPS media links are supported.');
  }
  if (isIP(hostname) && !isPublicIpAddress(hostname)) throw new Error('Local and private network media links are blocked.');
  parsed.hash = '';
  return parsed;
}

async function resolvePublicHost(hostname: string, resolveHost: MusicHostResolver, parentSignal?: AbortSignal): Promise<readonly string[]> {
  if (isIP(hostname)) {
    if (!isPublicIpAddress(hostname)) throw new Error('Local and private network media links are blocked.');
    return [hostname];
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, DNS_TIMEOUT_MS);
  timeout.unref();
  try {
    const aborted = controller.signal.aborted
      ? Promise.reject(new Error('DNS timeout or cancellation'))
      : new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('DNS timeout or cancellation')), { once: true });
        });
    const addresses = [...new Set(await Promise.race([resolveHost(hostname, controller.signal), aborted]))];
    if (addresses.length === 0 || addresses.some((address) => !isPublicIpAddress(address))) {
      throw new Error('Local and private network media links are blocked.');
    }
    return addresses;
  } catch (error) {
    if (error instanceof Error && error.message.includes('private network')) throw error;
    throw new Error('The media host could not be reached.');
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', abort);
    controller.abort();
  }
}

async function validatePublicHttpsUrl(rawUrl: string, maximumLength: number, resolveHost: MusicHostResolver, parentSignal?: AbortSignal): Promise<string> {
  const parsed = parseHttpsUrl(rawUrl, maximumLength);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  await resolvePublicHost(hostname, resolveHost, parentSignal);
  return parsed.toString();
}

export class PublicHttpsProxy {
  private readonly server: Server;
  private readonly controller = new AbortController();
  private readonly sockets = new Set<Socket>();

  constructor(private readonly resolveHost: MusicHostResolver = defaultHostResolver) {
    this.server = createServer((_request, response) => {
      response.writeHead(405, { Connection: 'close', 'Content-Type': 'text/plain' });
      response.end('HTTPS CONNECT is required.');
    });
    this.server.maxConnections = 128;
    this.server.headersTimeout = 5_000;
    this.server.requestTimeout = 5_000;
    this.server.on('connect', (request, rawClient, head) => {
      const client = rawClient as Socket;
      this.track(client);
      void this.openTunnel(request.url ?? '', client, head).catch(() => {
        if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      this.server.once('error', failed);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', failed);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('The secure media proxy could not bind to loopback.');
    return `http://127.0.0.1:${address.port}`;
  }

  dispose(): void {
    this.controller.abort();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    try { this.server.close(); } catch { /* The proxy may be cancelled before listen completes. */ }
  }

  private track(socket: Socket): void {
    if (this.sockets.has(socket)) return;
    this.sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => this.sockets.delete(socket));
  }

  private async openTunnel(authority: string, client: Socket, head: Buffer): Promise<void> {
    if (this.controller.signal.aborted) throw new Error('Proxy closed.');
    const parsed = parseHttpsUrl(`https://${authority}`, 2_048);
    if (parsed.pathname !== '/' || parsed.search) throw new Error('Invalid CONNECT authority.');
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    const addresses = await resolvePublicHost(hostname, this.resolveHost, this.controller.signal);
    const upstream = await this.connectFirst(addresses);
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

  private async connectFirst(addresses: readonly string[]): Promise<Socket> {
    let lastError: unknown;
    for (const address of addresses) {
      if (this.controller.signal.aborted) break;
      try {
        return await new Promise<Socket>((resolve, reject) => {
          const socket = connectTcp({ host: address, port: 443, family: isIP(address) });
          this.track(socket);
          const timeout = setTimeout(() => socket.destroy(new Error('Connection timed out.')), 10_000);
          timeout.unref();
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
    throw lastError ?? new Error('No public media address was reachable.');
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function cleanText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return fallback;
  let bounded = '';
  for (const character of cleaned) {
    if (bounded.length + character.length > 300) break;
    bounded += character;
  }
  return bounded;
}

function durationOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function sourceUrlOf(entry: Record<string, unknown>, fallback?: string): string | null {
  for (const key of ['webpage_url', 'original_url', 'url'] as const) {
    if (typeof entry[key] !== 'string') continue;
    try {
      return parseHttpsUrl(entry[key], 2_048).toString();
    } catch {
      // Flat playlist entries are occasionally IDs rather than URLs.
    }
  }
  return fallback ?? null;
}

function jsonRecord(stdout: string): Record<string, unknown> {
  try {
    const parsed = recordOf(JSON.parse(stdout.trim()));
    if (parsed) return parsed;
  } catch {
    // Report a stable boundary error without exposing extractor output or signed URLs.
  }
  throw new Error('yt-dlp returned unreadable media metadata. Update yt-dlp and try again.');
}

function mediaExtensionOf(url: string): string {
  const extension = path.extname(new URL(url).pathname).toLowerCase();
  return /^\.(?:aac|aiff|flac|m4a|mka|mp3|oga|ogg|opus|wav|weba|webm)$/u.test(extension) ? extension : '.m4a';
}

function mediaContentTypeOf(url: string): string {
  switch (mediaExtensionOf(url)) {
    case '.mp3': return 'audio/mpeg';
    case '.opus': return 'audio/ogg';
    case '.oga': case '.ogg': return 'audio/ogg';
    case '.wav': return 'audio/wav';
    case '.weba': case '.webm': return 'audio/webm';
    case '.flac': return 'audio/flac';
    case '.aac': return 'audio/aac';
    default: return 'audio/mp4';
  }
}

type DownloadOutcome =
  | { kind: 'redirect'; location: string }
  | { kind: 'body'; contentType: string | null; bytes: number };

/**
 * Routes one HTTPS request through the local SSRF-guarded CONNECT proxy. The
 * proxy re-validates DNS against the public address policy on every hop, so a
 * rebinding race cannot steer the audio download at a private target.
 */
class TunnelAgent extends HttpsAgent {
  constructor(private readonly proxyUrl: URL) {
    super({ keepAlive: false, maxSockets: 1 });
  }

  override createConnection(options: RequestOptions, callback?: (error: Error | null, stream: Socket) => void): Socket | null | undefined {
    if (!callback) return null;
    const deliver = (error: Error | null, socket?: TLSSocket): void => {
      callback(error, socket ?? (undefined as unknown as Socket));
    };
    const host = options.servername ?? (typeof options.host === 'string' ? options.host.replace(/^\[|\]$/g, '') : null);
    if (!host) { deliver(new Error('The media host was missing.')); return; }
    let settled = false;
    const settle = (error: Error | null, socket?: TLSSocket) => {
      if (settled) return;
      settled = true;
      request.destroy();
      deliver(error, socket);
    };
    const authority = `${host}:443`;
    const request = httpRequest({
      host: this.proxyUrl.hostname,
      port: Number(this.proxyUrl.port) || 80,
      method: 'CONNECT',
      path: authority,
      headers: { Host: authority },
      agent: false,
      timeout: PREFETCH_CONNECT_TIMEOUT_MS,
    });
    request.once('timeout', () => settle(new Error('The media proxy connection timed out.')));
    request.once('error', (error) => settle(error));
    request.once('connect', (_response, socket) => {
      if (settled) { socket.destroy(); return; }
      settled = true;
      const secure = connectTls({ socket, servername: host, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
      secure.once('error', () => { secure.destroy(); deliver(new Error('The media tunnel failed.')); });
      secure.once('secureConnect', () => deliver(null, secure));
    });
    request.end();
  }
}

async function downloadOnce(target: URL, agent: InstanceType<typeof TunnelAgent>, request: AudioDownloadRequest): Promise<DownloadOutcome> {
  return new Promise<DownloadOutcome>((resolve, reject) => {
    if (request.signal.aborted) { reject(new Error('The prefetch was cancelled.')); return; }
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    const outgoing = httpsRequest({
      protocol: 'https:',
      host: hostname,
      port: 443,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      agent,
      servername: hostname,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FateUI)', Accept: '*/*' },
      timeout: PREFETCH_IDLE_TIMEOUT_MS,
    });
    let sink: ReturnType<typeof createWriteStream> | null = null;
    let settled = false;
    let bytes = 0;
    let pacedBytes = 0;
    let pacedStart = Date.now();
    const finish = (error: Error | null, outcome?: DownloadOutcome) => {
      if (settled) return;
      settled = true;
      request.signal.removeEventListener('abort', abort);
      if (error) {
        outgoing.destroy();
        sink?.destroy();
        reject(error);
        return;
      }
      // The sink only exists for successful bodies, so a redirect hop never
      // leaves an empty file that breaks the next hop's exclusive create.
      sink!.end(() => resolve(outcome!));
    };
    const abort = () => finish(new Error('The prefetch was cancelled.'));
    request.signal.addEventListener('abort', abort, { once: true });
    outgoing.once('timeout', () => finish(new Error('The media download stalled.')));
    outgoing.once('error', (error) => finish(error));
    outgoing.once('response', (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
        if (typeof location === 'string' && location) {
          response.resume();
          finish(null, { kind: 'redirect', location: new URL(location, target).toString() });
          return;
        }
        finish(new Error('The media stream redirect was incomplete.'));
        return;
      }
      if (status !== 200) {
        response.resume();
        finish(new Error(`The media server answered with status ${status}.`));
        return;
      }
      sink = createWriteStream(request.destination, { flags: 'wx' });
      sink.once('error', (error) => finish(error));
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > request.maxBytes) {
          finish(new Error('The media file is too large to prefetch.'));
          return;
        }
        sink!.write(chunk);
        pacedBytes += chunk.length;
        if (pacedBytes >= PREFETCH_PACE_CHUNK_BYTES) {
          const expectedMs = (pacedBytes / request.bytesPerSecond) * 1000;
          const elapsedMs = Date.now() - pacedStart;
          if (elapsedMs < expectedMs) {
            response.pause();
            const wait = setTimeout(() => {
              pacedBytes = 0;
              pacedStart = Date.now();
              response.resume();
            }, expectedMs - elapsedMs);
            wait.unref?.();
          } else {
            pacedBytes = 0;
            pacedStart = Date.now();
          }
        }
      });
      response.once('error', (error) => finish(error));
      response.once('aborted', () => finish(new Error('The media connection was cut short.')));
      response.once('end', () => finish(null, {
        kind: 'body',
        contentType: typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : null,
        bytes,
      }));
    });
    outgoing.end();
  });
}

export const tunnelAudioDownloader: AudioDownloader = async (download) => {
  if (download.signal.aborted) throw new Error('The prefetch was cancelled.');
  let target = parseHttpsUrl(download.url, 16_384);
  const agent = new TunnelAgent(new URL(download.proxyUrl));
  try {
    for (let hop = 0; hop <= DOWNLOAD_REDIRECT_LIMIT; hop += 1) {
      const outcome = await downloadOnce(target, agent, download);
      if (outcome.kind === 'redirect') {
        target = parseHttpsUrl(outcome.location, 16_384);
        continue;
      }
      return { contentType: outcome.contentType, bytes: outcome.bytes };
    }
    throw new Error('The media stream redirected too many times.');
  } finally {
    agent.destroy();
  }
};

interface StoredTrack extends MusicTrack {
  sourceUrl: string;
}

interface CachedStream extends MusicStream {
  resolvedAt: number;
}

interface CachedAudio {
  trackId: string;
  token: string;
  file: string;
  bytes: number;
  contentType: string;
  title: string;
  duration: number | null;
  accessedAt: number;
}

export class MusicService {
  private tracks = new Map<string, StoredTrack>();
  private statusPromise: Promise<MusicStatus> | null = null;
  private operationActive = false;
  private generation = 0;
  private activeDnsController: AbortController | null = null;
  private activeProxy: PublicHttpsProxy | null = null;
  private durationSink: ((updates: readonly MusicDurationUpdate[]) => void) | null = null;
  private durationAttempted = new Set<string>();
  private durationFailures = 0;
  private backgroundPromise: Promise<void> | null = null;
  private backgroundCancelled = true;
  private activeDownload: { controller: AbortController; proxy: PublicHttpsProxy } | null = null;
  private readonly streamCache = new Map<string, CachedStream>();
  private readonly audioCache = new Map<string, CachedAudio>();
  private readonly mediaTokens = new Map<string, CachedAudio>();
  private readonly prefetchFailures = new Set<string>();
  private lastResolvedTrackId: string | null = null;
  private cacheDirectory: string | null = null;
  private cacheDirectoryPromise: Promise<string> | null = null;

  constructor(
    private readonly runner: MusicProcessRunner = new YtDlpProcessRunner(),
    private readonly resolveHost: MusicHostResolver = defaultHostResolver,
    private readonly downloadAudio: AudioDownloader = tunnelAudioDownloader,
  ) {}

  getStatus(): Promise<MusicStatus> {
    this.statusPromise ??= this.checkStatus();
    return this.statusPromise;
  }

  setDurationSink(sink: (updates: readonly MusicDurationUpdate[]) => void): void {
    this.durationSink = sink;
  }

  async load(rawUrl: string): Promise<MusicQueue> {
    await this.requireAvailable();
    const queue = await this.exclusive(async () => {
      const generation = this.generation;
      const sourceUrl = await this.validateUrl(rawUrl.trim(), 2_048, generation);
      const stdout = await this.runExtractor([
        '--skip-download',
        '--flat-playlist',
        '--playlist-end', String(MAX_TRACKS),
        '--dump-single-json',
        '--', sourceUrl,
      ], { timeoutMs: METADATA_TIMEOUT_MS, maxBuffer: JSON_BUFFER_BYTES });
      if (generation !== this.generation) throw new Error('The music queue changed while loading this link.');
      const root = jsonRecord(stdout);
      const rawEntries = Array.isArray(root.entries) ? root.entries : [root];
      const nextTracks = new Map<string, StoredTrack>();
      for (const rawEntry of rawEntries.slice(0, MAX_TRACKS)) {
        const entry = recordOf(rawEntry);
        if (!entry) continue;
        const trackSource = sourceUrlOf(entry, rawEntries.length === 1 ? sourceUrl : undefined);
        if (!trackSource) continue;
        const id = randomUUID();
        nextTracks.set(id, {
          id,
          title: cleanText(entry.title, `Track ${nextTracks.size + 1}`),
          duration: durationOf(entry.duration),
          sourceUrl: trackSource,
        });
      }
      if (nextTracks.size === 0) throw new Error('No playable tracks were found at this link.');
      for (const [id, track] of nextTracks) this.tracks.set(id, track);
      return {
        title: cleanText(root.title, nextTracks.size > 1 ? 'Playlist' : 'Now playing'),
        tracks: [...nextTracks.values()].map(({ sourceUrl: _sourceUrl, ...track }) => track),
      };
    });
    this.scheduleBackground();
    return queue;
  }

  /**
   * Resolves a playable stream for a track. Cached tracks answer instantly —
   * fully prefetched tracks even answer with a local media URL that needs no
   * network at all — while a cache miss falls back to a fresh extraction.
   */
  async resolveTrack(trackId: string): Promise<MusicStream> {
    await this.requireAvailable();
    const track = this.tracks.get(trackId);
    if (!track) throw new Error('This track is no longer in the active playlist. Load the link again.');
    const audio = this.audioCache.get(trackId);
    if (audio) {
      audio.accessedAt = Date.now();
      this.lastResolvedTrackId = trackId;
      this.scheduleBackground();
      return { trackId, title: audio.title, duration: audio.duration, url: `${MEDIA_SCHEME}://audio/${audio.token}` };
    }
    const cached = this.freshCachedStream(trackId);
    if (cached) {
      this.lastResolvedTrackId = trackId;
      this.scheduleBackground();
      return { trackId, title: cached.title, duration: cached.duration ?? track.duration, url: cached.url };
    }
    return this.exclusive(async () => {
      const current = this.tracks.get(trackId);
      if (!current) throw new Error('This track is no longer in the active playlist. Load the link again.');
      const generation = this.generation;
      const stream = await this.extractStream(current, generation);
      this.streamCache.set(trackId, { ...stream, resolvedAt: Date.now() });
      this.lastResolvedTrackId = trackId;
      return stream;
    });
  }

  /**
   * Answers one `fate-media://audio/<token>` request from the protocol glue in
   * the Electron entrypoint. Range requests are honoured so seeking works.
   */
  openMediaRequest(method: string, rawUrl: string, rangeHeader: string | null): MediaRequestResult {
    if (method !== 'GET' && method !== 'HEAD') return { status: 405 };
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { status: 404 };
    }
    if (url.protocol !== `${MEDIA_SCHEME}:` || url.hostname !== 'audio' || url.search || url.hash) return { status: 404 };
    const token = url.pathname.replace(/^\//u, '');
    if (!/^[0-9a-f]{2,128}$/u.test(token)) return { status: 404 };
    const entry = this.mediaTokens.get(token);
    if (!entry) return { status: 404 };
    entry.accessedAt = Date.now();
    let start = 0;
    let end = entry.bytes - 1;
    let partial = false;
    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/u.exec(rangeHeader.trim());
      if (match && (match[1] !== '' || match[2] !== '')) {
        if (match[1] !== '') {
          start = Number(match[1]);
          if (!Number.isSafeInteger(start) || start >= entry.bytes) return { status: 416 };
          if (match[2] !== '') {
            end = Number(match[2]);
            if (!Number.isSafeInteger(end) || end < start) return { status: 416 };
            end = Math.min(end, entry.bytes - 1);
          }
        } else {
          const suffix = Number(match[2]);
          if (!Number.isSafeInteger(suffix) || suffix <= 0) return { status: 416 };
          start = Math.max(0, entry.bytes - suffix);
        }
        partial = start > 0 || end < entry.bytes - 1;
      }
    }
    return {
      status: partial ? 206 : 200,
      contentType: entry.contentType,
      totalBytes: entry.bytes,
      file: entry.file,
      start,
      end,
      headOnly: method === 'HEAD',
    };
  }

  clearQueue(): void {
    this.generation += 1;
    this.backgroundCancelled = true;
    this.durationAttempted.clear();
    this.durationFailures = 0;
    this.tracks.clear();
    this.streamCache.clear();
    this.audioCache.clear();
    this.mediaTokens.clear();
    this.prefetchFailures.clear();
    this.lastResolvedTrackId = null;
    this.activeDnsController?.abort();
    this.activeDnsController = null;
    this.activeProxy?.dispose();
    this.activeProxy = null;
    this.activeDownload?.controller.abort();
    this.activeDownload?.proxy.dispose();
    this.activeDownload = null;
    this.cacheDirectoryPromise = null;
    if (this.cacheDirectory) {
      void rm(this.cacheDirectory, { recursive: true, force: true }).catch(() => { /* Cache files are advisory. */ });
      this.cacheDirectory = null;
    }
    // Queue clearing is also cancellation: terminate any in-flight extractor
    // so a stale 30–45 second request cannot retain CPU or process resources.
    this.runner.dispose();
  }

  reset(): void {
    this.clearQueue();
    this.statusPromise = null;
  }

  dispose(): void {
    this.reset();
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new Error('The music queue changed while this request was running.');
  }

  private async validateUrl(rawUrl: string, maximumLength: number, generation: number): Promise<string> {
    const controller = new AbortController();
    this.activeDnsController?.abort();
    this.activeDnsController = controller;
    try {
      const validated = await validatePublicHttpsUrl(rawUrl, maximumLength, this.resolveHost, controller.signal);
      this.assertGeneration(generation);
      return validated;
    } catch (error) {
      this.assertGeneration(generation);
      throw error;
    } finally {
      if (this.activeDnsController === controller) this.activeDnsController = null;
    }
  }

  private async checkStatus(): Promise<MusicStatus> {
    try {
      const version = cleanText(await this.runner.getVersion(), 'unknown');
      return { available: true, version };
    } catch {
      return {
        available: false,
        version: null,
        message: 'Install yt-dlp on PATH, then restart Fate UI.',
      };
    }
  }

  private async requireAvailable(): Promise<void> {
    const status = await this.getStatus();
    if (!status.available) throw new Error(status.message ?? 'yt-dlp is unavailable.');
  }

  private async runExtractor(args: readonly string[], limits: RunnerLimits): Promise<string> {
    const proxy = new PublicHttpsProxy(this.resolveHost);
    this.activeProxy?.dispose();
    this.activeProxy = proxy;
    try {
      const proxyUrl = await proxy.start();
      return await this.runner.run(['--proxy', proxyUrl, ...args], limits);
    } catch (error) {
      if (error instanceof MusicProcessError && error.kind === 'timeout') {
        throw new Error('yt-dlp took too long to read this link. Try again or use a smaller playlist.');
      }
      if (error instanceof MusicProcessError && error.kind === 'not-found') {
        throw new Error('yt-dlp is unavailable. Install it on PATH, then restart Fate UI.');
      }
      throw new Error('yt-dlp could not resolve this media. Check the link, access requirements, or yt-dlp version.');
    } finally {
      proxy.dispose();
      if (this.activeProxy === proxy) this.activeProxy = null;
    }
  }

  private async extractStream(track: StoredTrack, generation: number): Promise<MusicStream> {
    const sourceUrl = await this.validateUrl(track.sourceUrl, 2_048, generation);
    const stdout = await this.runExtractor([
      '--skip-download',
      '--no-playlist',
      '--format', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
      '--dump-single-json',
      '--', sourceUrl,
    ], { timeoutMs: STREAM_TIMEOUT_MS, maxBuffer: JSON_BUFFER_BYTES });
    if (generation !== this.generation) throw new Error('The music queue changed while resolving this track.');
    const metadata = jsonRecord(stdout);
    const requested = Array.isArray(metadata.requested_downloads) ? recordOf(metadata.requested_downloads[0]) : null;
    const direct = typeof requested?.url === 'string' ? requested.url : typeof metadata.url === 'string' ? metadata.url : null;
    if (!direct) throw new Error('yt-dlp could not find a browser-playable audio stream.');
    const streamUrl = await this.validateUrl(direct, 16_384, generation);
    const learnedDuration = durationOf(metadata.duration);
    if (learnedDuration !== null && track.duration == null) {
      track.duration = learnedDuration;
      this.emitDurations([{ trackId: track.id, duration: learnedDuration }]);
    }
    return {
      trackId: track.id,
      title: cleanText(metadata.title, track.title),
      duration: learnedDuration ?? track.duration,
      url: streamUrl,
    };
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.operationActive) {
      if (!this.backgroundPromise) throw new Error('Another music link is still being resolved.');
      // Background work (prefetch or duration lookups) must always yield to
      // explicit user actions.
      this.backgroundCancelled = true;
      this.activeProxy?.dispose();
      this.activeDownload?.controller.abort();
      this.activeDownload?.proxy.dispose();
      await this.backgroundPromise.catch(() => undefined);
      if (this.operationActive) throw new Error('Another music link is still being resolved.');
    }
    this.operationActive = true;
    try {
      return await operation();
    } finally {
      this.operationActive = false;
      this.scheduleBackground();
    }
  }

  private freshCachedStream(trackId: string): CachedStream | null {
    const cached = this.streamCache.get(trackId);
    if (cached && Date.now() - cached.resolvedAt <= STREAM_CACHE_TTL_MS) return cached;
    if (cached) this.streamCache.delete(trackId);
    return null;
  }

  private successorOf(trackId: string | null): string | null {
    if (!trackId) return null;
    let found = false;
    for (const id of this.tracks.keys()) {
      if (found) return id;
      if (id === trackId) found = true;
    }
    return null;
  }

  private nextPrefetchTarget(): string | null {
    const targetId = this.successorOf(this.lastResolvedTrackId);
    if (!targetId || this.prefetchFailures.has(targetId) || this.audioCache.has(targetId)) return null;
    return this.tracks.has(targetId) ? targetId : null;
  }

  private scheduleBackground(): void {
    if (this.backgroundPromise || !this.hasBackgroundWork()) return;
    this.backgroundCancelled = false;
    this.backgroundPromise = this.runBackground().catch(() => undefined).finally(() => {
      this.backgroundPromise = null;
    });
  }

  private hasBackgroundWork(): boolean {
    if (this.nextPrefetchTarget() !== null) return true;
    return Boolean(this.durationSink) && this.durationFailures < DURATION_MAX_FAILURES && this.pendingDurationTracks().length > 0;
  }

  /**
   * Single background lane. Prefetching the next queued track always runs
   * ahead of cosmetic duration backfill, one unit of work at a time, so a
   * user action only ever has to preempt one bounded step.
   */
  private async runBackground(): Promise<void> {
    while (!this.backgroundCancelled) {
      const generation = this.generation;
      const targetId = this.nextPrefetchTarget();
      if (targetId) {
        await this.acquireForBackground(() => this.prefetchTrack(targetId));
        continue;
      }
      const chunk = this.pendingDurationTracks();
      if (chunk.length > 0 && this.durationSink && this.durationFailures < DURATION_MAX_FAILURES) {
        await this.acquireForBackground(() => this.fetchDurationChunk(chunk, generation));
        continue;
      }
      return;
    }
  }

  private async prefetchTrack(targetId: string): Promise<void> {
    const track = this.tracks.get(targetId);
    if (!track || this.audioCache.has(targetId)) return;
    const generation = this.generation;
    try {
      let stream = this.freshCachedStream(targetId);
      if (!stream) {
        stream = { ...await this.extractStream(track, generation), resolvedAt: Date.now() };
        this.streamCache.set(targetId, stream);
      }
      if (this.backgroundCancelled || generation !== this.generation) return;
      await this.downloadToCache(track, stream, generation);
    } catch {
      // Only real failures suppress retries; cancellations must not.
      if (!this.backgroundCancelled && generation === this.generation) this.prefetchFailures.add(targetId);
    }
  }

  private async downloadToCache(track: StoredTrack, stream: CachedStream, generation: number): Promise<void> {
    if (this.audioCache.has(track.id)) return;
    const directory = await this.ensureCacheDirectory();
    const partial = path.join(directory, `${randomUUID()}.part`);
    const proxy = new PublicHttpsProxy(this.resolveHost);
    const controller = new AbortController();
    this.activeDownload = { controller, proxy };
    try {
      const proxyUrl = await proxy.start();
      const result = await this.downloadAudio({
        url: stream.url,
        destination: partial,
        bytesPerSecond: PREFETCH_BYTES_PER_SECOND,
        maxBytes: PREFETCH_MAX_FILE_BYTES,
        signal: controller.signal,
        proxyUrl,
      });
      if (controller.signal.aborted || generation !== this.generation || this.backgroundCancelled) return;
      if (result.bytes <= 0) return;
      const finalPath = path.join(directory, `${track.id}${mediaExtensionOf(stream.url)}`);
      await rename(partial, finalPath);
      if (generation !== this.generation || this.backgroundCancelled) {
        await rm(finalPath, { force: true }).catch(() => { /* Cache files are advisory. */ });
        return;
      }
      this.registerAudio({
        trackId: track.id,
        token: randomBytes(MEDIA_TOKEN_BYTES).toString('hex'),
        file: finalPath,
        bytes: result.bytes,
        contentType: result.contentType ?? mediaContentTypeOf(stream.url),
        title: stream.title,
        duration: stream.duration,
        accessedAt: Date.now(),
      });
    } finally {
      this.activeDownload = null;
      proxy.dispose();
      await rm(partial, { force: true }).catch(() => { /* Cache files are advisory. */ });
    }
  }

  private registerAudio(entry: CachedAudio): void {
    this.audioCache.set(entry.trackId, entry);
    this.mediaTokens.set(entry.token, entry);
    let totalBytes = 0;
    for (const cached of this.audioCache.values()) totalBytes += cached.bytes;
    const ordered = [...this.audioCache.values()].sort((first, second) => first.accessedAt - second.accessedAt);
    while (ordered.length > 0 && (ordered.length > PREFETCH_CACHE_MAX_FILES || totalBytes > PREFETCH_CACHE_MAX_BYTES)) {
      const victim = ordered.shift()!;
      totalBytes -= victim.bytes;
      if (this.audioCache.get(victim.trackId) === victim) this.audioCache.delete(victim.trackId);
      if (this.mediaTokens.get(victim.token) === victim) this.mediaTokens.delete(victim.token);
      void rm(victim.file, { force: true }).catch(() => { /* Cache files are advisory. */ });
    }
  }

  private async ensureCacheDirectory(): Promise<string> {
    if (this.cacheDirectory) return this.cacheDirectory;
    const directory = path.join(tmpdir(), `fate-ui-music-${process.pid}`);
    this.cacheDirectoryPromise ??= mkdir(directory, { recursive: true })
      .then(() => {
        this.cacheDirectory = directory;
        return directory;
      })
      .finally(() => { this.cacheDirectoryPromise = null; });
    return this.cacheDirectoryPromise;
  }

  private async acquireForBackground<T>(operation: () => Promise<T>): Promise<T> {
    while (this.operationActive) {
      if (this.backgroundCancelled) throw new Error('Background music work cancelled.');
      await new Promise((resolve) => { setTimeout(resolve, DURATION_BACKOFF_MS); });
    }
    if (this.backgroundCancelled) throw new Error('Background music work cancelled.');
    this.operationActive = true;
    try {
      return await operation();
    } finally {
      this.operationActive = false;
    }
  }

  private pendingDurationTracks(): StoredTrack[] {
    const pending: StoredTrack[] = [];
    for (const track of this.tracks.values()) {
      if (track.duration != null || this.durationAttempted.has(track.id)) continue;
      pending.push(track);
      if (pending.length >= DURATION_BATCH_SIZE) break;
    }
    return pending;
  }

  private async fetchDurationChunk(chunk: readonly StoredTrack[], generation: number): Promise<void> {
    for (const track of chunk) this.durationAttempted.add(track.id);
    try {
      this.publishDurations(await this.fetchDurations(chunk, generation));
      this.durationFailures = 0;
    } catch {
      this.durationFailures += 1;
    }
  }

  private async fetchDurations(chunk: readonly StoredTrack[], generation: number): Promise<readonly MusicDurationUpdate[]> {
    const urlToTrackId = new Map<string, string>();
    for (const track of chunk) {
      try {
        urlToTrackId.set(await this.validateUrl(track.sourceUrl, 2_048, generation), track.id);
      } catch {
        // Skip tracks whose source no longer validates; playback will report them.
      }
    }
    if (urlToTrackId.size === 0) return [];
    const stdout = await this.runExtractor([
      '--skip-download',
      '--no-playlist',
      '--flat-playlist',
      '--ignore-errors',
      '--dump-json',
      '--',
      ...urlToTrackId.keys(),
    ], { timeoutMs: METADATA_TIMEOUT_MS, maxBuffer: JSON_BUFFER_BYTES });
    if (generation !== this.generation) return [];
    const updates: MusicDurationUpdate[] = [];
    for (const line of stdout.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: Record<string, unknown> | null;
      try {
        entry = recordOf(JSON.parse(trimmed));
      } catch {
        continue;
      }
      if (!entry) continue;
      const duration = durationOf(entry.duration);
      if (duration === null) continue;
      const trackId = this.trackIdOfEntry(entry, urlToTrackId);
      if (trackId) updates.push({ trackId, duration });
    }
    return updates;
  }

  private trackIdOfEntry(entry: Record<string, unknown>, urlToTrackId: ReadonlyMap<string, string>): string | null {
    for (const key of ['webpage_url', 'original_url', 'url'] as const) {
      const raw = entry[key];
      if (typeof raw !== 'string') continue;
      try {
        const trackId = urlToTrackId.get(parseHttpsUrl(raw, 2_048).toString());
        if (trackId) return trackId;
      } catch {
        // Try the next URL field.
      }
    }
    return null;
  }

  private publishDurations(updates: readonly MusicDurationUpdate[]): void {
    const applied: MusicDurationUpdate[] = [];
    for (const update of updates) {
      const track = this.tracks.get(update.trackId);
      if (!track || track.duration != null) continue;
      track.duration = update.duration;
      applied.push(update);
    }
    this.emitDurations(applied);
  }

  private emitDurations(updates: readonly MusicDurationUpdate[]): void {
    if (updates.length === 0 || !this.durationSink) return;
    try {
      this.durationSink(updates);
    } catch {
      // Duration updates are advisory; the renderer keeps its own fallback.
    }
  }
}
