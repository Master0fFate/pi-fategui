import { getFateApi, getFateApiOptional, getWebApiOptional } from '../../platform/api';
import { canMutateNetwork, currentNetworkScope, useRuntimeStore } from '../../stores/runtimeStore';
import type { TaskUpdateInput } from '../../../shared/contracts/tasks';
import { Check, ChevronDown, ChevronUp, CircleAlert, Clock3, LoaderCircle, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import './networkFocus.css';
import { draftScopeKey, useScopedDraft } from './scopedDraft';
const taskTitles = new Map<string, string>();
const taskEdits = new Map<string, { title: string; detail: string; updatedAt: number }>();
import { useSkinComponents } from '../../skins/SkinProvider';

import type { GoalMaxCriterion } from '../../../shared/contracts/goalmaxxing';
import type { Task, TaskStatus } from '../../../shared/contracts/tasks';
import { selectGoalView, useGoalMaxStore, type GoalView } from '../../stores/goalMaxStore';
import { selectTaskView, useTaskStore } from '../../stores/taskStore';

function StateMark({ text, children }: { text: string; children: ReactNode }) {
  const { Symbol } = useSkinComponents();
  return <Symbol text={text}>{children}</Symbol>;
}

function criterionStatusIcon(status: GoalMaxCriterion['status']) {
  if (status === 'satisfied' || status === 'waived') return <StateMark text="[x]"><Check size={11} aria-hidden="true" /></StateMark>;
  if (status === 'failed') return <StateMark text="[!]"><CircleAlert size={11} aria-hidden="true" /></StateMark>;
  if (status === 'active') return <StateMark text="[>]"><LoaderCircle className="tool-spinner" size={11} aria-hidden="true" /></StateMark>;
  return <StateMark text="[ ]"><Clock3 size={11} aria-hidden="true" /></StateMark>;
}

function criterionStatusLabel(status: GoalMaxCriterion['status']): string {
  switch (status) {
    case 'satisfied': return 'Satisfied';
    case 'failed': return 'Failed';
    case 'active': return 'Active';
    case 'waived': return 'Waived';
    case 'pending': return 'Pending';
  }
}

function taskStatusIcon(status: TaskStatus) {
  if (status === 'done') return <StateMark text="[x]"><Check size={11} aria-hidden="true" /></StateMark>;
  if (status === 'blocked') return <StateMark text="[!]"><CircleAlert size={11} aria-hidden="true" /></StateMark>;
  if (status === 'in-progress') return <StateMark text="[>]"><LoaderCircle className="tool-spinner" size={11} aria-hidden="true" /></StateMark>;
  return <StateMark text="[ ]"><Clock3 size={11} aria-hidden="true" /></StateMark>;
}

function taskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case 'done': return 'Done';
    case 'blocked': return 'Blocked';
    case 'in-progress': return 'In progress';
    case 'todo': return 'To do';
  }
}

interface TaskRow {
  id: string;
  title: string;
  detail: string;
  status: TaskStatus;
  required: boolean;
  verified: boolean;
  managed: boolean;
}

/** Task creation and status belong to the agent; ordinary tasks may still be cancelled. */
function TaskListStrip({ tasks, controls = false, focusTaskId }: { tasks: readonly Task[]; controls?: boolean; focusTaskId?: string }) {
  const web = getWebApiOptional();
  useRuntimeStore((state) => state.networkBusy);
  const { ActionContent } = useSkinComponents();
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  useEffect(() => { if (focusTaskId) setExpanded(true); }, [focusTaskId]);
  useEffect(() => {
    if (!expanded || !focusTaskId) return;
    const row = rowRefs.current.get(focusTaskId); row?.focus({ preventScroll: true });
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [expanded, focusTaskId]);
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const setList = useTaskStore((state) => state.setList);
  const rows: TaskRow[] = [...tasks].sort((left, right) => left.order - right.order).map((task) => ({
    id: task.id, title: task.title, detail: task.detail, status: task.status, required: task.required, verified: task.verified, managed: task.source === 'goalmax',
  }));
  const done = rows.filter((row) => row.status === 'done').length;
  const requiredTotal = rows.filter((row) => row.required).length;
  const requiredDone = rows.filter((row) => row.required && row.status === 'done').length;
  const requiredVerified = rows.filter((row) => row.required && row.status === 'done' && row.verified).length;
  const current = rows.find((row) => row.status === 'in-progress') ?? rows.find((row) => row.status === 'todo') ?? rows.find((row) => row.status === 'blocked') ?? rows[rows.length - 1]!;
  const taskCount = `${rows.length} ${rows.length === 1 ? 'task' : 'tasks'}`;
  const gateSummary = requiredTotal === 0
    ? 'no required tasks'
    : `${requiredDone}/${requiredTotal} required · ${requiredVerified === requiredTotal ? 'verified' : 'unverified'}`;
  const canEdit = typeof window !== 'undefined' && Boolean(web || getFateApiOptional());

  const cancelTask = async (row: TaskRow) => {
    if (row.managed || mutatingId || !canEdit) return;
    if (web) { await useRuntimeStore.getState().runNetworkMutation(web, 'task.control', (scope) => web.deleteTask(scope, { id: row.id })); return; }
    if (typeof getFateApiOptional()?.deleteTask !== 'function') return;
    setMutatingId(row.id);
    setMutationError(null);
    try {
      setList(await getFateApi().deleteTask({ id: row.id }));
    } catch {
      setMutationError('Could not cancel the task. Try again.');
    } finally {
      setMutatingId(null);
    }
  };

  return (
    <section className="goalmax-task-strip" data-status="tasks" aria-label="Task list strip">
      <button type="button" className="goalmax-task-strip-toggle" aria-expanded={expanded} aria-controls={contentId} aria-label={expanded ? 'Collapse task list' : 'Expand task list'} onClick={() => setExpanded((value) => !value)}>
        <span className="goalmax-task-strip-mark" data-status={current.status}>{taskStatusIcon(current.status)}</span>
        <span className="goalmax-task-strip-copy">
          <strong title={current.detail ? `${current.title}\n${current.detail}` : current.title}>{current.title}</strong>
          <small title={`${taskCount} · ${gateSummary}`}>{done}/{rows.length} tasks</small>
        </span>
        {expanded ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
      </button>
      {expanded ? (
        <>
          <p className="goalmax-task-strip-summary">{taskCount} · {gateSummary}</p>
          <ol id={contentId} className="goalmax-task-strip-criteria" aria-label="Task status">
            {rows.map((row) => {
              const busy = mutatingId === row.id;
              const statusText = `${taskStatusLabel(row.status)}${row.required && row.status === 'done' ? (row.verified ? ' · verified' : ' · unverified') : ''}`;
              return (
                <li key={row.id} ref={(element) => { if (element) rowRefs.current.set(row.id, element); else rowRefs.current.delete(row.id); }} tabIndex={-1}
                  className="goalmax-task-strip-criterion" data-task-id={row.id} data-network-task-id={row.id} data-network-focus={focusTaskId === row.id || undefined}
                  aria-current={focusTaskId === row.id || undefined} data-status={row.status} data-required={row.required || undefined}>
                  {row.managed ? (
                    <span className="goalmax-task-strip-criterion-mark">{taskStatusIcon(row.status)}</span>
                  ) : (
                    <button type="button" className="goalmax-task-strip-criterion-mark goalmax-task-strip-criterion-cancel" aria-label={`Cancel task ${row.title}`} title="Cancel task" disabled={busy || Boolean(web && !canMutateNetwork(web, 'task.control'))} data-busy={busy || undefined} onClick={() => void cancelTask(row)}>
                      <ActionContent text={busy ? '~' : 'x'}>{busy ? <LoaderCircle className="tool-spinner" size={11} aria-hidden="true" /> : (
                        <><span className="goalmax-task-strip-criterion-status-icon">{taskStatusIcon(row.status)}</span><X className="goalmax-task-strip-criterion-cancel-icon" size={11} aria-hidden="true" /></>
                      )}</ActionContent>
                    </button>
                  )}
                  <span className="goalmax-task-strip-criterion-body">
                    <span className="goalmax-task-strip-criterion-title">{row.title}</span>
                    {focusTaskId === row.id && <small className="network-focus-label">Selected from Monitor</small>}
                    {row.detail ? <small className="goalmax-task-strip-criterion-description">{row.detail}</small> : null}
                  </span>
                  <em className="goalmax-task-strip-criterion-status" title="Status is updated by the agent">{statusText}</em>
                  {controls && !row.managed && <TaskRowEditor task={tasks.find((task) => task.id === row.id)!} tasks={tasks} />}
                </li>
              );
            })}
          </ol>
          {mutationError ? <p className="goalmax-task-strip-error" role="status">{mutationError}</p> : null}
        </>
      ) : null}
    </section>
  );
}

/**
 * Criteria fallback for goal sessions without a bound canonical task list.
 */
function GoalMaxCriteriaStrip({ goal }: { goal: GoalView }) {
  const [expanded, setExpanded] = useState(false);
  const required = goal.criteria.filter((criterion) => criterion.required && criterion.status !== 'waived');
  const satisfied = required.filter((criterion) => criterion.status === 'satisfied').length;
  const currentCriterion = goal.criteria.find((criterion) => criterion.status === 'active')
    ?? goal.criteria.find((criterion) => criterion.status === 'pending')
    ?? goal.criteria.find((criterion) => criterion.status === 'failed')
    ?? goal.criteria[goal.criteria.length - 1]
    ?? null;
  const verificationPending = goal.status === 'verifying';
  const currentStatus: GoalMaxCriterion['status'] = verificationPending ? 'pending' : currentCriterion?.status ?? fallbackStatus(goal);
  const taskLabel = verificationPending ? statusFallback(goal) : currentCriterion ? currentCriterion.title : statusFallback(goal);
  const toggleLabel = expanded ? 'Collapse goal criteria' : 'Expand goal criteria';
  return (
    <section className="goalmax-task-strip" data-status={goal.status} aria-label="GoalMax task strip">
      <button type="button" className="goalmax-task-strip-toggle" aria-expanded={expanded} aria-controls="goalmax-task-strip-criteria" aria-label={toggleLabel} onClick={() => setExpanded((value) => !value)}>
        <span className="goalmax-task-strip-mark" data-status={currentStatus}>{criterionStatusIcon(currentStatus)}</span>
        <span className="goalmax-task-strip-copy">
          <strong title={currentCriterion?.description ? `${taskLabel}\n${currentCriterion.description}` : taskLabel}>{taskLabel}</strong>
          <small>{satisfied}/{required.length} required</small>
        </span>
        {expanded ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
      </button>
      {expanded ? (
        <ol id="goalmax-task-strip-criteria" className="goalmax-task-strip-criteria" aria-label="Goal criteria status">
          {goal.criteria.map((criterion) => (
            <li key={criterion.id} className="goalmax-task-strip-criterion" data-status={criterion.status} data-required={criterion.required || undefined}>
              <span className="goalmax-task-strip-criterion-mark">{criterionStatusIcon(criterion.status)}</span>
              <span className="goalmax-task-strip-criterion-body">
                <span className="goalmax-task-strip-criterion-title">{criterion.title}</span>
                {criterion.description ? <small className="goalmax-task-strip-criterion-description">{criterion.description}</small> : null}
              </span>
              <em className="goalmax-task-strip-criterion-status">{criterionStatusLabel(criterion.status)}</em>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

/**
 * Task strip entry point. It reads the canonical task list first (so ordinary
 * sessions and GoalMax share one source of truth) and falls back to the goal
 * criteria only when no task list has been bound yet.
 */
export function GoalMaxTaskStrip() {
  const source = useRuntimeStore((state) => state.source);
  useRuntimeStore((state) => state.phase);
  const list = useTaskStore((state) => selectTaskView(state, source));
  const goal = useGoalMaxStore((state) => selectGoalView(state, source));
  if (list && list.tasks.length > 0) return <TaskListStrip key={'projectPath' in list ? `${list.projectPath}\0${list.sessionId}` : source} tasks={list.tasks} />;
  if (goal) return <GoalMaxCriteriaStrip key={goal.id} goal={goal} />;
  return null;
}

function fallbackStatus(goal: GoalView): GoalMaxCriterion['status'] {
  if (goal.status === 'completed') return 'satisfied';
  if (goal.status === 'verifying') return 'pending';
  if (goal.status === 'blocked' || goal.status === 'failed') return 'failed';
  return 'pending';
}

function statusFallback(goal: GoalView): string {
  if (goal.status === 'completed') return 'Goal achieved';
  if (goal.status === 'verifying') return 'Checking completion';
  if (goal.status === 'blocked') return 'Goal needs input';
  return 'No active criterion';
}

/** Same canonical task UI, with source-specific receipts versus domain results. */
export function TaskControlsPanel() {
  const source = useRuntimeStore((state) => state.source);
  useRuntimeStore((state) => state.phase);
  useRuntimeStore((state) => state.networkBusy);
  const network = useTaskStore((state) => state.network);
  const navigation = useRuntimeStore((state) => state.networkNavigation);
  const list = useTaskStore((state) => selectTaskView(state, source));
  const web = getWebApiOptional();
  const titleKey = draftScopeKey(web);
  const [title, setTitle, dropTitle] = useScopedDraft(taskTitles, titleKey, () => '');
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const create = async () => {
    if (!title.trim() || titleKey !== draftScopeKey(web)) return;
    try {
      if (web) {
        if (await useRuntimeStore.getState().runNetworkMutation(web, 'task.control', (scope) => web.createTask(scope, { title: title.trim(), detail: '', required: false, status: 'todo' }))) {
          if (titleKey === draftScopeKey(web)) setTitle(''); dropTitle();
        }
      } else { useTaskStore.getState().setList(await getFateApi().createTask({ title: title.trim() })); setTitle(''); }
    } catch { setError('Task was not changed. Refresh its canonical list.'); }
  };
  const clear = async () => {
    try {
      if (web && !await useRuntimeStore.getState().runNetworkMutation(web, 'task.control', (scope) => web.clearTasks(scope))) return;
      if (!web) { await getFateApi().clearTasks(); useTaskStore.getState().setList(null); }
      setConfirmClear(false);
    } catch { setError('Task list was not cleared.'); }
  };
  const disabled = Boolean(web && !canMutateNetwork(web, 'task.control'));
  const target = navigation && navigation.scopeKey === currentNetworkScope()?.key ? navigation.target : null;
  const focusTaskId = target?.kind === 'task' && list?.tasks.some((task) => task.id === target.taskId) ? target.taskId : null;
  return <section aria-label="Canonical tasks"><h2>Tasks</h2>
    {source === 'network' && network.status !== 'ready' ? <p role="status">Task read {network.status}. This is not a confirmed empty list.</p>
      : list?.tasks.length ? <><p>Canonical task revision: {list.revision}</p><TaskListStrip tasks={list.tasks} controls {...(focusTaskId ? { focusTaskId } : {})} /></>
        : <p>No canonical tasks returned. This is not verified success.</p>}
    <form onSubmit={(event) => { event.preventDefault(); void create(); }}><label>Task title<input maxLength={240} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <button type="submit" disabled={disabled || !title.trim()}>Create task</button></form>
    {confirmClear ? <p>Clear ordinary tasks? Managed GoalMax tasks remain host-controlled. <button type="button" disabled={disabled} onClick={() => void clear()}>Confirm clear tasks</button><button type="button" onClick={() => setConfirmClear(false)}>Keep tasks</button></p>
      : <button type="button" disabled={disabled || !list} onClick={() => setConfirmClear(true)}>Clear tasks</button>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
function TaskRowEditor({ task, tasks }: { task: Task; tasks: readonly Task[] }) {
  const web = getWebApiOptional();
  const editKey = `${draftScopeKey(web)}:task:${task.id}`;
  const [draft, setDraft, dropEdit] = useScopedDraft(taskEdits, editKey, () => ({ title: task.title, detail: task.detail, updatedAt: task.updatedAt }));
  const { title, detail } = draft;
  const [error, setError] = useState<string | null>(null);
  const disabled = Boolean(web && !canMutateNetwork(web, 'task.control'));
  const update = async (input: TaskUpdateInput) => {
    if (editKey !== `${draftScopeKey(web)}:task:${task.id}` || task.updatedAt !== draft.updatedAt) {
      setError('Host task changed. Local text is kept; use the current task row before a new edit.'); return;
    }
    try {
      if (web) { if (await useRuntimeStore.getState().runNetworkMutation(web, 'task.control', (scope) => web.updateTask(scope, input))) dropEdit(); }
      else { useTaskStore.getState().setList(await getFateApi().updateTask(input)); dropEdit(); }
    } catch { setError('Task update was not confirmed. Local text is kept.'); }
  };
  const move = async (direction: -1 | 1) => {
    const orderedIds = [...tasks].sort((a, b) => a.order - b.order).map((row) => row.id);
    const index = orderedIds.indexOf(task.id); const target = index + direction;
    if (index < 0 || target < 0 || target >= orderedIds.length) return;
    [orderedIds[index], orderedIds[target]] = [orderedIds[target]!, orderedIds[index]!];
    if (web) await useRuntimeStore.getState().runNetworkMutation(web, 'task.control', (scope) => web.reorderTasks(scope, { orderedIds }));
    else useTaskStore.getState().setList(await getFateApi().reorderTasks({ orderedIds }));
  };
  return <fieldset disabled={disabled}><legend>Edit task {task.title}</legend>
    <label>Title<input maxLength={240} value={title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} /></label>
    <label>Detail<textarea maxLength={2000} value={detail} onChange={(event) => setDraft((current) => ({ ...current, detail: event.target.value }))} /></label>
    {task.updatedAt !== draft.updatedAt && <p role="status">Host row changed; this local draft is not applied.</p>}
    <button type="button" onClick={() => { setDraft({ title: task.title, detail: task.detail, updatedAt: task.updatedAt }); setError(null); }}>Use current task row</button>
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={!title.trim()} onClick={() => void update({ id: task.id, title: title.trim(), detail })}>Save task</button>
    <label>Status<select value={task.status} onChange={(event) => {
      const status = event.target.value;
      if (status === 'todo' || status === 'in-progress' || status === 'done' || status === 'blocked') void update({ id: task.id, status });
    }}>{['todo', 'in-progress', 'done', 'blocked'].map((status) => <option key={status}>{status}</option>)}</select></label>
    <label>Required<input type="checkbox" checked={task.required} onChange={(event) => void update({ id: task.id, required: event.target.checked })} /></label>
    <button type="button" onClick={() => void move(-1)}>Move task up</button><button type="button" onClick={() => void move(1)}>Move task down</button>
    <p>Done is not verified. Verification remains host-owned.</p>
  </fieldset>;
}
