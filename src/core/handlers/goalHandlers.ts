import type { PiRuntimeService } from '../../main/pi/PiRuntimeService';
import { emptyInputSchema } from '../../shared/contracts/ipc';
import {
  goalMaxClearResultSchema, goalMaxControlInputSchema, goalMaxCreateInputSchema,
  goalMaxStateSchema, goalMaxSteeringEditInputSchema, goalMaxSteeringRemoveInputSchema,
  goalMaxUpdateInputSchema,
} from '../../shared/contracts/goalmaxxing';
import type { AdmissionAuthority, SessionAdmission } from '../workspaces/WorkspaceAdmissionQueue';
import type { WorkspaceHandle } from '../workspaces/WorkspaceHandle';
import { assertScopedRead } from './agentHandlers';

/** UI controls never complete a goal. The existing coordinator owns evidence and verification. */
export function createGoalHandlers(runtime: PiRuntimeService) {
  return {
    async get(input: unknown) {
      emptyInputSchema.parse(input);
      const goal = await runtime.getGoalMax();
      return goal === null ? null : goalMaxStateSchema.parse(goal);
    },
    async create(input: unknown) { return goalMaxStateSchema.parse(await runtime.createGoalMax(goalMaxCreateInputSchema.parse(input))); },
    async control(input: unknown) { return goalMaxStateSchema.parse(await runtime.controlGoalMax(goalMaxControlInputSchema.parse(input))); },
    async update(input: unknown) { return goalMaxStateSchema.parse(await runtime.updateGoalMax(goalMaxUpdateInputSchema.parse(input))); },
    async clear(input: unknown) { emptyInputSchema.parse(input); return goalMaxClearResultSchema.parse(await runtime.clearGoalMax()); },
    async editSteering(input: unknown) { return goalMaxStateSchema.parse(await runtime.editGoalMaxSteering(goalMaxSteeringEditInputSchema.parse(input))); },
    async removeSteering(input: unknown) { return goalMaxStateSchema.parse(await runtime.removeGoalMaxSteering(goalMaxSteeringRemoveInputSchema.parse(input))); },
  };
}

export function createScopedGoalHandlers(handle: WorkspaceHandle, authorize: () => AdmissionAuthority) {
  const handlers = createGoalHandlers(handle.runtime);
  const mutate = <T>(command: SessionAdmission, perform: () => Promise<T>) => handle.admission.run(command, authorize, () => {
    assertScopedRead(handle, authorize);
    return perform();
  });
  return {
    async get(input: unknown) {
      assertScopedRead(handle, authorize);
      const sessionId = handle.admission.snapshot().selectedSessionId;
      const result = await handlers.get(input);
      assertScopedRead(handle, authorize);
      if (handle.admission.snapshot().selectedSessionId !== sessionId) throw new Error('The selected session changed during the goal read.');
      return result;
    },
    create: (command: SessionAdmission, input: unknown) => mutate(command, () => handlers.create(input)),
    control: (command: SessionAdmission, input: unknown) => mutate(command, () => handlers.control(input)),
    update: (command: SessionAdmission, input: unknown) => mutate(command, () => handlers.update(input)),
    clear: (command: SessionAdmission, input: unknown) => mutate(command, () => handlers.clear(input)),
    editSteering: (command: SessionAdmission, input: unknown) => mutate(command, () => handlers.editSteering(input)),
    removeSteering: (command: SessionAdmission, input: unknown) => mutate(command, () => handlers.removeSteering(input)),
  };
}
