import { create } from 'zustand';
import type { WireResultOf } from '../../shared/protocol/methods';
import { currentNetworkScope, type NetworkWorkspaceApi, type ReadView } from './runtimeStore';
export type TaskListView = TaskList | NonNullable<WireResultOf<'task.list'>['list']>;
export function selectTaskView(state: TaskStore, source: 'desktop' | 'network'): TaskListView | null {
  if (source === 'desktop') return state.list;
  return state.networkScopeKey === currentNetworkScope()?.key && state.network.status === 'ready' ? state.network.value.list : null;
}
import { taskListSchema, type TaskEvent, type TaskList } from '../../shared/contracts/tasks';

interface TaskStore {
  networkScopeKey: string | null;
  network: ReadView<WireResultOf<'task.list'>>;
  loadNetwork: (api: NetworkWorkspaceApi) => Promise<void>;
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
  networkScopeKey: null, network: { status: 'unavailable' },
  loadNetwork: async (api) => {
    const captured = currentNetworkScope();
    if (!captured || !api.isConnected) { set({ networkScopeKey: null, network: { status: 'unavailable' } }); return; }
    set({ networkScopeKey: captured.key, network: { status: api.supports('task.read') ? 'loading' : 'unavailable' } });
    if (!api.supports('task.read')) return;
    try {
      const value = await api.readTasks(captured.scope);
      if (value.sessionId !== captured.sessionId || value.selectionRevision !== captured.header.selectionRevision) throw new Error('Task selection changed.');
      if (api.isConnected && currentNetworkScope()?.key === captured.key) set({ network: { status: 'ready', value } });
    } catch { if (currentNetworkScope()?.key === captured.key) set({ network: { status: 'error' } }); }
  },
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
