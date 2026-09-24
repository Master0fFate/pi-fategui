import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { ClipboardList, Copy, History, Home, MessageSquarePlus, MoreHorizontal, Play, Plus, RefreshCw, Search, Timer, Users } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AgentDraft, AgentRun, RoutineSave, TaskTemplateSave } from '../../../shared/contracts/agents';
import { useSkinComponents } from '../../skins/SkinProvider';
import { AppTooltip } from '../../components/AppTooltip';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { SelectControl } from '../../components/SelectControl';
import { useAgentsStore, agentError } from '../../stores/agentsStore';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { AgentLibraryEditor, initialLibraryDraft, type LibraryDefinition, type LibraryDraft, type LibraryKind } from './AgentLibraryEditor';
import './agents.css';

type Revision = { revision: number; digest: string };
type Editor = { kind: LibraryKind; item?: LibraryDefinition; expected: Revision | null };
type CopyPreview = Awaited<ReturnType<Window['piDesktop']['previewAutomationCopy']>>;
const sectionItems = [
  { key: 'agents', label: 'Agents', mark: '@', Icon: Users },
  { key: 'tasks', label: 'TaskTemplates', visibleLabel: 'Tasks', mark: '=', Icon: ClipboardList },
  { key: 'routines', label: 'Routines', visibleLabel: 'Routine', mark: '%', Icon: Timer },
  { key: 'history', label: 'Run history', visibleLabel: 'Runs', mark: '?', Icon: History },
  { key: 'migration', label: 'Copy Automations', visibleLabel: 'Import', mark: '+', Icon: Copy },
] as const;
const sectionHelp = {
  agents: 'Saved specialists. Open a home chat or start a fresh one.',
  tasks: 'Reusable prompts. Run one with an enabled Agent.',
  routines: 'Scheduled tasks run while Fate UI is open.',
  history: 'Review results, errors and actions waiting for approval.',
  migration: 'Copy an old Automation into a task. The original stays.',
} as const;
const date = (timestamp: number | null | undefined, timeZone?: string) => timestamp == null ? 'Not scheduled' : new Date(timestamp).toLocaleString(undefined, timeZone ? { timeZone } : undefined);

export function SidebarAgents() {
  const { ActionContent, Symbol } = useSkinComponents();
  const project = useRuntimeStore((state) => state.runtime.project);
  const livePermission = useRuntimeStore((state) => state.runtime.permissionLevel);
  const { library, legacy, legacyLoading, legacyError, busy, loading, error, view, selectedRunId } = useAgentsStore();
  const [queriesByView, setQueriesByView] = useState<Partial<Record<typeof view, string>>>({});
  const searchValue = queriesByView[view] ?? '';
  const setSearchValue = (value: string) => setQueriesByView((current) => ({ ...current, [view]: value }));
  const searchPlaceholder = view === 'agents' ? 'Search agents' : view === 'tasks' ? 'Search tasks' : view === 'routines' ? 'Search routines' : view === 'history' ? 'Search runs' : 'Search old Automations';
  const needle = searchValue.trim().toLocaleLowerCase();
  const agentNames = useMemo(() => new Map(library.agents.map((agent) => [agent.id, agent.name])), [library.agents]);
  const taskNames = useMemo(() => new Map(library.tasks.map((task) => [task.id, task.name])), [library.tasks]);
  const homes = useMemo(() => new Map(library.states.map((state) => [state.agentId, state])), [library.states]);
  const firstAgent = library.agents.find((agent) => agent.enabled)?.id ?? '';
  const firstTask = library.tasks.find((task) => task.enabled)?.id ?? '';
  const runVisible = (run: AgentRun) => !needle || [run.id, run.status, agentNames.get(run.agentId) ?? 'Deleted Agent', taskNames.get(run.taskTemplateId) ?? 'Deleted task'].some((value) => value.toLocaleLowerCase().includes(needle));
  const [scope, setScope] = useState('all');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; message: string; label: string; action: () => Promise<unknown> } | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [runRequest, setRunRequest] = useState<{ agentId: string; taskTemplateId: string; routineId?: string } | null>(null);
  const [copy, setCopy] = useState<CopyPreview | null>(null);
  const [approval, setApproval] = useState<{ run: AgentRun; action: AgentRun['approvals'][number] } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const projectPath = project?.path ?? null;
  const unavailable = !project?.trusted || busy;
  useEffect(() => {
    void useAgentsStore.getState().load(project?.trusted ? project.path : null);
    setEditor(null); setConfirm(null); setRunRequest(null); setCopy(null); setApproval(null); setQueriesByView({}); setDialogError(null);
  }, [projectPath, project?.trusted]);
  useEffect(() => {
    if (view === 'migration') void useAgentsStore.getState().loadLegacy(projectPath);
  }, [projectPath, view]);
  useEffect(() => {
    if (selectedRunId && view === 'history') document.getElementById(`agent-run-${selectedRunId}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedRunId, view, library.runs]);

  const perform = async (operation: () => Promise<unknown>, done?: () => void) => {
    setDialogError(null);
    try { await useAgentsStore.getState().mutate(operation); done?.(); }
    catch (error) { setDialogError(agentError(error)); }
  };
  const save = async (draft: LibraryDraft) => {
    if (!editor) return;
    await useAgentsStore.getState().mutate(() => {
      const base = { ...(editor.item ? { id: editor.item.id } : {}), expected: editor.expected };
      if (editor.kind === 'agent') return window.piDesktop.saveAgentDefinition({ ...base, value: draft as AgentDraft });
      if (editor.kind === 'task') return window.piDesktop.saveTaskTemplate({ ...base, value: draft as TaskTemplateSave['value'] });
      return window.piDesktop.saveRoutineDefinition({ ...base, value: draft as RoutineSave['value'] });
    });
  };
  const edit = (kind: LibraryKind, item?: LibraryDefinition) => setEditor({ kind, ...(item ? { item } : {}), expected: item ? library.revisions[`${kind}:${item.id}`]! : null });
  const toggle = (kind: LibraryKind, item: LibraryDefinition) => {
    const value = { ...initialLibraryDraft(kind, item), enabled: !item.enabled };
    const base = { id: item.id, expected: library.revisions[`${kind}:${item.id}`]! };
    void perform(() => kind === 'agent' ? window.piDesktop.saveAgentDefinition({ ...base, value: value as AgentDraft }) : kind === 'task' ? window.piDesktop.saveTaskTemplate({ ...base, value: value as TaskTemplateSave['value'] }) : window.piDesktop.saveRoutineDefinition({ ...base, value: value as RoutineSave['value'] }));
  };
  const remove = (kind: LibraryKind, item: LibraryDefinition) => {
    setDialogError(null);
    const expected = library.revisions[`${kind}:${item.id}`]!;
    setConfirm({ title: `Delete ${item.name}?`, message: 'The definition will be disabled and removed from this library. Saved conversations, definition revisions and run history are retained. Bound runs stop; the original Automation, if any, is unchanged.', label: 'Delete definition', action: () => window.piDesktop.deleteAgentLibraryItem({ kind, id: item.id, expected }) });
  };
  const open = (agentId: string, mode: 'home' | 'new') => {
    const requestedFromRevision = useUiStore.getState().sidebarTabRevision;
    void perform(async () => {
      await window.piDesktop.openAgentConversation({ agentId, mode });
      useRuntimeStore.getState().setRuntime(await window.piDesktop.getRuntimeState());
      const current = useUiStore.getState();
      // Do not overwrite a newer explicit sidebar choice made while the IPC
      // operation was pending. The tab switch is navigation, not completion.
      if (current.sidebarTab === 'agents' && current.sidebarTabRevision === requestedFromRevision) current.setSidebarTab('sessions');
    });
  };
  const visible = (item: LibraryDefinition) => item.name.toLocaleLowerCase().includes(needle) && (view === 'routines' || scope === 'all' || ('scope' in item && item.scope === scope));
  const visibleAgents = view === 'agents' ? library.agents.filter(visible) : [];
  const visibleTasks = view === 'tasks' ? library.tasks.filter(visible) : [];
  const visibleRoutines = view === 'routines' ? library.routines.filter(visible) : [];
  const visibleRuns = view === 'history' ? library.runs.filter(runVisible) : [];
  const visibleLegacy = view === 'migration' ? legacy.filter((item) => item.name.toLocaleLowerCase().includes(needle)) : [];
  const actions = (kind: LibraryKind, item: LibraryDefinition, extra?: ReactNode) => <Popover.Root>
    <Popover.Trigger asChild>
      <button type="button" className="agent-menu-trigger" disabled={unavailable} aria-label={`Actions for ${item.name}`} title={`Actions for ${item.name}`}><ActionContent text="more"><MoreHorizontal size={14} aria-hidden="true" /></ActionContent></button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="agent-library-menu" role="menu" aria-label={`Actions for ${item.name}`} side="bottom" align="end" sideOffset={4} collisionPadding={8}>
        <Popover.Close asChild><button type="button" role="menuitem" className="agent-library-menu-item" aria-label={`Edit ${item.name}`} onClick={() => edit(kind, item)}><ActionContent text="edit">Edit</ActionContent></button></Popover.Close>
        <Popover.Close asChild><button type="button" role="menuitem" className="agent-library-menu-item" aria-label={`${item.enabled ? 'Disable' : 'Enable'} ${item.name}`} onClick={() => toggle(kind, item)}><ActionContent text={item.enabled ? 'disable' : 'enable'}>{item.enabled ? 'Disable' : 'Enable'}</ActionContent></button></Popover.Close>
        {extra}
        <Popover.Close asChild><button type="button" role="menuitem" className="agent-library-menu-item agent-library-menu-item--danger" aria-label={`Delete ${item.name}`} onClick={() => remove(kind, item)}><ActionContent text="delete">Delete</ActionContent></button></Popover.Close>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
  const chosenAgent = library.agents.find((agent) => agent.id === runRequest?.agentId);
  const chosenTask = library.tasks.find((task) => task.id === runRequest?.taskTemplateId);
  const chosenRoutine = library.routines.find((routine) => routine.id === runRequest?.routineId);
  const effective = livePermission === 'read-only' || !livePermission || chosenAgent?.defaults.permission === 'read-only' || chosenTask?.permissionCeiling === 'read-only' || chosenRoutine?.permissionCeiling === 'read-only' ? 'Read only' : 'Edit project files';

  return <section className="sidebar-agent-library" aria-label="Agents library">
    {!project?.trusted ? <>
      <header className="agent-library-heading"><div><strong>Agents</strong><small>local library</small></div><button type="button" className="agent-quiet-action agent-refresh-action" disabled={loading || busy || !project?.trusted} onClick={() => void useAgentsStore.getState().load(projectPath)} aria-label="Refresh Agents" title="Refresh"><ActionContent text="r"><RefreshCw size={14} aria-hidden="true" /></ActionContent></button></header>
      <p className="agent-library-note agent-library-intro">Your specialists, repeatable tasks and schedules.</p>
      <nav className="agent-library-navigation" aria-label="Agents sections">{sectionItems.map(({ key, label, mark, Icon, ...item }) => <button type="button" key={key} aria-label={label} title={label} aria-pressed={view === key} onClick={() => useAgentsStore.getState().setView(key)}><span className="agent-library-nav-symbol"><Symbol text={mark}><Icon size={14} aria-hidden="true" /></Symbol></span><span className="agent-library-nav-label" aria-hidden="true">{'visibleLabel' in item ? item.visibleLabel : label}</span></button>)}</nav>
      <p className="agent-library-note agent-library-section-help">{sectionHelp[view]}</p>
      <p className="agent-library-empty">Open and trust a project to manage Agents.</p>
    </> : <>
      <div className="agent-library-toolbar sidebar-tab-toolbar">
        <label className="agent-library-search sidebar-search">
          <Search size={15} aria-hidden="true" />
          <input className="icon-label" type="search" aria-label="Search Agents library" placeholder={searchPlaceholder} value={searchValue} onChange={(event) => setSearchValue(event.target.value)} />
        </label>
        {view !== 'history' && view !== 'migration' && <AppTooltip content={view === 'agents' ? 'New Agent' : view === 'tasks' ? 'New TaskTemplate' : 'New Routine'} wrapTrigger triggerClassName="sidebar-toolbar-action sidebar-toolbar-action--primary">
          <button type="button" disabled={busy} aria-label={view === 'agents' ? 'New Agent' : view === 'tasks' ? 'New TaskTemplate' : 'New Routine'} onClick={() => edit(view === 'agents' ? 'agent' : view === 'tasks' ? 'task' : 'routine')}><ActionContent text="new"><Plus size={15} aria-hidden="true" /></ActionContent></button>
        </AppTooltip>}
      </div>
      <header className="agent-library-heading"><div><strong>Agents</strong><small>local library</small></div><button type="button" className="agent-quiet-action agent-refresh-action" disabled={loading || busy || !project?.trusted} onClick={() => void useAgentsStore.getState().load(projectPath)} aria-label="Refresh Agents" title="Refresh"><ActionContent text="r"><RefreshCw size={14} aria-hidden="true" /></ActionContent></button></header>
      <nav className="agent-library-navigation" aria-label="Agents sections">{sectionItems.map(({ key, label, mark, Icon, ...item }) => <button type="button" key={key} aria-label={label} title={label} aria-pressed={view === key} onClick={() => useAgentsStore.getState().setView(key)}><span className="agent-library-nav-symbol"><Symbol text={mark}><Icon size={14} aria-hidden="true" /></Symbol></span><span className="agent-library-nav-label" aria-hidden="true">{'visibleLabel' in item ? item.visibleLabel : label}</span></button>)}</nav>
      <p className="agent-library-note agent-library-section-help">{sectionHelp[view]}</p>
      {(view === 'agents' || view === 'tasks') && <div className="agent-library-scope-row"><label className="agent-library-scope">Available in<SelectControl compact label="Filter definition scope" value={scope} options={[{ value: 'all', label: 'All locations' }, { value: 'user', label: 'All trusted projects' }, { value: 'project', label: 'This project' }]} onValueChange={setScope} /></label></div>}
      {loading && <p className="agent-library-inline-status" role="status">Loading {view === 'history' ? 'runs' : view === 'migration' ? 'imports' : view}…</p>}
      {error && <p className="agent-library-error" role="alert">{error}</p>}
      {library.diagnostics.length > 0 && <div className="agent-library-error" role="alert"><strong>Records need attention; source data was preserved.</strong>{library.diagnostics.map((diagnostic, index) => <p key={index}>{diagnostic}</p>)}</div>}
      <div className="agent-library-list" aria-busy={loading}>
        {view === 'agents' && <>
          {visibleAgents.map((agent) => {
            const home = homes.get(agent.id);
            return <article className="agent-library-card" key={agent.id} aria-label={`Agent ${agent.name}`} data-disabled={!agent.enabled || undefined}>
              <div className="agent-library-card-heading">
                <div className="agent-library-card-title"><h3>{agent.name}</h3><small>{agent.scope} · r{agent.revision} · {agent.enabled ? 'on' : 'off'}</small></div>
                {actions('agent', agent)}
              </div>
              <p className="agent-card-description" title={agent.description || undefined}>{agent.description || 'No description yet.'}</p>
              <div className="agent-library-card-tools agent-chat-actions">
                <button type="button" className="agent-primary-action" disabled={unavailable || !agent.enabled} aria-label="Open home conversation" title="Resume this Agent's home chat" onClick={() => open(agent.id, 'home')}><ActionContent text="home"><Home size={13} aria-hidden="true" /></ActionContent><span>Home chat</span></button>
                <button type="button" className="agent-primary-action" disabled={unavailable || !agent.enabled} aria-label="Start Session" title="Start a new chat with current instructions" onClick={() => open(agent.id, 'new')}><ActionContent text="new"><MessageSquarePlus size={13} aria-hidden="true" /></ActionContent><span>New chat</span></button>
                <button type="button" className="agent-primary-action" disabled={unavailable || !agent.enabled || !firstTask} aria-label="Run task" title="Run a saved task with this Agent" onClick={() => { setDialogError(null); setRunRequest({ agentId: agent.id, taskTemplateId: firstTask }); }}><ActionContent text="run"><Play size={13} aria-hidden="true" /></ActionContent><span>Run task</span></button>
              </div>
              {home?.homeSessionId && <small className="agent-library-note agent-card-home">Home chat uses revision {home.appliedRevision}{home.appliedRevision !== agent.revision ? ' · older instructions retained; use New chat for the latest' : ''}</small>}
              <details className="agent-library-details"><summary>Details</summary><p>{agent.defaults.permission} · {agent.defaults.thinkingLevel} · {agent.defaults.model ? `${agent.defaults.model.provider}/${agent.defaults.model.id}` : 'Live selected model'}</p><p>Skills: {agent.skillRefs.join(', ') || 'None'}</p><pre>{agent.instructions || 'No additional system instructions.'}</pre><small>ID {agent.id}</small></details>
            </article>;
          })}
          {!visibleAgents.length && !loading && <p className="agent-library-empty">{library.agents.length ? 'No agents match. Clear the search or change the scope.' : 'No saved Agents. Select + to create a specialist, then open its home chat.'}</p>}
        </>}
        {view === 'tasks' && <>
          {visibleTasks.map((task) => <article key={task.id} className="agent-library-card" aria-label={`TaskTemplate ${task.name}`} data-disabled={!task.enabled || undefined}>
            <div className="agent-library-card-heading">
              <div className="agent-library-card-title"><h3>{task.name}</h3><small>{task.scope} · {task.permissionCeiling} · r{task.revision}</small></div>
              <div className="agent-library-card-tools">
                <button type="button" className="agent-primary-action" disabled={unavailable || !task.enabled || !firstAgent} aria-label="Run task" title="Run this TaskTemplate" onClick={() => { setDialogError(null); setRunRequest({ agentId: firstAgent, taskTemplateId: task.id }); }}><ActionContent text="run">Run</ActionContent></button>
                {actions('task', task, task.automationSource ? <Popover.Close asChild><button type="button" role="menuitem" className="agent-library-menu-item" aria-label="Roll back copy" disabled={unavailable} onClick={() => { setDialogError(null); const expected = library.revisions[`task:${task.id}`]!; setConfirm({ title: 'Roll back Automation copy?', message: 'This TaskTemplate is removed; the original Automation stays unchanged.', label: 'Roll back copy', action: () => window.piDesktop.rollbackAutomationCopy({ taskId: task.id, expected }) }); }}><ActionContent text="rollback">Roll back copy</ActionContent></button></Popover.Close> : undefined)}
              </div>
            </div>
            <details className="agent-library-details"><summary>Prompt</summary><pre>{task.prompt}</pre></details>
            {task.automationSource && <small className="agent-library-note agent-card-home">Copied from Automation · source remains unchanged</small>}
          </article>)}
          {!visibleTasks.length && !loading && <p className="agent-library-empty">{library.tasks.length ? 'No tasks match. Clear the search or change the scope.' : 'No tasks yet. Select + to save a prompt you can run with an Agent.'}</p>}
        </>}
        {view === 'routines' && <>
          <p className="agent-library-note agent-library-section-note">Runs only while Fate UI is open. Missed or overlapping runs are skipped.</p>
          {visibleRoutines.map((routine) => <article key={routine.id} className="agent-library-card" aria-label={`Routine ${routine.name}`} data-disabled={!routine.enabled || undefined}>
            <div className="agent-library-card-heading">
              <div className="agent-library-card-title"><h3>{routine.name}</h3><small>{routine.enabled ? 'on' : 'paused'} · {routine.intervalMinutes}m</small></div>
              <div className="agent-library-card-tools">
                <button type="button" className="agent-primary-action" disabled={unavailable || !routine.enabled} title={routine.enabled ? 'Test this Routine' : 'Enable this Routine before a test run.'} aria-label="Test run" onClick={() => { setDialogError(null); setRunRequest({ agentId: routine.agentId, taskTemplateId: routine.taskTemplateId, routineId: routine.id }); }}><ActionContent text="test">Test</ActionContent></button>
                <button type="button" className="agent-primary-action" onClick={() => { useAgentsStore.getState().setView('history'); void useAgentsStore.getState().load(projectPath, routine.id); }} aria-label="Run history" title="View Routine history"><ActionContent text="history">History</ActionContent></button>
                {actions('routine', routine)}
              </div>
            </div>
            <p className="agent-card-route">{agentNames.get(routine.agentId) ?? 'Unavailable Agent'} <span aria-hidden="true">→</span> {taskNames.get(routine.taskTemplateId) ?? 'Unavailable task'}</p>
            <small className="agent-library-note agent-card-next">Next {routine.enabled ? date(library.nextDue[routine.id], routine.timeZone) : 'paused'} · {routine.timeZone}</small>
          </article>)}
          {!visibleRoutines.length && !loading && <p className="agent-library-empty">{library.routines.length ? 'No routines match. Clear the search or change the scope.' : 'No Routines yet. Select + to schedule an Agent and a saved task.'}</p>}
        </>}
        {view === 'history' && <>
          <label className="agent-library-history-filter">Routine history<SelectControl compact label="Filter run history" value={useAgentsStore.getState().historyRoutineId ?? 'all-sources'} options={[{ value: 'all-sources', label: 'All sources' }, ...library.routines.map((routine) => ({ value: routine.id, label: routine.name }))]} onValueChange={(value) => void useAgentsStore.getState().load(projectPath, value === 'all-sources' ? null : value)} /></label>
          <p className="agent-library-note agent-library-section-note">Last 100 runs per Routine. Interrupted actions are not replayed automatically.</p>
          {visibleRuns.map((run) => <article id={`agent-run-${run.id}`} key={run.id} className="agent-library-card agent-run-card" aria-label={`Run ${run.id}`} data-focused={selectedRunId === run.id || undefined}>
            <div className="agent-library-card-heading"><div className="agent-library-card-title"><h3>{agentNames.get(run.agentId) ?? 'Deleted Agent'} <span aria-hidden="true">·</span> {taskNames.get(run.taskTemplateId) ?? 'Deleted task'}</h3><small>{date(run.scheduledFor)} · r{run.agentRevision}/{run.taskTemplateRevision}{run.routineRevision ? `/${run.routineRevision}` : ''} · {run.permission}</small></div><strong className="agent-run-status" data-status={run.status}>{run.status}</strong></div>
            {run.resultSummary && <pre>{run.resultSummary}</pre>}{run.error && <p className="agent-library-error">{run.error}</p>}
            {run.approvals.map((action) => <div className="agent-run-approval" key={action.id}><span>File action · {action.status}</span>{action.status === 'pending' && <button type="button" className="agent-primary-action" disabled={busy} aria-label="Review action" onClick={() => { setApproval({ run, action }); setReviewed(false); setDialogError(null); }}><ActionContent text="review">Review</ActionContent></button>}</div>)}
            <div className="agent-library-card-tools agent-run-tools"><button type="button" className="agent-primary-action" disabled={!run.sessionId || ['running', 'needs-attention', 'queued'].includes(run.status) || busy} aria-label="Open resulting session" onClick={() => void perform(async () => { await window.piDesktop.openAgentRunSession({ runId: run.id }); useRuntimeStore.getState().setRuntime(await window.piDesktop.getRuntimeState()); useUiStore.getState().setSidebarTab('sessions'); })}><ActionContent text="open">Open</ActionContent></button>
              {['running', 'needs-attention', 'queued'].includes(run.status) && <button type="button" className="agent-primary-action" disabled={busy} onClick={() => void perform(() => window.piDesktop.cancelAgentRun({ runId: run.id }))} aria-label={run.status === 'needs-attention' ? 'Stop / dismiss without replay' : 'Stop run'}><ActionContent text="stop">Stop</ActionContent></button>}
            </div><small className="agent-run-id">Run {run.id}{run.sessionId ? ` · Session ${run.sessionId}` : ''}</small>
          </article>)}
          {!visibleRuns.length && !loading && <p className="agent-library-empty">{library.runs.length ? 'No runs match. Clear the search or select all sources.' : 'No runs yet. Run a task or enable a Routine to see results here.'}</p>}
        </>}
        {view === 'migration' && <>
          <p className="agent-library-note agent-library-section-note">Legacy Automations · copy only · original file stays unchanged</p>
          {legacyLoading && <p className="agent-library-inline-status" role="status">Loading legacy Automations…</p>}
          {legacyError && <p className="agent-library-error" role="alert">Could not load legacy Automations: {legacyError}</p>}
          {visibleLegacy.map((item) => <article className="agent-library-card" key={item.sourceId} aria-label={`Legacy Automation ${item.name}`}>
            <div className="agent-library-card-heading">
              <div className="agent-library-card-title"><h3>{item.name}</h3><small>{item.permissionCeiling} · {item.prompt.length.toLocaleString()} chars</small></div>
              <button type="button" className="agent-primary-action" disabled={busy || Boolean(item.error)} aria-label={`Import ${item.name}`} title={item.error ?? 'Copy this Automation into a TaskTemplate'} onClick={() => { setDialogError(null); setCopy(item); }}><ActionContent text="copy">Import</ActionContent></button>
            </div>
            {item.error && <p className="agent-library-error" role="alert">{item.error}</p>}
            {item.existingTaskId && <small className="agent-library-note agent-card-home">Already copied · import opens the existing TaskTemplate</small>}
          </article>)}
          {!legacyLoading && !legacyError && !visibleLegacy.length && <p className="agent-library-empty">{legacy.length ? 'No Automations match. Clear the search.' : 'No old Automations to copy in this project.'}</p>}
        </>}
      </div>
    </>}
    {editor && <AgentLibraryEditor key={`${editor.kind}:${editor.item?.id ?? 'new'}`} kind={editor.kind} item={editor.item} library={library} busy={busy} onSave={save} onClose={() => setEditor(null)} />}
    {confirm && <ConfirmDialog title={confirm.title} message={confirm.message} confirmLabel={confirm.label} busy={busy} error={dialogError} onCancel={() => { setConfirm(null); setDialogError(null); }} onConfirm={() => void perform(confirm.action, () => setConfirm(null))} />}
    {runRequest && <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) setRunRequest(null); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="agent-library-dialog"><Dialog.Title>Confirm Agent task run</Dialog.Title><Dialog.Description>Starts one session in this project. Effective file access: {effective}.{runRequest.routineId ? ' Background file changes need your approval.' : ''}</Dialog.Description>
      <label>Agent<SelectControl compact label="Run Agent" value={runRequest.agentId} disabled={Boolean(runRequest.routineId) || busy} options={library.agents.filter((agent) => agent.enabled).map((agent) => ({ value: agent.id, label: agent.name }))} onValueChange={(agentId) => setRunRequest({ ...runRequest, agentId })} /></label>
      <label>TaskTemplate<SelectControl compact label="Run TaskTemplate" value={runRequest.taskTemplateId} disabled={Boolean(runRequest.routineId) || busy} options={library.tasks.filter((task) => task.enabled).map((task) => ({ value: task.id, label: task.name }))} onValueChange={(taskTemplateId) => setRunRequest({ ...runRequest, taskTemplateId })} /></label>
      <label>Task prompt (sent as your request)<textarea readOnly aria-label="Run task payload" value={chosenTask?.prompt ?? ''} rows={5} /></label><small className="agent-library-note">{projectPath}</small>{dialogError && <p role="alert" className="agent-library-error">{dialogError}</p>}
      <footer><button type="button" disabled={busy} onClick={() => setRunRequest(null)}><ActionContent text="cancel">Cancel</ActionContent></button><button type="button" aria-label="Confirm run" disabled={busy || !chosenAgent?.enabled || !chosenTask?.enabled} onClick={() => void perform(() => window.piDesktop.runAgentTask(runRequest), () => { setRunRequest(null); useAgentsStore.getState().setView('history'); })}><ActionContent text="run">Confirm</ActionContent></button></footer>
    </Dialog.Content></Dialog.Portal></Dialog.Root>}
    {copy && <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) setCopy(null); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="agent-library-dialog"><Dialog.Title>Copy Automation: {copy.name}</Dialog.Title><Dialog.Description>Creates one TaskTemplate. Original stays unchanged. Permission: {copy.permissionCeiling}.</Dialog.Description><textarea aria-label="Automation copy payload" readOnly value={copy.prompt} rows={7} /><small className="agent-library-note">Archived: {copy.archivedFields.join(', ') || 'none'} · SHA-256 {copy.sourceDigest}</small>{copy.existingTaskId && <p className="agent-library-note">Existing copy will open; no duplicate.</p>}{dialogError && <p className="agent-library-error" role="alert">{dialogError}</p>}<footer><button type="button" disabled={busy} onClick={() => setCopy(null)}><ActionContent text="cancel">Cancel</ActionContent></button><button type="button" aria-label="Confirm non-destructive copy" disabled={busy} onClick={() => void perform(() => window.piDesktop.copyAutomationToTask({ automationId: copy.sourceId, sourceDigest: copy.sourceDigest }), () => { setCopy(null); useAgentsStore.getState().setView('tasks'); })}><ActionContent text="copy">Confirm copy</ActionContent></button></footer></Dialog.Content></Dialog.Portal></Dialog.Root>}
    {approval && <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) setApproval(null); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="agent-library-dialog"><Dialog.Title>Review exact Agent action</Dialog.Title><Dialog.Description>One immutable file effect · expires {date(approval.action.expiresAt)} · live authority still wins.</Dialog.Description><pre aria-label="Exact proposed action">{approval.action.action}</pre><label className="agent-library-check"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />I reviewed the exact action and project</label><small className="agent-library-note">{approval.run.projectPath}</small>{dialogError && <p className="agent-library-error" role="alert">{dialogError}</p>}<footer><button type="button" disabled={busy} onClick={() => setApproval(null)}><ActionContent text="close">Close</ActionContent></button><button type="button" aria-label="Deny action" disabled={busy} onClick={() => void perform(() => window.piDesktop.decideAgentApproval({ runId: approval.run.id, approvalId: approval.action.id, approved: false, expected: { revision: approval.action.revision, digest: approval.action.digest } }), () => setApproval(null))}><ActionContent text="deny">Deny</ActionContent></button><button type="button" aria-label="Approve action" disabled={busy || !reviewed} onClick={() => void perform(() => window.piDesktop.decideAgentApproval({ runId: approval.run.id, approvalId: approval.action.id, approved: true, expected: { revision: approval.action.revision, digest: approval.action.digest } }), () => setApproval(null))}><ActionContent text="approve">Approve</ActionContent></button></footer></Dialog.Content></Dialog.Portal></Dialog.Root>}
  </section>;
}
