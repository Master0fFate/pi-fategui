import { create } from 'zustand';
import type {
  BrowserAnnotation,
  BrowserConfirmation,
  BrowserEvent,
  BrowserOriginGrant,
  BrowserState,
  BrowserWorkLogAction,
} from '../../shared/contracts/browser';

const MAX_BROWSER_LOG_ENTRIES = 300;

export interface BrowserWorkLogEntry {
  id: number;
  action: BrowserWorkLogAction;
  target: string;
  timestamp: number;
}

interface BrowserStore {
  state: BrowserState;
  annotations: BrowserAnnotation[];
  workLog: BrowserWorkLogEntry[];
  confirmation: BrowserConfirmation | null;
  error: string | null;
  pending: string | null;
  initializedProjectPath: string | null;
  hydrate: (state: BrowserState, projectPath?: string | null) => void;
  applyEvents: (events: readonly BrowserEvent[]) => void;
  setPending: (pending: string | null) => void;
  setError: (error: string | null) => void;
  setAnnotations: (annotations: BrowserAnnotation[]) => void;
  addAnnotation: (annotation: BrowserAnnotation) => void;
  replaceAnnotation: (annotation: BrowserAnnotation) => void;
  removeAnnotation: (id: string) => void;
  reset: () => void;
}

const initialBrowserState: BrowserState = {
  activeTabId: null,
  visible: false,
  viewBlocked: false,
  sessionFullAccess: false,
  controlLevel: 'off',
  mode: 'agent',
  tabs: [],
  grants: [],
};

let nextWorkLogId = 0;

export const useBrowserStore = create<BrowserStore>((set) => ({
  state: initialBrowserState,
  annotations: [],
  workLog: [],
  confirmation: null,
  error: null,
  pending: null,
  initializedProjectPath: null,
  hydrate: (state, projectPath) => set({
    state,
    ...(projectPath === undefined ? {} : { initializedProjectPath: projectPath }),
    error: null,
  }),
  applyEvents: (events) => set((current) => {
    let state = current.state;
    let annotations = current.annotations;
    let confirmation = current.confirmation;
    let error = current.error;
    let workLog = current.workLog;
    for (const event of events) {
      if (event.type === 'state') state = event.state;
      else if (event.type === 'confirmation-requested') confirmation = event.confirmation;
      else if (event.type === 'confirmation-cleared' && confirmation?.id === event.id) confirmation = null;
      else if (event.type === 'navigation-blocked') error = event.reason;
      else if (event.type === 'annotation-created') annotations = [event.annotation, ...annotations.filter((item) => item.id !== event.annotation.id)];
      else if (event.type === 'annotation-error') error = event.message;
      else if (event.type === 'cdp-availability' && !event.available) error = event.reason ?? 'Semantic browser control disconnected.';
      else if (event.type === 'work-log') {
        workLog = [...workLog, {
          id: ++nextWorkLogId,
          action: event.action,
          target: event.target,
          timestamp: event.timestamp,
        }].slice(-MAX_BROWSER_LOG_ENTRIES);
      }
    }
    return { state, annotations, confirmation, error, workLog };
  }),
  setPending: (pending) => set({ pending }),
  setError: (error) => set({ error }),
  setAnnotations: (annotations) => set({ annotations }),
  addAnnotation: (annotation) => set((current) => ({
    annotations: [annotation, ...current.annotations.filter((item) => item.id !== annotation.id)],
  })),
  replaceAnnotation: (annotation) => set((current) => ({
    annotations: current.annotations.map((item) => item.id === annotation.id ? annotation : item),
  })),
  removeAnnotation: (id) => set((current) => ({
    annotations: current.annotations.filter((annotation) => annotation.id !== id),
  })),
  reset: () => set({
    state: initialBrowserState,
    annotations: [],
    workLog: [],
    confirmation: null,
    error: null,
    pending: null,
    initializedProjectPath: null,
  }),
}));

export function currentBrowserTab(state: BrowserState) {
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
}

export function grantForOrigin(state: BrowserState, origin: string | null): BrowserOriginGrant | null {
  if (!origin) return null;
  return state.grants.find((grant) => grant.origin === origin) ?? null;
}

export function browserOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin === 'null' ? null : parsed.origin;
  } catch {
    return null;
  }
}
