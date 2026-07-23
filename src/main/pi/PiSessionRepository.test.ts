import type { AgentSession, SessionInfo } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { PiSessionRepository } from './PiSessionRepository';

const info = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  path: '/sessions/one.jsonl', id: 'one', cwd: '/project', name: 'Fix auth',
  created: new Date('2025-01-01T00:00:00.000Z'), modified: new Date('2025-01-02T00:00:00.000Z'),
  messageCount: 3, firstMessage: 'Investigate login', allMessagesText: 'Investigate login token refresh',
  ...overrides,
});

describe('PiSessionRepository', () => {
  it('projects, searches, sorts, and marks persistent Pi sessions', async () => {
    const source = { list: vi.fn(async () => [
      info(),
      info({ id: 'two', path: '/sessions/two.jsonl', name: ' ', firstMessage: 'Build parser', allMessagesText: 'Build parser with zebra handling', modified: new Date('2025-01-03T00:00:00.000Z') }),
    ]) };
    const repository = new PiSessionRepository(source);
    const sessions = await repository.list('/project', 'two', 'zebra');
    expect(source.list).toHaveBeenCalledWith('/project');
    expect(sessions).toEqual([expect.objectContaining({ id: 'two', title: 'Build parser', active: true })]);
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
      expect.objectContaining({ id: 'u1', depth: 0, active: true, preview: 'First direction' }),
      expect.objectContaining({ id: 'a1', depth: 1, active: true, label: 'current' }),
      expect.objectContaining({ id: 'u2', depth: 1, active: false, preview: 'Alternate direction' }),
    ]);
  });
});
