import { describe, expect, it, vi } from 'vitest';
import { createUpdateInstaller, type UpdateInstallerAdapters } from './installDownloadedUpdate';

interface FakeRuntime {
  adapters: UpdateInstallerAdapters;
  calls: string[];
  quit: ReturnType<typeof vi.fn>;
  childUnref: ReturnType<typeof vi.fn>;
  warns: string[];
}

// macOS bundle resolution re-reads the MacOS subdir for an executable; emulate
// a mounted image that exposes the shipped .app at the mount point and the
// binary inside both the staged and the installed bundle.
function defaultReadBundleDir(directoryPath: string, targetMacOsOverride?: () => Array<{ name: string; isDirectory: boolean; isFile: boolean }>) {
  const normalized = directoryPath.replace(/\\/g, '/');
  if (normalized.endsWith('MacOS')) {
    if (targetMacOsOverride && normalized.startsWith('/Applications')) return Promise.resolve(targetMacOsOverride());
    return Promise.resolve([{ name: 'fate-ui', isDirectory: false, isFile: true }]);
  }
  return Promise.resolve([{ name: 'fate-ui.app', isDirectory: true, isFile: false }]);
}

function fakeRuntime(platform: string, overrides: {
  removeErrorFor?: (target: string) => boolean;
  spawnOutcome?: 'spawn' | 'error';
  targetMacOs?: () => Array<{ name: string; isDirectory: boolean; isFile: boolean }>;
  installDir?: string;
} = {}): FakeRuntime {
  const calls: string[] = [];
  const quit = vi.fn();
  const childUnref = vi.fn();
  const warns: string[] = [];
  const adapters: UpdateInstallerAdapters = {
    spawn: (command, args) => {
      calls.push(`spawn ${[command, ...args].join(' ').replace(/\\/g, '/')}`.trim());
      const listeners: Array<{ event: 'spawn' | 'error'; listener: (error?: Error) => void }> = [];
      queueMicrotask(() => {
        for (const entry of listeners) {
          if (entry.event === 'spawn' && overrides.spawnOutcome !== 'error') entry.listener();
          if (entry.event === 'error' && overrides.spawnOutcome === 'error') entry.listener(new Error('spawn ENOENT'));
        }
      });
      return { unref: childUnref, on: (event, listener) => { listeners.push({ event, listener }); } };
    },
    execFile: (file, args, callback) => {
      calls.push(`${file} ${args[0] ?? ''}`.trim());
      callback(null);
    },
    copyFile: async (source, destination) => {
      calls.push(`copyFile ${source.replace(/\\/g, '/')} ${destination.replace(/\\/g, '/')}`);
    },
    remove: async (target) => {
      const normalized = target.replace(/\\/g, '/');
      if (overrides.removeErrorFor?.(normalized)) throw new Error('EPERM operation not permitted');
      calls.push(`remove ${normalized}`);
    },
    readBundleDir: (directoryPath) => defaultReadBundleDir(directoryPath, overrides.targetMacOs),
    quit,
    warn: (message) => { warns.push(message); },
    platform,
    execPath: '/usr/bin/fate',
    temporaryDirectory: '/tmp',
    ...(overrides.installDir !== undefined ? { installDir: overrides.installDir } : {}),
    quitDelayMs: 0,
  };
  return { adapters, calls, quit, childUnref, warns };
}

const flushQuit = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe('downloaded update installer', () => {
  it('runs the NSIS installer silently, then quits on Windows', async () => {
    const { adapters, calls, quit, childUnref } = fakeRuntime('win32');
    await createUpdateInstaller(adapters).install('/dl/setup.exe', '1.2.3');

    expect(calls).toEqual(['spawn /dl/setup.exe /S']);
    expect(childUnref).toHaveBeenCalledTimes(1);
    await flushQuit();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('mounts, replaces the shipped bundle, cleans legacy bundles, detaches, relaunches, then quits on macOS', async () => {
    const { adapters, calls, quit, childUnref } = fakeRuntime('darwin');
    await createUpdateInstaller(adapters).install('/dl/update.dmg', '1.2.3');

    expect(calls).toEqual([
      'hdiutil attach',
      'remove /Applications/fate-ui.app',
      'cp -R',
      'xattr -dr',
      'remove /Applications/Fate UI.app',
      'spawn /Applications/fate-ui.app/Contents/MacOS/fate-ui',
      'hdiutil detach',
    ]);
    expect(childUnref).toHaveBeenCalledTimes(1);
    await flushQuit();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('installs into the configured install directory instead of /Applications', async () => {
    const { adapters, calls } = fakeRuntime('darwin', { installDir: '/smoke/apps' });
    await createUpdateInstaller(adapters).install('/dl/update.dmg', '1.2.3');

    expect(calls).toContain('remove /smoke/apps/fate-ui.app');
    expect(calls).toContain('remove /smoke/apps/Fate UI.app');
    expect(calls).toContain('spawn /smoke/apps/fate-ui.app/Contents/MacOS/fate-ui');
  });

  it('aborts before copying when the installed bundle cannot be removed', async () => {
    const { adapters, calls, quit, childUnref } = fakeRuntime('darwin', {
      removeErrorFor: (target) => target === '/Applications/fate-ui.app',
    });

    await expect(createUpdateInstaller(adapters).install('/dl/update.dmg', '1.2.3')).rejects.toThrow(
      /could not be replaced.*releases page/i,
    );
    expect(calls).toEqual(['hdiutil attach', 'hdiutil detach']);
    expect(childUnref).not.toHaveBeenCalled();
    await flushQuit();
    expect(quit).not.toHaveBeenCalled();
  });

  it('refuses to relaunch when the copied bundle lacks the expected executable', async () => {
    const { adapters, calls, quit } = fakeRuntime('darwin', {
      targetMacOs: () => [],
    });

    await expect(createUpdateInstaller(adapters).install('/dl/update.dmg', '1.2.3')).rejects.toThrow(
      /did not contain the expected application executable/i,
    );
    expect(calls).toContain('cp -R');
    expect(calls.some((call) => call.startsWith('spawn'))).toBe(false);
    await flushQuit();
    expect(quit).not.toHaveBeenCalled();
  });

  it('rejects instead of crashing when the relaunch spawn fails', async () => {
    const { adapters, calls, quit, childUnref } = fakeRuntime('darwin', { spawnOutcome: 'error' });

    await expect(createUpdateInstaller(adapters).install('/dl/update.dmg', '1.2.3')).rejects.toThrow(
      /could not be relaunched.*ENOENT/i,
    );
    await flushQuit();
    expect(quit).not.toHaveBeenCalled();
  });

  it('warns but still installs when legacy bundle cleanup fails', async () => {
    const { adapters, warns, quit } = fakeRuntime('darwin', {
      removeErrorFor: (target) => target === '/Applications/Fate UI.app',
    });

    await createUpdateInstaller(adapters).install('/dl/update.dmg', '1.2.3');

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('Fate UI.app');
    await flushQuit();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('rejects a Windows relaunch failure without quitting', async () => {
    const { adapters, quit } = fakeRuntime('win32', { spawnOutcome: 'error' });

    await expect(createUpdateInstaller(adapters).install('/dl/setup.exe', '1.2.3')).rejects.toThrow(
      /could not be relaunched/i,
    );
    await flushQuit();
    expect(quit).not.toHaveBeenCalled();
  });

  it('makes the download executable, replaces the running binary, relaunches, then quits on Linux', async () => {
    const { adapters, calls, quit, childUnref } = fakeRuntime('linux');
    await createUpdateInstaller(adapters).install('/dl/update.AppImage', '1.2.3');

    expect(calls).toEqual([
      'chmod +x',
      'copyFile /dl/update.AppImage /usr/bin/fate',
      'spawn /usr/bin/fate',
    ]);
    expect(childUnref).toHaveBeenCalledTimes(1);
    await flushQuit();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('rejects on unsupported platforms without relaunching or quitting', async () => {
    const { adapters, calls, quit, childUnref } = fakeRuntime('freebsd');
    await expect(createUpdateInstaller(adapters).install('/dl/update', '1.2.3')).rejects.toThrow(
      'Auto-update is not supported on freebsd.',
    );
    expect(calls).toEqual([]);
    expect(childUnref).not.toHaveBeenCalled();
    await flushQuit();
    expect(quit).not.toHaveBeenCalled();
  });
});
