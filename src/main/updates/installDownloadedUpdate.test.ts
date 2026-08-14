import { describe, expect, it, vi } from 'vitest';
import { createUpdateInstaller, type UpdateInstallerAdapters } from './installDownloadedUpdate';

interface FakeRuntime {
  adapters: UpdateInstallerAdapters;
  calls: string[];
  quit: ReturnType<typeof vi.fn>;
  childUnref: ReturnType<typeof vi.fn>;
}

// macOS bundle resolution re-reads the MacOS subdir for an executable; emulate
// a mounted image that exposes the .app at the mount point and the binary inside.
function fakeReadBundleDir(directoryPath: string) {
  if (directoryPath.replace(/\\/g, '/').endsWith('MacOS')) {
    return Promise.resolve([{ name: 'fate-ui', isDirectory: false, isFile: true }]);
  }
  return Promise.resolve([{ name: 'Fate UI.app', isDirectory: true, isFile: false }]);
}

function fakeRuntime(platform: string): FakeRuntime {
  const calls: string[] = [];
  const quit = vi.fn();
  const childUnref = vi.fn();
  const adapters: UpdateInstallerAdapters = {
    spawn: (command, args) => {
      calls.push(`spawn ${[command, ...args].join(' ').replace(/\\/g, '/')}`.trim());
      return { unref: childUnref };
    },
    execFile: (file, args, callback) => {
      calls.push(`${file} ${args[0] ?? ''}`.trim());
      callback(null);
    },
    copyFile: async (source, destination) => {
      calls.push(`copyFile ${source.replace(/\\/g, '/')} ${destination.replace(/\\/g, '/')}`);
    },
    remove: async (target) => {
      calls.push(`remove ${target.replace(/\\/g, '/')}`);
    },
    readBundleDir: (directoryPath) => fakeReadBundleDir(directoryPath),
    quit,
    platform,
    execPath: '/usr/bin/fate',
    temporaryDirectory: '/tmp',
    quitDelayMs: 0,
  };
  return { adapters, calls, quit, childUnref };
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

  it('mounts, replaces the bundle, detaches, relaunches, then quits on macOS', async () => {
    const { adapters, calls, quit, childUnref } = fakeRuntime('darwin');
    await createUpdateInstaller(adapters).install('/dl/update.dmg', '1.2.3');

    expect(calls).toEqual([
      'hdiutil attach',
      'remove /Applications/Fate UI.app',
      'cp -R',
      'xattr -dr',
      'hdiutil detach',
      'spawn /Applications/Fate UI.app/Contents/MacOS/fate-ui',
    ]);
    expect(childUnref).toHaveBeenCalledTimes(1);
    await flushQuit();
    expect(quit).toHaveBeenCalledTimes(1);
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
