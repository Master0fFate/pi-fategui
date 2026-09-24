import { create } from 'zustand';
import type { AgentLibrary, LegacyImportItem } from '../../shared/contracts/agents';
import { useRuntimeStore } from './runtimeStore';
import { useUiStore } from './uiStore';

export const emptyAgentLibrary = (): AgentLibrary => ({ agents: [], tasks: [], routines: [], runs: [], states: [], diagnostics: [], revisions: {}, nextDue: {} });
export function agentError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  try { const parsed = JSON.parse(text) as { message?: unknown }; if (typeof parsed.message === 'string') return parsed.message; } catch { /* Plain errors need no decoding. */ }
  return text;
}
interface AgentsState {
  projectPath: string | null;
  library: AgentLibrary;
  legacy: LegacyImportItem[];
  legacyLoading: boolean;
  legacyError: string | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  view: 'agents' | 'tasks' | 'routines' | 'history' | 'migration';
  historyRoutineId: string | null;
  selectedRunId: string | null;
  load: (projectPath: string | null, routineId?: string | null) => Promise<void>;
  loadLegacy: (projectPath: string | null) => Promise<void>;
  mutate: (operation: () => Promise<unknown>) => Promise<void>;
  setView: (view: AgentsState['view']) => void;
  reset: () => void;
}
let generation = 0;
let legacyGeneration = 0;
// Panel-level errors are status messages, not form errors: they auto-dismiss
// after 8s. A dismissal only applies if the message it was scheduled for is
// still the current one, so newer failures always win.
let errorTimer: ReturnType<typeof setTimeout> | undefined;
let legacyErrorTimer: ReturnType<typeof setTimeout> | undefined;
const scheduleErrorDismiss = (key: 'error' | 'legacyError', message: string) => {
  if (key === 'error' && errorTimer) clearTimeout(errorTimer);
  if (key === 'legacyError' && legacyErrorTimer) clearTimeout(legacyErrorTimer);
  const timer = setTimeout(() => {
    if (key === 'error') { errorTimer = undefined; if (useAgentsStore.getState().error === message) useAgentsStore.setState({ error: null }); }
    else { legacyErrorTimer = undefined; if (useAgentsStore.getState().legacyError === message) useAgentsStore.setState({ legacyError: null }); }
  }, 8000);
  if (key === 'error') errorTimer = timer; else legacyErrorTimer = timer;
};
export const useAgentsStore = create<AgentsState>((set, get) => ({
  projectPath: null, library: emptyAgentLibrary(), legacy: [], legacyLoading: false, legacyError: null, loading: false, busy: false, error: null, view: 'agents', historyRoutineId: null, selectedRunId: null,
  load: async (projectPath, routineId = get().historyRoutineId) => {
    const current = ++generation;
    const changedProject = projectPath !== get().projectPath;
    const filter = changedProject ? null : routineId;
    set({ projectPath, loading: Boolean(projectPath), error: null, historyRoutineId: filter, ...(changedProject ? { library: emptyAgentLibrary(), selectedRunId: null } : {}) });
    if (!projectPath || !window.piDesktop?.getAgentLibrary) { set({ loading: false }); return; }
    try {
      const library = await window.piDesktop.getAgentLibrary(filter ? { routineId: filter } : {});
      if (current === generation) set({ library, loading: false });
    } catch (error) { if (current === generation) { const message = agentError(error); set({ error: message, loading: false }); scheduleErrorDismiss('error', message); } }
  },
  loadLegacy: async (projectPath) => {
    const current = ++legacyGeneration;
    if (!projectPath) { set({ legacy: [], legacyLoading: false, legacyError: null }); return; }
    set({ legacyLoading: true, legacyError: null });
    if (!window.piDesktop?.listLegacyAutomations) { set({ legacyLoading: false }); return; }
    try {
      const legacy = await window.piDesktop.listLegacyAutomations({});
      if (current === legacyGeneration && get().projectPath === projectPath) set({ legacy, legacyLoading: false });
    } catch (error) {
      if (current === legacyGeneration && get().projectPath === projectPath) { const message = agentError(error); set({ legacyError: message, legacyLoading: false }); scheduleErrorDismiss('legacyError', message); }
    }
  },
  mutate: async (operation) => {
    if (get().busy) throw new Error('Wait for the current Agent operation.');
    const projectPath = get().projectPath;
    set({ busy: true, error: null });
    try {
      await operation();
      if (get().projectPath === projectPath) await get().load(projectPath);
    } catch (error) {
      if (get().projectPath === projectPath) { const message = agentError(error); set({ error: message }); scheduleErrorDismiss('error', message); }
      throw error;
    } finally { set({ busy: false }); }
  },
  setView: (view) => set({ view }),
  reset: () => { generation += 1; legacyGeneration += 1; set({ projectPath: null, library: emptyAgentLibrary(), legacy: [], legacyLoading: false, legacyError: null, loading: false, busy: false, error: null, view: 'agents', historyRoutineId: null, selectedRunId: null }); },
}));

export async function openAgentNotice(projectPath: string, runId: string): Promise<void> {
  try {
    if (useRuntimeStore.getState().runtime.project?.path !== projectPath) {
      useRuntimeStore.getState().setRuntime(await window.piDesktop.focusProject(projectPath));
    }
    useUiStore.getState().setSidebarCollapsed(false);
    useUiStore.getState().setSidebarTab('agents');
    const routine = runId.split(':')[0]!;
    useAgentsStore.setState({ view: 'history', selectedRunId: runId, historyRoutineId: routine === 'manual' ? null : routine });
    await useAgentsStore.getState().load(projectPath, routine === 'manual' ? null : routine);
  } catch (error) { useUiStore.getState().showToast({ kind: 'error', title: 'Agent run unavailable', message: agentError(error) }); }
}
