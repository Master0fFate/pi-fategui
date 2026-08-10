import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentSession, SessionInfo } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { isSafeSessionPath, PiSessionRepository, sessionDisplayTitle } from './PiSessionRepository';

/**
 * A realistic session store layout: `<sessionsRoot>/--<encoded project>--/<name>.jsonl`,
 * exactly as the Pi SDK lays it out under ~/.pi/agent/sessions/. Tests create a
 * temp root so the containment checks see a real, isolated store.
 */
function sessionStore() {
  const sessionsRoot = mkdtempSync(path.join(tmpdir(), 'fate-sessions-'));
  const sessionDir = path.join(sessionsRoot, '--project--');
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

  it('projects, searches, sorts, and marks persistent Pi sessions', async () => {
    const { sessionsRoot, sessionDir } = sessionStore();
    try {
      const source = { rename: vi.fn(), remove: vi.fn(async () => undefined), list: vi.fn(async () => [
        info(sessionDir),
        info(sessionDir, { id: 'two', path: path.join(sessionDir, 'two.jsonl'), name: ' ', firstMessage: 'Build parser', allMessagesText: 'Build parser with zebra handling', modified: new Date('2025-01-03T00:00:00.000Z') }),
      ]) };
      const repository = new PiSessionRepository(source, sessionsRoot);
      const sessions = await repository.list('/project', 'two', 'zebra');
      expect(source.list).toHaveBeenCalledWith('/project');
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
