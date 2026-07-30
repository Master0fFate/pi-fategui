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
      musicPlaying: false,
      sendMessageWithModifier: false,
      toast: null,
      inspectorTab: 'changes',
      selectedSubagentRunId: null,
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

  it('shares transient playback state without coupling it to pane state', () => {
    useUiStore.getState().setMusicPlaying(true);
    expect(useUiStore.getState().musicPlaying).toBe(true);
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it('shares the saved composer delivery preference with the input surface', () => {
    useUiStore.getState().setSendMessageWithModifier(true);
    expect(useUiStore.getState().sendMessageWithModifier).toBe(true);
  });

  it('keeps transient notifications outside persisted pane state', () => {
    useUiStore.getState().showToast({ kind: 'warning', title: 'Microphone changed', message: 'Using the system default.' });
    expect(useUiStore.getState().toast).toMatchObject({ kind: 'warning', title: 'Microphone changed' });
    useUiStore.getState().dismissToast();
    expect(useUiStore.getState().toast).toBeNull();
  });

  it('opens a child detail or the child-session list in the expanded inspector', () => {
    useUiStore.setState({ inspectorCollapsed: true });
    useUiStore.getState().openSubagent('child-1');
    expect(useUiStore.getState()).toMatchObject({
      inspectorTab: 'sessions', inspectorCollapsed: false, selectedSubagentRunId: 'child-1',
    });

    useUiStore.getState().openSubagentList();
    expect(useUiStore.getState()).toMatchObject({
      inspectorTab: 'sessions', inspectorCollapsed: false, selectedSubagentRunId: null,
    });
  });

  it('sets and toggles both collapsible panes independently', () => {
    useUiStore.getState().setSidebarCollapsed(true);
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    useUiStore.getState().setSidebarCollapsed(false);

    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    expect(useUiStore.getState().inspectorCollapsed).toBe(false);

    useUiStore.getState().toggleInspector();
    expect(useUiStore.getState().inspectorCollapsed).toBe(true);
  });
});
