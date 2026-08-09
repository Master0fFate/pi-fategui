import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { UpdateCheckResult } from '../../shared/contracts/ipc';

export const REMOTE_VERSION_URL = 'https://raw.githubusercontent.com/Master0fFate/pi-fategui/main/PRODVER';
export const RELEASES_URL = 'https://github.com/Master0fFate/pi-fategui/releases';
export const RELEASE_DOWNLOAD_BASE = 'https://github.com/Master0fFate/pi-fategui/releases/download';
export const UPDATE_CHECK_TIMEOUT_MS = 10_000;
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export interface UpdateDownloadProgress {
  downloaded: number;
  total: number;
  percent: number;
  version: string;
}

export interface UpdateAssetDownload {
  ok: boolean;
  status: number;
  total: number;
  body: AsyncIterable<Uint8Array>;
}

export type FetchUpdateAsset = (url: string, init: { signal: AbortSignal }) => Promise<UpdateAssetDownload>;
export type LaunchUpdateInstaller = (filePath: string, version: string) => Promise<void>;
export type ReportUpdateProgress = (progress: UpdateDownloadProgress) => void;

/** Resolve the GitHub release asset filename for a platform/arch. */
export function platformAssetName(version: string, platform: string = process.platform, arch: string = process.arch): string {
  if (platform === 'win32') return `Fate-UI-${version}-Windows-${arch}.exe`;
  if (platform === 'darwin') return `Fate-UI-${version}-macOS-${arch}.dmg`;
  if (platform === 'linux') return `Fate-UI-${version}-Linux-${arch}.AppImage`;
  throw new Error(`Updates are unavailable for platform ${platform}.`);
}

export function releaseDownloadUrl(version: string, platform: string = process.platform, arch: string = process.arch): string {
  return `${RELEASE_DOWNLOAD_BASE}/v${version}/${platformAssetName(version, platform, arch)}`;
}

export const updateMessages = {
  localUnreadable: 'Cannot read local version. Please reinstall FateGUI.',
  localInvalid: 'The local version information is invalid. Please reinstall FateGUI.',
  remoteUnavailable: 'Unable to check for updates. Please check your internet connection and try again.',
  remoteInvalid: 'The update server returned invalid version information.',
  current: 'FateGUI is up to date.',
  available: 'Update available. Click to download.',
  development: 'You are running a newer or development version of FateGUI.',
} as const;

interface SemanticVersion {
  core: readonly [bigint, bigint, bigint];
  prerelease: readonly string[] | null;
  normalized: string;
}

interface VersionResponse {
  ok: boolean;
  text: () => Promise<string>;
}

type FetchVersion = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<VersionResponse>;
type ReadVersionFile = (filePath: string) => Promise<string>;
type OpenExternal = (url: string) => Promise<void>;

const semanticVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const numericIdentifierPattern = /^(?:0|[1-9]\d*)$/u;

export function parseSemanticVersion(value: string): SemanticVersion | null {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 100) return null;
  const match = semanticVersionPattern.exec(normalized);
  if (!match) return null;
  return {
    core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)],
    prerelease: match[4]?.split('.') ?? null,
    normalized,
  };
}

function comparePrerelease(left: readonly string[] | null, right: readonly string[] | null): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = numericIdentifierPattern.test(leftIdentifier);
    const rightNumeric = numericIdentifierPattern.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function compareSemanticVersions(left: SemanticVersion, right: SemanticVersion): number {
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index]! < right.core[index]!) return -1;
    if (left.core[index]! > right.core[index]!) return 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export interface UpdateServiceOptions {
  fetchVersion?: FetchVersion;
  openExternal?: OpenExternal;
  readVersionFile?: ReadVersionFile;
  remoteVersionUrl?: string;
  timeoutMs?: number;
  fetchAsset?: FetchUpdateAsset;
  launchInstaller?: LaunchUpdateInstaller;
  reportProgress?: ReportUpdateProgress;
  downloadDir?: string;
  platform?: string;
  arch?: string;
  downloadTimeoutMs?: number;
  removeFile?: (path: string) => Promise<void>;
}

export class UpdateService {
  private readonly fetchVersion: FetchVersion;
  private readonly openExternal: OpenExternal;
  private readonly readVersionFile: ReadVersionFile;
  private readonly remoteVersionUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchAsset: FetchUpdateAsset;
  private readonly launchInstaller: LaunchUpdateInstaller;
  private readonly reportProgress: ReportUpdateProgress | undefined;
  private readonly downloadDir: string;
  private readonly platform: string;
  private readonly arch: string;
  private readonly downloadTimeoutMs: number;
  private readonly removeFile: (path: string) => Promise<void>;

  constructor(private readonly localVersionPath: string, options: UpdateServiceOptions = {}) {
    this.fetchVersion = options.fetchVersion ?? ((url, init) => fetch(url, init));
    this.openExternal = options.openExternal ?? (async () => { throw new Error('The releases page opener is unavailable.'); });
    this.readVersionFile = options.readVersionFile ?? ((filePath) => fs.readFile(filePath, 'utf8'));
    this.remoteVersionUrl = options.remoteVersionUrl ?? REMOTE_VERSION_URL;
    this.timeoutMs = options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS;
    this.fetchAsset = options.fetchAsset ?? defaultFetchAsset;
    this.launchInstaller = options.launchInstaller ?? defaultLaunchInstaller;
    this.reportProgress = options.reportProgress;
    this.downloadDir = options.downloadDir ?? defaultDownloadDir();
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? UPDATE_DOWNLOAD_TIMEOUT_MS;
    this.removeFile = options.removeFile ?? ((filePath) => fs.rm(filePath, { force: true }));
  }

  async check(): Promise<UpdateCheckResult> {
    let localText: string;
    try {
      localText = await this.readVersionFile(this.localVersionPath);
    } catch {
      return { status: 'local-unreadable', message: updateMessages.localUnreadable };
    }
    const localVersion = parseSemanticVersion(localText);
    if (!localVersion) return { status: 'local-invalid', message: updateMessages.localInvalid };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    let remoteText: string;
    try {
      const response = await this.fetchVersion(this.remoteVersionUrl, {
        signal: controller.signal,
        headers: { 'cache-control': 'no-cache', 'user-agent': 'Fate-UI-update-check' },
      });
      if (!response.ok) return { status: 'remote-unavailable', message: updateMessages.remoteUnavailable };
      remoteText = await response.text();
    } catch {
      return { status: 'remote-unavailable', message: updateMessages.remoteUnavailable };
    } finally {
      clearTimeout(timeout);
    }

    const remoteVersion = parseSemanticVersion(remoteText);
    if (!remoteVersion) return { status: 'remote-invalid', message: updateMessages.remoteInvalid };
    const comparison = compareSemanticVersions(localVersion, remoteVersion);
    if (comparison < 0) {
      return {
        status: 'available',
        message: updateMessages.available,
        installedVersion: localVersion.normalized,
        productionVersion: remoteVersion.normalized,
      };
    }
    if (comparison > 0) {
      return {
        status: 'development',
        message: updateMessages.development,
        installedVersion: localVersion.normalized,
        productionVersion: remoteVersion.normalized,
      };
    }
    return {
      status: 'current',
      message: `${updateMessages.current} Installed version: ${localVersion.normalized}`,
      installedVersion: localVersion.normalized,
      productionVersion: remoteVersion.normalized,
    };
  }

  async openDownload(): Promise<void> {
    await this.openExternal(RELEASES_URL);
  }

  /**
   * Download the installer for the given version that matches this platform,
   * then hand it to the launcher hook (which installs and relaunches). Throws
   * on any failure so the IPC layer can surface a toast. The download streams
   * to disk and reports progress via the injected sink.
   */
  async downloadAndInstall(version: string): Promise<void> {
    const parsed = parseSemanticVersion(version);
    if (!parsed) throw new Error('The available update version is invalid.');
    const url = releaseDownloadUrl(parsed.normalized, this.platform, this.arch);
    const targetPath = path.join(this.downloadDir, platformAssetName(parsed.normalized, this.platform, this.arch));
    await this.removeFile(targetPath);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.downloadTimeoutMs);
    timeout.unref?.();
    try {
      const download = await this.fetchAsset(url, { signal: controller.signal });
      if (!download.ok || !download.body) throw new Error(`The update download could not start (HTTP ${download.status}).`);
      await this.streamDownload(download, targetPath, parsed.normalized);
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') throw new Error('The update download timed out. Check your connection and try again.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    await this.launchInstaller(targetPath, parsed.normalized);
  }

  private async streamDownload(download: UpdateAssetDownload, targetPath: string, version: string): Promise<void> {
    const file = createWriteStream(targetPath);
    const total = download.total;
    let downloaded = 0;
    const report = () => {
      this.reportProgress?.({ downloaded, total, percent: total > 0 ? Math.min(1, downloaded / total) : 0, version });
    };
    try {
      for await (const chunk of download.body) {
        await new Promise<void>((resolve, reject) => {
          file.write(chunk, (error) => (error ? reject(error) : resolve()));
        });
        downloaded += chunk.length;
        report();
      }
      await new Promise<void>((resolve, reject) => {
        file.end((error: Error | null | undefined) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      file.destroy();
      await this.removeFile(targetPath).catch(() => undefined);
      throw error;
    }
  }
}

const emptyAsyncIterable: AsyncIterable<Uint8Array> = {
  async *[Symbol.asyncIterator]() { /* no body */ },
};

async function defaultFetchAsset(url: string, init: { signal: AbortSignal }): Promise<UpdateAssetDownload> {
  const { Readable } = await import('node:stream');
  let response: Response;
  try {
    response = await fetch(url, { signal: init.signal, redirect: 'follow', headers: { 'user-agent': 'Fate-UI-update-check' } });
  } catch {
    return { ok: false, status: 0, total: 0, body: emptyAsyncIterable };
  }
  if (!response.ok || !response.body) return { ok: false, status: response.status, total: 0, body: emptyAsyncIterable };
  const total = Number(response.headers.get('content-length') ?? 0);
  return { ok: true, status: response.status, total, body: Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]) as unknown as AsyncIterable<Uint8Array> };
}

function defaultDownloadDir(): string {
  return require('node:os').tmpdir();
}

async function defaultLaunchInstaller(): Promise<void> {
  throw new Error('The update installer launcher is unavailable.');
}
