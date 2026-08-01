import { promises as fs } from 'node:fs';
import type { UpdateCheckResult } from '../../shared/contracts/ipc';

export const REMOTE_VERSION_URL = 'https://raw.githubusercontent.com/Master0fFate/pi-fategui/main/PRODVER';
export const RELEASES_URL = 'https://github.com/Master0fFate/pi-fategui/releases';
export const UPDATE_CHECK_TIMEOUT_MS = 10_000;

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
}

export class UpdateService {
  private readonly fetchVersion: FetchVersion;
  private readonly openExternal: OpenExternal;
  private readonly readVersionFile: ReadVersionFile;
  private readonly remoteVersionUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly localVersionPath: string, options: UpdateServiceOptions = {}) {
    this.fetchVersion = options.fetchVersion ?? ((url, init) => fetch(url, init));
    this.openExternal = options.openExternal ?? (async () => { throw new Error('The releases page opener is unavailable.'); });
    this.readVersionFile = options.readVersionFile ?? ((filePath) => fs.readFile(filePath, 'utf8'));
    this.remoteVersionUrl = options.remoteVersionUrl ?? REMOTE_VERSION_URL;
    this.timeoutMs = options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS;
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
}
