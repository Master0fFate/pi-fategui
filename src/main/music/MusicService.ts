import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Resolver } from 'node:dns';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';
import type { MusicQueue, MusicStatus, MusicStream, MusicTrack } from '../../shared/contracts/ipc';

const MAX_TRACKS = 200;
const METADATA_TIMEOUT_MS = 45_000;
const STREAM_TIMEOUT_MS = 30_000;
const DNS_TIMEOUT_MS = 5_000;
const JSON_BUFFER_BYTES = 8 * 1024 * 1024;
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

function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a = 0, b = 0, c = 0] = octets;
  return !(
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
  );
}

function isPublicIpAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isPublicIpv4(address);
  if (kind !== 6) return false;
  const normalized = address.toLocaleLowerCase();
  if (normalized.startsWith('::ffff:')) return isPublicIpv4(normalized.slice(7));
  const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
  return !(
    normalized === '::'
    || normalized === '::1'
    || (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80
    || (first & 0xff00) === 0xff00
    || normalized.startsWith('2001:db8:')
    || normalized.startsWith('2002:')
    || normalized.startsWith('64:ff9b:')
  );
}

function parseHttpsUrl(rawUrl: string, maximumLength: number): URL {
  if (rawUrl.length > maximumLength) throw new Error('The media link is too long.');
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Enter a complete HTTPS media link.');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLocaleLowerCase();
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

async function validatePublicHttpsUrl(rawUrl: string, maximumLength: number, resolveHost: MusicHostResolver, parentSignal?: AbortSignal): Promise<string> {
  const parsed = parseHttpsUrl(rawUrl, maximumLength);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!isIP(hostname)) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    parentSignal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, DNS_TIMEOUT_MS);
    timeout.unref();
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('DNS timeout or cancellation')), { once: true });
      });
      const addresses = await Promise.race([resolveHost(hostname, controller.signal), aborted]);
      if (addresses.length === 0 || addresses.some((address) => !isPublicIpAddress(address))) {
        throw new Error('Local and private network media links are blocked.');
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('private network')) throw error;
      throw new Error('The media host could not be reached.');
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abort);
      controller.abort();
    }
  }
  return parsed.toString();
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

interface StoredTrack extends MusicTrack {
  sourceUrl: string;
}

export class MusicService {
  private tracks = new Map<string, StoredTrack>();
  private statusPromise: Promise<MusicStatus> | null = null;
  private operationActive = false;
  private generation = 0;
  private activeDnsController: AbortController | null = null;

  constructor(
    private readonly runner: MusicProcessRunner = new YtDlpProcessRunner(),
    private readonly resolveHost: MusicHostResolver = defaultHostResolver,
  ) {}

  getStatus(): Promise<MusicStatus> {
    this.statusPromise ??= this.checkStatus();
    return this.statusPromise;
  }

  async load(rawUrl: string): Promise<MusicQueue> {
    await this.requireAvailable();
    return this.exclusive(async () => {
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
  }

  async resolveTrack(trackId: string): Promise<MusicStream> {
    await this.requireAvailable();
    return this.exclusive(async () => {
      const generation = this.generation;
      const track = this.tracks.get(trackId);
      if (!track) throw new Error('This track is no longer in the active playlist. Load the link again.');
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
      return {
        trackId,
        title: cleanText(metadata.title, track.title),
        duration: durationOf(metadata.duration) ?? track.duration,
        url: streamUrl,
      };
    });
  }

  clearQueue(): void {
    this.generation += 1;
    this.tracks.clear();
    this.activeDnsController?.abort();
    this.activeDnsController = null;
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
    try {
      return await this.runner.run(args, limits);
    } catch (error) {
      if (error instanceof MusicProcessError && error.kind === 'timeout') {
        throw new Error('yt-dlp took too long to read this link. Try again or use a smaller playlist.');
      }
      if (error instanceof MusicProcessError && error.kind === 'not-found') {
        throw new Error('yt-dlp is unavailable. Install it on PATH, then restart Fate UI.');
      }
      throw new Error('yt-dlp could not resolve this media. Check the link, access requirements, or yt-dlp version.');
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.operationActive) throw new Error('Another music link is still being resolved.');
    this.operationActive = true;
    try {
      return await operation();
    } finally {
      this.operationActive = false;
    }
  }
}
