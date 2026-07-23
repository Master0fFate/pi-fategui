import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const LEFT_MIN = 220;
export const LEFT_MAX = 420;
export const RIGHT_MIN = 280;
export const RIGHT_MAX = 520;

interface UiState {
  leftWidth: number;
  rightWidth: number;
  sidebarCollapsed: boolean;
  inspectorCollapsed: boolean;
  paletteOpen: boolean;
  settingsOpen: boolean;
  terminalOpen: boolean;
  inspectorTab: 'changes' | 'files' | 'tools' | 'context';
  setLeftWidth: (width: number) => void;
  setRightWidth: (width: number) => void;
  toggleSidebar: () => void;
  toggleInspector: () => void;
  setPaletteOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setTerminalOpen: (open: boolean) => void;
  toggleTerminal: () => void;
  setInspectorTab: (tab: UiState['inspectorTab']) => void;
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
      inspectorTab: 'changes',
      setLeftWidth: (leftWidth) => set({ leftWidth: clamp(leftWidth, LEFT_MIN, LEFT_MAX) }),
      setRightWidth: (rightWidth) => set({ rightWidth: clamp(rightWidth, RIGHT_MIN, RIGHT_MAX) }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      toggleInspector: () => set((state) => ({ inspectorCollapsed: !state.inspectorCollapsed })),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      setTerminalOpen: (terminalOpen) => set({ terminalOpen }),
      toggleTerminal: () => set((state) => ({ terminalOpen: !state.terminalOpen })),
      setInspectorTab: (inspectorTab) => set({ inspectorTab }),
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
