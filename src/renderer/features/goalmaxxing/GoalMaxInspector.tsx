import * as Tabs from '@radix-ui/react-tabs';
import { Check, CircleAlert, Clock3, Gauge, ListChecks, LoaderCircle, MessagesSquare, Pause, Play, RefreshCw, Route, ShieldCheck, Target, TestTube2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import type { GoalMaxCriterion, GoalMaxEvidence, GoalMaxState, GoalMaxTimelineEvent } from '../../../shared/contracts/goalmaxxing';
import { useGoalMaxStore } from '../../stores/goalMaxStore';
import { useUiStore } from '../../stores/uiStore';

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
function compactNumber(value: number): string {
  if (value < 1_000) return integer.format(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}m`;
}
function duration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
function criterionIcon(status: GoalMaxCriterion['status']) {
  if (status === 'satisfied' || status === 'waived') return <Check size={12} />;
  if (status === 'failed') return <CircleAlert size={12} />;
  if (status === 'active') return <LoaderCircle className="tool-spinner" size={12} />;
  return <Clock3 size={12} />;
}

function timelinePresentation(type: GoalMaxTimelineEvent['type']) {
  const label = type.split('.').map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(' ');
  if (type === 'goal.completed' || type === 'verification.passed') return { Icon: Check, label, tone: 'success' } as const;
  if (type === 'goal.blocked' || type === 'goal.cancelled' || type === 'verification.failed' || type === 'budget.reached') return { Icon: CircleAlert, label, tone: 'danger' } as const;
  if (type === 'goal.paused') return { Icon: Pause, label, tone: 'neutral' } as const;
  if (type === 'goal.resumed') return { Icon: Play, label, tone: 'active' } as const;
  if (type === 'goal.recovered') return { Icon: RefreshCw, label, tone: 'active' } as const;
  if (type === 'checkpoint.created') return { Icon: Gauge, label, tone: 'active' } as const;
  if (type === 'verification.started') return { Icon: TestTube2, label, tone: 'active' } as const;
  if (type === 'assignment.updated') return { Icon: MessagesSquare, label, tone: 'active' } as const;
  if (type === 'goal.created') return { Icon: Target, label, tone: 'active' } as const;
  return { Icon: Route, label, tone: 'neutral' } as const;
}

export function GoalMaxInspector() {
  const goal = useGoalMaxStore((state) => state.goal);
  const loading = useGoalMaxStore((state) => state.loading);
  const setGoal = useGoalMaxStore((state) => state.setGoal);
  const showToast = useUiStore((state) => state.showToast);
  const openAgents = useUiStore((state) => state.openSubagentList);
  const [busy, setBusy] = useState<'checkpoint' | 'verify' | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!goal || goal.status === 'completed' || goal.status === 'cancelled') return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [goal?.id, goal?.status]);
  const control = async (action: 'checkpoint' | 'verify') => {
    if (!goal || busy || !('piDesktop' in window) || typeof window.piDesktop.controlGoalMax !== 'function') return;
    setBusy(action);
    try { setGoal(await window.piDesktop.controlGoalMax({ action })); }
    catch (error) { showToast({ kind: 'error', title: action === 'verify' ? 'Verification failed to start' : 'Checkpoint failed', message: error instanceof Error ? error.message : 'Try again after the current operation settles.' }); }
    finally { setBusy(null); }
  };
  if (!goal) {
    return <div className="inspector-empty goalmax-empty"><Target size={24} /><strong>{loading ? 'Loading goal…' : 'No active goal'}</strong><p>Start one with /goalmaxxing followed by an objective.</p></div>;
  }
  const required = goal.criteria.filter((criterion) => criterion.required && criterion.status !== 'waived');
  const satisfied = required.filter((criterion) => criterion.status === 'satisfied').length;
  const activeAssignments = goal.childAssignments.filter((assignment) => assignment.status === 'running' || assignment.status === 'pending').length;
  const agentPolicy = goal.agentStrategy === 'off' ? 'root only' : goal.agentStrategy === 'read-only' ? 'read-only agents' : 'automatic agents';
  return (
    <section className="goalmax-flight-deck" aria-label="Goal Flight Deck">
      <header className="goalmax-deck-header" data-status={goal.status}>
        <span className="goalmax-deck-mark"><Target size={15} /></span>
        <span><strong>{goal.status === 'verifying' ? 'Verifying' : goal.status.charAt(0).toUpperCase() + goal.status.slice(1)}</strong><small>{goal.phase} · revision {goal.revision}</small></span>
        <div>
          <button type="button" disabled={Boolean(busy) || goal.status === 'completed' || goal.status === 'cancelled'} onClick={() => void control('checkpoint')}>{busy === 'checkpoint' ? <LoaderCircle className="tool-spinner" size={12} /> : <Gauge size={12} />}<span>Checkpoint</span></button>
          <button type="button" disabled={Boolean(busy) || goal.status === 'completed' || goal.status === 'cancelled'} onClick={() => void control('verify')}>{busy === 'verify' ? <LoaderCircle className="tool-spinner" size={12} /> : <TestTube2 size={12} />}<span>Verify</span></button>
        </div>
      </header>
      <Tabs.Root defaultValue="overview" className="goalmax-deck-tabs">
        <Tabs.List aria-label="Goal Flight Deck views"><Tabs.Trigger value="overview">Overview</Tabs.Trigger><Tabs.Trigger value="criteria">Criteria <span>{satisfied}/{required.length}</span></Tabs.Trigger><Tabs.Trigger value="evidence">Evidence</Tabs.Trigger><Tabs.Trigger value="timeline">Timeline</Tabs.Trigger></Tabs.List>
        <Tabs.Content value="overview" className="goalmax-deck-content">
          <section className="goalmax-objective"><span>Objective</span><p>{goal.objective}</p></section>
          {goal.blockedReason ? <section className="goalmax-blocker" role="status"><CircleAlert size={14} /><span><strong>Needs attention</strong>{goal.blockedReason}</span></section> : null}
          <dl className="goalmax-overview-facts">
            <div><dt>Criteria</dt><dd>{satisfied}/{required.length}</dd></div>
            <div><dt>Agents</dt><dd>{activeAssignments ? `${activeAssignments} active` : `${goal.childAssignments.length} linked`}</dd></div>
            <div><dt>Tokens</dt><dd>{compactNumber(goal.tokensUsed)}</dd></div>
            <div><dt>Elapsed</dt><dd>{duration(goal.elapsedMs + (goal.startedAt && goal.status !== 'completed' && goal.status !== 'cancelled' ? Math.max(0, now - goal.updatedAt) : 0))}</dd></div>
          </dl>
          <section className="goalmax-policy"><ShieldCheck size={13} /><span><strong>{goal.permission.permissionLevel} · {agentPolicy}</strong><small>{goal.verificationLevel} verification · {goal.permission.projectTrusted ? 'trusted project' : 'untrusted project'} · policy r{goal.permission.revision}</small></span></section>
          <section className="goalmax-progress-ledger"><span>Progress</span><dl><div><dt>Meaningful turns</dt><dd>{goal.progress.meaningfulTurnCount}</dd></div><div><dt>Stalled</dt><dd>{goal.progress.noProgressTurnCount}</dd></div><div><dt>Steering</dt><dd>{goal.steering.length}</dd></div><div><dt>Changed files</dt><dd>{goal.progress.changedFileCount}</dd></div><div><dt>Continuations</dt><dd>{goal.continuation.attempt}</dd></div></dl></section>
          <button className="goalmax-agents-link" type="button" onClick={openAgents}><MessagesSquare size={13} /><span>Open linked agents</span><em>{goal.childAssignments.length}</em></button>
        </Tabs.Content>
        <Tabs.Content value="criteria" className="goalmax-deck-content goalmax-criteria-list">
          {goal.criteria.map((criterion) => <CriterionRow key={criterion.id} criterion={criterion} assignments={goal.childAssignments} />)}
        </Tabs.Content>
        <Tabs.Content value="evidence" className="goalmax-deck-content goalmax-virtual-list">
          {goal.evidence.length ? <Virtuoso data={[...goal.evidence].reverse()} computeItemKey={(_index, evidence) => evidence.id} itemContent={(_index, evidence) => <EvidenceRow evidence={evidence} />} /> : <DeckEmpty icon={ListChecks} text="No evidence recorded" />}
        </Tabs.Content>
        <Tabs.Content value="timeline" className="goalmax-deck-content goalmax-virtual-list">
          {goal.timeline.length ? <Virtuoso data={goal.timeline} computeItemKey={(_index, event) => event.id} initialTopMostItemIndex={{ index: 'LAST', align: 'end', behavior: 'auto' }} followOutput="auto" itemContent={(index, event) => <TimelineRow event={event} first={index === 0} last={index === goal.timeline.length - 1} />} /> : <DeckEmpty icon={Route} text="No lifecycle events" />}
        </Tabs.Content>
      </Tabs.Root>
    </section>
  );
}

function CriterionRow({ criterion, assignments }: { criterion: GoalMaxCriterion; assignments: GoalMaxState['childAssignments'] }) {
  const owners = criterion.ownerNodeIds.flatMap((nodeId) => assignments.find((assignment) => assignment.nodeId === nodeId)?.label ?? []).join(', ');
  return <article className="goalmax-criterion-row" data-status={criterion.status}><span>{criterionIcon(criterion.status)}</span><div><strong>{criterion.title}</strong>{criterion.description && criterion.description !== criterion.title ? <p>{criterion.description}</p> : null}<small>{owners || `${criterion.evidenceIds.length} evidence`}</small></div><em>{criterion.status}</em></article>;
}
function EvidenceRow({ evidence }: { evidence: GoalMaxEvidence }) {
  return <article className="goalmax-evidence-row" data-current={evidence.current}><span>{evidence.kind}</span><div><strong>{evidence.title}</strong><small>{new Date(evidence.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{evidence.exitCode === undefined ? '' : ` · exit ${evidence.exitCode}`}</small>{evidence.summary ? <details><summary>Details</summary><pre>{evidence.summary}</pre></details> : null}</div></article>;
}
function TimelineRow({ event, first, last }: { event: GoalMaxTimelineEvent; first: boolean; last: boolean }) {
  const { Icon, label, tone } = timelinePresentation(event.type);
  const date = new Date(event.timestamp);
  return (
    <article className="goalmax-timeline-row" data-tone={tone} data-first={first || undefined} data-last={last || undefined}>
      <span className="goalmax-timeline-rail" aria-hidden="true"><i><Icon size={11} /></i></span>
      <div><strong>{event.summary}</strong><small>{label} · <time dateTime={date.toISOString()} title={date.toLocaleString()}>{date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></small></div>
    </article>
  );
}
function DeckEmpty({ icon: Icon, text }: { icon: typeof Route; text: string }) {
  return <div className="goalmax-deck-empty"><Icon size={20} /><span>{text}</span></div>;
}
