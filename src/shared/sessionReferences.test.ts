import { describe, expect, it } from 'vitest';
import { readSessionReference, serializeSessionReference, SESSION_REFERENCE_TRANSFER_TYPE } from './sessionReferences';

describe('session reference drag data', () => {
  it('round-trips only bounded structured session references', () => {
    const value = { id: 'session-1', title: 'Auth review', projectPath: '/project' };
    const transfer = { getData: (type: string) => type === SESSION_REFERENCE_TRANSFER_TYPE ? serializeSessionReference(value) : '' };
    expect(readSessionReference(transfer)).toEqual(value);
  });

  it('rejects malformed, incomplete, and oversized drag data', () => {
    expect(readSessionReference({ getData: () => 'not-json' })).toBeNull();
    expect(readSessionReference({ getData: () => JSON.stringify({ id: 'session-1', title: 'Missing project' }) })).toBeNull();
    expect(readSessionReference({ getData: () => JSON.stringify({ id: 'session-1', title: 'x'.repeat(201), projectPath: '/project' }) })).toBeNull();
  });
});
