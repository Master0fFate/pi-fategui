import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiDesktopApi, RuntimeState, SessionSummary } from '../../../shared/contracts/ipc';
import { useAutomationStore } from '../../stores/automationStore';
import { useBrowserStore } from '../../stores/browserStore';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useProjectStore } from '../../stores/projectStore';
import { useUiStore } from '../../stores/uiStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { Sidebar } from './Sidebar';

const session = (id: string, title: string, active: boolean, attention?: SessionSummary['attention']): SessionSummary => ({
  id,
  title,
  firstMessage: `${title} prompt`,
  path: `/sessions/${id}.jsonl`,
  createdAt: '2025-01-01T00:00:00.000Z',
  modifiedAt: '2025-01-02T00:00:00.000Z',
  messageCount: 2,
  active,
  ...(attention !== undefined ? { attention } : {}),
});

const ready = (overrides: Partial<RuntimeState> = {}): RuntimeState => ({
  status: 'ready',
  project: { path: '/project', name: 'project', trusted: true },
  sessionId: 's1',
  sessionFile: '/sessions/s1.jsonl',
  streaming: false,
  activeSessionRunning: false,
  runningSessionCount: 0,
  model: null,
  models: [],
  thinkingLevel: 'medium',
  messages: [],
  commands: [],
  sessions: [session('s1', 'First', true), session('s2', 'Second', false)],
  sessionCapabilities: { fork: true, navigate: true, clone: true, compact: true, import: true },
  sessionOperation: false,
  error: null,
  ...overrides,
});

describe('Sidebar sessions', () => {
  beforeEach(() => {
    localStorage.clear();
    useRuntimeStore.getState().setRuntime(ready());
    // Tests exercise expanded-folder rendering; production starts collapsed.
    useProjectStore.setState({ projects: [], expandedByPath: { '/project': true } });
    useUiStore.setState({ sidebarTab: 'sessions', composerDraftRequest: null, automationOpenRequest: null, toast: null, compactSessions: false });
    useWorkspaceStore.setState({ projectPath: '/project', git: null });
    useAutomationStore.getState().reset();
    useBrowserStore.getState().reset();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'piDesktop');
  });

  it('keeps navigation and idle-target actions enabled while the selected session streams', async () => {
    const state = ready({ streaming: true, activeSessionRunning: true, runningSessionCount: 1 });
    useRuntimeStore.getState().setRuntime(state);
    const newSession = vi.fn(async () => state);
    const switchSession = vi.fn(async () => state);
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: { newSession, switchSession } as unknown as PiDesktopApi,
    });
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    const create = screen.getByRole('button', { name: 'New session in project' });
    const openSecond = screen.getByRole('button', { name: /^Second/u });
    expect(create).toBeEnabled();
    expect(openSecond).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Clone First' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Rename First' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Clone Second' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Compact Second' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Create an isolated Git worktree session from Second' })).toBeDisabled();

    await user.click(openSecond);
    await waitFor(() => expect(switchSession).toHaveBeenCalledWith('s2'));
    await waitFor(() => expect(create).toBeEnabled());
    await user.click(create);
    await waitFor(() => expect(newSession).toHaveBeenCalledOnce());
  });

  it('opens projects from the toolbar and creates sessions from each folder header', async () => {
    const state = ready();
    const selectProject = vi.fn(async () => state);
    const newSession = vi.fn(async () => state);
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: { selectProject, newSession } as unknown as PiDesktopApi,
    });
    const user = userEvent.setup();
    const { container } = render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    expect(container.querySelector('.sidebar > .primary-button')).not.toBeInTheDocument();
    expect(container.querySelector('.sidebar > .new-session')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'New session in project' }));
    await waitFor(() => expect(newSession).toHaveBeenCalledOnce());
    await user.click(screen.getByRole('button', { name: 'Open project' }));
    await waitFor(() => expect(selectProject).toHaveBeenCalledOnce());
  });

  it('updates the selected session shell immediately while the desktop history load is pending', async () => {
    let finishSwitch: ((state: RuntimeState) => void) | undefined;
    const initial = ready({ messages: [{ id: 'old', role: 'user', text: 'Old conversation', timestamp: 1 }] });
    useRuntimeStore.getState().hydrateRuntime(initial);
    const switched = ready({
      sessionId: 's2',
      sessionFile: '/sessions/s2.jsonl',
      sessions: [session('s1', 'First', false), session('s2', 'Second', true)],
      messages: [{ id: 'new', role: 'user', text: 'New conversation', timestamp: 2 }],
    });
    const switchSession = vi.fn(() => new Promise<RuntimeState>((resolve) => { finishSwitch = resolve; }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { switchSession } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /^Second/u }));

    const pending = useRuntimeStore.getState();
    expect(switchSession).toHaveBeenCalledWith('s2');
    expect(pending.runtime.sessionId).toBe('s2');
    expect(pending.runtime.sessions?.find((item) => item.id === 's2')?.active).toBe(true);
    expect(pending.runtime.sessionOperation).toBe(true);
    expect(pending.timelineOrder).toEqual([]);
    expect(pending.messagesById.old).toBeUndefined();

    act(() => useRuntimeStore.getState().applyEvents([{
      type: 'state.changed', state: { ...initial, sessionOperation: true }, messagesIncluded: false, timestamp: 2,
    }]));
    expect(useRuntimeStore.getState().runtime.sessionId).toBe('s2');

    await act(async () => { finishSwitch?.(switched); await Promise.resolve(); });
    expect(useRuntimeStore.getState().runtime.sessionId).toBe('s2');
    expect(useRuntimeStore.getState().messagesById.new?.text).toBe('New conversation');
  });

  it('wraps every rendered session-row action in a tooltip trigger', () => {
    const { container } = render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    const actionGroups = [...container.querySelectorAll('.session-row-actions')];
    expect(actionGroups).toHaveLength(2);
    for (const group of actionGroups) {
      const actions = [...group.children];
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) expect(action).toHaveAttribute('data-state', 'closed');
    }
    expect(screen.getByRole('button', { name: /^First/u }).closest('.tooltip-trigger')).not.toBeNull();
  });

  it.each([
    ['Create new session from latest prompt in First', 'Branch from latest prompt'],
    ['Create an isolated Git worktree session from First', 'Create isolated Git worktree'],
    ['Clone First', 'Clone session'],
    ['Compact First', 'Compact session context'],
    ['Rename First', 'Rename session'],
    ['Delete Second', 'Delete session'],
  ])('shows useful hover copy for the %s action', async (accessibleName, tooltipCopy) => {
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    const button = screen.getByRole('button', { name: accessibleName });
    const tooltipTrigger = button.closest<HTMLElement>('.tooltip-trigger');
    expect(tooltipTrigger).not.toBeNull();
    await user.hover(tooltipTrigger!);

    expect(await screen.findByRole('tooltip')).toHaveTextContent(tooltipCopy);
  });

  it('shows the full session title to the right and includes branch plus relative activity', async () => {
    useWorkspaceStore.setState({
      git: { repository: true, branch: 'fate/session-feedback', upstream: null, pushTarget: null, ahead: 0, behind: 0, changes: [], additions: 0, deletions: 0, truncated: false },
    });
    const user = userEvent.setup();
    const { container } = render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    const openSecond = screen.getByRole('button', { name: /^Second/u });
    expect(openSecond).toHaveTextContent(/fate\/session-feedback.*updated.*ago/u);
    expect(openSecond.querySelector('time')).toHaveAttribute('dateTime', '2025-01-02T00:00:00.000Z');
    await user.hover(openSecond.closest<HTMLElement>('.tooltip-trigger')!);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Second');
    expect(container.querySelector('.session-drag-handle')).not.toBeInTheDocument();
    expect(openSecond.closest('.session-row')).toHaveAttribute('draggable', 'true');
  });

  it('presents semantic conversation paths and switches history without exposing raw SDK entries', async () => {
    const branches = [
      { id: 'current-leaf', parentId: 'root', depth: 4, label: 'current', preview: 'Current implementation response', kind: 'message', active: true },
      { id: 'alternate-leaf', parentId: 'root', depth: 7, label: 'message', preview: 'Alternative implementation response', kind: 'custom', active: false },
    ];
    const initial = ready({ branches });
    const switched = ready({
      branches: branches.map((branch) => ({ ...branch, active: branch.id === 'alternate-leaf' })),
      messages: [{ id: 'alternate-message', role: 'assistant', text: 'Alternative implementation response', timestamp: 2 }],
    });
    useRuntimeStore.getState().hydrateRuntime(initial);
    const navigateSessionBranch = vi.fn(async () => ({ state: switched, selectedText: 'Continue from this prompt' }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { navigateSessionBranch } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    const paths = screen.getByRole('list', { name: 'Conversation paths' });
    expect(paths.closest('.session-row-with-paths')).not.toBeNull();
    expect(paths.closest('.folder-group')).toHaveClass('folder-group--active');
    expect(paths.closest('.folder-group')).toContainElement(screen.getByRole('button', { name: 'Create an isolated Git worktree session from First' }));
    expect(paths.previousElementSibling).toHaveClass('session-row');
    // Only forks render — the active branch (the main session) is never
    // duplicated as a "Current path" row. No "Fork"/"Worktree" label text.
    expect(paths.querySelectorAll('.session-row--path')).toHaveLength(1);
    expect(paths).toHaveTextContent('Alternative implementation response');
    expect(paths).not.toHaveTextContent('Current path');
    expect(paths).not.toHaveTextContent('Alternate path');
    expect(paths).not.toHaveTextContent(/^Fork$/u);
    expect(paths).not.toHaveTextContent(/^Branches$/u);
    expect(paths).not.toHaveTextContent('custom');

    await user.click(screen.getByRole('button', { name: /Switch to fork: Alternative implementation response/u }));

    await waitFor(() => expect(navigateSessionBranch).toHaveBeenCalledWith('alternate-leaf'));
    await waitFor(() => expect(useRuntimeStore.getState().runtime.branches?.find((branch) => branch.id === 'alternate-leaf')?.active).toBe(true));
    expect(useUiStore.getState().composerDraftRequest).toMatchObject({ text: 'Continue from this prompt', selectAll: true });
    expect(useUiStore.getState().toast).toMatchObject({ kind: 'success', title: 'Conversation path switched' });
  });

  it('confirms and deletes an inactive conversation fork without selecting it first', async () => {
    const branches = [
      { id: 'current-leaf', parentId: 'root', depth: 1, label: 'current', preview: 'Current path', kind: 'message', active: true },
      { id: 'alternate-leaf', parentId: 'root', depth: 2, label: 'message', preview: 'Forked path', kind: 'custom', active: false },
    ];
    useRuntimeStore.getState().hydrateRuntime(ready({ branches }));
    const deleteSessionBranch = vi.fn(async () => ({ state: ready({ branches: [branches[0]!] }) }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { deleteSessionBranch } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Actions for Forked path' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete fork for Forked path' }));
    expect(screen.getByRole('group', { name: 'Confirm deleting fork: Forked path' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteSessionBranch).toHaveBeenCalledWith('alternate-leaf'));
    expect(useUiStore.getState().toast).toMatchObject({ kind: 'success', title: 'Fork deleted' });
  });

  it('uses compact session density for conversation path rows too', () => {
    useUiStore.setState({ compactSessions: true });
    const branches = [
      { id: 'current-leaf', parentId: 'root', depth: 1, label: 'current', preview: 'Current path', kind: 'message', active: true },
      { id: 'alternate-leaf', parentId: 'root', depth: 2, label: 'message', preview: 'Forked path', kind: 'custom', active: false },
    ];
    useRuntimeStore.getState().hydrateRuntime(ready({ branches }));
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    const paths = screen.getByRole('list', { name: 'Conversation paths' });
    expect(paths).toHaveClass('session-path-list--compact');
    // Only the fork renders (active branch is the main session, not duplicated).
    expect(paths.querySelectorAll('.session-row--path')).toHaveLength(1);
    expect(paths.querySelector('.session-row--path')).toHaveClass('session-row--path');
    expect(paths).toHaveTextContent('Forked path');
    expect(paths).not.toHaveTextContent('Current path');
  });

  it('keeps the Settings control as a tooltip-wrapped icon beside sidebar collapse', () => {
    const { container } = render(<Sidebar collapsed onToggle={vi.fn()} />);
    const settings = screen.getByRole('button', { name: 'Settings' });
    expect(settings).toHaveClass('sidebar-settings-button');
    expect(settings.closest('.sidebar-settings-tooltip')).toBe(container.querySelector('.sidebar-settings-tooltip'));
  });

  it('keeps rename and delete confirmation controls hoverable', async () => {
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Rename First' }));
    for (const name of ['Save session name', 'Cancel rename']) {
      expect(screen.getByRole('button', { name }).closest('.tooltip-trigger')).not.toBeNull();
    }
    await user.click(screen.getByRole('button', { name: 'Cancel rename' }));
    await user.click(screen.getByRole('button', { name: 'Delete Second' }));
    for (const name of ['Delete', 'Cancel']) {
      expect(screen.getByRole('button', { name }).closest('.tooltip-trigger')).not.toBeNull();
    }
  });

  it('keeps a disabled session action hoverable and explains why it is unavailable', async () => {
    useRuntimeStore.getState().setRuntime(ready({
      sessions: [session('s1', 'First', true), session('s2', 'Second', false, 'running')],
    }));
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    const clone = screen.getByRole('button', { name: 'Clone Second' });
    expect(clone).toBeDisabled();
    const tooltipTrigger = clone.closest<HTMLElement>('.tooltip-trigger');
    expect(tooltipTrigger).not.toBeNull();
    await user.hover(tooltipTrigger!);

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Wait for “Second” to finish');
  });

  it('does not let a background running count lock actions for the idle selected session', async () => {
    const state = ready({
      activeSessionRunning: false,
      runningSessionCount: 1,
      sessions: [session('s1', 'First', true), session('s2', 'Second', false, 'running')],
    });
    useRuntimeStore.getState().setRuntime(state);
    const cloneSession = vi.fn(async () => state);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { cloneSession } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Create new session from latest prompt in First' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Create an isolated Git worktree session from First' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clone First' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Clone Second' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete Second' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Rename Second' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Clone First' }));
    await waitFor(() => expect(cloneSession).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rename Second' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Rename Second' }));
    expect(screen.getByRole('textbox', { name: 'Rename Second' })).toHaveValue('Second');
  });

  it('does not let an older navigation response overwrite a newer selected session', async () => {
    let finishSwitch: ((state: RuntimeState) => void) | undefined;
    const stale = ready({
      sessionId: 's2',
      sessions: [session('s1', 'First', false), session('s2', 'Second', true)],
    });
    const switchSession = vi.fn(() => new Promise<RuntimeState>((resolve) => { finishSwitch = resolve; }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { switchSession } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /^Second/u }));
    expect(switchSession).toHaveBeenCalledOnce();
    const newer = ready({
      sessionId: 's3',
      sessions: [session('s1', 'First', false), session('s2', 'Second', false), session('s3', 'Third', true)],
    });
    act(() => useRuntimeStore.getState().setRuntime(newer));
    await act(async () => { finishSwitch?.(stale); await Promise.resolve(); });

    expect(useRuntimeStore.getState().runtime.sessionId).toBe('s3');
  });

  it('shows each inactive attention state with an accessible label and suppresses active attention', () => {
    useRuntimeStore.getState().setRuntime(ready({
      sessions: [
        session('s1', 'Active', true, 'error'),
        session('s2', 'Running', false, 'running'),
        session('s3', 'Completed', false, 'completed'),
        session('s4', 'Errored', false, 'error'),
      ],
    }));
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    expect(screen.getByLabelText('Session running')).toHaveAttribute('data-attention', 'running');
    expect(screen.getByLabelText('Session completed — new activity')).toHaveAttribute('data-attention', 'completed');
    expect(screen.getByLabelText('Session error — needs attention')).toHaveAttribute('data-attention', 'error');
    expect(document.querySelectorAll('.session-attention-dot')).toHaveLength(3);
  });

  it('keeps attention fresh while a session search is active', async () => {
    const initial = ready({ sessions: [session('s1', 'First', true), session('s2', 'Second', false, 'running')] });
    useRuntimeStore.getState().setRuntime(initial);
    const listSessions = vi.fn(async () => [session('s2', 'Second', false, 'running')]);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { listSessions } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    await user.type(screen.getByLabelText('Search sessions'), 'second');
    await waitFor(() => expect(listSessions).toHaveBeenCalledWith('second'));
    expect(screen.getByLabelText('Session running')).toBeInTheDocument();

    act(() => useRuntimeStore.getState().setRuntime({
      ...initial,
      sessions: [session('s1', 'First', true), session('s2', 'Second', false, 'error')],
    }));
    await waitFor(() => expect(screen.getByLabelText('Session error — needs attention')).toBeInTheDocument());
    expect(screen.queryByLabelText('Session running')).not.toBeInTheDocument();
  });

  it('orders the persistent navigator by workflow and centers the empty Automations state', async () => {
    const user = userEvent.setup();
    const { container } = render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Sessions', 'Automations', 'Resources']);
    expect(screen.getByRole('tab', { name: 'Sessions' })).toHaveAttribute('aria-selected', 'true');

    await user.click(screen.getByRole('tab', { name: 'Automations' }));
    expect(screen.getByRole('searchbox', { name: 'Search automations' })).toBeInTheDocument();
    expect(screen.getByText('No automations yet')).toBeInTheDocument();
    expect(container.querySelector('.automation-list')).not.toBeInTheDocument();
    expect(useUiStore.getState().sidebarTab).toBe('automations');

    await user.click(screen.getByRole('tab', { name: 'Resources' }));
    expect(screen.getByRole('searchbox', { name: 'Search resources' })).toBeInTheDocument();
    expect(useUiStore.getState().sidebarTab).toBe('resources');
  });

  it('searches the confined filesystem and opens a real Files preview from Resources', async () => {
    const searchFiles = vi.fn(async () => ({ entries: [{ path: 'src/App.tsx', name: 'App.tsx', kind: 'file' as const, symlink: false }], truncated: false }));
    const listFiles = vi.fn(async () => ({ path: '', entries: [], truncated: false }));
    const readFile = vi.fn(async () => ({ path: 'src/App.tsx', name: 'App.tsx', size: 12, state: 'text' as const, content: 'export {}', language: 'typescript', openable: true }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { searchFiles, listFiles, readFile } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    await user.click(screen.getByRole('tab', { name: 'Resources' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search resources' }), 'app');
    await waitFor(() => expect(searchFiles).toHaveBeenCalledWith('app', 40));
    await user.click(await screen.findByRole('button', { name: /App\.tsx/u }));

    await waitFor(() => expect(readFile).toHaveBeenCalledWith('src/App.tsx'));
    expect(useUiStore.getState()).toMatchObject({ inspectorTab: 'files', inspectorCollapsed: false });
    expect(useWorkspaceStore.getState().selectedFile).toBe('src/App.tsx');
  });

  it('activates real Browser tabs without changing grants or resuming agent control', async () => {
    const browserState = {
      activeTabId: 'tab-1', visible: false, viewBlocked: false, sessionFullAccess: false,
      controlLevel: 'observe' as const, mode: 'agent' as const, grants: [],
      tabs: [{ id: 'tab-1', profileId: 'project', url: 'https://example.test/auth', title: 'Auth callback', loading: false, canGoBack: false, canGoForward: false, documentEpoch: 1, semanticAvailable: true }],
    };
    useBrowserStore.getState().hydrate(browserState, '/project');
    const activateBrowserTab = vi.fn(async () => browserState);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { activateBrowserTab } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    await user.click(screen.getByRole('tab', { name: 'Resources' }));
    await user.click(screen.getByRole('button', { name: /Auth callback/u }));

    await waitFor(() => expect(activateBrowserTab).toHaveBeenCalledWith('tab-1'));
    expect(useUiStore.getState().browserOpen).toBe(true);
    expect(useBrowserStore.getState().state).toMatchObject({ controlLevel: 'observe', grants: [] });
  });

  it('shows one Pi Library launcher without duplicating its contents as a category', async () => {
    useRuntimeStore.getState().setRuntime(ready({ commands: [{ name: 'review', description: 'Review current changes', source: 'prompt' }] }));
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    await user.click(screen.getByRole('tab', { name: 'Resources' }));
    const launchers = screen.getAllByRole('button', { name: /^Pi Library/u });
    expect(launchers).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /\/review/u })).not.toBeInTheDocument();
    await user.click(launchers[0]!);

    expect(useUiStore.getState()).toMatchObject({ inspectorTab: 'resources', inspectorCollapsed: false });
  });

  it('opens the exact automation editor requested by a resource deep link', async () => {
    const definition = {
      id: '00000000-0000-4000-8000-000000000001', projectPath: '/project', name: 'Review auth', prompt: 'Review authentication changes.',
      permissionLevel: 'read-only' as const, createdAt: 1, updatedAt: 1, lastLaunchedAt: null, lastLaunchOutcome: null, launchCount: 0,
    };
    const listAutomations = vi.fn(async () => [definition]);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { listAutomations } as unknown as PiDesktopApi });
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);
    await waitFor(() => expect(useAutomationStore.getState().items).toHaveLength(1));

    act(() => useUiStore.getState().openAutomation('/another-project', definition.id));
    await waitFor(() => expect(useUiStore.getState().automationOpenRequest).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'Edit automation' })).not.toBeInTheDocument();

    act(() => useUiStore.getState().openAutomation('/project', definition.id));

    await waitFor(() => expect(useUiStore.getState().sidebarTab).toBe('automations'));
    const editor = await screen.findByRole('dialog', { name: 'Edit automation' });
    expect(editor).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Review auth');
    expect(useUiStore.getState().automationOpenRequest).toBeNull();
  });

  it('opens a saved automation in a renamed permission-scoped session without auto-sending', async () => {
    const definition = {
      id: '00000000-0000-4000-8000-000000000001', projectPath: '/project', name: 'Review auth', prompt: 'Review authentication changes.',
      permissionLevel: 'read-only' as const, createdAt: 1, updatedAt: 1, lastLaunchedAt: null, lastLaunchOutcome: null, launchCount: 0,
    };
    const scoped = ready({ sessionId: 's3', sessionFile: '/sessions/s3.jsonl', permissionLevel: 'read-only', sessions: [session('s3', 'Review auth', true)] });
    const launched = { ...definition, launchCount: 1, lastLaunchedAt: 2, lastLaunchOutcome: 'accepted' as const };
    const listAutomations = vi.fn().mockResolvedValueOnce([definition]).mockResolvedValue([launched]);
    const prepareAutomationSession = vi.fn(async () => ({ state: scoped, automation: launched }));
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: { listAutomations, prepareAutomationSession } as unknown as PiDesktopApi,
    });
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    await user.click(screen.getByRole('tab', { name: 'Automations' }));
    await user.click(await screen.findByRole('button', { name: /^Review auth/u }));

    await waitFor(() => expect(prepareAutomationSession).toHaveBeenCalledWith(definition.id));
    expect(useRuntimeStore.getState().runtime).toMatchObject({ sessionId: 's3', permissionLevel: 'read-only' });
    expect(useUiStore.getState().composerDraftRequest).toMatchObject({
      text: 'Review authentication changes.', mode: 'replace', selectAll: true,
    });
    expect(useUiStore.getState().sidebarTab).toBe('sessions');
  });

  it('groups sessions under project folders and previews other folders from disk', async () => {
    useProjectStore.setState({
      projects: [{ path: '/project', name: 'project' }, { path: '/other', name: 'other' }],
      expandedByPath: { '/project': true, '/other': true },
    });
    const otherSession = session('o1', 'Other session', false);
    const listProjectSessions = vi.fn(async () => [otherSession]);
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: { listProjectSessions } as unknown as PiDesktopApi,
    });
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Collapse project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse other' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Second/u })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^Other session/u })).toBeInTheDocument();
    expect(listProjectSessions).toHaveBeenCalledWith('/other');
  });

  it('does not reserve the full sidebar height for a collapsed active folder', () => {
    const other = { path: '/other', name: 'other' };
    useProjectStore.setState({
      projects: [{ path: '/project', name: 'project' }, other],
      expandedByPath: { '/project': false, '/other': false },
    });
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    const activeGroup = screen.getByRole('button', { name: 'Expand project' }).closest('.folder-group');
    expect(activeGroup).toHaveClass('folder-group--active');
    expect(activeGroup).not.toHaveClass('folder-group--expanded');
    expect(screen.getByRole('button', { name: 'Expand other' }).closest('.folder-group')).not.toHaveClass('folder-group--active');
  });

  it('hides session rows while a folder is collapsed but keeps its count chip', () => {
    useRuntimeStore.getState().setRuntime(ready({
      sessionId: 'active',
      sessions: [
        session('active', 'Active work', true),
        session('running', 'Background run', false, 'running'),
        session('unread', 'Unread result', false, 'completed'),
        session('failed', 'Failed run', false, 'error'),
        session('idle', 'Idle history', false),
      ],
    }));
    useProjectStore.setState({ projects: [{ path: '/project', name: 'project' }], expandedByPath: { '/project': false } });
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    // Collapsed: no session rows surface (collapsed folders stay quiet), but
    // the count chip still reflects the total session count.
    expect(screen.queryByRole('group', { name: 'Active sessions in project' })).not.toBeInTheDocument();
    expect(screen.queryByText('Active work')).not.toBeInTheDocument();
    expect(screen.queryByText('Background run')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'project 5' })).toBeInTheDocument();
  });

  it('bounds large background caches without dropping the exact count chip', async () => {
    useProjectStore.setState({
      projects: [{ path: '/project', name: 'project' }, { path: '/other', name: 'other' }],
      expandedByPath: { '/project': true, '/other': false },
    });
    const items = Array.from({ length: 300 }, (_value, index) => session(
      `other-${index}`,
      index === 299 ? 'Critical unread' : `Archived ${index}`,
      false,
      index === 299 ? 'completed' : undefined,
    ));
    const listProjectSessions = vi.fn(async () => items);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { listProjectSessions } as unknown as PiDesktopApi });
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    // Collapsed: no session rows surface, but the count chip still shows the
    // exact total read from disk.
    await waitFor(() => expect(listProjectSessions).toHaveBeenCalledWith('/other'));
    expect(screen.queryByRole('group', { name: 'Active sessions in other' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'other 300' })).toBeInTheDocument();
  });

  it('invalidates a pending preview request when the sidebar refreshes', async () => {
    useProjectStore.setState({
      projects: [{ path: '/project', name: 'project' }, { path: '/other', name: 'other' }],
      expandedByPath: { '/project': true, '/other': true },
    });
    let resolveOld!: (items: SessionSummary[]) => void;
    let resolveFresh!: (items: SessionSummary[]) => void;
    const listProjectSessions = vi.fn()
      .mockImplementationOnce(() => new Promise<SessionSummary[]>((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise<SessionSummary[]>((resolve) => { resolveFresh = resolve; }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { listProjectSessions } as unknown as PiDesktopApi });
    const { rerender } = render(<Sidebar collapsed={false} onToggle={vi.fn()} />);
    await waitFor(() => expect(listProjectSessions).toHaveBeenCalledTimes(1));

    rerender(<Sidebar collapsed onToggle={vi.fn()} />);
    rerender(<Sidebar collapsed={false} onToggle={vi.fn()} />);
    await waitFor(() => expect(listProjectSessions).toHaveBeenCalledTimes(2));
    resolveFresh([session('fresh', 'Fresh preview', false)]);
    expect(await screen.findByRole('button', { name: /^Fresh preview/u })).toBeInTheDocument();
    resolveOld([session('old', 'Stale preview', false)]);
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Stale preview/u })).not.toBeInTheDocument());
  });

  it('hides session rows for a collapsed background folder but still reads its count from disk', async () => {
    useProjectStore.setState({
      projects: [{ path: '/project', name: 'project' }, { path: '/other', name: 'other' }],
      expandedByPath: { '/project': true, '/other': false },
    });
    const listProjectSessions = vi.fn(async () => [
      session('other-active', 'Other active', true),
      session('other-unread', 'Other unread', false, 'completed'),
      session('other-idle', 'Other idle', false),
    ]);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { listProjectSessions } as unknown as PiDesktopApi });
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    await waitFor(() => expect(listProjectSessions).toHaveBeenCalledWith('/other'));
    // Collapsed: no session rows surface.
    expect(screen.queryByRole('group', { name: 'Active sessions in other' })).not.toBeInTheDocument();
    expect(screen.queryByText('Other active')).not.toBeInTheDocument();
    expect(screen.queryByText('Other unread')).not.toBeInTheDocument();
    // The count chip still reflects the disk total.
    expect(await screen.findByRole('button', { name: 'other 3' })).toBeInTheDocument();
  });

  it('opens the active folder and reveals its sessions when its name is clicked', async () => {
    useProjectStore.setState({
      projects: [{ path: '/project', name: 'project' }],
      expandedByPath: { '/project': false },
    });
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    const folder = screen.getByRole('button', { name: 'project 2' });
    expect(folder).toBeEnabled();
    await user.click(folder);

    expect(screen.getByRole('button', { name: 'Collapse project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^First/u })).toBeInTheDocument();
  });

  it('renders compact one-line rows with a per-session actions menu', async () => {
    useUiStore.setState({ compactSessions: true });
    const switchSession = vi.fn(async () => ready());
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: { switchSession } as unknown as PiDesktopApi,
    });
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    expect(screen.getAllByRole('button', { name: /Actions for /u }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/messages · updated/u)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Actions for Second' }));
    expect(await screen.findByRole('menuitem', { name: 'Clone Second' })).toBeInTheDocument();
  });

  it('routes a foreign folder focus through focusProject when the bridge is available', async () => {
    const other = { path: '/other', name: 'other' };
    useProjectStore.setState({ projects: [{ path: '/project', name: 'project' }, other], expandedByPath: { '/project': true, '/other': false } });
    const focused = ready({ status: 'disconnected', project: { ...other, trusted: true }, sessionId: null, sessions: [] });
    const focusProject = vi.fn(async () => focused);
    const openProject = vi.fn(async () => ready({ project: { ...other, trusted: true } }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { focusProject, openProject } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /^other$/u }));
    await waitFor(() => expect(focusProject).toHaveBeenCalledWith('/other'));
    expect(openProject).not.toHaveBeenCalled();
    expect(useRuntimeStore.getState().runtime.project?.path).toBe('/other');
  });

  it('uses the same compact preview-style rows for the active and inactive folders in compact mode', async () => {
    useUiStore.setState({ compactSessions: true });
    const project = { path: '/project', name: 'project' };
    const other = { path: '/other', name: 'other' };
    useProjectStore.setState({ projects: [project, other], expandedByPath: { '/project': true, '/other': true } });
    useRuntimeStore.getState().setRuntime(ready({
      project: { ...project, trusted: true },
      sessions: [session('p1', 'Project one', true), session('p2', 'Project two', false)],
    }));
    const listProjectSessions = vi.fn(async (path: string) => path === '/other' ? [session('o1', 'Other one', false)] : []);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { listProjectSessions } as unknown as PiDesktopApi });
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    // Both folders render the unified preview row class with title + meta, so
    // gaining/losing focus does not visibly change the row design.
    await waitFor(() => expect(screen.getByText('Other one')).toBeInTheDocument());
    const activeRows = document.querySelectorAll('section.folder-group--active .session-row--preview');
    const inactiveRows = document.querySelectorAll('section:not(.folder-group--active) .session-row--preview');
    expect(activeRows.length).toBeGreaterThan(0);
    expect(inactiveRows.length).toBeGreaterThan(0);
    expect(activeRows[0]).toHaveClass('session-row--preview');
    expect(inactiveRows[0]).toHaveClass('session-row--preview');
  });

  it('keeps the outgoing folder\'s sessions and does not reload them when focus moves to another folder', async () => {
    const project = { path: '/project', name: 'project' };
    const other = { path: '/other', name: 'other' };
    useProjectStore.setState({ projects: [project, other], expandedByPath: { '/project': true, '/other': true } });
    // /project is active with two live sessions visible.
    useRuntimeStore.getState().setRuntime(ready({
      project: { ...project, trusted: true },
      sessions: [session('p1', 'Project one', true), session('p2', 'Project two', false)],
    }));
    const otherState = ready({ project: { ...other, trusted: true }, sessions: [session('o1', 'Other one', true)] });
    const focusProject = vi.fn(async () => otherState);
    const listProjectSessions = vi.fn(async () => [session('o1', 'Other one', false)]);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { focusProject, listProjectSessions } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /^other$/u }));
    await waitFor(() => expect(useRuntimeStore.getState().runtime.project?.path).toBe('/other'));

    // The outgoing /project folder keeps showing the sessions it just had
    // (seeded from its live list) and is NOT re-fetched from disk on the switch.
    expect(screen.getByText('Project one')).toBeInTheDocument();
    expect(screen.getByText('Project two')).toBeInTheDocument();
    expect(listProjectSessions).not.toHaveBeenCalledWith('/project');
  });

  it('keeps showing a folder\'s cached sessions while its agent re-spawns (initializing), instead of collapsing to "Loading…"', async () => {
    const project = { path: '/project', name: 'project' };
    const other = { path: '/other', name: 'other' };
    useProjectStore.setState({ projects: [project, other], expandedByPath: { '/project': true, '/other': true } });
    // Start with /other active so /project is a background folder whose disk
    // sessions get cached into the preview store.
    useRuntimeStore.getState().setRuntime(ready({ project: { ...other, trusted: true }, sessionId: 'o1', sessions: [session('o1', 'Other', true)] }));
    const listProjectSessions = vi.fn(async (path: string) => path === '/project'
      ? [session('p1', 'Project one', false), session('p2', 'Project two', false)]
      : []);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { listProjectSessions } as unknown as PiDesktopApi });
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    // Wait for /project's background preview to load.
    await waitFor(() => expect(screen.getByText('Project one')).toBeInTheDocument());

    // Now focus /project and simulate its Pi runtime re-spawning: active,
    // status 'initializing', and an empty in-memory session list. The cached
    // preview must keep showing instead of vanishing into "Loading…".
    useRuntimeStore.getState().setRuntime(ready({
      project: { ...project, trusted: true },
      status: 'initializing',
      sessionId: null,
      sessionFile: null,
      sessions: [],
    }));

    expect(screen.getByText('Project one')).toBeInTheDocument();
    expect(screen.getByText('Project two')).toBeInTheDocument();
    expect(screen.queryByText('Loading sessions…')).not.toBeInTheDocument();
  });

  it('closes a background runtime before forgetting its folder', async () => {
    const other = { path: '/other', name: 'other' };
    useProjectStore.setState({ projects: [{ path: '/project', name: 'project' }, other], expandedByPath: { '/project': true, '/other': false } });
    const closeProjectRuntime = vi.fn(async () => undefined);
    const listProjectSessions = vi.fn(async () => []);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { closeProjectRuntime, listProjectSessions } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Actions for other' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Forget folder' }));
    await waitFor(() => expect(closeProjectRuntime).toHaveBeenCalledWith('/other'));
    await waitFor(() => expect(useProjectStore.getState().projects.map((project) => project.path)).toEqual(['/project']));
  });

  it('keeps a folder visible when its runtime cannot be closed', async () => {
    const other = { path: '/other', name: 'other' };
    useProjectStore.setState({ projects: [{ path: '/project', name: 'project' }, other], expandedByPath: { '/project': true, '/other': false } });
    const closeProjectRuntime = vi.fn(async () => { throw new Error('still busy'); });
    const listProjectSessions = vi.fn(async () => []);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { closeProjectRuntime, listProjectSessions } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Actions for other' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Forget folder' }));
    await waitFor(() => expect(useUiStore.getState().toast).toMatchObject({ kind: 'error', title: 'Could not forget folder' }));
    expect(useProjectStore.getState().projects.map((project) => project.path)).toEqual(['/project', '/other']);
  });

  it('promotes a focused disk preview to a live runtime before opening its session', async () => {
    const other = { path: '/other', name: 'other', trusted: true };
    const target = session('other-session', 'Other session', true);
    useRuntimeStore.getState().setRuntime(ready({ status: 'disconnected', project: other, sessionId: null, sessionFile: null, sessions: [target] }));
    useProjectStore.setState({ projects: [other], expandedByPath: { '/other': true } });
    const opened = ready({ project: other, sessionId: 'default', sessions: [session('default', 'Default', true), { ...target, active: false }] });
    const switched = ready({ project: other, sessionId: target.id, sessions: [{ ...target, active: true }] });
    const openProject = vi.fn(async () => opened);
    const switchSession = vi.fn(async () => switched);
    const listProjectSessions = vi.fn(async () => [target]);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { openProject, switchSession, listProjectSessions } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /^Other session/u }));
    await waitFor(() => expect(openProject).toHaveBeenCalledWith('/other'));
    await waitFor(() => expect(switchSession).toHaveBeenCalledWith(target.id));
    expect(useRuntimeStore.getState().runtime.sessionId).toBe(target.id);
  });

  it('searches a focused disk preview through the project-scoped listing API', async () => {
    const other = { path: '/other', name: 'other', trusted: true };
    const target = session('match', 'Matching preview', false);
    useRuntimeStore.getState().setRuntime(ready({ status: 'disconnected', project: other, sessionId: null, sessionFile: null, sessions: [session('cached', 'Cached preview', true)] }));
    useProjectStore.setState({ projects: [other], expandedByPath: { '/other': true } });
    const listProjectSessions = vi.fn(async () => [target]);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { listProjectSessions } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    await user.type(screen.getByRole('searchbox', { name: 'Search sessions' }), 'match');
    await waitFor(() => expect(listProjectSessions).toHaveBeenCalledWith('/other', 'match'));
    expect(screen.getByRole('button', { name: /^Matching preview/u })).toBeInTheDocument();
  });

  it('opens a foreign preview session without reordering folders or painting an intermediate session', async () => {
    const other = { path: '/other', name: 'other' };
    useProjectStore.setState({ projects: [{ path: '/project', name: 'project' }, other], expandedByPath: { '/project': true, '/other': true } });
    const target = session('other-session', 'Other session', false, 'running');
    const opened = ready({ project: { ...other, trusted: true }, sessionId: 'other-default', sessions: [session('other-default', 'Default', true), target] });
    const switched = ready({ project: { ...other, trusted: true }, sessionId: target.id, sessions: [session('other-default', 'Default', false), session(target.id, target.title, true, 'running')] });
    let finishSwitch!: (state: RuntimeState) => void;
    const openProject = vi.fn(async () => opened);
    const switchSession = vi.fn(() => new Promise<RuntimeState>((resolve) => { finishSwitch = resolve; }));
    const listProjectSessions = vi.fn(async () => [target]);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { openProject, switchSession, listProjectSessions } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    const { container } = render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    expect(await screen.findByRole('img', { name: 'Session running' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Other session/u }));
    await waitFor(() => expect(openProject).toHaveBeenCalledWith('/other'));
    await waitFor(() => expect(switchSession).toHaveBeenCalledWith(target.id));
    expect(useRuntimeStore.getState().runtime.project?.path).toBe('/project');
    expect(useRuntimeStore.getState().runtime.sessionId).toBe('s1');

    finishSwitch(switched);
    await waitFor(() => expect(useRuntimeStore.getState().runtime.sessionId).toBe(target.id));
    expect(useProjectStore.getState().projects.map((project) => project.path)).toEqual(['/project', '/other']);
    const folderButtons = [...container.querySelectorAll<HTMLElement>('.folder-open')];
    expect(folderButtons.map((button) => button.querySelector('.folder-name')?.textContent)).toEqual(['project', 'other']);
    expect(folderButtons[0]).not.toHaveAttribute('aria-current');
    expect(folderButtons[1]).toHaveAttribute('aria-current', 'true');
    expect(container.querySelector('.folder-group--active .folder-name')).toHaveTextContent('other');
  });

  it('applies the returned state when creating a session in a foreign folder', async () => {
    const other = { path: '/other', name: 'other' };
    useProjectStore.setState({ projects: [{ path: '/project', name: 'project' }, other], expandedByPath: { '/project': true, '/other': true } });
    const opened = ready({ project: { ...other, trusted: true }, sessionId: 'other-default', sessions: [session('other-default', 'Default', true)] });
    const created = ready({ project: { ...other, trusted: true }, sessionId: 'other-new', sessions: [session('other-new', 'New session', true)] });
    const openProject = vi.fn(async () => opened);
    const newSession = vi.fn(async () => created);
    const listProjectSessions = vi.fn(async () => []);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { openProject, newSession, listProjectSessions } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'New session in other' }));
    await waitFor(() => expect(openProject).toHaveBeenCalledWith('/other'));
    await waitFor(() => expect(newSession).toHaveBeenCalledOnce());
    expect(useRuntimeStore.getState().runtime.project?.path).toBe('/other');
    expect(useRuntimeStore.getState().runtime.sessionId).toBe('other-new');
  });
});
