import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from './relativeTime';

const now = Date.parse('2026-08-03T12:00:00.000Z');

describe('formatRelativeTime', () => {
  it.each([
    ['2026-08-03T11:59:31.000Z', 'now'],
    ['2026-08-03T11:57:00.000Z', '3m ago'],
    ['2026-08-03T09:00:00.000Z', '3h ago'],
    ['2026-07-20T12:00:00.000Z', '2w ago'],
    ['2027-08-03T12:00:00.000Z', 'in 1y'],
  ])('formats %s as %s', (value, expected) => {
    expect(formatRelativeTime(value, now)).toBe(expected);
  });

  it('fails safely for malformed timestamps', () => {
    expect(formatRelativeTime('not-a-date', now)).toBe('unknown');
  });
});
