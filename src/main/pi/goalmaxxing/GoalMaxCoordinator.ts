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
import { createGoalMaxTools, type GoalMaxReportInput } from './GoalMaxTools';
import { GoalMaxProgressEngine, classifyGoalMaxTool, type ToolObservation, type WorkspaceSnapshot } from './GoalMaxProgressEngine';
import { goalMaxCapsule, goalMaxDiagnosticPrompt, goalMaxVerificationPrompt } from './GoalMaxPrompt';
import { InMemoryGoalMaxRepository, type GoalMaxPersistence } from './GoalMaxRepository';
import { GoalMaxScheduler } from './GoalMaxScheduler';
import { decideGoalMaxRecovery, goalMaxRecoveryPhase, goalMaxResearchProgress, goalMaxScopeOverlap } from './GoalMaxStallDetector';
import {
  appendGoalMaxTimeline,
  canTransitionGoalMax,
  createGoalMaxCriterion,
  isGoalMaxTerminal,
  normalizeGoalMaxBrief,
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
type TurnMarker = { toolCount: number; meaningful: boolean; novelInvestigation: boolean; latestAssistantText: string; startedAt: number };
class GoalMaxOperationSuperseded extends Error {}

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
  private readonly scheduler = new GoalMaxScheduler();

  constructor(
    private readonly host: GoalMaxCoordinatorHost,
    private readonly repository: GoalMaxPersistence = new InMemoryGoalMaxRepository(),
    private readonly progressEngine = new GoalMaxProgressEngine(),
  ) {}

  createTools(): ToolDefinition[] {
    return createGoalMaxTools(this);
  }

  async bind(projectPath: string, sessionId: string): Promise<GoalMaxState | null> {
    const key = goalKey(projectPath, sessionId);
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
    return goal ? structuredClone(goal) : null;
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
      this.schedule(this.requireState(runtime.sessionId), 'user-resume');
    } else if (input.action === 'checkpoint') {
      await this.checkpoint(runtime.sessionId, 'User requested checkpoint.');
    } else {
      await this.requestVerification(runtime.sessionId, 'User requested verification.');
    }
    return structuredClone(this.requireState(runtime.sessionId));
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
    const updated = this.requireState(runtime.sessionId);
    if (runtime.streaming) await this.host.steerGoal(runtime.sessionId, goalMaxCapsule(updated), updated.id, updated.revision).catch(() => undefined);
    else if (updated.status === 'active') this.schedule(updated, 'goal-edit');
    return structuredClone(updated);
  }

  async recordSteering(sessionId: string, textValue: string, behavior: GoalMaxSteering['behavior']): Promise<GoalMaxState | null> {
    const existing = this.stateForSession(sessionId);
    const text = textValue.trim().slice(0, GOALMAX_STEERING_TEXT_LIMIT);
    if (!existing || !text || isGoalMaxTerminal(existing.status)) return existing ? structuredClone(existing) : null;
    await this.mutate(sessionId, (current, now) => {
      const reactivated = current.status === 'blocked' || current.status === 'failed';
      const active = reactivated ? transitionGoalMax(current, 'active', now) : current;
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
        steering: [...current.steering, steering].slice(-GOALMAX_MAX_STEERING),
        evidence: current.evidence.map((evidence) => evidence.kind === 'verification' ? { ...evidence, current: false } : evidence),
        blockedReason: reactivated ? null : current.blockedReason,
        failure: reactivated ? null : current.failure,
        updatedAt: now,
      }, 'steering.recorded', 'User steering persisted for subsequent goal turns.', now);
    });
    return structuredClone(this.requireState(sessionId));
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
    await this.repository.deleteSession(projectPath, sessionId);
  }

  hasRunnableGoal(sessionId: string): boolean {
    const goal = this.stateForSession(sessionId);
    return Boolean(goal && activeGoalStatuses.has(goal.status));
  }

  async statusForModel(sessionId: string): Promise<{ text: string; details: GoalMaxState }> {
    await this.flushObservations(sessionId);
    const goal = this.requireState(sessionId);
    return { text: goalMaxCapsule(goal), details: structuredClone(goal) };
  }

  async report(sessionId: string, input: GoalMaxReportInput): Promise<{ text: string; details: GoalMaxState }> {
    await this.flushObservations(sessionId);
    const goal = this.requireState(sessionId);
    if (isGoalMaxTerminal(goal.status)) throw new Error('The current goal is already terminal.');
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
      this.turnMarkers.set(sessionId, { toolCount: 0, meaningful: false, novelInvestigation: false, latestAssistantText: '', startedAt: Date.now() });
      void this.mutate(sessionId, (current, now) => ({ ...current, revision: current.revision + 1, executionState: 'running-root', continuation: { ...current.continuation, pending: false }, updatedAt: now }), false).catch(() => undefined);
      return;
    }
    if (event.type === 'tool_execution_start') {
      const map = this.toolStarts.get(sessionId) ?? new Map<string, { name: string; input: string }>();
      map.set(event.toolCallId, { name: event.toolName, input: safeSerialized(event.args) });
      while (map.size > MAX_TRACKED_TOOL_STARTS) map.delete(map.keys().next().value!);
      this.toolStarts.set(sessionId, map);
      const marker = this.turnMarkers.get(sessionId);
      if (marker && event.toolName !== 'goalmax_status' && event.toolName !== 'goalmax_report') marker.toolCount += 1;
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
      void this.onRootSettled(sessionId).catch(() => undefined);
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
    const previewAssignments = relevantChildren.slice(0, GOALMAX_MAX_ASSIGNMENTS).map((child) => assignmentFromChild(goal, child));
    const incomingFingerprints = relevantChildren.flatMap((child) => child.observations.map((observation) => childEvidenceFingerprint(goal.id, child.nodeId, observation.key)));
    const retainedFingerprints = new Set(goal.evidence.flatMap((item) => item.fingerprint ? [item.fingerprint] : []));
    if (stableAssignments(goal.childAssignments) === stableAssignments(previewAssignments)
      && incomingFingerprints.every((fingerprint) => retainedFingerprints.has(fingerprint))) return;

    void this.mutate(sessionId, (current, now) => {
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
    this.scheduler.dispose();
    this.states.clear();
    this.sessionKeys.clear();
    this.toolStarts.clear();
    this.turnMarkers.clear();
  }

  private async onRootSettled(sessionId: string): Promise<void> {
    await this.flushObservations(sessionId);
    const marker = this.turnMarkers.get(sessionId) ?? { toolCount: 0, meaningful: false, novelInvestigation: false, latestAssistantText: '', startedAt: Date.now() };
    this.turnMarkers.delete(sessionId);
    await this.serialize(sessionId, async () => {
      const goal = this.requireState(sessionId);
      if (isGoalMaxTerminal(goal.status)) return;
      const runtime = this.host.runtime(sessionId);
      const workspace = await this.progressEngine.capture(goal.projectPath);
      const now = Date.now();
      const workspaceChanged = workspace.fingerprint !== goal.progress.latestWorkspaceFingerprint;
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

  private async checkpoint(sessionId: string, summary: string): Promise<void> {
    await this.flushObservations(sessionId);
    await this.serialize(sessionId, async () => {
      const goal = this.requireState(sessionId);
      const workspace = await this.progressEngine.capture(goal.projectPath);
      const runtime = this.host.runtime(sessionId);
      const now = Date.now();
      let evidence = goal.evidence;
      if (workspace.fingerprint !== goal.progress.latestWorkspaceFingerprint) evidence = appendEvidence(invalidateVerificationEvidence(evidence), workspaceEvidence(goal, workspace, now));
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

  private async requestVerification(sessionId: string, summary: string): Promise<void> {
    await this.flushObservations(sessionId);
    await this.mutate(sessionId, (goal, now) => {
      const base = goal.status === 'active' ? goal : { ...goal, status: 'active' as const };
      const verifying = transitionGoalMax(base, 'verifying', now);
      return appendGoalMaxTimeline({ ...verifying, revision: goal.revision + 1, phase: 'verification', blockedReason: null }, 'verification.started', summary, now);
    });
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
        title: reportPass ? 'Independent completion gate passed' : 'Completion gate failed',
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
        const criteria = current.criteria.map((criterion) => criterion.required && criterion.status !== 'waived'
          ? { ...criterion, status: 'satisfied' as const, evidenceIds: [...new Set([...criterion.evidenceIds, verifierEvidence.id])].slice(-64), updatedAt: now }
          : criterion);
        const completed = transitionGoalMax({ ...current, ...accounting, evidence, criteria }, 'completed', now);
        return appendGoalMaxTimeline({ ...completed, revision: current.revision + 1, phase: 'handoff', executionState: 'idle' }, 'verification.passed', 'All required criteria passed the completion gate.', now);
      }
      if (verifierFailure) {
        const blocked = transitionGoalMax({ ...current, ...accounting, evidence }, 'blocked', now);
        return appendGoalMaxTimeline({
          ...blocked,
          revision: current.revision + 1,
          phase: 'verification',
          executionState: 'idle',
          blockedReason: verifierFailure,
        }, 'goal.blocked', verifierFailure, now);
      }
      const findings = [...deterministic.findings, ...parseVerificationFindings(report)].filter(Boolean).slice(0, 8);
      const existingTitles = new Set(current.criteria.map((criterion) => criterion.title.toLocaleLowerCase()));
      const added = findings.flatMap((finding) => {
        const title = finding.slice(0, 240);
        if (existingTitles.has(title.toLocaleLowerCase())) return [];
        existingTitles.add(title.toLocaleLowerCase());
        return [createGoalMaxCriterion({ title, description: finding.slice(0, 2_000), required: true, status: 'failed', evidenceIds: [verifierEvidence.id] }, now)];
      });
      const nextCriteria = [...current.criteria, ...added].slice(0, GOALMAX_MAX_CRITERIA);
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
  }

  private requireSelectedRuntime(): GoalMaxRuntimeSnapshot {
    // UI control calls always target the currently selected runtime. Iterating bound
    // background sessions here can mutate the wrong session after a tab switch.
    const selected = this.host.runtime('');
    if (!selected) throw new Error('Open and trust a project before using GoalMax.');
    return selected;
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
  ): Promise<void> {
    return this.serialize(sessionId, async () => {
      const current = this.requireState(sessionId);
      const next = goalMaxStateSchema.parse(normalizeGoalReferences(operation(structuredClone(current), Date.now())));
      if (next.id !== current.id || next.sessionId !== current.sessionId || next.projectPath !== current.projectPath || next.revision !== current.revision + 1) {
        throw new Error('GoalMax mutations must preserve identity and increment one revision.');
      }
      await this.commit(next, current.revision, emitSnapshot, additionalEvents);
    });
  }

  private async commit(next: GoalMaxState, expectedRevision: number, emitSnapshot = true, additionalEvents: GoalMaxEvent[] = []): Promise<void> {
    const parsed = goalMaxStateSchema.parse(normalizeGoalReferences(next));
    const previous = this.states.get(goalKey(parsed.projectPath, parsed.sessionId));
    await this.repository.save(parsed, expectedRevision);
    this.states.set(goalKey(parsed.projectPath, parsed.sessionId), parsed);
    this.sessionKeys.set(parsed.sessionId, goalKey(parsed.projectPath, parsed.sessionId));
    this.host.persistSessionEvent(parsed.sessionId, parsed);
    if (emitSnapshot) this.host.emit(snapshotEvent(parsed));
    else {
      if (!previous || previous.status !== parsed.status || previous.executionState !== parsed.executionState || previous.blockedReason !== parsed.blockedReason) this.host.emit(statusEvent(parsed));
      if (!previous || previous.phase !== parsed.phase) this.host.emit(phaseEvent(parsed));
      if (!previous || previous.tokensUsed !== parsed.tokensUsed || previous.elapsedMs !== parsed.elapsedMs) this.host.emit(usageEvent(parsed));
    }
    for (const event of additionalEvents) this.host.emit({ ...event, revision: parsed.revision } as GoalMaxEvent);
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

function normalizeGoalReferences(goal: GoalMaxState): GoalMaxState {
  const criteria = goal.criteria.slice(0, GOALMAX_MAX_CRITERIA).map((criterion) => ({
    ...criterion,
    title: redactGoalMaxDiagnostic(criterion.title).slice(0, 240),
    description: redactGoalMaxDiagnostic(criterion.description).slice(0, 2_000),
  }));
  const criterionIds = new Set(criteria.map((criterion) => criterion.id));
  const evidence = goal.evidence.slice(-GOALMAX_MAX_EVIDENCE).map((item) => ({
    ...item,
    title: redactGoalMaxDiagnostic(item.title).slice(0, 300),
    summary: redactGoalMaxDiagnostic(item.summary).slice(-8_000),
    ...(item.path ? { path: redactGoalMaxDiagnostic(item.path).slice(0, 4_096) } : {}),
    ...(item.command ? { command: redactGoalMaxDiagnostic(item.command).slice(0, 8_000) } : {}),
    ...(item.output ? { output: redactGoalMaxDiagnostic(item.output).slice(-8_000) } : {}),
    criterionIds: item.criterionIds.filter((id) => criterionIds.has(id)),
  }));
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const childAssignments = goal.childAssignments.slice(0, GOALMAX_MAX_ASSIGNMENTS).map((assignment) => ({
    ...assignment,
    label: redactGoalMaxDiagnostic(assignment.label).slice(0, 160),
    objective: redactGoalMaxDiagnostic(assignment.objective).slice(0, 4_000),
    criterionIds: assignment.criterionIds.filter((id) => criterionIds.has(id)),
    evidenceIds: assignment.evidenceIds.filter((id) => evidenceIds.has(id)),
  }));
  const ownerNodeIds = new Set(childAssignments.map((assignment) => assignment.nodeId));
  const normalizedCriteria = criteria.map((criterion) => {
    const retainedEvidence = criterion.evidenceIds.filter((id) => evidenceIds.has(id));
    return {
      ...criterion,
      evidenceIds: retainedEvidence,
      ownerNodeIds: criterion.ownerNodeIds.filter((id) => ownerNodeIds.has(id)),
      status: criterion.status === 'satisfied' && retainedEvidence.length === 0 ? 'active' as const : criterion.status,
    };
  });
  const criterionLinks = new Map<string, string[]>();
  for (const criterion of normalizedCriteria) for (const evidenceId of criterion.evidenceIds) criterionLinks.set(evidenceId, [...(criterionLinks.get(evidenceId) ?? []), criterion.id]);
  const normalizedEvidence = evidence.map((item) => criterionLinks.has(item.id)
    ? { ...item, criterionIds: [...new Set([...item.criterionIds, ...criterionLinks.get(item.id)!])].slice(0, GOALMAX_MAX_CRITERIA) }
    : item);
  return {
    ...goal,
    criteria: normalizedCriteria,
    evidence: normalizedEvidence,
    steering: goal.steering.slice(-GOALMAX_MAX_STEERING).map((item) => ({ ...item, text: redactGoalMaxDiagnostic(item.text).slice(0, GOALMAX_STEERING_TEXT_LIMIT) })),
    childAssignments,
    blockedReason: goal.blockedReason ? redactGoalMaxDiagnostic(goal.blockedReason).slice(0, 4_000) : null,
    failure: goal.failure ? { ...goal.failure, message: redactGoalMaxDiagnostic(goal.failure.message).slice(0, 4_000) } : null,
    continuation: {
      ...goal.continuation,
      reason: goal.continuation.reason ? redactGoalMaxDiagnostic(goal.continuation.reason).slice(0, 1_000) : null,
    },
    timeline: goal.timeline.map((event) => ({ ...event, summary: redactGoalMaxDiagnostic(event.summary).slice(0, 1_000) })), 
  };
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
  const required = goal.criteria.filter((criterion) => criterion.required && criterion.status !== 'waived');
  if (required.length === 0) findings.push('Define at least one required completion criterion.');
  if (goal.verificationLevel === 'strict') {
    const supportingIds = new Set(currentEvidence.filter(evidenceSupportsCriterion).map((evidence) => evidence.id));
    for (const criterion of required) {
      if (!criterion.evidenceIds.some((id) => supportingIds.has(id))) findings.push(`Attach current non-verifier evidence to required criterion: ${criterion.title}.`);
    }
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
