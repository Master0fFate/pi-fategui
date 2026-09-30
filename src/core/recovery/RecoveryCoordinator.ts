import path from 'node:path';
import { isAdapterCreatedContext, type RequestContext } from '../dispatch/RequestContext';
import { checkoutFactsSchema, readGoalReviewCheckout, type CheckoutFacts } from './GoalReviewFacts';
import type { GoalMaxPersistence } from '../../main/pi/goalmaxxing/GoalMaxRepository';
import type { SessionQueuePersistence } from '../../main/pi/SessionQueueRepository';
import type { ColdTeamRead } from '../../main/pi/PiSessionRepository';
import type { TaskList } from '../../shared/contracts/tasks';
import type { CommandStatus } from '../../shared/protocol/commandOutcomes';
import type { AgentTeam } from '../../shared/contracts/multiAgent';
import type { ScopedDomainEvent } from '../events/ScopedDomainEvents';
import type { AdmissionAuthority, SessionAdmission } from '../workspaces/WorkspaceAdmissionQueue';
import { inspectAgentTeamChildStorage } from '../../main/pi/multi-agent/AgentTeamHistory';
import { LifecycleRepository, type LifecycleRecord, type LifecycleRead } from './LifecycleRepository';

export interface RecoveryReviewControl {
  readonly command: SessionAdmission;
  readonly authorize: () => AdmissionAuthority;
}
export interface RecoverySources {
  readonly readSession: (projectPath: string, sessionId: string) => Promise<boolean>;
  readonly readTeams: (projectPath: string, sessionId: string) => Promise<ColdTeamRead>;
  readonly goals: Pick<GoalMaxPersistence, 'load'>;
  readonly queue: Pick<SessionQueuePersistence, 'load'>;
  readonly readTasks: (projectPath: string, sessionId: string) => Promise<{ state: 'ok'; list: TaskList } | { state: 'absent' | 'invalid' }>;
  readonly commandStatus: (requestId: string, workspaceId: string, principalId: string) => Promise<CommandStatus>;
  readonly validateWorktree: (worktree: NonNullable<LifecycleRecord['reference']['worktree']>, owner: string) => Promise<void>;
  readonly teamStorageRoots: readonly string[];
  readonly readCheckoutFacts?: (projectPath: string) => Promise<CheckoutFacts>;
  /** Host-only resolver: current membership, selected session, trust, idle writer. */
  readonly resolveReview?: (identity: RequestContext, workspaceId: string, generation: number, sessionId: string,
    control?: RecoveryReviewControl) => { projectPath: string; principalId: string };
}
export interface RecoveredLifecycle {
  readonly record: LifecycleRecord;
  readonly status: 'completed' | 'interrupted' | 'unknown' | 'review' | 'failed';
  readonly reason: string;
}
export interface RecoveryResult {
  readonly records: readonly RecoveredLifecycle[];
  readonly storageHealth: LifecycleRead['health'];
  /** A recovery projection never grants automatic execution. Storage faults also
   * block new admissions until an operator checks/repairs the original file. */
  readonly admissionsAllowed: boolean;
  readonly notice: string | null;
}

/** Read-only startup reconciliation. The index cannot authorize a completed run,
 * writer release, or replay. No source is mutated, including Team tombstones. */
export class RecoveryCoordinator {
  private readonly observed = new Map<string, string>();
  private readonly pending = new Set<Promise<void>>();
  private unhealthy: string | null = null;
  private startupAllowed = true;
  private readonly blockedSessions = new Map<string, Set<string>>();
  private readonly reviewedPrincipals = new Map<string, string>();
  private readonly reviewsInFlight = new Set<string>();
  constructor(readonly repository: LifecycleRepository, private readonly sources: RecoverySources) {}

  get admissionsAllowed(): boolean { return this.startupAllowed && this.unhealthy === null && this.pending.size === 0; }
  get storageNotice(): string | null { return this.unhealthy; }
  assertAdmission(projectPath?: string, sessionId?: string | null, principalId?: string): void {
    if (!this.admissionsAllowed) throw new Error(`STORAGE_UNAVAILABLE: ${this.unhealthy ?? 'A required lifecycle checkpoint is pending.'}`);
    if (projectPath && sessionId) {
      const key = JSON.stringify([projectPath, sessionId]);
      if (this.reviewsInFlight.has(key)) throw new Error('RECOVERY_REVIEW_REQUIRED: an operator review is in progress.');
      if ((this.blockedSessions.get(key)?.size ?? 0) > 0) throw new Error('RECOVERY_REVIEW_REQUIRED: This session has unresolved authoritative state.');
      const reviewer = this.reviewedPrincipals.get(key);
      if (reviewer && reviewer !== principalId) throw new Error('RECOVERY_REVIEW_REQUIRED: review belongs to another principal.');
    }
  }
  private checkout(projectPath: string): Promise<CheckoutFacts> {
    return (this.sources.readCheckoutFacts ?? readGoalReviewCheckout)(projectPath);
  }
  private scope(identity: RequestContext, workspaceId: string, generation: number, sessionId: string,
    control?: RecoveryReviewControl) {
    if (!isAdapterCreatedContext(identity) || identity.adapter !== 'local-ipc' || identity.expiresAt <= Date.now() || !this.sources.resolveReview)
      throw new Error('FORBIDDEN: host-local recovery review requires current authority.');
    const scope = this.sources.resolveReview(identity, workspaceId, generation, sessionId, control);
    if (scope.principalId !== identity.principalId) throw new Error('FORBIDDEN: review principal changed.');
    if (control) this.assertAdmission(); // Storage/pending writes fence ACK; preview remains readable.
    return scope;
  }
  /** Host-only preview. The caller must show these current facts and the saved
   * UNKNOWN outcome to the operator before accepting an explicit acknowledgement. */
  async inspectGoalReview(identity: RequestContext, workspaceId: string, generation: number, sessionId: string, goalId: string) {
    const scope = this.scope(identity, workspaceId, generation, sessionId);
    const goal = await this.sources.goals.load(scope.projectPath, sessionId);
    if (!goal || goal.id !== goalId || goal.status !== 'completed') throw new Error('Goal review identity changed or is not completed.');
    const checkout = await this.checkout(scope.projectPath);
    return { goal: structuredClone(goal), goalId, revision: goal.revision, projectPath: scope.projectPath, sessionId, checkout, outcome: 'UNKNOWN' as const,
      notice: 'Saved evidence and old provider effects are not verified. Acknowledgement permits only a new distinct request.' };
  }
  /** Acknowledges uncertainty, not completion. No Pi/Goal/worktree mutation and
   * no old request replay. Invalid or failed durable writes retain the block. */
  async acknowledgeGoalReview(identity: RequestContext, workspaceId: string, generation: number, sessionId: string,
    goalId: string, expectedRevision: number, seenCheckout: CheckoutFacts, control: RecoveryReviewControl): Promise<void> {
    if (!control) throw new Error('FORBIDDEN: a current host control lease is required.');
    const scope = this.scope(identity, workspaceId, generation, sessionId, control);
    const key = JSON.stringify([scope.projectPath, sessionId]);
    const blocked = this.blockedSessions.get(key);
    const previousPrincipal = this.reviewedPrincipals.get(key);
    const firstReview = blocked?.size === 1 && blocked.has(`goal:${goalId}`);
    // A new local adapter principal after restart cannot inherit an old ACK.
    // It may explicitly re-review exactly the same saved UNKNOWN goal and
    // clean checkout, with current control; no other uncertain state may exist.
    const transfer = previousPrincipal !== undefined && previousPrincipal !== scope.principalId && !blocked?.size;
    if (!firstReview && !transfer)
      throw new Error('RECOVERY_REVIEW_REQUIRED: another uncertain execution or command must be reviewed separately.');
    if (this.reviewsInFlight.has(key)) throw new Error('RECOVERY_REVIEW_REQUIRED: a review is already in progress.');
    this.reviewsInFlight.add(key);
    let preparing = false;
    let prepared = false;
    try {
      if (!await this.sources.readSession(scope.projectPath, sessionId)
        || (await this.sources.queue.load(scope.projectPath, sessionId)).length > 0
        || (await this.sources.readTasks(scope.projectPath, sessionId)).state === 'invalid')
        throw new Error('Session, task, or draft authority is unavailable for review.');
      const goal = await this.sources.goals.load(scope.projectPath, sessionId);
      if (!goal || goal.id !== goalId || goal.revision !== expectedRevision || goal.status !== 'completed') throw new Error('Goal revision changed before acknowledgement.');
      const index = await this.repository.read();
      if (index.health !== 'ok' || !index.records.some((item) => item.reference.projectPath === scope.projectPath
        && item.reference.sessionId === sessionId && item.reference.goalId === goalId && item.status === 'completed'))
        throw new Error('Saved uncertain goal completion is unavailable.');
      const observed = checkoutFactsSchema.parse(seenCheckout);
      const current = await this.checkout(scope.projectPath);
      if (JSON.stringify(current) !== JSON.stringify(observed)) throw new Error('Checkout changed since the operator reviewed it.');
      if (transfer) {
        const prior = await this.repository.readGoalReview(scope.projectPath, sessionId, goalId, expectedRevision, current);
        if (!prior || prior.stage !== 'committed' || prior.principalId !== previousPrincipal)
          throw new Error('RECOVERY_REVIEW_REQUIRED: previous durable review changed.');
      }
      this.scope(identity, workspaceId, generation, sessionId, control); // Recheck before staging.
      preparing = true;
      await this.repository.saveGoalReview({ projectPath: scope.projectPath, sessionId, goalId, goalRevision: expectedRevision,
        principalId: scope.principalId, checkout: current, stage: 'prepared' });
      prepared = true;
      preparing = false;
      const [again, liveGoal, staged] = await Promise.all([
        this.checkout(scope.projectPath), this.sources.goals.load(scope.projectPath, sessionId),
        this.repository.readGoalReview(scope.projectPath, sessionId, goalId, expectedRevision, current),
      ]);
      if (JSON.stringify(again) !== JSON.stringify(current) || !liveGoal || liveGoal.id !== goalId || liveGoal.revision !== expectedRevision
        || staged?.stage !== 'prepared' || staged.principalId !== scope.principalId)
        throw new Error('Goal or checkout changed during acknowledgement; prepared review is not authoritative.');
      this.scope(identity, workspaceId, generation, sessionId, control);
      await this.repository.saveGoalReview({ projectPath: scope.projectPath, sessionId, goalId, goalRevision: expectedRevision,
        principalId: scope.principalId, checkout: current, stage: 'committed' });
      // Publication is the last fallible step. A prepared-only record cannot
      // authorize after this call fails or the owner restarts.
      blocked?.delete(`goal:${goalId}`);
      if (blocked && !blocked.size) this.blockedSessions.delete(key);
      this.reviewedPrincipals.set(key, scope.principalId);
    } catch (error) {
      // A prepared record revokes the old ACK on disk before final checks;
      // block both principals in memory until an explicit fresh review.
      if (preparing || prepared) {
        this.reviewedPrincipals.delete(key);
        this.blockedSessions.set(key, new Set([...(this.blockedSessions.get(key) ?? []), `goal:${goalId}`]));
      }
      throw error;
    } finally { this.reviewsInFlight.delete(key); }
  }
  /** Only semantic status edges, never text deltas. Async failures are retained in
   * memory and block new admissions even when the disk itself cannot log them. */
  observe(event: ScopedDomainEvent, hostRoot: string): void {
    const { origin } = event;
    if (!origin.sessionId || !path.isAbsolute(hostRoot)) return;
    const base = { projectPath: hostRoot, sessionId: origin.sessionId, workspaceId: origin.workspaceId };
    if (event.kind === 'pi') {
      const pi = event.event;
      if (pi.type === 'run.started') void this.record({ ...base, runId: pi.runId }, 'running');
      // A run.completed transport event does not prove the external effects or
      // saved transcript settled. Never write a completed verdict from it.
      if (pi.type === 'run.completed') void this.record({ ...base, runId: pi.runId }, pi.aborted ? 'interrupted' : 'unknown', true);
      if (pi.type === 'agent-team.updated') {
        for (const task of pi.team.tasks) void this.record({ ...base, teamId: pi.team.id, taskId: task.id },
          task.status === 'completed' ? 'completed' : task.status === 'running' || task.status === 'queued' ? 'running'
            : task.status === 'interrupted' ? 'interrupted' : 'failed');
        if (pi.team.status === 'paused') void this.record({ ...base, teamId: pi.team.id }, 'paused');
      }
    } else if (event.kind === 'goal' && event.event.type === 'goalmax.status') {
      const goal = event.event;
      void this.record({ ...base, goalId: goal.goalId }, goal.status === 'completed' ? 'completed'
        : goal.status === 'active' || goal.status === 'verifying' || goal.status === 'normalising' ? 'running' : goal.status === 'failed' ? 'failed' : 'paused');
    } else if (event.kind === 'task' && event.event.type === 'tasklist.snapshot' && event.event.list) {
      for (const task of event.event.list.tasks) void this.record({ ...base, taskId: task.id },
        task.status === 'done' ? 'completed' : task.status === 'in-progress' ? 'running' : 'paused');
    }
  }
  record(reference: LifecycleRecord['reference'], status: LifecycleRecord['status'], checkpoint = false): Promise<void> {
    const key = JSON.stringify([reference.projectPath, reference.sessionId, reference.runId, reference.teamId, reference.taskId, reference.goalId]);
    if (!checkpoint && this.observed.get(key) === status) return Promise.resolve();
    this.observed.set(key, status);
    const task = this.repository.append(reference, status, checkpoint).then(() => undefined).catch(() => {
      this.unhealthy = 'Lifecycle checkpoint could not be saved. New admissions blocked; review the storage file.';
    });
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
    return task;
  }
  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
    if (this.unhealthy) throw new Error(`STORAGE_UNAVAILABLE: ${this.unhealthy}`);
  }

  async recover(): Promise<RecoveryResult> {
    const saved = await this.repository.read();
    const records: RecoveredLifecycle[] = [];
    // Older transitions are kept for history; only the latest per execution
    // identity is presented. A checkpoint never creates a new execution.
    const latest = new Map<string, LifecycleRecord>();
    for (const record of saved.records) {
      const ref = record.reference;
      latest.set(JSON.stringify([ref.projectPath, ref.sessionId, ref.runId, ref.teamId, ref.nodeId, ref.goalId, ref.taskId, ref.requestId]), record);
    }
    this.blockedSessions.clear();
    this.reviewedPrincipals.clear();
    const memo = <T>(read: (project: string, session: string) => Promise<T>): ((project: string, session: string) => Promise<T>) => {
      const cache = new Map<string, Promise<T>>();
      return (project, session) => {
        const key = JSON.stringify([project, session]);
        let result = cache.get(key);
        if (!result) { result = read(project, session); cache.set(key, result); }
        return result;
      };
    };
    const sources: RecoverySources = {
      ...this.sources,
      readSession: memo(this.sources.readSession),
      readTeams: memo(this.sources.readTeams),
      readTasks: memo(this.sources.readTasks),
      queue: { load: memo((project, session) => this.sources.queue.load(project, session)) },
      goals: { load: memo((project, session) => this.sources.goals.load(project, session)) },
    };
    const childHealthCache = new Map<string, Promise<Awaited<ReturnType<typeof inspectAgentTeamChildStorage>>>>();
    const checkoutCache = new Map<string, Promise<CheckoutFacts>>();
    const checkoutFor = (root: string): Promise<CheckoutFacts> => {
      let value = checkoutCache.get(root);
      if (!value) { value = this.checkout(root); checkoutCache.set(root, value); }
      return value;
    };
    for (const record of latest.values()) {
      const result = await this.reconcile(record, sources, childHealthCache);
      records.push(result);
      if (result.status === 'unknown' && (record.reference.teamId || record.reference.goalId || record.reference.taskId
        || record.reference.worktree || record.reference.requestId)) {
        const ref = record.reference;
        const key = JSON.stringify([ref.projectPath, ref.sessionId]);
        const blocked = this.blockedSessions.get(key) ?? new Set<string>();
        let acknowledged = false;
        if (ref.goalId && record.status === 'completed' && result.reason === 'Goal evidence needs a fresh explicit workspace verification.'
          && !ref.requestId && !ref.teamId && !ref.taskId && !ref.worktree) {
          try {
            const goal = await sources.goals.load(ref.projectPath, ref.sessionId);
            const checkout = await checkoutFor(ref.projectPath);
            const ack = goal?.id === ref.goalId && goal.status === 'completed'
              ? await this.repository.readGoalReview(ref.projectPath, ref.sessionId, ref.goalId, goal.revision, checkout) : null;
            acknowledged = Boolean(ack?.stage === 'committed' && JSON.stringify(ack.checkout) === JSON.stringify(checkout));
            if (acknowledged && ack) this.reviewedPrincipals.set(key, ack.principalId);
          } catch { acknowledged = false; }
        }
        if (!acknowledged) blocked.add(ref.goalId ? `goal:${ref.goalId}` : 'other');
        if (blocked.size) this.blockedSessions.set(key, blocked);
      }
    }
    // Ordinary Pi run.completed is uncertain, not permission to replay it,
    // but it cannot lock every unrelated or later explicit run globally.
    this.startupAllowed = saved.health === 'ok';
    return {
      records,
      storageHealth: saved.health,
      admissionsAllowed: this.admissionsAllowed,
      notice: saved.health === 'ok' ? null : `Lifecycle storage ${saved.health}; new admissions blocked. Preserve the file for operator review.`,
    };
  }

  private async reconcile(record: LifecycleRecord, sources: RecoverySources,
    childHealthCache: Map<string, Promise<Awaited<ReturnType<typeof inspectAgentTeamChildStorage>>>>): Promise<RecoveredLifecycle> {
    const ref = record.reference;
    const unknown = (reason: string): RecoveredLifecycle => ({ record, status: 'unknown', reason });
    const review = (reason: string): RecoveredLifecycle => ({ record, status: 'review', reason });
    try {
      if (!await sources.readSession(ref.projectPath, ref.sessionId)) return unknown('Pi session is missing or unreadable.');
      // Paused workflows and drafts always need explicit review, even if their
      // other records appear settled. A queued message is never replayed here.
      if (record.status === 'paused' || record.status === 'draft') return review('Saved workflow or draft needs explicit review.');
      const queue = await sources.queue.load(ref.projectPath, ref.sessionId);
      if (queue.length) return review('Saved outbox has pending messages; review delivery before new work.');
      const task = await sources.readTasks(ref.projectPath, ref.sessionId);
      if (task.state === 'invalid') return unknown('Task storage is invalid or unavailable.');
      const goal = await sources.goals.load(ref.projectPath, ref.sessionId);
      if (ref.goalId && (!goal || goal.id !== ref.goalId)) return unknown('Goal authority is missing or changed.');
      if (ref.taskId && !ref.teamId && (task.state !== 'ok' || !task.list.tasks.some((item) => item.id === ref.taskId))) return unknown('Task authority is missing.');
      let team: AgentTeam | null = null;
      if (ref.teamId || ref.worktree) {
        const teams = await sources.readTeams(ref.projectPath, ref.sessionId);
        if (teams.state !== 'ok') return unknown(`Selected Pi Team branch is ${teams.reason}.`);
        team = ref.teamId ? teams.teams.get(ref.teamId) ?? null : null;
        if (!team) return unknown('Team is missing, deleted, or on a different selected branch.');
        const childKey = JSON.stringify([ref.projectPath, ref.sessionId, team.id]);
        let childHealth = childHealthCache.get(childKey);
        if (!childHealth) {
          childHealth = inspectAgentTeamChildStorage(team, sources.teamStorageRoots);
          childHealthCache.set(childKey, childHealth);
        }
        const childState = await childHealth;
        if (childState !== 'ok') return unknown(`Team child transcript storage is ${childState}.`);
        if (team.status === 'paused') return review('Authoritative Team workflow is paused; resume only after explicit review.');
      }
      if (ref.worktree) {
        const node = team?.nodes.find((candidate) => candidate.id === ref.nodeId);
        const actual = node?.workspace;
        const expected = ref.worktree;
        if (!actual || actual.mode !== 'worktree' || actual.state !== 'ready'
          || !same(actual.path, expected.path) || !same(actual.parentPath, expected.parentPath)
          || !same(actual.commonDirectory ?? '', expected.commonDirectory)
          || actual.branch !== expected.branch || actual.baseCommit !== expected.baseCommit || !ref.teamId || !ref.nodeId) return unknown('Retained worktree identity changed.');
        await sources.validateWorktree(expected, `${ref.sessionId}/${ref.teamId}/${ref.nodeId}`);
      }
      let command: CommandStatus | null = null;
      if (ref.requestId) {
        if (!ref.workspaceId || !ref.principalId) return unknown('Command identity is incomplete.');
        command = await sources.commandStatus(ref.requestId, ref.workspaceId, ref.principalId);
        if (command.state !== 'settled' || !command.receipt || (ref.runId && (command.receipt.kind !== 'prompt' || command.receipt.runId !== ref.runId)))
          return unknown('Command outcome is not authoritatively settled; do not replay.');
      }
      if (record.status === 'running' || record.status === 'interrupted') return { record, status: 'interrupted', reason: 'Process work stopped; explicit review required before another run.' };
      const teamTask = ref.teamId && ref.taskId ? team?.tasks.find((item) => item.id === ref.taskId) : null;
      if (ref.teamId && ref.taskId && !teamTask) return unknown('Team task is missing from authoritative selected branch.');
      if (teamTask && teamTask.status !== 'completed') return teamTask.status === 'interrupted'
        ? { record, status: 'interrupted', reason: 'Team task was interrupted.' } : unknown('Team task is not authoritatively completed.');
      if (ref.goalId && goal?.status !== 'completed') return unknown('Goal is not authoritatively completed with current evidence.');
      // Saved GoalMax current flags are not a live checkout fingerprint. No
      // read-only validator is available at this boundary; never certify it.
      if (ref.goalId && record.status === 'completed') return unknown('Goal evidence needs a fresh explicit workspace verification.');
      if (ref.taskId && !ref.teamId && task.state === 'ok' && task.list.tasks.find((item) => item.id === ref.taskId)?.status !== 'done')
        return unknown('Task is not authoritatively done.');
      if (record.status === 'completed' && (teamTask?.status === 'completed' || ref.goalId && goal?.status === 'completed'
        || ref.taskId && task.state === 'ok' && task.list.tasks.some((item) => item.id === ref.taskId && item.status === 'done')))
        return { record, status: 'completed', reason: 'Completion confirmed against current authoritative state; no execution resumed.' };
      if (record.status === 'failed') return { record, status: 'failed', reason: 'Saved failure; no execution resumed.' };
      return unknown('No authoritative final execution evidence.');
    } catch { return unknown('An authoritative source or worktree check failed; no replay is safe.'); }
  }
}
function same(left: string, right: string): boolean {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
