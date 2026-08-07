import { describe, expect, it } from 'vitest';
import { nodePtyRuntimeRelativeBases } from './verify-packaged-native-deps.mjs';

describe('packaged node-pty runtime selection', () => {
  it('matches node-pty load order and normalizes electron-builder numeric architectures', () => {
    expect(nodePtyRuntimeRelativeBases('darwin', 1)).toEqual([
      'build/Release',
      'build/Debug',
      'prebuilds/darwin-x64',
    ]);
    expect(nodePtyRuntimeRelativeBases('mac', 3)).toEqual([
      'build/Release',
      'build/Debug',
      'prebuilds/darwin-arm64',
    ]);
  });
});
