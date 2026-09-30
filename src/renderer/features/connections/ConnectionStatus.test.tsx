import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionStatus, type ConnectionStatusProps } from './ConnectionStatus';

const props: ConnectionStatusProps = {
  hostName: 'remote-host', connected: true, statusLabel: 'Connected', lastConfirmedAt: Date.parse('2026-01-01T12:00:00.000Z'),
  workspaceName: 'project', sessionId: 'session-1', permissionLevel: 'edit', running: null, lastConfirmedStatus: 'running', controlLabel: 'Observer', panelId: 'workspace-controls', panelOpen: false, onOpenChange: vi.fn(),
};

describe('ConnectionStatus', () => {
  it('names the host before transport and control status, with one explicit review action', () => {
    const view = render(<ConnectionStatus {...props} />);
    expect(screen.getByRole('region', { name: 'Connection status' })).toBeInTheDocument();
    expect(screen.getByRole('status').textContent).toMatch(/^Host: remote-hostWorkspace: projectSession: session-1ConnectedObserverPermission: edit/);
    expect(screen.getByRole('button', { name: 'Review controls' })).toHaveAttribute('aria-controls', 'workspace-controls');
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/paid work/)).not.toBeInTheDocument();
    view.rerender(<ConnectionStatus {...props} running />);
    expect(screen.getByText(/Work, including paid work, may continue/)).toBeInTheDocument();
    expect(screen.getByText('Selected session: running')).toBeInTheDocument();
  });

  it('announces unconfirmed state without inferring that work has stopped on loss', () => {
    render(<ConnectionStatus {...props} connected={false} statusLabel="Reconnecting" />);
    expect(screen.getByText(/Work, including paid work, may continue/)).toBeInTheDocument();
    expect(screen.getByText('Last confirmed state: running')).toBeInTheDocument();
    expect(screen.getByText(/^Last confirmed \d/)).toHaveAttribute('datetime', '2026-01-01T12:00:00.000Z');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps unknown confirmation time explicit, without inventing a fresh timestamp', () => {
    render(<ConnectionStatus {...props} connected={false} lastConfirmedAt={null} />);
    expect(screen.getByText('No confirmed host update yet')).toBeInTheDocument();
    expect(screen.getByText('No confirmed host update yet')).not.toHaveAttribute('datetime');
  });

  it('opens only on user action and reports expanded state', () => {
    const onOpenChange = vi.fn();
    const view = render(<ConnectionStatus {...props} connected={false} onOpenChange={onOpenChange} />);
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review controls' }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    view.rerender(<ConnectionStatus {...props} panelOpen onOpenChange={onOpenChange} />);
    expect(screen.getByRole('button', { name: 'Hide controls' })).toHaveAttribute('aria-expanded', 'true');
  });
});
