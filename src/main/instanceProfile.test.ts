import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { acquireInstanceProfile, instanceUserDataPath } from './instanceProfile';

describe('instance profiles', () => {
  it('runs as the single-instance primary when it wins the primary lock', () => {
    const base = path.resolve('profiles/fate-ui');
    const setPath = vi.fn();
    const ensureDirectory = vi.fn();
    const profile = acquireInstanceProfile({
      getPath: () => base,
      setPath,
      requestSingleInstanceLock: () => true,
    }, 'single', ensureDirectory);

    expect(profile).toEqual({ slot: 1, userDataPath: base, isPrimary: true, mode: 'single' });
    expect(setPath).toHaveBeenCalledWith('userData', base);
    expect(ensureDirectory).toHaveBeenCalledWith(base);
  });

  it('reports a non-primary single-instance launch so the process can forward and exit', () => {
    const base = path.resolve('profiles/fate-ui');
    const attemptedPaths: string[] = [];
    const profile = acquireInstanceProfile({
      getPath: () => base,
      setPath: (_name, value) => { attemptedPaths.push(value); },
      requestSingleInstanceLock: () => false,
    }, 'single', () => undefined);

    expect(profile).toEqual({ slot: 1, userDataPath: base, isPrimary: false, mode: 'single' });
    // A secondary single-instance launch must never reach an isolated slot.
    expect(attemptedPaths).toEqual([base]);
  });

  it('allocates an uncapped sequence of isolated slots for explicit multi-instance launches', () => {
    const base = path.resolve('profiles/fate-ui');
    const occupiedSlots = 7;
    const attemptedPaths: string[] = [];
    let attempts = 0;
    const profile = acquireInstanceProfile({
      getPath: () => base,
      setPath: (_name, value) => { attemptedPaths.push(value); },
      requestSingleInstanceLock: () => {
        attempts += 1;
        return attempts > occupiedSlots;
      },
    }, 'multi', () => undefined);

    expect(profile).toEqual({ slot: 8, userDataPath: instanceUserDataPath(base, 8), isPrimary: true, mode: 'multi' });
    expect(attemptedPaths).toEqual(Array.from({ length: 8 }, (_, index) => instanceUserDataPath(base, index + 1)));
  });

  it('defaults to single-instance mode', () => {
    const base = path.resolve('profiles/fate-ui');
    const profile = acquireInstanceProfile({
      getPath: () => base,
      setPath: () => undefined,
      requestSingleInstanceLock: () => true,
    });
    expect(profile.mode).toBe('single');
    expect(profile.isPrimary).toBe(true);
  });

  it('rejects invalid slot numbers', () => {
    expect(() => instanceUserDataPath('/profile', 0)).toThrow(/positive safe integer/);
    expect(() => instanceUserDataPath('/profile', Number.POSITIVE_INFINITY)).toThrow(/positive safe integer/);
  });
});
