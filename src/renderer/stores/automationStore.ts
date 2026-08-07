import { create } from 'zustand';
import type {
  AutomationCreateInput,
  AutomationDefinition,
  AutomationLaunchOutcome,
  AutomationUpdateInput,
} from '../../shared/contracts/automations';

interface AutomationStore {
  projectPath: string | null;
  items: AutomationDefinition[];
  loading: boolean;
  mutatingId: string | null;
  error: string | null;
  initialize: (projectPath: string | null) => Promise<void>;
  create: (input: AutomationCreateInput) => Promise<AutomationDefinition>;
  update: (input: AutomationUpdateInput) => Promise<AutomationDefinition>;
  remove: (id: string) => Promise<void>;
  recordLaunch: (id: string, outcome: AutomationLaunchOutcome) => Promise<void>;
  reset: () => void;
}

let loadGeneration = 0;

const sorted = (items: readonly AutomationDefinition[]) => [...items]
  .sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name));
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'The automation operation failed.';

export const useAutomationStore = create<AutomationStore>((set, get) => ({
  projectPath: null,
  items: [],
  loading: false,
  mutatingId: null,
  error: null,

  initialize: async (projectPath) => {
    const generation = ++loadGeneration;
    if (!projectPath) {
      set({ projectPath: null, items: [], loading: false, mutatingId: null, error: null });
      return;
    }
    set((state) => ({
      projectPath,
      loading: true,
      error: null,
      ...(state.projectPath === projectPath ? {} : { items: [], mutatingId: null }),
    }));
    const desktop = 'piDesktop' in window ? window.piDesktop : undefined;
    if (typeof desktop?.listAutomations !== 'function') {
      if (generation === loadGeneration && get().projectPath === projectPath) set({ items: [], loading: false });
      return;
    }
    try {
      const items = await desktop.listAutomations();
      if (generation === loadGeneration && get().projectPath === projectPath) set({ items: sorted(items), loading: false });
    } catch (error) {
      if (generation === loadGeneration && get().projectPath === projectPath) set({ loading: false, error: messageOf(error) });
    }
  },

  create: async (input) => {
    const projectPath = get().projectPath;
    if (!projectPath || !('piDesktop' in window) || typeof window.piDesktop.createAutomation !== 'function') {
      throw new Error('Open a project before creating an automation.');
    }
    set({ mutatingId: 'new', error: null });
    try {
      const automation = await window.piDesktop.createAutomation(input);
      if (get().projectPath === projectPath) set((state) => ({ items: sorted([automation, ...state.items]), mutatingId: null }));
      return automation;
    } catch (error) {
      if (get().projectPath === projectPath) set({ mutatingId: null, error: messageOf(error) });
      throw error;
    }
  },

  update: async (input) => {
    const projectPath = get().projectPath;
    if (!projectPath || !('piDesktop' in window) || typeof window.piDesktop.updateAutomation !== 'function') {
      throw new Error('Open a project before editing an automation.');
    }
    set({ mutatingId: input.id, error: null });
    try {
      const automation = await window.piDesktop.updateAutomation(input);
      if (get().projectPath === projectPath) set((state) => ({
        items: sorted(state.items.map((item) => item.id === automation.id ? automation : item)),
        mutatingId: null,
      }));
      return automation;
    } catch (error) {
      if (get().projectPath === projectPath) set({ mutatingId: null, error: messageOf(error) });
      throw error;
    }
  },

  remove: async (id) => {
    const projectPath = get().projectPath;
    if (!projectPath || !('piDesktop' in window) || typeof window.piDesktop.deleteAutomation !== 'function') {
      throw new Error('Open a project before deleting an automation.');
    }
    set({ mutatingId: id, error: null });
    try {
      await window.piDesktop.deleteAutomation(id);
      if (get().projectPath === projectPath) set((state) => ({
        items: state.items.filter((item) => item.id !== id),
        mutatingId: null,
      }));
    } catch (error) {
      if (get().projectPath === projectPath) set({ mutatingId: null, error: messageOf(error) });
      throw error;
    }
  },

  recordLaunch: async (id, outcome) => {
    const projectPath = get().projectPath;
    const desktop = 'piDesktop' in window ? window.piDesktop : undefined;
    if (!projectPath || typeof desktop?.recordAutomationLaunch !== 'function') return;
    try {
      const automation = await desktop.recordAutomationLaunch(id, outcome);
      if (get().projectPath === projectPath) set((state) => ({
        items: sorted(state.items.map((item) => item.id === automation.id ? automation : item)),
      }));
    } catch {
      // Launch telemetry must never hide or invalidate the prepared session.
    }
  },

  reset: () => {
    loadGeneration += 1;
    set({ projectPath: null, items: [], loading: false, mutatingId: null, error: null });
  },
}));
