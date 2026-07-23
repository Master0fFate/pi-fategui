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
  setLeftWidth: (width: number) => void;
  setRightWidth: (width: number) => void;
  toggleSidebar: () => void;
  toggleInspector: () => void;
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
      setLeftWidth: (leftWidth) => set({ leftWidth: clamp(leftWidth, LEFT_MIN, LEFT_MAX) }),
      setRightWidth: (rightWidth) => set({ rightWidth: clamp(rightWidth, RIGHT_MIN, RIGHT_MAX) }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      toggleInspector: () => set((state) => ({ inspectorCollapsed: !state.inspectorCollapsed })),
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
