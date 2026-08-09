import { z } from 'zod';

/**
 * Canonical session-scoped task list.
 *
 * Tasks are a general app-owned primitive. They are NOT GoalMax-exclusive.
 * Ordinary user prompts create and update them; GoalMax binds to the same
 * list and synchronizes its required criteria into it (source = 'goalmax')
 * so the renderer and the runtime share one source of truth.
 */

export const TASK_LIST_SCHEMA_VERSION = 1;
export const TASK_MAX_ITEMS = 200;
export const TASK_TITLE_LIMIT = 240;
export const TASK_DETAIL_LIMIT = 2_000;

const idSchema = z.string().min(1).max(160).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'Identifiers cannot contain control characters.');

export const taskStatusSchema = z.enum(['todo', 'in-progress', 'done', 'blocked']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSourceSchema = z.enum(['user', 'goalmax', 'system']);
export type TaskSource = z.infer<typeof taskSourceSchema>;

export const taskSchema = z.object({
  id: idSchema,
  title: z.string().trim().min(1).max(TASK_TITLE_LIMIT),
  detail: z.string().trim().max(TASK_DETAIL_LIMIT).default(''),
  status: taskStatusSchema,
  required: z.boolean(),
  source: taskSourceSchema,
  /** GoalMax goal id when this task mirrors a goal criterion. */
  goalId: idSchema.nullable(),
  /** GoalMax criterion id this task mirrors (null for ordinary tasks). */
  goalCriterionId: idSchema.nullable(),
  /** Stable ordering index; dense within a list. */
  order: z.number().int().nonnegative().safe(),
  /** Independently verified with current non-verifier evidence. */
  verified: z.boolean(),
  verifiedAt: z.number().int().nonnegative().safe().nullable(),
  createdAt: z.number().int().nonnegative().safe(),
  updatedAt: z.number().int().nonnegative().safe(),
}).strict();

export type Task = z.infer<typeof taskSchema>;

export const taskListSchema = z.object({
  schemaVersion: z.literal(TASK_LIST_SCHEMA_VERSION),
  projectPath: z.string().min(1).max(32_768),
  sessionId: z.string().min(1).max(500),
  revision: z.number().int().nonnegative().safe(),
  /** Bound GoalMax goal id, if any. Null for ordinary task lists. */
  goalId: idSchema.nullable(),
  tasks: z.array(taskSchema).max(TASK_MAX_ITEMS),
  /** First non-done task in order, or null when every task is done/blocked. */
  currentTaskId: idSchema.nullable(),
  updatedAt: z.number().int().nonnegative().safe(),
}).strict().superRefine((list, context) => {
  const ids = new Set<string>();
  for (const task of list.tasks) {
    if (ids.has(task.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Task IDs must be unique.', path: ['tasks'] });
      break;
    }
    ids.add(task.id);
    if (task.source === 'goalmax') {
      if (!task.goalId) context.addIssue({ code: z.ZodIssueCode.custom, message: 'GoalMax-sourced tasks must reference a goal id.', path: ['tasks'] });
      if (list.goalId && task.goalId !== list.goalId) context.addIssue({ code: z.ZodIssueCode.custom, message: 'GoalMax-sourced tasks must match the bound goal id.', path: ['tasks'] });
    } else if (task.goalId || task.goalCriterionId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Ordinary tasks cannot reference a goal.', path: ['tasks'] });
    }
  }
  if (list.currentTaskId && !ids.has(list.currentTaskId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'The current task id must reference a retained task.', path: ['currentTaskId'] });
  }
  const current = list.currentTaskId ? list.tasks.find((task) => task.id === list.currentTaskId) : null;
  if (current && current.status === 'done') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'The current task cannot already be done.', path: ['currentTaskId'] });
  }
});

export type TaskList = z.infer<typeof taskListSchema>;

export const taskCreateInputSchema = z.object({
  title: z.string().trim().min(1).max(TASK_TITLE_LIMIT),
  detail: z.string().trim().max(TASK_DETAIL_LIMIT).default(''),
  required: z.boolean().default(false),
  status: taskStatusSchema.default('todo'),
}).strict();
export type TaskCreateInput = z.input<typeof taskCreateInputSchema>;

export const taskUpdateInputSchema = z.object({
  id: idSchema,
  title: z.string().trim().min(1).max(TASK_TITLE_LIMIT).optional(),
  detail: z.string().trim().max(TASK_DETAIL_LIMIT).optional(),
  status: taskStatusSchema.optional(),
  required: z.boolean().optional(),
}).strict().refine((input) => Object.keys(input).some((key) => key !== 'id'), 'At least one task field must change.');
export type TaskUpdateInput = z.infer<typeof taskUpdateInputSchema>;

export const taskReorderInputSchema = z.object({
  orderedIds: z.array(idSchema).min(1).max(TASK_MAX_ITEMS),
}).strict();
export type TaskReorderInput = z.infer<typeof taskReorderInputSchema>;

export const taskDeleteInputSchema = z.object({ id: idSchema }).strict();
export type TaskDeleteInput = z.infer<typeof taskDeleteInputSchema>;

export const taskEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tasklist.snapshot'),
    projectPath: z.string().min(1).max(32_768),
    sessionId: z.string().min(1).max(500),
    list: taskListSchema.nullable(),
    timestamp: z.number().int().nonnegative().safe(),
  }).strict(),
]);
export type TaskEvent = z.infer<typeof taskEventSchema>;
export const taskEventBatchSchema = z.array(taskEventSchema).min(1).max(50);

/** Compact gate snapshot embedded in RuntimeState.queue for the renderer. */
export const taskListSummarySchema = z.object({
  goalId: idSchema.nullable(),
  total: z.number().int().nonnegative().safe(),
  requiredTotal: z.number().int().nonnegative().safe(),
  requiredDone: z.number().int().nonnegative().safe(),
  requiredVerified: z.number().int().nonnegative().safe(),
  currentTaskId: idSchema.nullable(),
  currentTitle: z.string().max(TASK_TITLE_LIMIT).nullable(),
  currentStatus: taskStatusSchema.nullable(),
  verified: z.boolean(),
}).strict();
export type TaskListSummary = z.infer<typeof taskListSummarySchema>;

/** True when every required task is done AND independently verified. */
export function isTaskListGateSatisfied(list: TaskList | null): boolean {
  if (!list) return true;
  const required = list.tasks.filter((task) => task.required);
  if (required.length === 0) return true;
  return required.every((task) => task.status === 'done' && task.verified);
}

export function summarizeTaskList(list: TaskList | null): TaskListSummary {
  if (!list) {
    return { goalId: null, total: 0, requiredTotal: 0, requiredDone: 0, requiredVerified: 0, currentTaskId: null, currentTitle: null, currentStatus: null, verified: true };
  }
  const required = list.tasks.filter((task) => task.required);
  const current = list.currentTaskId ? list.tasks.find((task) => task.id === list.currentTaskId) ?? null : null;
  return {
    goalId: list.goalId,
    total: list.tasks.length,
    requiredTotal: required.length,
    requiredDone: required.filter((task) => task.status === 'done').length,
    requiredVerified: required.filter((task) => task.status === 'done' && task.verified).length,
    currentTaskId: current?.id ?? null,
    currentTitle: current?.title ?? null,
    currentStatus: current?.status ?? null,
    verified: isTaskListGateSatisfied(list),
  };
}
