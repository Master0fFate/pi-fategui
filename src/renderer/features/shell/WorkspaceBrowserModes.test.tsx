import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserState, PiDesktopApi } from '../../../shared/contracts/ipc';
import { useBrowserStore } from '../../stores/browserStore';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { Workspace } from './Workspace';

vi.mock('../browser/BrowserWorkspace', () => ({ BrowserWorkspace: () => <div data-testid="browser-workspace">Browser surface</div> }));
vi.mock('../chat/Composer', () => ({ Composer: () => <div data-testid="composer">Composer surface</div> }));
vi.mock('../chat/ConversationTimeline', () => ({ ConversationTimeline: () => <div>Conversation timeline</div> }));
vi.mock('../chat/ExtensionStatusRail', () => ({ ExtensionStatusRail: () => null }));
vi.mock('./WorkspaceActivityPulse', () => ({ WorkspaceActivityPulse: () => null }));

const browserState = (overrides: Partial<BrowserState> = {}): BrowserState => ({
  activeTabId: null,
  visible: false,
  viewBlocked: false,
  sessionFullAccess: false,
  controlLevel: 'off',
  mode: 'agent',
  tabs: [],
  grants: [],
  ...overrides,
});

describe('Workspace built-in browser', () => {
  beforeEach(() => {
    useRuntimeStore.setState((current) => ({
      ...current,
      runtime: {
        ...current.runtime,
        status: 'ready', sessionId: 'session-1', project: { path: '/project', name: 'project', trusted: true },
        messages: [], error: null,
      },
      timelineOrder: [],
      lastError: null,
    }));
    useBrowserStore.getState().reset();
    useUiStore.setState({ browserOpen: false, browserPaneWidth: 520, terminalOpen: false });
  });

  afterEach(() => Reflect.deleteProperty(window, 'piDesktop'));

  it('opens beside the thread, keeps the composer mounted, and resizes the preview', () => {
    const setBrowserMode = vi.fn(async () => browserState({ controlLevel: 'interact' }));
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: { setBrowserMode } as unknown as PiDesktopApi,
    });

    render(<Workspace inspectorCollapsed={false} onToggleInspector={vi.fn()} />);
    expect(screen.getByTestId('composer')).toBeInTheDocument();
    expect(screen.queryByTestId('browser-workspace')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open browser' }));

    expect(setBrowserMode).toHaveBeenCalledWith('agent');
    expect(screen.getByTestId('browser-thread-layout')).toBeInTheDocument();
    expect(screen.getByTestId('browser-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('composer')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Chat' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Browser' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Split' })).not.toBeInTheDocument();

    const resize = screen.getByRole('separator', { name: 'Resize chat and browser' });
    fireEvent.keyDown(resize, { key: 'ArrowLeft' });
    expect(useUiStore.getState().browserPaneWidth).toBe(532);
    fireEvent.keyDown(resize, { key: 'ArrowRight' });
    expect(useUiStore.getState().browserPaneWidth).toBe(520);
  });

  it('closes the preview without pausing or hiding the browser automation', () => {
    useUiStore.setState({ browserOpen: true });
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {} as unknown as PiDesktopApi,
    });

    render(<Workspace inspectorCollapsed={false} onToggleInspector={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close browser' }));

    expect(useUiStore.getState().browserOpen).toBe(false);
    expect(screen.queryByTestId('browser-workspace')).not.toBeInTheDocument();
    expect(screen.getByTestId('composer')).toBeInTheDocument();
  });

  it('fails closed when the project is not trusted', () => {
    useRuntimeStore.setState((current) => ({
      runtime: { ...current.runtime, project: { path: '/project', name: 'project', trusted: false } },
    }));
    useUiStore.setState({ browserOpen: true });

    render(<Workspace inspectorCollapsed={false} onToggleInspector={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Open browser' })).toBeDisabled();
    expect(screen.getByTestId('composer')).toBeInTheDocument();
    expect(screen.queryByTestId('browser-workspace')).not.toBeInTheDocument();
  });
});
