import { z } from 'zod';
import { agentRunSchema, type AgentRun } from '../../shared/contracts/agents';
import { DefinitionJournal, type DefinitionSnapshot } from './DefinitionJournal';
import { claimRun, evaluateDue, recoverRun, validateInterval, type IntervalSchedule, type LeasedRun } from './RoutinePolicy';

const entrySchema = z.object({
  id: z.string(), status: z.enum(['queued', 'running', 'needs-attention', 'succeeded', 'failed', 'skipped']),
  owner: z.string().nullable(), expiresAt: z.number().int().safe().nullable(), attempt: z.number().int().nonnegative(),
  scheduledFor: z.number().int().safe().nonnegative(), skippedOccurrences: z.number().int().nonnegative(), reason: z.string().nullable(),
  payload: agentRunSchema.nullable(),
}).strict();
const stateSchema = z.object({
  schemaVersion: z.literal(1), definitionRevision: z.number().int().nonnegative(), definitionDigest: z.string().nullable().default(null),
  schedule: z.object({ anchor: z.number().int().safe().nonnegative(), intervalMs: z.number().int().safe().positive(), timeZone: z.string() }).strict(),
  nextDue: z.number().int().safe().nonnegative(), runs: z.array(entrySchema).max(125),
}).strict();
export type RoutineLedgerState = z.infer<typeof stateSchema>;
const unresolved = new Set(['queued', 'running', 'needs-attention']);
function retained(runs: RoutineLedgerState['runs']): RoutineLedgerState['runs'] {
  if (runs.filter((run) => unresolved.has(run.status)).length > 25) throw new Error('Resolve pending runs before admitting more work.');
  let terminal = 0;
  return [...runs].reverse().filter((run) => unresolved.has(run.status) || ++terminal <= 100).reverse();
}

/** One durable head transaction binds due-state advancement, run snapshot and claim. */
export class RoutineLedger {
  constructor(private readonly journal: DefinitionJournal) {}

  async create(routineId: string, schedule: IntervalSchedule, definitionRevision = 1, definitionDigest: string | null = null): Promise<void> {
    validateInterval(schedule);
    await this.journal.save(routineId, null, { metadata: { schemaVersion: 1, definitionRevision, definitionDigest, schedule, nextDue: schedule.anchor, runs: [] }, body: '' });
  }

  async read(routineId: string): Promise<{ snapshot: DefinitionSnapshot; state: RoutineLedgerState }> {
    const snapshot = await this.journal.read(routineId);
    if (!snapshot) throw new Error('Routine does not exist.');
    const state = stateSchema.parse(snapshot.metadata);
    validateInterval(state.schedule);
    if (new Set(state.runs.map((run) => run.id)).size !== state.runs.length) throw new Error('Duplicate run identity.');
    for (const run of state.runs) if (run.payload && (run.payload.id !== run.id || run.payload.status !== run.status)) throw new Error('Run snapshot identity conflict.');
    return { snapshot, state };
  }

  private async save(id: string, snapshot: DefinitionSnapshot, state: RoutineLedgerState): Promise<void> {
    if (new Set(state.runs.map((run) => run.id)).size !== state.runs.length) throw new Error('Duplicate run identity.');
    await this.journal.save(id, snapshot, { metadata: stateSchema.parse({ ...state, runs: retained(state.runs) }), body: '' });
  }

  async configure(routineId: string, schedule: IntervalSchedule, definitionRevision: number, definitionDigest: string | null = null): Promise<void> {
    validateInterval(schedule);
    const saved = await this.journal.read(routineId);
    if (!saved) return this.create(routineId, schedule, definitionRevision, definitionDigest);
    const { snapshot, state } = await this.read(routineId);
    if (definitionRevision < state.definitionRevision) throw new Error('Stale Routine configuration. Reload before scheduling.');
    if (state.definitionRevision === definitionRevision && (state.schedule.intervalMs !== schedule.intervalMs || state.schedule.timeZone !== schedule.timeZone || state.definitionDigest !== null && state.definitionDigest !== definitionDigest)) throw new Error('Routine changed without a new revision. Save the reviewed definition before scheduling.');
    if (state.definitionRevision !== definitionRevision) await this.save(routineId, snapshot, { ...state, schedule, nextDue: schedule.anchor, definitionRevision, definitionDigest });
    else if (state.definitionDigest === null && definitionDigest !== null) await this.save(routineId, snapshot, { ...state, definitionDigest });
  }

  async tick(routineId: string, now: number, makePayload?: (id: string, scheduledFor: number, status: 'queued' | 'skipped') => AgentRun): Promise<RoutineLedgerState['runs'][number] | null> {
    const { snapshot, state } = await this.read(routineId);
    const due = evaluateDue(state.schedule, state.nextDue, now);
    if (!due) return null;
    const overlap = state.runs.some((run) => unresolved.has(run.status));
    const status = overlap ? 'skipped' : due.status;
    const id = `${routineId}:${state.definitionRevision}:${due.scheduledFor}`;
    const run = {
      id, status, owner: null, expiresAt: null, attempt: 0,
      scheduledFor: due.scheduledFor, skippedOccurrences: due.skippedOccurrences,
      reason: overlap ? 'Previous run is unresolved.' : due.status === 'skipped' ? 'Missed while asleep, delayed, or after clock change.' : null,
      payload: makePayload?.(id, due.scheduledFor, status) ?? null,
    };
    await this.save(routineId, snapshot, { ...state, nextDue: due.nextDue, runs: [...state.runs, run] });
    return run;
  }

  async admit(ledgerId: string, payload: AgentRun): Promise<void> {
    const { snapshot, state } = await this.read(ledgerId);
    if (state.runs.some((run) => run.id === payload.id)) throw new Error('Run is already admitted.');
    await this.save(ledgerId, snapshot, { ...state, runs: [...state.runs, { id: payload.id, status: payload.status, owner: null, expiresAt: null, attempt: 0, scheduledFor: payload.scheduledFor, skippedOccurrences: 0, reason: null, payload }] });
  }

  async claim(routineId: string, runId: string, owner: string, now: number): Promise<LeasedRun> {
    const { snapshot, state } = await this.read(routineId);
    const run = state.runs.find((candidate) => candidate.id === runId);
    if (!run) throw new Error('Unknown run.');
    const claimed = { ...run, ...claimRun(run, owner, now), payload: run.payload ? { ...run.payload, status: 'running' as const, startedAt: now } : null };
    await this.save(routineId, snapshot, { ...state, runs: state.runs.map((candidate) => candidate.id === runId ? claimed : candidate) });
    return claimed;
  }

  async update(routineId: string, runId: string, change: (run: AgentRun) => AgentRun): Promise<AgentRun> {
    const { snapshot, state } = await this.read(routineId);
    const entry = state.runs.find((candidate) => candidate.id === runId);
    if (!entry?.payload) throw new Error('Run snapshot is unavailable.');
    const next = agentRunSchema.parse(change(structuredClone(entry.payload)));
    if (next.id !== runId || next.agentId !== entry.payload.agentId || next.routineId !== entry.payload.routineId) throw new Error('Run ownership cannot change.');
    await this.save(routineId, snapshot, { ...state, runs: state.runs.map((candidate) => candidate.id === runId ? { ...candidate, status: next.status, payload: next } : candidate) });
    return next;
  }

  async heartbeat(routineId: string, runId: string, owner: string, now: number): Promise<void> {
    if (!owner || !Number.isSafeInteger(now) || now < 0) throw new Error('Invalid routine lease heartbeat.');
    const { snapshot, state } = await this.read(routineId);
    const entry = state.runs.find((candidate) => candidate.id === runId);
    if (!entry || !['running', 'needs-attention'].includes(entry.status) || entry.owner !== owner || entry.expiresAt === null || now >= entry.expiresAt) throw new Error('Routine lease is no longer owned by this process.');
    await this.save(routineId, snapshot, { ...state, runs: state.runs.map((candidate) => candidate.id === runId ? { ...candidate, expiresAt: now + 60_000 } : candidate) });
  }

  async recover(routineId: string, now: number, restarted: boolean, knownLiveOwner: string | null = null): Promise<void> {
    const { snapshot, state } = await this.read(routineId);
    let changed = false;
    const runs = state.runs.map((run) => {
      // A second live application must not infer interruption from process
      // restart alone. Only an expired (or malformed unleased) running record
      // is converted to needs-attention; the owning process keeps its lease
      // alive with heartbeat() while the effect is in flight.
      const live = run.owner !== null && run.owner === knownLiveOwner;
      const expired = ['running', 'needs-attention'].includes(run.status) && (run.expiresAt === null || now >= run.expiresAt);
      const recovered = run.status === 'running' && expired
        ? recoverRun(run, now, restarted)
        : run.status === 'needs-attention' && expired ? { ...run, owner: null, expiresAt: null } : run;
      const uncertain = expired && ['running', 'needs-attention'].includes(run.status);
      const expiredQueue = restarted && !live && run.status === 'queued';
      const status = expiredQueue ? 'skipped' as const : recovered.status;
      const next = { ...run, ...recovered, status, payload: run.payload ? { ...run.payload, status,
        error: uncertain ? 'Execution was interrupted or its lease expired. It will not be replayed automatically.' : expiredQueue ? 'Queued work was not replayed after restart.' : run.payload.error,
        approvals: uncertain || expiredQueue ? run.payload.approvals.map((approval) => approval.status === 'pending' ? { ...approval, status: 'uncertain' as const } : approval) : run.payload.approvals,
      } : null };
      if (JSON.stringify(next) !== JSON.stringify(run)) changed = true;
      return next;
    });
    if (changed) await this.save(routineId, snapshot, { ...state, runs });
  }
}
