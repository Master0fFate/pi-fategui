import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiDesktopApi, RuntimeState, SessionSummary } from '../../../shared/contracts/ipc';
import { useRuntimeStore } from '../../stores/runtimeStore';
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
  sessionCapabilities: { fork: true, clone: true, compact: true, import: true },
  sessionOperation: false,
  error: null,
  ...overrides,
});

describe('Sidebar sessions', () => {
  beforeEach(() => {
    localStorage.clear();
    useRuntimeStore.getState().setRuntime(ready());
    useWorkspaceStore.setState({ projectPath: '/project', git: null });
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

    const create = screen.getByRole('button', { name: 'New session' });
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

  it('lets the collapsed Settings tooltip wrapper fill the footer rail', () => {
    const { container } = render(<Sidebar collapsed onToggle={vi.fn()} />);
    const settings = screen.getByRole('button', { name: 'Settings' });
    expect(settings.closest('.tooltip-trigger')).toBe(container.querySelector('.sidebar-footer > .tooltip-trigger'));
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
});
