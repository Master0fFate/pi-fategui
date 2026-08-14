import {
  Bot,
  CircleAlert,
  Cpu,
  FileText,
  ListChecks,
  Loader2,
  MessagesSquare,
  RefreshCw,
  Send,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { useShallow } from 'zustand/react/shallow';
import type { PermissionLevel } from '../../../shared/contracts/ipc';
import type { AttestationQueryResult, MutationAttestation } from '../../../shared/contracts/mutationAttestation';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import {
  FLIGHT_RECORDER_LIMIT,
  selectFlightRecorder,
  type FlightDeckTarget,
  type FlightRecorderRow,
  type RecorderSources,
} from './flightDeck';

const LEDGER_QUERY_LIMIT = 1000;

/**
 * Mandatory honest scope copy, always rendered and fully readable: live rows are
 * session memory, ledger rows are local unsigned hashes, and neither covers
 * shell, formatters, external edits, diffs, or commits.
 */
const DISCLOSURE = 'Live rows are session memory and are not durable. Ledger rows are local, unsigned direct-write hashes — shell, formatters, external edits, diffs, and commits are not covered.';

/** Generic recovery copy; raw ledger errors are never surfaced (they may name local storage paths). */
const RECOVERY = 'The direct-write ledger could not be read for this project.';

type SourceFilter = 'all' | FlightRecorderRow['source'];

const SOURCE_FILTERS: readonly { value: Exclude<SourceFilter, 'all'>; label: string; title: string }[] = [
  { value: 'root', label: 'Root', title: 'Show only main-agent activity' },
  { value: 'legacy', label: 'Legacy', title: 'Show only legacy subagent activity' },
  { value: 'team', label: 'Team', title: 'Show only Agent Team activity' },
];

const SOURCE_LABEL: Record<FlightRecorderRow['source'], string> = {
  root: 'Root',
  legacy: 'Legacy',
  team: 'Team',
};

const KIND_LABEL: Record<FlightRecorderRow['kind'], string> = {
  tool: 'tool',
  message: 'message',
  error: 'error',
  run: 'agent run',
  task: 'task',
  envelope: 'envelope',
  lifecycle: 'lifecycle event',
};

const PERMISSION_LABEL: Record<PermissionLevel, string> = {
  'read-only': 'Read only',
  edit: 'Edit files',
  'full-access': 'Full access',
};

function permissionLabel(level: PermissionLevel | null): string {
  return level ? PERMISSION_LABEL[level] : 'Unknown permission';
}

function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

/** Honest hash summary: a real transition only when a prior hash was captured. */
function hashSummary(attestation: MutationAttestation): string {
  const post = shortHash(attestation.postHash);
  if (attestation.preState === 'hashed' && attestation.preHash) return `${shortHash(attestation.preHash)} → ${post}`;
  if (attestation.preState === 'oversize') return `oversize prior · ${post}`;
  return `new file · ${post}`;
}

/** Visible actor identity; never only in a tooltip. */
function actorDetail(actor: MutationAttestation['actor']): string {
  switch (actor.kind) {
    case 'root': return 'Main agent';
    case 'legacy': return `Subagent ${actor.runId.slice(0, 8)}`;
    case 'team': {
      const base = `Node ${actor.nodeId.slice(0, 8)}`;
      return actor.taskId ? `${base} · task ${actor.taskId.slice(0, 8)}` : base;
    }
  }
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour12: false });
}

function fullDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function activityKindIcon(kind: FlightRecorderRow['kind'] | 'write'): LucideIcon {
  switch (kind) {
    case 'write': return FileText;
    case 'tool': return Wrench;
    case 'message': return MessagesSquare;
    case 'error': return CircleAlert;
    case 'run': return Bot;
    case 'task': return ListChecks;
    case 'envelope': return Send;
    default: return Cpu;
  }
}

function isWriteRow(row: ActivityRow): boolean {
  // Writes include retained write/edit tool rows without a ledger match (for
  // example in an untrusted project) alongside merged and ledger-only rows.
  return row.kind === 'write' || (row.kind === 'tool' && (row.title === 'write' || row.title === 'edit'));
}

// ---------------------------------------------------------------------------
// Ledger query (trusted-project gated, cross-project safe, manually refreshed).
// ---------------------------------------------------------------------------

type LedgerStatus = 'loading' | 'ready' | 'error';

interface LedgerState {
  status: LedgerStatus;
  result: AttestationQueryResult | null;
  /** The trusted project path the current result belongs to (null until a query settles). */
  projectPath: string | null;
}

const LEDGER_INITIAL: LedgerState = { status: 'loading', result: null, projectPath: null };

function useAttestationLedger(projectPath: string | null, trusted: boolean) {
  const [state, setState] = useState<LedgerState>(LEDGER_INITIAL);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const refresh = useCallback(() => setRefreshNonce((value) => value + 1), []);

  useEffect(() => {
    // The ledger is queried only for a TRUSTED project. A same-path trust
    // downgrade re-runs this effect (trusted is a dependency) and clears any
    // rows loaded while trusted. A different trusted project must never briefly
    // show the previous project's rows: it clears to a loading state keyed to
    // the new path. A same-project refresh keeps the previous rows visible.
    if (!projectPath || !trusted) {
      setState({ status: 'ready', result: { rows: [], truncated: false }, projectPath });
      return;
    }
    let cancelled = false;
    setState((previous) => (previous.projectPath === projectPath && previous.status === 'ready' && previous.result
      ? previous
      : { status: 'loading', result: null, projectPath }));
    void (async () => {
      try {
        const result = await window.piDesktop.queryAttestations({ limit: LEDGER_QUERY_LIMIT });
        if (!cancelled) setState({ status: 'ready', result, projectPath });
      } catch {
        if (!cancelled) setState({ status: 'error', result: null, projectPath });
      }
    })();
    return () => { cancelled = true; };
  }, [projectPath, trusted, refreshNonce]);

  // State carries its own projectPath so stale rows are never rendered for a
  // different project, even before the effect clears them.
  const current = state.projectPath === projectPath;
  const usable = current && state.status === 'ready' ? state.result : null;
  return {
    status: current ? state.status : ('loading' as LedgerStatus),
    rows: usable?.rows ?? [],
    truncated: usable?.truncated ?? false,
    refresh,
  };
}

// ---------------------------------------------------------------------------
// Merge: retained write/edit tool rows are joined with their ledger record into
// one row. The join is a bounded heuristic (actor + path + operation + time
// window), never a claimed causal identity.
// ---------------------------------------------------------------------------

const MATCH_WINDOW_MS = 10 * 60_000;

interface LedgerInfo {
  operation: 'write' | 'edit';
  path: string;
  detail: string;
}

export interface ActivityRow {
  id: string;
  timestamp: number;
  source: FlightRecorderRow['source'];
  /** Ledger-only rows sort after retained rows at the same timestamp. */
  rank: number;
  kind: FlightRecorderRow['kind'] | 'write';
  title: string;
  detail: string;
  target?: FlightDeckTarget;
  ledger?: LedgerInfo;
}

function retainedActorKey(source: FlightRecorderRow['source'], target: FlightDeckTarget | undefined): string | null {
  if (source === 'root') return 'root';
  if (!target) return null;
  if (source === 'legacy' && target.kind === 'agent') return `legacy:${target.runId}`;
  if (source === 'team' && target.kind === 'team-node') return `team:${target.nodeId}`;
  return null;
}

function attestationActorKey(actor: MutationAttestation['actor']): string {
  if (actor.kind === 'root') return 'root';
  if (actor.kind === 'legacy') return `legacy:${actor.runId}`;
  return `team:${actor.nodeId}`;
}

export interface ActivityMerge {
  rows: ActivityRow[];
  matchedLedgerIds: Set<string>;
}

export function mergeActivity(retained: readonly FlightRecorderRow[], attestations: readonly MutationAttestation[]): ActivityMerge {
  // Greedy one-to-one join: for each attestation, the closest unused retained
  // write/edit tool row with the same actor, path, and operation inside the
  // time window. Each row pairs with at most one ledger record and vice versa.
  const candidates = retained
    .filter((row) => row.kind === 'tool' && (row.title === 'write' || row.title === 'edit'))
    .map((row) => ({ row, actorKey: retainedActorKey(row.source, row.target), used: false }));
  const ledgerIdByRowId = new Map<string, string>();
  const matchedLedgerIds = new Set<string>();
  for (const attestation of attestations) {
    const actorKey = attestationActorKey(attestation.actor);
    let best: (typeof candidates)[number] | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      if (candidate.used || candidate.actorKey !== actorKey || candidate.row.title !== attestation.operation) continue;
      const touchesPath = candidate.row.provenance?.affectedPaths.some(
        (reference) => reference.operation === attestation.operation && reference.path === attestation.path,
      );
      if (!touchesPath) continue;
      const delta = Math.abs(candidate.row.timestamp - attestation.recordedAt);
      if (delta <= MATCH_WINDOW_MS && delta < bestDelta) {
        best = candidate;
        bestDelta = delta;
      }
    }
    if (best) {
      best.used = true;
      matchedLedgerIds.add(attestation.id);
      ledgerIdByRowId.set(best.row.id, attestation.id);
    }
  }

  const attestationById = new Map(attestations.map((attestation) => [attestation.id, attestation]));
  const rows: ActivityRow[] = retained.flatMap((row): ActivityRow[] => {
    const attestationId = ledgerIdByRowId.get(row.id);
    const attestation = attestationId ? attestationById.get(attestationId) : undefined;
    if (attestation) {
      const detail = `${actorDetail(attestation.actor)} · ${permissionLabel(attestation.permissionLevel)} · ${hashSummary(attestation)}`;
      return [{
        id: row.id,
        timestamp: row.timestamp,
        source: row.source,
        rank: 0,
        kind: 'write',
        title: `${attestation.operation} ${attestation.path}`,
        detail,
        ...(row.target ? { target: row.target } : {}),
        ledger: { operation: attestation.operation, path: attestation.path, detail },
      }];
    }
    return [{
      id: row.id,
      timestamp: row.timestamp,
      source: row.source,
      rank: 0,
      kind: row.kind,
      title: row.title,
      detail: row.detail,
      ...(row.target ? { target: row.target } : {}),
    }];
  });
  for (const attestation of attestations) {
    if (matchedLedgerIds.has(attestation.id)) continue;
    rows.push({
      id: `ledger:${attestation.id}`,
      timestamp: attestation.recordedAt,
      source: attestation.actor.kind,
      rank: 1,
      kind: 'write',
      title: `${attestation.operation} ${attestation.path}`,
      detail: `${actorDetail(attestation.actor)} · ${permissionLabel(attestation.permissionLevel)} · ${hashSummary(attestation)}`,
      ledger: { operation: attestation.operation, path: attestation.path, detail: '' },
    });
  }
  rows.sort((left, right) => left.timestamp - right.timestamp || left.rank - right.rank || left.id.localeCompare(right.id));
  return { rows, matchedLedgerIds };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function ActivityRowView({ row, onOpen }: { row: ActivityRow; onOpen: (target: FlightDeckTarget) => void }) {
  const Icon = activityKindIcon(row.kind);
  const sourceLabel = SOURCE_LABEL[row.source];
  const ledger = row.ledger ? <span className="activity-tag">ledger</span> : null;
  const body = (
    <>
      <span className={`activity-source activity-source--${row.source}`}>{sourceLabel}</span>
      <span className="activity-kind"><Icon size={12} aria-hidden="true" /></span>
      <span className="activity-text">
        <strong>{row.title}</strong>
        <small>{ledger}{ledger ? ` · ` : ''}{row.detail}</small>
      </span>
      <time className="activity-time" dateTime={new Date(row.timestamp).toISOString()} title={fullDateTime(row.timestamp)}>{formatClock(row.timestamp)}</time>
    </>
  );
  const summary = `${sourceLabel} ${row.kind === 'write' ? `${row.ledger?.operation ?? 'write'} (ledger-backed)` : KIND_LABEL[row.kind]} · ${row.title} · ${row.detail}`;
  if (row.target) {
    const kindLabel = row.kind === 'write' ? `${row.ledger?.operation ?? 'write'}` : KIND_LABEL[row.kind];
    return (
      <button
        type="button"
        className="activity-row"
        data-clickable="true"
        data-source={row.source}
        data-kind={row.kind}
        title={summary}
        aria-label={`Open ${sourceLabel} ${kindLabel}: ${row.title}`}
        onClick={() => onOpen(row.target!)}
      >
        {body}
      </button>
    );
  }
  return (
    <div className="activity-row" data-clickable="false" data-source={row.source} data-kind={row.kind} title={summary} role="listitem">
      {body}
    </div>
  );
}

function FilterBar({ source, writesOnly, onSource, onWrites }: {
  source: SourceFilter;
  writesOnly: boolean;
  onSource: (value: SourceFilter) => void;
  onWrites: (value: boolean) => void;
}) {
  // One row, four toggles, no "All" chips: nothing pressed shows everything;
  // pressing a pressed toggle releases it. Kind (Writes) and source combine.
  return (
    <div className="activity-filters" role="group" aria-label="Filter activity" title="No toggle selected shows everything">
      <button
        type="button"
        className="activity-chip"
        aria-pressed={writesOnly}
        title="Show only write/edit rows"
        onClick={() => onWrites(!writesOnly)}
      >
        Writes
      </button>
      <span className="activity-filter-sep" aria-hidden="true" />
      {SOURCE_FILTERS.map((option) => (
        <button
          key={option.value}
          type="button"
          className="activity-chip"
          aria-pressed={source === option.value}
          title={option.title}
          onClick={() => onSource(source === option.value ? 'all' : option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ledgerStatusLine(status: LedgerStatus, projectPath: string | null, trusted: boolean, refresh: () => void): ReactNode {
  if (!projectPath) {
    return (
      <div className="activity-status" role="status">
        <span>No project open — direct-write ledger unavailable.</span>
      </div>
    );
  }
  if (!trusted) {
    return (
      <div className="activity-status" role="status">
        <span>Project not trusted — direct-write ledger hidden.</span>
      </div>
    );
  }
  if (status === 'loading') {
    return (
      <div className="activity-status" role="status" aria-live="polite">
        <Loader2 size={11} className="activity-spinner" aria-hidden="true" />
        <span>Loading direct-write ledger…</span>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="activity-status activity-status--error" role="alert">
        <CircleAlert size={11} aria-hidden="true" />
        <span>{RECOVERY}</span>
        <button type="button" className="activity-refresh" onClick={refresh} aria-label="Retry loading the direct-write ledger">
          <RefreshCw size={11} aria-hidden="true" /> Retry
        </button>
      </div>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function ActivityPanel() {
  const project = useRuntimeStore((state) => state.runtime.project);
  const projectPath = project?.path ?? null;
  const trusted = project?.trusted ?? false;
  const sessionId = useRuntimeStore((state) => state.runtime.sessionId);
  const timelineOrder = useRuntimeStore((state) => state.timelineOrder);
  const reactive = useRuntimeStore(useShallow((state) => ({
    messagesVersion: state.messagesVersion,
    reasoningVersion: state.reasoningVersion,
    timelineVersion: state.timelineVersion,
    toolsVersion: state.toolsVersion,
    subagentOrder: state.subagentOrder,
    subagentRecorderVersion: state.subagentRecorderVersion,
    agentTeamOrder: state.agentTeamOrder,
    agentTeamsById: state.agentTeamsById,
  })));
  const requestFlightDeckJump = useUiStore((state) => state.requestFlightDeckJump);

  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [writesOnly, setWritesOnly] = useState(false);

  const sources = useMemo((): RecorderSources => {
    const { timelineById, messagesById, reasoningByMessageId, toolsById, visibleTimelineIds, subagentsById } = useRuntimeStore.getState();
    const subagents = reactive.subagentOrder.flatMap((id) => subagentsById[id] ? [subagentsById[id]!] : []);
    const teams = reactive.agentTeamOrder.flatMap((id) => reactive.agentTeamsById[id] ? [reactive.agentTeamsById[id]!] : []);
    return { timelineOrder, timelineById, messagesById, toolsById, subagents, teams, reasoningByMessageId, visibleTimelineIds };
  }, [reactive, timelineOrder]);

  const projection = useMemo(() => selectFlightRecorder(sources), [sources]);
  const ledger = useAttestationLedger(projectPath, trusted);

  const merged = useMemo(() => mergeActivity(projection.rows, ledger.rows), [projection.rows, ledger.rows]);
  const filtered = useMemo(() => merged.rows.filter((row) =>
    (sourceFilter === 'all' || row.source === sourceFilter) && (!writesOnly || isWriteRow(row))), [merged.rows, sourceFilter, writesOnly]);

  const openTarget = (target: FlightDeckTarget) => {
    if (!projectPath || !sessionId) return;
    requestFlightDeckJump(projectPath, sessionId, target);
  };

  const liveCount = projection.rows.length;
  const ledgerCount = ledger.rows.length;
  const ledgerAvailable = Boolean(projectPath && trusted);
  const status = ledgerStatusLine(ledger.status, projectPath, trusted, ledger.refresh);

  if (merged.rows.length === 0) {
    return (
      <section className="activity-panel" aria-label="Activity">
        <ActivityHead live={0} ledger={0} ledgerAvailable={ledgerAvailable} />
        <p className="activity-disclosure">{DISCLOSURE}</p>
        {status}
        <div className="inspector-empty activity-status" role="status">
          <ListChecks size={24} aria-hidden="true" />
          <strong>No activity yet</strong>
          <p>Live events from this session and direct-write hash records for a trusted project appear here.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="activity-panel" aria-label="Activity">
      <ActivityHead live={liveCount} ledger={ledgerCount} ledgerAvailable={ledgerAvailable} onRefresh={ledgerAvailable ? ledger.refresh : undefined} />
      <p className="activity-disclosure">{DISCLOSURE}</p>
      <FilterBar source={sourceFilter} writesOnly={writesOnly} onSource={setSourceFilter} onWrites={setWritesOnly} />
      {status}
      {projection.omitted ? (
        <div className="activity-bounded" role="status">
          <TriangleAlert size={12} aria-hidden="true" />
          <span>Older live activity was omitted — only the most recent {FLIGHT_RECORDER_LIMIT} events are kept.</span>
        </div>
      ) : null}
      {ledger.truncated ? (
        <div className="activity-bounded" role="status">
          <TriangleAlert size={12} aria-hidden="true" />
          <span>More than {LEDGER_QUERY_LIMIT} direct writes are retained; only the most recent {LEDGER_QUERY_LIMIT} are shown.</span>
        </div>
      ) : null}
      {filtered.length === 0 ? (
        <div className="activity-status" role="status">
          <span>No rows match these filters.</span>
        </div>
      ) : (
        <Virtuoso
          className="activity-list"
          data={filtered}
          role="list"
          initialTopMostItemIndex={Math.max(0, filtered.length - 1)}
          followOutput="auto"
          computeItemKey={(_index, row) => row.id}
          itemContent={(_index, row) => <ActivityRowView row={row} onOpen={openTarget} />}
        />
      )}
    </section>
  );
}

function ActivityHead({ live, ledger, ledgerAvailable, onRefresh }: {
  live: number;
  ledger: number;
  ledgerAvailable: boolean;
  onRefresh?: (() => void) | undefined;
}) {
  return (
    <div className="activity-head">
      <strong>Activity</strong>
      <span className="activity-counts" title="live = retained session events · ledger = direct-write hash records">
        live {live} · ledger {ledgerAvailable ? ledger : '—'}
      </span>
      {onRefresh ? (
        <button type="button" className="activity-refresh" onClick={onRefresh} aria-label="Refresh the direct-write ledger">
          <RefreshCw size={11} aria-hidden="true" /> Refresh
        </button>
      ) : null}
    </div>
  );
}
