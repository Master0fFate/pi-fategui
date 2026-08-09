import { create } from 'zustand';
import { taskListSchema, type TaskEvent, type TaskList } from '../../shared/contracts/tasks';

interface TaskStore {
  projectPath: string | null;
  sessionId: string | null;
  list: TaskList | null;
  loading: boolean;
  selectionGeneration: number;
  selectSession: (projectPath: string | null, sessionId: string | null) => number;
  hydrate: (generation: number, list: TaskList | null) => boolean;
  setList: (list: TaskList | null) => void;
  applyEvents: (events: readonly TaskEvent[]) => void;
}

export const useTaskStore = create<TaskStore>((set) => ({
  projectPath: null,
  sessionId: null,
  list: null,
  loading: false,
  selectionGeneration: 0,
  selectSession: (projectPath, sessionId) => {
    let generation = 0;
    set((state) => {
      generation = state.selectionGeneration + 1;
      return { projectPath, sessionId, list: null, loading: Boolean(projectPath && sessionId), selectionGeneration: generation };
    });
    return generation;
  },
  hydrate: (generation, list) => {
    let applied = false;
    set((state) => {
      if (generation !== state.selectionGeneration) return state;
      if (list && (list.projectPath !== state.projectPath || list.sessionId !== state.sessionId)) return state;
      applied = true;
      const parsed = list ? taskListSchema.parse(list) : null;
      if (!parsed && state.list) return { loading: false };
      if (parsed && state.list && state.list.revision > parsed.revision) return { loading: false };
      return { list: parsed, loading: false };
    });
    return applied;
  },
  setList: (list) => set((state) => {
    if (list && (list.projectPath !== state.projectPath || list.sessionId !== state.sessionId)) return state;
    const parsed = list ? taskListSchema.parse(list) : null;
    if (parsed && state.list && parsed.revision < state.list.revision) return state;
    return { list: parsed, loading: false };
  }),
  applyEvents: (events) => set((state) => {
    let list = state.list;
    for (const event of events) {
      if (event.projectPath !== state.projectPath || event.sessionId !== state.sessionId) continue;
      if (event.type !== 'tasklist.snapshot') continue;
      const incoming = event.list;
      if (!incoming) { list = null; continue; }
      if (!list || incoming.revision >= list.revision) list = incoming;
    }
    return list === state.list ? state : { list };
  }),
}));
