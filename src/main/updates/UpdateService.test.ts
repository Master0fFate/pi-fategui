import { describe, expect, it, vi } from 'vitest';
import { compareSemanticVersions, parseSemanticVersion, RELEASES_URL, UpdateService, updateMessages } from './UpdateService';

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
