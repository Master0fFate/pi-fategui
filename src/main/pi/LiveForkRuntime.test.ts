/**
 * Live fork-deletion smoke test against the REAL Pi SDK, headless.
 *
 * Builds a real branched session with the real SDK SessionManager (pinned to an
 * isolated temp session directory), then runs the production
 * PiSessionRepository.deleteBranch path with a real SDK-backed source (real
 * SessionManager.list + real file IO). Verifies the rewritten file re-opens
 * with the deleted fork's whole subtree gone, the active leaf intact, and the
 * deletion persisted across a fresh "restart" load.
 */
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { PiSessionRepository, type SessionRepositorySource } from './PiSessionRepository';

let root: string;
let projectPath: string;
let sessionDir: string;
let repository: PiSessionRepository;
let sessionFile: string;
let sessionId: string;
interface LiveEntryIds { a1: string; a2: string; a3: string; u2b: string; a2b: string; u3b: string; a3b: string }
let ids: LiveEntryIds;

function textMessage(role: 'user' | 'assistant', text: string): Parameters<SessionManager['appendMessage']>[0] {
  return { role, content: [{ type: 'text', text }], timestamp: Date.now() } as Parameters<SessionManager['appendMessage']>[0];
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'fate-live-runtime-'));
  projectPath = path.join(root, 'project');
  sessionDir = path.join(root, 'agent', 'sessions', '--live--');
  await mkdir(sessionDir, { recursive: true });
  await mkdir(projectPath, { recursive: true });

  // Build a real 3-branch session with the real SDK.
  const manager = SessionManager.create(projectPath, sessionDir);
  manager.appendModelChange('zai', 'glm-5.2');
  manager.appendThinkingLevelChange('medium');
  manager.appendMessage(textMessage('user', 'Seed prompt one'));
  const a1 = manager.appendMessage(textMessage('assistant', 'FIRST REPLY MAIN'));
  manager.appendMessage(textMessage('user', 'Seed prompt two'));
  const a2 = manager.appendMessage(textMessage('assistant', 'SECOND REPLY MAIN'));
  manager.appendMessage(textMessage('user', 'Seed prompt three branch one'));
  const a3 = manager.appendMessage(textMessage('assistant', 'THIRD REPLY BRANCH ONE'));
  manager.branch(a1);
  const u2b = manager.appendMessage(textMessage('user', 'Seed alternate prompt two'));
  const a2b = manager.appendMessage(textMessage('assistant', 'ALTERNATE REPLY FORK TWO'));
  manager.branch(a2);
  const u3b = manager.appendMessage(textMessage('user', 'Seed variant prompt three'));
  const a3b = manager.appendMessage(textMessage('assistant', 'VARIANT REPLY FORK THREE'));
  sessionFile = manager.getSessionFile()!;
  sessionId = manager.getSessionId();
  expect(sessionFile).toBeTruthy();

  ids = { a1, a2, a3, u2b, a2b, u3b, a3b };
  const source: SessionRepositorySource = {
    list: (cwd) => SessionManager.list(cwd, sessionDir),
    rename: (sessionPath, name) => { SessionManager.open(sessionPath, sessionDir).appendSessionInfo(name); },
    remove: async (sessionPath) => { await rm(sessionPath); },
  };
  repository = new PiSessionRepository(source, path.join(root, 'agent', 'sessions'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function openSession(): SessionManager {
  return SessionManager.open(sessionFile, sessionDir, projectPath);
}

describe('live fork deletion against the real Pi SDK', () => {
  it('lists the seeded session with three branches', () => {
    const branches = repository.branches({ sessionManager: openSession() } as unknown as AgentSession);
    expect(branches.length).toBe(3);
    const active = branches.filter((branch) => branch.active);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(ids.a3b);
    expect(branches.map((branch) => branch.id).sort()).toEqual(
      [ids.a3, ids.a2b, ids.a3b].sort(),
    );
  });

  it('refuses to delete the active leaf or an ancestor of the active leaf', async () => {
    await expect(repository.deleteBranch(projectPath, sessionId, ids.a3b, ids.a3b)).rejects.toThrow(/conversation path/i);
    await expect(repository.deleteBranch(projectPath, sessionId, ids.a2, ids.a3b)).rejects.toThrow(/conversation path/i);
  });

  it('deletes a multi-entry inactive fork entirely and preserves the active path', async () => {
    await repository.deleteBranch(projectPath, sessionId, ids.a2b, ids.a3b);

    const contents = await readFile(sessionFile, 'utf8');
    expect(contents).not.toContain('ALTERNATE REPLY FORK TWO');
    expect(contents).not.toContain('Seed alternate prompt two');
    for (const retained of ['FIRST REPLY MAIN', 'SECOND REPLY MAIN', 'THIRD REPLY BRANCH ONE', 'VARIANT REPLY FORK THREE']) {
      expect(contents).toContain(retained);
    }

    // Fresh "restart" load through the real SDK: the whole fork subtree is gone.
    const reopened = openSession();
    const entries = reopened.getEntries() as Array<{ id: string }>;
    expect(entries.some((entry) => entry.id === ids.u2b)).toBe(false);
    expect(entries.some((entry) => entry.id === ids.a2b)).toBe(false);
    expect(entries.some((entry) => entry.id === ids.a3)).toBe(true);
    expect(entries.some((entry) => entry.id === ids.a3b)).toBe(true);
    expect(reopened.getLeafId()).toBe(ids.a3b);

    const branches = repository.branches({ sessionManager: reopened } as unknown as AgentSession);
    expect(branches.length).toBe(2);
    expect(branches.filter((branch) => branch.active)).toHaveLength(1);
    expect(branches.some((branch) => branch.id === ids.a2b)).toBe(false);
  });

  it('persists the deletion across a second independent load and listing', async () => {
    const sessions = await repository.list(projectPath, null);
    expect(sessions.some((session) => session.id === sessionId)).toBe(true);
    const listed = sessions.find((session) => session.id === sessionId)!;
    expect(listed.path).toBe(sessionFile);
    const reopened = SessionManager.open(listed.path, sessionDir, projectPath);
    expect(reopened.getLeafId()).toBe(ids.a3b);
    const context = reopened.buildSessionContext();
    const serialized = context.messages.map((message) => JSON.stringify(message)).join('\n');
    expect(serialized).toContain('VARIANT REPLY FORK THREE');
    expect(serialized).not.toContain('ALTERNATE REPLY FORK TWO');
    expect(serialized).not.toContain('THIRD REPLY BRANCH ONE');
    expect(serialized).toContain('SECOND REPLY MAIN');
  });
});
