import { mkdirSync } from 'node:fs';
import path from 'node:path';

interface InstanceProfileApp {
  getPath(name: 'userData'): string;
  setPath(name: 'userData', value: string): void;
  requestSingleInstanceLock(additionalData?: Record<string, unknown>): boolean;
}

export type InstanceAcquisitionMode = 'single' | 'multi';

export interface InstanceProfile {
  slot: number;
  userDataPath: string;
  /**
   * Single-instance mode only. True when this process won the primary lock and
   * should run the app; false when another instance already holds it and this
   * process must hand its launch arguments off and exit.
   */
  isPrimary: boolean;
  mode: InstanceAcquisitionMode;
}

export function instanceUserDataPath(primaryUserDataPath: string, slot: number): string {
  if (!Number.isSafeInteger(slot) || slot < 1) throw new Error('The Fate UI instance slot must be a positive safe integer.');
  const primary = path.resolve(primaryUserDataPath);
  return slot === 1 ? primary : path.join(primary, 'instances', String(slot));
}

/**
 * Resolve the Fate UI process identity.
 *
 * `single` (default): Fate UI runs as one process. The first launch wins the
 * primary lock; every later launch fails it, ships its arguments to the primary
 * via Electron's `second-instance` event, and exits. The `fate` terminal command
 * therefore adds or focuses a folder inside the live app instead of spawning a
 * new window.
 *
 * `multi`: each concurrent process gets its own persistent Chromium profile.
 * Electron's process singleton is scoped to userData, so occupied slots are
 * skipped while the first launch keeps the existing profile and renderer
 * storage. Opt into this with `--new-instance` or `FATE_NEW_INSTANCE=1` for
 * fully isolated accounts/credentials.
 */
export function acquireInstanceProfile(
  electronApp: InstanceProfileApp,
  mode: InstanceAcquisitionMode = 'single',
  ensureDirectory: (directory: string) => void = (directory) => mkdirSync(directory, { recursive: true }),
): InstanceProfile {
  const primaryUserDataPath = path.resolve(electronApp.getPath('userData'));
  if (mode === 'single') {
    electronApp.setPath('userData', primaryUserDataPath);
    ensureDirectory(primaryUserDataPath);
    const isPrimary = electronApp.requestSingleInstanceLock({ instanceSlot: 1, mode: 'single' });
    return { slot: 1, userDataPath: primaryUserDataPath, isPrimary, mode };
  }
  for (let slot = 1; Number.isSafeInteger(slot); slot += 1) {
    const userDataPath = instanceUserDataPath(primaryUserDataPath, slot);
    ensureDirectory(userDataPath);
    electronApp.setPath('userData', userDataPath);
    if (electronApp.requestSingleInstanceLock({ instanceSlot: slot, mode: 'multi' })) {
      return { slot, userDataPath, isPrimary: true, mode };
    }
  }
  throw new Error('Fate UI could not allocate an Electron instance profile.');
}
