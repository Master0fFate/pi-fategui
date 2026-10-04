import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandJournal, commandDigest } from '../../src/core/commands/CommandJournal';
import { Dispatcher, type DispatchResolvers, type HandlerMap } from '../../src/core/dispatch/Dispatcher';
import { createAuthenticatedServerContext } from '../../src/core/dispatch/RequestContext';
import { WorkspaceControl } from '../../src/core/security/WorkspaceControl';
import { ApprovalChallenges } from '../../src/core/security/ApprovalChallenges';
import { SessionPermissionStore } from '../../src/main/pi/SessionPermissionStore';
import { AppLogService } from '../../src/main/logging/AppLogService';
import { requestEnvelopeSchema, responseEnvelopeSchema, type RequestOf } from '../../src/shared/protocol/envelopes';
import { createMutationIdentity } from '../../src/shared/protocol/requestIds';
const epoch = '10000000-0000-4000-8000-000000000001';
const nextEpoch = '10000000-0000-4000-8000-000000000002';
const workspaceId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000003';
const principalId = '40000000-0000-4000-8000-000000000004';
const clientId = '50000000-0000-4000-8000-000000000005';
const time = 1_800_000_000_000;
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
type Level = 'read-only' | 'edit' | 'full-access';
async function fixture(oldLevel: Level = 'read-only', newLevel: Level = 'edit') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-permission-journal-')); roots.push(root);
  const store = new SessionPermissionStore(new AppLogService(), path.join(root, 'data'));
  await store.checkHealth(); await store.set(root, sessionId, oldLevel);
  const set = vi.spyOn(store, 'set');
  const owner = createAuthenticatedServerContext({ principalId, clientId, expiresAt: time + 3600_000 }, null);
  let member = true;
  let active: Level = oldLevel;
  const control = new WorkspaceControl({ now: () => time, isMember: (context) => member && context.principalId === principalId });
  const generation = control.claim(owner, workspaceId).generation;
  const atomicGrant = vi.fn(async (_context: unknown, target: { newLevel: 'read-only' | 'edit' | 'full-access' }) => {
    await store.set(root, sessionId, target.newLevel); active = target.newLevel;
  });
  const approvals = new ApprovalChallenges({ now: () => time,
    mayApprove: (context, target) => member && target.workspaceId === workspaceId && target.sessionId === sessionId
      && control.hasControl(context, workspaceId, target.controlGeneration ?? -1),
    readState: () => { store.assertHealthy(); return { trusted: true, storageHealthy: true, currentLevel: active, hostMaximum: 'edit' as const }; },
    atomicGrant,
  });
  const workspace = { workspaceId, generation: 3, selectedSessionId: sessionId, selectionRevision: 7, handle: {} };
  const resolvers: DispatchResolvers = { authenticate: (context) => context.principalId === principalId,
    isMember: (_context, id) => member && id === workspaceId, workspace: (_context, id) => id === workspaceId ? workspace : null,
    hasCapability: () => true, hasControl: (context, value, lease) => control.hasControl(context, value.workspaceId, lease),
    hasPermission: () => member, session: (_context, value, id) => id === sessionId
      ? { sessionId, workspaceId: value.workspaceId, workspaceGeneration: value.generation, handle: {} } : null,
    resource: () => null,
  };
  const unused = vi.fn((): never => { throw new Error('An unrelated handler must not be entered.'); });
  const handlers: HandlerMap = { 'host.info': unused, 'workspace.list': unused, 'file.list': unused,
    'file.previewText': unused, 'runtime.prompt': unused, 'runtime.abort': unused, 'session.select': unused };
  const journalRoot = path.join(root, 'commands');
  const journal = (serverEpoch = epoch) => new CommandJournal({ root: journalRoot, serverEpoch, now: () => time });
  const makeDispatcher = (serverEpoch = epoch) => new Dispatcher({ serverEpoch, now: () => time, handlers, resolvers,
    commandJournal: journal(serverEpoch), workspaceControl: control, approvalChallenges: approvals,
    networkReadsEnabled: true, networkMutationsEnabled: true });
  const dispatcher = makeDispatcher();
  const base = { protocol: 1, serverEpoch: epoch, issuedAt: time, workspaceId, workspaceGeneration: 3,
    selectionRevision: 7, controlGeneration: generation };
  const target = { sessionId, action: 'runtime.setPermission', oldLevel, newLevel };
  const issued = await dispatcher.dispatchJson(JSON.stringify({ ...base, requestId: randomUUID(), method: 'permission.issue', input: target }), owner);
  if (!issued.ok || issued.method !== 'permission.issue') throw new Error('Expected a real one-use challenge.');
  const confirmation = requestEnvelopeSchema.parse({ ...base, ...createMutationIdentity(epoch, time), method: 'permission.confirm',
    input: { ...target, challengeId: issued.result.challengeId } }) as RequestOf<'permission.confirm'>;
  const send = (request: object, actor = owner) => dispatcher.dispatchJson(JSON.stringify(request), actor);
  const status = async (serverEpoch = epoch) => makeDispatcher(serverEpoch).dispatchJson(JSON.stringify({ protocol: 1,
    requestId: randomUUID(), serverEpoch, issuedAt: time, method: 'command.status', workspaceId, workspaceGeneration: 3,
    input: { requestId: confirmation.requestId } }), owner);
  return { root, store, set, owner, atomicGrant, confirmation, send, status, journalRoot, journal,
    revoke: () => { member = false; }, changeDisplayedLevel: () => { active = 'read-only'; } };
}
describe('PF7 original permission-confirmation durable proof; no provider or replay', () => {
  it.each([['full-access', 'edit'], ['full-access', 'read-only'], ['edit', 'read-only']] as const)(
    'durably reduces %s to %s through the production dispatcher, deduplicates and recovers its receipt', async (oldLevel, newLevel) => {
      const f = await fixture(oldLevel, newLevel);
      const applied = await f.send(f.confirmation);
      expect(applied).toMatchObject({ ok: true, method: 'permission.confirm', result: { applied: true, sessionId, level: newLevel } });
      expect(await f.store.get(f.root, sessionId)).toBe(newLevel);
      expect(await f.send(f.confirmation)).toEqual(applied);
      expect(await f.status(nextEpoch)).toMatchObject({ ok: true, result: { state: 'settled',
        receipt: { kind: 'permission', outcome: 'applied', oldLevel, newLevel } } });
      expect(f.atomicGrant).toHaveBeenCalledOnce();
      expect(f.set).toHaveBeenCalledOnce();
      expect(await f.send({ ...f.confirmation, ...createMutationIdentity(epoch, time) }))
        .toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    });
  it('does not retry an uncertain reduction or claim that its authority was lowered', async () => {
    const f = await fixture('edit', 'read-only');
    f.set.mockRejectedValueOnce(new Error('Synthetic storage failure'));
    expect(await f.send(f.confirmation)).toMatchObject({ ok: false, execution: 'unknown', error: { code: 'OUTCOME_UNKNOWN' } });
    expect(await f.status(nextEpoch)).toMatchObject({ ok: true, result: { state: 'outcome_unknown', receipt: null } });
    expect(await f.store.get(f.root, sessionId)).toBe('edit');
    await f.send(f.confirmation);
    expect(f.set).toHaveBeenCalledOnce();
  });
  it('drops the applied ACK, reopens under a new epoch and resolves ONLY original ID/challenge/scope with one actual permission-store transaction', async () => {
    const f = await fixture();
    // Simulate the transport losing this ACK AFTER actual completion; do not send a replacement confirmation.
    const lost = await f.send(f.confirmation);
    expect(lost).toMatchObject({ ok: true, method: 'permission.confirm', result: { applied: true, sessionId, level: 'edit' } });
    expect(f.atomicGrant).toHaveBeenCalledOnce(); expect(f.set).toHaveBeenCalledOnce();
    expect(await f.store.get(f.root, sessionId)).toBe('edit');
    f.changeDisplayedLevel(); // A current displayed level is NOT used to establish the original application.
    const reviewed = await f.status(nextEpoch);
    expect(reviewed).toMatchObject({ ok: true, method: 'command.status', result: { state: 'settled', rejectionCode: null,
      receipt: { kind: 'permission', durability: 'journaled', outcome: 'applied', requestId: f.confirmation.requestId,
        challengeId: f.confirmation.input.challengeId, workspaceId, workspaceGeneration: 3, sessionId,
        selectionRevision: 7, controlGeneration: f.confirmation.controlGeneration, oldLevel: 'read-only', newLevel: 'edit' } } });
    expect(responseEnvelopeSchema.safeParse(reviewed).success).toBe(true);
    expect(await f.send(f.confirmation)).toEqual(lost); // Same-ID backend deduplication never reconsumes the nonce.
    expect(f.atomicGrant).toHaveBeenCalledOnce(); expect(f.set).toHaveBeenCalledOnce();
    await expect(f.journal(nextEpoch).checkHealth()).resolves.toBeUndefined();
    const record = await fs.readFile(path.join(f.journalRoot, `${createHash('sha256').update(f.confirmation.requestId).digest('hex')}.json`), 'utf8');
    expect(record).not.toContain(f.root);
    expect(JSON.parse(record) as unknown).toMatchObject({ requestId: f.confirmation.requestId, method: 'permission.confirm',
      epoch, issuedAt: time, workspaceId, workspaceGeneration: 3, sessionId,
      digest: commandDigest(f.confirmation), state: 'settled' });
  });
  it('denies fresh-ID challenge replay and altered original scope/body, with a durable rejection rather than a fabricated grant', async () => {
    const f = await fixture(); await f.send(f.confirmation);
    const fresh = { ...f.confirmation, ...createMutationIdentity(epoch, time) };
    expect(await f.send(fresh)).toMatchObject({ ok: false, execution: 'not-started', error: { code: 'PERMISSION_REQUIRED' } });
    expect(await f.journal().status(fresh.requestId, workspaceId, principalId)).toMatchObject({ state: 'rejected', receipt: null });
    for (const changed of [
      { ...f.confirmation, input: { ...f.confirmation.input, newLevel: 'full-access' } },
      { ...f.confirmation, input: { ...f.confirmation.input, sessionId: nextEpoch } },
      { ...f.confirmation, input: { ...f.confirmation.input, challengeId: nextEpoch } },
      { ...f.confirmation, selectionRevision: f.confirmation.selectionRevision + 1 },
      { ...f.confirmation, controlGeneration: f.confirmation.controlGeneration + 1 },
    ]) expect(await f.send(changed)).toMatchObject({ ok: false, error: { code: 'REQUEST_CONFLICT' } });
    expect(f.atomicGrant).toHaveBeenCalledOnce(); expect(f.set).toHaveBeenCalledOnce();
    f.revoke(); expect(await f.status(nextEpoch)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
  it('preserves unknown after an admitted store failure and never treats unchanged current level as proof or retries the original transaction', async () => {
    const f = await fixture(); f.set.mockRejectedValueOnce(new Error('PRIVATE_PROVIDER_FAILURE_SENTINEL'));
    const failed = await f.send(f.confirmation);
    expect(failed).toMatchObject({ ok: false, execution: 'unknown', error: { code: 'OUTCOME_UNKNOWN' } });
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_PROVIDER_FAILURE_SENTINEL');
    expect(await f.status(nextEpoch)).toMatchObject({ ok: true, result: { state: 'outcome_unknown', receipt: null } });
    expect(await f.send(f.confirmation)).toMatchObject({ ok: false, execution: 'unknown' });
    expect(f.atomicGrant).toHaveBeenCalledOnce(); expect(f.set).toHaveBeenCalledOnce();
    expect(await f.store.get(f.root, sessionId)).toBe('read-only');
  });
  it('does not infer original success after grant persistence but receipt-write interruption; restart is unknown and the effect stays at most once', async () => {
    const f = await fixture();
    const target = path.join(f.journalRoot, `${createHash('sha256').update(f.confirmation.requestId).digest('hex')}.json`);
    const rename = fs.rename.bind(fs); let writes = 0;
    const interrupted = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === target && ++writes === 2) throw new Error('Synthetic receipt replacement interruption');
      await rename(from, to);
    });
    try { expect(await f.send(f.confirmation)).toMatchObject({ ok: false, execution: 'unknown' }); }
    finally { interrupted.mockRestore(); }
    expect(await f.store.get(f.root, sessionId)).toBe('edit');
    expect(await f.status(nextEpoch)).toMatchObject({ ok: true, result: { state: 'outcome_unknown', receipt: null } });
    expect(await f.send(f.confirmation)).toMatchObject({ ok: false, execution: 'unknown' });
    expect(f.atomicGrant).toHaveBeenCalledOnce(); expect(f.set).toHaveBeenCalledOnce();
  });
});
