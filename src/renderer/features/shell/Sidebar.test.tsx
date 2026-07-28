import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiDesktopApi, RuntimeState, SessionSummary } from '../../../shared/contracts/ipc';
import { useRuntimeStore } from '../../stores/runtimeStore';
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
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'piDesktop');
  });

  it('keeps new-session and inactive-session navigation enabled while work streams, without enabling destructive actions', async () => {
    const state = ready({ streaming: true, runningSessionCount: 0 });
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
    expect(screen.getByRole('button', { name: 'Clone Second' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Compact Second' })).toBeDisabled();

    await user.click(openSecond);
    await waitFor(() => expect(switchSession).toHaveBeenCalledWith('s2'));
    await waitFor(() => expect(create).toBeEnabled());
    await user.click(create);
    await waitFor(() => expect(newSession).toHaveBeenCalledOnce());
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
