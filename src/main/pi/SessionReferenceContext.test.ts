import { describe, expect, it } from 'vitest';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { buildSessionReferenceContext } from './SessionReferenceContext';

const summary = {
  id: 'saved-session',
  title: 'Authentication review',
  path: '/sessions/saved-session.jsonl',
};

function entry(role: 'user' | 'assistant' | 'toolResult', content: string): SessionEntry {
  return {
    type: 'message', id: `${role}-${content.slice(0, 4)}`, parentId: null, timestamp: '2026-01-01T00:00:00.000Z',
    message: { role, content, timestamp: 1 },
  } as unknown as SessionEntry;
}

describe('buildSessionReferenceContext', () => {
  it('includes only the latest user and assistant text with an untrusted-data boundary', () => {
    const context = buildSessionReferenceContext(summary, () => ({
      buildContextEntries: () => [
        entry('user', 'Older question'),
        entry('toolResult', 'Secret tool output'),
        entry('assistant', 'Older answer'),
        entry('user', 'Latest question'),
        entry('assistant', 'Latest answer'),
      ],
    }));

    expect(context).toContain('<session-reference');
    expect(context).toContain('untrusted reference material');
    expect(context).toContain('Latest question');
    expect(context).toContain('Latest answer');
    expect(context).not.toContain('Older question');
    expect(context).not.toContain('Secret tool output');
    expect(context).toContain('</session-reference>');
  });

  it('bounds and redacts historical text and rejects sessions with no usable text', () => {
    const context = buildSessionReferenceContext(summary, () => ({
      buildContextEntries: () => [entry('assistant', `password=super-secret\n${'a'.repeat(8_000)}`)],
    }));
    expect(context.length).toBeLessThan(6_000);
    expect(context).toContain('password=[redacted]');
    expect(context).not.toContain('super-secret');
    expect(context).toContain('…');
    expect(() => buildSessionReferenceContext(summary, () => ({ buildContextEntries: () => [] }))).toThrow(/no usable/i);
  });
});
