import { describe, expect, it } from 'vitest';
import { releaseMetadata } from './releaseMetadata';

describe('application release metadata', () => {
  it('exposes the 1.1 machine version and Axiom display title', () => {
    expect(releaseMetadata).toEqual({
      version: '1.1.0',
      releaseName: 'Axiom',
      displayVersion: 'V1.1.0 - Axiom',
    });
  });
});
