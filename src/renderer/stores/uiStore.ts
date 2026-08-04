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
let nextFlightDeckJumpNonce = 0;

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

interface UiState {
  leftWidth: number;
  rightWidth: number;
  sidebarCollapsed: boolean;
  inspectorCollapsed: boolean;
  paletteOpen: boolean;
  settingsOpen: boolean;
  terminalOpen: boolean;
  musicPlayerEnabled: boolean;
  musicPlaying: boolean;
  sendMessageWithModifier: boolean;
  speech: SpeechSettings;
  speechDownload: SpeechDownloadProgress | null;
  toast: AppToastMessage | null;
  composerDraftRequest: { id: number; text: string; selectAll: boolean; notice?: string } | null;
  inspectorTab: 'changes' | 'files' | 'tools' | 'sessions' | 'resources' | 'context' | 'goal';
  selectedSubagentRunId: string | null;
  goalEditorOpen: boolean;
  flightDeckJump: FlightDeckJump | null;
  setLeftWidth: (width: number) => void;
  setRightWidth: (width: number) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  toggleInspector: () => void;
  setPaletteOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setTerminalOpen: (open: boolean) => void;
  toggleTerminal: () => void;
  setMusicPlayerEnabled: (enabled: boolean) => void;
  setMusicPlaying: (playing: boolean) => void;
  setSendMessageWithModifier: (enabled: boolean) => void;
  setSpeech: (speech: SpeechSettings) => void;
  setSpeechDownload: (speechDownload: SpeechDownloadProgress | null) => void;
  showToast: (toast: Omit<AppToastMessage, 'id'>) => void;
  dismissToast: () => void;
  requestComposerDraft: (text: string, selectAll?: boolean, notice?: string) => void;
  clearComposerDraftRequest: (id: number) => void;
  setInspectorTab: (tab: UiState['inspectorTab']) => void;
  openGoalMax: () => void;
  setGoalEditorOpen: (open: boolean) => void;
  openSubagent: (runId: string) => void;
  openSubagentList: () => void;
  closeSubagent: () => void;
  requestFlightDeckJump: (projectPath: string, sessionId: string, target: FlightDeckTarget) => void;
  clearFlightDeckJump: (nonce?: number) => void;
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      leftWidth: 264,
      rightWidth: 332,
      sidebarCollapsed: false,
      inspectorCollapsed: false,
      paletteOpen: false,
      settingsOpen: false,
      terminalOpen: false,
      musicPlayerEnabled: false,
      musicPlaying: false,
      sendMessageWithModifier: false,
      speech: { enabled: true, modelId: 'mini', language: 'auto', inputDeviceId: null },
      speechDownload: null,
      toast: null,
      composerDraftRequest: null,
      inspectorTab: 'changes',
      selectedSubagentRunId: null,
      goalEditorOpen: false,
      flightDeckJump: null,
      setLeftWidth: (leftWidth) => set({ leftWidth: clamp(leftWidth, LEFT_MIN, LEFT_MAX) }),
      setRightWidth: (rightWidth) => set({ rightWidth: clamp(rightWidth, RIGHT_MIN, RIGHT_MAX) }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      toggleInspector: () => set((state) => ({ inspectorCollapsed: !state.inspectorCollapsed })),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      setTerminalOpen: (terminalOpen) => set({ terminalOpen }),
      toggleTerminal: () => set((state) => ({ terminalOpen: !state.terminalOpen })),
      setMusicPlayerEnabled: (musicPlayerEnabled) => set({ musicPlayerEnabled }),
      setMusicPlaying: (musicPlaying) => set({ musicPlaying }),
      setSendMessageWithModifier: (sendMessageWithModifier) => set({ sendMessageWithModifier }),
      setSpeech: (speech) => set({ speech }),
      setSpeechDownload: (speechDownload) => set({ speechDownload }),
      showToast: (toast) => set({ toast: { ...toast, id: ++nextToastId } }),
      dismissToast: () => set({ toast: null }),
      requestComposerDraft: (text, selectAll = false, notice) => set({ composerDraftRequest: { id: ++nextComposerDraftRequestId, text, selectAll, ...(notice ? { notice } : {}) } }),
      clearComposerDraftRequest: (id) => set((state) => state.composerDraftRequest?.id === id ? { composerDraftRequest: null } : state),
      setInspectorTab: (inspectorTab) => set({ inspectorTab }),
      openGoalMax: () => set({ inspectorTab: 'goal', inspectorCollapsed: false }),
      setGoalEditorOpen: (goalEditorOpen) => set({ goalEditorOpen }),
      openSubagent: (selectedSubagentRunId) => set({ selectedSubagentRunId, inspectorTab: 'sessions', inspectorCollapsed: false }),
      openSubagentList: () => set({ selectedSubagentRunId: null, inspectorTab: 'sessions', inspectorCollapsed: false }),
      closeSubagent: () => set({ selectedSubagentRunId: null }),
      requestFlightDeckJump: (projectPath, sessionId, target) => set((state) => ({
        flightDeckJump: { nonce: ++nextFlightDeckJumpNonce, projectPath, sessionId, target },
        ...(target.kind === 'file' ? { inspectorTab: 'changes' as const, inspectorCollapsed: false }
          : target.kind === 'tool' ? { inspectorTab: 'tools' as const, inspectorCollapsed: false }
            : target.kind === 'agent' ? { inspectorTab: 'sessions' as const, inspectorCollapsed: false, selectedSubagentRunId: target.runId }
              : target.kind === 'team-node' || target.kind === 'task' ? { inspectorTab: 'sessions' as const, inspectorCollapsed: false, selectedSubagentRunId: null }
                : {}),
        ...(target.kind !== 'agent' ? { selectedSubagentRunId: target.kind === 'team-node' || target.kind === 'task' ? null : state.selectedSubagentRunId } : {}),
      })),
      clearFlightDeckJump: (nonce) => set((state) => !state.flightDeckJump || (nonce !== undefined && state.flightDeckJump.nonce !== nonce) ? state : { flightDeckJump: null }),
    }),
    {
      name: 'pi-desktop-ui-v1',
      partialize: ({ leftWidth, rightWidth, sidebarCollapsed, inspectorCollapsed }) => ({
        leftWidth,
        rightWidth,
        sidebarCollapsed,
        inspectorCollapsed,
      }),
    },
  ),
);
