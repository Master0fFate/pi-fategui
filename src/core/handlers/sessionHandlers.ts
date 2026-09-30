import type { PiRuntimeService } from '../../main/pi/PiRuntimeService';
import type { AdmissionAuthority, SessionAdmission } from '../workspaces/WorkspaceAdmissionQueue';
import type { WorkspaceHandle } from '../workspaces/WorkspaceHandle';
import { emptyInputSchema, runtimeStateSchema, sessionIdInputSchema, sessionListSchema, sessionSearchInputSchema } from '../../shared/contracts/ipc';

/** Captured runtime only. The transport must resolve its trusted workspace before calling. */
export function createSessionHandlers(runtime: PiRuntimeService) {
  return {
    newSession(input: unknown) {
      emptyInputSchema.parse(input);
      return runtime.newSession().then((state) => runtimeStateSchema.parse(state));
    },
    async listSessions(input: unknown) {
      const { query } = sessionSearchInputSchema.parse(input);
      return sessionListSchema.parse(await runtime.listSessions(query));
    },
    async selectSession(input: unknown) {
      const { sessionId } = sessionIdInputSchema.parse(input);
      return runtimeStateSchema.parse(await runtime.switchSession(sessionId));
    },
    /** Disk-only metadata lookup: never switch or initialize a live Pi session. */
    async listStoredSessions(projectPath: string, input: unknown) {
      const { query } = sessionSearchInputSchema.parse(input);
      if (runtime.getState(false).project?.path !== projectPath) throw new Error('The captured workspace does not own this session path.');
      return sessionListSchema.parse(await runtime.listSessionsForPath(projectPath, query));
    },
  };
}

/** Use only after the host resolves membership and a live generation in its registry. */
export function createScopedSessionHandlers(handle: WorkspaceHandle, authorize: () => AdmissionAuthority) {
  const handlers = createSessionHandlers(handle.runtime);
  return {
    listSessions: (input: unknown) => handlers.listSessions(input),
    listStoredSessions: (input: unknown) => handlers.listStoredSessions(handle.root, input),
    newSession: (command: SessionAdmission, input: unknown) => handle.admission.run(command, authorize,
      () => handlers.newSession(input), true),
    selectSession: (command: SessionAdmission, input: unknown) => handle.admission.run(command, authorize,
      () => handlers.selectSession(input), true),
  };
}
