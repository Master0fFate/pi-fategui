import { describe, expect, it } from 'vitest';
import { formatReleaseDisplayVersion } from './releaseMetadata';

describe('release display metadata', () => {
  it('keeps the codename separate from the machine version', () => {
    expect(formatReleaseDisplayVersion('1.0.0', 'Modulo')).toBe('V1.0.0 - Modulo');
  });

  it('formats future releases without inventing a codename', () => {
    expect(formatReleaseDisplayVersion('1.0.1')).toBe('V1.0.1');
  });
});
