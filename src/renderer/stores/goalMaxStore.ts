import { create } from 'zustand';
import { GOALMAX_MAX_ASSIGNMENTS, GOALMAX_MAX_EVIDENCE, goalMaxStateSchema, type GoalMaxEvent, type GoalMaxState } from '../../shared/contracts/goalmaxxing';

function evidenceOperationKey(evidence: GoalMaxState['evidence'][number]): string | null {
  if (evidence.command) return `${evidence.kind}\0command\0${evidence.command}`;
  if (evidence.path) return `${evidence.kind}\0path\0${evidence.path}`;
  return null;
}

interface GoalMaxStore {
  projectPath: string | null;
  sessionId: string | null;
  goal: GoalMaxState | null;
  loading: boolean;
  selectionGeneration: number;
  selectSession: (projectPath: string | null, sessionId: string | null) => number;
  hydrate: (generation: number, goal: GoalMaxState | null) => boolean;
  setGoal: (goal: GoalMaxState | null) => void;
  applyEvents: (events: readonly GoalMaxEvent[]) => void;
}

export const useGoalMaxStore = create<GoalMaxStore>((set) => ({
  projectPath: null,
  sessionId: null,
  goal: null,
  loading: false,
  selectionGeneration: 0,
  selectSession: (projectPath, sessionId) => {
    let generation = 0;
    set((state) => {
      generation = state.selectionGeneration + 1;
      return { projectPath, sessionId, goal: null, loading: Boolean(projectPath && sessionId), selectionGeneration: generation };
    });
    return generation;
  },
  hydrate: (generation, goal) => {
    let applied = false;
    set((state) => {
      if (generation !== state.selectionGeneration) return state;
      if (goal && (goal.projectPath !== state.projectPath || goal.sessionId !== state.sessionId)) return state;
      applied = true;
      const parsed = goal ? goalMaxStateSchema.parse(goal) : null;
      if (!parsed && state.goal) return { loading: false };
      if (parsed && state.goal?.id === parsed.id && state.goal.revision > parsed.revision) return { loading: false };
      return { goal: parsed, loading: false };
    });
    return applied;
  },
  setGoal: (goal) => set((state) => {
    if (goal && (goal.projectPath !== state.projectPath || goal.sessionId !== state.sessionId)) return state;
    const parsed = goal ? goalMaxStateSchema.parse(goal) : null;
    if (parsed && state.goal?.id === parsed.id && state.goal.revision > parsed.revision) return state;
    return { goal: parsed, loading: false };
  }),
  applyEvents: (events) => set((state) => {
    let goal = state.goal;
    for (const event of events) {
      if (event.projectPath !== state.projectPath || event.sessionId !== state.sessionId) continue;
      if (event.type === 'goalmax.snapshot') {
        if (!goal || event.goal.id !== goal.id || event.goal.revision >= goal.revision) goal = event.goal;
        continue;
      }
      if (event.type === 'goalmax.cleared') {
        if (goal?.id === event.goalId) goal = null;
        continue;
      }
      if (!goal || goal.id !== event.goalId || event.revision < goal.revision) continue;
      if (event.type === 'goalmax.status') {
        goal = { ...goal, revision: event.revision, status: event.status, executionState: event.executionState, blockedReason: event.blockedReason, updatedAt: event.timestamp };
      } else if (event.type === 'goalmax.phase') {
        goal = { ...goal, revision: event.revision, phase: event.phase, updatedAt: event.timestamp };
      } else if (event.type === 'goalmax.criterion') {
        const index = goal.criteria.findIndex((criterion) => criterion.id === event.criterion.id);
        const criteria = [...goal.criteria];
        if (index >= 0) criteria[index] = event.criterion;
        else criteria.push(event.criterion);
        goal = { ...goal, revision: event.revision, criteria, updatedAt: event.timestamp };
      } else if (event.type === 'goalmax.evidence') {
        const operationKey = event.evidence.exitCode === undefined ? null : evidenceOperationKey(event.evidence);
        const previous = goal.evidence
          .filter((item) => item.id !== event.evidence.id)
          .map((item) => operationKey && item.current && evidenceOperationKey(item) === operationKey ? { ...item, current: false } : item);
        const evidence = [...previous, event.evidence].slice(-GOALMAX_MAX_EVIDENCE);
        goal = { ...goal, revision: event.revision, evidence, updatedAt: event.timestamp };
      } else if (event.type === 'goalmax.assignment') {
        const childAssignments = [...goal.childAssignments.filter((item) => item.id !== event.assignment.id), event.assignment].slice(-GOALMAX_MAX_ASSIGNMENTS);
        goal = { ...goal, revision: event.revision, childAssignments, updatedAt: event.timestamp };
      } else if (event.type === 'goalmax.usage') {
        goal = { ...goal, revision: event.revision, tokensUsed: event.tokensUsed, elapsedMs: event.elapsedMs, updatedAt: event.timestamp };
      }
    }
    return goal === state.goal ? state : { goal };
  }),
}));
