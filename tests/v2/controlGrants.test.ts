import { describe, expect, it, vi } from 'vitest';
import { createAuthenticatedServerContext, createLocalIpcContext } from '../../src/core/dispatch/RequestContext';
import { WorkspaceControl, CONTROL_LEASE_MS, CONTROL_RENEW_INTERVAL_MS } from '../../src/core/security/WorkspaceControl';
import { ApprovalChallenges, APPROVAL_CHALLENGE_MS, type ApprovalState, type ApprovalTarget } from '../../src/core/security/ApprovalChallenges';
import { WorkspaceAdmissionQueue } from '../../src/core/workspaces/WorkspaceAdmissionQueue';

const workspaceId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000003';
const principalId = '40000000-0000-4000-8000-000000000004';
const clientA = '50000000-0000-4000-8000-000000000005';
const clientB = '60000000-0000-4000-8000-000000000006';
const otherPrincipal = '70000000-0000-4000-8000-000000000007';
const time = 1_800_000_000_000;
const context = (clientId = clientA, principal = principalId) => createAuthenticatedServerContext({ principalId: principal, clientId, expiresAt: time + 600_000 }, null);
const local = () => createLocalIpcContext({ principalId, clientId: clientA, expiresAt: time + 600_000 });
function barrier() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  return { pending, release };
}

describe('workspace control (isolated primitive)', () => {
  it('allows one explicit controller, rejects observers, and fences releases and reclaims', () => {
    let now = time;
    const a = context(); const b = context(clientB);
    const control = new WorkspaceControl({ now: () => now, isMember: () => true });
    expect(control.hasControl(b, workspaceId, 1)).toBe(false);
    const first = control.claim(a, workspaceId);
    expect(first.current).toMatchObject({ principalId, clientId: clientA, generation: 1, expiresAt: now + CONTROL_LEASE_MS });
    expect(control.hasControl(a, workspaceId, 1)).toBe(true);
    expect(control.hasControl(b, workspaceId, 1)).toBe(false);
    expect(() => control.claim(b, workspaceId)).toThrow('CONTROL_REQUIRED');
    expect(() => control.claim(a, workspaceId)).toThrow('CONTROL_REQUIRED');
    expect(() => control.release(b, workspaceId, 1)).toThrow('CONTROL_REQUIRED');
    expect(() => control.release(a, workspaceId, 2)).toThrow('CONTROL_REQUIRED');
    expect(control.release(a, workspaceId, 1)).toMatchObject({ generation: 2, current: null });
    expect(control.claim(b, workspaceId).current?.generation).toBe(3);
    expect(control.hasControl(a, workspaceId, 1)).toBe(false);
    now += 1;
    expect(() => control.claim(local(), workspaceId)).toThrow('UNAUTHENTICATED');
    expect(() => control.claim({ ...a }, workspaceId)).toThrow('UNAUTHENTICATED');
  });

  it('expires exactly at 15s, fences stale renewals, and uses server identity on disconnect', () => {
    let now = time;
    const a = context(); const b = context(clientB);
    const control = new WorkspaceControl({ now: () => now, isMember: () => true });
    control.claim(a, workspaceId);
    now += CONTROL_RENEW_INTERVAL_MS;
    expect(control.renew(a, workspaceId, 1).expiresAt).toBe(now + CONTROL_LEASE_MS);
    expect(() => control.renew(b, workspaceId, 1)).toThrow('CONTROL_REQUIRED');
    now += CONTROL_LEASE_MS;
    expect(control.hasControl(a, workspaceId, 1)).toBe(false);
    expect(() => control.renew(a, workspaceId, 1)).toThrow('CONTROL_REQUIRED');
    expect(control.claim(b, workspaceId).current?.generation).toBe(3);
    expect(control.disconnect(a)).toEqual([]);
    expect(control.disconnect(b)).toMatchObject([{ generation: 4, current: null }]);
    expect(control.hasControl(b, workspaceId, 3)).toBe(false);
  });

  it('requires host-authorized takeover and fences a queued command without stopping active work', async () => {
    const a = context(); const b = context(clientB);
    let allowTakeover = false;
    const control = new WorkspaceControl({ now: () => time, isMember: () => true, mayTakeOver: () => allowTakeover });
    const first = control.claim(a, workspaceId).current!;
    expect(() => control.takeover(b, workspaceId)).toThrow('FORBIDDEN');
    const gate = barrier();
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const runtime = { getState: () => ({ sessionId }) };
    const queue = new WorkspaceAdmissionQueue(runtime, 1);
    const admission = { workspaceGeneration: 1, expectedSessionId: sessionId, selectionRevision: 0, controlGeneration: first.generation };
    const authority = () => ({ currentGeneration: 1, controlGeneration: control.hasControl(a, workspaceId, first.generation) ? first.generation : null, permission: true });
    const active = queue.run(admission, authority, async () => { markEntered(); await gate.pending; return 'running work settled'; });
    await entered;
    const stale = queue.run(admission, authority, () => 'must not execute');
    allowTakeover = true;
    const transfer = control.takeover(b, workspaceId);
    expect(transfer).toMatchObject({ previous: { clientId: clientA, generation: 1 }, current: { clientId: clientB, generation: 2 } });
    expect(control.hasControl(a, workspaceId, 1)).toBe(false);
    expect(control.hasControl(b, workspaceId, 2)).toBe(true);
    gate.release();
    expect(await active).toBe('running work settled');
    await expect(stale).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
  });

  it('does not grant control to a non-member even with an adapter-issued context', () => {
    const control = new WorkspaceControl({ isMember: () => false, now: () => time });
    expect(() => control.claim(context(), workspaceId)).toThrow('FORBIDDEN');
    expect(control.hasControl(context(), workspaceId, 1)).toBe(false);
  });
});

const target: ApprovalTarget = { workspaceId, sessionId, action: 'runtime.setPermission', oldLevel: 'edit', newLevel: 'full-access' };
function approvals() {
  let now = time;
  let active: ApprovalState['currentLevel'] = 'edit';
  let hostMaximum: ApprovalState['hostMaximum'] = 'full-access';
  let storageHealthy = true;
  let trusted = true;
  let controller = true;
  const events: string[] = [];
  const save = vi.fn(async () => { events.push('durable-save'); });
  const activate = vi.fn(() => { events.push('activate'); active = 'full-access'; });
  const service = new ApprovalChallenges({ now: () => now, mayApprove: () => controller,
    readState: () => ({ trusted, storageHealthy, currentLevel: active, hostMaximum }), save, activate });
  return { service, events, save, activate, setNow: (value: number) => { now = value; },
    setCap: (value: ApprovalState['hostMaximum']) => { hostMaximum = value; },
    setHealthy: (value: boolean) => { storageHealthy = value; }, setTrusted: (value: boolean) => { trusted = value; },
    setController: (value: boolean) => { controller = value; }, level: () => active };
}

describe('single-use approval challenges (isolated primitive)', () => {
  it('binds principal, client, workspace, session, action and both levels; saves before activation', async () => {
    const f = approvals(); const a = context();
    const challenge = f.service.issue(a, target);
    const variants: ApprovalTarget[] = [
      { ...target, workspaceId: sessionId }, { ...target, sessionId: workspaceId },
      { ...target, action: 'runtime.prompt' }, { ...target, oldLevel: 'read-only' }, { ...target, newLevel: 'edit' },
    ];
    for (const variant of variants) await expect(f.service.consume(a, challenge.id, variant)).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
    await expect(f.service.consume(context(clientB), challenge.id, target)).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
    await expect(f.service.consume(context(clientA, otherPrincipal), challenge.id, target)).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
    await f.service.consume(a, challenge.id, target);
    expect(f.events).toEqual(['durable-save', 'activate']);
    expect(f.level()).toBe('full-access');
    await expect(f.service.consume(a, challenge.id, target)).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
    expect(f.save).toHaveBeenCalledTimes(1);
  });

  it('does not let a remote request exceed the host maximum, including an edit cap set after issue', async () => {
    const f = approvals(); const a = context();
    f.setCap('edit');
    expect(() => f.service.issue(a, target)).toThrow('PERMISSION_REQUIRED');
    f.setCap('full-access');
    const challenge = f.service.issue(a, target);
    f.setCap('edit');
    await expect(f.service.consume(a, challenge.id, target)).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
    expect(f.save).not.toHaveBeenCalled();
    expect(f.level()).toBe('edit');
  });

  it('does not activate on failed save, unhealthy store, untrusted project or expired challenge', async () => {
    const f = approvals(); const a = context();
    f.setHealthy(false);
    expect(() => f.service.issue(a, target)).toThrow('PERMISSION_REQUIRED');
    f.setHealthy(true); f.setTrusted(false);
    expect(() => f.service.issue(a, target)).toThrow('PERMISSION_REQUIRED');
    f.setTrusted(true);
    const failed = f.service.issue(a, target);
    f.save.mockRejectedValueOnce(new Error('disk failed'));
    await expect(f.service.consume(a, failed.id, target)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(f.level()).toBe('edit');
    await expect(f.service.consume(a, failed.id, target)).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
    const expired = f.service.issue(a, target);
    f.setNow(time + APPROVAL_CHALLENGE_MS);
    await expect(f.service.consume(a, expired.id, target)).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
    expect(f.activate).not.toHaveBeenCalled();
  });

  it('consumes before async persistence, and disconnect during save prevents grant', async () => {
    const f = approvals(); const a = context(); const gate = barrier();
    f.save.mockImplementationOnce(async () => { await gate.pending; f.events.push('durable-save'); });
    const challenge = f.service.issue(a, target);
    const pending = f.service.consume(a, challenge.id, target);
    await expect(f.service.consume(a, challenge.id, target)).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
    expect(() => f.service.issue(a, target)).toThrow('BUSY');
    f.service.revokeClient(a);
    gate.release();
    await expect(pending).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
    expect(f.events).toEqual(['durable-save']);
    expect(f.level()).toBe('edit');
  });

  it('does not activate if host cap is reduced during the durable write', async () => {
    const f = approvals(); const a = context(); const gate = barrier();
    f.save.mockImplementationOnce(async () => { await gate.pending; });
    const challenge = f.service.issue(a, target);
    const pending = f.service.consume(a, challenge.id, target);
    f.setCap('edit');
    gate.release();
    await expect(pending).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
    expect(f.activate).not.toHaveBeenCalled();
  });

  it('does not activate when controller authority is lost while saving', async () => {
    const f = approvals(); const a = context(); const gate = barrier();
    f.save.mockImplementationOnce(async () => { await gate.pending; });
    const challenge = f.service.issue(a, target);
    const pending = f.service.consume(a, challenge.id, target);
    f.setController(false);
    gate.release();
    await expect(pending).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
    expect(f.activate).not.toHaveBeenCalled();
  });

  it('cannot activate if the approval expires during the durable write', async () => {
    const f = approvals(); const a = context(); const gate = barrier();
    f.save.mockImplementationOnce(async () => { await gate.pending; });
    const challenge = f.service.issue(a, target);
    const pending = f.service.consume(a, challenge.id, target);
    f.setNow(time + APPROVAL_CHALLENGE_MS);
    gate.release();
    await expect(pending).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
    expect(f.activate).not.toHaveBeenCalled();
  });
});
