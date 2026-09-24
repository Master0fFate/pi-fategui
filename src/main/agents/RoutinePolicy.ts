export type Permission = 'read-only' | 'edit' | 'full-access';
export type Workspace = 'shared' | 'worktree';
const rank: Record<Permission, number> = { 'read-only': 0, edit: 1, 'full-access': 2 };

export function effectivePermission(live: Permission, ...ceilings: Array<'read-only' | 'edit'>): 'read-only' | 'edit' {
  return Math.min(rank[live], 1, ...ceilings.map((level) => rank[level])) === 0 ? 'read-only' : 'edit';
}

export function effectiveWorkspace(policy: { preferredMode: Workspace; strict: boolean }, requested?: Workspace): Workspace {
  if (policy.strict && requested && requested !== policy.preferredMode) throw new Error('Workspace request conflicts with global strict policy.');
  return requested ?? policy.preferredMode;
}

export interface IntervalSchedule {
  anchor: number;
  intervalMs: number;
  timeZone: string;
}
export interface DueDecision {
  scheduledFor: number;
  nextDue: number;
  skippedOccurrences: number;
  status: 'queued' | 'skipped';
}

export function validateInterval(schedule: IntervalSchedule): void {
  if (!Number.isSafeInteger(schedule.anchor) || schedule.anchor < 0
    || !Number.isSafeInteger(schedule.intervalMs) || schedule.intervalMs < 60_000 || schedule.intervalMs > 7 * 86_400_000) throw new Error('Invalid interval schedule.');
  // Zone controls display, not cadence. No ambiguous wall-clock local-time parsing.
  new Intl.DateTimeFormat('en', { timeZone: schedule.timeZone }).format(0);
}

export function evaluateDue(schedule: IntervalSchedule, nextDue: number, now: number): DueDecision | null {
  validateInterval(schedule);
  if (![nextDue, now].every((value) => Number.isSafeInteger(value) && value >= 0)
    || nextDue < schedule.anchor || (nextDue - schedule.anchor) % schedule.intervalMs !== 0) throw new Error('Invalid schedule watermark.');
  if (now < nextDue) return null;
  const skippedOccurrences = Math.floor((now - nextDue) / schedule.intervalMs);
  const scheduledFor = nextDue + skippedOccurrences * schedule.intervalMs;
  const following = scheduledFor + schedule.intervalMs;
  if (!Number.isSafeInteger(following)) throw new Error('Schedule overflow.');
  // Waking after a missed occurrence never silently starts catch-up work.
  const status = skippedOccurrences > 0 || now - scheduledFor > 30_000 ? 'skipped' : 'queued';
  return { scheduledFor, nextDue: following, skippedOccurrences: skippedOccurrences + (status === 'skipped' ? 1 : 0), status };
}

export interface ApprovalBinding {
  runId: string;
  actionDigest: string;
  definitionRevision: number;
  taskRevision: number;
  permissionRevision: number;
  projectPath: string;
}
export interface Approval extends ApprovalBinding {
  approvedAt: number;
  expiresAt: number;
  consumed: boolean;
}

export function consumeApproval(approval: Approval, action: ApprovalBinding, now: number, trusted: boolean, live: Permission): Approval {
  const keys: Array<keyof ApprovalBinding> = ['runId', 'actionDigest', 'definitionRevision', 'taskRevision', 'permissionRevision', 'projectPath'];
  if (!trusted || live === 'read-only' || approval.consumed || ![now, approval.approvedAt, approval.expiresAt].every(Number.isSafeInteger)
    || now < approval.approvedAt || now >= approval.expiresAt || approval.expiresAt - approval.approvedAt > 5 * 60_000
    || keys.some((key) => action[key] === undefined || action[key] !== approval[key])) throw new Error('Approval is stale, expired, consumed, or unauthorized.');
  return { ...approval, consumed: true };
}

export type PrototypeRunStatus = 'queued' | 'running' | 'needs-attention' | 'succeeded' | 'failed' | 'skipped';
export interface LeasedRun {
  id: string;
  status: PrototypeRunStatus;
  owner: string | null;
  expiresAt: number | null;
  attempt: number;
}

export function claimRun(run: LeasedRun, owner: string, now: number): LeasedRun {
  if (run.status !== 'queued' || run.owner || run.attempt !== 0 || !owner || !Number.isSafeInteger(now) || now < 0) throw new Error('Run cannot be claimed.');
  return { ...run, status: 'running', owner, expiresAt: now + 60_000, attempt: 1 };
}

export function recoverRun(run: LeasedRun, now: number, restarted: boolean): LeasedRun {
  // An expired lease is uncertain work, never evidence that repeating an effect is safe.
  if (run.status === 'running' && (restarted || run.expiresAt === null || now >= run.expiresAt)) return { ...run, status: 'needs-attention', owner: null, expiresAt: null };
  return run;
}

export function retainPerRoutine<T extends { routineId: string; status: PrototypeRunStatus }>(runs: readonly T[], limit: number): T[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid history limit.');
  const counts = new Map<string, number>();
  return [...runs].reverse().filter((run) => {
    if (['queued', 'running', 'needs-attention'].includes(run.status)) return true;
    const count = counts.get(run.routineId) ?? 0;
    counts.set(run.routineId, count + 1);
    return count < limit;
  }).reverse();
}
