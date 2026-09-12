import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { shouldMarkReleaseLatest, validateReleaseMetadata } from './release-metadata.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');

describe('release metadata verification', () => {
  it('verifies the repository V1 metadata and exact public title', async () => {
    const result = await execFileAsync(process.execPath, [path.join(root, 'scripts', 'verify-version.mjs')], { cwd: root });
    expect(result.stdout).toBe('Version sources match exactly: 1.0.0; release title: V1.0.0 - Modulo\n');
  });

  it('keeps the codename out of package and production SemVer', () => {
    expect(() => validateReleaseMetadata({ version: '1.0.0 - Modulo', releaseName: 'Modulo' }, '1.0.0 - Modulo'))
      .toThrow(/not strict SemVer/u);
    expect(() => validateReleaseMetadata({ version: '1.0.0', releaseName: 'Modulo' }, 'V1.0.0 - Modulo'))
      .toThrow(/must exactly match/u);
  });

  it('allows a future release to omit the codename', () => {
    expect(validateReleaseMetadata({ version: '1.0.1' }, '1.0.1')).toMatchObject({
      version: '1.0.1', displayVersion: 'V1.0.1', tag: 'v1.0.1', isPrerelease: false,
    });
  });

  it('treats release names as opaque human metadata without changing machine identifiers', () => {
    expect(validateReleaseMetadata({ version: '1.0.0', releaseName: '../Modulo: "Final" ✦' }, '1.0.0')).toMatchObject({
      version: '1.0.0', tag: 'v1.0.0', displayVersion: 'V1.0.0 - ../Modulo: "Final" ✦',
    });
  });

  it('derives latest-release policy with SemVer instead of shell comparisons', () => {
    expect(shouldMarkReleaseLatest('1.0.0')).toBe(true);
    expect(shouldMarkReleaseLatest('1.0.1', 'v1.0.0')).toBe(true);
    expect(shouldMarkReleaseLatest('1.0.1', 'v1.1.0')).toBe(false);
    expect(shouldMarkReleaseLatest('1.0.1', 'v1.0.1')).toBe(false);
    expect(shouldMarkReleaseLatest('1.0.1-beta1', 'v1.0.0')).toBe(false);
    expect(shouldMarkReleaseLatest('1.0.0', 'v1.0.1-beta1')).toBe(false);
    expect(shouldMarkReleaseLatest('1.0.0', 'v0.9.9-beta4')).toBe(true);
    expect(shouldMarkReleaseLatest('1.0.0', 'v1.0.0-beta1')).toBe(true);
    expect(() => shouldMarkReleaseLatest('1.0.1', 'V1.0.0 - Old Title')).toThrow(/Published release tag is invalid/u);
  });

  it('rejects empty, padded, or control-bearing release names', () => {
    for (const releaseName of ['', ' Modulo', 'Modulo ', 'Modulo\nInjected']) {
      expect(() => validateReleaseMetadata({ version: '1.0.0', releaseName }, '1.0.0')).toThrow(/releaseName is invalid/u);
    }
  });
});
