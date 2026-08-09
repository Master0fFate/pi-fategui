import { goalMaxStateSchema, type GoalMaxState } from '../../../shared/contracts/goalmaxxing';
import { GOALMAX_PLAN_PLACEHOLDER_TITLE, GOALMAX_TASK_PLAN_TIMELINE_PREFIX, GOALMAX_VERIFICATION_TITLE } from './GoalMaxStateMachine';

/** Upgrade and validate the authoritative snapshot without replaying conversation history. */
export function migrateGoalMaxSnapshot(value: unknown): GoalMaxState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GoalMax snapshot is not an object.');
  const version = (value as { schemaVersion?: unknown }).schemaVersion;
  if (version === 2) return goalMaxStateSchema.parse(backfillTaskPlanCaptured(value));
  if (version !== 1) throw new Error(`Unsupported GoalMax snapshot version ${String(version)}.`);

  const legacy = structuredClone(value) as Record<string, unknown>;
  const criteria = Array.isArray(legacy.criteria) ? legacy.criteria as Array<Record<string, unknown>> : [];
  const evidence = Array.isArray(legacy.evidence) ? legacy.evidence as Array<Record<string, unknown>> : [];
  const evidenceById = new Map(evidence.flatMap((item) => typeof item.id === 'string' ? [[item.id, item] as const] : []));
  for (const criterion of criteria) {
    if (typeof criterion.id !== 'string' || !Array.isArray(criterion.evidenceIds)) continue;
    for (const evidenceId of criterion.evidenceIds) {
      if (typeof evidenceId !== 'string') continue;
      const item = evidenceById.get(evidenceId);
      if (!item) continue;
      const linked = Array.isArray(item.criterionIds) ? item.criterionIds.filter((id): id is string => typeof id === 'string') : [];
      item.criterionIds = [...new Set([...linked, criterion.id])];
    }
  }
  return goalMaxStateSchema.parse(backfillTaskPlanCaptured({ ...legacy, schemaVersion: 2, steering: [] }));
}

/**
 * Version-2 snapshots written before the durable taskPlanCaptured flag rely on
 * the bounded timeline for plan detection. If the plan event was evicted, infer
 * the flag from the durable criteria structure: a captured plan replaces the
 * intake placeholder and adds the control-plane verification criterion.
 */
function backfillTaskPlanCaptured(value: object): object {
  const record = value as Record<string, unknown>;
  if (record.taskPlanCaptured === true) return value;
  const timeline = Array.isArray(record.timeline) ? record.timeline as Array<Record<string, unknown>> : [];
  const hasPlanEvent = timeline.some((event) => typeof event.summary === 'string' && event.summary.startsWith(GOALMAX_TASK_PLAN_TIMELINE_PREFIX));
  if (hasPlanEvent) return { ...record, taskPlanCaptured: true };
  // The intake placeholder criterion persists until the model replaces it with
  // the real task plan. If it is absent and a verification criterion exists, the
  // plan was captured but the durable flag and timeline event were lost.
  const criteria = Array.isArray(record.criteria) ? record.criteria as Array<Record<string, unknown>> : [];
  const hasPlaceholder = criteria.some((criterion) => typeof criterion.title === 'string' && criterion.title.trim().toLocaleLowerCase() === GOALMAX_PLAN_PLACEHOLDER_TITLE.trim().toLocaleLowerCase());
  const hasVerificationCriterion = criteria.some((criterion) => typeof criterion.title === 'string' && criterion.title.trim().toLocaleLowerCase() === GOALMAX_VERIFICATION_TITLE.trim().toLocaleLowerCase());
  if (!hasPlaceholder && hasVerificationCriterion) return { ...record, taskPlanCaptured: true };
  return value;
}
