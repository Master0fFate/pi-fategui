import { createHash, randomUUID } from 'node:crypto';
import type { AgentSessionEvent, ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  GOALMAX_MAX_ASSIGNMENTS,
  GOALMAX_MAX_CRITERIA,
  GOALMAX_MAX_EVIDENCE,
  GOALMAX_MAX_STEERING,
  GOALMAX_STEERING_TEXT_LIMIT,
  goalMaxControlInputSchema,
  goalMaxCreateInputSchema,
  goalMaxStateSchema,
  goalMaxUpdateInputSchema,
  type GoalMaxChildAssignment,
  type GoalMaxClearResult,
  type GoalMaxControlInput,
  type GoalMaxCreateInput,
  type GoalMaxEvent,
  type GoalMaxEvidence,
  type GoalMaxPhase,
  type GoalMaxState,
  type GoalMaxSteering,
  type GoalMaxUpdateInput,
} from '../../../shared/contracts/goalmaxxing';
import type { ModelInfo, PermissionLevel, ThinkingLevel } from '../../../shared/contracts/ipc';
import { createGoalMaxTools, type GoalMaxCompletionInput, type GoalMaxReportInput } from './GoalMaxTools';
import { GoalMaxProgressEngine, classifyGoalMaxTool, type ToolObservation, type WorkspaceSnapshot } from './GoalMaxProgressEngine';
import { goalMaxCapsule, goalMaxDiagnosticPrompt, goalMaxVerificationPrompt } from './GoalMaxPrompt';
import { InMemoryGoalMaxRepository, type GoalMaxPersistence } from './GoalMaxRepository';
import { GoalMaxScheduler } from './GoalMaxScheduler';
import type { TaskService } from '../tasks/TaskService';
import { decideGoalMaxRecovery, goalMaxRecoveryPhase, goalMaxResearchProgress, goalMaxScopeOverlap } from './GoalMaxStallDetector';
import {
  appendGoalMaxTimeline,
  canTransitionGoalMax,
  createGoalMaxCriterion,
  GOALMAX_TASK_PLAN_TIMELINE_PREFIX,
  GOALMAX_VERIFICATION_TITLE,
  hasGoalMaxTaskPlan,
  isGoalMaxTerminal,
  normalizeGoalMaxBrief,
  reconcileGoalMaxReferences,
  transitionGoalMax,
} from './GoalMaxStateMachine';

export interface GoalMaxRuntimeChildObservation {
  key: string;
  kind: GoalMaxEvidence['kind'];
  title: string;
  summary: string;
  timestamp: number;
  meaningful: boolean;
  path?: string;
  command?: string;
  exitCode?: number;
}

export interface GoalMaxRuntimeChild {
  nodeId: string;
  teamId?: string;
  label: string;
  objective: string;
  status: GoalMaxChildAssignment['status'];
  permissionLevel: PermissionLevel;
  requestedModel: Pick<ModelInfo, 'provider' | 'id' | 'name'> | null;
  effectiveModel: Pick<ModelInfo, 'provider' | 'id' | 'name'> | null;
  requestedThinking: ThinkingLevel | null;
  effectiveThinking: ThinkingLevel | null;
  startedAt: number | null;
  endedAt: number | null;
  result: string | null;
  error: string | null;
  observations: GoalMaxRuntimeChildObservation[];
}

export interface GoalMaxRuntimeSnapshot {
  projectPath: string;
  sessionId: string;
  projectTrusted: boolean;
  permissionLevel: PermissionLevel;
  idle: boolean;
  streaming: boolean;
  queuedUserMessages: number;
  tokensUsed: number;
  activeChildren: number;
  children: GoalMaxRuntimeChild[];
}

export interface GoalMaxVerificationResult {
  verdict: 'pass' | 'fail';
  report: string;
  nodeId?: string;
  infrastructureFailure?: 'timeout' | 'unavailable';
}

export interface GoalMaxDiagnosticResult {
  report: string;
  nodeId?: string;
  infrastructureFailure?: 'timeout' | 'unavailable';
}

export interface GoalMaxCoordinatorHost {
  runtime(sessionId: string): GoalMaxRuntimeSnapshot | null;
  startGoal(sessionId: string, objective: string, capsule: string): Promise<boolean>;
  continueGoal(sessionId: string, capsule: string, goalId: string, revision: number): Promise<void>;
  steerGoal(sessionId: string, capsule: string, goalId: string, revision: number): Promise<void>;
  abortGoal(sessionId: string): Promise<void>;
  verifyGoal(sessionId: string, prompt: string): Promise<GoalMaxVerificationResult>;
  diagnoseGoal(sessionId: string, prompt: string): Promise<GoalMaxDiagnosticResult>;
  persistSessionEvent(sessionId: string, state: GoalMaxState): void;
  emit(event: GoalMaxEvent): void;
}

type BufferedEvidence = { evidence: GoalMaxEvidence; observation: ToolObservation };
type ObservationBuffer = { items: BufferedEvidence[]; timer: ReturnType<typeof setTimeout> };
type TurnMarker = { toolCount: number; meaningful: boolean; novelInvestigation: boolean; latestAssistantText: string; startedAt: number; statusCalls: number; reportCalls: number; completeCalls: number };
interface GoalMaxCommitGuard {
  validate(): string | null;
  recover(previous: GoalMaxState, attempted: GoalMaxState, reason: string, now: number): GoalMaxState;
}
class GoalMaxOperationSuperseded extends Error {}
class GoalMaxCompletionRejected extends Error {}

const activeGoalStatuses = new Set<GoalMaxState['status']>(['normalising', 'active', 'verifying']);
const MAX_BUFFERED_OBSERVATIONS = 64;
const MAX_TRACKED_TOOL_STARTS = 128;

export class GoalMaxCoordinator {
  private readonly states = new Map<string, GoalMaxState>();
  private readonly sessionKeys = new Map<string, string>();
  private readonly mutationQueues = new Map<string, Promise<void>>();
  private readonly toolStarts = new Map<string, Map<string, { name: string; input: string }>>();
  private readonly observationBuffers = new Map<string, ObservationBuffer>();
  private readonly turnMarkers = new Map<string, TurnMarker>();
  private readonly verificationRuns = new Map<string, Promise<void>>();
  private readonly diagnosticRuns = new Map<string, Promise<void>>();
  private readonly failClosedStates = new Map<string, GoalMaxState>();
  private readonly completionFences = new Set<string>();
  private readonly completionFenceConflicts = new Map<string, string>();
  private readonly scheduler = new GoalMaxScheduler();

  constructor(
    private readonly host: GoalMaxCoordinatorHost,
    private readonly repository: GoalMaxPersistence = new InMemoryGoalMaxRepository(),
    private readonly progressEngine = new GoalMaxProgressEngine(),
    private readonly taskService: TaskService | null = null,
  ) {}

  createTools(): ToolDefinition[] {
    return createGoalMaxTools(this);
  }

  isCompletionGateActive(sessionId: string): boolean {
    return this.completionFences.has(sessionId);
  }

  async bind(projectPath: string, sessionId: string): Promise<GoalMaxState | null> {
    const key = goalKey(projectPath, sessionId);
    // Rebinding is an explicit runtime recovery boundary. Retry the durable
    // state from disk instead of carrying a process-local fail-closed overlay.
    this.failClosedStates.delete(sessionId);
    const restored = await this.repository.load(projectPath, sessionId);
    if (!restored) {
      this.states.delete(key);
      this.sessionKeys.delete(sessionId);
      return null;
    }
    this.sessionKeys.set(sessionId, key);
    const sanitizedOnRestore = normalizeGoalReferences(restored);
    const restoredDiagnosticsChanged = JSON.stringify(sanitizedOnRestore) !== JSON.stringify(restored);
    let goal = sanitizedOnRestore;
    const runtime = this.host.runtime(sessionId);
    const now = Date.now();
    const interrupted = goal.executionState !== 'idle' || goal.continuation.pending || goal.status === 'verifying';
    if (interrupted && !isGoalMaxTerminal(goal.status)) {
      const expected = goal.revision;
      goal = {
        ...goal,
        revision: expected + 1,
        status: goal.status === 'paused' || goal.status === 'blocked' ? goal.status : 'active',
        executionState: 'idle',
        continuation: { ...goal.continuation, pending: false, reason: 'Recovered after runtime rebind.' },
        permission: runtime ? permissionSnapshot(runtime, goal.permission, now) : goal.permission,
        elapsedMs: elapsed(goal, now),
        updatedAt: now,
      };
      goal = appendGoalMaxTimeline(goal, 'goal.recovered', 'Recovered the unfinished goal with an idle continuation lease.', now);
      await this.repository.save(goalMaxStateSchema.parse(normalizeGoalReferences(goal)), expected);
      this.host.persistSessionEvent(sessionId, goal);
    } else if (restoredDiagnosticsChanged) {
      const expected = goal.revision;
      goal = appendGoalMaxTimeline({ ...goal, revision: expected + 1, updatedAt: now }, 'goal.recovered', 'Sensitive diagnostic values were redacted during restore.', now);
      goal = goalMaxStateSchema.parse(normalizeGoalReferences(goal));
      await this.repository.save(goal, expected);
      this.host.persistSessionEvent(sessionId, goal);
    }
    if (!isGoalMaxTerminal(goal.status)) {
      const workspace = await this.progressEngine.capture(projectPath);
      if (workspace.fingerprint !== goal.progress.latestWorkspaceFingerprint) {
        const expected = goal.revision;
        const timestamp = Date.now();
        const evidence = appendEvidence(invalidateVerificationEvidence(goal.evidence), workspaceEvidence(goal, workspace, timestamp));
        goal = appendGoalMaxTimeline({
          ...goal,
          revision: expected + 1,
          evidence,
          progress: {
            ...goal.progress,
            changedFileCount: workspace.changedFileCount,
            latestWorkspaceFingerprint: workspace.fingerprint,
            latestEvidenceAt: timestamp,
          },
          elapsedMs: elapsed(goal, timestamp),
          updatedAt: timestamp,
        }, 'goal.recovered', 'Workspace evidence reconciled after runtime rebind.', timestamp);
        goal = goalMaxStateSchema.parse(normalizeGoalReferences(goal));
        await this.repository.save(goal, expected);
        this.host.persistSessionEvent(sessionId, goal);
      }
    }
    this.states.set(key, goal);
    this.host.emit(snapshotEvent(goal));
    // Re-bind the canonical task list after restart, including achieved goals.
    // This repairs a completion projection that could not be written before the
    // prior process exited. Cancelled goals are detached only by explicit clear.
    if (goal.status !== 'cancelled') await this.taskService?.syncGoal(goal.projectPath, goal.sessionId, goal).catch(() => undefined);
    if (goal.status === 'active') this.schedule(goal, 'runtime-bind');
    return structuredClone(goal);
  }

  unbind(sessionId: string): void {
    const goal = this.stateForSession(sessionId);
    if (!goal) return;
    this.scheduler.cancel(goal.id);
    this.toolStarts.delete(sessionId);
    this.turnMarkers.delete(sessionId);
    const buffer = this.observationBuffers.get(goal.id);
    if (buffer) clearTimeout(buffer.timer);
    void this.flushObservations(sessionId).catch(() => undefined);
  }

  get(projectPath: string, sessionId: string): GoalMaxState | null {
    const goal = this.states.get(goalKey(projectPath, sessionId));
    if (!goal) return null;
    const failClosed = this.failClosedStates.get(sessionId);
    return structuredClone(failClosed?.id === goal.id && failClosed.projectPath === goal.projectPath ? failClosed : goal);
  }

  async create(inputValue: GoalMaxCreateInput): Promise<GoalMaxState> {
    const input = goalMaxCreateInputSchema.parse(inputValue);
    const runtime = this.requireSelectedRuntime();
    const key = goalKey(runtime.projectPath, runtime.sessionId);
    const existing = this.states.get(key) ?? await this.repository.load(runtime.projectPath, runtime.sessionId);
    if (existing) throw new Error(isGoalMaxTerminal(existing.status) ? 'Clear the finished goal before starting a new one.' : 'This session already has an active goal.');
    const normalized = normalizeGoalMaxBrief(input.objective);
    const workspace = await this.progressEngine.capture(runtime.projectPath);
    const now = Date.now();
    const id = `goal-${randomUUID()}`;
    let originalBriefRef: string | null = null;
    let originalBriefHash: string | null = null;
    if (normalized.preserveBrief) {
      const saved = await this.repository.saveBrief(runtime.projectPath, runtime.sessionId, id, input.objective);
      originalBriefRef = saved.ref;
      originalBriefHash = saved.hash;
    }
    const criteria = normalized.criteria.map((criterion) => createGoalMaxCriterion(criterion, now));
    let goal: GoalMaxState = {
      schemaVersion: 2,
      id,
      sessionId: runtime.sessionId,
      projectPath: runtime.projectPath,
      revision: 1,
      objective: normalized.objective,
      originalBriefRef,
      originalBriefHash,
      status: 'active',
      phase: 'intake',
      executionState: 'idle',
      verificationLevel: input.verificationLevel,
      agentStrategy: input.agentStrategy,
      criteria,
      taskPlanCaptured: false,
      budget: {
        tokenLimit: input.tokenLimit,
        timeLimitMs: input.timeLimitMs,
        source: input.tokenLimit !== null || input.timeLimitMs !== null ? 'user-explicit' : null,
      },
      permission: { permissionLevel: runtime.permissionLevel, projectTrusted: runtime.projectTrusted, revision: 1, resolvedAt: now },
      progress: {
        meaningfulTurnCount: 0,
        noProgressTurnCount: 0,
        repeatedFailureCount: 0,
        planningOnlyTurnCount: 0,
        changedFileCount: workspace.changedFileCount,
        baselineWorkspaceFingerprint: workspace.fingerprint,
        latestWorkspaceFingerprint: workspace.fingerprint,
        latestEvidenceAt: null,
        latestMeaningfulProgressAt: null,
        lastFailureFingerprint: null,
      },
      evidence: [],
      continuation: { pending: false, attempt: 0, lastScheduledAt: null, lastSettledAt: null, reason: null },
      steering: [],
      childAssignments: [],
      tokensUsed: 0,
      tokenBaseline: runtime.tokensUsed,
      elapsedMs: 0,
      timeline: [],
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: null,
      blockedReason: null,
      failure: null,
    };
    goal = appendGoalMaxTimeline(goal, 'goal.created', 'Goal created and persisted before execution.', now);
    goal = goalMaxStateSchema.parse(goal);
    await this.repository.save(goal, null);
    this.states.set(key, goal);
    this.sessionKeys.set(runtime.sessionId, key);
    this.host.persistSessionEvent(runtime.sessionId, goal);
    this.host.emit(snapshotEvent(goal));
    // Bind the canonical task list to this goal's required criteria on creation.
    this.taskService?.syncGoal(runtime.projectPath, runtime.sessionId, goal).catch(() => undefined);
    try {
      const accepted = await this.host.startGoal(runtime.sessionId, goal.objective, goalMaxCapsule(goal));
      if (!accepted) throw new Error('Pi rejected the goal before starting.');
    } catch (error) {
      await this.mutate(runtime.sessionId, (current, timestamp) => appendGoalMaxTimeline({
        ...current,
        status: 'failed', executionState: 'idle', failure: { code: 'GOAL_START_FAILED', message: errorMessage(error), retryable: true },
        revision: current.revision + 1, updatedAt: timestamp,
      }, 'goal.blocked', 'Goal start failed before the first turn.', timestamp));
      throw error;
    }
    return structuredClone(this.requireState(runtime.sessionId));
  }

  async control(inputValue: GoalMaxControlInput): Promise<GoalMaxState> {
    const input = goalMaxControlInputSchema.parse(inputValue);
    const runtime = this.requireSelectedRuntime();
    let goal = this.requireState(runtime.sessionId);
    if (input.action === 'cancel') {
      const failures: unknown[] = [];
      try { await this.flushObservations(runtime.sessionId); } catch (error) { failures.push(error); }
      goal = this.requireState(runtime.sessionId);
      if (goal.status !== 'completed') {
        this.scheduler.cancel(goal.id);
        if (goal.status !== 'cancelled') {
          try {
            await this.mutate(runtime.sessionId, (current, now) => appendGoalMaxTimeline({
              ...transitionGoalMax(current, 'cancelled', now),
              revision: current.revision + 1,
              tokensUsed: Math.max(0, (this.host.runtime(runtime.sessionId)?.tokensUsed ?? current.tokenBaseline + current.tokensUsed) - current.tokenBaseline),
              elapsedMs: elapsed(current, now),
              blockedReason: input.reason?.trim() || null,
              continuation: { ...current.continuation, pending: false, reason: 'Cancelled by the user.' },
              childAssignments: current.childAssignments.map((assignment) => assignment.status === 'running' || assignment.status === 'pending'
                ? { ...assignment, status: 'cancelled' as const, endedAt: now }
                : assignment),
            }, 'goal.cancelled', input.reason?.trim() || 'Goal cancelled by the user.', now));
          } catch (error) { failures.push(error); }
        }
        try { await this.host.abortGoal(runtime.sessionId); } catch (error) { failures.push(error); }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Goal cancellation was only partially completed.');
      return structuredClone(this.requireState(runtime.sessionId));
    }
    if (isGoalMaxTerminal(goal.status)) throw new Error('Clear this finished goal before changing it.');
    if (this.completionFences.has(runtime.sessionId)) {
      this.completionFenceConflicts.set(runtime.sessionId, 'A goal control action arrived during the completion gate.');
    }
    if (input.action === 'pause') {
      this.scheduler.cancel(goal.id);
      await this.mutate(runtime.sessionId, (current, now) => appendGoalMaxTimeline({
        ...transitionGoalMax(current, 'paused', now), revision: current.revision + 1,
        tokensUsed: Math.max(0, (this.host.runtime(runtime.sessionId)?.tokensUsed ?? current.tokenBaseline + current.tokensUsed) - current.tokenBaseline),
        elapsedMs: elapsed(current, now),
        blockedReason: input.reason?.trim() || null,
        continuation: { ...current.continuation, pending: false, reason: input.reason?.trim() || 'Paused by the user.' },
      }, 'goal.paused', input.reason?.trim() || 'Goal paused by the user.', now));
    } else if (input.action === 'resume') {
      await this.mutate(runtime.sessionId, (current, now) => {
        const live = this.host.runtime(runtime.sessionId);
        const active = transitionGoalMax(current, 'active', now);
        return appendGoalMaxTimeline({
          ...active, revision: current.revision + 1, blockedReason: null, failure: null,
          permission: live ? permissionSnapshot(live, current.permission, now) : current.permission,
          continuation: { ...current.continuation, pending: false, reason: 'Resumed by the user.' },
        }, 'goal.resumed', 'Goal resumed with current runtime policy.', now);
      });
      this.clearFailClosedState(runtime.sessionId);
      this.schedule(this.requireState(runtime.sessionId), 'user-resume');
    } else if (input.action === 'checkpoint') {
      await this.checkpoint(runtime.sessionId, 'User requested checkpoint.');
    } else {
      await this.requestVerification(runtime.sessionId, 'User requested verification.');
    }
    return this.get(runtime.projectPath, runtime.sessionId) ?? structuredClone(this.requireState(runtime.sessionId));
  }

  async update(inputValue: GoalMaxUpdateInput): Promise<GoalMaxState> {
    const input = goalMaxUpdateInputSchema.parse(inputValue);
    const runtime = this.requireSelectedRuntime();
    const current = this.requireState(runtime.sessionId);
    if (isGoalMaxTerminal(current.status)) throw new Error('Clear this finished goal before replacing it.');
    if (current.revision !== input.expectedRevision) throw new Error('The goal changed while it was being edited. Reopen the editor and retry.');
    const normalized = input.objective ? normalizeGoalMaxBrief(input.objective) : null;
    let briefRef = current.originalBriefRef;
    let briefHash = current.originalBriefHash;
    if (input.objective) {
      if (normalized?.preserveBrief) {
        const saved = await this.repository.saveBrief(current.projectPath, current.sessionId, current.id, input.objective);
        briefRef = saved.ref;
        briefHash = saved.hash;
      } else {
        briefRef = null;
        briefHash = null;
      }
    }
    await this.mutate(runtime.sessionId, (goal, now) => {
      if (goal.revision !== input.expectedRevision) throw new Error('The goal changed while it was being edited. Reopen the editor and retry.');
      const existingById = new Map(goal.criteria.map((criterion) => [criterion.id, criterion]));
      const criteria = input.criteria
        ? input.criteria.map((criterion) => {
            const existing = criterion.id ? existingById.get(criterion.id) : undefined;
            return createGoalMaxCriterion({
              title: criterion.title,
              description: criterion.description,
              required: criterion.required,
              ...(existing ? { id: existing.id, status: existing.status, evidenceIds: existing.evidenceIds, ownerNodeIds: existing.ownerNodeIds } : {}),
            }, now);
          })
        : goal.criteria;
      const tokenLimit = input.tokenLimit === undefined ? goal.budget.tokenLimit : input.tokenLimit;
      const timeLimitMs = input.timeLimitMs === undefined ? goal.budget.timeLimitMs : input.timeLimitMs;
      const status: GoalMaxState['status'] = goal.status === 'paused' ? 'paused' : 'active';
      const next: GoalMaxState = {
        ...goal,
        revision: goal.revision + 1,
        objective: normalized?.objective ?? goal.objective,
        originalBriefRef: input.objective ? briefRef : goal.originalBriefRef,
        originalBriefHash: input.objective ? briefHash : goal.originalBriefHash,
        criteria,
        verificationLevel: input.verificationLevel ?? goal.verificationLevel,
        agentStrategy: input.agentStrategy ?? goal.agentStrategy,
        budget: { tokenLimit, timeLimitMs, source: tokenLimit !== null || timeLimitMs !== null ? 'user-explicit' as const : null },
        status,
        executionState: goal.status === 'verifying' || goal.executionState === 'waiting' ? 'idle' : goal.executionState,
        blockedReason: null,
        completedAt: null,
        evidence: goal.evidence.map((evidence) => evidence.kind === 'verification' ? { ...evidence, current: false } : evidence),
        updatedAt: now,
      };
      return appendGoalMaxTimeline(next, 'goal.updated', 'Goal objective, criteria, or execution policy changed.', now);
    });
    this.clearFailClosedState(runtime.sessionId);
    const updated = this.requireState(runtime.sessionId);
    if (runtime.streaming) await this.host.steerGoal(runtime.sessionId, goalMaxCapsule(updated), updated.id, updated.revision).catch(() => undefined);
    else if (updated.status === 'active') this.schedule(updated, 'goal-edit');
    return structuredClone(updated);
  }

  async recordSteering(sessionId: string, textValue: string, behavior: GoalMaxSteering['behavior']): Promise<GoalMaxState | null> {
    const existing = this.stateForSession(sessionId);
    const text = textValue.trim().slice(0, GOALMAX_STEERING_TEXT_LIMIT);
    if (!existing || !text || isGoalMaxTerminal(existing.status)) return existing ? structuredClone(existing) : null;
    // A steering change during the atomic completion gate must reject that
    // completion; record a conflict the guard reads after its durable save.
    if (this.completionFences.has(sessionId)) this.completionFenceConflicts.set(sessionId, 'New user steering arrived during the completion gate.');
    const resumesExecution = existing.status === 'blocked' || existing.status === 'failed' || existing.status === 'verifying'
      || existing.status === 'budget-limited' || existing.status === 'usage-limited';
    if (resumesExecution) this.scheduler.cancel(existing.id);
    await this.mutate(sessionId, (current, now) => {
      const reactivated = current.status === 'blocked' || current.status === 'failed' || current.status === 'verifying'
        || current.status === 'budget-limited' || current.status === 'usage-limited';
      const active = reactivated ? transitionGoalMax(current, 'active', now) : current;
      const runtime = this.host.runtime(sessionId);
      const executionState: GoalMaxState['executionState'] = runtime
        ? runtime.streaming
          ? 'running-root'
          : runtime.activeChildren > 0
            ? 'running-children'
            : 'idle'
        : active.executionState;
      const steering: GoalMaxSteering = {
        id: `steering-${randomUUID()}`,
        text,
        behavior,
        timestamp: now,
        revision: current.revision + 1,
      };
      return appendGoalMaxTimeline({
        ...active,
        revision: current.revision + 1,
        phase: current.phase === 'verification' ? 'implementation' : current.phase,
        executionState,
        steering: [...current.steering, steering].slice(-GOALMAX_MAX_STEERING),
        evidence: current.evidence.map((evidence) => evidence.kind === 'verification' ? { ...evidence, current: false } : evidence),
        blockedReason: reactivated ? null : current.blockedReason,
        failure: reactivated ? null : current.failure,
        continuation: reactivated ? { ...current.continuation, pending: false, reason: 'User steering resumed the goal.' } : current.continuation,
        updatedAt: now,
      }, 'steering.recorded', 'User update accepted into the active GoalMax objective.', now);
    });
    this.clearFailClosedState(sessionId);
    const updated = this.requireState(sessionId);
    await this.redeliverSteering(sessionId, updated);
    return structuredClone(updated);
  }

  async updateSteering(sessionId: string, steeringId: string, textValue: string): Promise<GoalMaxState | null> {
    const existing = this.stateForSession(sessionId);
    const text = textValue.trim().slice(0, GOALMAX_STEERING_TEXT_LIMIT);
    if (!existing || !text || isGoalMaxTerminal(existing.status)) return existing ? structuredClone(existing) : null;
    if (!existing.steering.some((item) => item.id === steeringId)) throw new Error('That goal update is no longer listed.');
    if (this.completionFences.has(sessionId)) this.completionFenceConflicts.set(sessionId, 'A goal update edit arrived during the completion gate.');
    await this.mutate(sessionId, (current, now) => {
      if (!current.steering.some((item) => item.id === steeringId)) throw new GoalMaxOperationSuperseded();
      return appendGoalMaxTimeline({
        ...current,
        revision: current.revision + 1,
        steering: current.steering.map((item) => item.id === steeringId ? { ...item, text, timestamp: now } : item),
        updatedAt: now,
      }, 'steering.updated', 'Goal update edited by the user.', now);
    });
    this.clearFailClosedState(sessionId);
    const updated = this.requireState(sessionId);
    await this.redeliverSteering(sessionId, updated);
    return structuredClone(updated);
  }

  async removeSteering(sessionId: string, steeringId: string): Promise<GoalMaxState | null> {
    const existing = this.stateForSession(sessionId);
    if (!existing || isGoalMaxTerminal(existing.status)) return existing ? structuredClone(existing) : null;
    if (!existing.steering.some((item) => item.id === steeringId)) return structuredClone(existing);
    if (this.completionFences.has(sessionId)) this.completionFenceConflicts.set(sessionId, 'A goal update was withdrawn during the completion gate.');
    await this.mutate(sessionId, (current, now) => appendGoalMaxTimeline({
      ...current,
      revision: current.revision + 1,
      steering: current.steering.filter((item) => item.id !== steeringId),
      updatedAt: now,
    }, 'steering.removed', 'Goal update withdrawn by the user.', now));
    this.clearFailClosedState(sessionId);
    const updated = this.requireState(sessionId);
    await this.redeliverSteering(sessionId, updated);
    return structuredClone(updated);
  }

  /** Deliver edited/withdrawn steering to the running root or the next idle continuation. */
  private async redeliverSteering(sessionId: string, updated: GoalMaxState): Promise<void> {
    const runtime = this.host.runtime(sessionId);
    if (updated.status === 'active' && runtime?.streaming && updated.executionState === 'running-root') {
      await this.host.steerGoal(sessionId, goalMaxCapsule(updated), updated.id, updated.revision).catch(() => undefined);
    } else if (updated.status === 'active' && runtime?.idle && updated.executionState === 'idle') {
      this.schedule(updated, 'user-steering');
    }
  }

  async clear(): Promise<GoalMaxClearResult> {
    const runtime = this.requireSelectedRuntime();
    let goal = this.requireState(runtime.sessionId);
    if (!isGoalMaxTerminal(goal.status)) {
      await this.control({ action: 'cancel', reason: 'Cleared by the user.' });
      goal = this.requireState(runtime.sessionId);
    } else if (goal.status === 'cancelled') {
      // A previous cancellation may have persisted before process cleanup
      // failed. Retrying clear must retry the idempotent runtime abort.
      await this.host.abortGoal(runtime.sessionId);
    }
    this.scheduler.cancel(goal.id);
    await this.repository.archiveAndClear(goal);
    this.discardTransientState(goal);
    // The goal is gone; remove its mirrored tasks from the canonical list so the
    // session returns to an ordinary (goal-free) task list.
    await this.taskService?.detachGoal(goal.projectPath, goal.sessionId, goal.id).catch(() => undefined);
    this.states.delete(goalKey(goal.projectPath, goal.sessionId));
    this.sessionKeys.delete(goal.sessionId);
    this.host.emit({ type: 'goalmax.cleared', projectPath: goal.projectPath, sessionId: goal.sessionId, goalId: goal.id, timestamp: Date.now() });
    return { cleared: true, archivedGoalId: goal.id };
  }

  async deleteSession(projectPath: string, sessionId: string): Promise<void> {
    const goal = this.states.get(goalKey(projectPath, sessionId));
    if (goal) this.discardTransientState(goal);
    this.states.delete(goalKey(projectPath, sessionId));
    this.sessionKeys.delete(sessionId);
    this.failClosedStates.delete(sessionId);
    await this.repository.deleteSession(projectPath, sessionId);
  }

  hasRunnableGoal(sessionId: string): boolean {
    const goal = this.stateForSession(sessionId);
    return Boolean(goal && !this.failClosedStates.has(sessionId) && activeGoalStatuses.has(goal.status));
  }

  async statusForModel(sessionId: string): Promise<{ text: string; details: GoalMaxState }> {
    await this.flushObservations(sessionId);
    const stored = this.requireState(sessionId);
    const failClosed = this.failClosedStates.get(sessionId);
    const goal = failClosed?.id === stored.id ? failClosed : stored;
    return { text: goalMaxCapsule(goal), details: structuredClone(goal) };
  }

  async requestCompletion(sessionId: string, input: GoalMaxCompletionInput): Promise<{ text: string; details: GoalMaxState }> {
    await this.flushObservations(sessionId);
    let current = this.requireState(sessionId);
    if (current.status === 'completed') {
      return { text: 'GoalMax is already completed. End the current turn without calling more tools.', details: structuredClone(current) };
    }
    if (current.status === 'cancelled') {
      return { text: 'Completion was not accepted because this goal was cancelled. Clear it before starting another goal.', details: structuredClone(current) };
    }
    const summary = input.summary.trim();
    if (!summary) throw new Error('A completion summary is required.');
    if (current.status !== 'active' && current.status !== 'verifying') {
      return { text: `Completion was not accepted while GoalMax is ${current.status}. Resume the goal first.`, details: structuredClone(current) };
    }
    const taskPlanCaptured = hasGoalMaxTaskPlan(current);
    if (!taskPlanCaptured) {
      return { text: 'Completion was not accepted. Submit the detailed execution task plan first.', details: structuredClone(current) };
    }
    try {
      await this.checkpoint(sessionId, 'Completion evidence refreshed before the atomic completion gate.', this.turnMarkers.get(sessionId)?.startedAt);
      current = this.requireState(sessionId);
      if (input.criterionEvidence?.length) {
        current = (await this.report(sessionId, {
          outcome: 'progress',
          summary: 'Completion evidence linked to the finished work.',
          criterionUpdates: input.criterionEvidence.map((item) => ({
            criterionId: item.criterionId,
            status: 'satisfied' as const,
            evidenceIds: item.evidenceIds,
          })),
        })).details;
      }
    } catch (error) {
      const reason = redactGoalMaxDiagnostic(errorMessage(error)).trim().slice(0, 4_000) || 'The evidence checkpoint was unavailable.';
      return { text: `Completion was not accepted because current evidence could not be refreshed: ${reason}`, details: structuredClone(this.requireState(sessionId)) };
    }
    const preflight = deterministicVerification(current);
    const runtime = this.host.runtime(sessionId);
    if (runtime && runtime.activeChildren > 0) preflight.findings.push(`Wait for ${runtime.activeChildren} active child ${runtime.activeChildren === 1 ? 'task' : 'tasks'} to settle.`);
    if (preflight.findings.length > 0) {
      const actionable = current.status === 'verifying'
        ? await this.reactivateFromRejectedCompletion(sessionId, current, `Completion was not accepted. Continue the active goal and resolve:\n${preflight.findings.map((finding) => `- ${finding}`).join('\n')}`)
        : current;
      return {
        text: `Completion was not accepted. Continue the active goal and resolve:\n${preflight.findings.map((finding) => `- ${finding}`).join('\n')}`.slice(0, 8_000),
        details: structuredClone(actionable),
      };
    }
    const completionRevision = current.revision;
    this.scheduler.cancel(current.id);
    // The completion fence blocks new child admission for this session until
    // the completed state is durably published. A conflict (new child admitted
    // by a concurrent root tool call, or new steering) is recorded and the
    // guard rolls the would-be completion back to active below.
    this.completionFences.add(sessionId);
    this.completionFenceConflicts.delete(sessionId);
    const guard: GoalMaxCommitGuard = {
      validate: () => this.completionFenceConflicts.get(sessionId) ?? null,
      recover: (previous, attempted, reason, now) => appendGoalMaxTimeline({
        ...previous,
        revision: attempted.revision + 1,
        status: 'active',
        phase: previous.phase === 'verification' ? 'implementation' : previous.phase,
        executionState: 'idle',
        blockedReason: null,
        failure: null,
        evidence: previous.evidence.map((evidence) => evidence.kind === 'verification' ? { ...evidence, current: false } : evidence),
        continuation: { ...previous.continuation, pending: false, reason: `Completion was not accepted: ${reason}` },
        updatedAt: now,
      }, 'verification.failed', `Completion gate rejected: ${reason}. GoalMax stays active without a warning state.`, now),
    };
    try { await this.mutate(sessionId, (goal, now) => {
      if (goal.status !== 'active' && goal.status !== 'verifying') throw new GoalMaxOperationSuperseded();
      if (goal.revision !== completionRevision) throw new Error('The goal changed during the completion gate. Inspect the latest steering and task state, then retry completion.');
      const latestPreflight = deterministicVerification(goal);
      const latestRuntime = this.host.runtime(sessionId);
      if (latestRuntime && latestRuntime.activeChildren > 0) latestPreflight.findings.push(`Wait for ${latestRuntime.activeChildren} active child ${latestRuntime.activeChildren === 1 ? 'task' : 'tasks'} to settle.`);
      if (latestPreflight.findings.length > 0) throw new Error(`Completion conditions changed:\n${latestPreflight.findings.map((finding) => `- ${finding}`).join('\n')}`);
      const requiredCriterionIds = goal.criteria.filter((criterion) => criterion.required && criterion.status !== 'waived').map((criterion) => criterion.id);
      const supportingIds = goal.evidence.filter(evidenceSupportsCriterion).map((evidence) => evidence.id);
      const completionEvidence: GoalMaxEvidence = {
        id: `evidence-${randomUUID()}`,
        kind: 'verification',
        title: 'GoalMax completion evidence accepted',
        summary: summary.slice(0, 8_000),
        // This marks each required task as completion-gate verified. It is not
        // added to user-work criterion evidenceIds, so it cannot manufacture
        // the concrete evidence those criteria need to pass Gate A.
        criterionIds: requiredCriterionIds,
        source: 'runtime',
        timestamp: now,
        current: true,
      };
      const evidence = appendEvidence(goal.evidence, completionEvidence);
      const criteria = goal.criteria.map((criterion) => isControlPlaneVerificationCriterion(criterion)
        ? {
            ...criterion,
            status: 'satisfied' as const,
            evidenceIds: [...new Set([...criterion.evidenceIds, ...supportingIds.slice(-1), completionEvidence.id])].slice(-64),
            updatedAt: now,
          }
        : criterion);
      const verifying = goal.status === 'verifying' ? goal : transitionGoalMax(goal, 'verifying', now);
      const completed = transitionGoalMax({
        ...verifying,
        evidence,
        criteria,
        elapsedMs: elapsed(goal, now),
        tokensUsed: runtime ? Math.max(0, runtime.tokensUsed - goal.tokenBaseline) : goal.tokensUsed,
        progress: { ...goal.progress, latestEvidenceAt: now },
      }, 'completed', now);
      const verified = appendGoalMaxTimeline({
        ...completed,
        revision: goal.revision + 1,
        phase: 'handoff',
        executionState: 'idle',
        blockedReason: null,
        failure: null,
        continuation: { ...goal.continuation, pending: false, reason: null },
      }, 'verification.passed', 'Current evidence satisfied the atomic completion gate.', now);
      return appendGoalMaxTimeline(verified, 'goal.completed', 'GoalMax achieved its persisted objective.', now);
    }, true, [], guard); } catch (error) {
      const latest = this.requireState(sessionId);
      if (latest.status === 'completed') return { text: 'GoalMax is already completed. End the current turn without calling more tools.', details: structuredClone(latest) };
      const isRejection = error instanceof GoalMaxCompletionRejected;
      const reason = isRejection
        ? (error.message || 'A new child or steering change arrived during the completion gate.')
        : (redactGoalMaxDiagnostic(errorMessage(error)).trim().slice(0, 4_000) || 'The goal changed before completion could be stored.');
      const text = isRejection && latest.status === 'active'
        ? `Completion was not accepted: ${reason} Resolve the new work and retry completion when it settles.`
        : `Completion was not accepted: ${reason}`;
      return { text, details: structuredClone(latest) };
    } finally {
      this.completionFences.delete(sessionId);
      this.completionFenceConflicts.delete(sessionId);
    }
    const completed = this.requireState(sessionId);
    try {
      await this.taskService?.syncGoal(completed.projectPath, completed.sessionId, completed);
    } catch (error) {
      // The achieved goal is durably persisted; only its task projection is stale.
      // Rebind reconciles it on the next session bind, so surface the failure as
      // a non-blocking continuation note rather than a warning state.
      await this.mutate(sessionId, (goal, now) => appendGoalMaxTimeline({
        ...goal,
        revision: goal.revision + 1,
        continuation: { ...goal.continuation, pending: false, reason: `The task projection could not be written: ${errorMessage(error)}` },
        updatedAt: now,
      }, 'goal.updated', 'Completion was accepted but the task projection needs a rebind to repair.', now)).catch(() => undefined);
    }
    return {
      text: 'GoalMax completed. The persisted objective is achieved. Stop using tools and end the current turn.',
      details: structuredClone(this.requireState(sessionId)),
    };
  }

  async report(sessionId: string, input: GoalMaxReportInput): Promise<{ text: string; details: GoalMaxState }> {
    await this.flushObservations(sessionId);
    const goal = this.requireState(sessionId);
    if (isGoalMaxTerminal(goal.status)) throw new Error('The current goal is already terminal.');
    const taskPlanCaptured = hasGoalMaxTaskPlan(goal);
    if (input.taskPlan) {
      if (input.outcome !== 'progress' || input.blocker || input.pendingTaskChanges || input.criterionUpdates?.length || input.ownerAssignments?.length) {
        throw new Error('Submit the initial task plan as a progress report without pending changes, blockers, criterion updates, or owner assignments.');
      }
      if (taskPlanCaptured) {
        throw new Error('The execution task plan is already captured. Update task progress instead of replacing it.');
      }
      const taskPlan = normalizeReportedTaskPlan(input.taskPlan, goal.objective);
      await this.mutate(sessionId, (current, now) => {
        const criteria = taskPlan.map((task, index) => createGoalMaxCriterion({
          title: task.title,
          description: task.detail,
          required: task.required,
          status: index === 0 ? 'active' : 'pending',
        }, now));
        criteria.push(createGoalMaxCriterion({
          title: GOALMAX_VERIFICATION_TITLE,
          description: 'Current observable evidence must satisfy the atomic completion gate.',
          required: true,
          status: 'pending',
        }, now));
        return appendGoalMaxTimeline({
          ...current,
          revision: current.revision + 1,
          criteria,
          taskPlanCaptured: true,
          phase: 'planning',
          status: current.status === 'paused' ? 'paused' : 'active',
          blockedReason: null,
          completedAt: null,
          evidence: current.evidence.map((evidence) => evidence.kind === 'verification' ? { ...evidence, current: false } : evidence),
          updatedAt: now,
        }, 'goal.updated', `${GOALMAX_TASK_PLAN_TIMELINE_PREFIX} ${taskPlan.length} implementation tasks.`, now);
      });
      this.clearFailClosedState(sessionId);
      return { text: 'Execution task plan recorded. Continue with the first active task.', details: structuredClone(this.requireState(sessionId)) };
    }
    if (input.pendingTaskChanges) {
      if (!taskPlanCaptured) throw new Error('Capture the initial execution task plan before changing pending tasks.');
      if (input.outcome !== 'progress' || input.blocker || input.criterionUpdates?.length || input.ownerAssignments?.length) {
        throw new Error('Submit pending task changes as a progress report without blockers, criterion updates, or owner assignments.');
      }
      const addCount = input.pendingTaskChanges.add?.length ?? 0;
      const removeCount = new Set(input.pendingTaskChanges.removeCriterionIds ?? []).size;
      if (addCount === 0 && removeCount === 0) throw new Error('Pending task changes must add or remove at least one task.');
      await this.mutate(sessionId, (current, now) => {
        const criteria = reconcilePendingTaskChanges(current, input.pendingTaskChanges!, now);
        const reactivated = current.status === 'blocked' || current.status === 'failed' || current.status === 'verifying'
          || current.status === 'budget-limited' || current.status === 'usage-limited';
        return appendGoalMaxTimeline({
          ...current,
          revision: current.revision + 1,
          criteria,
          phase: input.phase ?? current.phase,
          status: current.status === 'paused' ? 'paused' : 'active',
          executionState: reactivated && current.executionState === 'waiting' ? 'running-root' : current.executionState,
          blockedReason: null,
          failure: null,
          evidence: current.evidence.map((evidence) => evidence.kind === 'verification' ? { ...evidence, current: false } : evidence),
          updatedAt: now,
        }, 'goal.updated', `Pending task list updated: ${addCount} added, ${removeCount} removed.`, now);
      });
      this.clearFailClosedState(sessionId);
      const updated = this.requireState(sessionId);
      return { text: 'Pending task changes recorded without changing active or completed work.', details: structuredClone(updated) };
    }
    if (!taskPlanCaptured) {
      if (input.outcome !== 'blocked') throw new Error('Submit a detailed execution task plan before reporting progress or requesting completion.');
      if (input.phase && input.phase !== 'intake' && input.phase !== 'planning') {
        throw new Error('A blocker reported before task planning must remain in intake or planning.');
      }
    }
    await this.mutate(sessionId, (current, now) => {
      const evidenceById = new Map(current.evidence.filter(evidenceSupportsCriterion).map((evidence) => [evidence.id, evidence]));
      const criterionIds = new Set(current.criteria.map((criterion) => criterion.id));
      const assignmentNodeIds = new Set(current.childAssignments.map((assignment) => assignment.nodeId));
      const updates = new Map((input.criterionUpdates ?? []).filter((update) => criterionIds.has(update.criterionId)).map((update) => [update.criterionId, update]));
      const owners = new Map<string, string[]>();
      for (const assignment of input.ownerAssignments ?? []) {
        if (!assignmentNodeIds.has(assignment.nodeId) || !criterionIds.has(assignment.criterionId)) continue;
        owners.set(assignment.criterionId, [...(owners.get(assignment.criterionId) ?? []), assignment.nodeId]);
      }
      const childAssignments = current.childAssignments.map((assignment) => {
        const assignedCriteria = [...owners.entries()].flatMap(([criterionId, nodeIds]) => nodeIds.includes(assignment.nodeId) ? [criterionId] : []);
        return assignedCriteria.length ? { ...assignment, criterionIds: [...new Set([...assignment.criterionIds, ...assignedCriteria])].slice(0, GOALMAX_MAX_CRITERIA) } : assignment;
      });
      const criteria = current.criteria.map((criterion) => {
        const update = updates.get(criterion.id);
        const assignedEvidenceIds = childAssignments.flatMap((assignment) => assignment.criterionIds.includes(criterion.id) ? assignment.evidenceIds : []);
        const requestedEvidenceIds = update?.evidenceIds ?? criterion.evidenceIds;
        const validEvidenceIds = [...new Set([...requestedEvidenceIds, ...assignedEvidenceIds])].filter((id) => evidenceById.has(id)).slice(0, 64);
        const proposed = update?.status ?? criterion.status;
        const status = proposed === 'satisfied' && validEvidenceIds.length === 0 ? 'active' : proposed;
        return {
          ...criterion,
          status,
          evidenceIds: validEvidenceIds,
          ownerNodeIds: owners.has(criterion.id) ? [...new Set([...criterion.ownerNodeIds, ...owners.get(criterion.id)!])].slice(0, 64) : criterion.ownerNodeIds,
          updatedAt: update || owners.has(criterion.id) ? now : criterion.updatedAt,
        };
      });
      const evidenceLinks = new Map<string, string[]>();
      for (const criterion of criteria) for (const evidenceId of criterion.evidenceIds) evidenceLinks.set(evidenceId, [...(evidenceLinks.get(evidenceId) ?? []), criterion.id]);
      const evidence = current.evidence.map((item) => evidenceLinks.has(item.id)
        ? { ...item, criterionIds: [...new Set([...item.criterionIds, ...evidenceLinks.get(item.id)!])].slice(0, GOALMAX_MAX_CRITERIA) }
        : item);
      const phase = input.phase ?? current.phase;
      let next: GoalMaxState = {
        ...current,
        revision: current.revision + 1,
        criteria,
        evidence,
        childAssignments,
        phase,
        blockedReason: input.outcome === 'blocked' ? input.blocker?.trim() || input.summary.trim() : null,
        status: input.outcome === 'blocked' ? 'blocked' : input.outcome === 'completion-candidate' ? 'verifying' : current.status === 'paused' ? 'paused' : 'active',
        executionState: input.outcome === 'completion-candidate' ? 'waiting' : current.executionState,
        updatedAt: now,
      };
      next = appendGoalMaxTimeline(next, input.outcome === 'blocked' ? 'goal.blocked' : input.outcome === 'completion-candidate' ? 'verification.started' : 'checkpoint.created', input.summary, now);
      return next;
    });
    this.clearFailClosedState(sessionId);
    const updated = this.requireState(sessionId);
    return {
      text: input.outcome === 'completion-candidate'
        ? 'Completion candidate recorded. Verification will run after the current root turn settles.'
        : input.outcome === 'blocked' ? 'Goal blocked with an explicit reason. The objective remains persisted.' : 'Goal progress recorded.',
      details: structuredClone(updated),
    };
  }

  observeSessionEvent(sessionId: string, event: AgentSessionEvent): void {
    const goal = this.stateForSession(sessionId);
    if (!goal || isGoalMaxTerminal(goal.status)) return;
    const raw = event as AgentSessionEvent & Record<string, unknown>;
    if (event.type === 'agent_start') {
      this.turnMarkers.set(sessionId, { toolCount: 0, meaningful: false, novelInvestigation: false, latestAssistantText: '', startedAt: Date.now(), statusCalls: 0, reportCalls: 0, completeCalls: 0 });
      void this.mutate(sessionId, (current, now) => ({ ...current, revision: current.revision + 1, executionState: 'running-root', continuation: { ...current.continuation, pending: false }, updatedAt: now }), false).catch(() => undefined);
      return;
    }
    if (event.type === 'tool_execution_start') {
      const map = this.toolStarts.get(sessionId) ?? new Map<string, { name: string; input: string }>();
      map.set(event.toolCallId, { name: event.toolName, input: safeSerialized(event.args) });
      while (map.size > MAX_TRACKED_TOOL_STARTS) map.delete(map.keys().next().value!);
      this.toolStarts.set(sessionId, map);
      const marker = this.turnMarkers.get(sessionId);
      if (marker) {
        if (event.toolName === 'goalmax_status') marker.statusCalls += 1;
        else if (event.toolName === 'goalmax_report') marker.reportCalls += 1;
        else if (event.toolName === 'goalmax_complete') marker.completeCalls += 1;
        else marker.toolCount += 1;
      }
      return;
    }
    if (event.type === 'tool_execution_end') {
      const start = this.toolStarts.get(sessionId)?.get(event.toolCallId);
      this.toolStarts.get(sessionId)?.delete(event.toolCallId);
      const observation = classifyGoalMaxTool(event.toolName, start?.input ?? '', resultText(event.result), event.isError);
      if (!observation) return;
      const evidence = evidenceFromObservation(goal, observation);
      const buffered = this.observationBuffers.get(goal.id)?.items ?? [];
      const novelInvestigation = observation.investigation
        && !goal.evidence.some((item) => item.current && item.fingerprint === evidence.fingerprint)
        && !buffered.some((item) => item.evidence.fingerprint === evidence.fingerprint);
      this.bufferObservation(sessionId, evidence, observation);
      const marker = this.turnMarkers.get(sessionId);
      if (marker) {
        if (observation.meaningful) marker.meaningful = true;
        if (novelInvestigation) marker.novelInvestigation = true;
      }
      return;
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const marker = this.turnMarkers.get(sessionId);
      if (marker) marker.latestAssistantText = resultText(event.message).slice(0, 8_000);
      return;
    }
    if (event.type === 'agent_settled') {
      void this.onRootSettled(sessionId).catch((error: unknown) => { void this.blockAfterRootSettlementFailure(sessionId, error); });
      return;
    }
    if (event.type === 'compaction_end' && !event.aborted && !event.errorMessage && goal.status === 'active') {
      this.schedule(goal, 'compaction-complete');
    }
    void raw;
  }

  syncChildren(sessionId: string, children: GoalMaxRuntimeChild[]): void {
    const goal = this.stateForSession(sessionId);
    if (!goal || isGoalMaxTerminal(goal.status)) return;
    const assignedNodeIds = new Set(goal.childAssignments.map((assignment) => assignment.nodeId));
    const relevantChildren = children.filter((child) => assignedNodeIds.has(child.nodeId)
      || (child.startedAt !== null && child.startedAt >= goal.createdAt)
      || ((child.status === 'pending' || child.status === 'running') && child.endedAt === null));
    // Completion fence: a new active child arriving during the atomic completion
    // gate must reject that completion rather than mutate a completed goal. We
    // detect it here and record a conflict the completion guard reads after its
    // durable save, then skip this sync entirely.
    if (this.completionFences.has(sessionId)) {
      const knownActive = new Set(goal.childAssignments.filter((assignment) => assignment.status === 'running' || assignment.status === 'pending').map((assignment) => assignment.nodeId));
      const newActiveChild = relevantChildren.some((child) => (child.status === 'pending' || child.status === 'running') && !knownActive.has(child.nodeId));
      if (newActiveChild) this.completionFenceConflicts.set(sessionId, 'A new child task started during the completion gate.');
      return;
    }
    const previewAssignments = relevantChildren.slice(0, GOALMAX_MAX_ASSIGNMENTS).map((child) => assignmentFromChild(goal, child));
    const incomingFingerprints = relevantChildren.flatMap((child) => child.observations.map((observation) => childEvidenceFingerprint(goal.id, child.nodeId, observation.key)));
    const retainedFingerprints = new Set(goal.evidence.flatMap((item) => item.fingerprint ? [item.fingerprint] : []));
    if (stableAssignments(goal.childAssignments) === stableAssignments(previewAssignments)
      && incomingFingerprints.every((fingerprint) => retainedFingerprints.has(fingerprint))) return;

    void this.mutate(sessionId, (current, now) => {
      if (isGoalMaxTerminal(current.status)) throw new GoalMaxOperationSuperseded();
      let evidence = current.evidence;
      const evidenceByFingerprint = new Map(evidence.flatMap((item) => item.fingerprint ? [[item.fingerprint, item] as const] : []));
      let addedEvidence = 0;
      const nextAssignments = relevantChildren.slice(0, GOALMAX_MAX_ASSIGNMENTS).map((child) => {
        let assignment = assignmentFromChild(current, child);
        const linkedEvidenceIds = [...assignment.evidenceIds];
        for (const observation of child.observations.slice(-32)) {
          const fingerprint = childEvidenceFingerprint(current.id, child.nodeId, observation.key);
          const existing = evidenceByFingerprint.get(fingerprint);
          if (existing) {
            const criterionIds = [...new Set([...existing.criterionIds, ...assignment.criterionIds])].slice(0, GOALMAX_MAX_CRITERIA);
            if (criterionIds.length !== existing.criterionIds.length) {
              const updated = { ...existing, criterionIds };
              evidence = evidence.map((item) => item.id === existing.id ? updated : item);
              evidenceByFingerprint.set(fingerprint, updated);
            }
            linkedEvidenceIds.push(existing.id);
            continue;
          }
          const item = evidenceFromChildObservation(current, child, assignment, observation, fingerprint);
          evidence = appendEvidence(evidence, item);
          evidenceByFingerprint.set(fingerprint, item);
          linkedEvidenceIds.push(item.id);
          addedEvidence += 1;
        }
        assignment = { ...assignment, evidenceIds: [...new Set(linkedEvidenceIds)].slice(-64) };
        return assignment;
      });
      const evidenceById = new Map(evidence.filter(evidenceSupportsCriterion).map((item) => [item.id, item]));
      const criteria = current.criteria.map((criterion) => {
        const owners = nextAssignments.filter((assignment) => assignment.criterionIds.includes(criterion.id));
        const linkedEvidenceIds = owners.flatMap((assignment) => assignment.evidenceIds).filter((id) => evidenceById.has(id));
        if (!owners.length && !linkedEvidenceIds.length) return criterion;
        return {
          ...criterion,
          ownerNodeIds: [...new Set([...criterion.ownerNodeIds, ...owners.map((assignment) => assignment.nodeId)])].slice(0, 64),
          evidenceIds: [...new Set([...criterion.evidenceIds, ...linkedEvidenceIds])].slice(-64),
          updatedAt: now,
        };
      });
      const criterionLinks = new Map<string, string[]>();
      for (const criterion of criteria) for (const evidenceId of criterion.evidenceIds) criterionLinks.set(evidenceId, [...(criterionLinks.get(evidenceId) ?? []), criterion.id]);
      evidence = evidence.map((item) => criterionLinks.has(item.id)
        ? { ...item, criterionIds: [...new Set([...item.criterionIds, ...criterionLinks.get(item.id)!])].slice(0, GOALMAX_MAX_CRITERIA) }
        : item);
      const hasActiveChildren = nextAssignments.some((assignment) => assignment.status === 'running' || assignment.status === 'pending');
      const executionState: GoalMaxState['executionState'] = current.executionState === 'running-root'
        ? 'running-root'
        : hasActiveChildren
          ? 'running-children'
          : current.executionState === 'running-children' || current.executionState === 'waiting'
            ? 'idle'
            : current.executionState;
      const runtime = this.host.runtime(sessionId);
      let next: GoalMaxState = {
        ...current,
        revision: current.revision + 1,
        childAssignments: nextAssignments,
        criteria,
        evidence,
        executionState,
        tokensUsed: runtime ? Math.max(0, runtime.tokensUsed - current.tokenBaseline) : current.tokensUsed,
        elapsedMs: elapsed(current, now),
        progress: addedEvidence > 0 ? { ...current.progress, latestEvidenceAt: now, latestMeaningfulProgressAt: now } : current.progress,
        updatedAt: now,
      };
      next = appendGoalMaxTimeline(next, addedEvidence > 0 ? 'evidence.added' : 'assignment.updated', addedEvidence > 0
        ? `${addedEvidence} child evidence ${addedEvidence === 1 ? 'record' : 'records'} reconciled.`
        : 'Goal-linked agent assignments reconciled.', now);
      return next;
    }).then(() => {
      const current = this.stateForSession(sessionId);
      const hasActiveChildren = current?.childAssignments.some((assignment) => assignment.status === 'running' || assignment.status === 'pending');
      if (this.diagnosticRuns.has(sessionId)) return;
      if (current?.status === 'active' && !hasActiveChildren && current.executionState === 'idle') this.schedule(current, 'children-settled');
      else if (current?.status === 'verifying' && !hasActiveChildren && current.executionState === 'idle' && this.host.runtime(sessionId)?.idle) void this.verify(sessionId).catch(() => undefined);
    }).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    for (const buffer of this.observationBuffers.values()) clearTimeout(buffer.timer);
    await Promise.allSettled([...this.sessionKeys.keys()].map((sessionId) => this.flushObservations(sessionId)));
    await Promise.allSettled([...this.verificationRuns.values(), ...this.diagnosticRuns.values()]);
    this.observationBuffers.clear();
    this.verificationRuns.clear();
    this.diagnosticRuns.clear();
    this.failClosedStates.clear();
    this.scheduler.dispose();
    this.states.clear();
    this.sessionKeys.clear();
    this.toolStarts.clear();
    this.turnMarkers.clear();
  }

  private async onRootSettled(sessionId: string): Promise<void> {
    await this.flushObservations(sessionId);
    const marker = this.turnMarkers.get(sessionId) ?? { toolCount: 0, meaningful: false, novelInvestigation: false, latestAssistantText: '', startedAt: Date.now(), statusCalls: 0, reportCalls: 0, completeCalls: 0 };
    this.turnMarkers.delete(sessionId);
    let gatewayViolation: string | null = null;
    await this.serialize(sessionId, async () => {
      const goal = this.requireState(sessionId);
      if (isGoalMaxTerminal(goal.status)) return;
      const runtime = this.host.runtime(sessionId);
      const workspace = await this.progressEngine.capture(goal.projectPath);
      const now = Date.now();
      const workspaceChanged = workspace.fingerprint !== goal.progress.latestWorkspaceFingerprint;
      gatewayViolation = strictGatewayViolation(goal, marker, workspaceChanged);
      let evidence = goal.evidence;
      const researchProgress = goalMaxResearchProgress(goal, marker.latestAssistantText, marker.novelInvestigation);
      let meaningful = marker.meaningful || workspaceChanged || researchProgress;
      if (workspaceChanged) {
        evidence = invalidateVerificationEvidence(evidence, marker.startedAt);
        evidence = appendEvidence(evidence, workspaceEvidence(goal, workspace, now));
      }
      const overlap = marker.latestAssistantText ? goalMaxScopeOverlap(goal.objective, marker.latestAssistantText) : 1;
      if (marker.latestAssistantText && overlap < 0.04 && marker.toolCount === 0) meaningful = false;
      const planningOnly = marker.toolCount === 0 && !workspaceChanged;
      let next: GoalMaxState = {
        ...goal,
        revision: goal.revision + 1,
        executionState: 'idle',
        evidence,
        tokensUsed: runtime ? Math.max(0, runtime.tokensUsed - goal.tokenBaseline) : goal.tokensUsed,
        elapsedMs: elapsed(goal, now),
        continuation: { ...goal.continuation, pending: false, lastSettledAt: now, reason: null },
        progress: {
          ...goal.progress,
          meaningfulTurnCount: goal.progress.meaningfulTurnCount + (meaningful ? 1 : 0),
          noProgressTurnCount: meaningful ? 0 : goal.progress.noProgressTurnCount + 1,
          planningOnlyTurnCount: planningOnly ? goal.progress.planningOnlyTurnCount + 1 : 0,
          changedFileCount: workspace.changedFileCount,
          latestWorkspaceFingerprint: workspace.fingerprint,
          latestEvidenceAt: evidence.at(-1)?.timestamp ?? goal.progress.latestEvidenceAt,
          latestMeaningfulProgressAt: meaningful ? now : goal.progress.latestMeaningfulProgressAt,
        },
        updatedAt: now,
      };
      next = appendGoalMaxTimeline(next, 'continuation.settled', meaningful ? 'Root turn settled with observable progress.' : 'Root turn settled without observable progress.', now);
      await this.commit(next, goal.revision);
    });
    if (gatewayViolation) {
      await this.blockForGatewayViolation(sessionId, gatewayViolation);
      return;
    }
    const current = this.stateForSession(sessionId);
    if (!current || isGoalMaxTerminal(current.status) || current.status === 'paused' || current.status === 'blocked') return;
    if (current.status === 'verifying') {
      const runtime = this.host.runtime(sessionId);
      if (runtime && runtime.activeChildren > 0) {
        this.syncChildren(sessionId, runtime.children);
        return;
      }
      await this.verify(sessionId);
      return;
    }
    const recovery = decideGoalMaxRecovery(current);
    if (recovery.kind === 'blocked') {
      await this.mutate(sessionId, (goal, now) => appendGoalMaxTimeline({
        ...transitionGoalMax(goal, 'blocked', now), revision: goal.revision + 1, blockedReason: recovery.reason,
      }, 'goal.blocked', recovery.reason, now));
      return;
    }
    if (recovery.kind === 'diagnose' && current.agentStrategy !== 'off') {
      await this.diagnose(sessionId);
      return;
    }
    this.schedule(current, 'root-settled');
  }

  private async blockForGatewayViolation(sessionId: string, reason: string): Promise<void> {
    const current = this.stateForSession(sessionId);
    if (!current || current.status !== 'active') return;
    this.scheduler.cancel(current.id);
    try {
      await this.mutate(sessionId, (goal, now) => {
        if (goal.status !== 'active') throw new GoalMaxOperationSuperseded();
        return appendGoalMaxTimeline({
          ...transitionGoalMax(goal, 'blocked', now),
          revision: goal.revision + 1,
          blockedReason: reason,
        }, 'goal.blocked', reason, now);
      });
    } catch { /* A concurrent change superseded the gateway block; the goal already reflects it. */ }
  }

  private async blockAfterRootSettlementFailure(sessionId: string, error: unknown): Promise<void> {
    const current = this.stateForSession(sessionId);
    if (!current || (current.status !== 'active' && current.status !== 'verifying')) return;
    const diagnostic = redactGoalMaxDiagnostic(errorMessage(error)).trim() || 'Unknown settlement failure.';
    const reason = `GoalMax stopped safely because the root turn could not be settled: ${diagnostic}`.slice(0, 4_000);
    this.scheduler.cancel(current.id);
    try {
      await this.mutate(sessionId, (goal, now) => {
        if (goal.status !== 'active' && goal.status !== 'verifying') throw new GoalMaxOperationSuperseded();
        const blocked = transitionGoalMax({ ...goal, blockedReason: reason }, 'blocked', now);
        return appendGoalMaxTimeline({
          ...blocked,
          revision: goal.revision + 1,
          executionState: 'idle',
          continuation: { ...goal.continuation, pending: false, reason: 'Root settlement failed; review the blocker before resuming.' },
          failure: { code: 'GOALMAX_SETTLEMENT_FAILED', message: reason, retryable: true },
        }, 'goal.blocked', reason, now);
      });
    } catch (recoveryError) {
      // Persistence may itself be the failed dependency. Publish a validated,
      // process-local blocked projection so the UI and lifecycle fail closed
      // even though the durable snapshot must be retried on resume/rebind.
      const latest = this.stateForSession(sessionId);
      if (!latest) return;
      if (latest.status === 'blocked' || isGoalMaxTerminal(latest.status)) {
        try { this.host.emit(snapshotEvent(latest)); } catch { /* The authoritative state is already non-runnable. */ }
        return;
      }
      if (latest.status !== 'active' && latest.status !== 'verifying') return;
      const recoveryDiagnostic = redactGoalMaxDiagnostic(errorMessage(recoveryError)).trim() || 'Unknown persistence failure.';
      const failClosedReason = `${reason} Recovery could not be persisted: ${recoveryDiagnostic}`.slice(0, 4_000);
      const now = Date.now();
      const blocked = transitionGoalMax({ ...latest, blockedReason: failClosedReason }, 'blocked', now);
      const failClosed = goalMaxStateSchema.parse(normalizeGoalReferences(appendGoalMaxTimeline({
        ...blocked,
        executionState: 'idle',
        continuation: { ...latest.continuation, pending: false, reason: 'Root settlement failed; retry by resuming or rebinding the session.' },
        failure: { code: 'GOALMAX_SETTLEMENT_FAILED', message: failClosedReason, retryable: true },
      }, 'goal.blocked', failClosedReason, now)));
      this.failClosedStates.set(sessionId, failClosed);
      try { this.host.persistSessionEvent(sessionId, failClosed); } catch { /* Best-effort session checkpoint. */ }
      try { this.host.emit(snapshotEvent(failClosed)); } catch { /* Runtime reads still expose the blocked projection. */ }
    }
  }

  private diagnose(sessionId: string): Promise<void> {
    const running = this.diagnosticRuns.get(sessionId);
    if (running) return running;
    const diagnosis = this.performDiagnosis(sessionId);
    this.diagnosticRuns.set(sessionId, diagnosis);
    void diagnosis.finally(() => {
      if (this.diagnosticRuns.get(sessionId) === diagnosis) this.diagnosticRuns.delete(sessionId);
    }).catch(() => undefined);
    return diagnosis;
  }

  private async performDiagnosis(sessionId: string): Promise<void> {
    const initial = this.requireState(sessionId);
    if (initial.status !== 'active') return;
    await this.mutate(sessionId, (goal, now) => appendGoalMaxTimeline({
      ...goal,
      revision: goal.revision + 1,
      executionState: 'waiting',
      continuation: { ...goal.continuation, pending: false, reason: 'Running a bounded diagnostic review.' },
      updatedAt: now,
    }, 'checkpoint.created', 'Bounded anti-stall diagnostic review started.', now));
    const goal = this.requireState(sessionId);
    let result: GoalMaxDiagnosticResult;
    try {
      result = await this.host.diagnoseGoal(sessionId, goalMaxDiagnosticPrompt(goal));
    } catch (error) {
      result = { report: `Diagnostic reviewer unavailable: ${errorMessage(error)}`, infrastructureFailure: 'unavailable' };
    }
    const latest = this.stateForSession(sessionId);
    if (!latest || latest.id !== goal.id || latest.status !== 'active') return;
    await this.mutate(sessionId, (current, now) => {
      const report = redactGoalMaxDiagnostic(result.report).slice(0, 8_000);
      const evidence: GoalMaxEvidence = {
        id: `evidence-${randomUUID()}`,
        kind: 'subagent',
        title: result.infrastructureFailure ? 'Diagnostic review unavailable' : 'Diagnostic review completed',
        summary: report,
        criterionIds: [],
        source: result.nodeId ? 'child-tool' : 'runtime',
        timestamp: now,
        current: true,
        ...(result.nodeId ? { path: result.nodeId } : {}),
        fingerprint: createHash('sha256').update(`${current.id}\0diagnosis\0${report}`).digest('hex'),
      };
      return appendGoalMaxTimeline({
        ...current,
        revision: current.revision + 1,
        executionState: 'idle',
        evidence: appendEvidence(current.evidence, evidence),
        continuation: { ...current.continuation, reason: result.infrastructureFailure ? 'Diagnostic review was unavailable; change strategy directly.' : 'Use the diagnostic review to take a materially different action.' },
        progress: { ...current.progress, latestEvidenceAt: now },
        updatedAt: now,
      }, 'evidence.added', result.infrastructureFailure ? 'Diagnostic review was unavailable; root strategy change required.' : 'Diagnostic review recorded for the next recovery turn.', now);
    });
    const current = this.stateForSession(sessionId);
    if (current?.status === 'active') this.schedule(current, 'diagnostic-review');
  }

  private async checkpoint(sessionId: string, summary: string, currentTurnStartedAt?: number): Promise<void> {
    await this.flushObservations(sessionId);
    await this.serialize(sessionId, async () => {
      const goal = this.requireState(sessionId);
      const workspace = await this.progressEngine.capture(goal.projectPath);
      const runtime = this.host.runtime(sessionId);
      const now = Date.now();
      let evidence = goal.evidence;
      if (workspace.fingerprint !== goal.progress.latestWorkspaceFingerprint) evidence = appendEvidence(invalidateVerificationEvidence(evidence, currentTurnStartedAt), workspaceEvidence(goal, workspace, now));
      const next = appendGoalMaxTimeline({
        ...goal,
        revision: goal.revision + 1,
        evidence,
        tokensUsed: runtime ? Math.max(0, runtime.tokensUsed - goal.tokenBaseline) : goal.tokensUsed,
        elapsedMs: elapsed(goal, now),
        progress: {
          ...goal.progress,
          changedFileCount: workspace.changedFileCount,
          latestWorkspaceFingerprint: workspace.fingerprint,
          latestEvidenceAt: evidence.at(-1)?.timestamp ?? goal.progress.latestEvidenceAt,
        },
        updatedAt: now,
      }, 'checkpoint.created', summary, now);
      await this.commit(next, goal.revision);
    });
  }

  private async reactivateFromRejectedCompletion(
    sessionId: string,
    current: GoalMaxState,
    reasonText: string,
  ): Promise<GoalMaxState> {
    if (current.status !== 'verifying') return current;
    try {
      await this.mutate(sessionId, (goal, now) => appendGoalMaxTimeline({
        ...transitionGoalMax(goal, 'active', now),
        revision: goal.revision + 1,
        phase: goal.phase === 'verification' ? 'implementation' : goal.phase,
        executionState: 'idle',
        blockedReason: null,
        failure: null,
        evidence: goal.evidence.map((evidence) => evidence.kind === 'verification' ? { ...evidence, current: false } : evidence),
        continuation: { ...goal.continuation, pending: false, reason: reasonText.slice(0, 1_000) },
        updatedAt: now,
      }, 'verification.failed', 'Completion request left the verifying state and returned to active work.', now));
    } catch { /* a concurrent mutation already moved the goal forward */ }
    return this.requireState(sessionId);
  }

  private async requestVerification(sessionId: string, summary: string): Promise<void> {
    await this.flushObservations(sessionId);
    await this.mutate(sessionId, (goal, now) => {
      const base = goal.status === 'active' ? goal : { ...goal, status: 'active' as const };
      const verifying = transitionGoalMax(base, 'verifying', now);
      return appendGoalMaxTimeline({ ...verifying, revision: goal.revision + 1, phase: 'verification', blockedReason: null }, 'verification.started', summary, now);
    });
    this.clearFailClosedState(sessionId);
    const runtime = this.host.runtime(sessionId);
    if (runtime?.idle && runtime.activeChildren === 0) await this.verify(sessionId);
  }

  private verify(sessionId: string): Promise<void> {
    const running = this.verificationRuns.get(sessionId);
    if (running) return running;
    const verification = this.performVerification(sessionId);
    this.verificationRuns.set(sessionId, verification);
    void verification.finally(() => {
      if (this.verificationRuns.get(sessionId) === verification) this.verificationRuns.delete(sessionId);
    }).catch(() => undefined);
    return verification;
  }

  private async performVerification(sessionId: string): Promise<void> {
    await this.checkpoint(sessionId, 'Completion evidence reconciled before verification.');
    let goal = this.requireState(sessionId);
    if (goal.status !== 'verifying') return;
    const deterministic = deterministicVerification(goal);
    let verification: GoalMaxVerificationResult | null = null;
    let verifierFailure: string | null = null;
    if (deterministic.pass) {
      try { verification = await this.host.verifyGoal(sessionId, goalMaxVerificationPrompt(goal)); }
      catch (error) {
        verifierFailure = `Independent verifier unavailable: ${errorMessage(error)}`.slice(0, 4_000);
        deterministic.findings.push(verifierFailure);
      }
    }
    if (verification?.infrastructureFailure === 'timeout') verifierFailure = 'Independent verifier timed out. Retry verification.';
    else if (verification?.infrastructureFailure === 'unavailable') verifierFailure = 'Independent verifier unavailable. Retry verification.';
    const reportPass = deterministic.findings.length === 0 && verification?.verdict === 'pass';
    const report = verification?.report ?? deterministic.findings.join('\n');
    const latest = this.stateForSession(sessionId);
    if (!latest || latest.id !== goal.id || latest.status !== 'verifying') return;
    try { await this.mutate(sessionId, (current, now) => {
      if (current.id !== goal.id || current.status !== 'verifying') throw new GoalMaxOperationSuperseded();
      const criterionIds = current.criteria.filter((criterion) => criterion.required && criterion.status !== 'waived').map((criterion) => criterion.id);
      const verifierEvidence: GoalMaxEvidence = {
        id: `evidence-${randomUUID()}`,
        kind: 'verification',
        title: reportPass ? 'Independent completion gate passed' : verifierFailure ? 'Independent completion review unavailable' : 'Completion gate returned follow-up work',
        summary: report.slice(0, 8_000),
        criterionIds,
        source: verification ? 'verifier' : 'runtime',
        timestamp: now,
        current: true,
        ...(verification?.nodeId ? { path: verification.nodeId } : {}),
      };
      const evidence = appendEvidence(current.evidence, verifierEvidence);
      const runtime = this.host.runtime(sessionId);
      const accounting = {
        elapsedMs: elapsed(current, now),
        tokensUsed: runtime ? Math.max(0, runtime.tokensUsed - current.tokenBaseline) : current.tokensUsed,
        progress: { ...current.progress, latestEvidenceAt: now },
      };
      if (reportPass) {
        const supportingIds = current.evidence.filter(evidenceSupportsCriterion).map((evidence) => evidence.id);
        const criteria = current.criteria.map((criterion) => criterion.required && criterion.status !== 'waived'
          ? {
              ...criterion,
              status: 'satisfied' as const,
              evidenceIds: [...new Set([
                ...criterion.evidenceIds,
                ...(isControlPlaneVerificationCriterion(criterion) ? supportingIds.slice(-1) : []),
                verifierEvidence.id,
              ])].slice(-64),
              updatedAt: now,
            }
          : criterion);
        const completed = transitionGoalMax({ ...current, ...accounting, evidence, criteria }, 'completed', now);
        const verified = appendGoalMaxTimeline({ ...completed, revision: current.revision + 1, phase: 'handoff', executionState: 'idle' }, 'verification.passed', 'All required criteria passed the completion gate.', now);
        return appendGoalMaxTimeline(verified, 'goal.completed', 'GoalMax completed after independent verification.', now);
      }
      if (verifierFailure) {
        const active = transitionGoalMax({ ...current, ...accounting, evidence }, 'active', now);
        return appendGoalMaxTimeline({
          ...active,
          revision: current.revision + 1,
          phase: 'validation',
          executionState: 'idle',
          blockedReason: null,
          failure: null,
          continuation: { ...current.continuation, pending: false, reason: verifierFailure },
        }, 'verification.failed', `${verifierFailure} GoalMax remains active and will retry without showing a work blocker.`, now);
      }
      const findings = [...deterministic.findings, ...parseVerificationFindings(report)].filter(Boolean).slice(0, 8);
      const existingTitles = new Set(current.criteria.map((criterion) => criterion.title.toLocaleLowerCase()));
      const added = findings.flatMap((finding) => {
        const title = finding.slice(0, 240);
        if (existingTitles.has(title.toLocaleLowerCase())) return [];
        existingTitles.add(title.toLocaleLowerCase());
        return [createGoalMaxCriterion({ title, description: finding.slice(0, 2_000), required: true, status: 'pending', evidenceIds: [verifierEvidence.id] }, now)];
      });
      const verificationIndex = current.criteria.findIndex(isControlPlaneVerificationCriterion);
      const nextCriteria = (verificationIndex < 0
        ? [...current.criteria, ...added]
        : [...current.criteria.slice(0, verificationIndex), ...added, ...current.criteria.slice(verificationIndex)]
      ).slice(0, GOALMAX_MAX_CRITERIA);
      const retainedCriterionIds = new Set(nextCriteria.map((criterion) => criterion.id));
      const linkedEvidence = evidence.map((item) => item.id === verifierEvidence.id
        ? { ...item, criterionIds: [...new Set([...item.criterionIds, ...added.map((criterion) => criterion.id)])].filter((id) => retainedCriterionIds.has(id)).slice(0, GOALMAX_MAX_CRITERIA) }
        : item);
      const active = transitionGoalMax({ ...current, ...accounting, evidence: linkedEvidence, criteria: nextCriteria }, 'active', now);
      return appendGoalMaxTimeline({ ...active, revision: current.revision + 1, phase: deterministic.needsVerificationCommand ? 'validation' : 'implementation' }, 'verification.failed', 'Completion gate failed; findings returned to active execution.', now);
    }); } catch (error) {
      if (error instanceof GoalMaxOperationSuperseded) return;
      throw error;
    }
    goal = this.requireState(sessionId);
    if (goal.status === 'active') this.schedule(goal, 'verification-failed');
  }

  private schedule(goal: GoalMaxState, reason: string): void {
    if (goal.status !== 'active') return;
    this.scheduler.schedule({ goalId: goal.id, expectedRevision: goal.revision, reason }, (request) => this.maybeContinue(goal.sessionId, request.expectedRevision, request.reason));
  }

  private async maybeContinue(sessionId: string, expectedRevision: number, reason: string): Promise<void> {
    await this.flushObservations(sessionId);
    const initial = this.stateForSession(sessionId);
    if (!initial || initial.revision !== expectedRevision || initial.status !== 'active' || initial.executionState !== 'idle') return;
    const runtime = this.host.runtime(sessionId);
    if (!runtime || !runtime.idle || runtime.streaming || runtime.queuedUserMessages > 0) return;
    if (runtime.activeChildren > 0) {
      await this.mutate(sessionId, (goal, now) => ({ ...goal, revision: goal.revision + 1, executionState: 'running-children', updatedAt: now }), false);
      return;
    }
    const now = Date.now();
    const tokensUsed = Math.max(0, runtime.tokensUsed - initial.tokenBaseline);
    const elapsedMs = elapsed(initial, now);
    if ((initial.budget.tokenLimit !== null && tokensUsed >= initial.budget.tokenLimit) || (initial.budget.timeLimitMs !== null && elapsedMs >= initial.budget.timeLimitMs)) {
      await this.mutate(sessionId, (goal, timestamp) => appendGoalMaxTimeline({
        ...transitionGoalMax(goal, 'budget-limited', timestamp), revision: goal.revision + 1, tokensUsed, elapsedMs,
        blockedReason: 'The explicit user budget was reached.',
      }, 'budget.reached', 'Explicit user budget reached; continuation paused.', timestamp));
      return;
    }
    let current = initial;
    if (runtime.permissionLevel !== current.permission.permissionLevel || runtime.projectTrusted !== current.permission.projectTrusted) {
      await this.mutate(sessionId, (goal, timestamp) => ({
        ...goal, revision: goal.revision + 1, permission: permissionSnapshot(runtime, goal.permission, timestamp), updatedAt: timestamp,
      }));
      current = this.requireState(sessionId);
    }
    const recovery = decideGoalMaxRecovery(current);
    if (recovery.kind === 'blocked') {
      await this.mutate(sessionId, (goal, timestamp) => appendGoalMaxTimeline({
        ...transitionGoalMax(goal, 'blocked', timestamp), revision: goal.revision + 1, blockedReason: recovery.reason,
      }, 'goal.blocked', recovery.reason, timestamp));
      return;
    }
    let dispatched: GoalMaxState | null = null;
    await this.mutate(sessionId, (goal, timestamp) => {
      const recoveryPhase = recovery.kind === 'change-strategy' ? goalMaxRecoveryPhase(goal.phase) : goal.phase;
      let next: GoalMaxState = {
        ...goal,
        revision: goal.revision + 1,
        phase: recoveryPhase,
        executionState: 'running-root',
        tokensUsed,
        elapsedMs,
        continuation: {
          pending: false,
          attempt: goal.continuation.attempt + 1,
          lastScheduledAt: timestamp,
          lastSettledAt: goal.continuation.lastSettledAt,
          reason,
        },
        updatedAt: timestamp,
      };
      if (recoveryPhase !== goal.phase) next = appendGoalMaxTimeline(next, 'phase.changed', `Anti-stall recovery changed phase from ${goal.phase} to ${recoveryPhase}.`, timestamp);
      next = appendGoalMaxTimeline(next, 'continuation.scheduled', `${reason}: ${recovery.kind}.`, timestamp);
      dispatched = next;
      return next;
    });
    const goal = dispatched ?? this.requireState(sessionId);
    try {
      await this.host.continueGoal(sessionId, goalMaxCapsule(goal, recovery), goal.id, goal.revision);
    } catch (error) {
      const failure = classifyContinuationFailure(error);
      try { await this.mutate(sessionId, (latest, timestamp) => {
        if (latest.id !== goal.id || latest.revision !== goal.revision || latest.status !== 'active') throw new GoalMaxOperationSuperseded();
        if (failure.kind === 'defer') return appendGoalMaxTimeline({
          ...latest,
          revision: latest.revision + 1,
          executionState: 'idle',
          continuation: { ...latest.continuation, pending: false, reason: failure.message },
          updatedAt: timestamp,
        }, 'continuation.settled', 'Automatic continuation deferred to current user work.', timestamp);
        const transitioned = transitionGoalMax(latest, failure.status, timestamp);
        return appendGoalMaxTimeline({
          ...transitioned,
          revision: latest.revision + 1,
          executionState: 'idle',
          blockedReason: failure.message,
          failure: failure.status === 'failed' ? { code: failure.code, message: failure.message, retryable: true } : null,
          updatedAt: timestamp,
        }, 'goal.blocked', failure.summary, timestamp);
      }); } catch (mutationError) {
        if (!(mutationError instanceof GoalMaxOperationSuperseded)) throw mutationError;
      }
    }
  }

  private bufferObservation(sessionId: string, evidence: GoalMaxEvidence, observation: ToolObservation): void {
    const goal = this.stateForSession(sessionId);
    if (!goal) return;
    const existing = this.observationBuffers.get(goal.id);
    if (existing) {
      existing.items.push({ evidence, observation });
      if (existing.items.length > MAX_BUFFERED_OBSERVATIONS) existing.items.splice(0, existing.items.length - MAX_BUFFERED_OBSERVATIONS);
      return;
    }
    const timer = setTimeout(() => { void this.flushObservations(sessionId).catch(() => undefined); }, 1_000);
    timer.unref?.();
    this.observationBuffers.set(goal.id, { items: [{ evidence, observation }], timer });
  }

  private async flushObservations(sessionId: string): Promise<void> {
    const goal = this.stateForSession(sessionId);
    if (!goal) return;
    const buffer = this.observationBuffers.get(goal.id);
    if (!buffer) return;
    clearTimeout(buffer.timer);
    this.observationBuffers.delete(goal.id);
    const items = buffer.items.slice(-MAX_BUFFERED_OBSERVATIONS);
    const newEvidence = items.map((item) => item.evidence);
    await this.mutate(sessionId, (current, now) => {
      let repeatedFailureCount = current.progress.repeatedFailureCount;
      let lastFailureFingerprint = current.progress.lastFailureFingerprint;
      for (const { observation } of items) {
        if (!observation.failureFingerprint) {
          if (observation.meaningful) { repeatedFailureCount = 0; lastFailureFingerprint = null; }
          continue;
        }
        repeatedFailureCount = observation.failureFingerprint === lastFailureFingerprint ? repeatedFailureCount + 1 : 1;
        lastFailureFingerprint = observation.failureFingerprint;
      }
      let evidence = current.evidence;
      for (const item of newEvidence) {
        evidence = supersedeMatchingEvidence(evidence, item);
        evidence = appendEvidence(evidence, item);
      }
      return {
        ...current,
        revision: current.revision + 1,
        evidence,
        progress: {
          ...current.progress,
          repeatedFailureCount,
          lastFailureFingerprint,
          latestEvidenceAt: newEvidence.at(-1)?.timestamp ?? current.progress.latestEvidenceAt,
        },
        updatedAt: now,
      };
    }, false, newEvidence.map((evidence) => evidenceEvent(goal, evidence)));
  }

  private discardTransientState(goal: GoalMaxState): void {
    this.scheduler.cancel(goal.id);
    const buffer = this.observationBuffers.get(goal.id);
    if (buffer) clearTimeout(buffer.timer);
    this.observationBuffers.delete(goal.id);
    this.toolStarts.delete(goal.sessionId);
    this.turnMarkers.delete(goal.sessionId);
    this.failClosedStates.delete(goal.sessionId);
    this.completionFences.delete(goal.sessionId);
    this.completionFenceConflicts.delete(goal.sessionId);
  }

  private requireSelectedRuntime(): GoalMaxRuntimeSnapshot {
    // UI control calls always target the currently selected runtime. Iterating bound
    // background sessions here can mutate the wrong session after a tab switch.
    const selected = this.host.runtime('');
    if (!selected) throw new Error('Open and trust a project before using GoalMax.');
    return selected;
  }

  private clearFailClosedState(sessionId: string): void {
    if (!this.failClosedStates.delete(sessionId)) return;
    const current = this.stateForSession(sessionId);
    if (current) this.host.emit(snapshotEvent(current));
  }

  private stateForSession(sessionId: string): GoalMaxState | null {
    const key = this.sessionKeys.get(sessionId);
    return key ? this.states.get(key) ?? null : null;
  }

  private requireState(sessionId: string): GoalMaxState {
    const goal = this.stateForSession(sessionId);
    if (!goal) throw new Error('This session has no GoalMax objective.');
    return goal;
  }

  private mutate(
    sessionId: string,
    operation: (goal: GoalMaxState, now: number) => GoalMaxState,
    emitSnapshot = true,
    additionalEvents: GoalMaxEvent[] = [],
    guard?: GoalMaxCommitGuard,
  ): Promise<void> {
    return this.serialize(sessionId, async () => {
      const current = this.requireState(sessionId);
      const source = hasGoalMaxTaskPlan(current) && current.taskPlanCaptured !== true ? { ...current, taskPlanCaptured: true } : current;
      const next = goalMaxStateSchema.parse(normalizeGoalReferences(operation(structuredClone(source), Date.now())));
      if (next.id !== current.id || next.sessionId !== current.sessionId || next.projectPath !== current.projectPath || next.revision !== current.revision + 1) {
        throw new Error('GoalMax mutations must preserve identity and increment one revision.');
      }
      await this.commit(next, current.revision, emitSnapshot, additionalEvents, guard);
    });
  }

  private async commit(
    next: GoalMaxState,
    expectedRevision: number,
    emitSnapshot = true,
    additionalEvents: GoalMaxEvent[] = [],
    guard?: GoalMaxCommitGuard,
  ): Promise<void> {
    let committed = goalMaxStateSchema.parse(normalizeGoalReferences(next));
    const storedPrevious = this.states.get(goalKey(committed.projectPath, committed.sessionId));
    const failClosed = this.failClosedStates.get(committed.sessionId);
    const previous = failClosed?.id === storedPrevious?.id ? failClosed : storedPrevious;
    if (!storedPrevious) throw new Error('GoalMax cannot commit without a bound previous state.');
    await this.repository.save(committed, expectedRevision);
    let guardFailure: GoalMaxCompletionRejected | null = null;
    const guardReason = guard?.validate();
    if (guard && guardReason) {
      const attempted = committed;
      committed = goalMaxStateSchema.parse(normalizeGoalReferences(guard.recover(structuredClone(storedPrevious), structuredClone(attempted), guardReason, Date.now())));
      if (committed.id !== attempted.id || committed.sessionId !== attempted.sessionId || committed.projectPath !== attempted.projectPath || committed.revision !== attempted.revision + 1 || isGoalMaxTerminal(committed.status)) {
        throw new Error('A rejected GoalMax completion must recover the same goal as a non-terminal next revision.');
      }
      await this.repository.save(committed, attempted.revision);
      guardFailure = new GoalMaxCompletionRejected(guardReason);
    }
    // Keep the canonical task list bound to this goal. syncGoal is idempotent,
    // derives task verification from current completion evidence, and is
    // serialized on its own per-session queue.
    this.taskService?.syncGoal(committed.projectPath, committed.sessionId, committed).catch(() => undefined);
    let visible = committed;
    if (failClosed?.id === committed.id && activeGoalStatuses.has(committed.status)) {
      visible = goalMaxStateSchema.parse({
        ...committed,
        status: 'blocked',
        executionState: 'idle',
        blockedReason: failClosed.blockedReason,
        failure: failClosed.failure,
        continuation: { ...committed.continuation, pending: false, reason: failClosed.continuation.reason },
        timeline: failClosed.timeline,
        updatedAt: Math.max(committed.updatedAt, failClosed.updatedAt),
      });
      this.failClosedStates.set(committed.sessionId, visible);
    } else if (!activeGoalStatuses.has(committed.status)) this.failClosedStates.delete(committed.sessionId);
    this.states.set(goalKey(committed.projectPath, committed.sessionId), committed);
    this.sessionKeys.set(committed.sessionId, goalKey(committed.projectPath, committed.sessionId));
    this.host.persistSessionEvent(committed.sessionId, visible);
    if (failClosed?.id === committed.id || emitSnapshot) this.host.emit(snapshotEvent(visible));
    else {
      if (!previous || previous.status !== visible.status || previous.executionState !== visible.executionState || previous.blockedReason !== visible.blockedReason) this.host.emit(statusEvent(visible));
      if (!previous || previous.phase !== visible.phase) this.host.emit(phaseEvent(visible));
      if (!previous || previous.tokensUsed !== visible.tokensUsed || previous.elapsedMs !== visible.elapsedMs) this.host.emit(usageEvent(visible));
    }
    for (const event of additionalEvents) this.host.emit({ ...event, revision: committed.revision } as GoalMaxEvent);
    if (guardFailure) throw guardFailure;
  }

  private serialize(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const key = this.sessionKeys.get(sessionId) ?? sessionId;
    const previous = this.mutationQueues.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const queued = result.then(() => undefined, () => undefined);
    this.mutationQueues.set(key, queued);
    void queued.finally(() => { if (this.mutationQueues.get(key) === queued) this.mutationQueues.delete(key); });
    return result;
  }
}

function goalKey(projectPath: string, sessionId: string): string {
  return `${projectPath}\0${sessionId}`;
}

function snapshotEvent(goal: GoalMaxState): GoalMaxEvent {
  return { type: 'goalmax.snapshot', projectPath: goal.projectPath, sessionId: goal.sessionId, goal: structuredClone(goal), timestamp: Date.now() };
}

function statusEvent(goal: GoalMaxState): GoalMaxEvent {
  return {
    type: 'goalmax.status', projectPath: goal.projectPath, sessionId: goal.sessionId, goalId: goal.id,
    revision: goal.revision, status: goal.status, executionState: goal.executionState,
    blockedReason: goal.blockedReason, timestamp: goal.updatedAt,
  };
}

function phaseEvent(goal: GoalMaxState): GoalMaxEvent {
  return {
    type: 'goalmax.phase', projectPath: goal.projectPath, sessionId: goal.sessionId, goalId: goal.id,
    revision: goal.revision, phase: goal.phase, timestamp: goal.updatedAt,
  };
}

function usageEvent(goal: GoalMaxState): GoalMaxEvent {
  return {
    type: 'goalmax.usage', projectPath: goal.projectPath, sessionId: goal.sessionId, goalId: goal.id,
    revision: goal.revision, tokensUsed: goal.tokensUsed, elapsedMs: goal.elapsedMs, timestamp: goal.updatedAt,
  };
}

function evidenceEvent(goal: GoalMaxState, evidence: GoalMaxEvidence): GoalMaxEvent {
  return { type: 'goalmax.evidence', projectPath: goal.projectPath, sessionId: goal.sessionId, goalId: goal.id, revision: goal.revision, evidence, timestamp: evidence.timestamp };
}

function permissionSnapshot(runtime: GoalMaxRuntimeSnapshot, previous: GoalMaxState['permission'], now: number): GoalMaxState['permission'] {
  const changed = runtime.permissionLevel !== previous.permissionLevel || runtime.projectTrusted !== previous.projectTrusted;
  return {
    permissionLevel: runtime.permissionLevel,
    projectTrusted: runtime.projectTrusted,
    revision: previous.revision + (changed ? 1 : 0),
    resolvedAt: now,
  };
}

function elapsed(goal: GoalMaxState, now: number): number {
  return goal.startedAt === null ? goal.elapsedMs : Math.max(goal.elapsedMs, now - goal.startedAt);
}

function evidenceFromObservation(goal: GoalMaxState, observation: ToolObservation): GoalMaxEvidence {
  const timestamp = Date.now();
  const title = redactGoalMaxDiagnostic(observation.title).slice(-1_000);
  const summary = redactGoalMaxDiagnostic(observation.summary).slice(-4_000);
  const evidencePath = observation.path ? redactGoalMaxDiagnostic(observation.path).slice(0, 4_096) : undefined;
  const command = observation.command ? redactGoalMaxDiagnostic(observation.command).slice(0, 4_000) : undefined;
  return {
    id: `evidence-${randomUUID()}`,
    kind: observation.kind,
    title,
    summary,
    criterionIds: [],
    source: 'root-tool',
    timestamp,
    current: true,
    ...(evidencePath ? { path: evidencePath } : {}),
    ...(command ? { command } : {}),
    ...(observation.exitCode === undefined ? {} : { exitCode: observation.exitCode }),
    fingerprint: createHash('sha256').update(`${goal.id}\0${observation.kind}\0${title}\0${summary}\0${evidencePath ?? ''}\0${command ?? ''}`).digest('hex'),
  };
}

function workspaceEvidence(goal: GoalMaxState, workspace: WorkspaceSnapshot, now: number): GoalMaxEvidence {
  return {
    id: `evidence-${randomUUID()}`,
    kind: 'git-diff',
    title: workspace.changedFileCount === 0 ? 'Workspace returned to baseline' : `${workspace.changedFileCount} changed ${workspace.changedFileCount === 1 ? 'file' : 'files'}`,
    summary: redactGoalMaxDiagnostic(workspace.paths.slice(0, 80).join('\n')),
    criterionIds: [],
    source: 'workspace',
    timestamp: now,
    current: true,
    fingerprint: workspace.fingerprint,
  };
}

function appendEvidence(evidence: GoalMaxEvidence[], item: GoalMaxEvidence): GoalMaxEvidence[] {
  return [...evidence.filter((candidate) => candidate.id !== item.id), item].slice(-GOALMAX_MAX_EVIDENCE);
}

function supersedeMatchingEvidence(evidence: GoalMaxEvidence[], item: GoalMaxEvidence): GoalMaxEvidence[] {
  if (item.exitCode === undefined) return evidence;
  const operationKey = evidenceOperationKey(item);
  if (!operationKey) return evidence;
  return evidence.map((candidate) => candidate.current && evidenceOperationKey(candidate) === operationKey
    ? { ...candidate, current: false }
    : candidate);
}

function evidenceOperationKey(evidence: GoalMaxEvidence): string | null {
  if (evidence.command) return `${evidence.kind}\0command\0${evidence.command}`;
  if (evidence.path) return `${evidence.kind}\0path\0${evidence.path}`;
  return null;
}

type ReportedTaskItem = { title: string; detail: string; required?: boolean };

function normalizeReportedTaskPlan(
  taskPlan: NonNullable<GoalMaxReportInput['taskPlan']>,
  objective: string,
): Array<{ title: string; detail: string; required: boolean }> {
  if (taskPlan.length < 2 || taskPlan.length >= GOALMAX_MAX_CRITERIA) {
    throw new Error(`The execution task plan must contain 2-${GOALMAX_MAX_CRITERIA - 1} implementation tasks.`);
  }
  const normalized = normalizeReportedTaskItems(taskPlan, objective);
  if (!normalized.some((task) => task.required)) throw new Error('The execution task plan must contain at least one required implementation task.');
  return normalized;
}

function normalizeReportedTaskItems(
  taskPlan: readonly ReportedTaskItem[],
  objective: string,
): Array<{ title: string; detail: string; required: boolean }> {
  const objectiveKey = normalizedPlanText(objective);
  const seenTitles = new Set<string>();
  const seenDetails = new Set<string>();
  return taskPlan.map((task) => {
    const title = task.title.replace(/\s+/gu, ' ').trim();
    const detail = task.detail.replace(/\s+/gu, ' ').trim();
    if (title.length < 4 || title.length > 240) throw new Error('Every planned task title must contain 4-240 characters.');
    if (detail.length < 8 || detail.length > 2_000) throw new Error('Every planned task needs a detailed observable completion condition.');
    const titleKey = normalizedPlanText(title);
    const detailKey = normalizedPlanText(detail);
    const copiesObjective = titleKey === objectiveKey
      || detailKey === objectiveKey
      || (objectiveKey.length >= 40 && detailKey.includes(objectiveKey) && detailKey.length <= objectiveKey.length + 60);
    if (copiesObjective) throw new Error('A planned task cannot copy the full objective. Decompose it into distinct work.');
    if (isTaskPlanPlaceholder(title) || isTaskPlanPlaceholder(detail)) {
      throw new Error(`The planned task "${title}" contains placeholder text. Use a specific action and completion condition.`);
    }
    if (isReservedFinalVerification(title, detail)) {
      throw new Error('Do not add a final verification task. GoalMax appends and owns that criterion.');
    }
    if (seenTitles.has(titleKey) || seenDetails.has(detailKey)) throw new Error(`The planned task "${title}" duplicates another task.`);
    seenTitles.add(titleKey);
    seenDetails.add(detailKey);
    return { title, detail, required: task.required ?? true };
  });
}

function reconcilePendingTaskChanges(
  goal: GoalMaxState,
  changes: NonNullable<GoalMaxReportInput['pendingTaskChanges']>,
  now: number,
): GoalMaxState['criteria'] {
  const removeIds = new Set(changes.removeCriterionIds ?? []);
  for (const id of removeIds) {
    const criterion = goal.criteria.find((candidate) => candidate.id === id);
    if (!criterion) throw new Error(`The pending task change references an unknown criterion: ${id}.`);
    if (isControlPlaneVerificationCriterion(criterion)) throw new Error('The control-plane verification task cannot be removed.');
    if (criterion.status !== 'pending' || criterion.evidenceIds.length > 0 || criterion.ownerNodeIds.length > 0) {
      throw new Error(`Only untouched pending tasks may be removed: ${criterion.title}.`);
    }
  }
  const retained = goal.criteria.filter((criterion) => !removeIds.has(criterion.id));
  const additions = normalizeReportedTaskItems(changes.add ?? [], goal.objective);
  const retainedTitles = new Set(retained.map((criterion) => normalizedPlanText(criterion.title)));
  const retainedDetails = new Set(retained.map((criterion) => normalizedPlanText(criterion.description)).filter(Boolean));
  for (const addition of additions) {
    if (retainedTitles.has(normalizedPlanText(addition.title)) || retainedDetails.has(normalizedPlanText(addition.detail))) {
      throw new Error(`The pending task "${addition.title}" duplicates retained work.`);
    }
  }
  if (retained.length + additions.length > GOALMAX_MAX_CRITERIA) throw new Error('The updated goal would exceed the task limit.');
  const addedCriteria = additions.map((task) => createGoalMaxCriterion({
    title: task.title,
    description: task.detail,
    required: task.required,
    status: 'pending',
  }, now));
  const verificationIndex = retained.findIndex(isControlPlaneVerificationCriterion);
  if (verificationIndex < 0) return [...retained, ...addedCriteria];
  return [...retained.slice(0, verificationIndex), ...addedCriteria, ...retained.slice(verificationIndex)];
}

function normalizedPlanText(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function isTaskPlanPlaceholder(value: string): boolean {
  return /^(?:deliver|complete|do|handle|execute|finish|implement|fix|address|work on)(?: the)? (?:objective|request|task|work|it)$/iu.test(normalizedPlanText(value));
}

function isControlPlaneVerificationCriterion(criterion: GoalMaxState['criteria'][number]): boolean {
  return normalizedPlanText(criterion.title) === normalizedPlanText(GOALMAX_VERIFICATION_TITLE);
}

function isReservedFinalVerification(title: string, detail: string): boolean {
  const titleKey = normalizedPlanText(title);
  const detailKey = normalizedPlanText(detail);
  return /^(?:run |perform |conduct |complete )?(?:the )?(?:final |independent |completion )?(?:checks?|verification|verify(?: (?:the )?(?:result|delivered result|work|objective))?)$/iu.test(titleKey)
    || /\bcompletion gate\b|\b(?:final|independent|completion) (?:checks?|verification|review)\b|\bverify (?:the )?(?:delivered )?(?:result|objective|work)\b/iu.test(detailKey);
}

function normalizeGoalReferences(goal: GoalMaxState): GoalMaxState {
  return reconcileGoalMaxReferences({
    ...goal,
    criteria: goal.criteria.map((criterion) => ({
      ...criterion,
      title: redactGoalMaxDiagnostic(criterion.title).slice(0, 240),
      description: redactGoalMaxDiagnostic(criterion.description).slice(0, 2_000),
    })),
    evidence: goal.evidence.map((item) => ({
      ...item,
      title: redactGoalMaxDiagnostic(item.title).slice(0, 300),
      summary: redactGoalMaxDiagnostic(item.summary).slice(-8_000),
      ...(item.path ? { path: redactGoalMaxDiagnostic(item.path).slice(0, 4_096) } : {}),
      ...(item.command ? { command: redactGoalMaxDiagnostic(item.command).slice(0, 8_000) } : {}),
      ...(item.output ? { output: redactGoalMaxDiagnostic(item.output).slice(-8_000) } : {}),
    })),
    steering: goal.steering.map((item) => ({ ...item, text: redactGoalMaxDiagnostic(item.text).slice(0, GOALMAX_STEERING_TEXT_LIMIT) })),
    childAssignments: goal.childAssignments.map((assignment) => ({
      ...assignment,
      label: redactGoalMaxDiagnostic(assignment.label).slice(0, 160),
      objective: redactGoalMaxDiagnostic(assignment.objective).slice(0, 4_000),
    })),
    blockedReason: goal.blockedReason ? redactGoalMaxDiagnostic(goal.blockedReason).slice(0, 4_000) : null,
    failure: goal.failure ? { ...goal.failure, message: redactGoalMaxDiagnostic(goal.failure.message).slice(0, 4_000) } : null,
    continuation: {
      ...goal.continuation,
      reason: goal.continuation.reason ? redactGoalMaxDiagnostic(goal.continuation.reason).slice(0, 1_000) : null,
    },
    timeline: goal.timeline.map((event) => ({ ...event, summary: redactGoalMaxDiagnostic(event.summary).slice(0, 1_000) })),
  });
}

function invalidateVerificationEvidence(evidence: GoalMaxEvidence[], currentTurnStartedAt?: number): GoalMaxEvidence[] {
  const lastWorkspaceIndex = evidence.findLastIndex((item) => item.current && item.kind === 'git-diff');
  const currentTurnIndex = currentTurnStartedAt === undefined
    ? evidence.length
    : evidence.findIndex((item, index) => index > lastWorkspaceIndex && item.timestamp >= currentTurnStartedAt);
  const evidenceFloor = currentTurnIndex < 0 ? evidence.length : currentTurnIndex;
  let lastObservedArtifactIndex = -1;
  for (let index = evidenceFloor; index < evidence.length; index += 1) {
    const item = evidence[index]!;
    if (item.current && (item.kind === 'file' || item.kind === 'screenshot') && item.exitCode === 0) lastObservedArtifactIndex = index;
  }
  return evidence.map((item, index) => {
    if (item.kind === 'verification') return { ...item, current: false };
    if (item.kind !== 'test' && item.kind !== 'build' && item.kind !== 'lint') return item;
    const ranThisTurn = index >= evidenceFloor;
    const ranAfterObservedArtifact = lastObservedArtifactIndex < 0 || index > lastObservedArtifactIndex;
    return ranThisTurn && ranAfterObservedArtifact ? item : { ...item, current: false };
  });
}

function assignmentFromChild(goal: GoalMaxState, child: GoalMaxRuntimeChild): GoalMaxChildAssignment {
  const previous = goal.childAssignments.find((assignment) => assignment.nodeId === child.nodeId);
  return {
    id: previous?.id ?? `assignment-${randomUUID()}`,
    goalId: goal.id,
    nodeId: child.nodeId,
    ...(child.teamId ? { teamId: child.teamId } : {}),
    label: redactGoalMaxDiagnostic(child.label),
    lane: inferLane(child.objective),
    objective: redactGoalMaxDiagnostic(child.objective),
    criterionIds: previous?.criterionIds.length ? previous.criterionIds : inferChildCriterionIds(goal, child.objective),
    status: child.status,
    requestedModel: child.requestedModel,
    effectiveModel: child.effectiveModel,
    requestedThinking: child.requestedThinking,
    effectiveThinking: child.effectiveThinking,
    permissionLevel: child.permissionLevel,
    evidenceIds: previous?.evidenceIds ?? [],
    startedAt: child.startedAt,
    endedAt: child.endedAt,
  };
}

function inferChildCriterionIds(goal: GoalMaxState, objective: string): string[] {
  const candidates = goal.criteria.filter((criterion) => criterion.required && criterion.status !== 'satisfied' && criterion.status !== 'waived');
  const scored = candidates.map((criterion) => {
    const criterionText = `${criterion.title}\n${criterion.description}`;
    return { id: criterion.id, score: Math.max(goalMaxScopeOverlap(criterionText, objective), goalMaxScopeOverlap(objective, criterionText)) };
  }).sort((left, right) => right.score - left.score);
  const best = scored[0]?.score ?? 0;
  if (best >= 0.035) return scored.filter((item) => item.score >= Math.max(0.035, best * 0.7)).slice(0, 4).map((item) => item.id);
  return candidates.length === 1 ? [candidates[0]!.id] : [];
}

function childEvidenceFingerprint(goalId: string, nodeId: string, observationKey: string): string {
  return createHash('sha256').update(`${goalId}\0${nodeId}\0${observationKey}`).digest('hex');
}

function evidenceFromChildObservation(
  goal: GoalMaxState,
  child: GoalMaxRuntimeChild,
  assignment: GoalMaxChildAssignment,
  observation: GoalMaxRuntimeChildObservation,
  fingerprint: string,
): GoalMaxEvidence {
  return {
    id: `evidence-${randomUUID()}`,
    kind: observation.kind,
    title: redactGoalMaxDiagnostic(observation.title).slice(0, 300),
    summary: redactGoalMaxDiagnostic(observation.summary).slice(-8_000),
    criterionIds: [...assignment.criterionIds],
    source: 'child-tool',
    timestamp: observation.timestamp,
    current: true,
    ...(observation.path ? { path: redactGoalMaxDiagnostic(observation.path).slice(0, 4_096) } : {}),
    ...(observation.command ? { command: redactGoalMaxDiagnostic(observation.command).slice(0, 8_000) } : {}),
    ...(observation.exitCode === undefined ? {} : { exitCode: observation.exitCode }),
    fingerprint,
  };
}

function inferLane(objective: string): GoalMaxChildAssignment['lane'] {
  const value = objective.toLocaleLowerCase();
  if (/\btest|verify|validation\b/u.test(value)) return 'tests';
  if (/\breview|audit\b/u.test(value)) return 'review';
  if (/\bresearch|investigat|explor\b/u.test(value)) return 'research';
  if (/\bdoc|readme\b/u.test(value)) return 'documentation';
  if (/\bimplement|build|edit|write\b/u.test(value)) return 'implementation';
  return 'general';
}

function stableAssignments(assignments: GoalMaxChildAssignment[]): string {
  return JSON.stringify(assignments.map(({ id: _id, ...assignment }) => assignment));
}

function evidenceSupportsCriterion(evidence: GoalMaxEvidence): boolean {
  return evidence.current && evidence.kind !== 'verification' && (evidence.exitCode === undefined || evidence.exitCode === 0);
}

function deterministicVerification(goal: GoalMaxState): { pass: boolean; findings: string[]; needsVerificationCommand: boolean } {
  const findings: string[] = [];
  const currentEvidence = goal.evidence.filter((evidence) => evidence.current);
  const verificationCommands = currentEvidence.filter((evidence) => evidence.kind === 'test' || evidence.kind === 'build' || evidence.kind === 'lint');
  const changed = goal.progress.latestWorkspaceFingerprint !== goal.progress.baselineWorkspaceFingerprint || goal.progress.changedFileCount > 0;
  const needsVerificationCommand = changed && !verificationCommands.some((evidence) => evidence.exitCode === 0);
  if (needsVerificationCommand) findings.push('Run and record a successful current test, build, lint, or typecheck after the latest workspace change.');
  const currentFailure = goal.evidence.findLast((evidence) => evidence.current && evidence.exitCode !== undefined && evidence.exitCode !== 0 && (
    (evidence.kind === 'file' && Boolean(evidence.path))
    || ((evidence.kind === 'test' || evidence.kind === 'build' || evidence.kind === 'lint') && Boolean(evidence.command))
  ));
  if (currentFailure) findings.push(`Resolve the current failed evidence: ${currentFailure.title}.`);
  const required = goal.criteria.filter((criterion) => criterion.required && criterion.status !== 'waived' && !isControlPlaneVerificationCriterion(criterion));
  if (required.length === 0) findings.push('Define at least one required completion criterion.');
  // Gate A: every user-work criterion must carry current non-verifier evidence.
  // The control-plane verification criterion is satisfied only after this
  // deterministic preflight and the independent verifier both pass.
  const supportingIds = new Set(currentEvidence.filter(evidenceSupportsCriterion).map((evidence) => evidence.id));
  for (const criterion of required) {
    if (!criterion.evidenceIds.some((id) => supportingIds.has(id))) findings.push(`Attach current non-verifier evidence to required criterion: ${criterion.title}.`);
  }
  return { pass: findings.length === 0, findings, needsVerificationCommand };
}

function parseVerificationFindings(report: string): string[] {
  return report.split('\n').map((line) => line.replace(/^[-*]\s*/u, '').trim())
    .filter((line) => line && !/^(?:VERDICT|FINDINGS|UNCERTAINTY)\s*:/iu.test(line) && !/^VERDICT\b/iu.test(line))
    .slice(0, 8);
}

function redactGoalMaxDiagnostic(value: string): string {
  const redacted = '<redacted>';
  return value
    .replace(/\[(?:credential )?redacted\]\]*/giu, redacted)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/giu, redacted)
    .replace(/(\b(?:authorization|proxy-authorization)\s*:\s*)(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu, `$1${redacted}`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu, `$1 ${redacted}`)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,})\b/gu, redacted)
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, redacted)
    .replace(/(https?:\/\/[^\s/:@]+:)[^\s/@]+@/giu, `$1${redacted}@`)
    .replace(/^(\s*(?:[A-Z][A-Z0-9]*_)*(?:API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|REFRESH_?TOKEN|CLIENT_?SECRET|PASSWORD|PASSWD|SECRET|CREDENTIALS?)\s+).*$/gimu, `$1${redacted}`)
    .replace(/(--(?:api[-_]?key|access[-_]?token|auth[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|secret|credential)(?:\s+|=))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&\r\n]+)/giu, `$1${redacted}`)
    .replace(/(\b(?:api[-_]?key|access[-_]?token|auth[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|secret|authorization|cookie|set-cookie|x-api-key|credential)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\]\r\n]+)/giu, `$1${redacted}`);
}

function safeSerialized(value: unknown): string {
  try { return JSON.stringify(value).slice(0, 16_000); }
  catch { return String(value).slice(0, 16_000); }
}

function resultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const candidate = value as { content?: unknown; text?: unknown };
    if (typeof candidate.text === 'string') return candidate.text;
    if (Array.isArray(candidate.content)) return candidate.content.flatMap((part) => part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : []).join('\n');
  }
  return safeSerialized(value);
}

function classifyContinuationFailure(error: unknown):
  | { kind: 'defer'; message: string }
  | { kind: 'stop'; status: 'blocked' | 'usage-limited' | 'failed'; code: string; message: string; summary: string } {
  const message = errorMessage(error).slice(0, 4_000) || 'The automatic continuation could not start.';
  const rawCode = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'CONTINUATION_FAILED';
  const code = rawCode.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 100) || 'CONTINUATION_FAILED';
  const fingerprint = `${code} ${message}`.toLocaleLowerCase();
  if (/\bstale\b|idle runtime lease|\brun[_ -]?active\b|queued user/u.test(fingerprint)) return { kind: 'defer', message };
  if (/usage|quota|rate.?limit|credits?|token.?limit|\b429\b/u.test(fingerprint)) {
    return { kind: 'stop', status: 'usage-limited', code, message, summary: 'Provider usage is unavailable; the goal remains persisted.' };
  }
  if (/permission|approval|access.?denied|unauthori[sz]ed|auth.?required|untrusted|sandbox|provider.?unavailable|offline|network|connection/u.test(fingerprint)) {
    return { kind: 'stop', status: 'blocked', code, message, summary: 'Automatic continuation is blocked by the current environment or policy.' };
  }
  return { kind: 'stop', status: 'failed', code, message, summary: 'Automatic continuation could not start.' };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * STRICT GATEWAY: the root agent must work through the captured task plan and
 * keep the goal plane in sync every turn. Implementation work (workspace
 * change or meaningful evidence) before the plan exists, or without any
 * goalmax_status/goalmax_report/goalmax_complete call in the same turn, is a
 * hard contract violation that blocks the goal immediately.
 */
function strictGatewayViolation(goal: GoalMaxState, marker: TurnMarker, workspaceChanged: boolean): string | null {
  // A completion-candidate report is itself a goalmax_report sync; the
  // verification gate owns the goal from that point on.
  if (goal.status === 'verifying') return null;
  const implementationWork = workspaceChanged || marker.meaningful;
  if (!implementationWork) return null;
  if (!hasGoalMaxTaskPlan(goal)) {
    return 'The agent performed implementation work before capturing the execution task plan. The plan gate is mandatory: submit 2-12 concrete tasks via goalmax_report (outcome "progress", phase "planning") before changing the workspace.';
  }
  if (marker.statusCalls === 0 && marker.reportCalls === 0 && marker.completeCalls === 0) {
    return 'The agent changed the workspace without consulting the goal plane this turn. Every working turn must call goalmax_status or goalmax_report so the task list stays the single source of truth.';
  }
  return null;
}
