import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiDesktopApi } from '../../../shared/contracts/ipc';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { Workspace } from './Workspace';

const renders = vi.hoisted(() => ({ composer: 0 }));

vi.mock('../browser/BrowserWorkspace', () => ({ BrowserWorkspace: () => <div /> }));
vi.mock('../chat/Composer', () => ({
  Composer: () => {
    renders.composer += 1;
    return <div data-testid="composer" />;
  },
}));
vi.mock('../chat/ConversationTimeline', () => ({ ConversationTimeline: () => <div /> }));
vi.mock('../chat/ExtensionStatusRail', () => ({ ExtensionStatusRail: () => null }));
vi.mock('./WorkspaceActivityPulse', () => ({ WorkspaceActivityPulse: () => null }));

describe('Workspace runtime subscriptions', () => {
  beforeEach(() => {
    useRuntimeStore.setState((current) => ({
      ...current,
      runtime: {
        ...current.runtime,
        status: 'ready',
        sessionId: 'session-1',
        project: { path: '/project-a', name: 'Project A', trusted: true },
        sessions: undefined,
        messages: [],
        error: null,
      },
      timelineOrder: [],
      lastError: null,
    }));
    useUiStore.setState({ browserOpen: false, terminalOpen: false });
    renders.composer = 0;
  });

  afterEach(() => Reflect.deleteProperty(window, 'piDesktop'));

  it('does not rerender workspace children for unrelated runtime metadata', () => {
    render(<Workspace inspectorCollapsed={false} onToggleInspector={vi.fn()} />);
    expect(renders.composer).toBe(1);

    act(() => useRuntimeStore.setState((current) => ({
      runtime: {
        ...current.runtime,
        extensionUi: { statuses: [], widgets: [], working: 'Indexing', title: null },
      },
    })));
    expect(renders.composer).toBe(1);

    act(() => useRuntimeStore.setState((current) => ({
      runtime: { ...current.runtime, project: { path: '/project-a', name: 'Project B', trusted: true } },
    })));
    expect(screen.getByText('Project B')).toBeInTheDocument();
    expect(renders.composer).toBe(2);

    act(() => useRuntimeStore.setState((current) => ({
      runtime: { ...current.runtime, project: { path: '/project-a', name: 'Project B', trusted: false } },
    })));
    expect(screen.getByRole('button', { name: 'Open browser' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open terminal' })).toBeDisabled();

    act(() => useRuntimeStore.setState((current) => ({
      runtime: {
        ...current.runtime,
        sessions: [{
          id: 'session-1',
          title: 'Focused session',
          firstMessage: '',
          path: '/session-1.jsonl',
          createdAt: '2025-01-01T00:00:00.000Z',
          modifiedAt: '2025-01-01T00:00:00.000Z',
          messageCount: 0,
          active: true,
        }],
      },
    })));
    expect(screen.getByText('Focused session')).toBeInTheDocument();
  });

  it('clears project-scoped reveal errors when project identity changes', async () => {
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: { revealProject: vi.fn().mockRejectedValue(new Error('Reveal failed')) } as unknown as PiDesktopApi,
    });
    render(<Workspace inspectorCollapsed={false} onToggleInspector={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show project in file browser' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Reveal failed');

    act(() => useRuntimeStore.setState((current) => ({
      runtime: { ...current.runtime, project: { path: '/project-b', name: 'Project B', trusted: true } },
    })));
    await waitFor(() => expect(screen.queryByText('Reveal failed')).not.toBeInTheDocument());
  });

  it('ignores a reveal failure that arrives after switching projects', async () => {
    let rejectReveal!: (reason: Error) => void;
    const revealProject = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectReveal = reject; }));
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: { revealProject } as unknown as PiDesktopApi,
    });
    render(<Workspace inspectorCollapsed={false} onToggleInspector={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show project in file browser' }));
    expect(revealProject).toHaveBeenCalledOnce();
    act(() => useRuntimeStore.setState((current) => ({
      runtime: { ...current.runtime, project: { path: '/project-b', name: 'Project B', trusted: true } },
    })));
    await act(async () => rejectReveal(new Error('Stale reveal failure')));

    expect(screen.queryByText('Stale reveal failure')).not.toBeInTheDocument();
  });
});
