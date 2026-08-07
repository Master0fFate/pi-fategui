import { goalMaxStateSchema, type GoalMaxState } from '../../../shared/contracts/goalmaxxing';

/** Upgrade and validate the authoritative snapshot without replaying conversation history. */
export function migrateGoalMaxSnapshot(value: unknown): GoalMaxState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GoalMax snapshot is not an object.');
  const version = (value as { schemaVersion?: unknown }).schemaVersion;
  if (version === 2) return goalMaxStateSchema.parse(value);
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
  return goalMaxStateSchema.parse({ ...legacy, schemaVersion: 2, steering: [] });
}
