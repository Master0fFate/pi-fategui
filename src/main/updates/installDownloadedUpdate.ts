import { execFile, spawn } from 'node:child_process';
import { copyFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MACOS_APP_BUNDLE_NAME,
  MACOS_INSTALL_DIR,
  resolveMacOSUpdateBundle,
  type MacOSBundleDirEntry,
} from './UpdateService';

/**
 * Read a mounted update image as bundle entries. Kept as a standalone default
 * adapter so production wires real fs while tests inject a fake directory.
 */
export async function readMacOSBundleDir(directoryPath: string): Promise<readonly MacOSBundleDirEntry[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() }));
}

export interface DetachedChild {
  unref(): void;
}

export interface UpdateInstallerAdapters {
  /** Spawn a detached process that survives this app quitting. */
  spawn(command: string, args: readonly string[], options: { detached: true; stdio: 'ignore' }): DetachedChild;
  /** Run a platform command and notify the callback (error is null on success). */
  execFile(file: string, args: readonly string[], callback: (error: Error | null) => void): void;
  copyFile(source: string, destination: string): Promise<void>;
  remove(target: string): Promise<void>;
  readBundleDir(directoryPath: string): Promise<readonly MacOSBundleDirEntry[]>;
  /** Quit (not exit) this process so the detached installer can take over. */
  quit(): void;
  platform: string;
  execPath: string;
  temporaryDirectory: string;
  /** Delay before quit after relaunch. Defaults to 800ms. */
  quitDelayMs?: number;
}

export interface UpdateInstaller {
  /** Install a downloaded updater for the current platform, then relaunch and quit. */
  install(filePath: string, version: string): Promise<void>;
}

/**
 * Installs a downloaded updater for the current platform, then relaunches and
 * quits. Platform dispatch and side effects go through the injected adapters so
 * the ordering is testable without running real installer commands.
 *
 * - Windows: runs the NSIS installer (silent) which replaces the app.
 * - macOS: mounts the DMG, copies the .app over /Applications, then relaunches.
 * - Linux: replaces the running AppImage at its path, then relaunches it.
 */
export function createUpdateInstaller(adapters: UpdateInstallerAdapters): UpdateInstaller {
  const quitDelayMs = adapters.quitDelayMs ?? 800;

  function relaunchDetached(command: string, args: readonly string[] = []): void {
    const child = adapters.spawn(command, [...args], { detached: true, stdio: 'ignore' });
    child.unref();
  }

  function scheduleQuit(): void {
    setTimeout(() => adapters.quit(), quitDelayMs);
  }

  function execRejecting(file: string, args: readonly string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      adapters.execFile(file, args, (error) => (error ? reject(error) : resolve()));
    });
  }

  function execSettling(file: string, args: readonly string[]): Promise<void> {
    return new Promise((resolve) => {
      adapters.execFile(file, args, () => resolve());
    });
  }

  async function install(filePath: string, _version: string): Promise<void> {
    if (adapters.platform === 'win32') {
      relaunchDetached(filePath, ['/S']);
      scheduleQuit();
      return;
    }
    if (adapters.platform === 'darwin') {
      const mountPoint = path.join(adapters.temporaryDirectory, `fate-ui-update-${Date.now()}`);
      await execRejecting('hdiutil', ['attach', filePath, '-nobrowse', '-mountpoint', mountPoint]);
      try {
        const { sourceApp, targetApp } = await resolveMacOSUpdateBundle(mountPoint, adapters.readBundleDir);
        await adapters.remove(targetApp).catch(() => undefined);
        await execRejecting('cp', ['-R', sourceApp, targetApp]);
        await execSettling('xattr', ['-dr', 'com.apple.quarantine', targetApp]);
      } finally {
        await execSettling('hdiutil', ['detach', mountPoint]);
      }
      relaunchDetached(path.join(MACOS_INSTALL_DIR, MACOS_APP_BUNDLE_NAME, 'Contents', 'MacOS', 'fate-ui'));
      scheduleQuit();
      return;
    }
    if (adapters.platform === 'linux') {
      const target = adapters.execPath;
      await execRejecting('chmod', ['+x', filePath]);
      await adapters.copyFile(filePath, target);
      relaunchDetached(target);
      scheduleQuit();
      return;
    }
    throw new Error(`Auto-update is not supported on ${adapters.platform}.`);
  }

  return { install };
}

/** Production adapter set: real spawn/execFile/fs against this process. */
export function createProductionUpdateInstallerAdapters(options: {
  platform?: string;
  execPath?: string;
  temporaryDirectory?: string;
  quit: () => void;
  quitDelayMs?: number;
}): UpdateInstallerAdapters {
  return {
    spawn: (command, args, options) => spawn(command, [...args], options),
    execFile: (file, args, callback) => execFile(file, [...args], (error) => callback(error)),
    copyFile: (source, destination) => copyFile(source, destination),
    remove: (target) => rm(target, { recursive: true, force: true }),
    readBundleDir: readMacOSBundleDir,
    quit: options.quit,
    platform: options.platform ?? process.platform,
    execPath: options.execPath ?? process.execPath,
    temporaryDirectory: options.temporaryDirectory ?? tmpdir(),
    ...(options.quitDelayMs !== undefined ? { quitDelayMs: options.quitDelayMs } : {}),
  };
}
