import { mkdir } from 'node:fs/promises';
import {
  createProductionUpdateInstallerAdapters,
  createUpdateInstaller,
  type UpdateInstallerAdapters,
} from './installDownloadedUpdate';

/**
 * Opt-in macOS updater smoke wired on the initial window's first load.
 *
 * Runs the production installer (real hdiutil, resolve, remove, copy, verify,
 * xattr, detach) against a real release DMG, installing into a throwaway
 * directory. Only the final relaunch is recorded instead of spawning, because
 * the app under smoke is itself the process doing the installing. The standard
 * production smoke continues afterwards and quits the app, so a successful
 * updater smoke also proves the freshly installed bundle launches.
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
  return (command, args, options) => {
    void args;
    void options;
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
    // Wrap spawn so the recorded relaunch target reflects a successful spawn,
    // whichever adapter set (production or injected) runs underneath.
    const adapters: UpdateInstallerAdapters = {
      ...base,
      spawn: (command, args, options) => {
        const child = base.spawn(command, args, options);
        const forward = child.on.bind(child);
        return {
          unref: () => child.unref(),
          on: (event, listener) => {
            forward(event, (error) => {
              if (event === 'spawn') spawned.push(command);
              listener(error);
            });
          },
        };
      },
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
