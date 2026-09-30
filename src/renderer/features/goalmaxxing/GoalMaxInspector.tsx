import { getFateApi, getFateApiOptional, getWebApiOptional } from '../../platform/api';
import { canMutateNetwork, currentNetworkScope, useRuntimeStore } from '../../stores/runtimeStore';
import type { WireResultOf } from '../../../shared/protocol/methods';
import * as Tabs from '@radix-ui/react-tabs';
import { Check, CircleAlert, Clock3, Gauge, ListChecks, LoaderCircle, MessagesSquare, Pause, Play, RefreshCw, Route, ShieldCheck, Target, TestTube2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import './networkFocus.css';
import { Virtuoso } from 'react-virtuoso';
import type { GoalMaxCriterion, GoalMaxEvidence, GoalMaxState, GoalMaxTimelineEvent } from '../../../shared/contracts/goalmaxxing';
import { selectGoalView, useGoalMaxStore } from '../../stores/goalMaxStore';
import { useUiStore } from '../../stores/uiStore';
import { goalMaxStatusLabel } from './goalMaxPresentation';
import { useSkinComponents } from '../../skins/SkinProvider';
import { draftScopeKey, useScopedDraft } from './scopedDraft';
const objectiveDrafts = new Map<string, string>();

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
  if (type === 'goal.blocked' || type === 'goal.cancelled' || type === 'budget.reached') return { Icon: CircleAlert, label, tone: 'danger' } as const;
  if (type === 'verification.failed') return { Icon: RefreshCw, label: 'Verification returned follow-up work', tone: 'active' } as const;
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
  const { ActionContent, Symbol } = useSkinComponents();
  const source = useRuntimeStore((state) => state.source);
  const phase = useRuntimeStore((state) => state.phase);
  const networkBusy = useRuntimeStore((state) => state.networkBusy);
  const web = getWebApiOptional();
  const goal = useGoalMaxStore((state) => selectGoalView(state, source));
  const network = useGoalMaxStore((state) => state.network);
  const navigation = useRuntimeStore((state) => state.networkNavigation);
  const target = navigation && navigation.scopeKey === currentNetworkScope()?.key ? navigation.target : null;
  const focusCriterionId = target?.kind === 'goal-criterion' && goal?.id === target.goalId
    && goal.criteria.some((criterion) => criterion.id === target.criterionId) ? target.criterionId : null;
  const [tab, setTab] = useState<'overview' | 'criteria' | 'evidence' | 'timeline'>('overview');
  useEffect(() => { if (focusCriterionId) setTab('criteria'); }, [focusCriterionId]);
  const objectiveKey = draftScopeKey(web);
  const [objective, setObjective, dropObjective] = useScopedDraft(objectiveDrafts, objectiveKey, () => '');
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
    if (!goal || busy) return;
    if (web) { await useRuntimeStore.getState().runNetworkMutation(web, 'goal.control', (scope) => web.controlGoal(scope, { action })); return; }
    if (!getFateApiOptional() || typeof getFateApiOptional()?.controlGoalMax !== 'function') return;
    setBusy(action);
    try { setGoal(await getFateApi().controlGoalMax({ action })); }
    catch (error) { showToast({ kind: 'error', title: action === 'verify' ? 'Verification failed to start' : 'Checkpoint failed', message: error instanceof Error ? error.message : 'Try again after the current operation settles.' }); }
    finally { setBusy(null); }
  };
  const create = async () => {
    if (!web || !objective.trim() || objectiveKey !== draftScopeKey(web)) return;
    const ok = await useRuntimeStore.getState().runNetworkMutation(web, 'goal.control', (scope) => web.createGoal(scope, {
      objective: objective.trim(), verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null,
    }));
    if (ok) { if (objectiveKey === draftScopeKey(web)) setObjective(''); dropObjective(); }
  };
  if (source === 'network' && (phase !== 'observing' || network.status !== 'ready')) return <section aria-label="Host goal details"><p role="status">{phase !== 'observing' ? 'Goal is not current; host work may continue.' : network.status === 'loading' ? 'Reading goal…' : 'Goal read unavailable. Refresh this workspace.'}</p></section>;
  if (!goal) {
    return <div className="inspector-empty goalmax-empty" aria-label={web ? 'Host goal details' : undefined}><Target size={24} /><strong>{loading ? 'Loading goal…' : 'No active goal'}</strong>
      {web ? <form onSubmit={(event) => { event.preventDefault(); void create(); }}><label>Goal objective<textarea maxLength={200_000} value={objective} onChange={(event) => setObjective(event.target.value)} /></label>
        <p>Normal verification, automatic agents, no admission budget selected. Host policy still applies; a running goal can incur provider cost.</p>
        <button type="submit" disabled={!objective.trim() || !canMutateNetwork(web, 'goal.control')}>Create goal</button></form>
        : <p>Start one with /goalmax followed by an objective.</p>}</div>;
  }
  const required = goal.criteria.filter((criterion) => criterion.required && criterion.status !== 'waived');
  const satisfied = required.filter((criterion) => criterion.status === 'satisfied').length;
  const desktopGoal = 'childAssignments' in goal ? goal : null;
  const activeAssignments = desktopGoal?.childAssignments.filter((assignment) => assignment.status === 'running' || assignment.status === 'pending').length;
  const agentPolicy = desktopGoal?.agentStrategy === 'off' ? 'root only' : desktopGoal?.agentStrategy === 'read-only' ? 'read-only agents' : 'automatic agents';
  const controlDisabled = Boolean(busy) || networkBusy || Boolean(web && !canMutateNetwork(web, 'goal.control'));
  return (
    <section className="goalmax-flight-deck" aria-label={web ? 'Host goal details' : 'Goal Flight Deck'}>
      <header className="goalmax-deck-header" data-status={goal.status}>
        <span className="goalmax-deck-mark"><Symbol text=">"><Target size={15} /></Symbol></span>
        <span><strong>{goalMaxStatusLabel(goal.status)}</strong><small>{goal.phase} · revision {goal.revision}</small></span>
        <div>
          <button type="button" aria-label="Checkpoint" disabled={controlDisabled || goal.status === 'completed' || goal.status === 'cancelled'} onClick={() => void control('checkpoint')}><ActionContent text={busy === 'checkpoint' ? 'wait' : 'checkpoint'}>{busy === 'checkpoint' ? <LoaderCircle className="tool-spinner" size={12} /> : <Gauge size={12} />}<span>Checkpoint</span></ActionContent></button>
          <button type="button" aria-label="Verify" disabled={controlDisabled || goal.status === 'completed' || goal.status === 'cancelled'} onClick={() => void control('verify')}><ActionContent text={busy === 'verify' ? 'wait' : 'verify'}>{busy === 'verify' ? <LoaderCircle className="tool-spinner" size={12} /> : <TestTube2 size={12} />}<span>Verify</span></ActionContent></button>
        </div>
      </header>
      <Tabs.Root value={tab} onValueChange={(value) => { if (value === 'overview' || value === 'criteria' || value === 'evidence' || value === 'timeline') setTab(value); }} className="goalmax-deck-tabs">
        <Tabs.List aria-label="Goal Flight Deck views"><Tabs.Trigger value="overview">Overview</Tabs.Trigger><Tabs.Trigger value="criteria">Criteria <span>{satisfied}/{required.length}</span></Tabs.Trigger><Tabs.Trigger value="evidence">Evidence</Tabs.Trigger><Tabs.Trigger value="timeline">Timeline</Tabs.Trigger></Tabs.List>
        <Tabs.Content value="overview" className="goalmax-deck-content">
          <section className="goalmax-objective"><span>Objective</span><p>{goal.objective}</p></section>
          {desktopGoal?.blockedReason ? <section className="goalmax-blocker" role="status"><CircleAlert size={14} /><span><strong>Needs attention</strong>{desktopGoal.blockedReason}</span></section> : null}
          {'continuationPending' in goal && goal.continuationPending && <p>Continuation pending on host. This can continue after client loss.</p>}
          <dl className="goalmax-overview-facts">
            <div><dt>Criteria</dt><dd>{satisfied}/{required.length}</dd></div>
            {desktopGoal ? <><div><dt>Agents</dt><dd>{activeAssignments ? `${activeAssignments} active` : `${desktopGoal.childAssignments.length} linked`}</dd></div>
            <div><dt>Tokens</dt><dd>{compactNumber(desktopGoal.tokensUsed)}</dd></div>
            <div><dt>Elapsed</dt><dd>{duration(desktopGoal.elapsedMs + (desktopGoal.startedAt && desktopGoal.status !== 'completed' && desktopGoal.status !== 'cancelled' ? Math.max(0, now - desktopGoal.updatedAt) : 0))}</dd></div></> : <div><dt>Execution</dt><dd>{goal.executionState}</dd></div>}
          </dl>
          {desktopGoal ? <><section className="goalmax-policy"><ShieldCheck size={13} /><span><strong>{desktopGoal.permission.permissionLevel} · {agentPolicy}</strong><small>{desktopGoal.verificationLevel} verification · {desktopGoal.permission.projectTrusted ? 'trusted project' : 'untrusted project'} · policy r{desktopGoal.permission.revision}</small></span></section>
          <section className="goalmax-progress-ledger"><span>Progress</span><dl><div><dt>Meaningful turns</dt><dd>{desktopGoal.progress.meaningfulTurnCount}</dd></div><div><dt>Stalled</dt><dd>{desktopGoal.progress.noProgressTurnCount}</dd></div><div><dt>Steering</dt><dd>{desktopGoal.steering.length}</dd></div><div><dt>Changed files</dt><dd>{desktopGoal.progress.changedFileCount}</dd></div><div><dt>Continuations</dt><dd>{desktopGoal.continuation.attempt}</dd></div></dl></section>
          <button className="goalmax-agents-link" type="button" onClick={openAgents}><Symbol text=">"><MessagesSquare size={13} /></Symbol><span>Open linked agents</span><em>{desktopGoal.childAssignments.length}</em></button></> : <p>Bounded host view. Detailed budgets, permission policy, telemetry and evidence content are not included; no completion is inferred.</p>}
        </Tabs.Content>
        <Tabs.Content value="criteria" className="goalmax-deck-content goalmax-criteria-list">
          {goal.criteria.map((criterion) => <CriterionRow key={criterion.id} criterion={criterion} focused={focusCriterionId === criterion.id} {...(desktopGoal ? { assignments: desktopGoal.childAssignments } : {})} />)}
        </Tabs.Content>
        <Tabs.Content value="evidence" className="goalmax-deck-content goalmax-virtual-list">
          {goal.evidence.length ? <Virtuoso data={[...goal.evidence].reverse()} computeItemKey={(_index, evidence) => evidence.id} itemContent={(_index, evidence) => <EvidenceRow evidence={evidence} />} /> : <DeckEmpty icon={ListChecks} text="No evidence recorded" />}
        </Tabs.Content>
        <Tabs.Content value="timeline" className="goalmax-deck-content goalmax-virtual-list">
          {desktopGoal ? desktopGoal.timeline.length ? <Virtuoso data={desktopGoal.timeline} computeItemKey={(_index, event) => event.id} initialTopMostItemIndex={{ index: 'LAST', align: 'end', behavior: 'auto' }} followOutput="auto" itemContent={(index, event) => <TimelineRow event={event} first={index === 0} last={index === desktopGoal.timeline.length - 1} />} /> : <DeckEmpty icon={Route} text="No lifecycle events" /> : <p>Lifecycle history is not included in this bounded read.</p>}
        </Tabs.Content>
      </Tabs.Root>
    </section>
  );
}

function CriterionRow({ criterion, assignments, focused = false }: { criterion: GoalMaxCriterion; assignments?: GoalMaxState['childAssignments']; focused?: boolean }) {
  const { Symbol } = useSkinComponents();
  const rowRef = useRef<HTMLElement>(null);
  useEffect(() => { if (focused) { rowRef.current?.focus({ preventScroll: true }); rowRef.current?.scrollIntoView?.({ block: 'nearest' }); } }, [focused]);
  const owners = assignments ? criterion.ownerNodeIds.flatMap((nodeId) => assignments.find((assignment) => assignment.nodeId === nodeId)?.label ?? []).join(', ') : 'Owner details omitted';
  return <article ref={rowRef} tabIndex={-1} className="goalmax-criterion-row" data-criterion-id={criterion.id} data-network-criterion-id={criterion.id}
    data-network-focus={focused || undefined} aria-current={focused || undefined} data-status={criterion.status}><span><Symbol text={criterion.status === 'satisfied' ? '[x]' : criterion.status === 'failed' ? '[!]' : criterion.status === 'active' ? '[>]' : '[ ]'}>{criterionIcon(criterion.status)}</Symbol></span><div><strong>{criterion.title}</strong>{focused && <small className="network-focus-label">Selected from Monitor</small>}{criterion.description && criterion.description !== criterion.title ? <p>{criterion.description}</p> : null}<small>{owners || `${criterion.evidenceIds.length} evidence`}</small></div><em>{criterion.status}</em></article>;
}
function EvidenceRow({ evidence }: { evidence: GoalMaxEvidence | NonNullable<WireResultOf<'goal.get'>['goal']>['evidence'][number] }) {
  return <article className="goalmax-evidence-row" data-current={evidence.current}><span>{evidence.kind}</span><div><strong>{'title' in evidence ? evidence.title : evidence.id}</strong><small>{new Date(evidence.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{'exitCode' in evidence && evidence.exitCode !== undefined ? ` · exit ${evidence.exitCode}` : ''} · {evidence.current ? 'current' : 'not current'}</small>{'summary' in evidence && evidence.summary ? <details><summary>Details</summary><pre>{evidence.summary}</pre></details> : null}</div></article>;
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
