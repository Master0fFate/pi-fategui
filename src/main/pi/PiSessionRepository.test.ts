import type { AgentSession, SessionInfo } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { PiSessionRepository, sessionDisplayTitle } from './PiSessionRepository';

const info = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  path: '/sessions/one.jsonl', id: 'one', cwd: '/project', name: 'Fix auth',
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

  it('projects, searches, sorts, and marks persistent Pi sessions', async () => {
    const source = { rename: vi.fn(), remove: vi.fn(async () => undefined), list: vi.fn(async () => [
      info(),
      info({ id: 'two', path: '/sessions/two.jsonl', name: ' ', firstMessage: 'Build parser', allMessagesText: 'Build parser with zebra handling', modified: new Date('2025-01-03T00:00:00.000Z') }),
    ]) };
    const repository = new PiSessionRepository(source);
    const sessions = await repository.list('/project', 'two', 'zebra');
    expect(source.list).toHaveBeenCalledWith('/project');
    expect(sessions).toEqual([expect.objectContaining({ id: 'two', title: 'Build parser', active: true })]);
    await repository.rename('/project', 'two', 'Parser work');
    expect(source.rename).toHaveBeenCalledWith('/sessions/two.jsonl', 'Parser work');
    await expect(repository.renameIfUnnamed('/project', 'two', 'Generated title')).resolves.toBe(true);
    expect(source.rename).toHaveBeenCalledWith('/sessions/two.jsonl', 'Generated title');
    await expect(repository.renameIfUnnamed('/project', 'one', 'Must not replace manual title')).resolves.toBe(false);
    await repository.delete('/project', 'two');
    expect(source.remove).toHaveBeenCalledWith('/sessions/two.jsonl');
    await expect(repository.deleteAll('/project', new Set(['one']))).resolves.toBe(1);
    expect(source.remove).toHaveBeenCalledWith('/sessions/two.jsonl');
    expect(source.list).toHaveBeenCalledTimes(6);
  });

  it('does not retain or even read full conversation search text for ordinary sidebar listings', async () => {
    const session = info();
    Object.defineProperty(session, 'allMessagesText', { get: () => { throw new Error('full search text should stay cold'); } });
    const source = { rename: vi.fn(), list: vi.fn(async () => [session]) };
    const repository = new PiSessionRepository(source);

    await expect(repository.list('/project', null)).resolves.toEqual([expect.objectContaining({ id: 'one' })]);
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
});
