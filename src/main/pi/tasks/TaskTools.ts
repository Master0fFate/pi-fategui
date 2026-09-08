import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  TASK_DETAIL_LIMIT,
  TASK_TITLE_LIMIT,
  taskCreateInputSchema,
  taskUpdateInputSchema,
  type TaskList,
} from '../../../shared/contracts/tasks';
import type { TaskService } from './TaskService';

export const TASK_TOOL_NAMES = ['list_tasks', 'create_task', 'update_task', 'delete_task'] as const;

export interface TaskToolSession {
  projectPath: string;
  sessionId: string;
  isCurrent(): boolean;
}

const createInput = taskCreateInputSchema.omit({ required: true });
const updateInput = taskUpdateInputSchema.innerType().omit({ required: true })
  .refine((input) => Object.keys(input).some((key) => key !== 'id'), 'At least one task field must change.');

function result(list: TaskList | null) {
  return {
    content: [{ type: 'text' as const, text: list ? JSON.stringify(list) : 'This session has no tasks.' }],
    details: { list },
  };
}

export function createTaskTools(
  tasks: TaskService,
  resolveSession: (sessionId: string) => TaskToolSession,
): ToolDefinition[] {
  const loading = new Map<string, Promise<TaskList | null>>();
  const prepare = async (sessionId: string, signal?: AbortSignal): Promise<TaskToolSession> => {
    signal?.throwIfAborted();
    const owner = resolveSession(sessionId);
    if (!owner.isCurrent()) throw new Error('The calling root session is no longer available.');
    const key = `${owner.projectPath}\0${owner.sessionId}`;
    if (!tasks.get(owner.projectPath, owner.sessionId)) {
      let pending = loading.get(key);
      if (!pending) {
        pending = tasks.bind(owner.projectPath, owner.sessionId);
        loading.set(key, pending);
      }
      try {
        await pending;
      } finally {
        if (loading.get(key) === pending) loading.delete(key);
      }
    }
    signal?.throwIfAborted();
    if (!owner.isCurrent()) throw new Error('The calling root session changed while loading its tasks.');
    return owner;
  };
  const title = Type.String({ minLength: 1, maxLength: TASK_TITLE_LIMIT });
  const detail = Type.String({ maxLength: TASK_DETAIL_LIMIT, description: 'Task details and observable completion condition.' });
  const status = Type.Unsafe<'todo' | 'in-progress' | 'done' | 'blocked'>({
    type: 'string', enum: ['todo', 'in-progress', 'done', 'blocked'],
  });
  const id = Type.String({ minLength: 1, maxLength: 160, description: 'Exact task ID returned by list_tasks.' });
  return [
    defineTool({
      name: 'list_tasks',
      label: 'List session tasks',
      promptSnippet: 'Inspect the current session task list, details, and statuses',
      description: 'Read the canonical task list for this root session, including ordinary tasks and read-only GoalMax-managed tasks. Available without GoalMax. No project files are changed.',
      parameters: Type.Object({}, { additionalProperties: false }),
      executionMode: 'sequential',
      execute: async (_id, _params, signal, _update, context) => {
        const owner = await prepare(context.sessionManager.getSessionId(), signal);
        return result(tasks.get(owner.projectPath, owner.sessionId));
      },
    }),
    defineTool({
      name: 'create_task',
      label: 'Create session task',
      promptSnippet: 'Add an ordinary task to the current session task list',
      description: 'Create a session task with a title, optional detail, and status (default todo). This changes session metadata only, not project files. It cannot create GoalMax criteria or independent verification evidence.',
      parameters: Type.Object({ title, detail: Type.Optional(detail), status: Type.Optional(status) }, { additionalProperties: false }),
      executionMode: 'sequential',
      execute: async (_id, params, signal, _update, context) => {
        const input = createInput.parse(params);
        const owner = await prepare(context.sessionManager.getSessionId(), signal);
        return result(await tasks.create(owner.projectPath, owner.sessionId, input));
      },
    }),
    defineTool({
      name: 'update_task',
      label: 'Update session task',
      promptSnippet: 'Update an ordinary task title, details, or status',
      description: 'Update an existing ordinary session task by ID. At least one field must change. GoalMax-managed tasks, requirement flags, and independent verification cannot be changed with this tool. A done status is a progress report, not verification evidence.',
      parameters: Type.Object({ id, title: Type.Optional(title), detail: Type.Optional(detail), status: Type.Optional(status) }, { additionalProperties: false }),
      executionMode: 'sequential',
      execute: async (_id, params, signal, _update, context) => {
        const input = updateInput.parse(params);
        const owner = await prepare(context.sessionManager.getSessionId(), signal);
        return result(await tasks.update(owner.projectPath, owner.sessionId, input));
      },
    }),
    defineTool({
      name: 'delete_task',
      label: 'Delete session task',
      promptSnippet: 'Remove an ordinary task from the current session task list',
      description: 'Delete an ordinary session task by exact ID. GoalMax-managed tasks cannot be deleted. This changes session metadata only, not project files.',
      parameters: Type.Object({ id }, { additionalProperties: false }),
      executionMode: 'sequential',
      execute: async (_id, params, signal, _update, context) => {
        const owner = await prepare(context.sessionManager.getSessionId(), signal);
        return result(await tasks.delete(owner.projectPath, owner.sessionId, params));
      },
    }),
  ] as ToolDefinition[];
}
