import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SpeechDownloadProgress, SpeechSettings } from '../../shared/contracts/ipc';
import type { FlightDeckTarget } from '../features/shell/flightDeck';

export type AppToastKind = 'info' | 'success' | 'warning' | 'error';
export interface AppToastMessage {
  id: number;
  kind: AppToastKind;
  title: string;
  message: string;
}

let nextToastId = 0;
let nextComposerDraftRequestId = 0;
let nextAutomationOpenNonce = 0;
let nextFlightDeckJumpNonce = 0;

export interface AutomationOpenRequest {
  nonce: number;
  projectPath: string;
  automationId: string;
}

export interface FlightDeckJump {
  nonce: number;
  projectPath: string;
  sessionId: string;
  target: FlightDeckTarget;
}

export const LEFT_MIN = 220;
export const LEFT_MAX = 460;
export const RIGHT_MIN = 280;
export const RIGHT_MAX = 560;
export const BROWSER_PANE_MIN = 360;
// Generous upper bound so the browser pane can expand far enough left to reach a
// ~16:9 viewport aspect ratio on large windows. The flex layout naturally clamps
// to the available width, so a high cap is harmless and just removes the cap.
export const BROWSER_PANE_MAX = 2400;

export type SidebarTab = 'sessions' | 'resources' | 'automations';
export type InspectorTab = 'changes' | 'files' | 'tools' | 'sessions' | 'resources' | 'context' | 'goal';
export type InspectorDestination = 'work' | 'run' | 'system';
export type InspectorLastViews = Record<InspectorDestination, InspectorTab>;
export type SelectedAgent =
  | { kind: 'subagent'; runId: string }
  | { kind: 'team-node'; teamId: string; nodeId: string };

export const INSPECTOR_DEFAULT_VIEWS: Record<InspectorDestination, InspectorTab> = {
  work: 'changes',
  run: 'goal',
  system: 'context',
};

export function inspectorDestinationForTab(tab: InspectorTab): InspectorDestination {
  if (tab === 'changes' || tab === 'files') return 'work';
  if (tab === 'goal' || tab === 'sessions' || tab === 'tools') return 'run';
  return 'system';
}

interface UiState {
  leftWidth: number;
  rightWidth: number;
  sidebarCollapsed: boolean;
  sidebarTab: SidebarTab;
  inspectorCollapsed: boolean;
  paletteOpen: boolean;
  settingsOpen: boolean;
  terminalOpen: boolean;
  browserOpen: boolean;
  browserPaneWidth: number;
  musicPlayerEnabled: boolean;
  musicPlaying: boolean;
  sendMessageWithModifier: boolean;
  compactSessions: boolean;
  speech: SpeechSettings;
  speechDownload: SpeechDownloadProgress | null;
  toast: AppToastMessage | null;
  composerDraftRequest: { id: number; text: string; selectAll: boolean; mode: 'replace' | 'insert'; notice?: string } | null;
  automationOpenRequest: AutomationOpenRequest | null;
  inspectorTab: InspectorTab;
  inspectorLastViews: InspectorLastViews;
  selectedAgent: SelectedAgent | null;
  goalEditorOpen: boolean;
  flightDeckJump: FlightDeckJump | null;
  setLeftWidth: (width: number) => void;
  setRightWidth: (width: number) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  toggleSidebar: () => void;
  toggleInspector: () => void;
  setPaletteOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setTerminalOpen: (open: boolean) => void;
  toggleTerminal: () => void;
  setBrowserOpen: (open: boolean) => void;
  toggleBrowser: () => void;
  setBrowserPaneWidth: (width: number) => void;
  setMusicPlayerEnabled: (enabled: boolean) => void;
  setMusicPlaying: (playing: boolean) => void;
  setSendMessageWithModifier: (enabled: boolean) => void;
  setCompactSessions: (enabled: boolean) => void;
  setSpeech: (speech: SpeechSettings) => void;
  setSpeechDownload: (speechDownload: SpeechDownloadProgress | null) => void;
  showToast: (toast: Omit<AppToastMessage, 'id'>) => void;
  dismissToast: () => void;
  requestComposerDraft: (text: string, selectAll?: boolean, notice?: string) => void;
  requestComposerInsertion: (text: string, notice?: string) => void;
  clearComposerDraftRequest: (id: number) => void;
  openAutomation: (projectPath: string, automationId: string) => void;
  clearAutomationOpenRequest: (nonce: number) => void;
  setInspectorTab: (tab: InspectorTab) => void;
  openInspectorTab: (tab: InspectorTab) => void;
  openInspectorDestination: (destination: InspectorDestination) => void;
  openGoalMax: () => void;
  setGoalEditorOpen: (open: boolean) => void;
  openSubagent: (runId: string) => void;
  openAgentTeamNode: (teamId: string, nodeId: string) => void;
  openSubagentList: () => void;
  closeSubagent: () => void;
  requestFlightDeckJump: (projectPath: string, sessionId: string, target: FlightDeckTarget) => void;
  clearFlightDeckJump: (nonce?: number) => void;
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

function selectInspectorTab(state: Pick<UiState, 'inspectorLastViews'>, inspectorTab: InspectorTab) {
  const destination = inspectorDestinationForTab(inspectorTab);
  return {
    inspectorTab,
    inspectorLastViews: { ...state.inspectorLastViews, [destination]: inspectorTab },
  };
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      leftWidth: 264,
      rightWidth: 332,
      sidebarCollapsed: false,
      sidebarTab: 'sessions',
      inspectorCollapsed: false,
      paletteOpen: false,
      settingsOpen: false,
      terminalOpen: false,
      browserOpen: false,
      browserPaneWidth: 520,
      musicPlayerEnabled: false,
      musicPlaying: false,
      sendMessageWithModifier: false,
      compactSessions: false,
      speech: { enabled: true, modelId: 'mini', language: 'auto', inputDeviceId: null },
      speechDownload: null,
      toast: null,
      composerDraftRequest: null,
      automationOpenRequest: null,
      inspectorTab: 'changes',
      inspectorLastViews: { ...INSPECTOR_DEFAULT_VIEWS },
      selectedAgent: null,
      goalEditorOpen: false,
      flightDeckJump: null,
      setLeftWidth: (leftWidth) => set({ leftWidth: clamp(leftWidth, LEFT_MIN, LEFT_MAX) }),
      setRightWidth: (rightWidth) => set({ rightWidth: clamp(rightWidth, RIGHT_MIN, RIGHT_MAX) }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      setSidebarTab: (sidebarTab) => set({ sidebarTab }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      toggleInspector: () => set((state) => ({ inspectorCollapsed: !state.inspectorCollapsed })),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      setTerminalOpen: (terminalOpen) => set({ terminalOpen }),
      toggleTerminal: () => set((state) => ({ terminalOpen: !state.terminalOpen })),
      setBrowserOpen: (browserOpen) => set((state) => ({ browserOpen, inspectorCollapsed: browserOpen ? true : state.inspectorCollapsed })),
      toggleBrowser: () => set((state) => ({ browserOpen: !state.browserOpen, inspectorCollapsed: !state.browserOpen ? true : state.inspectorCollapsed })),
      setBrowserPaneWidth: (browserPaneWidth) => set({ browserPaneWidth: clamp(browserPaneWidth, BROWSER_PANE_MIN, BROWSER_PANE_MAX) }),
      setMusicPlayerEnabled: (musicPlayerEnabled) => set({ musicPlayerEnabled }),
      setMusicPlaying: (musicPlaying) => set({ musicPlaying }),
      setSendMessageWithModifier: (sendMessageWithModifier) => set({ sendMessageWithModifier }),
      setCompactSessions: (compactSessions) => set({ compactSessions }),
      setSpeech: (speech) => set({ speech }),
      setSpeechDownload: (speechDownload) => set({ speechDownload }),
      showToast: (toast) => set({ toast: { ...toast, id: ++nextToastId } }),
      dismissToast: () => set({ toast: null }),
      requestComposerDraft: (text, selectAll = false, notice) => set({ composerDraftRequest: { id: ++nextComposerDraftRequestId, text, selectAll, mode: 'replace', ...(notice ? { notice } : {}) } }),
      requestComposerInsertion: (text, notice) => set({ composerDraftRequest: { id: ++nextComposerDraftRequestId, text, selectAll: false, mode: 'insert', ...(notice ? { notice } : {}) } }),
      clearComposerDraftRequest: (id) => set((state) => state.composerDraftRequest?.id === id ? { composerDraftRequest: null } : state),
      openAutomation: (projectPath, automationId) => set({
        sidebarCollapsed: false,
        sidebarTab: 'automations',
        automationOpenRequest: { nonce: ++nextAutomationOpenNonce, projectPath, automationId },
      }),
      clearAutomationOpenRequest: (nonce) => set((state) => state.automationOpenRequest?.nonce === nonce ? { automationOpenRequest: null } : state),
      setInspectorTab: (inspectorTab) => set((state) => selectInspectorTab(state, inspectorTab)),
      openInspectorTab: (inspectorTab) => set((state) => ({ ...selectInspectorTab(state, inspectorTab), inspectorCollapsed: false })),
      openInspectorDestination: (destination) => set((state) => ({
        ...selectInspectorTab(state, state.inspectorLastViews[destination] ?? INSPECTOR_DEFAULT_VIEWS[destination]),
        inspectorCollapsed: false,
      })),
      openGoalMax: () => set((state) => ({ ...selectInspectorTab(state, 'goal'), inspectorCollapsed: false })),
      setGoalEditorOpen: (goalEditorOpen) => set({ goalEditorOpen }),
      openSubagent: (runId) => set((state) => ({ ...selectInspectorTab(state, 'sessions'), selectedAgent: { kind: 'subagent', runId }, inspectorCollapsed: false })),
      openAgentTeamNode: (teamId, nodeId) => set((state) => ({ ...selectInspectorTab(state, 'sessions'), selectedAgent: { kind: 'team-node', teamId, nodeId }, inspectorCollapsed: false })),
      openSubagentList: () => set((state) => ({ ...selectInspectorTab(state, 'sessions'), selectedAgent: null, inspectorCollapsed: false })),
      closeSubagent: () => set({ selectedAgent: null }),
      requestFlightDeckJump: (projectPath, sessionId, target) => set((state) => {
        const inspectorTab: InspectorTab | null = target.kind === 'file' ? 'changes'
          : target.kind === 'tool' ? 'tools'
            : target.kind === 'agent' || target.kind === 'team-node' || target.kind === 'task' ? 'sessions'
              : null;
        return {
          flightDeckJump: { nonce: ++nextFlightDeckJumpNonce, projectPath, sessionId, target },
          ...(inspectorTab ? { ...selectInspectorTab(state, inspectorTab), inspectorCollapsed: false } : {}),
          ...(target.kind === 'agent' ? { selectedAgent: { kind: 'subagent' as const, runId: target.runId } }
            : target.kind === 'team-node' ? { selectedAgent: { kind: 'team-node' as const, teamId: target.teamId, nodeId: target.nodeId } }
              : target.kind === 'task' ? { selectedAgent: target.nodeId ? { kind: 'team-node' as const, teamId: target.teamId, nodeId: target.nodeId } : null }
                : { selectedAgent: state.selectedAgent }),
        };
      }),
      clearFlightDeckJump: (nonce) => set((state) => !state.flightDeckJump || (nonce !== undefined && state.flightDeckJump.nonce !== nonce) ? state : { flightDeckJump: null }),
    }),
    {
      name: 'pi-desktop-ui-v1',
      partialize: ({
        leftWidth,
        rightWidth,
        sidebarCollapsed,
        sidebarTab,
        inspectorCollapsed,
        inspectorTab,
        inspectorLastViews,
        browserOpen,
        browserPaneWidth,
      }) => ({
        leftWidth,
        rightWidth,
        sidebarCollapsed,
        sidebarTab,
        inspectorCollapsed,
        inspectorTab,
        inspectorLastViews,
        browserOpen,
        browserPaneWidth,
      }),
    },
  ),
);
