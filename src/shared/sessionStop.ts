interface ChildWorkState {
  agentTeams?: readonly { activeTurns: number; nodes: readonly { depth: number; status: string }[]; tasks: readonly { status: string }[] }[] | null | undefined;
  subagents?: readonly { status: string }[] | null | undefined;
  subagentWorkflows?: readonly { nodes: readonly { status: string }[] }[] | null | undefined;
}

export function hasStoppableChildWork(runtime: ChildWorkState): boolean {
  return (runtime.agentTeams ?? []).some((team) => team.activeTurns > 0
      || team.nodes.some((node) => node.depth > 0 && (node.status === 'creating' || node.status === 'active'))
      || team.tasks.some((task) => task.status === 'queued' || task.status === 'running'))
    || (runtime.subagents ?? []).some((run) => run.status === 'running' || run.status === 'queued')
    || (runtime.subagentWorkflows ?? []).some((workflow) => workflow.nodes.some((node) => node.status === 'running' || node.status === 'pending'));
}

export function canStopSession(runtime: ChildWorkState & {
  streaming: boolean;
  activeSessionRunning?: boolean | undefined;
}): boolean {
  return runtime.streaming || runtime.activeSessionRunning === true || hasStoppableChildWork(runtime);
}
