import { randomUUID } from 'node:crypto';
import {
  TASK_MAX_ITEMS,
  taskCreateInputSchema,
  taskDeleteInputSchema,
  taskListSchema,
  taskReorderInputSchema,
  taskUpdateInputSchema,
  type Task,
  type TaskCreateInput,
  type TaskDeleteInput,
  type TaskEvent,
  type TaskList,
  type TaskReorderInput,
  type TaskUpdateInput,
} from '../../../shared/contracts/tasks';
import type { GoalMaxState } from '../../../shared/contracts/goalmaxxing';
import { InMemoryTaskRepository, type TaskPersistence } from './TaskRepository';

export interface TaskServiceHost {
  emit(event: TaskEvent): void;
}

function listKey(projectPath: string, sessionId: string): string {
  return `${projectPath}\0${sessionId}`;
}

function criterionTaskStatus(criterion: GoalMaxState['criteria'][number]): Task['status'] {
  switch (criterion.status) {
    case 'satisfied': return 'done';
    case 'waived': return 'done';
    case 'failed': return 'blocked';
    case 'active': return 'in-progress';
    case 'pending': return 'todo';
  }
}

function nextOrderId(tasks: readonly Task[]): number {
  return tasks.reduce((max, task) => Math.max(max, task.order + 1), 0);
}

function recomputeCurrent(tasks: Task[]): string | null {
  const candidate = tasks
    .filter((task) => task.status !== 'done')
    .sort((left, right) => left.order - right.order)[0];
  return candidate?.id ?? null;
}

function freshList(projectPath: string, sessionId: string, now: number): TaskList {
  return {
    schemaVersion: 1,
    projectPath,
    sessionId,
    revision: 0,
    goalId: null,
    tasks: [],
    currentTaskId: null,
    updatedAt: now,
  };
}

/**
 * Canonical, revision-checked, race-safe session task list.
 *
 * Ordinary prompts mutate it through CRUD. GoalMax binds a goal and mirrors its
 * required criteria into the same list (source = 'goalmax'), then reports
 * verification outcomes back so the list is the single source of truth for
 * task identity, status, and the strict completion gate.
 */
export class TaskService {
  private readonly states = new Map<string, TaskList>();
  private readonly sessionKeys = new Map<string, string>();
  private readonly mutationQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly host: TaskServiceHost,
    private readonly repository: TaskPersistence = new InMemoryTaskRepository(),
  ) {}

  async bind(projectPath: string, sessionId: string): Promise<TaskList | null> {
    const key = listKey(projectPath, sessionId);
    const restored = await this.repository.load(projectPath, sessionId);
    if (!restored) {
      this.states.delete(key);
      this.sessionKeys.delete(sessionId);
      return null;
    }
    this.states.set(key, restored);
    this.sessionKeys.set(sessionId, key);
    this.host.emit(snapshotEvent(restored));
    return structuredClone(restored);
  }

  unbind(sessionId: string): void {
    this.sessionKeys.delete(sessionId);
  }

  get(projectPath: string, sessionId: string): TaskList | null {
    const list = this.states.get(listKey(projectPath, sessionId));
    return list ? structuredClone(list) : null;
  }

  async ensure(projectPath: string, sessionId: string): Promise<TaskList> {
    const existing = this.get(projectPath, sessionId);
    if (existing) return existing;
    // revision 0 is an in-memory placeholder for an empty list that has never been
    // persisted; the first durable commit creates revision 1.
    const list = freshList(projectPath, sessionId, Date.now());
    this.states.set(listKey(projectPath, sessionId), list);
    this.sessionKeys.set(sessionId, listKey(projectPath, sessionId));
    return structuredClone(list);
  }

  async create(projectPath: string, sessionId: string, input: TaskCreateInput): Promise<TaskList> {
    const parsed = taskCreateInputSchema.parse(input);
    await this.ensure(projectPath, sessionId);
    await this.mutate(projectPath, sessionId, (list, now) => {
      if (list.tasks.length >= TASK_MAX_ITEMS) throw new Error('The task list is full.');
      const order = parsed.status === 'done' ? nextOrderId(list.tasks) : nextOrderId(list.tasks);
      const task: Task = {
        id: `task-${randomUUID()}`,
        title: parsed.title,
        detail: parsed.detail,
        status: parsed.status,
        required: parsed.required,
        source: 'user',
        goalId: null,
        goalCriterionId: null,
        order,
        verified: parsed.status === 'done' && !parsed.required,
        verifiedAt: parsed.status === 'done' && !parsed.required ? now : null,
        createdAt: now,
        updatedAt: now,
      };
      const tasks = [...list.tasks, task];
      return { ...list, tasks, currentTaskId: recomputeCurrent(tasks) };
    });
    return this.requireList(projectPath, sessionId);
  }

  async update(projectPath: string, sessionId: string, input: TaskUpdateInput): Promise<TaskList> {
    const parsed = taskUpdateInputSchema.parse(input);
    await this.ensure(projectPath, sessionId);
    await this.mutate(projectPath, sessionId, (list, now) => {
      const tasks = list.tasks.map((task) => {
        if (task.id !== parsed.id) return task;
        const status = parsed.status ?? task.status;
        const required = parsed.required ?? task.required;
        // A required task cannot be self-verified. Only an independent
        // verification outcome (markCriterionVerified) sets verified=true.
        const verified = !required && status === 'done' ? task.verified : status === 'done' ? task.verified && !required : false;
        return {
          ...task,
          ...(parsed.title !== undefined ? { title: parsed.title } : {}),
          ...(parsed.detail !== undefined ? { detail: parsed.detail } : {}),
          status,
          required,
          verified,
          verifiedAt: verified ? task.verifiedAt ?? now : null,
          updatedAt: now,
        };
      });
      return { ...list, tasks, currentTaskId: recomputeCurrent(tasks) };
    });
    return this.requireList(projectPath, sessionId);
  }

  async reorder(projectPath: string, sessionId: string, input: TaskReorderInput): Promise<TaskList> {
    const parsed = taskReorderInputSchema.parse(input);
    await this.ensure(projectPath, sessionId);
    await this.mutate(projectPath, sessionId, (list, now) => {
      const byId = new Map(list.tasks.map((task) => [task.id, task]));
      const ordered: Task[] = [];
      const seen = new Set<string>();
      for (const id of parsed.orderedIds) {
        const task = byId.get(id);
        if (!task || seen.has(id)) throw new Error('The reorder request references an unknown or duplicate task.');
        seen.add(id);
        ordered.push(task);
      }
      // Any tasks not mentioned keep their relative order after the explicit set.
      for (const task of list.tasks) if (!seen.has(task.id)) ordered.push(task);
      const tasks = ordered.map((task, index) => ({ ...task, order: index, updatedAt: index === task.order ? task.updatedAt : now }));
      return { ...list, tasks, currentTaskId: recomputeCurrent(tasks) };
    });
    return this.requireList(projectPath, sessionId);
  }

  async delete(projectPath: string, sessionId: string, input: TaskDeleteInput): Promise<TaskList> {
    const parsed = taskDeleteInputSchema.parse(input);
    await this.ensure(projectPath, sessionId);
    await this.mutate(projectPath, sessionId, (list, now) => {
      const existing = list.tasks.find((task) => task.id === parsed.id);
      if (!existing) throw new Error('That task no longer exists.');
      if (existing.source === 'goalmax') throw new Error('GoalMax tasks are managed by the active goal. Edit or clear the goal instead.');
      const tasks = list.tasks.filter((task) => task.id !== parsed.id).map((task, index) => ({ ...task, order: index }));
      return { ...list, tasks, currentTaskId: recomputeCurrent(tasks), updatedAt: now };
    });
    return this.requireList(projectPath, sessionId);
  }

  async clear(projectPath: string, sessionId: string): Promise<TaskList> {
    const key = listKey(projectPath, sessionId);
    const currentRevision = this.states.get(key)?.revision ?? 0;
    const now = Date.now();
    const list: TaskList = { ...freshList(projectPath, sessionId, now), revision: currentRevision + 1, updatedAt: now };
    await this.commit(list, currentRevision);
    return structuredClone(this.requireList(projectPath, sessionId));
  }

  async deleteSession(projectPath: string, sessionId: string): Promise<void> {
    this.states.delete(listKey(projectPath, sessionId));
    this.sessionKeys.delete(sessionId);
    await this.repository.deleteSession(projectPath, sessionId);
  }

  /**
   * Mirror a GoalMax goal's criteria into the canonical list. Idempotent: it
   * reconciles titles/required/status, removes dropped criteria, and preserves
   * ordinary user tasks. Verification outcome is applied separately so a stale
   * workspace invalidation never self-verifies a task.
   */
  syncGoal(projectPath: string, sessionId: string, goal: GoalMaxState): Promise<TaskList> {
    return this.serialize(sessionId, async () => {
      await this.ensure(projectPath, sessionId);
      const expected = this.states.get(listKey(projectPath, sessionId))?.revision ?? null;
      const current = structuredClone(this.requireList(projectPath, sessionId));
      const now = Date.now();
      const goalTasksByCriterion = new Map(
        current.tasks.filter((task) => task.source === 'goalmax' && task.goalCriterionId).map((task) => [task.goalCriterionId!, task]),
      );
      const userTasks = current.tasks.filter((task) => task.source !== 'goalmax');
      const goalTasks: Task[] = [];
      for (const criterion of goal.criteria) {
        const existing = goalTasksByCriterion.get(criterion.id);
        const required = criterion.required && criterion.status !== 'waived';
        const hasCurrentSupportingEvidence = goal.evidence.some((evidence) => evidence.kind !== 'verification' && evidence.current && (evidence.exitCode === undefined || evidence.exitCode === 0) && evidence.criterionIds.includes(criterion.id));
        const status = criterion.status === 'satisfied' && !hasCurrentSupportingEvidence ? 'in-progress' : criterionTaskStatus(criterion);
        // Task verification is derived solely from current independent
        // verification evidence. Stale verification (workspace change) or a
        // changed criterion never self-verifies a task.
        const verified = goal.evidence.some((evidence) => evidence.kind === 'verification' && evidence.current && evidence.criterionIds.includes(criterion.id));
        goalTasks.push({
          id: existing?.id ?? `task-${randomUUID()}`,
          title: criterion.title,
          detail: criterion.description,
          status,
          required,
          source: 'goalmax',
          goalId: goal.id,
          goalCriterionId: criterion.id,
          order: 0,
          // Derived above from current verification evidence.
          verified,
          verifiedAt: verified ? existing?.verifiedAt ?? now : null,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        });
      }
      // Drop goal tasks whose criterion disappeared.
      const combined = [...userTasks, ...goalTasks]
        .sort((left, right) => {
          // Keep user tasks first (stable by existing order), then goal tasks.
          const lu = left.source !== 'goalmax' ? 0 : 1;
          const ru = right.source !== 'goalmax' ? 0 : 1;
          return lu - ru;
        })
        .map((task, index) => ({ ...task, order: index }));
      const next: TaskList = {
        ...current,
        revision: current.revision + 1,
        goalId: goal.id,
        tasks: combined,
        currentTaskId: recomputeCurrent(combined),
        updatedAt: now,
      };
      await this.commit(next, expected);
    }).then(() => this.requireList(projectPath, sessionId));
  }

  /** Mark the task mirroring a criterion as independently verified (or not). */
  markCriterionVerified(projectPath: string, sessionId: string, goalId: string, criterionId: string, verified: boolean): Promise<void> {
    return this.serialize(sessionId, async () => {
      const expected = this.states.get(listKey(projectPath, sessionId))?.revision ?? null;
      const current = structuredClone(this.requireList(projectPath, sessionId));
      const now = Date.now();
      let changed = false;
      const tasks = current.tasks.map((task) => {
        if (task.source !== 'goalmax' || task.goalId !== goalId || task.goalCriterionId !== criterionId) return task;
        changed = true;
        return { ...task, verified, verifiedAt: verified ? now : null, updatedAt: now };
      });
      if (!changed) return;
      await this.commit({ ...current, revision: current.revision + 1, tasks, updatedAt: now }, expected);
    });
  }

  /** Remove GoalMax-sourced tasks and clear the bound goal (used on goal clear). */
  detachGoal(projectPath: string, sessionId: string, goalId: string): Promise<void> {
    return this.serialize(sessionId, async () => {
      const expected = this.states.get(listKey(projectPath, sessionId))?.revision ?? null;
      const current = structuredClone(this.requireList(projectPath, sessionId));
      const tasks = current.tasks
        .filter((task) => !(task.source === 'goalmax' && task.goalId === goalId))
        .map((task, index) => ({ ...task, order: index }));
      const now = Date.now();
      await this.commit({ ...current, revision: current.revision + 1, goalId: current.goalId === goalId ? null : current.goalId, tasks, currentTaskId: recomputeCurrent(tasks), updatedAt: now }, expected);
    });
  }

  hasList(sessionId: string): boolean {
    return this.sessionKeys.has(sessionId);
  }

  async dispose(): Promise<void> {
    this.states.clear();
    this.sessionKeys.clear();
    this.mutationQueues.clear();
  }

  private requireList(projectPath: string, sessionId: string): TaskList {
    const list = this.states.get(listKey(projectPath, sessionId));
    if (!list) throw new Error('This session has no task list.');
    return structuredClone(list);
  }

  private mutate(
    projectPath: string,
    sessionId: string,
    operation: (list: TaskList, now: number) => TaskList,
  ): Promise<void> {
    return this.serialize(sessionId, async () => {
      const expected = this.states.get(listKey(projectPath, sessionId))?.revision ?? null;
      const current = structuredClone(this.requireList(projectPath, sessionId));
      const now = Date.now();
      const next = taskListSchema.parse({ ...operation(current, now), revision: current.revision + 1, updatedAt: now });
      if (next.projectPath !== current.projectPath || next.sessionId !== current.sessionId || next.revision !== current.revision + 1) {
        throw new Error('Task list mutations must preserve identity and increment one revision.');
      }
      await this.commit(next, expected);
    });
  }

  private async commit(next: TaskList, expectedRevision: number | null): Promise<void> {
    const parsed = taskListSchema.parse(next);
    // revision 0 is an in-memory placeholder; the first durable commit (advancing
    // 0 -> 1) is a repository create, so it must present a null expected revision.
    const repoExpected = expectedRevision === 0 ? null : expectedRevision;
    await this.repository.save(parsed, repoExpected);
    this.states.set(listKey(parsed.projectPath, parsed.sessionId), parsed);
    this.sessionKeys.set(parsed.sessionId, listKey(parsed.projectPath, parsed.sessionId));
    this.host.emit(snapshotEvent(parsed));
  }

  private serialize(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const key = this.sessionKeys.get(sessionId) ?? sessionId;
    const previous = this.mutationQueues.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const queued = result.then(() => undefined, () => undefined);
    this.mutationQueues.set(key, queued);
    void queued.finally(() => { if (this.mutationQueues.get(key) === queued) this.mutationQueues.delete(key); });
    return result;
  }
}

function snapshotEvent(list: TaskList): TaskEvent {
  return { type: 'tasklist.snapshot', projectPath: list.projectPath, sessionId: list.sessionId, list: structuredClone(list), timestamp: Date.now() };
}
