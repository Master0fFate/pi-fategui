import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalMaxState } from '../../../shared/contracts/goalmaxxing';
import type { TaskList } from '../../../shared/contracts/tasks';
import { useGoalMaxStore } from '../../stores/goalMaxStore';
import { useTaskStore } from '../../stores/taskStore';
import { GoalMaxTaskStrip } from './GoalMaxTaskStrip';

function buildGoal(overrides: Partial<GoalMaxState> = {}): GoalMaxState {
  return {
    schemaVersion: 2, id: 'goal-1', sessionId: 's1', projectPath: '/project', revision: 1,
    objective: 'Ship the GoalMax task strip', originalBriefRef: null, originalBriefHash: null,
    status: 'active', phase: 'implementation', executionState: 'idle', verificationLevel: 'normal', agentStrategy: 'auto',
    criteria: [
      { id: 'criterion-research', title: 'Research dense row layout', description: 'Survey existing dense row patterns', required: true, status: 'satisfied', evidenceIds: [], ownerNodeIds: [], updatedAt: 1 },
      { id: 'criterion-implement', title: 'Build the collapsible strip', description: '', required: true, status: 'active', evidenceIds: [], ownerNodeIds: [], updatedAt: 1 },
      { id: 'criterion-optional', title: 'Optional polish pass', description: '', required: false, status: 'pending', evidenceIds: [], ownerNodeIds: [], updatedAt: 1 },
    ],
    budget: { tokenLimit: null, timeLimitMs: null, source: null },
    permission: { permissionLevel: 'edit', projectTrusted: true, revision: 1, resolvedAt: 1 },
    progress: { meaningfulTurnCount: 1, noProgressTurnCount: 0, repeatedFailureCount: 0, planningOnlyTurnCount: 0, changedFileCount: 1, baselineWorkspaceFingerprint: 'a', latestWorkspaceFingerprint: 'b', latestEvidenceAt: null, latestMeaningfulProgressAt: 1, lastFailureFingerprint: null },
    evidence: [], continuation: { pending: false, attempt: 1, lastScheduledAt: 1, lastSettledAt: 1, reason: null }, steering: [], childAssignments: [],
    tokensUsed: 0, tokenBaseline: 0, elapsedMs: 0, timeline: [], createdAt: 1, updatedAt: 1, startedAt: 1, completedAt: null, blockedReason: null, failure: null,
    ...overrides,
  };
}

function buildTaskList(includeManualTask = false): TaskList {
  const now = 1;
  const tasks: TaskList['tasks'] = [
    { id: 'task-plan', title: 'Implement the workflow', detail: 'Build the required behavior.', status: 'todo', required: true, source: 'goalmax', goalId: 'goal-1', goalCriterionId: 'criterion-plan', order: 0, verified: false, verifiedAt: null, createdAt: now, updatedAt: now },
    { id: 'task-verify', title: 'Verify the delivered result', detail: 'Run the completion gate.', status: 'todo', required: true, source: 'goalmax', goalId: 'goal-1', goalCriterionId: 'criterion-verify', order: 1, verified: false, verifiedAt: null, createdAt: now, updatedAt: now },
  ];
  if (includeManualTask) tasks.unshift({ id: 'task-manual', title: 'Review the copy', detail: '', status: 'todo', required: false, source: 'user', goalId: null, goalCriterionId: null, order: 0, verified: false, verifiedAt: null, createdAt: now, updatedAt: now });
  return {
    schemaVersion: 1, projectPath: '/project', sessionId: 's1', revision: includeManualTask ? 2 : 1, goalId: 'goal-1',
    tasks: tasks.map((task, order) => ({ ...task, order })), currentTaskId: tasks[0]!.id, updatedAt: now,
  };
}

beforeEach(() => {
  useGoalMaxStore.setState({ projectPath: '/project', sessionId: 's1', goal: buildGoal(), loading: false, selectionGeneration: 1 });
  useTaskStore.setState({ projectPath: '/project', sessionId: 's1', list: null, loading: false, selectionGeneration: 1 });
});
afterEach(() => {
  Reflect.deleteProperty(window, 'piDesktop');
  useGoalMaxStore.setState({ goal: null });
  useTaskStore.setState({ list: null });
});

describe('GoalMax task strip', () => {
  it('shows the active criterion and the required satisfied/total count', () => {
    render(<GoalMaxTaskStrip />);
    const strip = screen.getByRole('region', { name: 'GoalMax task strip' });
    expect(strip).toHaveTextContent('Build the collapsible strip');
    expect(strip).toHaveTextContent('1/2 required');
  });

  it('expands to a dense criterion list and collapses again', async () => {
    const user = userEvent.setup();
    render(<GoalMaxTaskStrip />);
    await user.click(screen.getByRole('button', { name: 'Expand goal criteria' }));
    const list = screen.getByRole('list', { name: 'Goal criteria status' });
    expect(list).toHaveTextContent('Research dense row layout');
    expect(list).toHaveTextContent('Survey existing dense row patterns');
    expect(list).toHaveTextContent('Satisfied');
    expect(list).toHaveTextContent('Optional polish pass');
    expect(list).toHaveTextContent('Pending');
    await user.click(screen.getByRole('button', { name: 'Collapse goal criteria' }));
    expect(screen.queryByRole('list', { name: 'Goal criteria status' })).toBeNull();
  });

  it('adds a manual task immediately and increments the visible total count', async () => {
    const user = userEvent.setup();
    const initial = buildTaskList();
    const added = buildTaskList(true);
    const createTask = vi.fn(async () => added);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { createTask } });
    useTaskStore.setState({ list: initial });
    render(<GoalMaxTaskStrip />);

    const strip = screen.getByRole('region', { name: 'Task list strip' });
    expect(strip).toHaveTextContent('2 tasks · 0/2 required · unverified');
    await user.click(screen.getByRole('button', { name: 'Expand task list' }));
    await user.type(screen.getByRole('textbox', { name: 'Add a task' }), 'Review the copy');
    await user.click(screen.getByRole('button', { name: 'Add task' }));

    expect(createTask).toHaveBeenCalledWith({ title: 'Review the copy', required: false, status: 'todo' });
    expect(strip).toHaveTextContent('3 tasks · 0/2 required · unverified');
    expect(screen.getByRole('list', { name: 'Task status' })).toHaveTextContent('Review the copy');
  });

  it('applies the returned list when a manual task status changes', async () => {
    const user = userEvent.setup();
    const initial = buildTaskList(true);
    const updated: TaskList = {
      ...initial,
      revision: initial.revision + 1,
      tasks: initial.tasks.map((task) => task.id === 'task-manual' ? { ...task, status: 'in-progress' as const } : task),
    };
    const updateTask = vi.fn(async () => updated);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { updateTask } });
    useTaskStore.setState({ list: initial });
    render(<GoalMaxTaskStrip />);

    await user.click(screen.getByRole('button', { name: 'Expand task list' }));
    await user.click(screen.getByRole('button', { name: 'Change status for Review the copy' }));

    expect(updateTask).toHaveBeenCalledWith({ id: 'task-manual', status: 'in-progress' });
    expect(useTaskStore.getState().list?.tasks.find((task) => task.id === 'task-manual')?.status).toBe('in-progress');
  });

  it('turns a manual task status control into a cancel action and applies the returned list', async () => {
    const user = userEvent.setup();
    const withManualTask = buildTaskList(true);
    const withoutManualTask = { ...buildTaskList(), revision: withManualTask.revision + 1 };
    const deleteTask = vi.fn(async () => withoutManualTask);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { deleteTask } });
    useTaskStore.setState({ list: withManualTask });
    render(<GoalMaxTaskStrip />);

    await user.click(screen.getByRole('button', { name: 'Expand task list' }));
    const cancel = screen.getByRole('button', { name: 'Cancel task Review the copy' });
    expect(cancel).toHaveAttribute('title', 'Cancel task');
    cancel.focus();
    expect(cancel).toHaveFocus();
    expect(cancel.querySelector('.goalmax-task-strip-criterion-cancel-icon')).toBeInTheDocument();
    await user.hover(cancel);
    await user.click(cancel);

    expect(deleteTask).toHaveBeenCalledWith({ id: 'task-manual' });
    expect(screen.queryByRole('button', { name: 'Cancel task Review the copy' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Task list strip' })).toHaveTextContent('2 tasks · 0/2 required · unverified');
  });

  it('renders nothing when no goal is active', () => {
    useGoalMaxStore.setState({ goal: null });
    const { container } = render(<GoalMaxTaskStrip />);
    expect(container).toBeEmptyDOMElement();
  });
});
