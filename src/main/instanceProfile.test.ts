import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { acquireInstanceProfile, instanceUserDataPath } from './instanceProfile';

describe('instance profiles', () => {
  it('preserves the existing profile for the first process', () => {
    const base = path.resolve('profiles/fate-ui');
    const setPath = vi.fn();
    const ensureDirectory = vi.fn();
    const profile = acquireInstanceProfile({
      getPath: () => base,
      setPath,
      requestSingleInstanceLock: () => true,
    }, ensureDirectory);

    expect(profile).toEqual({ slot: 1, userDataPath: base });
    expect(setPath).toHaveBeenCalledWith('userData', base);
    expect(ensureDirectory).toHaveBeenCalledWith(base);
  });

  it('allocates an uncapped sequence of isolated slots for concurrent processes', () => {
    const base = path.resolve('profiles/fate-ui');
    const occupiedSlots = 7;
    const attemptedPaths: string[] = [];
    let currentPath = base;
    let attempts = 0;
    const profile = acquireInstanceProfile({
      getPath: () => base,
      setPath: (_name, value) => {
        currentPath = value;
        attemptedPaths.push(value);
      },
      requestSingleInstanceLock: () => {
        attempts += 1;
        return attempts > occupiedSlots;
      },
    }, () => undefined);

    expect(profile).toEqual({ slot: 8, userDataPath: instanceUserDataPath(base, 8) });
    expect(currentPath).toBe(profile.userDataPath);
    expect(attemptedPaths).toEqual(Array.from({ length: 8 }, (_, index) => instanceUserDataPath(base, index + 1)));
  });

  it('rejects invalid slot numbers', () => {
    expect(() => instanceUserDataPath('/profile', 0)).toThrow(/positive safe integer/);
    expect(() => instanceUserDataPath('/profile', Number.POSITIVE_INFINITY)).toThrow(/positive safe integer/);
  });
});
