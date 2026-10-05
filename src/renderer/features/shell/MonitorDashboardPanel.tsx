import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowUpRight, ChevronLeft, ChevronRight, LayoutDashboard, ListChecks, Loader2, Play, RefreshCw, TriangleAlert, Users } from 'lucide-react';
import type { WireResultOf } from '../../../shared/protocol/methods';
import { monitorItemSchema, type MonitorDashboard, type MonitorItem } from '../../../shared/contracts/monitorDashboard';
import type { NetworkMonitor } from '../../../shared/protocol/diagnostics';
import type { WebWorkspace } from '../../../client/WebFateApi';
import { currentNetworkScope, useRuntimeStore, type ReadView } from '../../stores/runtimeStore';
import { getFateApiOptional, getWebApiOptional, hasCapability } from '../../platform/api';
import { unavailableExplanation } from '../../platform/capabilityPolicy';
import { useUiStore } from '../../stores/uiStore';
import { openAgentNotice } from '../../stores/agentsStore';
import { selectTaskView, useTaskStore } from '../../stores/taskStore';
import { selectGoalView, useGoalMaxStore } from '../../stores/goalMaxStore';
import './monitorDashboard.css';

const SECTIONS = ['overview', 'runs', 'teams', 'tasks', 'activity'] as const;
const PAGE_SIZE = 25;
const SECTION_LABELS = { overview: 'Overview', runs: 'Runs', teams: 'Teams', tasks: 'Tasks', activity: 'Activity' } as const;
const ROW_ICONS = { run: Play, 'team-node': Users, task: ListChecks, event: Activity } as const;
const clock = (value: number) => new Date(value).toLocaleTimeString();

function DetailLink({ item, projectPath }: { item: MonitorItem; projectPath: string }) {
  const openTeamNode = useUiStore((state) => state.openAgentTeamNode);
  if (item.ref.kind === 'run') return <button type="button" className="activity-refresh" onClick={() => void openAgentNotice(projectPath, item.ref.id)}>Open run<ArrowUpRight size={10} aria-hidden="true" /></button>;
  if (item.ref.kind === 'team-node' && item.ref.teamId) return <button type="button" className="activity-refresh" onClick={() => openTeamNode(item.ref.teamId!, item.ref.id)}>Open agent<ArrowUpRight size={10} aria-hidden="true" /></button>;
  return null;
}

export function MonitorDashboardPanel({ webScope }: { webScope?: WebWorkspace & { readonly sessionId: string; readonly selectionRevision: number } } = {}) {
  const project = useRuntimeStore((state) => state.runtime.project);
  const desktopSessionId = useRuntimeStore((state) => state.runtime.sessionId);
  const sessionId = webScope?.sessionId ?? desktopSessionId;
  const [section, setSection] = useState<typeof SECTIONS[number]>('overview');
  const [offset, setOffset] = useState(0);
  const [dashboard, setDashboard] = useState<MonitorDashboard | NetworkMonitor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [detail, setDetail] = useState<ReadView<WireResultOf<'workspace.monitorDetail'>>>({ status: 'unavailable' });
  const detailRequest = useRef(0);
  const [detailScopeKey, setDetailScopeKey] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const supersedeDetail = useCallback(() => {
    // Cancellation owns the busy reset. A superseded navigation's finally must
    // not reset a newer navigation, but must not leave its old busy latch behind.
    const request = ++detailRequest.current;
    setNavigating(false); setNavigationError(null);
    setDetail({ status: 'unavailable' }); setDetailScopeKey(null);
    return request;
  }, []);
  useEffect(() => () => { detailRequest.current++; }, []);
  const web = getWebApiOptional();
  const supported = webScope ? web?.supports('workspace.monitor') === true : hasCapability('monitor');

  useEffect(() => {
    setDashboard(null);
    supersedeDetail();
    setOffset(0);
  }, [project?.path, sessionId, webScope?.workspaceId, webScope?.workspaceGeneration, webScope?.selectionRevision, supersedeDetail]);

  useEffect(() => {
    const api = getFateApiOptional();
    if (!supported || !sessionId || (webScope ? !web : !project?.trusted || !api?.getMonitorDashboard)) return undefined;
    let active = true;
    let busy = false;
    let revision: string | undefined;
    const read = async () => {
      if (busy) return;
      busy = true;
      try {
        const input = { section, offset, limit: PAGE_SIZE, ...(revision ? { sinceRevision: revision } : {}) };
        // Network rows have scoped selection metadata and opaque navigation
        // bindings, not host paths, raw source refs or desktop lifecycle objects.
        const next = webScope && web ? (await web.readMonitor(webScope, input)).dashboard
          : await api!.getMonitorDashboard(input);
        if (!active) return;
        if (webScope && ('projectPath' in next || next.sessionId !== webScope.sessionId
          || next.selectionRevision !== webScope.selectionRevision)) return;
        if (!webScope && (!('projectPath' in next) || !('sessionId' in next)
          || next.projectPath !== project?.path || next.sessionId !== sessionId)) return;
        setDashboard((previous) => next.unchanged && previous?.revision === next.revision && previous.section === section && previous.offset === offset
          ? { ...previous, checkedAt: next.checkedAt, overall: next.overall, sources: next.sources, sourceCheckedAt: next.sourceCheckedAt, counts: next.counts } : next);
        revision = next.revision;
        setError(null);
      } catch (reason) {
        if (active) {
          if (webScope) setDashboard(null);
          // Network failures can contain host/provider text. Do not print an
          // arbitrary exception in the browser Monitor, even on a read error.
          setError(webScope ? 'Monitor unavailable. Refresh the workspace and try again.'
            : reason instanceof Error ? reason.message : 'Dashboard unavailable.');
        }
      } finally { busy = false; }
    };
    void read();
    const timer = setInterval(() => void read(), 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [supported, project?.path, project?.trusted, sessionId, webScope?.workspaceId, webScope?.workspaceGeneration,
    webScope?.selectionRevision, section, offset, refresh]);

  const readDetail = async (id: string) => {
    const request = supersedeDetail();
    const captured = currentNetworkScope();
    if (!web || getWebApiOptional() !== web || !webScope || !captured || !web.isConnected || captured.header.serverEpoch !== web.serverEpoch || captured.scope.workspaceId !== webScope.workspaceId
      || captured.scope.workspaceGeneration !== webScope.workspaceGeneration || captured.sessionId !== webScope.sessionId
      || captured.header.selectionRevision !== webScope.selectionRevision) return;
    setDetailScopeKey(captured.key);
    setDetail({ status: 'loading' });
    try {
      const value = await web.readMonitorDetail(captured.scope, id);
      if (request === detailRequest.current && getWebApiOptional() === web && web.isConnected && captured.header.serverEpoch === web.serverEpoch && currentNetworkScope()?.key === captured.key
        && value.id === id && value.sessionId === captured.sessionId && value.selectionRevision === webScope.selectionRevision) setDetail({ status: 'ready', value });
    } catch { if (request === detailRequest.current && currentNetworkScope()?.key === captured.key) setDetail({ status: 'error' }); }
  };

  const navigate = async () => {
    const captured = currentNetworkScope();
    if (!web || getWebApiOptional() !== web || !captured || captured.key !== detailScopeKey || detail.status !== 'ready' || !detail.value.target || navigating) return;
    const original = detail.value;
    const request = ++detailRequest.current;
    const current = () => request === detailRequest.current && getWebApiOptional() === web && web.isConnected
      && captured.header.serverEpoch === web.serverEpoch && currentNetworkScope()?.key === captured.key;
    setNavigating(true); setNavigationError(null);
    useRuntimeStore.setState({ networkNavigation: null });
    try {
      // Revalidate the actual opaque binding at click time. A visible old detail
      // never authorizes a jump after removal, expiry, selection or host change.
      const fresh = await web.readMonitorDetail(captured.scope, original.id);
      if (!current()) return;
      if (fresh.id !== original.id || fresh.sessionId !== captured.sessionId || fresh.selectionRevision !== captured.header.selectionRevision
        || !fresh.target || JSON.stringify(fresh.target) !== JSON.stringify(original.target)) throw new Error('Target changed.');
      const target = fresh.target;
      if (target.kind === 'task') {
        await useTaskStore.getState().loadNetwork(web);
        if (!current()) return;
        if (!selectTaskView(useTaskStore.getState(), 'network')?.tasks.some((task) => task.id === target.taskId)) throw new Error('Target not retained.');
      } else if (target.kind === 'goal-criterion') {
        await useGoalMaxStore.getState().loadNetwork(web);
        if (!current()) return;
        const goal = selectGoalView(useGoalMaxStore.getState(), 'network');
        if (goal?.id !== target.goalId || !goal.criteria.some((criterion) => criterion.id === target.criterionId)) throw new Error('Target not retained.');
      } else {
        await useRuntimeStore.getState().loadNetworkViews(web, 'agents');
        if (!current()) return;
        const teams = useRuntimeStore.getState().networkViews.teams;
        if (teams.status !== 'ready' || !teams.value.teams.some((team) => team.id === target.teamId && team.nodes.some((node) => node.id === target.nodeId))) throw new Error('Target not retained.');
      }
      if (!current()) return;
      setDetail({ status: 'ready', value: fresh });
      useRuntimeStore.setState({ networkNavigation: { scopeKey: captured.key, target } });
      if (target.kind === 'team-node') useUiStore.getState().openAgentTeamNode(target.teamId, target.nodeId);
      else useUiStore.getState().setInspectorTab(target.kind === 'goal-criterion' ? 'goal' : 'sessions');
    } catch { if (current()) setNavigationError('Source target cannot be confirmed. Refresh this scoped page; no other row was selected.'); }
    finally { if (request === detailRequest.current) setNavigating(false); }
  };

  if (!supported) return <section className="monitor-dashboard monitor-panel monitor-dashboard--empty" aria-label="Monitoring dashboard">
    <div className="inspector-empty"><LayoutDashboard size={22} aria-hidden="true" /><strong>Monitor unavailable</strong><p>{unavailableExplanation.monitor}</p></div>
  </section>;
  if (!sessionId || (!webScope && !project?.trusted)) return <div className="monitor-dashboard monitor-panel monitor-dashboard--empty">
    <div className="inspector-empty"><LayoutDashboard size={22} aria-hidden="true" /><strong>Nothing to monitor</strong><p>Open a trusted project and session.</p></div>
  </div>;
  const shown = dashboard && dashboard.section === section && dashboard.offset === offset
    && (webScope ? !('projectPath' in dashboard) && dashboard.sessionId === webScope.sessionId
      && dashboard.selectionRevision === webScope.selectionRevision
      : 'projectPath' in dashboard && dashboard.projectPath === project?.path && dashboard.sessionId === sessionId)
    ? dashboard : null;
  const unknownSources = shown ? Object.entries(shown.sources).filter(([, status]) => status === 'unknown').map(([name]) => name) : [];
  return (
    <section className="monitor-dashboard monitor-panel activity-panel" aria-label="Monitoring dashboard">
      <header className="monitor-dashboard-header activity-head">
        <strong>Monitor</strong>
        {shown ? <span className={`monitor-state monitor-state--${shown.overall}`}>{shown.overall}</span> : null}
        {shown ? <span className="monitor-dashboard-metrics activity-counts" aria-label="Work status">
          <span data-tone={shown.counts.attention > 0 ? 'attention' : undefined}><strong>{shown.counts.attention}</strong> attention</span>
          {' '}<span data-tone={shown.counts.active > 0 ? 'active' : undefined}><strong>{shown.counts.active}</strong> active</span>
        </span> : null}
        <button type="button" className="activity-refresh" onClick={() => { supersedeDetail(); setRefresh((value) => value + 1); }}><RefreshCw size={10} aria-hidden="true" />Refresh</button>
      </header>
      <nav className="monitor-dashboard-sections activity-filters" aria-label="Dashboard sections">
        {SECTIONS.map((name) => <button key={name} type="button" className="activity-chip" aria-current={section === name ? 'page' : undefined}
          onClick={() => { supersedeDetail(); setSection(name); setOffset(0); }}>{SECTION_LABELS[name]}{name !== 'overview' && shown ? <>{' '}<span className="monitor-dashboard-count">{shown.counts[name]}</span></> : null}</button>)}
      </nav>
      {unknownSources.length > 0 ? <p className="monitor-dashboard-unknown activity-bounded"><TriangleAlert size={11} aria-hidden="true" /><span>Unavailable: {unknownSources.join(', ')}</span></p> : null}
      {shown?.sources.runs === 'partial' ? <p className="monitor-dashboard-unknown activity-bounded"><TriangleAlert size={11} aria-hidden="true" /><span>Runs: latest 1,000 only.</span></p> : null}
      {error ? <p role="alert" className="monitor-dashboard-error activity-status activity-status--error">{error}</p> : null}
      <div className="monitor-dashboard-body">
        {!shown && !error ? <p className="monitor-dashboard-empty activity-status" role="status"><Loader2 size={11} className="activity-spinner" aria-hidden="true" />Loading…</p> : null}
        {shown?.items.length === 0 && !error ? <p className="monitor-dashboard-empty">{shown.overall === 'unknown' || Object.values(shown.sources).some((status) => status !== 'ready')
          ? 'No rows returned. A source is partial or unknown; this does not prove there is no active work.'
          : `No ${section === 'overview' ? 'active or flagged work' : section}.`}</p> : null}
        {shown ? <ol className="monitor-dashboard-list" start={offset + 1}>
          {shown.items.map((item) => {
            const kind = 'ref' in item ? item.ref.kind : 'navigation' in item && item.navigation ? item.navigation.kind : null;
            const Icon = kind ? ROW_ICONS[kind] : Activity;
            const detailText = !webScope && 'detail' in item && typeof item.detail === 'string' ? item.detail : '';
            return <li key={item.id} className={`monitor-dashboard-row monitor-dashboard-row--${item.state} activity-row`}>
              <span className="monitor-dashboard-row-state">{item.state}</span>
              <span className="activity-kind"><Icon size={12} aria-hidden="true" /></span>
              <span className="activity-text">
                <strong>{item.title}</strong>
                {detailText ? <small title={detailText}>{detailText}</small> : null}
                {webScope && !('navigation' in item && item.navigation) ? <small>Detail navigation unavailable for this row.</small> : null}
              </span>
              <span className="monitor-dashboard-row-side">
                <time className="activity-time" dateTime={new Date(item.updatedAt).toISOString()} title={new Date(item.updatedAt).toLocaleString()}>{clock(item.updatedAt)}</time>
                {webScope && 'navigation' in item && item.navigation
                  ? <button type="button" className="activity-refresh" aria-label={`Open Monitor row ${item.id}`} onClick={() => void readDetail(item.id)}>Open details<ArrowUpRight size={10} aria-hidden="true" /></button> : null}
                {!webScope && project && monitorItemSchema.safeParse(item).success
                  ? <DetailLink item={monitorItemSchema.parse(item)} projectPath={project.path} /> : null}
              </span>
            </li>;
          })}
        </ol> : null}
        {webScope && detailScopeKey === currentNetworkScope()?.key && detail.status !== 'unavailable' && <section className="monitor-dashboard-detail" aria-label="Monitor row details">
          {detail.status === 'ready' ? <><h3>{detail.value.title}</h3><p className="monitor-dashboard-detail-meta">{detail.value.state} · {detail.value.kind} · {new Date(detail.value.updatedAt).toLocaleString()}</p>
            <p className="monitor-dashboard-detail-text">{detail.value.detail}</p>{detail.value.redacted && <p className="monitor-dashboard-detail-meta">Provider/private detail is withheld by host policy.</p>}
            {detail.value.target ? <button type="button" className="activity-refresh" disabled={navigating || !web?.isConnected} onClick={() => void navigate()}>Open corresponding work<ArrowUpRight size={10} aria-hidden="true" /></button>
              : <p className="monitor-dashboard-detail-meta">This bounded source detail has no canonical task, Team node or criterion target. No run ID is invented.</p>}
            {navigationError && <p role="alert" className="monitor-dashboard-error">{navigationError}</p>}</> : <p className="monitor-dashboard-detail-meta" role={detail.status === 'error' ? 'alert' : 'status'}>{detail.status === 'error' ? 'Detail unavailable or stale. Refresh this scoped page; unknown is not empty.' : 'Reading scoped detail…'}</p>}
        </section>}
        {webScope && shown ? <p className="monitor-dashboard-note activity-disclosure">Detail links use opaque host-issued row bindings. The host checks scope, selection and lifetime before each read.</p> : null}
      </div>
      {shown && shown.total > PAGE_SIZE ? <div className="monitor-dashboard-pagination">
        <button type="button" className="activity-refresh" disabled={offset === 0} onClick={() => { supersedeDetail(); setOffset((value) => Math.max(0, value - PAGE_SIZE)); }}><ChevronLeft size={10} aria-hidden="true" />Previous</button>
        <span>{offset + 1}–{Math.min(offset + PAGE_SIZE, shown.total)} / {shown.total}</span>
        <button type="button" className="activity-refresh" disabled={offset + PAGE_SIZE >= shown.total} onClick={() => { supersedeDetail(); setOffset((value) => value + PAGE_SIZE); }}>Next<ChevronRight size={10} aria-hidden="true" /></button>
      </div> : null}
      {shown ? <footer className="monitor-dashboard-sources" aria-label="Source check times"
        title={(Object.keys(shown.sources) as Array<keyof typeof shown.sources>).map((name) =>
          `${name} ${shown.sourceCheckedAt[name] === null ? '—' : clock(shown.sourceCheckedAt[name]!)}`).join(' · ')}>
        <time dateTime={new Date(shown.checkedAt).toISOString()}>Checked {clock(shown.checkedAt)}</time>
      </footer> : null}
    </section>
  );
}
