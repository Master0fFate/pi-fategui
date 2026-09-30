import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSnapshot } from '../../client/WebFateApi';
import { UnconfirmedCommand } from '../../client/HttpCommandTransport';
import { installWebFateApi, resetFateApi } from '../platform/api';
import { useWebWorkspaceStore } from '../stores/webWorkspaceStore';
import { useUiStore } from '../stores/uiStore';
import { useRuntimeStore } from '../stores/runtimeStore';
import { App } from './App';
import { boundedSessionExport, MAX_SESSION_EXPORT_BYTES } from '../features/shell/Workspace';
import { networkFixture, alpha, beta, hostSession, originalRequestId, monitorRowId } from './networkFixture.testSupport';
import type { WireResultOf } from '../../shared/protocol/methods';

// Only layout is replaced. Every shared row, selector, control and typed API remains real.
vi.mock('react-virtuoso', () => ({
  Virtuoso: ({ data = [], itemContent }: { data?: readonly unknown[]; itemContent: (index: number, item: unknown) => ReactNode }) =>
    <div>{data.map((item, index) => <div key={index}>{itemContent(index, item)}</div>)}</div>,
}));
beforeEach(() => {
  useWebWorkspaceStore.getState().reset();
  useUiStore.setState({ sidebarCollapsed: false, inspectorCollapsed: false, inspectorTab: 'monitor',
    inspectorLastViews: { work: 'files', run: 'monitor', system: 'context' }, goalEditorOpen: false, selectedAgent: null, toast: null });
});
afterEach(() => { cleanup(); resetFateApi(); useWebWorkspaceStore.getState().reset(); Reflect.deleteProperty(window, 'piDesktop'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function canonicalWork(f: ReturnType<typeof networkFixture>) {
  f.host.tasks = { schemaVersion: 1, revision: 2, goalId: null, currentTaskId: 'task-other', updatedAt: 1000,
    tasks: ['task-other', 'task-target'].map((id, order) => ({ id, title: id, detail: '', status: 'todo' as const, required: false,
      source: 'user' as const, goalId: null, goalCriterionId: null, order, verified: false, verifiedAt: null, createdAt: 1000, updatedAt: 1000 })) };
  f.host.goal = { id: 'goal-target', revision: 2, objective: 'Host objective', status: 'active', phase: 'implementation', executionState: 'idle',
    criteria: ['criterion-other', 'criterion-target'].map((id) => ({ id, title: id, description: '', required: true, status: 'pending' as const,
      evidenceIds: [], ownerNodeIds: [], updatedAt: 1000 })), evidence: [], continuationPending: false, updatedAt: 1000 };
  f.host.teams = [{ id: 'team-target', rootNodeId: 'node-root', status: 'active', selected: true, activeTurns: 0, writerNodeId: null,
    nodesTruncated: false, nodes: [{ id: 'node-root', parentNodeId: null, path: '/root', handle: 'root', status: 'ready',
      permissionLevel: 'edit', writer: false, unreadMessages: 0 }, { id: 'node-target', parentNodeId: 'node-root', path: '/root/child', handle: 'child',
      status: 'ready', permissionLevel: 'edit', writer: false, unreadMessages: 0 }] }];
}
const canonicalTargets = [
  { kind: 'task', taskId: 'task-target' },
  { kind: 'goal-criterion', goalId: 'goal-target', criterionId: 'criterion-target' },
  { kind: 'team-node', teamId: 'team-target', nodeId: 'node-target' },
] as const satisfies readonly NonNullable<WireResultOf<'workspace.monitorDetail'>['target']>[];

describe('shared AppShell browser projection', () => {
  it('exports at most 1 MiB of UTF-8 authorized excerpts and labels the result partial', () => {
    const f = networkFixture();
    const snapshot = f.makeSnapshot(alpha);
    const text = boundedSessionExport({ ...snapshot,
      header: { ...snapshot.header, warnings: ['HOST_CONFIG_PRIVATE_PATH_SENTINEL'] },
      items: Array.from({ length: 90 }, (_, index) => ({ kind: 'message' as const, role: 'assistant' as const,
        id: String(index), timestamp: 1000, text: '🙂'.repeat(4096), clipped: true, mediaOmitted: true })) });
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(MAX_SESSION_EXPORT_BYTES);
    expect(text).toContain('Partial retained transcript');
    expect(text).toContain('Export limit reached');
    expect(text).toContain('assistant (clipped)');
    expect(text).not.toContain('HOST_CONFIG_PRIVATE_PATH_SENTINEL');
    expect(text).not.toContain(alpha.workspaceId);
    expect(f.api.readSnapshot).not.toHaveBeenCalled();
  });
  it('downloads only on explicit action from the confirmed current snapshot, and refuses after loss', async () => {
    const BaseURL = URL;
    const createObjectURL = vi.fn((_object: Blob | MediaSource) => 'blob:authorized-session');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', class extends BaseURL { static override createObjectURL = createObjectURL; static override revokeObjectURL = revokeObjectURL; });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const f = networkFixture(); installWebFateApi(f.api); render(<App />);
    const download = await screen.findByRole('button', { name: 'Export bounded session text' });
    await waitFor(() => expect(download).toBeEnabled());
    expect(createObjectURL).not.toHaveBeenCalled();
    fireEvent.click(download);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    if (!(blob instanceof Blob)) throw new Error('Export did not produce a text Blob.');
    expect(blob.size).toBeLessThanOrEqual(MAX_SESSION_EXPORT_BYTES);
    expect(click).toHaveBeenCalledTimes(1);
    expect(f.api.previewText).not.toHaveBeenCalled();
    act(() => f.disconnect());
    expect(download).toBeDisabled(); fireEvent.click(download);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:authorized-session'));
  });
  it('mounts shared shell without preload, reads bounded snapshot and Monitor through a complete structural API', async () => {
    const f = networkFixture();
    const originalRuntime = useRuntimeStore.getState().runtime;
    installWebFateApi(f.api); render(<App />);
    expect(await screen.findByText('Retained Alpha')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Registered workspaces' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Inspector destinations' })).toBeInTheDocument();
    expect(screen.getByRole('main', { name: 'Fate web workspace' })).toBeInTheDocument();
    expect(screen.getByText(/Older history omitted/)).toBeInTheDocument();
    expect(screen.getAllByText(/Media omitted/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('region', { name: 'Connection status' })).toHaveLength(1);
    expect('piDesktop' in window).toBe(false);
    await waitFor(() => expect(f.api.readMonitor).toHaveBeenCalledWith({ ...alpha, sessionId: hostSession, selectionRevision: 4 }, expect.objectContaining({ section: 'overview', offset: 0, limit: 25 })));
    const dashboard = screen.getByRole('region', { name: 'Monitoring dashboard' });
    fireEvent.click(within(dashboard).getByRole('button', { name: /Runs/ }));
    await waitFor(() => expect(f.api.readMonitor).toHaveBeenCalledWith({ ...alpha, sessionId: hostSession, selectionRevision: 4 }, expect.objectContaining({ section: 'runs', offset: 0, limit: 25 })));
    fireEvent.click(within(dashboard).getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(f.api.readMonitor).toHaveBeenCalledWith({ ...alpha, sessionId: hostSession, selectionRevision: 4 }, expect.objectContaining({ section: 'runs', offset: 25, limit: 25 })));
    expect(useRuntimeStore.getState().runtime).toBe(originalRuntime);
  });
  it.each(canonicalTargets)('revalidates and focuses the real canonical $kind target, not the first row', async (target) => {
    const f = networkFixture(); canonicalWork(f); f.host.detail.target = target;
    installWebFateApi(f.api); render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: `Open Monitor row ${monitorRowId}` }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open corresponding work' }));
    await waitFor(() => expect(f.api.readMonitorDetail).toHaveBeenCalledTimes(2));
    const selector = target.kind === 'task' ? '[data-network-task-id="task-target"]'
      : target.kind === 'goal-criterion' ? '[data-network-criterion-id="criterion-target"]' : '[data-team-id="team-target"][data-node-id="node-target"]';
    await waitFor(() => expect(document.querySelector(selector)).toHaveAttribute('data-network-focus', 'true'));
    expect(document.querySelector(selector)).toHaveFocus();
    expect(useRuntimeStore.getState().networkNavigation?.target).toEqual(target);
    expect(document.querySelectorAll('[data-network-focus="true"]')).toHaveLength(1);
    expect(f.api.readMonitorDetail).toHaveBeenLastCalledWith(alpha, monitorRowId);
    expect(f.api.sendPrompt).not.toHaveBeenCalled(); expect(f.api.controlTeam).not.toHaveBeenCalled();
  });
  it.each(['row', 'page', 'section'] as const)('cancels a pending Monitor navigation on a new %s action without stranding or stealing its busy latch', async (action) => {
    const f = networkFixture(); canonicalWork(f);
    const nextRowId = '00000000000000000000000000000002';
    f.host.monitorRows = [...f.host.monitorRows, { ...f.host.monitorRows[0]!, id: nextRowId, title: 'Second Run' }];
    const detailFor = (id: string): WireResultOf<'workspace.monitorDetail'> => ({ ...f.host.detail, id,
      sessionId: hostSession, selectionRevision: 4,
      target: { kind: 'task', taskId: id === monitorRowId ? 'task-other' : 'task-target' } });
    f.api.readMonitorDetail.mockImplementation(async (_scope, id) => detailFor(id));
    installWebFateApi(f.api); render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: `Open Monitor row ${monitorRowId}` }));
    const firstNavigation = await screen.findByRole('button', { name: 'Open corresponding work' });
    let finishOld!: (value: WireResultOf<'workspace.monitorDetail'>) => void;
    f.api.readMonitorDetail.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    fireEvent.click(firstNavigation);
    await waitFor(() => expect(f.api.readMonitorDetail).toHaveBeenCalledTimes(2));
    expect(firstNavigation).toBeDisabled();

    const dashboard = screen.getByRole('region', { name: 'Monitoring dashboard' });
    if (action === 'page') {
      fireEvent.click(within(dashboard).getByRole('button', { name: 'Next' }));
      expect(screen.queryByRole('region', { name: 'Monitor row details' })).not.toBeInTheDocument();
      await waitFor(() => expect(f.api.readMonitor).toHaveBeenCalledWith({ ...alpha, sessionId: hostSession, selectionRevision: 4 },
        expect.objectContaining({ section: 'overview', offset: 25 })));
    } else if (action === 'section') {
      fireEvent.click(within(dashboard).getByRole('button', { name: /Runs/ }));
      expect(screen.queryByRole('region', { name: 'Monitor row details' })).not.toBeInTheDocument();
      await waitFor(() => expect(f.api.readMonitor).toHaveBeenCalledWith({ ...alpha, sessionId: hostSession, selectionRevision: 4 },
        expect.objectContaining({ section: 'runs', offset: 0 })));
    }
    fireEvent.click(await screen.findByRole('button', { name: `Open Monitor row ${nextRowId}` }));
    const nextNavigation = await screen.findByRole('button', { name: 'Open corresponding work' });
    await waitFor(() => expect(nextNavigation).toBeEnabled());
    expect(useRuntimeStore.getState().networkNavigation).toBeNull();
    expect(document.querySelector('[data-network-focus="true"]')).not.toBeInTheDocument();

    let finishNew!: (value: WireResultOf<'workspace.monitorDetail'>) => void;
    f.api.readMonitorDetail.mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; }));
    fireEvent.click(nextNavigation);
    await waitFor(() => expect(f.api.readMonitorDetail).toHaveBeenCalledTimes(4));
    expect(f.api.readMonitorDetail.mock.calls.map(([, id]) => id)).toEqual([monitorRowId, monitorRowId, nextRowId, nextRowId]);
    expect(f.api.readMonitorDetail).toHaveBeenLastCalledWith(alpha, nextRowId);
    await act(async () => { finishOld(detailFor(monitorRowId)); });
    expect(nextNavigation).toBeDisabled(); // The old finally cannot release the new recheck.
    expect(useRuntimeStore.getState().networkNavigation).toBeNull();
    expect(document.querySelector('[data-network-focus="true"]')).not.toBeInTheDocument();
    expect(useUiStore.getState().inspectorTab).toBe('monitor');

    await act(async () => { finishNew(detailFor(nextRowId)); });
    await waitFor(() => expect(document.querySelector('[data-network-task-id="task-target"]')).toHaveAttribute('data-network-focus', 'true'));
    expect(document.querySelector('[data-network-task-id="task-target"]')).toHaveFocus();
    expect(useRuntimeStore.getState().networkNavigation?.target).toEqual({ kind: 'task', taskId: 'task-target' });
    expect(document.querySelector('[data-network-task-id="task-other"][data-network-focus="true"]')).not.toBeInTheDocument();
    expect(document.querySelectorAll('[data-network-focus="true"]')).toHaveLength(1);
    expect(f.api.sendPrompt).not.toHaveBeenCalled(); expect(f.api.controlTeam).not.toHaveBeenCalled();
  });
  it.each(['changed', 'removed'] as const)('refuses a %s canonical source on navigation without selecting a replacement row', async (mode) => {
    const f = networkFixture(); canonicalWork(f); f.host.detail.target = canonicalTargets[0];
    installWebFateApi(f.api); render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: `Open Monitor row ${monitorRowId}` }));
    const navigate = await screen.findByRole('button', { name: 'Open corresponding work' });
    if (mode === 'changed') f.host.detail.target = { kind: 'task', taskId: 'task-other' };
    else if (f.host.tasks) f.host.tasks.tasks = f.host.tasks.tasks.filter((task) => task.id !== 'task-target');
    fireEvent.click(navigate);
    expect(await screen.findByText(/Source target cannot be confirmed/)).toBeInTheDocument();
    expect(useRuntimeStore.getState().networkNavigation).toBeNull();
    expect(document.querySelector('[data-network-focus="true"]')).not.toBeInTheDocument();
    expect(useUiStore.getState().inspectorTab).toBe('monitor');
    expect(f.api.sendPrompt).not.toHaveBeenCalled();
  });
  it('requires explicit scoped Team deletion confirmation and refreshes only after its journaled receipt', async () => {
    const f = networkFixture(undefined, true); canonicalWork(f);
    useUiStore.setState({ inspectorTab: 'sessions' }); installWebFateApi(f.api); render(<App />);
    const requestDelete = await screen.findByRole('button', { name: 'Delete team history for team-target' });
    await waitFor(() => expect(requestDelete).toBeEnabled());
    expect(f.api.controlTeam).not.toHaveBeenCalled();
    fireEvent.click(requestDelete);
    let dialog = screen.getByRole('alertdialog', { name: 'Delete team-target history?' });
    expect(dialog).toHaveTextContent(`Workspace: Alpha. Session: ${hostSession}. Team: team-target.`);
    expect(dialog).toHaveTextContent('host checks active and queued work, waiting tasks and leases');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(f.api.controlTeam).not.toHaveBeenCalled();
    const receipt = f.receipt('team.control');
    let finish!: (value: WireResultOf<'team.control'>) => void;
    f.api.controlTeam.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(requestDelete); dialog = screen.getByRole('alertdialog', { name: 'Delete team-target history?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete history' }));
    await waitFor(() => expect(f.api.controlTeam).toHaveBeenCalledWith(alpha, { action: 'deleteTeam', teamId: 'team-target' }));
    expect(f.api.readSnapshot).toHaveBeenCalledTimes(1);
    // The modal hides the background from accessibility, but must retain its rows until the receipt.
    expect(document.querySelector('section[aria-label="Host agents and tasks"]')).toBeInTheDocument();
    expect(useRuntimeStore.getState().networkViews.teams).toMatchObject({ status: 'ready', value: { teams: [{ id: 'team-target' }] } });
    await act(async () => { f.host.teams = []; finish(receipt); });
    await waitFor(() => expect(f.api.readSnapshot).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete team history for team-target' })).not.toBeInTheDocument());
    expect(f.api.controlTeam).toHaveBeenCalledTimes(1);
  });
  it.each(['refused', 'unknown', 'not-journaled'] as const)('does not infer Team deletion or retry a %s result', async (result) => {
    const f = networkFixture(undefined, true); canonicalWork(f);
    f.api.controlTeam.mockImplementationOnce(async (scope) => {
      if (result === 'refused') throw new Error('Host refused canonical active/queued work.');
      f.api.rememberPendingPromptReview(scope, hostSession, originalRequestId, 'team.control');
      if (result === 'unknown') throw new UnconfirmedCommand(originalRequestId);
      return { ...f.receipt('team.control'), requestId: originalRequestId, durability: 'not-journaled' };
    });
    useUiStore.setState({ inspectorTab: 'sessions' }); installWebFateApi(f.api); render(<App />);
    const requestDelete = await screen.findByRole('button', { name: 'Delete team history for team-target' });
    await waitFor(() => expect(requestDelete).toBeEnabled()); fireEvent.click(requestDelete);
    fireEvent.click(within(screen.getByRole('alertdialog', { name: 'Delete team-target history?' })).getByRole('button', { name: 'Delete history' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    // Assert the persistent status, not the transient error in the closing modal.
    await waitFor(() => expect(screen.getByText(/Deletion was not confirmed. No deleted state is inferred/)).toBeInTheDocument());
    expect(requestDelete).toBeDisabled(); fireEvent.click(requestDelete);
    expect(f.api.controlTeam).toHaveBeenCalledTimes(1);
    expect(f.api.readSnapshot).toHaveBeenCalledTimes(1);
    expect(useRuntimeStore.getState().networkViews.teams).toMatchObject({ status: 'ready', value: { teams: [{ id: 'team-target' }] } });
    expect(f.api.clearPendingPromptReview).not.toHaveBeenCalled();
    if (result !== 'refused') {
      expect(useRuntimeStore.getState().pendingReview).toMatchObject({ scope: alpha, sessionId: hostSession, requestId: originalRequestId, method: 'team.control' });
      expect(screen.getByRole('button', { name: 'Review original command' })).toBeEnabled();
      expect(f.api.pendingPromptReview(alpha, hostSession)).toMatchObject({ kind: 'match', value: { requestId: originalRequestId, method: 'team.control' } });
    }
  });
  it('leaves runtime.prompt mutation and original-ID review exclusively with Composer', async () => {
    const f = networkFixture(undefined, true); installWebFateApi(f.api); render(<App />);
    expect(await screen.findByText('Retained Alpha')).toBeInTheDocument();
    const operation = vi.fn(async () => f.promptReceipt);
    await act(async () => { expect(await useRuntimeStore.getState().runNetworkMutation(f.api, 'runtime.prompt', operation)).toBe(false); });
    expect(operation).not.toHaveBeenCalled();
    f.api.rememberPendingPromptReview(alpha, hostSession, originalRequestId);
    act(() => useRuntimeStore.getState().recoverPendingReview(f.api));
    expect(useRuntimeStore.getState().pendingReview).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review original command' })).not.toBeInTheDocument();
    expect(f.api.clearPendingPromptReview).not.toHaveBeenCalled();
    expect(f.api.reviewPromptStatus).not.toHaveBeenCalled();
  });
  it('reviews a generic action only by its original ID and never replays absent or unknown outcomes', async () => {
    const f = networkFixture(); installWebFateApi(f.api); render(<App />);
    const claim = await screen.findByRole('button', { name: 'Claim control' });
    await waitFor(() => expect(claim).toBeEnabled()); fireEvent.click(claim);
    const thinking = screen.getByRole('combobox', { name: 'Thinking level' });
    await waitFor(() => expect(thinking).toBeEnabled());
    f.api.setThinking.mockImplementationOnce(async (scope) => {
      f.api.rememberPendingPromptReview(scope, hostSession, originalRequestId, 'runtime.setThinking');
      throw new UnconfirmedCommand(originalRequestId);
    });
    fireEvent.change(thinking, { target: { value: 'high' } });
    const review = await screen.findByRole('button', { name: 'Review original command' });
    expect(thinking).toBeDisabled();
    f.api.reviewPromptStatus.mockResolvedValueOnce({ state: 'absent', receipt: null, rejectionCode: null });
    fireEvent.click(review);
    await waitFor(() => expect(screen.getByText(/Original command absent/)).toBeInTheDocument());
    f.api.reviewPromptStatus.mockResolvedValueOnce({ state: 'outcome_unknown', receipt: null, rejectionCode: null });
    fireEvent.click(review);
    await waitFor(() => expect(screen.getByText(/Original command outcome_unknown/)).toBeInTheDocument());
    expect(f.api.clearPendingPromptReview).not.toHaveBeenCalled();
    expect(f.api.setThinking).toHaveBeenCalledTimes(1);
    f.api.reviewPromptStatus.mockResolvedValueOnce({ state: 'settled', receipt: { ...f.receipt('runtime.setThinking'), requestId: originalRequestId, durability: 'journaled' }, rejectionCode: null });
    fireEvent.click(review);
    await waitFor(() => expect(useRuntimeStore.getState().pendingReview).toBeNull());
    expect(f.api.reviewPromptStatus).toHaveBeenLastCalledWith(alpha, originalRequestId);
    expect(f.api.clearPendingPromptReview).toHaveBeenCalledTimes(1);
    expect(f.api.setThinking).toHaveBeenCalledTimes(1);
  });
  it('claims control explicitly, keeps Composer original-request review visible, and never treats absent as not executed', async () => {
    const f = networkFixture(); installWebFateApi(f.api); render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Claim control' })).toBeEnabled());
    const send = screen.getByRole('button', { name: 'Send prompt' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message to selected host session' }), { target: { value: 'Inspect the work' } });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Claim control' }));
    await waitFor(() => expect(send).toBeEnabled());
    f.api.sendPrompt.mockRejectedValueOnce(new UnconfirmedCommand(originalRequestId));
    fireEvent.click(send);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review original request' })).toBeEnabled());
    expect(useRuntimeStore.getState().pendingReview).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review original command' })).not.toBeInTheDocument();
    expect(send).toBeDisabled();
    expect(f.api.sendPrompt).toHaveBeenCalledTimes(1);
    expect(f.api.sendPrompt).toHaveBeenCalledWith(alpha, 'Inspect the work');
    f.api.reviewPromptStatus.mockResolvedValueOnce({ state: 'absent', receipt: null, rejectionCode: null });
    fireEvent.click(screen.getByRole('button', { name: 'Review original request' }));
    await waitFor(() => expect(f.api.reviewPromptStatus).toHaveBeenCalledWith(alpha, originalRequestId));
    expect(await screen.findByText(/Outcome is not confirmed/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue('Inspect the work');
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Review original request' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue(''));
    expect(f.api.sendPrompt).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Release control' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Release control' }));
    await waitFor(() => expect(f.api.releaseControl).toHaveBeenCalledWith(alpha));
    expect(send).toBeDisabled();
  });
  it('does not show a prior browser login draft to another authenticated session', async () => {
    const first = networkFixture('80000000-0000-4000-8000-000000000008');
    installWebFateApi(first.api); const view = render(<App />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toBeEnabled());
    fireEvent.change(screen.getByRole('textbox', { name: 'Message to selected host session' }), { target: { value: 'Private draft from login one' } });
    expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue('Private draft from login one');
    view.unmount(); resetFateApi(); useWebWorkspaceStore.getState().reset();
    const second = networkFixture('90000000-0000-4000-8000-000000000009'); installWebFateApi(second.api); render(<App />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toBeEnabled());
    expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue('');
    expect(screen.queryByDisplayValue('Private draft from login one')).not.toBeInTheDocument();
  });
  it('uses resource IDs for named host file reads, never a host path or generic desktop proxy', async () => {
    const f = networkFixture(); installWebFateApi(f.api); useUiStore.setState({ inspectorTab: 'files' }); render(<App />);
    expect(await screen.findByRole('button', { name: 'readme.txt' })).toBeInTheDocument();
    expect(f.api.listFiles).toHaveBeenCalledWith(alpha, null);
    fireEvent.click(screen.getByRole('button', { name: 'readme.txt' }));
    expect(await screen.findByText('Contents for Alpha')).toBeInTheDocument();
    expect(f.api.previewText).toHaveBeenCalledWith(alpha, '70000000-0000-4000-8000-000000000007');
  });
  it('drops a late A→B→A snapshot and shows last-confirmed running as stale in the one host strip', async () => {
    const f = networkFixture(); installWebFateApi(f.api); render(<App />);
    expect(await screen.findByText('Retained Alpha')).toBeInTheDocument();
    let release!: (result: WebSnapshot) => void;
    f.api.readSnapshot.mockImplementationOnce(() => new Promise<WebSnapshot>((resolve) => { release = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }));
    await waitFor(() => expect(f.api.readSnapshot).toHaveBeenCalledWith(beta));
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(await screen.findByText('Retained Alpha')).toBeInTheDocument();
    await act(async () => { release(f.makeSnapshot(beta, 'Leaked Beta result')); });
    expect(screen.queryByText('Leaked Beta result')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review controls' }));
    act(() => f.disconnect());
    const status = screen.getByRole('region', { name: 'Connection status' });
    expect(status).toHaveTextContent('Last confirmed state: running');
    expect(status).toHaveTextContent(/Work, including paid work, may continue/);
    expect(status).toHaveTextContent(/does not mean it stopped or completed/);
    expect(within(screen.getByRole('main', { name: 'Fate web workspace' })).getByRole('button', { name: 'Refresh host state' })).toBeDisabled();
  });
});
