import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compareSemanticVersions, parseSemanticVersion, RELEASES_URL, UpdateService, resolveMacOSUpdateBundle, updateMessages } from './UpdateService';

const parsed = (value: string) => {
  const version = parseSemanticVersion(value);
  if (!version) throw new Error(`Expected ${value} to be valid.`);
  return version;
};

const response = (body: string, ok = true) => ({ ok, text: vi.fn(async () => body) });

function service(local: string | Error, remote: string | Error, options: { timeoutMs?: number; openExternal?: (url: string) => Promise<void> } = {}) {
  return new UpdateService('/installed/PRODVER', {
    readVersionFile: vi.fn(async () => {
      if (local instanceof Error) throw local;
      return local;
    }),
    fetchVersion: async (_url, init) => {
      if (remote instanceof Error) throw remote;
      if (remote === 'TIMEOUT') {
        return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      }
      return response(remote);
    },
    ...(options.openExternal ? { openExternal: options.openExternal } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

describe('semantic version handling', () => {
  it('trims and validates standard releases and prereleases', () => {
    expect(parseSemanticVersion('  1.4.0\r\n')?.normalized).toBe('1.4.0');
    expect(parseSemanticVersion('0.4.1-beta2')?.normalized).toBe('0.4.1-beta2');
    expect(parseSemanticVersion('1.2.3-beta.10+build.7')?.normalized).toBe('1.2.3-beta.10+build.7');
    for (const invalid of ['', '1.4', '1.4.0.0', '01.4.0', '1.04.0', 'v1.4.0', '1.4.0-beta.01', 'not-a-version', `1.0.0-${'x'.repeat(101)}`]) {
      expect(parseSemanticVersion(invalid)).toBeNull();
    }
  });

  it('compares numeric components and SemVer prerelease identifiers correctly', () => {
    expect(compareSemanticVersions(parsed('1.10.0'), parsed('1.9.0'))).toBe(1);
    expect(compareSemanticVersions(parsed('2.0.0'), parsed('10.0.0'))).toBe(-1);
    expect(compareSemanticVersions(parsed('1.0.0-beta.10'), parsed('1.0.0-beta.9'))).toBe(1);
    expect(compareSemanticVersions(parsed('1.0.0-beta'), parsed('1.0.0'))).toBe(-1);
    expect(compareSemanticVersions(parsed('1.0.0+local'), parsed('1.0.0+remote'))).toBe(0);
  });
});

describe('UpdateService', () => {
  it('distinguishes unreadable and malformed local version files', async () => {
    await expect(service(new Error('missing'), '1.0.0').check()).resolves.toEqual({
      status: 'local-unreadable', message: updateMessages.localUnreadable,
    });
    await expect(service('  \r\n', '1.0.0').check()).resolves.toEqual({
      status: 'local-invalid', message: updateMessages.localInvalid,
    });
    await expect(service('version one', '1.0.0').check()).resolves.toEqual({
      status: 'local-invalid', message: updateMessages.localInvalid,
    });
  });

  it('distinguishes unreachable and malformed remote version files', async () => {
    await expect(service('1.0.0', new Error('offline')).check()).resolves.toEqual({
      status: 'remote-unavailable', message: updateMessages.remoteUnavailable,
    });
    await expect(service('1.0.0', 'broken').check()).resolves.toEqual({
      status: 'remote-invalid', message: updateMessages.remoteInvalid,
    });
  });

  it('times out a stalled remote request without throwing', async () => {
    await expect(service('1.0.0', 'TIMEOUT', { timeoutMs: 5 }).check()).resolves.toEqual({
      status: 'remote-unavailable', message: updateMessages.remoteUnavailable,
    });
  });

  it('reports current, available, and development versions explicitly', async () => {
    await expect(service(' 1.4.0\n', '1.4.0\n').check()).resolves.toEqual({
      status: 'current',
      message: 'FateGUI is up to date. Installed version: 1.4.0',
      installedVersion: '1.4.0',
      productionVersion: '1.4.0',
    });
    await expect(service('1.9.0', '1.10.0').check()).resolves.toMatchObject({
      status: 'available', message: updateMessages.available, installedVersion: '1.9.0', productionVersion: '1.10.0',
    });
    await expect(service('2.0.0', '1.10.0').check()).resolves.toMatchObject({
      status: 'development', message: updateMessages.development, installedVersion: '2.0.0', productionVersion: '1.10.0',
    });
  });

  it('opens only the official releases page', async () => {
    const openExternal = vi.fn(async () => undefined);
    const updates = service('1.0.0', '1.0.0', { openExternal });
    await updates.openDownload();
    expect(openExternal).toHaveBeenCalledWith(RELEASES_URL);
  });
});

describe('UpdateService download and install', () => {
  it('downloads the platform installer, reports progress, then launches it', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'fate-update-'));
    const chunks = [Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5])];
    const fetchAsset = vi.fn(async () => ({ ok: true, status: 200, total: 5, body: (async function* () { for (const c of chunks) yield c; })() }));
    const launchInstaller = vi.fn(async () => undefined);
    const reportProgress = vi.fn();
    const removeFile = vi.fn(async () => undefined);
    const updates = new UpdateService('/installed/PRODVER', {
      fetchAsset, launchInstaller, reportProgress, removeFile, downloadDir: tmp, platform: 'win32', arch: 'x64',
    });

    await updates.downloadAndInstall('0.8.10-beta14');

    expect(fetchAsset).toHaveBeenCalledWith(
      'https://github.com/Master0fFate/pi-fategui/releases/download/v0.8.10-beta14/Fate-UI-0.8.10-beta14-Windows-x64.exe',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const fetchCalls = fetchAsset.mock.calls as unknown as Array<[string, unknown]>;
    expect(reportProgress).toHaveBeenCalledWith(expect.objectContaining({ downloaded: 5, total: 5, percent: 1, version: '0.8.10-beta14' }));
    expect(launchInstaller).toHaveBeenCalledTimes(1);
    const launchCalls = launchInstaller.mock.calls as unknown as Array<[string, string]>;
    expect(launchCalls[0]![0]).toMatch(/Fate-UI-0\.8\.10-beta14-Windows-x64\.exe$/);
    expect(launchCalls[0]![1]).toBe('0.8.10-beta14');
  });

  it('selects the macOS DMG and Linux AppImage for their platforms', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'fate-update-'));
    const fetchAsset = vi.fn(async () => ({ ok: true, status: 200, total: 0, body: (async function* () { /* empty */ })() }));
    const launchInstaller = vi.fn(async () => undefined);
    const removeFile = vi.fn(async () => undefined);
    const fetchCalls = fetchAsset.mock.calls as unknown as Array<[string, unknown]>;
    const mac = new UpdateService('/p', { fetchAsset, launchInstaller, removeFile, downloadDir: tmp, platform: 'darwin', arch: 'arm64' });
    await mac.downloadAndInstall('1.0.0');
    expect(fetchCalls[fetchCalls.length - 1]![0]).toContain('Fate-UI-1.0.0-macOS-arm64.dmg');
    const linux = new UpdateService('/p', { fetchAsset, launchInstaller, removeFile, downloadDir: tmp, platform: 'linux', arch: 'x64' });
    await linux.downloadAndInstall('1.0.0');
    expect(fetchCalls[fetchCalls.length - 1]![0]).toContain('Fate-UI-1.0.0-Linux-x64.AppImage');
  });

  it('throws when the asset download fails to start', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'fate-update-'));
    const fetchAsset = vi.fn(async () => ({ ok: false, status: 404, total: 0, body: (async function* () { /* empty */ })() }));
    const updates = new UpdateService('/p', { fetchAsset, launchInstaller: vi.fn(async () => undefined), removeFile: vi.fn(async () => undefined), downloadDir: tmp, platform: 'win32', arch: 'x64' });
    await expect(updates.downloadAndInstall('1.0.0')).rejects.toThrow(/could not start/i);
  });
});

describe('resolveMacOSUpdateBundle', () => {
  const entry = (name: string, kind: 'file' | 'dir') => ({ name, isDirectory: kind === 'dir', isFile: kind === 'file' });

  it('prefers the canonical bundle name when it is present in the disk image', async () => {
    const readDir = vi.fn(async (directoryPath: string) => {
      if (directoryPath === '/mount') return [entry('Fate UI.app', 'dir'), entry('Applications', 'dir')];
      return [entry('fate-ui', 'file')];
    });
    await expect(resolveMacOSUpdateBundle('/mount', readDir)).resolves.toEqual({
      sourceApp: '/mount/Fate UI.app',
      targetApp: '/Applications/Fate UI.app',
    });
  });

  it('selects the actual staged bundle when its name differs from the expected name', async () => {
    // Models the reported failure: the DMG ships a differently-named bundle,
    // so the old hardcoded /mount/Fate UI.app path did not exist.
    const readDir = vi.fn(async (directoryPath: string) => {
      if (directoryPath === '/mount') return [entry('Fate GUI.app', 'dir')];
      return [entry('fate-ui', 'file')];
    });
    const result = await resolveMacOSUpdateBundle('/mount', readDir);
    expect(result.sourceApp).toBe('/mount/Fate GUI.app');
    // Installed under the canonical name so the relaunch path stays stable.
    expect(result.targetApp).toBe('/Applications/Fate UI.app');
  });

  it('rejects an ambiguous disk image that contains multiple unknown bundles', async () => {
    const readDir = vi.fn(async () => [entry('Alpha.app', 'dir'), entry('Beta.app', 'dir')]);
    await expect(resolveMacOSUpdateBundle('/mount', readDir)).rejects.toThrow(/no application bundle/i);
    // Nothing past discovery runs, so no copy of an arbitrary bundle happens.
    expect(readDir.mock.calls).toHaveLength(1);
  });

  it('refuses to copy a staged entry that is not a valid application bundle', async () => {
    const readDir = vi.fn(async (directoryPath: string) => {
      if (directoryPath === '/mount') return [entry('Fate UI.app', 'dir')];
      return []; // Contents/MacOS is empty, so this is not a real bundle.
    });
    await expect(resolveMacOSUpdateBundle('/mount', readDir)).rejects.toThrow(/not a valid macOS application/i);
  });

  it('refuses a staged .app whose Contents/MacOS directory is missing', async () => {
    const readDir = vi.fn(async (directoryPath: string) => {
      if (directoryPath === '/mount') return [entry('Fate UI.app', 'dir')];
      throw new Error('ENOENT');
    });
    await expect(resolveMacOSUpdateBundle('/mount', readDir)).rejects.toThrow(/not a valid macOS application/i);
  });

  it('rejects a disk image that has no bundle at all', async () => {
    const readDir = vi.fn(async () => [entry('readme.txt', 'file')]);
    await expect(resolveMacOSUpdateBundle('/mount', readDir)).rejects.toThrow(/no application bundle/i);
  });
});
