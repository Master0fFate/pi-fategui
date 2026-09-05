import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent';
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

const directories: string[] = [];
afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

function saved(entries: unknown[]) {
  const directory = mkdtempSync(path.join(tmpdir(), 'fate-reference-'));
  directories.push(directory);
  const file = path.join(directory, 'session.jsonl');
  const bytes = entries.map((item) => JSON.stringify(item)).join('\n');
  writeFileSync(file, bytes);
  return { file, bytes, summary: { ...summary, path: file } };
}

const header = { type: 'session', version: 3, id: 'saved-session', cwd: '/project', timestamp: '2026-01-01T00:00:00.000Z' };

describe('buildSessionReferenceContext', () => {
  it('uses SDK in-memory restoration without migrating or repairing the saved file', () => {
    const fixture = saved([
      { ...header, version: 1 },
      { type: 'message', timestamp: header.timestamp, message: { role: 'user', content: 'Legacy question', timestamp: 1 } },
      { type: 'message', timestamp: header.timestamp, message: { role: 'assistant', content: 'Legacy answer', timestamp: 2 } },
    ]);
    const restore = vi.spyOn(SessionManager, 'inMemory');
    const context = buildSessionReferenceContext(fixture.summary);
    expect(context).toContain('Legacy question');
    expect(context).toContain('Legacy answer');
    expect(restore).toHaveBeenCalledOnce();
    expect(restore.mock.results[0]?.value.isPersisted()).toBe(false);
    expect(readFileSync(fixture.file, 'utf8')).toBe(fixture.bytes);
  });

  it('recovers messages inside the active compaction checkpoint without leaking inactive branches or tools', () => {
    const fixture = saved([
      header,
      { ...entry('user', 'Original question'), id: 'u1' },
      { ...entry('assistant', 'Original answer'), id: 'a1', parentId: 'u1' },
      { ...entry('user', 'Inactive question'), id: 'u2', parentId: 'a1' },
      { ...entry('assistant', 'Inactive answer'), id: 'a2', parentId: 'u2' },
      {
        type: 'compaction', id: 'c1', parentId: 'a1', timestamp: header.timestamp, summary: 'Earlier work', tokensBefore: 500, firstKeptEntryId: 'u1',
        retainedTail: [
          { role: 'user', content: 'Checkpoint question', timestamp: 3 },
          { role: 'toolResult', content: 'Hidden tool output', timestamp: 4 },
          { role: 'assistant', content: 'Checkpoint answer password=secret-value', timestamp: 5 },
        ],
      },
    ]);
    const context = buildSessionReferenceContext(fixture.summary);
    expect(context).toContain('Checkpoint question');
    expect(context).toContain('Checkpoint answer password=[redacted]');
    expect(context).not.toContain('Original');
    expect(context).not.toContain('Inactive');
    expect(context).not.toContain('Hidden tool output');
    expect(context.length).toBeLessThanOrEqual(5800);
    expect(readFileSync(fixture.file, 'utf8')).toBe(fixture.bytes);
  });

  it('does not expose legacy-kept messages when a self-contained checkpoint has an empty tail', () => {
    const fixture = saved([
      header,
      { ...entry('user', 'Older private question'), id: 'u1' },
      { ...entry('assistant', 'Older private answer'), id: 'a1', parentId: 'u1' },
      { type: 'compaction', id: 'c1', parentId: 'a1', timestamp: header.timestamp, summary: 'Summary', firstKeptEntryId: 'u1', tokensBefore: 500, retainedTail: [] },
    ]);
    expect(() => buildSessionReferenceContext(fixture.summary)).toThrow(/no usable/);
    expect(readFileSync(fixture.file, 'utf8')).toBe(fixture.bytes);
  });

  it('rejects stale session identities and cyclic active paths without changing the file', () => {
    const fixture = saved([header, { ...entry('user', 'Question'), id: 'u1' }]);
    expect(() => buildSessionReferenceContext({ ...fixture.summary, id: 'different-session' })).toThrow(/changed since/);
    const cyclic = saved([header, { ...entry('user', 'Question'), id: 'u1', parentId: 'u1' }]);
    expect(() => buildSessionReferenceContext(cyclic.summary)).toThrow(/cyclic/);
    expect(readFileSync(cyclic.file, 'utf8')).toBe(cyclic.bytes);
  });

  it('decodes UTF-8 across read chunks and leaves a missing trailing newline untouched', () => {
    const fixture = saved([
      header,
      { type: 'custom', id: 'padding', parentId: null, timestamp: header.timestamp, customType: 'large', data: '😀'.repeat(40_000) },
      { ...entry('user', 'שלום 世界 question'), id: 'u1', parentId: 'padding' },
      { ...entry('assistant', 'Verified ✓ answer'), id: 'a1', parentId: 'u1' },
    ]);
    const context = buildSessionReferenceContext(fixture.summary);
    expect(context).toContain('שלום 世界 question');
    expect(context).toContain('Verified ✓ answer');
    expect(context).not.toContain('\uFFFD');
    expect(readFileSync(fixture.file, 'utf8')).toBe(fixture.bytes);
  });

  it('rejects a non-session file without initializing or overwriting it', () => {
    const fixture = saved([{ unrelated: 'data' }]);
    expect(() => buildSessionReferenceContext(fixture.summary)).toThrow(/not a valid saved session/);
    expect(readFileSync(fixture.file, 'utf8')).toBe(fixture.bytes);
  });

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
