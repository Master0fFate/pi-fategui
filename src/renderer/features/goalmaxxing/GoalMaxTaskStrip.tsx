import { Check, ChevronDown, ChevronUp, CircleAlert, Clock3, LoaderCircle, Plus, X } from 'lucide-react';
import { useState } from 'react';
import type { GoalMaxCriterion, GoalMaxState } from '../../../shared/contracts/goalmaxxing';
import type { Task, TaskStatus } from '../../../shared/contracts/tasks';
import { useGoalMaxStore } from '../../stores/goalMaxStore';
import { useTaskStore } from '../../stores/taskStore';

function criterionStatusIcon(status: GoalMaxCriterion['status']) {
  if (status === 'satisfied' || status === 'waived') return <Check size={11} aria-hidden="true" />;
  if (status === 'failed') return <CircleAlert size={11} aria-hidden="true" />;
  if (status === 'active') return <LoaderCircle className="tool-spinner" size={11} aria-hidden="true" />;
  return <Clock3 size={11} aria-hidden="true" />;
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
  if (status === 'done') return <Check size={11} aria-hidden="true" />;
  if (status === 'blocked') return <CircleAlert size={11} aria-hidden="true" />;
  if (status === 'in-progress') return <LoaderCircle className="tool-spinner" size={11} aria-hidden="true" />;
  return <Clock3 size={11} aria-hidden="true" />;
}

function taskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case 'done': return 'Done';
    case 'blocked': return 'Blocked';
    case 'in-progress': return 'In progress';
    case 'todo': return 'To do';
  }
}

const TASK_STATUS_CYCLE: TaskStatus[] = ['todo', 'in-progress', 'done', 'blocked'];

interface TaskRow {
  id: string;
  title: string;
  detail: string;
  status: TaskStatus;
  required: boolean;
  verified: boolean;
  managed: boolean;
}

/**
 * Reads the canonical, session-scoped task list (the same list GoalMax binds
 * to), so the strip is not GoalMax-exclusive. The collapsed row shows the
 * current task plus the required done/total count and the verification state;
 * expanding reveals a dense status list with an inline create/toggle/remove
 * path for ordinary user tasks.
 */
function TaskListStrip({ tasks }: { tasks: readonly Task[] }) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState('');
  const rows: TaskRow[] = [...tasks].sort((left, right) => left.order - right.order).map((task) => ({
    id: task.id, title: task.title, detail: task.detail, status: task.status, required: task.required, verified: task.verified, managed: task.source === 'goalmax',
  }));
  const requiredTotal = rows.filter((row) => row.required).length;
  const requiredDone = rows.filter((row) => row.required && row.status === 'done').length;
  const requiredVerified = rows.filter((row) => row.required && row.status === 'done' && row.verified).length;
  const current = rows.find((row) => row.status === 'in-progress') ?? rows.find((row) => row.status === 'todo') ?? rows.find((row) => row.status === 'blocked') ?? rows[rows.length - 1]!;
  const gateSuffix = requiredVerified === requiredTotal && requiredTotal > 0 ? ' · verified' : requiredDone < requiredTotal ? ' · unverified' : ' · unverified';
  const canEdit = typeof window !== 'undefined' && 'piDesktop' in window;

  const addTask = async () => {
    const title = draft.trim();
    if (!title || !canEdit || typeof window.piDesktop.createTask !== 'function') return;
    setDraft('');
    try { await window.piDesktop.createTask({ title, required: false, status: 'todo' }); } catch { setDraft(title); }
  };
  const cycleStatus = async (row: TaskRow) => {
    if (row.managed || !canEdit || typeof window.piDesktop.updateTask !== 'function') return;
    const next = TASK_STATUS_CYCLE[(TASK_STATUS_CYCLE.indexOf(row.status) + 1) % TASK_STATUS_CYCLE.length];
    try { await window.piDesktop.updateTask({ id: row.id, status: next }); } catch { /* keep */ }
  };
  const removeTask = async (row: TaskRow) => {
    if (row.managed || !canEdit || typeof window.piDesktop.deleteTask !== 'function') return;
    try { await window.piDesktop.deleteTask({ id: row.id }); } catch { /* keep */ }
  };

  return (
    <section className="goalmax-task-strip" data-status="tasks" aria-label="Task list strip">
      <button type="button" className="goalmax-task-strip-toggle" aria-expanded={expanded} aria-controls="goalmax-task-strip-tasks" aria-label={expanded ? 'Collapse task list' : 'Expand task list'} onClick={() => setExpanded((value) => !value)}>
        <span className="goalmax-task-strip-mark" data-status={current.status}>{taskStatusIcon(current.status)}</span>
        <span className="goalmax-task-strip-copy">
          <strong>{current.title}</strong>
          {current.detail ? <small className="goalmax-task-strip-criterion-description">{current.detail}</small> : null}
          <small>{requiredDone}/{requiredTotal} required{gateSuffix}</small>
        </span>
        {expanded ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
      </button>
      {expanded ? (
        <>
          <ol id="goalmax-task-strip-tasks" className="goalmax-task-strip-criteria" aria-label="Task status">
            {rows.map((row) => (
              <li key={row.id} className="goalmax-task-strip-criterion" data-status={row.status} data-required={row.required || undefined}>
                <button type="button" className="goalmax-task-strip-criterion-mark" aria-label={`Cycle ${row.title} status`} disabled={row.managed} onClick={() => cycleStatus(row)}>{taskStatusIcon(row.status)}</button>
                <span className="goalmax-task-strip-criterion-body">
                  <span className="goalmax-task-strip-criterion-title">{row.title}</span>
                  {row.detail ? <small className="goalmax-task-strip-criterion-description">{row.detail}</small> : null}
                </span>
                <em className="goalmax-task-strip-criterion-status">{taskStatusLabel(row.status)}{row.required && row.status === 'done' ? (row.verified ? ' · verified' : ' · unverified') : ''}</em>
                {!row.managed ? <button type="button" className="goalmax-task-strip-criterion-remove" aria-label={`Remove task ${row.title}`} onClick={() => removeTask(row)}><X size={11} aria-hidden="true" /></button> : null}
              </li>
            ))}
          </ol>
          <form className="goalmax-task-strip-add" onSubmit={(event) => { event.preventDefault(); void addTask(); }}>
            <input type="text" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Add a task…" aria-label="Add a task" maxLength={240} />
            <button type="submit" disabled={!draft.trim()} aria-label="Add task"><Plus size={12} aria-hidden="true" /></button>
          </form>
        </>
      ) : null}
    </section>
  );
}

/**
 * Compact collapsed row that summarises the active GoalMax goal (criteria
 * fallback). Kept verbatim so legacy goal sessions render unchanged when no
 * canonical task list has been bound yet.
 */
function GoalMaxCriteriaStrip({ goal }: { goal: GoalMaxState }) {
  const [expanded, setExpanded] = useState(false);
  const required = goal.criteria.filter((criterion) => criterion.required && criterion.status !== 'waived');
  const satisfied = required.filter((criterion) => criterion.status === 'satisfied').length;
  const currentCriterion = goal.criteria.find((criterion) => criterion.status === 'active')
    ?? goal.criteria.find((criterion) => criterion.status === 'pending')
    ?? goal.criteria.find((criterion) => criterion.status === 'failed')
    ?? goal.criteria[goal.criteria.length - 1]
    ?? null;
  const currentStatus: GoalMaxCriterion['status'] = currentCriterion?.status ?? fallbackStatus(goal);
  const taskLabel = currentCriterion ? currentCriterion.title : statusFallback(goal);
  const toggleLabel = expanded ? 'Collapse goal criteria' : 'Expand goal criteria';
  return (
    <section className="goalmax-task-strip" data-status={goal.status} aria-label="GoalMax task strip">
      <button type="button" className="goalmax-task-strip-toggle" aria-expanded={expanded} aria-controls="goalmax-task-strip-criteria" aria-label={toggleLabel} onClick={() => setExpanded((value) => !value)}>
        <span className="goalmax-task-strip-mark" data-status={currentStatus}>{criterionStatusIcon(currentStatus)}</span>
        <span className="goalmax-task-strip-copy">
          <strong>{taskLabel}</strong>
          {currentCriterion?.description ? <small className="goalmax-task-strip-criterion-description">{currentCriterion.description}</small> : null}
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
  const list = useTaskStore((state) => state.list);
  const goal = useGoalMaxStore((state) => state.goal);
  if (list && list.tasks.length > 0) return <TaskListStrip tasks={list.tasks} />;
  if (goal) return <GoalMaxCriteriaStrip goal={goal} />;
  return null;
}

function fallbackStatus(goal: GoalMaxState): GoalMaxCriterion['status'] {
  if (goal.status === 'completed' || goal.status === 'verifying') return 'satisfied';
  if (goal.status === 'blocked' || goal.status === 'failed') return 'failed';
  return 'pending';
}

function statusFallback(goal: GoalMaxState): string {
  if (goal.status === 'completed') return 'Goal complete';
  if (goal.status === 'verifying') return 'Verifying goal';
  if (goal.status === 'blocked') return 'Goal blocked';
  return 'No active criterion';
}
