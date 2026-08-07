import { mkdirSync } from 'node:fs';
import path from 'node:path';

interface InstanceProfileApp {
  getPath(name: 'userData'): string;
  setPath(name: 'userData', value: string): void;
  requestSingleInstanceLock(additionalData?: Record<string, unknown>): boolean;
}

export interface InstanceProfile {
  slot: number;
  userDataPath: string;
}

export function instanceUserDataPath(primaryUserDataPath: string, slot: number): string {
  if (!Number.isSafeInteger(slot) || slot < 1) throw new Error('The Fate UI instance slot must be a positive safe integer.');
  const primary = path.resolve(primaryUserDataPath);
  return slot === 1 ? primary : path.join(primary, 'instances', String(slot));
}

/**
 * Give each concurrent process its own persistent Chromium profile. Electron's
 * process singleton is scoped to userData, so occupied slots are skipped while
 * the first launch keeps the existing profile and renderer storage.
 */
export function acquireInstanceProfile(
  electronApp: InstanceProfileApp,
  ensureDirectory: (directory: string) => void = (directory) => mkdirSync(directory, { recursive: true }),
): InstanceProfile {
  const primaryUserDataPath = path.resolve(electronApp.getPath('userData'));
  for (let slot = 1; Number.isSafeInteger(slot); slot += 1) {
    const userDataPath = instanceUserDataPath(primaryUserDataPath, slot);
    ensureDirectory(userDataPath);
    electronApp.setPath('userData', userDataPath);
    if (electronApp.requestSingleInstanceLock({ instanceSlot: slot })) return { slot, userDataPath };
  }
  throw new Error('Fate UI could not allocate an Electron instance profile.');
}
