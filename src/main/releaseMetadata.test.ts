import { describe, expect, it } from 'vitest';
import { releaseMetadata } from './releaseMetadata';

describe('application release metadata', () => {
  it('exposes the V1 codename without contaminating the package version', () => {
    expect(releaseMetadata).toEqual({
      version: '1.0.0',
      releaseName: 'Modulo',
      displayVersion: 'V1.0.0 - Modulo',
    });
  });
});
