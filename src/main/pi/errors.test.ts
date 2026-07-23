import { describe, expect, it } from 'vitest';
import { normalizeError } from './errors';

describe('normalizeError', () => {
  it('provides an honest authentication action', () => {
    expect(normalizeError(new Error('No auth configured for model'))).toMatchObject({
      code: 'AUTH_REQUIRED', retryable: true,
      actionable: expect.stringContaining('/login'),
    });
  });

  it('does not leak stacks or arbitrary fields', () => {
    expect(normalizeError({ secret: 'key' })).toEqual({ code: 'UNKNOWN', message: 'An unknown error occurred.', retryable: true });
  });
});
