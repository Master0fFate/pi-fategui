import type { PiRuntimeService } from '../../main/pi/PiRuntimeService';
import { emptyInputSchema } from '../../shared/contracts/ipc';
import {
  taskCreateInputSchema, taskDeleteInputSchema, taskListSchema, taskReorderInputSchema,
  taskUpdateInputSchema,
} from '../../shared/contracts/tasks';
import type { AdmissionAuthority, SessionAdmission } from '../workspaces/WorkspaceAdmissionQueue';
import type { WorkspaceHandle } from '../workspaces/WorkspaceHandle';
import { assertScopedRead } from './agentHandlers';

/** Existing TaskService owns GoalMax mirroring and the independent verified flag. */
export function createTaskHandlers(runtime: PiRuntimeService) {
  return {
    async get(input: unknown) {
      emptyInputSchema.parse(input);
      const list = await runtime.getTaskList();
      return list === null ? null : taskListSchema.parse(list);
    },
    async create(input: unknown) { return taskListSchema.parse(await runtime.createTask(taskCreateInputSchema.parse(input))); },
    async update(input: unknown) { return taskListSchema.parse(await runtime.updateTask(taskUpdateInputSchema.parse(input))); },
    async reorder(input: unknown) { return taskListSchema.parse(await runtime.reorderTasks(taskReorderInputSchema.parse(input))); },
    async delete(input: unknown) { return taskListSchema.parse(await runtime.deleteTask(taskDeleteInputSchema.parse(input))); },
    async clear(input: unknown) { emptyInputSchema.parse(input); return taskListSchema.parse(await runtime.clearTasks()); },
  };
}

export function createScopedTaskHandlers(handle: WorkspaceHandle, authorize: () => AdmissionAuthority) {
  const handlers = createTaskHandlers(handle.runtime);
  const mutate = <T>(command: SessionAdmission, perform: () => Promise<T>) => handle.admission.run(command, authorize, () => {
    assertScopedRead(handle, authorize);
    return perform();
  });
  return {
    async get(input: unknown = {}) {
      assertScopedRead(handle, authorize);
      const sessionId = handle.admission.snapshot().selectedSessionId;
      const result = await handlers.get(input);
      assertScopedRead(handle, authorize);
      if (handle.admission.snapshot().selectedSessionId !== sessionId) throw new Error('The selected session changed during the task read.');
      return result;
    },
    create: (command: SessionAdmission, input: unknown) => mutate(command, () => handlers.create(input)),
    update: (command: SessionAdmission, input: unknown) => mutate(command, () => handlers.update(input)),
    reorder: (command: SessionAdmission, input: unknown) => mutate(command, () => handlers.reorder(input)),
    delete: (command: SessionAdmission, input: unknown) => mutate(command, () => handlers.delete(input)),
    clear: (command: SessionAdmission, input: unknown) => mutate(command, () => handlers.clear(input)),
  };
}
