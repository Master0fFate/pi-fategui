import { beforeEach, describe, expect, it } from 'vitest';
import { LEFT_MAX, LEFT_MIN, RIGHT_MAX, RIGHT_MIN, useUiStore } from './uiStore';

describe('UI store', () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({
      leftWidth: 264,
      rightWidth: 332,
      sidebarCollapsed: false,
      sidebarTab: 'sessions',
      inspectorCollapsed: false,
      musicPlaying: false,
      sendMessageWithModifier: false,
      toast: null,
      inspectorTab: 'changes',
      inspectorLastViews: { work: 'changes', run: 'goal', system: 'context' },
      selectedAgent: null,
      automationOpenRequest: null,
      flightDeckJump: null,
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

  it('persists the selected sidebar destination and distinguishes draft insertion from replacement', () => {
    useUiStore.getState().setSidebarTab('resources');
    expect(useUiStore.getState().sidebarTab).toBe('resources');
    expect(JSON.parse(localStorage.getItem('pi-desktop-ui-v1') ?? '{}').state?.sidebarTab).toBe('resources');

    useUiStore.getState().requestComposerInsertion('/review ');
    expect(useUiStore.getState().composerDraftRequest).toMatchObject({ text: '/review ', mode: 'insert', selectAll: false });
    useUiStore.getState().requestComposerDraft('Replace me', true);
    expect(useUiStore.getState().composerDraftRequest).toMatchObject({ text: 'Replace me', mode: 'replace', selectAll: true });
  });

  it('opens an exact automation through a transient sidebar request', () => {
    useUiStore.setState({ sidebarCollapsed: true, sidebarTab: 'sessions' });
    useUiStore.getState().openAutomation('C:/project', 'automation-1');
    const request = useUiStore.getState().automationOpenRequest;

    expect(useUiStore.getState()).toMatchObject({
      sidebarCollapsed: false,
      sidebarTab: 'automations',
      automationOpenRequest: { projectPath: 'C:/project', automationId: 'automation-1' },
    });
    expect(JSON.parse(localStorage.getItem('pi-desktop-ui-v1') ?? '{}').state?.automationOpenRequest).toBeUndefined();

    useUiStore.getState().clearAutomationOpenRequest(request!.nonce);
    expect(useUiStore.getState().automationOpenRequest).toBeNull();
  });

  it('keeps transient notifications outside persisted pane state', () => {
    useUiStore.getState().showToast({ kind: 'warning', title: 'Microphone changed', message: 'Using the system default.' });
    expect(useUiStore.getState().toast).toMatchObject({ kind: 'warning', title: 'Microphone changed' });
    useUiStore.getState().dismissToast();
    expect(useUiStore.getState().toast).toBeNull();
  });

  it('remembers the last view within each Inspector destination', () => {
    useUiStore.getState().setInspectorTab('files');
    useUiStore.getState().openInspectorDestination('run');
    expect(useUiStore.getState().inspectorTab).toBe('goal');

    useUiStore.getState().setInspectorTab('sessions');
    useUiStore.getState().openInspectorDestination('work');
    expect(useUiStore.getState().inspectorTab).toBe('files');
    useUiStore.getState().openInspectorDestination('run');
    expect(useUiStore.getState()).toMatchObject({ inspectorTab: 'sessions', inspectorCollapsed: false });

    useUiStore.setState({ inspectorCollapsed: true });
    useUiStore.getState().openInspectorTab('resources');
    expect(useUiStore.getState()).toMatchObject({ inspectorTab: 'resources', inspectorCollapsed: false });
  });

  it('opens a child detail or the child-session list in the expanded inspector', () => {
    useUiStore.setState({ inspectorCollapsed: true });
    useUiStore.getState().openSubagent('child-1');
    expect(useUiStore.getState()).toMatchObject({
      inspectorTab: 'sessions', inspectorCollapsed: false, selectedAgent: { kind: 'subagent', runId: 'child-1' },
    });

    useUiStore.getState().openAgentTeamNode('team-1', 'node-1');
    expect(useUiStore.getState()).toMatchObject({
      inspectorTab: 'sessions', inspectorCollapsed: false, selectedAgent: { kind: 'team-node', teamId: 'team-1', nodeId: 'node-1' },
    });

    useUiStore.getState().openSubagentList();
    expect(useUiStore.getState()).toMatchObject({
      inspectorTab: 'sessions', inspectorCollapsed: false, selectedAgent: null,
    });
  });

  it('keeps scoped Flight Deck jumps transient and routes existing inspector surfaces', () => {
    useUiStore.getState().requestFlightDeckJump('C:/project', 'session-1', { kind: 'file', path: 'src/app.ts' });
    const fileJump = useUiStore.getState().flightDeckJump;
    expect(useUiStore.getState()).toMatchObject({ inspectorTab: 'changes', inspectorCollapsed: false });
    expect(fileJump).toMatchObject({ projectPath: 'C:/project', sessionId: 'session-1', target: { kind: 'file', path: 'src/app.ts' } });
    expect(JSON.parse(localStorage.getItem('pi-desktop-ui-v1') ?? '{}').state?.flightDeckJump).toBeUndefined();
    useUiStore.getState().clearFlightDeckJump(fileJump?.nonce);
    expect(useUiStore.getState().flightDeckJump).toBeNull();

    useUiStore.getState().requestFlightDeckJump('C:/project', 'session-1', { kind: 'agent', runId: 'run-1' });
    expect(useUiStore.getState()).toMatchObject({ inspectorTab: 'sessions', selectedAgent: { kind: 'subagent', runId: 'run-1' } });
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
