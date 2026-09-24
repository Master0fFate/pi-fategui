import { describe, expect, it } from 'vitest';
import { claimRun, consumeApproval, effectivePermission, effectiveWorkspace, evaluateDue, recoverRun, retainPerRoutine, type Approval, type ApprovalBinding, type IntervalSchedule, type LeasedRun, type Permission } from './RoutinePolicy';

const instant = (date: string) => Date.parse(date);
const schedule = (anchor: number, timeZone = 'UTC'): IntervalSchedule => ({ anchor, intervalMs: 60 * 60_000, timeZone });
const binding: ApprovalBinding = { runId: 'run-1', actionDigest: 'digest-of-exact-action', definitionRevision: 1, taskRevision: 2, permissionRevision: 3, projectPath: '/trusted' };
const approval: Approval = { ...binding, approvedAt: 1000, expiresAt: 301_000, consumed: false };

describe('D0-04 deterministic default precedence', () => {
  for (const live of ['read-only', 'edit', 'full-access'] as Permission[]) {
    for (const agent of ['read-only', 'edit'] as const) {
      for (const task of ['read-only', 'edit'] as const) {
        for (const routine of ['read-only', 'edit'] as const) {
          it(`${live} / Agent ${agent} / task ${task} / Routine ${routine} never widens`, () => {
            expect(effectivePermission(live, agent, task, routine)).toBe([live, agent, task, routine].includes('read-only') ? 'read-only' : 'edit');
          });
        }
      }
    }
  }
  it('honors strict global workspace policy rather than treating defaults as authority', () => {
    expect(effectiveWorkspace({ preferredMode: 'worktree', strict: true })).toBe('worktree');
    expect(() => effectiveWorkspace({ preferredMode: 'worktree', strict: true }, 'shared')).toThrow(/strict/);
    expect(effectiveWorkspace({ preferredMode: 'shared', strict: false }, 'worktree')).toBe('worktree');
  });
});

describe('D0-05 interval scheduler fake-clock examples', () => {
  it('queues one due occurrence and advances the persisted watermark before execution', () => {
    expect(evaluateDue(schedule(0), 0, 0)).toEqual({ scheduledFor: 0, nextDue: 3_600_000, skippedOccurrences: 0, status: 'queued' });
    expect(evaluateDue(schedule(0), 3_600_000, 0)).toBeNull();
  });
  it.each([
    ['America/New_York', '2026-03-08T06:30:00Z', '01:30', '03:30'],
    ['America/New_York', '2026-11-01T05:30:00Z', '01:30', '01:30'],
    ['Europe/Berlin', '2026-03-29T00:30:00Z', '01:30', '03:30'],
    ['Australia/Lord_Howe', '2026-10-03T15:00:00Z', '01:30', '03:00'],
  ])('has an unambiguous UTC cadence through %s DST at %s', (zone, date, before, after) => {
    const anchor = instant(date);
    const first = evaluateDue(schedule(anchor, zone), anchor, anchor)!;
    const second = evaluateDue(schedule(anchor, zone), first.nextDue, first.nextDue)!;
    const format = (time: number) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(time);
    expect(format(first.scheduledFor)).toBe(before);
    expect(format(second.scheduledFor)).toBe(after);
    expect(second.scheduledFor - first.scheduledFor).toBe(3_600_000);
  });
  it('skips missed occurrences after sleep instead of replaying a burst', () => {
    expect(evaluateDue(schedule(0), 0, 10 * 3_600_000)).toEqual({ scheduledFor: 36_000_000, nextDue: 39_600_000, skippedOccurrences: 11, status: 'skipped' });
  });
  it('does not replay work after clock rollback or restart with a saved watermark', () => {
    const persisted = evaluateDue(schedule(0), 0, 0)!;
    expect(evaluateDue(schedule(0), persisted.nextDue, 0)).toBeNull();
    expect(evaluateDue(schedule(0), persisted.nextDue, 3_600_000)?.status).toBe('queued');
  });
  it('skips delayed ticks and forward clock jumps and rejects invalid zones/watermarks', () => {
    expect(evaluateDue(schedule(0), 0, 30_001)?.status).toBe('skipped');
    expect(evaluateDue(schedule(0), 0, 86_400_000)?.status).toBe('skipped');
    expect(() => evaluateDue(schedule(0, 'invalid'), 0, 0)).toThrow();
    expect(() => evaluateDue(schedule(0), 1, 1)).toThrow();
    expect(() => evaluateDue(schedule(0), 0, Number.NaN)).toThrow();
  });
  it('does not retry an expired claim or uncertain run after a crash', () => {
    const queued: LeasedRun = { id: 'run', status: 'queued', owner: null, expiresAt: null, attempt: 0 };
    const claimed = claimRun(queued, 'process-1', 0);
    expect(() => claimRun(claimed, 'process-2', 1)).toThrow();
    expect(recoverRun(claimed, 60_000, false).status).toBe('needs-attention');
    expect(recoverRun(claimed, 1, true).status).toBe('needs-attention');
    expect(() => claimRun(recoverRun(claimed, 60_000, false), 'process-2', 60_001)).toThrow();
  });
});

describe('D0-08 approval binding and expiry proof', () => {
  it('consumes exact approved work once', () => {
    const consumed = consumeApproval(approval, binding, 1001, true, 'edit');
    expect(consumed.consumed).toBe(true);
    expect(() => consumeApproval(consumed, binding, 1002, true, 'edit')).toThrow();
  });
  it.each(['runId', 'actionDigest', 'definitionRevision', 'taskRevision', 'permissionRevision', 'projectPath'] as const)('rejects changed %s', (key) => {
    expect(() => consumeApproval(approval, { ...binding, [key]: 'changed' }, 1001, true, 'edit')).toThrow();
  });
  it('rejects expiry, rollback, revoked trust and live permission lowering', () => {
    expect(() => consumeApproval(approval, binding, approval.expiresAt, true, 'edit')).toThrow();
    expect(() => consumeApproval(approval, binding, 999, true, 'edit')).toThrow();
    expect(() => consumeApproval(approval, binding, 1001, false, 'edit')).toThrow();
    expect(() => consumeApproval(approval, binding, 1001, true, 'read-only')).toThrow();
    expect(() => consumeApproval(approval, {} as ApprovalBinding, 1001, true, 'edit')).toThrow();
  });
  it('retains unresolved runs and caps terminal history per Routine, not Agent', () => {
    const runs = [
      { routineId: 'a', status: 'succeeded' as const, id: 'a-old' },
      { routineId: 'b', status: 'succeeded' as const, id: 'b-only' },
      { routineId: 'a', status: 'succeeded' as const, id: 'a-new' },
      { routineId: 'a', status: 'needs-attention' as const, id: 'a-pending' },
    ];
    expect(retainPerRoutine(runs, 1).map((run) => run.id)).toEqual(['b-only', 'a-new', 'a-pending']);
  });
});
