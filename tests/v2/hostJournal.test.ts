import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandJournal } from '../../src/core/commands/CommandJournal';
import { requestEnvelopeSchema, type MutationRequest } from '../../src/shared/protocol/envelopes';
import { mutationReceiptSchema } from '../../src/shared/protocol/commandOutcomes';
import { operationMethodSchema, type OperationMethod } from '../../src/shared/protocol/hostOperations';
import { createMutationIdentity, MAX_REQUEST_AGE_MS, MAX_CLOCK_SKEW_MS } from '../../src/shared/protocol/requestIds';
const epoch = '10000000-0000-4000-8000-000000000001';
const nextEpoch = '10000000-0000-4000-8000-000000000002';
const workspaceId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000003';
const newSessionId = '30000000-0000-4000-8000-000000000004';
const principalId = '40000000-0000-4000-8000-000000000004';
const resourceId = '50000000-0000-4000-8000-000000000005';
const time = 1_800_000_000_000;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const inputs: Record<OperationMethod, object> = {
  'session.create': {}, 'runtime.setModel': { provider: 'fake', id: 'model' }, 'runtime.setThinking': { level: 'medium' },
  'runtime.queue': { id: resourceId, action: 'cancel' }, 'goal.create': { objective: 'PRIVATE_BRIEF_NOT_JOURNALED' },
  'goal.control': { action: 'verify' }, 'goal.update': { expectedRevision: 1, objective: 'Updated objective' }, 'goal.clear': {},
  'goal.editSteering': { steeringId: 'steer', text: 'Revise' }, 'goal.removeSteering': { steeringId: 'steer' },
  'task.create': { title: 'PRIVATE_TASK_NOT_JOURNALED' }, 'task.update': { id: 'task', status: 'done' },
  'task.reorder': { orderedIds: ['task'] }, 'task.delete': { id: 'task' }, 'task.clear': {},
  'agent.control': { action: 'cancel', target: 'child' }, 'team.control': { action: 'createTeam' },
  'agent.workspace': { teamId: 'team', target: 'child', operation: 'review' },
};
function request(method: OperationMethod, issuedAt = time): MutationRequest {
  return requestEnvelopeSchema.parse({ protocol: 1, ...createMutationIdentity(epoch, issuedAt), method,
    workspaceId, workspaceGeneration: 3, expectedSessionId: sessionId, selectionRevision: 8, controlGeneration: 2, input: inputs[method] }) as MutationRequest;
}
const receipt = (command: MutationRequest, operation: OperationMethod) => mutationReceiptSchema.parse({ kind: 'operation', operation,
  requestId: command.requestId, durability: 'journaled', outcome: 'applied',
  sessionId: operation === 'session.create' ? newSessionId : sessionId, viewRevision: 9 });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'fate-host-journal-')); roots.push(root);
  return { root, owner: new CommandJournal({ root, serverEpoch: epoch, now: () => time }),
    reopened: () => new CommandJournal({ root, serverEpoch: nextEpoch, now: () => time }) };
}
describe('T39 backwards-compatible journaled host operations', () => {
  it('covers every newly named operation with its real kind/method, one original ID and a compact restart-readable receipt', async () => {
    const f = await fixture();
    for (const operation of operationMethodSchema.options) {
      const command = request(operation);
      const effect = vi.fn(async () => receipt(command, operation));
      const expected = await f.owner.execute(command, principalId, effect);
      expect(expected).toMatchObject({ kind: 'operation', operation, requestId: command.requestId, durability: 'journaled' });
      expect(await f.owner.execute(command, principalId, effect)).toEqual(expected);
      expect(effect).toHaveBeenCalledOnce();
      expect(await f.reopened().status(command.requestId, workspaceId, principalId)).toMatchObject({ state: 'settled', receipt: expected });
      const stored = JSON.parse(await readFile(path.join(f.root, `${createHash('sha256').update(command.requestId).digest('hex')}.json`), 'utf8')) as { sessionId: string; digest: string };
      expect(stored.sessionId).toBe(sessionId); // creation retains original captured target while receipt names new selected session.
      expect(stored.digest).toMatch(/^[a-f0-9]{64}$/u);
      expect(JSON.stringify(stored)).not.toContain('PRIVATE_BRIEF_NOT_JOURNALED');
      expect(JSON.stringify(stored)).not.toContain('PRIVATE_TASK_NOT_JOURNALED');
    }
    await expect(f.reopened().checkHealth()).resolves.toBeUndefined();
  });
  it('keeps legacy prompt records readable beside operations, without reinterpreting old kinds or admission', async () => {
    const f = await fixture();
    const command = requestEnvelopeSchema.parse({ protocol: 1, ...createMutationIdentity(epoch, time), method: 'runtime.prompt', workspaceId,
      workspaceGeneration: 3, expectedSessionId: sessionId, selectionRevision: 8, controlGeneration: 2, input: { text: 'Synthetic old prompt' } }) as MutationRequest;
    const old = mutationReceiptSchema.parse({ kind: 'prompt', requestId: command.requestId, durability: 'journaled', outcome: 'accepted', sessionId, runId: resourceId, viewRevision: 1 });
    await f.owner.execute(command, principalId, async () => old);
    const model = request('runtime.setModel'); await f.owner.execute(model, principalId, async () => receipt(model, 'runtime.setModel'));
    expect(await f.reopened().status(command.requestId, workspaceId, principalId)).toMatchObject({ state: 'settled', receipt: old });
    await expect(f.reopened().checkHealth()).resolves.toBeUndefined();
  });
  it('does not disguise a model effect as prompt or accept a different operation receipt; unknown IDs are never replayed', async () => {
    for (const wrong of ['kind', 'method'] as const) {
      const f = await fixture(); const command = request('runtime.setModel');
      const effect = vi.fn(async () => wrong === 'kind' ? mutationReceiptSchema.parse({ kind: 'prompt', requestId: command.requestId,
        durability: 'journaled', outcome: 'accepted', sessionId, runId: resourceId, viewRevision: 1 }) : receipt(command, 'runtime.setThinking'));
      await expect(f.owner.execute(command, principalId, effect)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
      expect(await f.reopened().status(command.requestId, workspaceId, principalId)).toMatchObject({ state: 'outcome_unknown', receipt: null });
      await expect(f.owner.execute(command, principalId, effect)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
      expect(effect).toHaveBeenCalledOnce();
    }
  });
  it('applies the same clock/retention gate to new operations and rejects changed payload under the original ID', async () => {
    const f = await fixture();
    const effect = vi.fn();
    await expect(f.owner.execute(request('task.clear', time - MAX_REQUEST_AGE_MS - 1), principalId, effect)).rejects.toMatchObject({ code: 'CLOCK_SKEW' });
    await expect(f.owner.execute(request('task.clear', time + MAX_CLOCK_SKEW_MS + 1), principalId, effect)).rejects.toMatchObject({ code: 'CLOCK_SKEW' });
    expect(effect).not.toHaveBeenCalled();
    const command = request('runtime.setModel');
    await f.owner.execute(command, principalId, async () => receipt(command, 'runtime.setModel'));
    const changed = requestEnvelopeSchema.parse({ ...command, input: { provider: 'fake', id: 'other' } }) as MutationRequest;
    await expect(f.owner.execute(changed, principalId, async () => receipt(changed, 'runtime.setModel'))).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
  });
});
