import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { resolveDevelopmentProfile } from './dev-profile.mjs';

describe('resolveDevelopmentProfile', () => {
  it('uses a deterministic isolated Electron profile for each checkout', () => {
    const first = resolveDevelopmentProfile(path.join(tmpdir(), 'fate-checkout-a'), {});
    const repeated = resolveDevelopmentProfile(path.join(tmpdir(), 'fate-checkout-a'), {});
    const second = resolveDevelopmentProfile(path.join(tmpdir(), 'fate-checkout-b'), {});

    expect(first).toEqual(repeated);
    expect(first.profileRoot).not.toBe(second.profileRoot);
    expect(first.electronUserData).toBe(path.join(first.profileRoot, 'electron'));
    expect(first.fateGuiData).toBe(path.join(homedir(), '.pi', 'fateGUI'));
    expect(second.fateGuiData).toBe(first.fateGuiData);
  });

  it('honors explicit development and Fate data overrides', () => {
    const profile = resolveDevelopmentProfile('.', {
      PI_DESKTOP_DEV_PROFILE: path.join(tmpdir(), 'custom-fate-profile'),
      FATE_GUI_DATA_DIR: path.join(tmpdir(), 'custom-fate-data'),
    });

    expect(profile.profileRoot).toBe(path.resolve(tmpdir(), 'custom-fate-profile'));
    expect(profile.electronUserData).toBe(path.resolve(tmpdir(), 'custom-fate-profile', 'electron'));
    expect(profile.fateGuiData).toBe(path.resolve(tmpdir(), 'custom-fate-data'));
  });
});
