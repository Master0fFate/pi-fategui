import { randomUUID } from 'node:crypto';
import {
  GOALMAX_MAX_ASSIGNMENTS,
  GOALMAX_MAX_CRITERIA,
  GOALMAX_MAX_EVIDENCE,
  GOALMAX_MAX_STEERING,
  GOALMAX_MAX_TIMELINE_EVENTS,
  GOALMAX_OBJECTIVE_LIMIT,
  goalMaxStateSchema,
  type GoalMaxCriterion,
  type GoalMaxEvidence,
  type GoalMaxState,
  type GoalMaxStatus,
  type GoalMaxTimelineEvent,
} from '../../../shared/contracts/goalmaxxing';

export const GOALMAX_PLAN_PLACEHOLDER_TITLE = 'Plan the execution';
export const GOALMAX_VERIFICATION_TITLE = 'Verify the delivered result';
export const GOALMAX_TASK_PLAN_TIMELINE_PREFIX = 'Execution task plan captured:';

const terminalStatuses = new Set<GoalMaxStatus>(['completed', 'cancelled']);
const transitions: Record<GoalMaxStatus, ReadonlySet<GoalMaxStatus>> = {
  normalising: new Set(['active', 'failed', 'cancelled']),
  active: new Set(['paused', 'blocked', 'verifying', 'cancelled', 'budget-limited', 'usage-limited', 'failed']),
  paused: new Set(['active', 'cancelled']),
  blocked: new Set(['active', 'paused', 'cancelled', 'failed']),
  verifying: new Set(['active', 'paused', 'blocked', 'completed', 'cancelled', 'failed']),
  completed: new Set(),
  cancelled: new Set(),
  'budget-limited': new Set(['active', 'paused', 'cancelled']),
  'usage-limited': new Set(['active', 'paused', 'cancelled']),
  failed: new Set(['active', 'paused', 'cancelled']),
};

export function isGoalMaxTerminal(status: GoalMaxStatus): boolean {
  return terminalStatuses.has(status);
}

export function hasGoalMaxTaskPlan(goal: Pick<GoalMaxState, 'taskPlanCaptured' | 'timeline'>): boolean {
  return goal.taskPlanCaptured === true || goal.timeline.some((event) => event.summary.startsWith(GOALMAX_TASK_PLAN_TIMELINE_PREFIX));
}

export function canTransitionGoalMax(from: GoalMaxStatus, to: GoalMaxStatus): boolean {
  return from === to || transitions[from].has(to);
}

/** Evidence that independently supports a criterion: current and not produced by the verifier itself. */
export function isGoalMaxCriterionEvidence(evidence: GoalMaxEvidence): boolean {
  return evidence.current && evidence.source !== 'verifier';
}

export function reconcileGoalMaxReferences(goal: GoalMaxState): GoalMaxState {
  const criteria = goal.criteria.slice(0, GOALMAX_MAX_CRITERIA);
  const criterionIds = new Set(criteria.map((criterion) => criterion.id));
  const evidence = goal.evidence.slice(-GOALMAX_MAX_EVIDENCE).map((item) => ({
    ...item,
    criterionIds: item.criterionIds.filter((id) => criterionIds.has(id)),
  }));
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const childAssignments = goal.childAssignments.slice(0, GOALMAX_MAX_ASSIGNMENTS).map((assignment) => ({
    ...assignment,
    criterionIds: assignment.criterionIds.filter((id) => criterionIds.has(id)),
    evidenceIds: assignment.evidenceIds.filter((id) => evidenceIds.has(id)),
  }));
  const ownerNodeIds = new Set(childAssignments.map((assignment) => assignment.nodeId));
  const normalizedCriteria = criteria.map((criterion) => {
    const retainedEvidenceIds = criterion.evidenceIds.filter((id) => evidenceIds.has(id));
    return {
      ...criterion,
      evidenceIds: retainedEvidenceIds,
      ownerNodeIds: criterion.ownerNodeIds.filter((id) => ownerNodeIds.has(id)),
      status: criterion.status === 'satisfied' && retainedEvidenceIds.length === 0 ? 'active' as const : criterion.status,
    };
  });
  const criterionLinks = new Map<string, string[]>();
  for (const criterion of normalizedCriteria) {
    for (const evidenceId of criterion.evidenceIds) {
      criterionLinks.set(evidenceId, [...(criterionLinks.get(evidenceId) ?? []), criterion.id]);
    }
  }
  const normalizedEvidence = evidence.map((item) => criterionLinks.has(item.id)
    ? { ...item, criterionIds: [...new Set([...item.criterionIds, ...criterionLinks.get(item.id)!])].slice(0, GOALMAX_MAX_CRITERIA) }
    : item);
  return {
    ...goal,
    criteria: normalizedCriteria,
    evidence: normalizedEvidence,
    childAssignments,
    steering: goal.steering.slice(-GOALMAX_MAX_STEERING),
    timeline: goal.timeline.slice(-GOALMAX_MAX_TIMELINE_EVENTS),
  };
}

export function transitionGoalMax(goal: GoalMaxState, status: GoalMaxStatus, now = Date.now()): GoalMaxState {
  const reconciled = reconcileGoalMaxReferences(goal);
  if (!canTransitionGoalMax(reconciled.status, status)) throw new Error(`GoalMax cannot transition from ${reconciled.status} to ${status}.`);
  // Gate A (strict, verification-level-independent): a required criterion may
  // only be satisfied, and a goal may only complete, with current NON-VERIFIER
  // evidence. A verifier pass alone can never satisfy a required criterion.
  const currentEvidenceIds = status === 'completed' ? new Set(reconciled.evidence.filter(isGoalMaxCriterionEvidence).map((evidence) => evidence.id)) : null;
  if (currentEvidenceIds && reconciled.criteria.some((criterion) => criterion.required && criterion.status !== 'waived' && (
    criterion.status !== 'satisfied' || !criterion.evidenceIds.some((id) => currentEvidenceIds.has(id))
  ))) throw new Error('GoalMax cannot complete while a required criterion lacks current non-verifier evidence.');
  return goalMaxStateSchema.parse({
    ...reconciled,
    status,
    executionState: status === 'active' ? reconciled.executionState : status === 'verifying' ? 'waiting' : 'idle',
    blockedReason: status === 'blocked' ? reconciled.blockedReason : null,
    completedAt: status === 'completed' ? now : reconciled.completedAt,
    updatedAt: now,
  });
}

export function normalizeGoalMaxBrief(brief: string): { objective: string; criteria: Array<Pick<GoalMaxCriterion, 'title' | 'description' | 'required'>>; preserveBrief: boolean } {
  const normalized = brief.replace(/\r\n?/gu, '\n').trim();
  if (!normalized) throw new Error('A GoalMax objective is required.');
  const compact = normalized.replace(/[ \t]+/gu, ' ').replace(/\n{3,}/gu, '\n\n');
  const objective = compact.length <= GOALMAX_OBJECTIVE_LIMIT
    ? compact
    : conciseObjective(compact);
  const candidates = compact.split('\n').flatMap((line) => {
    const match = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/u.exec(line);
    if (!match) return [];
    const value = match[1]!.replace(/\s+/gu, ' ').trim();
    return value.length >= 4 ? [value] : [];
  });
  const unique = [...new Set(candidates.map((value) => value.slice(0, 2_000)))].slice(0, Math.max(0, GOALMAX_MAX_CRITERIA - 1));
  const criteria = unique.length > 0
    ? unique.map((description) => ({ title: criterionTitle(description), description, required: true }))
    : [{
        title: GOALMAX_PLAN_PLACEHOLDER_TITLE,
        description: 'Decompose the objective into concrete, ordered tasks with observable completion conditions before implementation.',
        required: true,
      }];
  criteria.push({
    title: GOALMAX_VERIFICATION_TITLE,
    description: 'Current observable evidence must satisfy the atomic completion gate.',
    required: true,
  });
  return { objective, criteria: criteria.slice(0, GOALMAX_MAX_CRITERIA), preserveBrief: compact !== objective };
}

function conciseObjective(brief: string): string {
  const firstHeading = brief.split('\n').find((line) => /^#{1,3}\s+\S/u.test(line))?.replace(/^#{1,3}\s+/u, '').trim();
  const firstParagraph = brief.split(/\n\s*\n/u).map((part) => part.replace(/^#{1,6}\s+/u, '').trim()).find(Boolean) ?? brief;
  const lead = firstHeading && !firstParagraph.startsWith(firstHeading) ? `${firstHeading}: ${firstParagraph}` : firstParagraph;
  const clipped = lead.slice(0, GOALMAX_OBJECTIVE_LIMIT - 1).trimEnd();
  return `${clipped}…`;
}

function criterionTitle(description: string): string {
  const sentence = description.split(/(?<=[.!?])\s/u)[0] ?? description;
  if (sentence.length <= 120) return sentence.replace(/[.:;!?]+$/u, '');
  const clipped = sentence.slice(0, 117);
  const boundary = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, boundary > 70 ? boundary : clipped.length).trimEnd()}…`;
}

export function createGoalMaxCriterion(
  input: Pick<GoalMaxCriterion, 'title' | 'description' | 'required'> & Partial<Pick<GoalMaxCriterion, 'id' | 'status' | 'evidenceIds' | 'ownerNodeIds'>>,
  now = Date.now(),
): GoalMaxCriterion {
  return {
    id: input.id ?? `criterion-${randomUUID()}`,
    title: input.title.trim(),
    description: input.description.trim(),
    required: input.required,
    status: input.status ?? 'pending',
    evidenceIds: [...new Set(input.evidenceIds ?? [])].slice(0, 64),
    ownerNodeIds: [...new Set(input.ownerNodeIds ?? [])].slice(0, 64),
    updatedAt: now,
  };
}

export function appendGoalMaxTimeline(
  goal: GoalMaxState,
  type: GoalMaxTimelineEvent['type'],
  summary: string,
  now = Date.now(),
): GoalMaxState {
  const event: GoalMaxTimelineEvent = {
    id: `goal-event-${randomUUID()}`,
    type,
    summary: summary.trim().slice(0, 1_000),
    timestamp: now,
    revision: goal.revision,
  };
  return { ...goal, timeline: [...goal.timeline, event].slice(-GOALMAX_MAX_TIMELINE_EVENTS), updatedAt: now };
}
