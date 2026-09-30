import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionManager, type AgentSession, type SessionInfo } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { isSafeSessionPath, PiSessionRepository, projectSessionDirectory, sessionDisplayTitle } from './PiSessionRepository';

/**
 * A realistic session store layout: `<sessionsRoot>/--<encoded project>--/<name>.jsonl`,
 * exactly as the Pi SDK lays it out under ~/.pi/agent/sessions/. Tests create a
 * temp root so the containment checks see a real, isolated store.
 */
function sessionStore() {
  const sessionsRoot = mkdtempSync(path.join(tmpdir(), 'fate-sessions-'));
  const sessionDir = projectSessionDirectory('/project', sessionsRoot);
  mkdirSync(sessionDir, { recursive: true });
  return { sessionsRoot, sessionDir };
}

const info = (sessionDir: string, overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  path: path.join(sessionDir, 'one.jsonl'), id: 'one', cwd: '/project', name: 'Fix auth',
  created: new Date('2025-01-01T00:00:00.000Z'), modified: new Date('2025-01-02T00:00:00.000Z'),
  messageCount: 3, firstMessage: 'Investigate login', allMessagesText: 'Investigate login token refresh',
  ...overrides,
});

describe('PiSessionRepository', () => {
  it('turns the first prompt into a compact deterministic fallback title', () => {
    const longPrompt = 'Redesign the complete settings experience while preserving every existing behavior and keeping the interface smooth';
    const title = sessionDisplayTitle(undefined, longPrompt);
    expect(title).toBe('Redesign the complete settings experience while…');
    expect([...title].length).toBeLessThanOrEqual(58);
    expect(sessionDisplayTitle('  Hand-picked   title  ', longPrompt)).toBe('Hand-picked title');
    expect([...sessionDisplayTitle('x'.repeat(500), longPrompt)].length).toBeLessThanOrEqual(120);
    expect(sessionDisplayTitle('😀'.repeat(500), longPrompt).length).toBeLessThanOrEqual(200);
    expect(sessionDisplayTitle(undefined, '(no messages)')).toBe('Untitled session');
  });

  it('reads bounded default metadata and only hydrates the selected JSONL without SessionManager.list', async () => {
    const sessionsRoot = mkdtempSync(path.join(tmpdir(), 'fate-session-metadata-'));
    const projectPath = '/project';
    const sessionDir = projectSessionDirectory(projectPath, sessionsRoot);
    const sessionPath = path.join(sessionDir, 'fast.jsonl');
    mkdirSync(sessionDir, { recursive: true });
    const entries = [
      { type: 'session', version: 3, id: 'fast', timestamp: '2025-01-01T00:00:00.000Z', cwd: projectPath },
      { type: 'message', id: 'user', parentId: null, timestamp: '2025-01-01T00:00:01.000Z', message: { role: 'user', content: 'Inspect this saved session', timestamp: 1 } },
      { type: 'message', id: 'assistant', parentId: 'user', timestamp: '2025-01-01T00:00:02.000Z', message: { role: 'assistant', content: 'Already inspected', timestamp: 2 } },
      { type: 'custom', id: 'large', parentId: 'assistant', timestamp: '2025-01-01T00:00:03.000Z', customType: 'test', data: 'x'.repeat(300_000) },
      { type: 'message', id: 'tail-assistant', parentId: 'large', timestamp: '2025-01-01T00:00:04.000Z', message: { role: 'assistant', content: 'Tail searchable evidence', timestamp: 4 } },
      { type: 'session_info', id: 'name', parentId: 'tail-assistant', timestamp: '2025-01-01T00:00:05.000Z', name: 'Fast metadata title' },
    ];
    const list = vi.spyOn(SessionManager, 'list');
    try {
      writeFileSync(sessionPath, entries.map((entry) => JSON.stringify(entry)).join('\n').concat('\n'));
      const repository = new PiSessionRepository(undefined, sessionsRoot);

      await expect(repository.list(projectPath, 'fast')).resolves.toEqual([
        expect.objectContaining({ id: 'fast', title: 'Fast metadata title', firstMessage: 'Inspect this saved session', active: true }),
      ]);
      await expect(repository.list(projectPath, null, 'tail searchable')).resolves.toEqual([
        expect.objectContaining({ id: 'fast', title: 'Fast metadata title' }),
      ]);
      expect(list).not.toHaveBeenCalled();

      const snapshot = await repository.snapshot(projectPath, 'fast');
      expect(snapshot?.branch.map((entry) => entry.id)).toEqual(['user', 'assistant', 'large', 'tail-assistant', 'name']);
    } finally {
      list.mockRestore();
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it('streams a real >128 MiB JSONL session and preserves the active branch, recent history and metadata', async () => {
    const { sessionsRoot, sessionDir } = sessionStore();
    const sessionPath = path.join(sessionDir, 'large.jsonl');
    const fd = openSync(sessionPath, 'w');
    const append = (value: unknown) => writeSync(fd, `${JSON.stringify(value)}\n`);
    const timestamp = '2025-01-01T00:00:00.000Z';
    try {
      append({ type: 'session', version: 3, id: 'large', timestamp, cwd: '/project' });
      append({ type: 'message', id: 'root', parentId: null, timestamp, message: { role: 'user', content: 'First message from the saved file' } });
      append({ type: 'model_change', id: 'model', parentId: 'root', timestamp, provider: 'openai', modelId: 'gpt-4.1' });
      append({ type: 'thinking_level_change', id: 'thinking', parentId: 'model', timestamp, thinkingLevel: 'high' });
      append({ type: 'compaction', id: 'compact', parentId: 'thinking', timestamp, firstKeptEntryId: 'root', summary: 'Remember the prior work', tokensBefore: 7 });
      append({ type: 'custom', id: 'team-state', parentId: 'compact', timestamp, customType: 'fate-agent-team-event', data: { teamId: 'team-a', sequence: 1, payload: { team: { id: 'team-a', detail: 'y'.repeat(1_200_000) } } } });
      // Reuse one modest string; never make the fixture itself a 128 MiB JS value.
      const padding = 'x'.repeat(1024 * 1024);
      for (let index = 0; index < 130; index += 1) {
        append({ type: 'custom', id: `pad-${index}`, parentId: index ? `pad-${index - 1}` : 'team-state', timestamp, customType: 'unrelated-extension', data: padding });
      }
      append({ type: 'message', id: 'inactive', parentId: 'root', timestamp, message: { role: 'assistant', content: 'Do not show the wrong fork' } });
      append({ type: 'message', id: 'recent-user', parentId: 'pad-129', timestamp, message: { role: 'user', content: 'Show my recent question' } });
      append({ type: 'message', id: 'recent-assistant', parentId: 'recent-user', timestamp, message: { role: 'assistant', content: 'Show the recent answer', provider: 'openai', model: 'gpt-4.1', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.01 } } } });
      append({ type: 'session_info', id: 'renamed', parentId: 'recent-assistant', timestamp, name: 'Title beyond 128 MiB' });
      closeSync(fd);
      expect(statSync(sessionPath).size).toBeGreaterThan(128 * 1024 * 1024);
      const repository = new PiSessionRepository({ rename: vi.fn(), list: vi.fn(async () => [info(sessionDir, { id: 'large', path: sessionPath, firstMessage: '(no messages)' })]) }, sessionsRoot);
      const snapshot = await repository.snapshot('/project', 'large');
      expect(snapshot?.summary).toEqual(expect.objectContaining({ title: 'Title beyond 128 MiB', firstMessage: 'First message from the saved file', messageCount: 4 }));
      expect(snapshot?.entries).toHaveLength(139);
      expect(snapshot?.branch.map((entry) => entry.id)).toEqual(['root', 'model', 'thinking', 'compact', 'team-state', ...Array.from({ length: 130 }, (_, index) => `pad-${index}`), 'recent-user', 'recent-assistant', 'renamed']);
      expect(snapshot?.branch.find((entry) => entry.id === 'team-state')).toEqual(expect.objectContaining({ data: expect.objectContaining({ payload: expect.objectContaining({ team: expect.objectContaining({ id: 'team-a' }) }) }) }));
      expect(snapshot?.previewNotice).toMatch(/compact previews/i);
      expect(snapshot?.branch.some((entry) => entry.id === 'inactive')).toBe(false);
      expect(snapshot?.branch.find((entry) => entry.id === 'model')).toEqual(expect.objectContaining({ provider: 'openai', modelId: 'gpt-4.1' }));
      expect(snapshot?.branch.find((entry) => entry.id === 'thinking')).toEqual(expect.objectContaining({ thinkingLevel: 'high' }));
      expect(snapshot?.branch.find((entry) => entry.id === 'compact')).toEqual(expect.objectContaining({ summary: 'Remember the prior work', firstKeptEntryId: 'root' }));
      expect(snapshot?.branch.find((entry) => entry.id === 'recent-assistant')).toEqual(expect.objectContaining({ message: expect.objectContaining({ content: 'Show the recent answer' }) }));
      expect(snapshot?.entries.find((entry) => entry.id === 'inactive')).toEqual(expect.objectContaining({ message: expect.objectContaining({ role: 'assistant' }) }));
      // The preview may stream a huge file, but deleting a fork must still
      // reject it independently instead of allocating/replacing that file.
      const sizeBefore = statSync(sessionPath).size;
      await expect(repository.deleteBranch('/project', 'large', 'inactive', 'renamed')).rejects.toThrow(/too large to safely rewrite/i);
      expect(statSync(sessionPath).size).toBe(sizeBefore);
    } finally {
      try { closeSync(fd); } catch { /* Already closed after fixture generation. */ }
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  }, 90_000);

  it('does not let repeated hidden state evict the visible conversation from a large preview', async () => {
    const { sessionsRoot, sessionDir } = sessionStore();
    const sessionPath = path.join(sessionDir, 'hidden-state.jsonl');
    const fd = openSync(sessionPath, 'w');
    const timestamp = '2025-01-01T00:00:00.000Z';
    const content = `Retain my actual question: ${'q'.repeat(2 * 1024 * 1024)}`;
    try {
      writeSync(fd, `${JSON.stringify({ type: 'session', version: 3, id: 'hidden-state', timestamp, cwd: '/project' })}\n`);
      writeSync(fd, `${JSON.stringify({ type: 'message', id: 'question', parentId: null, timestamp, message: { role: 'user', content } })}\n`);
      const padding = 'x'.repeat(1024 * 1024);
      for (let index = 0; index < 30; index += 1) {
        writeSync(fd, `${JSON.stringify({ type: 'custom', customType: 'hidden-state', id: `state-${index}`, parentId: index ? `state-${index - 1}` : 'question', timestamp, data: padding })}\n`);
      }
      closeSync(fd);
      const repository = new PiSessionRepository(undefined, sessionsRoot);
      const snapshot = await repository.snapshot('/project', 'hidden-state');
      expect(snapshot?.branch.find((entry) => entry.id === 'question')).toEqual(expect.objectContaining({ message: expect.objectContaining({ content }) }));
      expect(snapshot?.branch.filter((entry) => entry.type === 'custom').every((entry) => !('data' in entry))).toBe(true);
    } finally {
      try { closeSync(fd); } catch { /* Closed after fixture generation. */ }
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it('preserves tool-result identity and outcome when its output is clipped from a large preview', async () => {
    const { sessionsRoot, sessionDir } = sessionStore();
    const sessionPath = path.join(sessionDir, 'clipped-result.jsonl');
    const fd = openSync(sessionPath, 'w');
    const timestamp = '2025-01-01T00:00:00.000Z';
    const padding = 'x'.repeat(2 * 1024 * 1024);
    try {
      writeSync(fd, `${JSON.stringify({ type: 'session', version: 3, id: 'clipped-result', timestamp, cwd: '/project' })}\n`);
      writeSync(fd, `${JSON.stringify({ type: 'message', id: 'call', parentId: null, timestamp, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tool-1', name: 'bash', arguments: {} }] } })}\n`);
      writeSync(fd, `${JSON.stringify({ type: 'message', id: 'result', parentId: 'call', timestamp, message: { role: 'toolResult', toolCallId: 'tool-1', toolName: 'bash', isError: true, content: [{ type: 'text', text: padding }] } })}\n`);
      for (let index = 0; index < 13; index += 1) {
        writeSync(fd, `${JSON.stringify({ type: 'message', id: `later-${index}`, parentId: index ? `later-${index - 1}` : 'result', timestamp, message: { role: 'user', content: padding } })}\n`);
      }
      closeSync(fd);
      const snapshot = await new PiSessionRepository(undefined, sessionsRoot).snapshot('/project', 'clipped-result');
      expect(snapshot?.branch.find((entry) => entry.id === 'result')).toEqual(expect.objectContaining({ message: expect.objectContaining({ role: 'toolResult', toolCallId: 'tool-1', toolName: 'bash', isError: true, content: expect.stringContaining('omitted') }) }));
    } finally {
      try { closeSync(fd); } catch { /* Closed after fixture generation. */ }
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it('refuses a known summary from a different project even inside the sessions root', async () => {
    const { sessionsRoot } = sessionStore();
    const otherDirectory = projectSessionDirectory('/other-project', sessionsRoot);
    const otherPath = path.join(otherDirectory, 'other.jsonl');
    try {
      mkdirSync(otherDirectory, { recursive: true });
      writeFileSync(otherPath, `${JSON.stringify({ type: 'session', id: 'other', timestamp: '2025-01-01T00:00:00.000Z', cwd: '/other-project' })}\n`);
      const repository = new PiSessionRepository({ rename: vi.fn(), list: vi.fn(async () => []) }, sessionsRoot);
      const summary = { id: 'other', path: otherPath, title: 'Other', firstMessage: '', createdAt: '2025-01-01T00:00:00.000Z', modifiedAt: '2025-01-01T00:00:00.000Z', messageCount: 0, active: false, attention: null };
      await expect(repository.snapshot('/project', 'other', summary)).resolves.toBeUndefined();
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it('keeps active branch state when a single valid entry exceeds the record budget', async () => {
    const { sessionsRoot, sessionDir } = sessionStore();
    const sessionPath = path.join(sessionDir, 'oversized-record.jsonl');
    const timestamp = '2025-01-01T00:00:00.000Z';
    try {
      const entries = [
        { type: 'session', id: 'oversized-record', version: 3, timestamp, cwd: '/project' },
        { type: 'model_change', id: 'root', parentId: null, timestamp, provider: 'anthropic', modelId: 'claude-sonnet' },
        // Deliberately put the ID *after* the giant content. A prefix-only
        // parser would lose this node and break the active parent chain.
        { type: 'message', message: { role: 'user', content: `very long ${'😀'.repeat(1_300_000)}` }, id: 'huge', parentId: 'root', timestamp },
        { type: 'message', id: 'recent', parentId: 'huge', timestamp, message: { role: 'assistant', content: 'The real tail' } },
      ];
      const fd = openSync(sessionPath, 'w');
      try {
        for (const entry of entries) writeSync(fd, `${JSON.stringify(entry)}\n`);
        // The invalid but structurally balanced giant line must not become
        // the active leaf merely because its header fields look plausible.
        writeSync(fd, `{"type":"message","id":"invalid-giant","parentId":"recent","message":{"role":"assistant","content":"${'x'.repeat(4 * 1024 * 1024)}"},"broken":nope}\n`);
        // Metadata extraction must never keep an earlier string when a later
        // duplicate routing key has JSON.parse's authoritative null value.
        writeSync(fd, `{"type":"message","id":"invented-id","parentId":"recent","message":{"role":"assistant","content":"${'x'.repeat(4 * 1024 * 1024)}"},"id":null}\n`);
        writeSync(fd, `{"type":"message","id":"invented-parent","parentId":"recent","message":{"role":"assistant","content":"${'x'.repeat(4 * 1024 * 1024)}"},"parentId":null}\n`);
      } finally { closeSync(fd); }
      const repository = new PiSessionRepository({ rename: vi.fn(), list: vi.fn(async () => [info(sessionDir, { id: 'oversized-record', path: sessionPath })]) }, sessionsRoot);
      const snapshot = await repository.snapshot('/project', 'oversized-record');
      expect(snapshot?.branch.map((entry) => entry.id)).toEqual(['root', 'huge', 'recent']);
      expect(snapshot?.branch[0]).toEqual(expect.objectContaining({ provider: 'anthropic', modelId: 'claude-sonnet' }));
      expect(snapshot?.branch[1]).toEqual(expect.objectContaining({ message: expect.objectContaining({ role: 'user', content: expect.stringContaining('omitted') }) }));
      expect(snapshot?.branch[2]).toEqual(expect.objectContaining({ message: expect.objectContaining({ content: 'The real tail' }) }));
      expect(snapshot?.entries.some((entry) => entry.id === 'invalid-giant')).toBe(false);
      expect(statSync(sessionPath).size).toBeGreaterThan(4 * 1024 * 1024);
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('does not present old running child state when its later state exceeds the record budget', async () => {
    const { sessionsRoot, sessionDir } = sessionStore();
    const sessionPath = path.join(sessionDir, 'child-state.jsonl');
    const timestamp = '2025-01-01T00:00:00.000Z';
    try {
      const entries = [
        { type: 'session', id: 'child-state', version: 3, timestamp, cwd: '/project' },
        { type: 'custom', customType: 'fate-agent-team-event', id: 'running', parentId: null, timestamp, data: { teamId: 'team-a', sequence: 1, payload: { team: { id: 'team-a', status: 'running' } } } },
        { type: 'custom', customType: 'fate-agent-team-event', id: 'completed', parentId: 'running', timestamp, data: { teamId: 'team-a', sequence: 2, payload: { team: { id: 'team-a', status: 'completed', detail: 'x'.repeat(4 * 1024 * 1024) } } } },
      ];
      writeFileSync(sessionPath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      const snapshot = await new PiSessionRepository(undefined, sessionsRoot).snapshot('/project', 'child-state');
      expect(snapshot?.branch.map((entry) => entry.id)).toEqual(['running', 'completed']);
      expect(snapshot?.branch.every((entry) => !('data' in entry))).toBe(true);
      expect(snapshot?.previewNotice).toContain('child-agent state');
    } finally { rmSync(sessionsRoot, { recursive: true, force: true }); }
  });

  it('follows the final metadata leaf rather than a newer sibling and retains settings on its own ancestry', async () => {
    const { sessionsRoot, sessionDir } = sessionStore();
    const sessionPath = path.join(sessionDir, 'branches.jsonl');
    const timestamp = '2025-01-01T00:00:00.000Z';
    try {
      const entries = [
        { type: 'session', id: 'branches', version: 3, timestamp, cwd: '/project' },
        { type: 'message', id: 'root', parentId: null, timestamp, message: { role: 'user', content: 'Start' } },
        { type: 'model_change', id: 'left-model', parentId: 'root', timestamp, provider: 'wrong', modelId: 'wrong' },
        { type: 'message', id: 'left-tail', parentId: 'left-model', timestamp, message: { role: 'assistant', content: 'Old fork' } },
        { type: 'model_change', id: 'right-model', parentId: 'root', timestamp, provider: 'right', modelId: 'right' },
        { type: 'thinking_level_change', id: 'right-thinking', parentId: 'right-model', timestamp, thinkingLevel: 'xhigh' },
        { type: 'compaction', id: 'right-compact', parentId: 'right-thinking', timestamp, summary: 'Keep this', firstKeptEntryId: 'root', tokensBefore: 100 },
        { type: 'message', id: 'inactive-late', parentId: 'left-tail', timestamp, message: { role: 'assistant', content: 'Newer, but not active' } },
        { type: 'session_info', id: 'active-leaf', parentId: 'right-compact', timestamp, name: 'Branch name' },
      ];
      writeFileSync(sessionPath, entries.map((entry) => JSON.stringify(entry)).join('\n').concat('\n'));
      const repository = new PiSessionRepository({ rename: vi.fn(), list: vi.fn(async () => [info(sessionDir, { id: 'branches', path: sessionPath })]) }, sessionsRoot);
      const snapshot = await repository.snapshot('/project', 'branches');
      expect(snapshot?.branch.map((entry) => entry.id)).toEqual(['root', 'right-model', 'right-thinking', 'right-compact', 'active-leaf']);
      expect(snapshot?.summary.title).toBe('Branch name');
      expect(snapshot?.branch[1]).toEqual(expect.objectContaining({ provider: 'right', modelId: 'right' }));
      expect(snapshot?.branch[3]).toEqual(expect.objectContaining({ summary: 'Keep this' }));
      expect(snapshot?.entries.map((entry) => entry.id)).toEqual(entries.slice(1).map((entry) => entry.id));
      expect(snapshot?.entries.find((entry) => entry.id === 'left-tail')).toEqual(entries[3]); // ordinary files stay exact
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it('projects, searches, sorts, and marks persistent Pi sessions', async () => {
    const { sessionsRoot, sessionDir } = sessionStore();
    try {
      const source = { rename: vi.fn(), remove: vi.fn(async () => undefined), list: vi.fn(async () => [
        info(sessionDir),
        info(sessionDir, { id: 'two', path: path.join(sessionDir, 'two.jsonl'), name: ' ', firstMessage: 'Build parser', allMessagesText: 'Build parser with zebra handling', modified: new Date('2025-01-03T00:00:00.000Z') }),
      ]) };
      const repository = new PiSessionRepository(source, sessionsRoot);
      const sessions = await repository.list('/project', 'two', 'zebra');
      expect(source.list).toHaveBeenCalledWith('/project', true);
      expect(sessions).toEqual([expect.objectContaining({ id: 'two', title: 'Build parser', active: true })]);
      await repository.rename('/project', 'two', 'Parser work');
      expect(source.rename).toHaveBeenCalledWith(path.join(sessionDir, 'two.jsonl'), 'Parser work');
      await expect(repository.renameIfUnnamed('/project', 'two', 'Generated title')).resolves.toBe(true);
      expect(source.rename).toHaveBeenCalledWith(path.join(sessionDir, 'two.jsonl'), 'Generated title');
      await expect(repository.renameIfUnnamed('/project', 'one', 'Must not replace manual title')).resolves.toBe(false);
      await repository.delete('/project', 'two');
      expect(source.remove).toHaveBeenCalledWith(path.join(sessionDir, 'two.jsonl'));
      await expect(repository.deleteAll('/project', new Set(['one']))).resolves.toBe(1);
      expect(source.remove).toHaveBeenCalledWith(path.join(sessionDir, 'two.jsonl'));
      expect(source.list).toHaveBeenCalledTimes(6);
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it('does not retain or even read full conversation search text for ordinary sidebar listings', async () => {
    const { sessionsRoot, sessionDir } = sessionStore();
    try {
      const session = info(sessionDir);
      Object.defineProperty(session, 'allMessagesText', { get: () => { throw new Error('full search text should stay cold'); } });
      const source = { rename: vi.fn(), list: vi.fn(async () => [session]) };
      const repository = new PiSessionRepository(source, sessionsRoot);

      await expect(repository.list('/project', null)).resolves.toEqual([expect.objectContaining({ id: 'one' })]);
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it('projects deeply nested session trees without recursive stack growth', () => {
    let node: { entry: Record<string, unknown>; children: typeof node[] } = {
      entry: { type: 'message', id: 'deep-9999', parentId: 'deep-9998', timestamp: '2025-01-01T00:00:00Z', message: { role: 'assistant', content: 'leaf' } },
      children: [],
    };
    for (let index = 9_998; index >= 0; index -= 1) {
      node = {
        entry: { type: 'message', id: `deep-${index}`, parentId: index ? `deep-${index - 1}` : null, timestamp: '2025-01-01T00:00:00Z', message: { role: 'assistant', content: '' } },
        children: [node],
      };
    }
    const session = { sessionManager: { getBranch: () => [], getTree: () => [node] } } as unknown as AgentSession;
    expect(new PiSessionRepository().branches(session)).toEqual([
      expect.objectContaining({ id: 'deep-9999', depth: 9_999 }),
    ]);
  });

  it('removes an inactive branch, its descendants, and its unshared ancestors without touching siblings', async () => {
    const { sessionsRoot, sessionDir } = sessionStore();
    const sessionPath = path.join(sessionDir, 'branch.jsonl');
    const header = { type: 'session', version: 3, id: 'branch-session', timestamp: '2025-01-01T00:00:00.000Z', cwd: '/project' };
    const root = { type: 'message', id: 'root', parentId: null, timestamp: '2025-01-01T00:00:01.000Z', message: { role: 'user', content: 'Root' } };
    const activeParent = { type: 'message', id: 'active-parent', parentId: 'root', timestamp: '2025-01-01T00:00:02.000Z', message: { role: 'assistant', content: 'Active parent' } };
    const active = { type: 'message', id: 'active', parentId: 'active-parent', timestamp: '2025-01-01T00:00:03.000Z', message: { role: 'assistant', content: 'Active' } };
    const removedParent = { type: 'message', id: 'removed-parent', parentId: 'root', timestamp: '2025-01-01T00:00:04.000Z', message: { role: 'assistant', content: 'Removed parent' } };
    const removed = { type: 'message', id: 'removed', parentId: 'removed-parent', timestamp: '2025-01-01T00:00:05.000Z', message: { role: 'assistant', content: 'Removed' } };
    const removedChild = { type: 'message', id: 'removed-child', parentId: 'removed', timestamp: '2025-01-01T00:00:06.000Z', message: { role: 'assistant', content: 'Removed child' } };
    const sibling = { type: 'message', id: 'sibling', parentId: 'root', timestamp: '2025-01-01T00:00:07.000Z', message: { role: 'assistant', content: 'Sibling' } };
    const removedReference = { type: 'label', id: 'label-remove', parentId: 'active', timestamp: '2025-01-01T00:00:08.000Z', targetId: 'removed-child', label: 'Discarded' };
    const keptReference = { type: 'label', id: 'label-keep', parentId: 'active', timestamp: '2025-01-01T00:00:09.000Z', targetId: 'active', label: 'Current' };
    try {
      writeFileSync(sessionPath, [header, root, activeParent, active, removedParent, removed, removedChild, sibling, removedReference, keptReference]
        .map((entry) => JSON.stringify(entry)).join('\n').concat('\n'));
      const repository = new PiSessionRepository({ rename: vi.fn(), list: vi.fn(async () => [info(sessionDir, { id: 'branch-session', path: sessionPath })]) }, sessionsRoot);

      await repository.deleteBranch('/project', 'branch-session', 'removed', 'active');

      expect(readFileSync(sessionPath, 'utf8')).toBe(
        [header, root, activeParent, active, sibling, keptReference].map((entry) => JSON.stringify(entry)).join('\n').concat('\n'),
      );
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it('deletes a 10,000-entry inactive branch without recursive stack growth', async () => {
    const { sessionsRoot, sessionDir } = sessionStore();
    const sessionPath = path.join(sessionDir, 'deep-branch.jsonl');
    const header = { type: 'session', version: 3, id: 'deep-branch-session', timestamp: '2025-01-01T00:00:00.000Z', cwd: '/project' };
    const root = { type: 'message', id: 'root', parentId: null, timestamp: '2025-01-01T00:00:01.000Z', message: { role: 'user', content: 'Root' } };
    const active = { type: 'message', id: 'active', parentId: 'root', timestamp: '2025-01-01T00:00:02.000Z', message: { role: 'assistant', content: 'Active' } };
    try {
      const entries: unknown[] = [header, root, active];
      for (let index = 0; index < 10_000; index += 1) {
        entries.push({
          type: 'message', id: `fork-${index}`, parentId: index === 0 ? 'root' : `fork-${index - 1}`,
          timestamp: '2025-01-01T00:00:03.000Z', message: { role: 'assistant', content: 'Fork' },
        });
      }
      writeFileSync(sessionPath, entries.map((entry) => JSON.stringify(entry)).join('\n').concat('\n'));
      const repository = new PiSessionRepository({ rename: vi.fn(), list: vi.fn(async () => [info(sessionDir, { id: 'deep-branch-session', path: sessionPath })]) }, sessionsRoot);

      await repository.deleteBranch('/project', 'deep-branch-session', 'fork-9999', 'active');

      expect(readFileSync(sessionPath, 'utf8')).toBe([header, root, active].map((entry) => JSON.stringify(entry)).join('\n').concat('\n'));
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it('terminates on a cyclic inactive branch and removes the complete cycle', async () => {
    const { sessionsRoot, sessionDir } = sessionStore();
    const sessionPath = path.join(sessionDir, 'cyclic-branch.jsonl');
    const header = { type: 'session', version: 3, id: 'cyclic-session', timestamp: '2025-01-01T00:00:00.000Z', cwd: '/project' };
    const root = { type: 'message', id: 'root', parentId: null, timestamp: '2025-01-01T00:00:01.000Z', message: { role: 'user', content: 'Root' } };
    const active = { type: 'message', id: 'active', parentId: 'root', timestamp: '2025-01-01T00:00:02.000Z', message: { role: 'assistant', content: 'Active' } };
    const cycleA = { type: 'message', id: 'cycle-a', parentId: 'cycle-b', timestamp: '2025-01-01T00:00:03.000Z', message: { role: 'assistant', content: 'Cycle A' } };
    const cycleB = { type: 'message', id: 'cycle-b', parentId: 'cycle-a', timestamp: '2025-01-01T00:00:04.000Z', message: { role: 'assistant', content: 'Cycle B' } };
    try {
      writeFileSync(sessionPath, [header, root, active, cycleA, cycleB].map((entry) => JSON.stringify(entry)).join('\n').concat('\n'));
      const repository = new PiSessionRepository({ rename: vi.fn(), list: vi.fn(async () => [info(sessionDir, { id: 'cyclic-session', path: sessionPath })]) }, sessionsRoot);

      await repository.deleteBranch('/project', 'cyclic-session', 'cycle-a', 'active');

      expect(readFileSync(sessionPath, 'utf8')).toBe([header, root, active].map((entry) => JSON.stringify(entry)).join('\n').concat('\n'));
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it('removes an inactive branch whose parent is missing without affecting valid entries', async () => {
    const { sessionsRoot, sessionDir } = sessionStore();
    const sessionPath = path.join(sessionDir, 'orphan-branch.jsonl');
    const header = { type: 'session', version: 3, id: 'orphan-session', timestamp: '2025-01-01T00:00:00.000Z', cwd: '/project' };
    const root = { type: 'message', id: 'root', parentId: null, timestamp: '2025-01-01T00:00:01.000Z', message: { role: 'user', content: 'Root' } };
    const active = { type: 'message', id: 'active', parentId: 'root', timestamp: '2025-01-01T00:00:02.000Z', message: { role: 'assistant', content: 'Active' } };
    const sibling = { type: 'message', id: 'sibling', parentId: 'root', timestamp: '2025-01-01T00:00:03.000Z', message: { role: 'assistant', content: 'Sibling' } };
    const orphan = { type: 'message', id: 'orphan', parentId: 'missing', timestamp: '2025-01-01T00:00:04.000Z', message: { role: 'assistant', content: 'Orphan' } };
    const orphanChild = { type: 'message', id: 'orphan-child', parentId: 'orphan', timestamp: '2025-01-01T00:00:05.000Z', message: { role: 'assistant', content: 'Orphan child' } };
    try {
      writeFileSync(sessionPath, [header, root, active, sibling, orphan, orphanChild].map((entry) => JSON.stringify(entry)).join('\n').concat('\n'));
      const repository = new PiSessionRepository({ rename: vi.fn(), list: vi.fn(async () => [info(sessionDir, { id: 'orphan-session', path: sessionPath })]) }, sessionsRoot);

      await repository.deleteBranch('/project', 'orphan-session', 'orphan', 'active');

      expect(readFileSync(sessionPath, 'utf8')).toBe([header, root, active, sibling].map((entry) => JSON.stringify(entry)).join('\n').concat('\n'));
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it('refuses to delete the active path or its ancestors', async () => {
    const { sessionsRoot, sessionDir } = sessionStore();
    const sessionPath = path.join(sessionDir, 'active.jsonl');
    try {
      writeFileSync(sessionPath, [
        { type: 'session', version: 3, id: 'active-session', timestamp: '2025-01-01T00:00:00.000Z', cwd: '/project' },
        { type: 'message', id: 'root', parentId: null, timestamp: '2025-01-01T00:00:01.000Z', message: { role: 'user', content: 'Root' } },
        { type: 'message', id: 'leaf', parentId: 'root', timestamp: '2025-01-01T00:00:02.000Z', message: { role: 'assistant', content: 'Leaf' } },
      ].map((entry) => JSON.stringify(entry)).join('\n').concat('\n'));
      const repository = new PiSessionRepository({ rename: vi.fn(), list: vi.fn(async () => [info(sessionDir, { id: 'active-session', path: sessionPath })]) }, sessionsRoot);
      await expect(repository.deleteBranch('/project', 'active-session', 'root', 'leaf')).rejects.toThrow('Switch to a different conversation path');
      expect(readFileSync(sessionPath, 'utf8')).toContain('"leaf"');
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it('flattens the SDK session tree and identifies the active branch', () => {
    const first = { type: 'message', id: 'u1', parentId: null, timestamp: '2025-01-01T00:00:00Z', message: { role: 'user', content: 'First direction', timestamp: 1 } };
    const active = { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2025-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Current answer' }], timestamp: 2 } };
    const alternate = { type: 'message', id: 'u2', parentId: 'u1', timestamp: '2025-01-01T00:00:02Z', message: { role: 'user', content: 'Alternate direction', timestamp: 3 } };
    const session = {
      sessionManager: {
        getBranch: () => [first, active],
        getTree: () => [{ entry: first, children: [{ entry: active, children: [], label: 'current' }, { entry: alternate, children: [] }] }],
      },
    } as unknown as AgentSession;
    const branches = new PiSessionRepository().branches(session);
    expect(branches).toEqual([
      expect.objectContaining({ id: 'a1', depth: 1, active: true, label: 'current', preview: 'Current answer' }),
      expect.objectContaining({ id: 'u2', depth: 1, active: false, preview: 'Alternate direction' }),
    ]);
  });

  describe('delete-all containment', () => {
    it('deletes every session except the excluded ones in one pass', async () => {
      const { sessionsRoot, sessionDir } = sessionStore();
      try {
        const remove = vi.fn(async () => undefined);
        const source = {
          rename: vi.fn(),
          remove,
          list: vi.fn(async () => [
            info(sessionDir),
            info(sessionDir, { id: 'two', path: path.join(sessionDir, 'two.jsonl') }),
            info(sessionDir, { id: 'three', path: path.join(sessionDir, 'three.jsonl') }),
          ]),
        };
        const repository = new PiSessionRepository(source, sessionsRoot);
        const deleted = await repository.deleteAll('/project', new Set(['two']));
        expect(deleted).toBe(2);
        expect(remove).toHaveBeenCalledWith(path.join(sessionDir, 'one.jsonl'));
        expect(remove).toHaveBeenCalledWith(path.join(sessionDir, 'three.jsonl'));
        expect(remove).not.toHaveBeenCalledWith(path.join(sessionDir, 'two.jsonl'));
        expect(source.list).toHaveBeenCalledOnce();
      } finally {
        rmSync(sessionsRoot, { recursive: true, force: true });
      }
    });

    it('reloads the summary cache after a batch delete (next read re-lists from disk)', async () => {
      const { sessionsRoot, sessionDir } = sessionStore();
      try {
        const source = {
          rename: vi.fn(),
          remove: vi.fn(async () => undefined),
          list: vi.fn(async () => [info(sessionDir)]),
        };
        const repository = new PiSessionRepository(source, sessionsRoot);
        await repository.list('/project', null);
        expect(source.list).toHaveBeenCalledTimes(1);
        await repository.list('/project', null);
        expect(source.list).toHaveBeenCalledTimes(1); // served from cache
        await repository.deleteAll('/project');
        await repository.list('/project', null);
        expect(source.list).toHaveBeenCalledTimes(3); // cache invalidated → reload
      } finally {
        rmSync(sessionsRoot, { recursive: true, force: true });
      }
    });

    it('refuses to delete a session file that escapes the project session directory', async () => {
      const { sessionsRoot, sessionDir } = sessionStore();
      const outside = path.join(path.dirname(sessionsRoot), 'victim.jsonl');
      try {
        const remove = vi.fn(async () => undefined);
        const source = {
          rename: vi.fn(),
          remove,
          list: vi.fn(async () => [
            info(sessionDir),
            info(sessionDir, { id: 'escape', path: outside }),
          ]),
        };
        const repository = new PiSessionRepository(source, sessionsRoot);
        await expect(repository.deleteAll('/project')).rejects.toThrow('outside this project');
        expect(remove).not.toHaveBeenCalled(); // fail closed: nothing deleted
      } finally {
        rmSync(sessionsRoot, { recursive: true, force: true });
      }
    });

    it('refuses to delete sessions from a different project in the same listing', async () => {
      const { sessionsRoot, sessionDir } = sessionStore();
      const otherDir = path.join(sessionsRoot, '--other-project--');
      mkdirSync(otherDir, { recursive: true });
      try {
        const remove = vi.fn(async () => undefined);
        const source = {
          rename: vi.fn(),
          remove,
          list: vi.fn(async () => [
            info(sessionDir),
            info(sessionDir, { id: 'other', path: path.join(otherDir, 'other.jsonl') }),
          ]),
        };
        const repository = new PiSessionRepository(source, sessionsRoot);
        await expect(repository.deleteAll('/project')).rejects.toThrow('outside this project');
        expect(remove).not.toHaveBeenCalled();
      } finally {
        rmSync(sessionsRoot, { recursive: true, force: true });
      }
    });

    it('refuses non-jsonl paths, nested paths, and directory roots', async () => {
      const { sessionsRoot, sessionDir } = sessionStore();
      const cases = [
        path.join(sessionDir, 'notes.txt'),
        path.join(sessionDir, 'nested', 'one.jsonl'),
        path.join(sessionsRoot, 'one.jsonl'),
      ];
      try {
        for (const badPath of cases) {
          const remove = vi.fn(async () => undefined);
          const source = {
            rename: vi.fn(),
            remove,
            list: vi.fn(async () => [info(sessionDir, { id: 'bad', path: badPath })]),
          };
          const repository = new PiSessionRepository(source, sessionsRoot);
          await expect(repository.deleteAll('/project')).rejects.toThrow('outside this project');
          expect(remove).not.toHaveBeenCalled();
          await expect(repository.delete('/project', 'bad')).rejects.toThrow('outside this project');
        }
      } finally {
        rmSync(sessionsRoot, { recursive: true, force: true });
      }
    });

    it('classifies only direct .jsonl children of project session directories as safe', () => {
      const { sessionsRoot, sessionDir } = sessionStore();
      try {
        expect(isSafeSessionPath(sessionsRoot, path.join(sessionDir, 'one.jsonl'))).toBe(true);
        expect(isSafeSessionPath(sessionsRoot, path.join(sessionDir, 'deep', 'one.jsonl'))).toBe(false);
        expect(isSafeSessionPath(sessionsRoot, path.join(sessionDir, 'one.txt'))).toBe(false);
        expect(isSafeSessionPath(sessionsRoot, path.join(sessionsRoot, 'one.jsonl'))).toBe(false);
        expect(isSafeSessionPath(sessionsRoot, path.join(path.dirname(sessionsRoot), 'one.jsonl'))).toBe(false);
        expect(isSafeSessionPath(sessionsRoot, '')).toBe(false);
      } finally {
        rmSync(sessionsRoot, { recursive: true, force: true });
      }
    });
  });
});
