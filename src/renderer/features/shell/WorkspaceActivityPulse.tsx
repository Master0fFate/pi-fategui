import { Activity, CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react';
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { selectActivityPulse } from './flightDeck';

export function WorkspaceActivityPulse() {
  const projection = useRuntimeStore(useShallow((state) => ({
    status: state.runtime.status,
    project: state.runtime.project,
    error: state.runtime.error,
    sessionOperation: state.runtime.sessionOperation,
    contextUsage: state.runtime.contextUsage,
    streaming: state.runtime.streaming,
    activeSessionRunning: state.runtime.activeSessionRunning,
    queue: state.runtime.queue,
    workflows: state.runtime.subagentWorkflows,
    teams: state.runtime.agentTeams,
    toolOrder: state.toolOrder,
    toolsById: state.toolsById,
    toolsVersion: state.toolsVersion,
    subagentOrder: state.subagentOrder,
    subagentRecorderVersion: state.subagentRecorderVersion,
  })));
  const tools = useMemo(() => projection.toolOrder.flatMap((id) => projection.toolsById[id] ? [projection.toolsById[id]!] : []), [projection.toolOrder, projection.toolsById, projection.toolsVersion]);
  const subagents = useMemo(() => {
    const runsById = useRuntimeStore.getState().subagentsById;
    return projection.subagentOrder.flatMap((id) => runsById[id] ? [runsById[id]!] : []);
  }, [projection.subagentOrder, projection.subagentRecorderVersion]);
  const git = useWorkspaceStore((state) => state.git);
  const pulse = useMemo(() => selectActivityPulse({
    runtime: {
      status: projection.status,
      project: projection.project,
      error: projection.error,
      sessionOperation: projection.sessionOperation,
      contextUsage: projection.contextUsage,
      streaming: projection.streaming,
      activeSessionRunning: projection.activeSessionRunning,
      queue: projection.queue,
    },
    tools,
    subagents,
    workflows: projection.workflows ?? [],
    teams: projection.teams ?? [],
    changedFiles: git?.repository ? git.changes.length : null,
  }), [git, projection.activeSessionRunning, projection.contextUsage, projection.error, projection.project, projection.queue, projection.sessionOperation, projection.status, projection.streaming, projection.teams, projection.workflows, subagents, tools]);
  const Icon = pulse.tone === 'active' ? LoaderCircle : pulse.tone === 'attention' ? CircleAlert : pulse.tone === 'success' ? CircleCheck : Activity;
  return (
    <div className="activity-pulse" data-tone={pulse.tone} aria-label={`Activity: ${pulse.label}. ${pulse.context}`}>
      <span className="activity-pulse-state"><Icon size={10} className={pulse.tone === 'active' ? 'tool-spinner' : undefined} aria-hidden="true" />{pulse.label}</span>
      {pulse.evidence.slice(0, 3).map((item) => <span className="activity-pulse-chip" key={item}>{item}</span>)}
      <span className="activity-pulse-context">{pulse.context}</span>
    </div>
  );
}
