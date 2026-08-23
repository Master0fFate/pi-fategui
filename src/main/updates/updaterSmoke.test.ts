import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { UpdateInstallerAdapters } from './installDownloadedUpdate';
import { recordingSpawn, runUpdaterSmoke } from './updaterSmoke';

function darwinAdapters(overrides: Partial<UpdateInstallerAdapters> = {}): UpdateInstallerAdapters {
  return {
    spawn: recordingSpawn(() => undefined),
    execFile: (_file, _args, callback) => callback(null),
    copyFile: async () => undefined,
    remove: async () => undefined,
    readBundleDir: (directoryPath) => {
      const normalized = directoryPath.replace(/\\/g, '/');
      if (normalized.endsWith('MacOS')) return Promise.resolve([{ name: 'fate-ui', isDirectory: false, isFile: true }]);
      return Promise.resolve([{ name: 'fate-ui.app', isDirectory: true, isFile: false }]);
    },
    quit: () => undefined,
    platform: 'darwin',
    execPath: '/usr/bin/fate-ui',
    temporaryDirectory: tmpdir(),
    quitDelayMs: 0,
    ...overrides,
  };
}

describe('macOS updater smoke', () => {
  it('installs the DMG into the smoke directory and logs the relaunch target', async () => {
    const installDir = await mkdtemp(path.join(tmpdir(), 'fate-updater-smoke-'));
    const log = vi.fn();
    const error = vi.fn();
    const exit = vi.fn();

    await runUpdaterSmoke({
      dmgPath: '/dl/Fate-UI-1.0.0-macOS-arm64.dmg',
      installDir: installDir.replace(/\\/g, '/'),
      log,
      error,
      exit,
      adapters: darwinAdapters({ installDir: installDir.replace(/\\/g, '/') }),
    });

    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/^PI_DESKTOP_UPDATER_SMOKE_OK .+\/fate-ui\.app\/Contents\/MacOS\/fate-ui$/);
  });

  it('exits with a failure marker when the install is refused', async () => {
    const installDir = await mkdtemp(path.join(tmpdir(), 'fate-updater-smoke-'));
    const log = vi.fn();
    const error = vi.fn();
    const exit = vi.fn();

    await runUpdaterSmoke({
      dmgPath: '/dl/Fate-UI-1.0.0-macOS-arm64.dmg',
      installDir: installDir.replace(/\\/g, '/'),
      log,
      error,
      exit,
      adapters: darwinAdapters({
        installDir: installDir.replace(/\\/g, '/'),
        remove: async (target) => {
          if (target.replace(/\\/g, '/') === `${installDir.replace(/\\/g, '/')}/fate-ui.app`) {
            throw new Error('EPERM operation not permitted');
          }
        },
      }),
    });

    expect(log).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls[0]![0]).toMatch(/^PI_DESKTOP_UPDATER_SMOKE_FAILED .*could not be replaced/);
  });
});
