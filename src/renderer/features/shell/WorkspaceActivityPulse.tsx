import { Activity, CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react';
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { selectActivityPulse } from './flightDeck';

export function WorkspaceActivityPulse() {
  const { runtime, toolOrder, toolsById, toolsVersion, subagentOrder, subagentsById } = useRuntimeStore(useShallow((state) => ({
    runtime: state.runtime,
    toolOrder: state.toolOrder,
    toolsById: state.toolsById,
    toolsVersion: state.toolsVersion,
    subagentOrder: state.subagentOrder,
    subagentsById: state.subagentsById,
  })));
  const tools = useMemo(() => toolOrder.flatMap((id) => toolsById[id] ? [toolsById[id]!] : []), [toolOrder, toolsById, toolsVersion]);
  const subagents = useMemo(() => subagentOrder.flatMap((id) => subagentsById[id] ? [subagentsById[id]!] : []), [subagentOrder, subagentsById]);
  const git = useWorkspaceStore((state) => state.git);
  const pulse = useMemo(() => selectActivityPulse({
    runtime,
    tools,
    subagents,
    workflows: runtime.subagentWorkflows ?? [],
    teams: runtime.agentTeams ?? [],
    changedFiles: git?.repository ? git.changes.length : null,
  }), [git, runtime, subagents, tools]);
  const Icon = pulse.tone === 'active' ? LoaderCircle : pulse.tone === 'attention' ? CircleAlert : pulse.tone === 'success' ? CircleCheck : Activity;
  return (
    <div className="activity-pulse" data-tone={pulse.tone} aria-label={`Activity: ${pulse.label}. ${pulse.context}`}>
      <span className="activity-pulse-state"><Icon size={10} className={pulse.tone === 'active' ? 'tool-spinner' : undefined} aria-hidden="true" />{pulse.label}</span>
      {pulse.evidence.slice(0, 3).map((item) => <span className="activity-pulse-chip" key={item}>{item}</span>)}
      <span className="activity-pulse-context">{pulse.context}</span>
    </div>
  );
}
