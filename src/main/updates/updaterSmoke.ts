import { mkdir } from 'node:fs/promises';
import {
  createProductionUpdateInstallerAdapters,
  createUpdateInstaller,
  type UpdateInstallerAdapters,
} from './installDownloadedUpdate';

/**
 * Opt-in macOS updater smoke wired on the initial window's first load.
 *
 * Runs the production installer (real hdiutil attach, resolve, remove, cp,
 * verify, xattr, legacy cleanup, detach) against a real release DMG, installing
 * into a throwaway directory. The final relaunch is only recorded, never
 * spawned: the app running this smoke is itself the process doing the
 * installing, and a detached child would inherit this smoke's environment and
 * recursively reinstall over itself. The standard production smoke continues
 * afterwards and quits the app; CI then launches the freshly installed bundle
 * to prove it starts cleanly.
 */
export interface UpdaterSmokeDeps {
  dmgPath: string;
  installDir: string;
  log: (line: string) => void;
  error: (line: string) => void;
  exit: (code: number) => void;
  /** Full adapter override for unit tests; production uses the real set with a recording spawn. */
  adapters?: UpdateInstallerAdapters;
}

/** Spawn adapter that records the relaunch target and reports successful spawn. */
export function recordingSpawn(record: (command: string) => void): UpdateInstallerAdapters['spawn'] {
  return (command, _args, _options) => {
    record(command);
    const listeners: Array<{ event: 'spawn' | 'error'; listener: (error?: Error) => void }> = [];
    queueMicrotask(() => {
      for (const entry of listeners) if (entry.event === 'spawn') entry.listener();
    });
    return {
      unref: () => undefined,
      on: (event, listener) => {
        listeners.push({ event, listener });
      },
    };
  };
}

export async function runUpdaterSmoke(deps: UpdaterSmokeDeps): Promise<void> {
  try {
    await mkdir(deps.installDir, { recursive: true });
    const spawned: string[] = [];
    const base: UpdateInstallerAdapters = deps.adapters ?? createProductionUpdateInstallerAdapters({
      installDir: deps.installDir,
      quit: () => undefined,
    });
    // The relaunch is recorded, never actually spawned (see the module doc).
    const adapters: UpdateInstallerAdapters = {
      ...base,
      spawn: recordingSpawn((command) => spawned.push(command)),
    };
    await createUpdateInstaller(adapters).install(deps.dmgPath, '0.0.0-smoke');
    if (spawned.length !== 1 || !spawned[0]!.startsWith(`${deps.installDir}/`)) {
      throw new Error(`Unexpected relaunch target: ${spawned.join(', ') || 'none'}`);
    }
    deps.log(`PI_DESKTOP_UPDATER_SMOKE_OK ${spawned[0]}`);
  } catch (error: unknown) {
    deps.error(`PI_DESKTOP_UPDATER_SMOKE_FAILED ${error instanceof Error ? error.message : String(error)}`);
    deps.exit(1);
  }
}
