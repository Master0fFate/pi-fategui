import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalGate, type ApprovalContext } from './ApprovalGate';
import { DefinitionJournal, type DefinitionSnapshot } from './DefinitionJournal';

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agents-approval-')));
  roots.push(root);
  const journal = new DefinitionJournal(path.join(root, 'approvals'));
  const context: ApprovalContext = { permission: 'edit', trusted: true, binding: { runId: 'run-1', projectPath: root, definitionRevision: 1, taskRevision: 1, permissionRevision: 1 } };
  let now = 1000;
  let notify!: (snapshot: DefinitionSnapshot) => void;
  const attention = new Promise<DefinitionSnapshot>((resolve) => { notify = resolve; });
  const gate = new ApprovalGate(journal, () => context, (_id, snapshot) => notify(snapshot), () => now);
  const effect = vi.fn(async () => 'executed');
  const controller = new AbortController();
  const result = gate.execute('action', 'write', { path: 'file', content: 'bytes' }, effect, controller.signal).then((value) => ({ value }), (error: unknown) => ({ error }));
  const pending = await attention;
  return { root, gate, journal, context, pending, effect, result, controller, setNow: (value: number) => { now = value; } };
}

describe('D0-08 durable suspended-effect adversarial proof', () => {
  it('invokes the immutable displayed snapshot even when original arguments mutate while paused', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agents-approval-snapshot-')));
    roots.push(root);
    const journal = new DefinitionJournal(root);
    const input = { path: 'approved.txt', content: 'approved', nested: { flag: true } };
    let notify!: (snapshot: DefinitionSnapshot) => void;
    const ready = new Promise<DefinitionSnapshot>((resolve) => { notify = resolve; });
    const gate = new ApprovalGate(journal, () => ({ trusted: true, permission: 'edit', binding: { runId: 'run', projectPath: root, definitionRevision: 1, taskRevision: 1, permissionRevision: 1 } }), (_id, snapshot) => notify(snapshot));
    const effect = vi.fn(async (approved: Readonly<typeof input>) => {
      expect(Object.isFrozen(approved)).toBe(true);
      expect(Object.isFrozen(approved.nested)).toBe(true);
      await fs.writeFile(path.join(root, approved.path), approved.content);
    });
    const run = gate.execute('snapshot', 'write', input, effect);
    const pending = await ready;
    input.path = 'not-approved.txt';
    input.content = 'changed';
    input.nested.flag = false;
    expect(JSON.parse(pending.body).input).toEqual({ path: 'approved.txt', content: 'approved', nested: { flag: true } });
    await gate.approve('snapshot', pending);
    await run;
    expect(await fs.readFile(path.join(root, 'approved.txt'), 'utf8')).toBe('approved');
    await expect(fs.stat(path.join(root, 'not-approved.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('admits at most one approval under concurrent clicks', async () => {
    const { gate, pending, effect, result, journal } = await fixture();
    const decisions = await Promise.allSettled([gate.approve('action', pending), gate.approve('action', pending)]);
    expect(decisions.filter((decision) => decision.status === 'fulfilled')).toHaveLength(1);
    expect(await result).toEqual({ value: 'executed' });
    expect(effect).toHaveBeenCalledOnce();
    expect((await journal.read('action'))?.metadata.status).toBe('consumed');
  });

  it.each(['permission', 'trusted', 'definitionRevision', 'taskRevision', 'permissionRevision', 'projectPath'] as const)('does not execute after %s changes', async (field) => {
    const { gate, pending, context, result, effect } = await fixture();
    if (field === 'permission') context.permission = 'read-only';
    else if (field === 'trusted') context.trusted = false;
    else if (field === 'projectPath') context.binding.projectPath += '-other';
    else context.binding[field] += 1;
    await expect(gate.approve('action', pending)).rejects.toThrow(/Approval/);
    await gate.deny('action');
    expect(await result).toHaveProperty('error');
    expect(effect).not.toHaveBeenCalled();
  });

  it('audits denial without executing', async () => {
    const { gate, journal, effect, result } = await fixture();
    await gate.deny('action');
    expect(await result).toHaveProperty('error');
    expect((await journal.read('action'))?.metadata.status).toBe('denied');
    expect(effect).not.toHaveBeenCalled();
  });

  it('rejects expiry and clock rollback, retaining the original action for inspection', async () => {
    const { gate, journal, pending, setNow, result, effect } = await fixture();
    setNow(999);
    await expect(gate.approve('action', pending)).rejects.toThrow(/Approval/);
    setNow(301_000);
    await expect(gate.approve('action', pending)).rejects.toThrow(/Approval/);
    await gate.deny('action', 'expired');
    expect(await result).toHaveProperty('error');
    expect((await journal.read('action'))?.metadata.status).toBe('expired');
    expect(effect).not.toHaveBeenCalled();
  });

  it('does not replay a persisted pending approval after process restart', async () => {
    const { gate, journal, pending, context, controller, result, effect } = await fixture();
    controller.abort();
    expect(await result).toHaveProperty('error');
    const restarted = new ApprovalGate(journal, () => context, () => undefined);
    await expect(restarted.approve('action', pending)).rejects.toThrow(/Restarted/);
    await expect(gate.approve('action', pending)).rejects.toThrow(/Restarted/);
    expect((await journal.read('action'))?.metadata.status).toBe('needs-attention');
    expect(effect).not.toHaveBeenCalled();
  });

  it('does not resume when authority changes during durable approval persistence', async () => {
    const { gate, journal, pending, context, effect, result } = await fixture();
    const save = journal.save.bind(journal);
    vi.spyOn(journal, 'save').mockImplementation(async (...args) => {
      const saved = await save(...args);
      context.permission = 'read-only';
      return saved;
    });
    await expect(gate.approve('action', pending)).rejects.toThrow(/Approval/);
    expect(await result).toHaveProperty('error');
    expect(effect).not.toHaveBeenCalled();
    expect((await journal.read('action'))?.metadata.status).toBe('consumed');
  });
});
