import { ArrowUpRight, CircleAlert, Clock3, FileCode2, MessageSquare, Route, Wrench } from 'lucide-react';
import { useMemo } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { useShallow } from 'zustand/react/shallow';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { selectFlightRecorder, type FlightDeckTarget, type FlightRecorderRow } from './flightDeck';

function navigate(target: FlightDeckTarget): void {
  const runtime = useRuntimeStore.getState().runtime;
  const projectPath = runtime.project?.path;
  if (!projectPath || !runtime.sessionId) return;
  useUiStore.getState().requestFlightDeckJump(projectPath, runtime.sessionId, target);
}

function RecorderRow({ row }: { row: FlightRecorderRow }) {
  const git = useWorkspaceStore((state) => state.git);
  const changedTargets = row.provenance?.affectedPaths.flatMap((reference) => {
    const change = git?.changes.find((candidate) => candidate.path === reference.path || candidate.oldPath === reference.path);
    return change ? [{ path: change.path, operation: reference.operation }] : [];
  }) ?? [];
  const Icon = row.kind === 'tool' ? Wrench : row.kind === 'error' ? CircleAlert : row.kind === 'message' ? MessageSquare : Route;
  return (
    <article className="recorder-row" data-source={row.source}>
      <span className="recorder-rail" aria-hidden="true"><Icon size={11} /></span>
      <div className="recorder-copy">
        <span><strong>{row.title}</strong><em>{row.source}</em></span>
        <small>{row.detail}</small>
        {changedTargets.length ? <div className="recorder-paths">{changedTargets.map((reference) => (
          <button type="button" key={`${reference.operation}:${reference.path}`} onClick={() => navigate({ kind: 'file', path: reference.path })} title={reference.path}>
            <FileCode2 size={10} />{reference.path}
          </button>
        ))}</div> : null}
      </div>
      {row.target ? (
        <button className="recorder-jump" type="button" aria-label={`Open ${row.title}`} onClick={() => navigate(row.target!)}><ArrowUpRight size={12} /></button>
      ) : <span className="recorder-not-retained">Not retained</span>}
    </article>
  );
}

export function FlightRecorder() {
  const { timelineOrder, timelineById, visibleTimelineIds, messagesById, reasoningByMessageId, toolsById, subagentOrder, subagentsById, agentTeamOrder, agentTeamsById } = useRuntimeStore(useShallow((state) => ({
    timelineOrder: state.timelineOrder,
    timelineById: state.timelineById,
    visibleTimelineIds: state.visibleTimelineIds,
    messagesById: state.messagesById,
    reasoningByMessageId: state.reasoningByMessageId,
    toolsById: state.toolsById,
    subagentOrder: state.subagentOrder,
    subagentsById: state.subagentsById,
    agentTeamOrder: state.agentTeamOrder,
    agentTeamsById: state.agentTeamsById,
  })));
  const subagents = useMemo(() => subagentOrder.flatMap((id) => subagentsById[id] ? [subagentsById[id]!] : []), [subagentOrder, subagentsById]);
  const teams = useMemo(() => agentTeamOrder.flatMap((id) => agentTeamsById[id] ? [agentTeamsById[id]!] : []), [agentTeamOrder, agentTeamsById]);
  const projection = useMemo(() => selectFlightRecorder({ timelineOrder, timelineById, visibleTimelineIds, messagesById, reasoningByMessageId, toolsById, subagents, teams }), [messagesById, reasoningByMessageId, subagents, teams, timelineById, timelineOrder, toolsById, visibleTimelineIds]);
  return (
    <section className="flight-recorder" aria-label="Flight Recorder">
      <header><span><Route size={12} /><strong>Flight Recorder</strong></span><small>{projection.rows.length} recent</small></header>
      {projection.omitted ? <div className="recorder-boundary"><Clock3 size={11} /><span className="recorder-boundary-copy">Older recorder activity is bounded</span></div> : null}
      {projection.rows.length === 0 ? <div className="recorder-empty">No recorded agent activity</div> : (
        <Virtuoso
          className="recorder-list"
          data={projection.rows}
          initialItemCount={Math.min(projection.rows.length, 18)}
          computeItemKey={(_index, row) => row.id}
          itemContent={(_index, row) => <RecorderRow row={row} />}
          followOutput="auto"
        />
      )}
    </section>
  );
}
