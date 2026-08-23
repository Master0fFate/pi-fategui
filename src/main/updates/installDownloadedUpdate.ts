import { execFile, spawn } from 'node:child_process';
import { copyFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MACOS_INSTALL_DIR,
  MACOS_LEGACY_APP_BUNDLE_NAMES,
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

/** Reasons the installer can refuse or fail after a successful download. */
export const updateInstallerMessages = {
  unremovableTarget: 'The installed application could not be replaced (a PKG install is owned by the system). Install the update manually from the releases page.',
  executableMissing: 'The installed update bundle did not contain the expected application executable. Nothing was relaunched.',
  relaunchFailed: 'The updated application could not be relaunched.',
} as const;

export interface DetachedChild {
  unref(): void;
  /** Register process lifecycle observers ('spawn' on success, 'error' on failure). */
  on(event: 'spawn' | 'error', listener: (error?: Error) => void): void;
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
  /** Report a non-fatal problem (for example, legacy bundle cleanup failure). */
  warn?(message: string): void;
  platform: string;
  execPath: string;
  temporaryDirectory: string;
  /** macOS install destination. Defaults to /Applications; smoke tests use a temp directory. */
  installDir?: string;
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
 * - macOS: mounts the DMG, copies the staged bundle over /Applications under
 *   its own shipped name, verifies the launcher executable, then relaunches.
 * - Linux: replaces the running AppImage at its path, then relaunches it.
 *
 * Any relaunch failure rejects instead of quitting, so the renderer can show
 * the error; a spawn failure never surfaces as an uncaught exception.
 */
export function createUpdateInstaller(adapters: UpdateInstallerAdapters): UpdateInstaller {
  const quitDelayMs = adapters.quitDelayMs ?? 800;

  function relaunchDetached(command: string, args: readonly string[] = []): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let child: DetachedChild;
      try {
        child = adapters.spawn(command, [...args], { detached: true, stdio: 'ignore' });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      let settled = false;
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      child.on('spawn', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      child.unref();
    });
  }

  async function relaunchOrThrow(command: string, args: readonly string[] = []): Promise<void> {
    try {
      await relaunchDetached(command, args);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${updateInstallerMessages.relaunchFailed} ${detail}`);
    }
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

  /** Confirm the freshly copied bundle exposes the resolved launcher executable. */
  async function verifyInstalledExecutable(targetApp: string, executableName: string): Promise<void> {
    let entries: readonly MacOSBundleDirEntry[];
    try {
      entries = await adapters.readBundleDir(path.posix.join(targetApp, 'Contents', 'MacOS'));
    } catch {
      throw new Error(updateInstallerMessages.executableMissing);
    }
    if (!entries.some((entry) => entry.isFile && entry.name === executableName)) {
      throw new Error(updateInstallerMessages.executableMissing);
    }
  }

  /** Remove bundles left behind by earlier updaters; best-effort and never fatal. */
  async function removeLegacyBundles(targetApp: string): Promise<void> {
    const targetName = path.posix.basename(targetApp);
    for (const name of MACOS_LEGACY_APP_BUNDLE_NAMES) {
      if (name === targetName) continue;
      await adapters.remove(path.posix.join(adapters.installDir ?? MACOS_INSTALL_DIR, name))
        .catch((error: unknown) => adapters.warn?.(`Legacy bundle cleanup failed for ${name}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  async function install(filePath: string, _version: string): Promise<void> {
    if (adapters.platform === 'win32') {
      await relaunchOrThrow(filePath, ['/S']);
      scheduleQuit();
      return;
    }
    if (adapters.platform === 'darwin') {
      const mountPoint = path.join(adapters.temporaryDirectory, `fate-ui-update-${Date.now()}`);
      await execRejecting('hdiutil', ['attach', filePath, '-nobrowse', '-mountpoint', mountPoint]);
      try {
        const { sourceApp, targetApp, executableName } = await resolveMacOSUpdateBundle(mountPoint, adapters.readBundleDir, {
          ...(adapters.installDir !== undefined ? { installDir: adapters.installDir } : {}),
        });
        // The old bundle must actually be gone before copying: `cp -R` into a
        // surviving directory copies inside it instead of replacing it.
        await adapters.remove(targetApp).catch(async (error: unknown) => {
          throw new Error(`${updateInstallerMessages.unremovableTarget} ${error instanceof Error ? error.message : String(error)}`);
        });
        await execRejecting('cp', ['-R', sourceApp, targetApp]);
        await verifyInstalledExecutable(targetApp, executableName);
        await execSettling('xattr', ['-dr', 'com.apple.quarantine', targetApp]);
        await removeLegacyBundles(targetApp);
        await relaunchOrThrow(path.posix.join(targetApp, 'Contents', 'MacOS', executableName));
      } finally {
        await execSettling('hdiutil', ['detach', mountPoint]);
      }
      scheduleQuit();
      return;
    }
    if (adapters.platform === 'linux') {
      const target = adapters.execPath;
      await execRejecting('chmod', ['+x', filePath]);
      await adapters.copyFile(filePath, target);
      await relaunchOrThrow(target);
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
  installDir?: string;
  quit: () => void;
  quitDelayMs?: number;
  warn?: (message: string) => void;
}): UpdateInstallerAdapters {
  return {
    spawn: (command, args, options) => spawn(command, [...args], options),
    execFile: (file, args, callback) => execFile(file, [...args], (error) => callback(error)),
    copyFile: (source, destination) => copyFile(source, destination),
    remove: (target) => rm(target, { recursive: true, force: true }),
    readBundleDir: readMacOSBundleDir,
    quit: options.quit,
    ...(options.warn !== undefined ? { warn: options.warn } : {}),
    platform: options.platform ?? process.platform,
    execPath: options.execPath ?? process.execPath,
    temporaryDirectory: options.temporaryDirectory ?? tmpdir(),
    ...(options.installDir !== undefined ? { installDir: options.installDir } : {}),
    ...(options.quitDelayMs !== undefined ? { quitDelayMs: options.quitDelayMs } : {}),
  };
}
