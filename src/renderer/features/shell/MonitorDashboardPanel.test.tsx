import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MonitorDashboard } from '../../../shared/contracts/monitorDashboard';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { installFateApi, installWebFateApi, resetFateApi } from '../../platform/api';
import { desktopHostCapabilities } from '../../../shared/protocol/capabilities';
import { negotiateCapabilities } from '../../platform/capabilityPolicy';
import type { FateApi } from '../../../client/FateApi';
import type { WebWorkspace } from '../../../client/WebFateApi';
import { networkFixture, hostSession, otherHostSession, monitorRowId } from '../../app/networkFixture.testSupport';
import type { NetworkMonitor } from '../../../shared/protocol/diagnostics';
import type { WireResultOf } from '../../../shared/protocol/methods';
import { alpha, beta } from '../../app/networkFixture.testSupport';
import { MonitorDashboardPanel } from './MonitorDashboardPanel';

const snapshot = (section: MonitorDashboard['section'] = 'overview'): MonitorDashboard => ({
  projectPath: '/project', sessionId: 'session', checkedAt: 1000, revision: 'a', overall: 'attention',
  sources: { runs: 'ready', teams: 'ready', tasks: 'ready', activity: 'ready' },
  sourceCheckedAt: { runs: 1000, teams: 1000, tasks: 1000, activity: 1000 },
  counts: { attention: 1, active: 1, runs: 2, teams: 0, tasks: 0, activity: 0 },
  section, offset: 0, limit: 25, total: 1, unchanged: false,
  items: [{ id: 'run:one', source: 'runs', state: 'attention', title: 'Release check', detail: 'Failed', updatedAt: 1000, ref: { kind: 'run', id: 'one' } }],
});

const original = Object.getOwnPropertyDescriptor(window, 'piDesktop');
const initialRuntime = useRuntimeStore.getState().runtime;
afterEach(() => {
  if (original) Object.defineProperty(window, 'piDesktop', original);
  else Reflect.deleteProperty(window, 'piDesktop');
  resetFateApi();
  useRuntimeStore.getState().reset();
  useRuntimeStore.setState({ runtime: initialRuntime });
  vi.restoreAllMocks();
});

describe('monitor dashboard panel', () => {
  it('requires an exact workspace monitor grant on a registered host', () => {
    const host = { ...desktopHostCapabilities, workspaces: [{ workspaceId: '20000000-0000-4000-8000-000000000002', label: 'Project', supported: { monitor: false, operations: [] } }] };
    expect(negotiateCapabilities(host).monitor).toBe(false);
    expect(negotiateCapabilities(host, undefined, host.workspaces[0]!.workspaceId).monitor).toBe(false);
    expect(negotiateCapabilities({ ...host, workspaces: [{ ...host.workspaces[0]!, supported: { monitor: true, operations: [] } }] }, undefined, host.workspaces[0]!.workspaceId).monitor).toBe(true);
  });
  it('does not poll or show healthy empty work when host monitoring is absent', async () => {
    const getMonitorDashboard = vi.fn(async () => snapshot());
    const dispose = installFateApi({ getMonitorDashboard } as unknown as FateApi, {
      ...desktopHostCapabilities, supported: { ...desktopHostCapabilities.supported, monitor: false },
    });
    act(() => useRuntimeStore.setState((state) => ({ runtime: { ...state.runtime, status: 'ready', project: { path: '/project', name: 'Project', trusted: true }, sessionId: 'session' } })));
    render(<MonitorDashboardPanel />);
    expect(screen.getByText(/Monitoring is unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/No active or flagged work/)).not.toBeInTheDocument();
    expect(getMonitorDashboard).not.toHaveBeenCalled();
    dispose();
  });
  it('reads the injected fake without any window bridge and refreshes a page with its revision', async () => {
    Reflect.deleteProperty(window, 'piDesktop');
    const getMonitorDashboard = vi.fn(async ({ section, offset, sinceRevision }: { section: MonitorDashboard['section']; offset: number; sinceRevision?: string }) => ({
      ...snapshot(section), offset, revision: sinceRevision ? 'b' : 'a', total: section === 'runs' ? 26 : 1,
    }));
    const dispose = installFateApi({ getMonitorDashboard } as unknown as FateApi);
    act(() => useRuntimeStore.setState((state) => ({ runtime: { ...state.runtime, status: 'ready', project: { path: '/project', name: 'Project', trusted: true }, sessionId: 'session' } })));
    const user = userEvent.setup();
    render(<MonitorDashboardPanel />);
    expect(await screen.findByText('Release check')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Runs 2/ }));
    await waitFor(() => expect(getMonitorDashboard).toHaveBeenCalledWith({ section: 'runs', offset: 0, limit: 25 }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(getMonitorDashboard).toHaveBeenCalledWith({ section: 'runs', offset: 25, limit: 25 }));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(getMonitorDashboard).toHaveBeenCalledTimes(4));
    dispose();
  });
  it('sends the displayed page revision on its bounded interval refresh', async () => {
    Reflect.deleteProperty(window, 'piDesktop');
    let tick: (() => void) | undefined;
    const realSetInterval = globalThis.setInterval;
    const timer = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) => {
      if (delay === 15_000) tick = callback as () => void;
      return realSetInterval(callback, delay, ...args);
    });
    const getMonitorDashboard = vi.fn(async ({ sinceRevision }: { sinceRevision?: string }) => ({ ...snapshot(), revision: sinceRevision ? 'b' : 'a' }));
    const dispose = installFateApi({ getMonitorDashboard } as unknown as FateApi);
    act(() => useRuntimeStore.setState((state) => ({ runtime: { ...state.runtime, status: 'ready', project: { path: '/project', name: 'Project', trusted: true }, sessionId: 'session' } })));
    render(<MonitorDashboardPanel />);
    await waitFor(() => expect(getMonitorDashboard).toHaveBeenCalledTimes(1));
    act(() => tick?.());
    await waitFor(() => expect(getMonitorDashboard).toHaveBeenLastCalledWith({ section: 'overview', offset: 0, limit: 25, sinceRevision: 'a' }));
    dispose();
    timer.mockRestore();
  });

  it('reads the shared snapshot, exposes source state, and opens a retained run', async () => {
    const getMonitorDashboard = vi.fn(async ({ section }: { section: MonitorDashboard['section'] }) => snapshot(section));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { getMonitorDashboard } });
    act(() => useRuntimeStore.setState((state) => ({ runtime: { ...state.runtime, status: 'ready', project: { path: '/project', name: 'Project', trusted: true }, sessionId: 'session' } })));
    render(<MonitorDashboardPanel />);
    expect(await screen.findByText('Release check')).toBeInTheDocument();
    expect(screen.getByLabelText('Work status')).toHaveTextContent('1 attention');
    await userEvent.click(screen.getByRole('button', { name: /Runs 2/ }));
    await waitFor(() => expect(getMonitorDashboard).toHaveBeenLastCalledWith({ section: 'runs', offset: 0, limit: 25 }));
    expect(screen.getByRole('button', { name: 'Open run' })).toBeInTheDocument();
  });

  it('shows an unavailable source rather than a healthy empty page', async () => {
    const missing = { ...snapshot(), overall: 'unknown' as const, sources: { ...snapshot().sources, runs: 'unknown' as const }, items: [], total: 0 };
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { getMonitorDashboard: vi.fn(async () => missing) } });
    act(() => useRuntimeStore.setState((state) => ({ runtime: { ...state.runtime, status: 'ready', project: { path: '/project', name: 'Project', trusted: true }, sessionId: 'session' } })));
    render(<MonitorDashboardPanel />);
    expect(await screen.findByText('Unavailable: runs')).toBeInTheDocument();
    expect(screen.getByText('unknown')).toBeInTheDocument();
  });

  it('renders bounded web row metadata and rejects a late prior-session result', async () => {
    const workspace: WebWorkspace = { workspaceId: '20000000-0000-4000-8000-000000000002', workspaceGeneration: 3, label: 'Project' };
    const scopeA = { ...workspace, sessionId: hostSession, selectionRevision: 4 };
    const scopeB = { ...workspace, sessionId: otherHostSession, selectionRevision: 5 };
    const makeNetworkDashboard = (sessionId: string, selectionRevision: number, state: 'normal' | 'attention'): NetworkMonitor => ({
      revision: `${selectionRevision.toString(36)}:rows`, sessionId, selectionRevision, checkedAt: 1000,
      overall: 'unknown', sources: { runs: 'partial', teams: 'ready', tasks: 'unknown', activity: 'ready' },
      sourceCheckedAt: { runs: 1000, teams: 1000, tasks: null, activity: 1000 },
      counts: { active: 1, attention: 1, runs: 1, teams: 0, tasks: 0, activity: 0 },
      section: 'overview', total: 1, offset: 0, limit: 25, unchanged: false,
      items: [{ id: '00000000000000000000000000000001', source: 'runs', state,
        title: 'Run',
        updatedAt: 1000, navigation: { kind: 'run', expiresAt: 90000 } }],
    });
    let finishA!: (value: { scope: typeof scopeA; dashboard: NetworkMonitor }) => void;
    const f = networkFixture();
    f.api.listWorkspaces.mockResolvedValue([workspace]);
    f.api.readMonitor.mockImplementation((scope) => f.host.sessionId === scopeA.sessionId
      ? new Promise<{ scope: typeof scopeA; dashboard: NetworkMonitor }>((resolve) => { finishA = resolve; })
      : Promise.resolve({ scope, dashboard: makeNetworkDashboard(scopeB.sessionId, scopeB.selectionRevision, 'normal') }));
    const readMonitor = f.api.readMonitor;
    installWebFateApi(f.api);
    await act(async () => { await useRuntimeStore.getState().initialize(f.api); await useRuntimeStore.getState().refresh(f.api); });
    const view = render(<MonitorDashboardPanel webScope={scopeA} />);
    await waitFor(() => expect(readMonitor).toHaveBeenCalledWith(scopeA, expect.objectContaining({ section: 'overview' })));
    await act(async () => { f.host.sessionId = otherHostSession; f.host.selectionRevision = 5; f.host.detail.state = 'normal'; await useRuntimeStore.getState().refresh(f.api); });
    view.rerender(<MonitorDashboardPanel webScope={scopeB} />);
    expect(await screen.findByText('Run')).toBeInTheDocument();
    const detailAction = screen.getByRole('button', { name: `Open Monitor row ${monitorRowId}` });
    await userEvent.click(detailAction);
    expect(await screen.findByRole('region', { name: 'Monitor row details' })).toHaveTextContent('Redacted source detail');
    expect(f.api.readMonitorDetail).toHaveBeenCalledWith(workspace, monitorRowId);
    expect(screen.queryByRole('button', { name: 'Open corresponding work' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open run/u })).not.toBeInTheDocument();
    expect(screen.getByText('normal')).toBeInTheDocument();
    expect(screen.getByText('Unavailable: tasks')).toBeInTheDocument();
    await act(async () => { finishA({ scope: scopeA, dashboard: makeNetworkDashboard(scopeA.sessionId, scopeA.selectionRevision, 'attention') }); });
    expect(screen.getByText('normal')).toBeInTheDocument();
    expect(screen.queryByText('attention', { selector: '.monitor-dashboard-row-state' })).not.toBeInTheDocument();
  });
  it('drops a delayed opaque detail through A→B→A and epoch/selection change, without a replacement operation', async () => {
    const f = networkFixture(); installWebFateApi(f.api);
    await act(async () => { await useRuntimeStore.getState().initialize(f.api); await useRuntimeStore.getState().refresh(f.api); });
    const scopeA = { ...alpha, sessionId: hostSession, selectionRevision: 4 };
    const view = render(<MonitorDashboardPanel webScope={scopeA} />);
    let finish!: (value: WireResultOf<'workspace.monitorDetail'>) => void;
    f.api.readMonitorDetail.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await userEvent.click(await screen.findByRole('button', { name: `Open Monitor row ${monitorRowId}` }));
    await waitFor(() => expect(f.api.readMonitorDetail).toHaveBeenCalledTimes(1));
    await act(async () => {
      f.host.epoch = '11000000-0000-4000-8000-000000000001'; f.host.sessionId = otherHostSession; f.host.selectionRevision = 5;
      useRuntimeStore.getState().select(beta); await useRuntimeStore.getState().refresh(f.api);
    });
    view.rerender(<MonitorDashboardPanel webScope={{ ...beta, sessionId: otherHostSession, selectionRevision: 5 }} />);
    await act(async () => { f.host.sessionId = hostSession; f.host.selectionRevision = 6;
      useRuntimeStore.getState().select(alpha); await useRuntimeStore.getState().refresh(f.api); });
    view.rerender(<MonitorDashboardPanel webScope={{ ...alpha, sessionId: hostSession, selectionRevision: 6 }} />);
    await act(async () => { finish({ id: monitorRowId, sessionId: hostSession, selectionRevision: 4, kind: 'run', state: 'attention',
      updatedAt: 1000, title: 'OLD_SCOPE_DETAIL_SENTINEL', detail: 'Old bounded source', redacted: true }); });
    expect(screen.queryByText('OLD_SCOPE_DETAIL_SENTINEL')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Monitor row details' })).not.toBeInTheDocument();
    expect(useRuntimeStore.getState().networkNavigation).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: `Open Monitor row ${monitorRowId}` }));
    expect(await screen.findByRole('region', { name: 'Monitor row details' })).toHaveTextContent('Redacted source detail');
    expect(f.api.readMonitorDetail).toHaveBeenCalledTimes(2);
    expect(f.api.sendPrompt).not.toHaveBeenCalled(); expect(f.api.controlTeam).not.toHaveBeenCalled();
  });

  it('does not show arbitrary network read errors or imply unknown or partial means no active work', async () => {
    const scope = { workspaceId: '20000000-0000-4000-8000-000000000002', workspaceGeneration: 3,
      label: 'Project', sessionId: hostSession, selectionRevision: 4 };
    const leak = 'FAKE_HOST_ERROR_WITH_PRIVATE_PATH';
    const f = networkFixture();
    f.api.readMonitor.mockRejectedValue(new Error(leak));
    installWebFateApi(f.api);
    render(<MonitorDashboardPanel webScope={scope} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Monitor unavailable. Refresh the workspace and try again.');
    expect(screen.queryByText(leak)).not.toBeInTheDocument();
    expect(screen.queryByText(/No active or flagged work/u)).not.toBeInTheDocument();
  });
});
