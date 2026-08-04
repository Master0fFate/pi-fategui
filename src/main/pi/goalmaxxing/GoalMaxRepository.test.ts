import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoalMaxState } from '../../../shared/contracts/goalmaxxing';
import { migrateGoalMaxSnapshot } from './GoalMaxMigrations';
import { GoalMaxRepository } from './GoalMaxRepository';

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function state(revision = 1): GoalMaxState {
  const now = 10;
  return {
    schemaVersion: 2, id: 'goal-1', sessionId: 'session-1', projectPath: '/project', revision,
    objective: 'Ship the feature', originalBriefRef: null, originalBriefHash: null, status: 'active', phase: 'implementation', executionState: 'idle',
    verificationLevel: 'normal', agentStrategy: 'auto',
    criteria: [{ id: 'criterion-1', title: 'Ship', description: 'Ship', required: true, status: 'pending', evidenceIds: [], ownerNodeIds: [], updatedAt: now }],
    budget: { tokenLimit: null, timeLimitMs: null, source: null }, permission: { permissionLevel: 'edit', projectTrusted: true, revision: 1, resolvedAt: now },
    progress: { meaningfulTurnCount: 0, noProgressTurnCount: 0, repeatedFailureCount: 0, planningOnlyTurnCount: 0, changedFileCount: 0, baselineWorkspaceFingerprint: 'a', latestWorkspaceFingerprint: 'a', latestEvidenceAt: null, latestMeaningfulProgressAt: null, lastFailureFingerprint: null },
    evidence: [], continuation: { pending: false, attempt: 0, lastScheduledAt: null, lastSettledAt: null, reason: null }, steering: [], childAssignments: [],
    tokensUsed: 0, tokenBaseline: 0, elapsedMs: 0, timeline: [], createdAt: now, updatedAt: now, startedAt: now, completedAt: null, blockedReason: null, failure: null,
  };
}

describe('GoalMax repository', () => {
  it('migrates v1 snapshots into the durable steering schema', () => {
    const { steering: _steering, ...legacy } = state();
    expect(migrateGoalMaxSnapshot({ ...legacy, schemaVersion: 1 })).toMatchObject({ schemaVersion: 2, steering: [] });
  });

  it('atomically round-trips snapshots and enforces revision compare-and-swap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'goalmax-repo-')); roots.push(root);
    const logs = { write: vi.fn() };
    const repository = new GoalMaxRepository(logs, root);
    await repository.save(state(), null);
    await expect(repository.load('/project', 'session-1')).resolves.toEqual(state());
    await expect(repository.save({ ...state(2), updatedAt: 20 }, 0)).rejects.toThrow(/changed before/u);
    await expect(repository.save({ ...state(3), updatedAt: 20 }, 1)).rejects.toThrow(/exactly one revision/u);
    await repository.save({ ...state(2), updatedAt: 20 }, 1);
    await expect(repository.load('/project', 'session-1')).resolves.toMatchObject({ revision: 2, updatedAt: 20 });
  });

  it('stores long briefs by content identity so a stale edit cannot overwrite the active source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'goalmax-repo-')); roots.push(root);
    const repository = new GoalMaxRepository({ write: vi.fn() }, root);
    const first = await repository.saveBrief('/project', 'session-1', 'goal-1', 'first brief');
    const second = await repository.saveBrief('/project', 'session-1', 'goal-1', 'second brief');
    expect(first.ref).not.toBe(second.ref);
    const current = { ...state(), originalBriefRef: second.ref, originalBriefHash: second.hash };
    await repository.save(current, null);

    await repository.archiveAndClear(current);

    const briefs = (await findFiles(root)).filter((file) => file.endsWith('.txt'));
    expect(briefs).toHaveLength(2);
    await expect(Promise.all(briefs.map((file) => readFile(file, 'utf8')))).resolves.toEqual(expect.arrayContaining(['first brief', 'second brief']));
  });

  it('rejects a recovered long brief when its integrity hash no longer matches', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'goalmax-repo-')); roots.push(root);
    const logs = { write: vi.fn() };
    const repository = new GoalMaxRepository(logs, root);
    const saved = await repository.saveBrief('/project', 'session-1', 'goal-1', 'trusted brief');
    await repository.save({ ...state(), originalBriefRef: saved.ref, originalBriefHash: saved.hash }, null);
    const brief = (await findFiles(root)).find((file) => file.endsWith(saved.ref))!;
    await writeFile(brief, 'tampered brief', 'utf8');

    await expect(new GoalMaxRepository(logs, root).load('/project', 'session-1')).resolves.toBeNull();
    expect(logs.write).toHaveBeenCalledWith('warn', 'goalmaxxing', expect.stringContaining('integrity'));
  });

  it('archives a cleared goal and ignores malformed recovery snapshots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'goalmax-repo-')); roots.push(root);
    const logs = { write: vi.fn() };
    const repository = new GoalMaxRepository(logs, root);
    await repository.save(state(), null);
    await repository.archiveAndClear(state());
    await expect(repository.load('/project', 'session-1')).resolves.toBeNull();
    const files = await findFiles(root);
    expect(files.some((file) => file.includes(`${path.sep}archive${path.sep}`) && file.endsWith('.json'))).toBe(true);

    await repository.save(state(), null);
    const current = (await findFiles(root)).find((file) => file.endsWith('current.json'))!;
    await writeFile(current, '{ malformed', 'utf8');
    await expect(new GoalMaxRepository(logs, root).load('/project', 'session-1')).resolves.toBeNull();
    expect(logs.write).toHaveBeenCalledWith('warn', 'goalmaxxing', expect.stringContaining('ignored'));
    expect(await readFile(current, 'utf8')).toContain('malformed');
  });
});

async function findFiles(root: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const result: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target); else result.push(target);
    }
  };
  await visit(root);
  return result;
}
