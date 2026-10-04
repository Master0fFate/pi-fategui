import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalEvent } from '../../../shared/contracts/ipc';
import { MANUAL_TERMINAL_WARNING } from '../../../shared/contracts/terminal';
import { useUiStore } from '../../stores/uiStore';
import { TerminalPanel } from './TerminalPanel';

const f = vi.hoisted(() => {
  const state: { supported: boolean; control: number | null; workspaceId: string;
    listener: ((event: TerminalEvent) => void) | null; input: ((data: string) => void) | null;
    rendered: string[] } = { supported: true, control: 2, workspaceId: 'host-project', listener: null, input: null, rendered: [] };
  const api = {
    createTerminal: vi.fn<(cols: number, rows: number) => Promise<{ id: string; shell: string; cwd: string }>>(),
    writeTerminal: vi.fn<(id: string, data: string) => Promise<void>>(),
    acknowledgeTerminal: vi.fn<(id: string, characters: number) => Promise<void>>(),
    resizeTerminal: vi.fn<(id: string, cols: number, rows: number) => Promise<void>>(),
    closeTerminal: vi.fn<(id: string) => Promise<void>>(),
    onTerminalEvent: (listener: (event: TerminalEvent) => void) => {
      state.listener = listener;
      return () => { if (state.listener === listener) state.listener = null; };
    },
  };
  return { state, api };
});
vi.mock('../../platform/api', () => ({
  getTerminalApiOptional: () => f.state.supported ? f.api : undefined,
  hasCapability: () => f.state.supported,
  getWebApiOptional: () => ({ serverEpoch: 'epoch', origin: 'http://127.0.0.1:49301', hostName: 'Remote test host', isConnected: true,
    workspace: { workspaceId: f.state.workspaceId, workspaceGeneration: 1, label: 'Registered project' }, control: f.state.control }),
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24;
  options = { disableStdin: false, theme: {}, fontFamily: '' };
  loadAddon() {} open() {} attachCustomKeyEventHandler() {} focus() {} dispose() {}
  getSelection() { return ''; }
  write(data: string, consumed?: () => void) { f.state.rendered.push(data); consumed?.(); }
  writeln(data: string) { f.state.rendered.push(data); }
  onData(listener: (data: string) => void) { f.state.input = listener; return { dispose: () => { f.state.input = null; } }; }
} }));

beforeEach(() => {
  vi.clearAllMocks();
  f.state.supported = true; f.state.control = 2; f.state.workspaceId = 'host-project';
  f.state.listener = null; f.state.input = null; f.state.rendered = [];
  f.api.createTerminal.mockResolvedValue({ id: 'terminal-id', shell: '/bin/sh', cwd: '/host/project' });
  f.api.writeTerminal.mockResolvedValue(undefined); f.api.acknowledgeTerminal.mockResolvedValue(undefined);
  f.api.resizeTerminal.mockResolvedValue(undefined); f.api.closeTerminal.mockResolvedValue(undefined);
  useUiStore.setState({ terminalOpen: true });
});

describe('manual terminal consent and shared port', () => {
  it('names the execution host and unsandboxed authority before creating a shell; cancel starts nothing', () => {
    render(<TerminalPanel />);
    expect(screen.getByText(MANUAL_TERMINAL_WARNING)).toBeVisible();
    expect(screen.getByText(/Manual shell · Remote test host/u)).toBeVisible();
    expect(f.api.createTerminal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useUiStore.getState().terminalOpen).toBe(false);
    expect(f.api.createTerminal).not.toHaveBeenCalled();
  });

  it('only starts after explicit consent, maps consumed output ACKs, and closes on unmount', async () => {
    const view = render(<TerminalPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Start manual shell' }));
    await waitFor(() => expect(f.api.createTerminal).toHaveBeenCalledExactlyOnceWith(80, 24));
    await act(async () => { f.state.listener?.({ type: 'data', id: 'terminal-id', data: '😀' }); });
    expect(f.state.rendered).toEqual(['😀']);
    expect(f.api.acknowledgeTerminal).toHaveBeenCalledExactlyOnceWith('terminal-id', 2);
    await act(async () => { f.state.input?.('manual\r'); });
    expect(f.api.writeTerminal).toHaveBeenCalledExactlyOnceWith('terminal-id', 'manual\r');
    view.unmount();
    expect(f.api.closeTerminal).toHaveBeenCalledExactlyOnceWith('terminal-id');
    expect(f.state.listener).toBeNull();
  });

  it('requires new consent after workspace/control changes and never autostarts after channel loss', async () => {
    const view = render(<TerminalPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Start manual shell' }));
    await waitFor(() => expect(f.api.createTerminal).toHaveBeenCalledOnce());
    await act(async () => { f.state.listener?.({ type: 'exit', id: 'terminal-id', exitCode: -1 }); });
    expect(screen.getByRole('alert')).toHaveTextContent('Input was not replayed');
    expect(f.api.createTerminal).toHaveBeenCalledOnce();
    f.state.control = 3; f.state.workspaceId = 'different-project';
    view.rerender(<TerminalPanel />);
    expect(screen.getByText(MANUAL_TERMINAL_WARNING)).toBeVisible();
    expect(f.api.createTerminal).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Start manual shell' }));
    await waitFor(() => expect(f.api.createTerminal).toHaveBeenCalledTimes(2));
  });

  it('disables observers and never invokes a missing/unsupported client path', () => {
    f.state.control = null;
    const view = render(<TerminalPanel />);
    expect(screen.getByRole('button', { name: 'Start manual shell' })).toBeDisabled();
    f.state.supported = false;
    view.rerender(<TerminalPanel />);
    expect(screen.queryByRole('button', { name: 'Start manual shell' })).not.toBeInTheDocument();
    expect(f.api.createTerminal).not.toHaveBeenCalled();
  });

  it('surfaces refused input and closes the shell instead of retrying or replaying', async () => {
    f.api.writeTerminal.mockRejectedValue(new Error('Terminal input exceeded the limit.'));
    render(<TerminalPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Start manual shell' }));
    await waitFor(() => expect(f.api.createTerminal).toHaveBeenCalledOnce());
    await act(async () => { f.state.input?.('rejected'); });
    expect(screen.getByRole('alert')).toHaveTextContent('Terminal input exceeded the limit');
    expect(f.api.closeTerminal).toHaveBeenCalledExactlyOnceWith('terminal-id');
    await act(async () => { f.state.input?.('not queued'); });
    expect(f.api.writeTerminal).toHaveBeenCalledOnce();
  });

  it('cleans up a late creation after unmount without queuing pre-creation keystrokes', async () => {
    let finish!: (result: { id: string; shell: string; cwd: string }) => void;
    f.api.createTerminal.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<TerminalPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Start manual shell' }));
    f.state.input?.('never queued');
    expect(f.api.writeTerminal).not.toHaveBeenCalled();
    view.unmount();
    await act(async () => { finish({ id: 'late-terminal', shell: '/bin/sh', cwd: '/host/project' }); });
    expect(f.api.closeTerminal).toHaveBeenCalledExactlyOnceWith('late-terminal');
    expect(f.api.writeTerminal).not.toHaveBeenCalled();
  });
});
