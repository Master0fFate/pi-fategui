import { beforeEach, describe, expect, it } from 'vitest';
import { LEFT_MAX, LEFT_MIN, RIGHT_MAX, RIGHT_MIN, useUiStore } from './uiStore';

describe('UI store', () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({
      leftWidth: 264,
      rightWidth: 332,
      sidebarCollapsed: false,
      inspectorCollapsed: false,
    });
  });

  it('clamps pane widths to usable limits', () => {
    useUiStore.getState().setLeftWidth(-100);
    useUiStore.getState().setRightWidth(900);
    expect(useUiStore.getState().leftWidth).toBe(LEFT_MIN);
    expect(useUiStore.getState().rightWidth).toBe(RIGHT_MAX);

    useUiStore.getState().setLeftWidth(900);
    useUiStore.getState().setRightWidth(1);
    expect(useUiStore.getState().leftWidth).toBe(LEFT_MAX);
    expect(useUiStore.getState().rightWidth).toBe(RIGHT_MIN);
  });

  it('toggles both collapsible panes independently', () => {
    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    expect(useUiStore.getState().inspectorCollapsed).toBe(false);

    useUiStore.getState().toggleInspector();
    expect(useUiStore.getState().inspectorCollapsed).toBe(true);
  });
});
