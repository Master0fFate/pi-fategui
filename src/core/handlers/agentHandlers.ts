import type { PiRuntimeService } from '../../main/pi/PiRuntimeService';
import { runtimeStateSchema, subagentControlInputSchema } from '../../shared/contracts/ipc';
import { agentTeamControlInputSchema } from '../../shared/contracts/multiAgent';
import { monitorDashboardSchema, monitorReadInputSchema } from '../../shared/contracts/monitorDashboard';
import { WorkspaceAdmissionError, type AdmissionAuthority, type SessionAdmission } from '../workspaces/WorkspaceAdmissionQueue';
import type { WorkspaceHandle } from '../workspaces/WorkspaceHandle';

/** Host membership and generation are checked again at use, not captured as a boolean. */
export function assertScopedRead(handle: WorkspaceHandle, authorize: () => AdmissionAuthority): void {
  const authority = authorize();
  if (authority.currentGeneration !== handle.generation) throw new WorkspaceAdmissionError('STALE_WORKSPACE');
  const project = handle.runtime.getState(false).project;
  if (!project?.trusted || project.path !== handle.root) throw new WorkspaceAdmissionError('STALE_WORKSPACE');
}

/** Existing Team/subagent runtime owns authorization, stop settlement and worktree review. */
export function createAgentHandlers(runtime: PiRuntimeService) {
  return {
    async controlTeam(input: unknown) {
      return runtimeStateSchema.parse(await runtime.controlAgentTeam(agentTeamControlInputSchema.parse(input)));
    },
    async controlSubagent(input: unknown) {
      return runtimeStateSchema.parse(await runtime.controlSubagent(subagentControlInputSchema.parse(input)));
    },
    /** The root ID comes from the trusted adapter or saved agent's origin, never from input. */
    async monitor(input: unknown, rootSessionId: string) {
      return monitorDashboardSchema.parse(await runtime.getMonitorDashboard(monitorReadInputSchema.parse(input), rootSessionId));
    },
    async desktopMonitor(input: unknown) {
      return monitorDashboardSchema.parse(await runtime.getMonitorDashboard(monitorReadInputSchema.parse(input)));
    },
  };
}

/** A caller may not nominate a different parent, workspace, or root in a Team command. */
export function createScopedAgentHandlers(handle: WorkspaceHandle, authorize: () => AdmissionAuthority, rootSessionId: string) {
  const handlers = createAgentHandlers(handle.runtime);
  const assertRoot = () => {
    assertScopedRead(handle, authorize);
    if (handle.runtime.getState(false).sessionId !== rootSessionId) throw new WorkspaceAdmissionError('STALE_SESSION');
  };
  return {
    async monitor(input: unknown) {
      assertScopedRead(handle, authorize);
      // A scheduled agent may read its own still-live root even when another session is selected.
      const result = await handlers.monitor(input, rootSessionId);
      assertScopedRead(handle, authorize);
      if (result.projectPath !== handle.root || result.sessionId !== rootSessionId) throw new WorkspaceAdmissionError('STALE_SESSION');
      return result;
    },
    controlTeam(command: SessionAdmission, input: unknown) {
      return handle.admission.run(command, authorize, () => { assertRoot(); return handlers.controlTeam(input); });
    },
    controlSubagent(command: SessionAdmission, input: unknown) {
      return handle.admission.run(command, authorize, () => { assertRoot(); return handlers.controlSubagent(input); });
    },
  };
}
