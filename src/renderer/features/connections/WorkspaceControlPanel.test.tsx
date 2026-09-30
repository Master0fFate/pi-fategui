import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceControlPanel, type WorkspaceControlPanelProps } from './WorkspaceControlPanel';
import type { WireResultOf } from '../../../shared/protocol/methods';

const sessionId = '11111111-1111-4111-8111-111111111111';
const challengeId = '22222222-2222-4222-8222-222222222222';
const workspace = { workspaceId: '33333333-3333-4333-8333-333333333333', workspaceGeneration: 1, label: 'Project' };
const requestId = '44444444-4444-4444-8444-444444444444.1700000000000.55555555-5555-4555-8555-555555555555';
function challenge(): WireResultOf<'permission.issue'> {
  return { challengeId, sessionId, oldLevel: 'edit', newLevel: 'full-access', expiresAt: Date.now() + 60_000 };
}
function props(overrides: Partial<WorkspaceControlPanelProps> = {}): WorkspaceControlPanelProps {
  return {
    id: 'control-panel', hostName: 'Host', workspace, sessionId, permissionLevel: 'edit', scopeKey: 'host:workspace:session:lease',
    ready: true, controlGeneration: null, canControl: true, canApprovePermission: true, takeoverAllowed: false,
    onClose: vi.fn(), onRefresh: vi.fn(async () => undefined), onClaim: vi.fn(async () => undefined),
    onRenew: vi.fn(async () => undefined), onRelease: vi.fn(async () => undefined), onTakeover: vi.fn(async () => undefined),
    onRequestPermission: vi.fn(async () => challenge()),
    onRespondPermission: vi.fn(async () => ({ applied: true as const, sessionId, level: 'full-access' as const })),
    ...overrides,
  };
}
async function openPermissionReview() {
  fireEvent.change(screen.getByRole('combobox', { name: 'Requested permission' }), { target: { value: 'full-access' } });
  fireEvent.click(screen.getByRole('button', { name: 'Request permission review' }));
  await screen.findByRole('group', { name: 'Permission confirmation' });
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('WorkspaceControlPanel', () => {
  it('supports keyboard client login and explicit claim without optimistic control', async () => {
    const user = userEvent.setup();
    const values = props({ onLogin: vi.fn() });
    render(<WorkspaceControlPanel {...values} />);
    expect(screen.getByRole('heading', { name: 'Workspace controls' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Sign in to host' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(values.onLogin).toHaveBeenCalledOnce();
    await user.tab(); await user.tab(); await user.tab();
    expect(screen.getByRole('button', { name: 'Claim control' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(values.onClaim).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Renew control' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Release control' })).toBeDisabled();
  });

  it('keeps reconnect warnings inline and mutations disabled, without automatic actions or dialogs', () => {
    const values = props({ ready: false, controlGeneration: 4 });
    const view = render(<WorkspaceControlPanel {...values} />);
    for (const name of ['Claim control', 'Renew control', 'Release control', 'Take over control', 'Request permission review']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    view.rerender(<WorkspaceControlPanel {...values} />);
    expect(screen.getAllByText(/Work, including paid work, may continue/)).toHaveLength(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(values.onClaim).not.toHaveBeenCalled();
    expect(values.onRefresh).not.toHaveBeenCalled();
  });

  it('refreshes once on explicit review and restores focus when closing', async () => {
    const values = props();
    render(<><button id="control-panel-trigger">Review controls</button><WorkspaceControlPanel {...values} /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh host state' }));
    await waitFor(() => expect(values.onRefresh).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Close controls' }));
    expect(values.onClose).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Review controls' })).toHaveFocus();
  });

  it('requires trusted host takeover policy and starts review with safe Cancel focus', async () => {
    const values = props();
    const view = render(<WorkspaceControlPanel {...values} />);
    expect(screen.getByRole('button', { name: 'Take over control' })).toBeDisabled();
    view.rerender(<WorkspaceControlPanel {...values} takeoverAllowed />);
    fireEvent.click(screen.getByRole('button', { name: 'Take over control' }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Takeover confirmation' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take over control' })).toHaveFocus();
    expect(values.onTakeover).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Take over control' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm takeover' }));
    await waitFor(() => expect(values.onTakeover).toHaveBeenCalledOnce());
  });

  it('sends exact scoped issue/confirm schemas and consumes the challenge once', async () => {
    const values = props({ controlGeneration: 4 });
    render(<WorkspaceControlPanel {...values} />);
    await openPermissionReview();
    expect(values.onRequestPermission).toHaveBeenCalledWith({ sessionId, action: 'runtime.setPermission', oldLevel: 'edit', newLevel: 'full-access' });
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    const confirm = screen.getByRole('button', { name: 'Confirm permission change' });
    fireEvent.click(confirm); fireEvent.click(confirm);
    await waitFor(() => expect(values.onRespondPermission).toHaveBeenCalledOnce());
    expect(values.onRespondPermission).toHaveBeenCalledWith({ challengeId, sessionId, action: 'runtime.setPermission', oldLevel: 'edit', newLevel: 'full-access' });
    expect(screen.queryByRole('group', { name: 'Permission confirmation' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Request permission review' })).toHaveFocus());
  });

  it('Cancel sends no confirmation and cannot resurrect the same challenge', async () => {
    const values = props({ controlGeneration: 4 });
    render(<WorkspaceControlPanel {...values} />);
    await openPermissionReview();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(values.onRespondPermission).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Request permission review' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Request permission review' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('group', { name: 'Permission confirmation' })).not.toBeInTheDocument();
  });

  it('invalidates challenges on takeover/scope change, without retaining stale authority', async () => {
    const values = props({ controlGeneration: 4 });
    const view = render(<WorkspaceControlPanel {...values} />);
    await openPermissionReview();
    view.rerender(<WorkspaceControlPanel {...values} scopeKey="new-host-lease" controlGeneration={null} />);
    expect(screen.queryByRole('group', { name: 'Permission confirmation' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Workspace controls' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Request permission review' })).toBeDisabled();
    expect(values.onRespondPermission).not.toHaveBeenCalled();
  });

  it('drops a delayed challenge for the previous host scope', async () => {
    let resolve!: (value: WireResultOf<'permission.issue'>) => void;
    const values = props({ controlGeneration: 4, onRequestPermission: vi.fn(() => new Promise<WireResultOf<'permission.issue'>>((done) => { resolve = done; })) });
    const view = render(<WorkspaceControlPanel {...values} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'full-access' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request permission review' }));
    view.rerender(<WorkspaceControlPanel {...values} scopeKey="different-host" />);
    await act(async () => { resolve(challenge()); });
    expect(screen.queryByRole('group', { name: 'Permission confirmation' })).not.toBeInTheDocument();
    expect(values.onRespondPermission).not.toHaveBeenCalled();
  });

  it('expires visible challenges without automatically sending a decision', async () => {
    vi.useFakeTimers();
    const values = props({ controlGeneration: 4, onRequestPermission: vi.fn(async () => ({ ...challenge(), expiresAt: Date.now() + 500 })) });
    render(<WorkspaceControlPanel {...values} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'full-access' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Request permission review' })); });
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(screen.getByRole('button', { name: 'Confirm permission change' })).toBeDisabled();
    expect(values.onRespondPermission).not.toHaveBeenCalled();
  });

  it('uses calibrated host time for challenge admission, polling and pre-dispatch expiry', async () => {
    vi.useFakeTimers();
    let hostTime = 1000;
    const values = props({ controlGeneration: 4, estimatedHostTime: () => hostTime,
      onRequestPermission: vi.fn(async () => ({ ...challenge(), expiresAt: 1600 })) });
    render(<WorkspaceControlPanel {...values} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'full-access' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Request permission review' })); });
    const confirm = screen.getByRole('button', { name: 'Confirm permission change' });
    expect(confirm).toBeEnabled(); // Browser wall clock is far ahead of this host clock.
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(confirm).toBeEnabled(); // Advancing the browser clock alone does not expire it.
    hostTime = 1600;
    fireEvent.click(confirm); // Host expiry is rechecked even before the next UI timer tick.
    expect(values.onRespondPermission).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(confirm).toBeDisabled();
    expect(screen.getByText('Challenge expired. Cancel and request a new review.')).toBeInTheDocument();
  });

  it('does not offer repeat confirmation or fresh-ID Retry after uncertain permission delivery', async () => {
    const values = props({ controlGeneration: 4, onRespondPermission: vi.fn(async () => { throw new Error('Delivery uncertain'); }) });
    render(<WorkspaceControlPanel {...values} />);
    await openPermissionReview();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm permission change' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm permission change' })).not.toBeInTheDocument();
    expect(values.onRespondPermission).toHaveBeenCalledOnce();
    expect(values.onRefresh).toHaveBeenCalledOnce();
  });

  it('reviews only the original command ID and labels admission separately from completion', async () => {
    const values = props({ originalRequestId: requestId, onReviewOriginal: vi.fn(async () => ({ state: 'outcome_unknown' as const, receipt: null, rejectionCode: null })) });
    render(<WorkspaceControlPanel {...values} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review original request' }));
    await waitFor(() => expect(values.onReviewOriginal).toHaveBeenCalledWith({ requestId }));
    expect(screen.getByRole('status')).toHaveTextContent('outcome_unknown');
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(values.onClaim).not.toHaveBeenCalled();
  });

  it('does not turn an accepted original receipt into a completed run', async () => {
    const values = props({ originalRequestId: requestId, onReviewOriginal: vi.fn(async () => ({ state: 'settled' as const,
      receipt: { kind: 'prompt' as const, requestId, durability: 'journaled' as const, outcome: 'accepted' as const,
        sessionId, runId: challengeId, viewRevision: 1 }, rejectionCode: null })) });
    render(<WorkspaceControlPanel {...values} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review original request' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('The prompt was admitted; this is not proof the run completed.'));
    expect(values.onClaim).not.toHaveBeenCalled();
  });

  it('reviews a parent-scoped original command after the selected session has changed', async () => {
    const values = props({ originalRequestId: requestId,
      onReviewOriginal: vi.fn(async () => ({ state: 'settled' as const,
        receipt: { kind: 'selection' as const, requestId, durability: 'journaled' as const,
          outcome: 'selected' as const, sessionId, selectionRevision: 1, viewRevision: 1 }, rejectionCode: null })) });
    const view = render(<WorkspaceControlPanel {...values} />);
    view.rerender(<WorkspaceControlPanel {...values} sessionId={challengeId} scopeKey="same-host-workspace:new-selection" />);
    fireEvent.click(screen.getByRole('button', { name: 'Review original request' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Original request status: settled.'));
    expect(values.onReviewOriginal).toHaveBeenCalledWith({ requestId });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(values.onClaim).not.toHaveBeenCalled();
    expect(values.onRespondPermission).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('refuses corrupt original IDs instead of creating a new request identity', () => {
    const values = props({ originalRequestId: 'file:///remote/project', onReviewOriginal: vi.fn() });
    render(<WorkspaceControlPanel {...values} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review original request' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Original request identity is invalid');
    expect(values.onReviewOriginal).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('renders remote path-looking labels as inert text, never local-shell links', () => {
    const openPath = vi.fn();
    vi.stubGlobal('piDesktop', { openPath });
    render(<WorkspaceControlPanel {...props({ hostName: 'file:///C:/remote/private.txt' })} />);
    expect(screen.getByText(/file:\/\/\/C:\/remote\/private.txt/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(openPath).not.toHaveBeenCalled();
  });
});
