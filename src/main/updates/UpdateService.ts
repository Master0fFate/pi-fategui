import { createHash } from 'node:crypto';
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

export function releaseChecksumsUrl(version: string): string {
  return `${RELEASE_DOWNLOAD_BASE}/v${version}/SHA256SUMS`;
}

const sha256HexPattern = /^[0-9a-f]{64}$/iu;
const sha256SumsLinePattern = /^([0-9a-f]{64})(?: {2}| \*)(.+)$/iu;

/** Parse a published SHA256SUMS file (`<hex>  <name>` or `<hex> *<name>`). */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = sha256SumsLinePattern.exec(line);
    if (!match) continue;
    const digest = match[1]!.toLowerCase();
    const name = match[2]!.trim();
    if (!sha256HexPattern.test(digest) || name.length === 0) continue;
    sums.set(name, digest);
  }
  return sums;
}

export function digestForAsset(sums: Map<string, string>, assetName: string): string | null {
  return sums.get(assetName) ?? null;
}

export const updateVerifyMessages = {
  checksumsUnavailable: 'The update checksum list could not be downloaded. Installation was refused.',
  checksumsInvalid: 'The update checksum list is invalid. Installation was refused.',
  digestMissing: 'The update checksum list does not include this installer. Installation was refused.',
  mismatch: 'The update file failed checksum verification. The downloaded file was deleted and was not installed.',
} as const;

/** Canonical macOS application bundle name and install location. */
export const MACOS_APP_BUNDLE_NAME = 'fate-ui.app';
export const MACOS_INSTALL_DIR = '/Applications';
/** Canonical macOS launcher executable inside a bundle's Contents/MacOS. */
export const MACOS_EXECUTABLE_NAME = 'fate-ui';
/** Bundles left behind by earlier updaters; removed best-effort after a successful install. */
export const MACOS_LEGACY_APP_BUNDLE_NAMES = ['Fate UI.app'] as const;

export interface MacOSBundleDirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
}

/** Lists a directory's entries with their type, mirroring fs.Dirent. */
export type ReadMacOSBundleDir = (directoryPath: string) => Promise<readonly MacOSBundleDirEntry[]>;

export interface MacOSBundleResolution {
  /** Absolute path of the staged .app bundle inside the mount point. */
  readonly sourceApp: string;
  /** Install destination derived from the staged bundle's own name. */
  readonly targetApp: string;
  /** Executable file name inside the bundle's Contents/MacOS directory. */
  readonly executableName: string;
}

export interface ResolveMacOSBundleOptions {
  /** Expected bundle basename; defaults to the canonical product name. */
  readonly expectedName?: string;
  /** Install directory; defaults to /Applications. */
  readonly installDir?: string;
}

/**
 * Resolve the staged application bundle inside a mounted macOS disk image.
 *
 * The bundle name shipped inside an update DMG is not guaranteed to match the
 * canonical product name, so the staged .app directory is discovered instead
 * of assuming a fixed path. Anything that is not a genuine application bundle
 * (no Contents/MacOS executable) is rejected, so an update never copies an
 * arbitrary file or folder. The bundle is installed under its own staged name
 * and the launcher executable is resolved from Contents/MacOS, so the copy and
 * the relaunch always refer to the bundle that was actually shipped.
 */
export async function resolveMacOSUpdateBundle(
  mountPoint: string,
  readDir: ReadMacOSBundleDir,
  options: ResolveMacOSBundleOptions = {},
): Promise<MacOSBundleResolution> {
  const expectedName = options.expectedName ?? MACOS_APP_BUNDLE_NAME;
  const installDir = options.installDir ?? MACOS_INSTALL_DIR;
  const entries = await readDir(mountPoint);
  const candidates = entries.filter((entry) => entry.isDirectory && entry.name.toLowerCase().endsWith('.app'));
  const expected = candidates.find((entry) => entry.name === expectedName);
  // If the canonical bundle is absent, accept exactly one alternative bundle.
  // More than one unknown bundle is ambiguous and must be rejected by hand.
  const chosen = expected ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!chosen) {
    const found = candidates.map((entry) => entry.name).join(', ') || 'none';
    throw new Error(`The macOS update disk image has no application bundle to install (found: ${found}).`);
  }
  const sourceApp = path.posix.join(mountPoint, chosen.name);
  let executables: readonly MacOSBundleDirEntry[];
  try {
    executables = await readDir(path.posix.join(sourceApp, 'Contents', 'MacOS'));
  } catch {
    throw new Error(`The staged bundle "${chosen.name}" is not a valid macOS application.`);
  }
  const executableFiles = executables.filter((entry) => entry.isFile);
  if (executableFiles.length === 0) {
    throw new Error(`The staged bundle "${chosen.name}" is not a valid macOS application.`);
  }
  const preferred = executableFiles.find((entry) => entry.name === MACOS_EXECUTABLE_NAME);
  let executableName: string | undefined = preferred?.name;
  if (!executableName && executableFiles.length === 1) executableName = executableFiles[0]!.name;
  if (!executableName) {
    throw new Error(`The staged bundle "${chosen.name}" does not expose exactly one launcher executable.`);
  }
  return { sourceApp, targetApp: path.posix.join(installDir, chosen.name), executableName };
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
    const assetName = platformAssetName(parsed.normalized, this.platform, this.arch);
    const url = releaseDownloadUrl(parsed.normalized, this.platform, this.arch);
    const targetPath = path.join(this.downloadDir, assetName);
    await this.removeFile(targetPath);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.downloadTimeoutMs);
    timeout.unref?.();
    try {
      const expectedDigest = await this.readExpectedDigest(parsed.normalized, assetName, controller.signal);
      const download = await this.fetchAsset(url, { signal: controller.signal });
      if (!download.ok || !download.body) throw new Error(`The update download could not start (HTTP ${download.status}).`);
      const actualDigest = await this.streamDownload(download, targetPath, parsed.normalized);
      if (actualDigest !== expectedDigest) {
        await this.removeFile(targetPath).catch(() => undefined);
        throw new Error(updateVerifyMessages.mismatch);
      }
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') throw new Error('The update download timed out. Check your connection and try again.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    await this.launchInstaller(targetPath, parsed.normalized);
  }

  private async readExpectedDigest(version: string, assetName: string, signal: AbortSignal): Promise<string> {
    let remoteText: string;
    try {
      const response = await this.fetchVersion(releaseChecksumsUrl(version), {
        signal,
        headers: { 'cache-control': 'no-cache', 'user-agent': 'Fate-UI-update-check' },
      });
      if (!response.ok) throw new Error(updateVerifyMessages.checksumsUnavailable);
      remoteText = await response.text();
    } catch (error) {
      if (error instanceof Error && error.message === updateVerifyMessages.checksumsUnavailable) throw error;
      if ((error as { name?: string })?.name === 'AbortError') throw error;
      throw new Error(updateVerifyMessages.checksumsUnavailable);
    }
    const digest = digestForAsset(parseSha256Sums(remoteText), assetName);
    if (!digest) {
      throw new Error(remoteText.trim().length === 0 ? updateVerifyMessages.checksumsInvalid : updateVerifyMessages.digestMissing);
    }
    return digest;
  }

  private async streamDownload(download: UpdateAssetDownload, targetPath: string, version: string): Promise<string> {
    const file = createWriteStream(targetPath);
    const hash = createHash('sha256');
    const total = download.total;
    let downloaded = 0;
    const report = () => {
      this.reportProgress?.({ downloaded, total, percent: total > 0 ? Math.min(1, downloaded / total) : 0, version });
    };
    try {
      for await (const chunk of download.body) {
        hash.update(chunk);
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
    return hash.digest('hex');
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
