import type { GoalMaxPhase, GoalMaxState } from '../../../shared/contracts/goalmaxxing';

export type GoalMaxRecovery =
  | { kind: 'continue'; instruction: string }
  | { kind: 'reconcile'; instruction: string }
  | { kind: 'diagnose'; instruction: string }
  | { kind: 'change-strategy'; instruction: string }
  | { kind: 'blocked'; reason: string };

export function decideGoalMaxRecovery(goal: GoalMaxState): GoalMaxRecovery {
  const { noProgressTurnCount, repeatedFailureCount, planningOnlyTurnCount } = goal.progress;
  if (noProgressTurnCount >= 5) {
    return { kind: 'blocked', reason: 'Five consecutive continuations produced no observable progress. Review the blocker or change the approach before resuming.' };
  }
  if (repeatedFailureCount >= 4) {
    return { kind: 'blocked', reason: 'The same failure repeated four times without a successful recovery.' };
  }
  if (noProgressTurnCount === 4) {
    return { kind: 'change-strategy', instruction: 'Change execution strategy now. Return to the last useful evidence, choose a different concrete route, and do not repeat the failed action.' };
  }
  if (noProgressTurnCount === 3 || repeatedFailureCount === 3) {
    return { kind: 'diagnose', instruction: 'Diagnose the exact blocker before retrying. Use read-only inspection or a focused reviewer, then perform a different artefact-producing action.' };
  }
  if (noProgressTurnCount === 2 || planningOnlyTurnCount >= 2) {
    return { kind: 'reconcile', instruction: 'Planning-only output is exhausted. Reconcile current artefacts and perform one concrete implementation or verification action this turn.' };
  }
  if (noProgressTurnCount === 1) {
    return { kind: 'continue', instruction: 'The previous turn produced no observable delta. Perform the smallest concrete action that advances an unsatisfied criterion.' };
  }
  return { kind: 'continue', instruction: 'Perform the highest-value concrete action that advances an unsatisfied criterion.' };
}

export function goalMaxScopeOverlap(objective: string, text: string): number {
  const objectiveTerms = terms(objective);
  if (objectiveTerms.size === 0) return 1;
  const textTerms = terms(text);
  let matched = 0;
  for (const term of objectiveTerms) if (textTerms.has(term)) matched += 1;
  return matched / objectiveTerms.size;
}

export function goalMaxResearchProgress(goal: GoalMaxState, text: string, novelInvestigation: boolean): boolean {
  const compact = text.replace(/\s+/gu, ' ').trim();
  if (!novelInvestigation || compact.length < 80 || terms(compact).size < 6) return false;
  const scope = [
    goal.objective,
    ...goal.criteria.filter((criterion) => criterion.status !== 'satisfied' && criterion.status !== 'waived')
      .flatMap((criterion) => [criterion.title, criterion.description]),
    ...goal.steering.slice(-8).map((item) => item.text),
  ].filter(Boolean).join('\n');
  return goalMaxScopeOverlap(scope, compact) >= 0.035;
}

export function goalMaxRecoveryPhase(phase: GoalMaxPhase): GoalMaxPhase {
  if (phase === 'intake' || phase === 'planning' || phase === 'research') return 'implementation';
  if (phase === 'implementation') return 'validation';
  if (phase === 'validation' || phase === 'verification') return 'implementation';
  return phase;
}

function terms(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/gu)?.filter((term) => !stopWords.has(term)) ?? []);
}

const stopWords = new Set(['this', 'that', 'with', 'from', 'have', 'will', 'into', 'your', 'then', 'when', 'where', 'which', 'should', 'could', 'would', 'about', 'without', 'implementation']);
