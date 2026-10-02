import * as Tabs from '@radix-ui/react-tabs';
import { Activity, Files, GitCompareArrows, Info, ListChecks, MessagesSquare, LayoutDashboard, Sparkles, Target } from 'lucide-react';
import { lazy, useEffect, useRef } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useShallow } from 'zustand/react/shallow';
import { AppTooltip } from '../../components/AppTooltip';
import { DeferredPanel } from '../../components/DeferredPanel';
import { ToolCard } from '../chat/ToolCard';
import { ChangesPanel } from '../diffs/ChangesPanel';
import { FilesPanel } from '../files/FilesPanel';
import { LazyDiffViewer } from '../files/LazyMonaco';
import { ResourcesPanel } from '../resources/ResourcesPanel';
import { ContextPanel } from './ContextPanel';
import { ActivityPanel } from './ActivityPanel';
import { MonitorDashboardPanel } from './MonitorDashboardPanel';
import { currentNetworkScope, useRuntimeStore, type ReadView } from '../../stores/runtimeStore';
import { selectGitStatusView, useWorkspaceStore } from '../../stores/workspaceStore';
import { getWebApiOptional } from '../../platform/api';
import { inspectorDestinationForTab, useUiStore } from '../../stores/uiStore';
import { GoalMaxInspector } from '../goalmaxxing/GoalMaxInspector';
import { useSkinComponents } from '../../skins/SkinProvider';

const SubagentSessionsPanel = lazy(() => import('./SubagentSessionsPanel').then((module) => ({ default: module.SubagentSessionsPanel })));

interface InspectorProps { onCollapse?: () => void }
const destinations = [
  { value: 'work', label: 'Work', tabs: [{ value: 'changes', label: 'Changes', icon: GitCompareArrows }, { value: 'files', label: 'Files', icon: Files }] },
  { value: 'run', label: 'Run', tabs: [{ value: 'monitor', label: 'Monitor', icon: LayoutDashboard }, { value: 'goal', label: 'Goal', icon: Target },
    { value: 'sessions', label: 'Agents', icon: MessagesSquare }, { value: 'tools', label: 'Tools', icon: ListChecks }, { value: 'activity', label: 'Activity', icon: Activity }] },
  { value: 'system', label: 'System', tabs: [{ value: 'context', label: 'Context', icon: Info }, { value: 'resources', label: 'Resources', icon: Sparkles }] },
] as const;
const webDestinations = [
  { value: 'work', label: 'Work', tabs: [{ value: 'files', label: 'Files', icon: Files }, { value: 'changes', label: 'Changes', icon: GitCompareArrows }] },
  { value: 'run', label: 'Run', tabs: [{ value: 'monitor', label: 'Monitor', icon: LayoutDashboard }, { value: 'goal', label: 'Goal', icon: Target }, { value: 'sessions', label: 'Agents / Tasks', icon: MessagesSquare }] },
] as const;
function RichRead<T>({ state, children }: { state: ReadView<T>; children: (value: T) => React.ReactNode }) {
  if (state.status !== 'ready') return <p role={state.status === 'error' ? 'alert' : 'status'}>Host read {state.status}. Refresh to retry. Unknown is not empty.</p>;
  return <>{children(state.value)}</>;
}
function HostGitDetails() {
  const web = getWebApiOptional();
  const snapshot = useRuntimeStore((state) => state.snapshot);
  const phase = useRuntimeStore((state) => state.phase);
  const source = useRuntimeStore((state) => state.source);
  const views = useWorkspaceStore((state) => state.hostGit);
  const load = useWorkspaceStore((state) => state.loadNetworkGit);
  const status = selectGitStatusView(useWorkspaceStore.getState(), source);
  useEffect(() => { if (web && phase === 'observing') void load(web); }, [web, snapshot, phase, load]);
  if (!web || !currentNetworkScope() || views.scopeKey !== currentNetworkScope()?.key) return <p role="status">Git is not current. Refresh a selected session snapshot.</p>;
  return <section className="monitor-dashboard" aria-label="Host Git details"><h2>Git status</h2>
    <RichRead state={views.status}>{() => status ? <><p>{status.repository ? `Branch: ${status.branch || '(detached)'} · ahead ${status.ahead} · behind ${status.behind}` : 'No repository in this workspace.'}</p>
      <p>Changes: {status.changes.length}{status.truncated ? ' (partial)' : ''} · +{status.additions} −{status.deletions}</p>
      <ul>{status.changes.map((change) => <li key={change.path}>{change.indexStatus}{change.workTreeStatus} {change.oldPath ? `${change.oldPath} → ` : ''}{change.path}
        <button type="button" aria-label={`Review diff ${change.path}`} onClick={() => void useWorkspaceStore.getState().readNetworkDiff(web, change.path)}>Review diff</button>
        {views.reviewedPaths.has(change.path) && <span> · reviewed in this view</span>}
      </li>)}</ul><button type="button" onClick={() => void useWorkspaceStore.getState().readNetworkDiff(web, null)}>Review combined diff</button></> : null}</RichRead>
    {(views.diff.status !== 'unavailable' || views.combined.status !== 'unavailable') && <section aria-label="Host Git diff">
      {views.diff.status !== 'unavailable' && <RichRead state={views.diff}>{(diff) => <><h3>{diff.path}</h3>{diff.state === 'text'
        ? <><pre aria-label="Original text">{diff.original ?? ''}</pre><pre aria-label="Modified text">{diff.modified ?? ''}</pre>
          <LazyDiffViewer original={diff.original ?? ''} modified={diff.modified ?? ''} language={diff.language} path={diff.path} />
          <button type="button" onClick={() => useWorkspaceStore.getState().markNetworkReviewed(diff.path)}>Toggle reviewed</button></>
        : <p>Diff {diff.state}; text is not available. This file is not marked reviewed.</p>}{diff.mediaOmitted && <p>Media omitted.</p>}</>}</RichRead>}
      {views.combined.status !== 'unavailable' && <RichRead state={views.combined}>{(diff) => <><pre>{diff.patch}</pre>{diff.truncated && <p>Combined diff is partial; this is not a complete review.</p>}</>}</RichRead>}
      <p>Reviewed markers are local inspection notes for this snapshot, not host approval or verification.</p>
    </section>}
    <h2>Git history</h2><RichRead state={views.history}>{(history) => <><p>HEAD: {history.head ?? 'none'}{history.truncated ? ' · history partial' : ''}</p><ol>{history.commits.map((commit) => <li key={commit.hash}>
      <strong>{commit.subject}</strong> · {commit.hash.slice(0, 12)} · {commit.authorName} · {new Date(commit.authoredAt).toLocaleString()}
      <button type="button" aria-label={`Inspect commit ${commit.hash}`} onClick={() => void useWorkspaceStore.getState().readNetworkCommit(web, commit.hash)}>Inspect commit</button>
    </li>)}</ol></>}</RichRead>
    {views.commit.status !== 'unavailable' && <RichRead state={views.commit}>{(commit) => <section aria-label="Host commit details"><h3>{commit.subject}</h3><p>{commit.hash} · {commit.filesChanged} files · +{commit.additions} −{commit.deletions}</p>
      <ul>{commit.files.map((file) => <li key={file.path}>{file.status} {file.path}</li>)}</ul>{commit.filesTruncated && <p>Commit file list is partial.</p>}</section>}</RichRead>}
    <p>Direct native Git commit/revert is unavailable on the network. Approved mutations use Team workspace review, checkpoint and integrate gates in Agents / Tasks.</p>
  </section>;
}
function RuntimeContextPanel() {
  const runtime = useRuntimeStore(useShallow((state) => ({ contextUsage: state.runtime.contextUsage, tokenTelemetry: state.runtime.tokenTelemetry,
    streaming: state.runtime.streaming, model: state.runtime.model, thinkingLevel: state.runtime.thinkingLevel, project: state.runtime.project, objective: state.runtime.objective })));
  return <ContextPanel runtime={runtime} />;
}
function ToolsPanel() {
  const order = useRuntimeStore((state) => state.toolOrder);
  const projectPath = useRuntimeStore((state) => state.runtime.project?.path);
  const sessionId = useRuntimeStore((state) => state.runtime.sessionId);
  const jump = useUiStore((state) => state.flightDeckJump);
  const clearFlightDeckJump = useUiStore((state) => state.clearFlightDeckJump);
  const showToast = useUiStore((state) => state.showToast);
  const listRef = useRef<VirtuosoHandle>(null);
  useEffect(() => {
    if (!jump || jump.projectPath !== projectPath || jump.sessionId !== sessionId || jump.target.kind !== 'tool') return;
    const index = order.indexOf(jump.target.toolCallId);
    if (index < 0 || !useRuntimeStore.getState().toolsById[jump.target.toolCallId]) {
      showToast({ kind: 'info', title: 'Activity not retained', message: 'That tool execution is no longer available in the bounded timeline.' }); clearFlightDeckJump(jump.nonce); return;
    }
    listRef.current?.scrollToIndex({ index, align: 'center', behavior: 'auto' });
  }, [clearFlightDeckJump, jump, order, projectPath, sessionId, showToast]);
  if (order.length === 0) return <div className="inspector-empty"><ListChecks size={24} /><strong>No tool activity</strong><p>Pi tool executions will be shown chronologically.</p></div>;
  return <Virtuoso ref={listRef} className="tool-history" data={order} computeItemKey={(_index, id) => id}
    itemContent={(_index, id) => <div className="tool-history-row"><ToolCard toolCallId={id} compact /></div>} followOutput="auto" />;
}
export function Inspector(_props: InspectorProps = {}) {
  const { TabContent } = useSkinComponents();
  const web = getWebApiOptional();
  const snapshot = useRuntimeStore((state) => state.snapshot);
  const selected = useRuntimeStore((state) => state.selected);
  const webPhase = useRuntimeStore((state) => state.phase);
  const confirmed = webPhase === 'observing' && web?.isConnected && selected && snapshot
    && snapshot.header.workspaceId === selected.workspaceId && snapshot.header.workspaceGeneration === selected.workspaceGeneration ? snapshot : null;
  const webScope = confirmed && selected && confirmed.header.sessionId && confirmed.header.selectionRevision !== undefined
    ? { ...selected, sessionId: confirmed.header.sessionId, selectionRevision: confirmed.header.selectionRevision } : undefined;
  const desktopActiveChildren = useRuntimeStore((state) => state.subagentOrder.reduce((count, id) => {
    const status = state.subagentsById[id]?.status; return count + (status === 'queued' || status === 'running' ? 1 : 0);
  }, 0) + (state.runtime.subagentWorkflows ?? []).filter((workflow) => workflow.status === 'running').length
    + (state.runtime.agentTeams ?? []).reduce((count, team) => count + team.activeTurns, 0));
  const activeChildren = web ? 0 : desktopActiveChildren; // Bounded rows are not lifecycle counts.
  const activeTab = useUiStore((state) => state.inspectorTab);
  const setActiveTab = useUiStore((state) => state.setInspectorTab);
  const openDestination = useUiStore((state) => state.openInspectorDestination);
  const activeDestinationValue = inspectorDestinationForTab(activeTab);
  const availableDestinations = web ? webDestinations : destinations;
  const activeDestination = availableDestinations.find(({ value }) => value === activeDestinationValue) ?? availableDestinations[0]!;
  return <aside className="inspector" aria-label="Project inspector">
    <nav className="inspector-primary-nav" aria-label="Inspector destinations">{availableDestinations.map(({ value, label }) => {
      const isActive = value === activeDestinationValue;
      const accessibleLabel = value === 'run' && activeChildren > 0 ? `${label}, ${activeChildren} active` : label;
      return <button type="button" key={value} className="inspector-primary-trigger" aria-current={isActive ? 'page' : undefined} aria-label={accessibleLabel}
        onClick={() => { if (!isActive) openDestination(value); }}><TabContent label={label} active={isActive} labelClassName="inspector-primary-label" />
        {value === 'run' && activeChildren > 0 ? <span className="inspector-run-count" aria-hidden="true">{activeChildren}</span> : null}</button>;
    })}</nav>
    <Tabs.Root value={activeTab} onValueChange={(value) => setActiveTab(value as typeof activeTab)} className="inspector-tabs">
      <Tabs.List aria-label={`${activeDestination.label} views`} className="inspector-secondary-tabs">{activeDestination.tabs.map(({ value, label, icon: Icon }) => <AppTooltip content={label} side="bottom" sideOffset={6} wrapTrigger triggerClassName="inspector-secondary-tooltip" key={value}>
        <Tabs.Trigger value={value} className="inspector-secondary-trigger" aria-label={value === 'sessions' ? web ? 'Agents / Tasks' : `Subagent sessions${activeChildren > 0 ? `, ${activeChildren} active` : ''}` : label}>
          <TabContent label={label} active={activeTab === value} labelClassName="inspector-secondary-label" icon={<Icon size={13} strokeWidth={1.75} aria-hidden="true" />} /></Tabs.Trigger></AppTooltip>)}</Tabs.List>
      <Tabs.Content value="changes" className="tab-content">{web ? <HostGitDetails /> : <ChangesPanel />}</Tabs.Content>
      <Tabs.Content value="files" className="tab-content"><FilesPanel /></Tabs.Content>
      <Tabs.Content value="sessions" className="tab-content"><DeferredPanel label="agent sessions" className="inspector-empty"><SubagentSessionsPanel key={web ? confirmed?.header.snapshotId : undefined} /></DeferredPanel></Tabs.Content>
      <Tabs.Content value="monitor" className="tab-content">{web && !confirmed ? <p className="inspector-empty" role="status">Monitor is not current. Last confirmed {snapshot ? new Date(snapshot.header.capturedAt).toLocaleString() : 'unknown'}; host work may continue. Reconnect or refresh before review.</p>
        : web && !webScope ? <p className="inspector-empty">Monitor requires a confirmed selected session. Unknown does not mean no active work.</p>
          : <MonitorDashboardPanel key={web ? confirmed?.header.snapshotId : undefined} {...(webScope ? { webScope } : {})} />}</Tabs.Content>
      <Tabs.Content value="goal" className="tab-content"><GoalMaxInspector /></Tabs.Content>
      {!web && <><Tabs.Content value="tools" className="tab-content"><ToolsPanel /></Tabs.Content><Tabs.Content value="activity" className="tab-content"><ActivityPanel /></Tabs.Content>
        <Tabs.Content value="resources" className="tab-content"><ResourcesPanel /></Tabs.Content><Tabs.Content value="context" className="tab-content"><RuntimeContextPanel /></Tabs.Content></>}
    </Tabs.Root>
  </aside>;
}
