import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { DefinitionJournal } from './DefinitionJournal';
import { RoutineLedger } from './RoutineLedger';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agents-scheduler-')));
  roots.push(root);
  const first = new RoutineLedger(new DefinitionJournal(root, 2));
  const second = new RoutineLedger(new DefinitionJournal(root, 2));
  await first.create('routine-1', { anchor: 0, intervalMs: 60_000, timeZone: 'America/New_York' });
  return { root, first, second };
}

describe('D0-05 persisted schedule/claim transaction proof', () => {
  it('admits one auditable occurrence when two scheduler instances race', async () => {
    const { first, second } = await fixture();
    const results = await Promise.allSettled([first.tick('routine-1', 0), second.tick('routine-1', 0)]);
    const admitted = results.filter((result) => result.status === 'fulfilled' && result.value !== null);
    expect(admitted).toHaveLength(1);
    const { state } = await second.read('routine-1');
    expect(state.nextDue).toBe(60_000);
    expect(state.runs).toEqual([expect.objectContaining({ id: 'routine-1:1:0', status: 'queued' })]);
    expect(await second.tick('routine-1', 0)).toBeNull();
  });

  it('grants one persisted claim when two executors race, before any execution', async () => {
    const { first, second } = await fixture();
    const run = await first.tick('routine-1', 0);
    const results = await Promise.allSettled([first.claim('routine-1', run!.id, 'first', 0), second.claim('routine-1', run!.id, 'second', 0)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const { state } = await first.read('routine-1');
    expect(state.runs[0]).toMatchObject({ status: 'running', attempt: 1, expiresAt: 60_000 });
    await expect(first.claim('routine-1', run!.id, 'third', 1)).rejects.toThrow(/claimed/);
  });

  it('survives process restart without rerunning an uncertain effect or repeating the due instant', async () => {
    const { root, first } = await fixture();
    const run = await first.tick('routine-1', 0);
    await first.claim('routine-1', run!.id, 'old-process', 0);
    const restarted = new RoutineLedger(new DefinitionJournal(root));
    await restarted.recover('routine-1', 10, true);
    expect((await restarted.read('routine-1')).state.runs[0]?.status).toBe('running');
    await restarted.recover('routine-1', 60_000, true);
    expect((await restarted.read('routine-1')).state.runs[0]?.status).toBe('needs-attention');
    await expect(restarted.claim('routine-1', run!.id, 'new-process', 60_001)).rejects.toThrow(/claimed/);
    expect(await restarted.tick('routine-1', 0)).toBeNull();
    expect(await restarted.tick('routine-1', 60_000)).toMatchObject({ status: 'skipped', reason: 'Previous run is unresolved.' });
  });

  it('recovers expired claims as uncertain without allowing lease theft', async () => {
    const { first, second } = await fixture();
    const run = await first.tick('routine-1', 0);
    await first.claim('routine-1', run!.id, 'old-process', 0);
    await second.recover('routine-1', 60_000, false);
    expect((await second.read('routine-1')).state.runs[0]).toMatchObject({ status: 'needs-attention', owner: null, expiresAt: null, attempt: 1 });
    await expect(second.claim('routine-1', run!.id, 'new-process', 60_001)).rejects.toThrow();
  });

  it('does not mark a live lease uncertain when another process recovers the shared store', async () => {
    const { first, second } = await fixture();
    const run = await first.tick('routine-1', 0);
    await first.claim('routine-1', run!.id, 'first-process', 0);
    await second.recover('routine-1', 10, true, 'second-process');
    expect((await second.read('routine-1')).state.runs[0]).toMatchObject({ status: 'running', owner: 'first-process', expiresAt: 60_000 });
    await first.heartbeat('routine-1', run!.id, 'first-process', 50_000);
    await second.recover('routine-1', 60_000, true, 'second-process');
    expect((await second.read('routine-1')).state.runs[0]).toMatchObject({ status: 'running', owner: 'first-process', expiresAt: 110_000 });
    await second.recover('routine-1', 110_000, false, 'first-process');
    expect((await second.read('routine-1')).state.runs[0]?.status).toBe('needs-attention');
  });

  it('rejects a heartbeat after the lease has expired or changed owner', async () => {
    const { first } = await fixture();
    const run = await first.tick('routine-1', 0);
    await first.claim('routine-1', run!.id, 'self', 0);
    await expect(first.heartbeat('routine-1', run!.id, 'other', 10)).rejects.toThrow(/no longer owned/);
    await expect(first.heartbeat('routine-1', run!.id, 'self', 59_000)).resolves.toBeUndefined();
    await expect(first.heartbeat('routine-1', run!.id, 'self', 120_001)).rejects.toThrow(/no longer owned/);
  });

  it('keeps a live approval pending across observation and marks it uncertain only after lease expiry', async () => {
    const { first, second } = await fixture();
    const run = await first.tick('routine-1', 0, (id, scheduledFor, status) => ({
      schemaVersion: 1, id, agentId: 'a392d8b9-76cc-4158-a381-1151ccf818fb', agentRevision: 1,
      taskTemplateId: 'b392d8b9-76cc-4158-a381-1151ccf818fb', taskTemplateRevision: 1, routineId: 'c392d8b9-76cc-4158-a381-1151ccf818fb', routineRevision: 1,
      projectPath: '/project', scheduledFor, startedAt: null, finishedAt: null, status, sessionId: null, resultSummary: '', error: null,
      inputs: {}, permission: 'edit', approvals: [{ id: 'approval', digest: 'a'.repeat(64), revision: 1, action: '{}', expiresAt: 300_000, status: 'pending' }],
    }));
    await first.claim('routine-1', run!.id, 'first-process', 0);
    await first.update('routine-1', run!.id, (current) => ({ ...current, status: 'needs-attention' }));
    await first.heartbeat('routine-1', run!.id, 'first-process', 50_000);
    await second.recover('routine-1', 60_000, true, 'second-process');
    expect((await second.read('routine-1')).state.runs[0]).toMatchObject({ status: 'needs-attention', owner: 'first-process', expiresAt: 110_000, payload: { approvals: [{ status: 'pending' }] } });
    await second.recover('routine-1', 110_000, false, 'second-process');
    expect((await second.read('routine-1')).state.runs[0]).toMatchObject({ status: 'needs-attention', owner: null, expiresAt: null, payload: { approvals: [{ status: 'uncertain' }] } });
  });

  it('skips wake catch-up once and retains the monotonically advanced watermark after restart', async () => {
    const { root, first } = await fixture();
    expect(await first.tick('routine-1', 600_000)).toMatchObject({ status: 'skipped', scheduledFor: 600_000, skippedOccurrences: 11 });
    const restarted = new RoutineLedger(new DefinitionJournal(root));
    expect(await restarted.tick('routine-1', 0)).toBeNull();
    expect(await restarted.tick('routine-1', 600_000)).toBeNull();
    expect((await restarted.read('routine-1')).state.runs).toHaveLength(1);
  });

  it('rejects stale/unversioned schedule changes and distinguishes revisions after clock rollback', async () => {
    const { first } = await fixture();
    const initial = await first.tick('routine-1', 31_000);
    await expect(first.configure('routine-1', { anchor: 0, intervalMs: 120_000, timeZone: 'UTC' }, 1)).rejects.toThrow(/without a new revision/);
    await first.configure('routine-1', { anchor: 0, intervalMs: 60_000, timeZone: 'UTC' }, 2, 'new-definition');
    await expect(first.configure('routine-1', { anchor: 0, intervalMs: 60_000, timeZone: 'UTC' }, 1)).rejects.toThrow(/Stale/);
    await expect(first.configure('routine-1', { anchor: 0, intervalMs: 60_000, timeZone: 'UTC' }, 2, 'external-change')).rejects.toThrow(/without a new revision/);
    const revised = await first.tick('routine-1', 31_000);
    expect(initial?.scheduledFor).toBe(revised?.scheduledFor);
    expect(initial?.id).not.toBe(revised?.id);
    expect((await first.read('routine-1')).state.runs).toHaveLength(2);
  });

  it('caps terminal history independently per Routine and prunes only verified app-owned old state revisions', async () => {
    const { root, first } = await fixture();
    await first.create('routine-2', { anchor: 0, intervalMs: 60_000, timeZone: 'UTC' });
    await first.tick('routine-2', 31_000);
    for (let index = 0; index < 105; index += 1) await first.tick('routine-1', index * 60_000 + 31_000);
    expect((await first.read('routine-1')).state.runs).toHaveLength(100);
    expect((await first.read('routine-2')).state.runs).toHaveLength(1);
    expect((await fs.readdir(path.join(root, 'routine-1'))).filter((file) => file.endsWith('.md'))).toHaveLength(2);
  }, 15_000);

  it('does not reset corrupt due-state to an empty queue', async () => {
    const { root, first } = await fixture();
    const { snapshot } = await first.read('routine-1');
    const journal = new DefinitionJournal(root);
    await journal.save('routine-1', snapshot, { metadata: { proofVersion: 99 }, body: 'Original unsupported record.' });
    await expect(first.tick('routine-1', 0)).rejects.toThrow();
    expect((await journal.read('routine-1'))?.body).toBe('Original unsupported record.');
  });
});
