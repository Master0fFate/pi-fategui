import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiDesktopApi, PiEvent, RuntimeState } from '../../shared/contracts/ipc';
import { useRuntimeStore } from '../stores/runtimeStore';
import { useUiStore } from '../stores/uiStore';
import { App } from './App';

describe('first-launch shell', () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({ sidebarCollapsed: false, inspectorCollapsed: false, leftWidth: 264, rightWidth: 332 });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'piDesktop');
  });

  it('renders honest first-launch navigation and inspector tabs', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'What would you like Pi to do?' })).toBeInTheDocument();
    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Changes/ })).toBeInTheDocument();
    expect(screen.getByText('Ready to connect')).toBeInTheDocument();
  });

  it('collapses and restores both side panes', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Collapse inspector' }));
    expect(screen.queryByRole('complementary', { name: 'Project inspector' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open inspector' })).toBeInTheDocument();
  });

  it('resizes panes with keyboard-accessible separators', async () => {
    const user = userEvent.setup();
    render(<App />);
    const sidebarHandle = screen.getByRole('separator', { name: 'Resize sidebar' });
    expect(sidebarHandle).toHaveAttribute('aria-valuenow', '264');
    sidebarHandle.focus();
    await user.keyboard('{ArrowRight}');
    expect(sidebarHandle).toHaveAttribute('aria-valuenow', '276');
  });

  it('buffers live events until startup state hydration completes', async () => {
    let resolveState: ((state: RuntimeState) => void) | undefined;
    let listener: ((events: PiEvent[]) => void) | undefined;
    const statePromise = new Promise<RuntimeState>((resolve) => { resolveState = resolve; });
    const initial: RuntimeState = {
      status: 'ready', project: { path: '/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: null,
      streaming: true, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null,
    };
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getRuntimeState: vi.fn(() => statePromise),
        onEvents: vi.fn((next: (events: PiEvent[]) => void) => { listener = next; return () => undefined; }),
      } as unknown as PiDesktopApi,
    });

    render(<App />);
    act(() => listener?.([{ type: 'assistant.text', messageId: 'live', delta: 'not lost', timestamp: 1 }]));
    await act(async () => { resolveState?.(initial); await statePromise; });
    await waitFor(() => expect(useRuntimeStore.getState().messagesById.live?.text).toBe('not lost'));
  });

  it('does not rely on renderer Node globals', () => {
    render(<App />);
    expect('require' in window).toBe(false);
    expect('piDesktop' in window).toBe(false);
  });
});
