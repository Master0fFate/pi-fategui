import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeState, SubagentRun } from '../../../shared/contracts/ipc';
import type { AgentTeam } from '../../../shared/contracts/multiAgent';
import type { MutationAttestation } from '../../../shared/contracts/mutationAttestation';
import { useGoalMaxStore } from '../../stores/goalMaxStore';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { ActivityPanel, mergeActivity } from './ActivityPanel';
import { FLIGHT_RECORDER_LIMIT } from './flightDeck';
import { Inspector } from './Inspector';

// jsdom cannot measure Virtuoso; render every row directly and expose the scroll props.
vi.mock('react-virtuoso', async () => {
  const React = await import('react');
  return {
    Virtuoso: (props: Record<string, unknown>) => React.createElement(
      'div',
      {
        className: props.className as string | undefined,
        role: props.role as string | undefined,
        'data-follow-output': typeof props.followOutput === 'string' ? props.followOutput : String(props.followOutput),
        'data-initial-top-most-item-index': props.initialTopMostItemIndex,
      },
      (props.data as readonly unknown[] ?? []).map((item, index) => React.createElement(
        'div',
        { key: typeof props.computeItemKey === 'function' ? (props.computeItemKey as (index: number, item: unknown) => string | number)(index, item) : index },
        (props.itemContent as (index: number, item: unknown) => React.ReactNode)(index, item),
      )),
    ),
  };
});

const model = { provider: 'test', id: 'model', name: 'Model', reasoning: true, contextWindow: 100_000 };

const run: SubagentRun = {
  id: 'subagent-1',
  parentSessionId: 'parent-1',
  parentToolCallId: 'delegate-1',
  task: 'Inspect the runtime and report the event ownership boundary.',
  role: 'scout',
  handle: 'architecture-scout-1',
  displayName: 'Architecture Scout',
  agentName: 'architecture-scout',
  agentSource: 'user',
  permissionLevel: 'read-only',
  enabledTools: ['read', 'grep', 'find', 'ls'],
  skills: ['code-review'], skillMode: 'selected', preloadedSkills: ['code-review'],
  status: 'completed',
  model,
  routingModels: [model],
  thinkingLevel: 'high',
  executionMode: 'managed',
  controlCount: 2, attempt: 1, maxAttempts: 1,
  mailbox: { state: 'available', ttlMs: 300_000, expiresAt: 300_020, followUpCount: 0 },
  notification: 'never', dependsOn: [],
  createdAt: 1,
  startedAt: 2,
  updatedAt: 20,
  endedAt: 20,
  messages: [
    { id: 'task', role: 'user', text: 'Delegated task from the parent agent', timestamp: 3, timelinePosition: 0 },
    { id: 'answer', role: 'assistant', text: '**Boundary confirmed.**', reasoning: 'Trace child events separately.', timestamp: 10, timelinePosition: 2 },
  ],
  tools: [{
    id: 'read-1', name: 'read', input: '{"path":"src/main/pi/PiRuntimeService.ts"}', output: 'source', outputTruncated: false,
    status: 'succeeded', startedAt: 5, updatedAt: 8, endedAt: 8, timelinePosition: 1,
  }],
  result: 'Boundary confirmed.',
  omittedActivity: 0,
  transcriptTruncated: false,
  usage: { input: 120, output: 24, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 144, turns: 1 },
};

const team: AgentTeam = {
  id: 'team-1', rootSessionId: 'parent-1', projectPath: '/project', name: 'Review team', protocolVersion: 2, status: 'active', selected: true, rootNodeId: 'team-root',
  limits: { maxDepth: 2, maxNodes: 16, maxActiveTurns: 3, maxMessages: 256, maxMessageBytes: 32_768 },
  activeTurns: 0, writerNodeId: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  nodes: [
    {
      id: 'team-root', teamId: 'team-1', parentNodeId: null, path: '/root', handle: 'root', displayName: 'Root', depth: 0,
      role: 'root', agentName: 'direct', permissionLevel: 'full-access', enabledTools: ['read'], model: run.model,
      thinkingLevel: 'medium', status: 'ready', childIds: ['team-reviewer'], unreadMessages: 0, writer: false,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, createdAt: 1, updatedAt: 2,
    },
    {
      id: 'team-reviewer', teamId: 'team-1', parentNodeId: 'team-root', path: '/root/reviewer', handle: 'reviewer', displayName: 'Reviewer', depth: 1,
      role: 'reviewer', agentName: 'direct', permissionLevel: 'read-only', enabledTools: ['read'], model: run.model,
      thinkingLevel: 'medium', status: 'ready', currentTaskId: 'team-task', childIds: [], unreadMessages: 0, writer: false,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, createdAt: 1, updatedAt: 2,
    },
  ],
  tasks: [{ id: 'team-task', teamId: 'team-1', assigneeNodeId: 'team-reviewer', requesterNodeId: 'team-root', inputEnvelopeId: 'team-envelope', resultEnvelopeId: 'team-result', summary: 'Review the change', status: 'completed', createdAt: 1, startedAt: 1, endedAt: 4 }],
  envelopes: [
    { id: 'team-envelope', teamId: 'team-1', sequence: 1, kind: 'NEW_TASK', authorNodeId: 'team-root', recipientNodeId: 'team-reviewer', taskId: 'team-task', content: 'Review the change and report concrete risks.', triggerTurn: true, state: 'consumed', createdAt: 1, deliveredAt: 1 },
    { id: 'team-result', teamId: 'team-1', sequence: 2, kind: 'FINAL_ANSWER', authorNodeId: 'team-reviewer', recipientNodeId: 'team-root', taskId: 'team-task', content: '**Review complete.** No blocking risks found.', triggerTurn: false, state: 'consumed', createdAt: 4, deliveredAt: 4 },
  ],
  operationReceipts: [], timeline: [
    { id: 'team-tool-start', sequence: 3, type: 'tool.started', nodeId: 'team-reviewer', taskId: 'team-task', toolCallId: 'team-read', toolName: 'read', summary: '/root/reviewer started read.', timestamp: 2 },
    { id: 'team-tool-end', sequence: 4, type: 'tool.completed', nodeId: 'team-reviewer', taskId: 'team-task', toolCallId: 'team-read', toolName: 'read', summary: '/root/reviewer completed read.', timestamp: 3 },
  ], createdAt: 1, updatedAt: 4,
};

const state: RuntimeState = {
  status: 'ready', project: { path: '/project', name: 'project', trusted: true }, sessionId: 'parent-1', sessionFile: '/sessions/parent.jsonl',
  streaming: false, model, models: [model], thinkingLevel: 'medium',
  messages: [{ id: 'msg-1', role: 'assistant', text: 'Plan recorded.', timestamp: 5 }],
  tools: [
    { id: 'delegate-1', name: 'subagent', input: '{}', output: 'Boundary confirmed.', outputTruncated: false, status: 'succeeded', startedAt: 1, updatedAt: 20, endedAt: 20, subagentRunIds: [run.id] },
    { id: 'edit-1', name: 'edit', input: '{}', output: '', outputTruncated: false, status: 'succeeded', startedAt: 10, updatedAt: 11, endedAt: 11, provenance: { actor: { kind: 'root' }, affectedPaths: [{ path: 'src/app.ts', operation: 'edit' }] } },
  ],
  sessions: [{
    id: 'parent-1', title: 'Runtime boundaries', firstMessage: 'Inspect runtime boundaries', path: '/sessions/parent.jsonl',
    createdAt: '2026-01-01T00:00:00.000Z', modifiedAt: '2026-01-01T00:01:00.000Z', messageCount: 2, active: true,
  }],
  subagents: [run], agentTeams: [team], commands: [], error: null,
};

function attestation(overrides: Partial<MutationAttestation> = {}): MutationAttestation {
  return {
    id: 'rec-1',
    schemaVersion: 1,
    recordedAt: 11,
    projectPathHash: 'a'.repeat(64),
    sessionId: 'parent-1',
    actor: { kind: 'root' },
    permissionLevel: 'edit',
    operation: 'edit',
    path: 'src/app.ts',
    preHash: 'c'.repeat(64),
    postHash: 'b'.repeat(64),
    preState: 'hashed',
    captureKind: 'direct-file-tool',
    ...overrides,
  };
}

function mockQuery(result: { rows: MutationAttestation[]; truncated: boolean }) {
  const queryAttestations = vi.fn(async () => result);
  Object.defineProperty(window, 'piDesktop', { configurable: true, value: { queryAttestations } });
  return queryAttestations;
}

describe('mergeActivity', () => {
  it('joins a ledger record with its retained write/edit tool row into one row', () => {
    const retained: Parameters<typeof mergeActivity>[0] = [{
      id: 'root:edit-1', source: 'root', sourceRank: 0, sourceIndex: 0, timestamp: 10,
      kind: 'tool', title: 'edit', detail: 'Root tool completed', target: { kind: 'tool', toolCallId: 'edit-1' },
      provenance: { actor: { kind: 'root' }, affectedPaths: [{ path: 'src/app.ts', operation: 'edit' }] },
    }];
    const { rows, matchedLedgerIds } = mergeActivity(retained, [attestation()]);
    expect(rows).toHaveLength(1);
    expect(matchedLedgerIds.size).toBe(1);
    expect(rows[0]).toMatchObject({ id: 'root:edit-1', kind: 'write', title: 'edit src/app.ts', target: { kind: 'tool', toolCallId: 'edit-1' } });
    expect(rows[0]!.detail).toContain('cccccccc → bbbbbbbb');
  });

  it('keeps unmatched rows separate instead of pairing them by guesswork', () => {
    const retained: Parameters<typeof mergeActivity>[0] = [{
      id: 'root:edit-1', source: 'root', sourceRank: 0, sourceIndex: 0, timestamp: 10,
      kind: 'tool', title: 'edit', detail: 'Root tool completed', target: { kind: 'tool', toolCallId: 'edit-1' },
      provenance: { actor: { kind: 'root' }, affectedPaths: [{ path: 'src/app.ts', operation: 'edit' }] },
    }];
    // Different path: no join possible.
    const { rows, matchedLedgerIds } = mergeActivity(retained, [attestation({ id: 'other', path: 'src/other.ts' })]);
    expect(matchedLedgerIds.size).toBe(0);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.kind === 'tool')).toBeTruthy();
    expect(rows.find((row) => row.id === 'ledger:other')).toMatchObject({ kind: 'write', rank: 1, source: 'root' });
  });

  it('rejects a join outside the time window even when path and actor match', () => {
    const retained: Parameters<typeof mergeActivity>[0] = [{
      id: 'root:edit-1', source: 'root', sourceRank: 0, sourceIndex: 0, timestamp: 10,
      kind: 'tool', title: 'edit', detail: 'Root tool completed',
      provenance: { actor: { kind: 'root' }, affectedPaths: [{ path: 'src/app.ts', operation: 'edit' }] },
    }];
    const { matchedLedgerIds } = mergeActivity(retained, [attestation({ recordedAt: 10 + 11 * 60_000 })]);
    expect(matchedLedgerIds.size).toBe(0);
  });
});

describe('Activity inspector panel', () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as { piDesktop?: unknown }).piDesktop;
    useUiStore.setState({ flightDeckJump: null, toast: null });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders retained activity from all sources plus ledger rows with the honest disclosure', async () => {
    useRuntimeStore.getState().hydrateRuntime(state);
    mockQuery({ rows: [attestation()], truncated: false });
    render(<ActivityPanel />);

    await waitFor(() => expect(screen.getByText('Activity')).toBeInTheDocument());
    expect(screen.getByText(/Live rows are session memory and are not durable/i)).toBeInTheDocument();
    // Source badges distinguish the three execution origins across merged rows.
    expect(screen.getAllByText('Root').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Legacy').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Team').length).toBeGreaterThanOrEqual(1);
  });

  it('merges a matching attestation with its retained edit into one ledger-tagged row', async () => {
    useRuntimeStore.getState().hydrateRuntime(state);
    mockQuery({ rows: [attestation()], truncated: false });
    render(<ActivityPanel />);

    await waitFor(() => expect(screen.getByText('edit src/app.ts')).toBeInTheDocument());
    // One merged row: the retained tool row is replaced, the hash is inline, and
    // the ledger tag marks it as durable hash-backed, not session memory.
    expect(screen.getAllByText('edit src/app.ts')).toHaveLength(1);
    expect(screen.getByText('ledger')).toBeInTheDocument();
    expect(screen.getByText(/cccccccc → bbbbbbbb/)).toBeInTheDocument();
    expect(screen.getByText(/Main agent · Edit files/)).toBeInTheDocument();
    // The merged row keeps tool navigation.
    expect(screen.getByRole('button', { name: 'Open Root edit: edit src/app.ts' })).toBeInTheDocument();
  });

  it('renders ledger-only rows after a restart when no retained tool row exists', async () => {
    useRuntimeStore.getState().hydrateRuntime(state);
    mockQuery({ rows: [attestation({ id: 'old-1', operation: 'write', path: 'src/old.ts', preState: 'missing', preHash: null })], truncated: false });
    render(<ActivityPanel />);

    await waitFor(() => expect(screen.getByText('write src/old.ts')).toBeInTheDocument());
    expect(screen.getByText(/new file · bbbbbbbb/)).toBeInTheDocument();
    expect(screen.getAllByText('ledger').length).toBeGreaterThanOrEqual(1);
  });

  it('routes clickable retained targets through the flight-deck jump for the current session', async () => {
    const user = userEvent.setup();
    useRuntimeStore.getState().hydrateRuntime(state);
    mockQuery({ rows: [], truncated: false });
    render(<ActivityPanel />);

    const button = await screen.findByRole('button', { name: 'Open Root tool: edit' });
    await user.click(button);

    expect(useUiStore.getState().flightDeckJump).toMatchObject({
      projectPath: '/project', sessionId: 'parent-1', target: { kind: 'tool', toolCallId: 'edit-1' },
    });
  });

  it('keeps rows without retained targets non-actionable and honest', () => {
    useRuntimeStore.getState().hydrateRuntime(state);
    // Push the root conversation event outside the retained window.
    useRuntimeStore.setState({ visibleTimelineIds: new Set() });
    render(<ActivityPanel />);

    expect(screen.getByRole('button', { name: 'Open Root tool: edit' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open Root message/ })).not.toBeInTheDocument();
    expect(screen.getByText(/no longer retained/i)).toBeInTheDocument();
  });

  it('filters with one row of toggles: writes, then source, each released by pressing again', async () => {
    const user = userEvent.setup();
    useRuntimeStore.getState().hydrateRuntime(state);
    mockQuery({ rows: [], truncated: false });
    render(<ActivityPanel />);

    await screen.findByRole('button', { name: 'Open Root tool: edit' });

    const bar = screen.getByRole('group', { name: 'Filter activity' });
    expect(bar).toBeInTheDocument();
    // No "All" chips: four toggles only.
    expect(within(bar).queryByRole('button', { name: 'All' })).not.toBeInTheDocument();

    // Writes: only the retained write/edit tool row remains.
    await user.click(within(bar).getByRole('button', { name: 'Writes' }));
    expect(screen.getByRole('button', { name: 'Open Root tool: edit' })).toBeInTheDocument();
    expect(screen.queryByText(/Agent message/i)).not.toBeInTheDocument();

    // + Legacy source: nothing matches, and the no-match notice is honest.
    await user.click(within(bar).getByRole('button', { name: 'Legacy' }));
    expect(screen.getByText('No rows match these filters.')).toBeInTheDocument();

    // Pressing the pressed source toggle again releases it.
    await user.click(within(bar).getByRole('button', { name: 'Legacy' }));
    expect(screen.getByRole('button', { name: 'Open Root tool: edit' })).toBeInTheDocument();

    // Releasing Writes restores the full list.
    await user.click(within(bar).getByRole('button', { name: 'Writes' }));
    expect(screen.getAllByText(/Agent message/i).length).toBeGreaterThan(0);
  });

  it('keeps the source toggle exclusive and shows a no-match notice when a filter empties the list', async () => {
    const user = userEvent.setup();
    useRuntimeStore.getState().hydrateRuntime(state);
    mockQuery({ rows: [], truncated: false });
    render(<ActivityPanel />);

    await screen.findByRole('button', { name: 'Open Root tool: edit' });
    const bar = screen.getByRole('group', { name: 'Filter activity' });

    // Team source: root rows disappear, team rows stay.
    await user.click(within(bar).getByRole('button', { name: 'Team' }));
    expect(screen.queryByRole('button', { name: 'Open Root tool: edit' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Team').length).toBeGreaterThan(0);

    // Root source replaces Team (exclusive within the source group).
    await user.click(within(bar).getByRole('button', { name: 'Root' }));
    expect(within(bar).getByRole('button', { name: 'Root' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(bar).getByRole('button', { name: 'Team' })).toHaveAttribute('aria-pressed', 'false');

    // Writes + Root on a fixture whose only write is a root edit: still one row.
    await user.click(within(bar).getByRole('button', { name: 'Writes' }));
    expect(screen.getByRole('button', { name: 'Open Root tool: edit' })).toBeInTheDocument();
  });

  it('keeps retained activity visible when no project is open and never calls the ledger', () => {
    useRuntimeStore.getState().hydrateRuntime({ ...state, project: null });
    const queryAttestations = vi.fn(async () => ({ rows: [], truncated: false }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { queryAttestations } });
    render(<ActivityPanel />);

    expect(screen.getByText('No project open — direct-write ledger unavailable.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Root tool: edit' })).toBeInTheDocument();
    expect(queryAttestations).not.toHaveBeenCalled();
    expect(screen.getByText(/ledger —/)).toBeInTheDocument();
  });

  it('hides ledger rows but keeps live rows when the same project is downgraded to untrusted', async () => {
    const project = { path: '/project', name: 'project', trusted: true };
    useRuntimeStore.getState().hydrateRuntime(state);
    const queryAttestations = mockQuery({ rows: [attestation()], truncated: false });
    render(<ActivityPanel />);

    await waitFor(() => expect(screen.getByText('edit src/app.ts')).toBeInTheDocument());
    expect(queryAttestations).toHaveBeenCalledTimes(1);

    useRuntimeStore.getState().hydrateRuntime({ ...state, project: { ...project, trusted: false } });

    await waitFor(() => expect(screen.getByText('Project not trusted — direct-write ledger hidden.')).toBeInTheDocument());
    expect(screen.queryByText('edit src/app.ts')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Root tool: edit' })).toBeInTheDocument();
    expect(queryAttestations).toHaveBeenCalledTimes(1);
  });

  it('surfaces a generic recovery message and never the raw ledger error text', async () => {
    useRuntimeStore.getState().hydrateRuntime(state);
    const queryAttestations = vi.fn(async () => { throw new Error('ledger read failed at /home/user/.pi/fateGUI/attestations'); });
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { queryAttestations } });
    render(<ActivityPanel />);

    await waitFor(() => expect(screen.getByText(/direct-write ledger could not be read/i)).toBeInTheDocument());
    expect(screen.queryByText(/ledger read failed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/fateGUI\/attestations/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Root tool: edit' })).toBeInTheDocument();
    // Retry works and still hides raw errors.
    await waitFor(() => expect(queryAttestations).toHaveBeenCalledTimes(1));
  });

  it('shows ledger loading without hiding retained rows', () => {
    useRuntimeStore.getState().hydrateRuntime(state);
    const queryAttestations = vi.fn(() => new Promise(() => undefined));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { queryAttestations } });
    render(<ActivityPanel />);

    expect(screen.getByText('Loading direct-write ledger…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Root tool: edit' })).toBeInTheDocument();
    expect(screen.getByText(/Live rows are session memory and are not durable/i)).toBeInTheDocument();
  });

  it('refreshes the ledger on demand', async () => {
    const user = userEvent.setup();
    useRuntimeStore.getState().hydrateRuntime(state);
    const queryAttestations = mockQuery({ rows: [attestation()], truncated: false });
    render(<ActivityPanel />);

    await waitFor(() => expect(queryAttestations).toHaveBeenCalledWith({ limit: 1000 }));
    await user.click(screen.getByRole('button', { name: 'Refresh the direct-write ledger' }));
    await waitFor(() => expect(queryAttestations).toHaveBeenCalledTimes(2));
  });

  it('clears the previous project rows when switching to a different trusted project before the new query resolves', async () => {
    useRuntimeStore.getState().hydrateRuntime(state);
    let resolveQuery!: (result: { rows: MutationAttestation[]; truncated: boolean }) => void;
    const queryAttestations = vi.fn(() => new Promise<{ rows: MutationAttestation[]; truncated: boolean }>((resolve) => {
      resolveQuery = resolve;
    }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { queryAttestations } });

    render(<ActivityPanel />);
    await waitFor(() => expect(queryAttestations).toHaveBeenCalledTimes(1));
    resolveQuery({ rows: [attestation({ id: 'a-1', path: 'src/a.ts' })], truncated: false });
    await waitFor(() => expect(screen.getByText('edit src/a.ts')).toBeInTheDocument());

    await act(async () => {
      useRuntimeStore.getState().hydrateRuntime({ ...state, project: { path: '/project-b', name: 'b', trusted: true } });
    });
    expect(screen.queryByText('edit src/a.ts')).not.toBeInTheDocument();
    expect(screen.getByText('Loading direct-write ledger…')).toBeInTheDocument();
    expect(queryAttestations).toHaveBeenCalledTimes(2);

    resolveQuery({ rows: [attestation({ id: 'b-1', path: 'src/b.ts' })], truncated: false });
    await waitFor(() => expect(screen.getByText('edit src/b.ts')).toBeInTheDocument());
    expect(screen.queryByText('edit src/a.ts')).not.toBeInTheDocument();
  });

  it('warns when older live activity is omitted and when the ledger is truncated', async () => {
    const messages = Array.from({ length: 300 }, (_value, index) => ({
      id: `msg-${index}`, role: 'assistant' as const, text: `event ${index}`, timestamp: index,
    }));
    useRuntimeStore.getState().hydrateRuntime({ ...state, messages, tools: [], subagents: [], agentTeams: [] });
    mockQuery({ rows: [attestation({ id: 'x' })], truncated: true });
    render(<ActivityPanel />);

    await waitFor(() => expect(screen.getByText(`More than 1000 direct writes are retained; only the most recent 1000 are shown.`)).toBeInTheDocument());
    expect(screen.getByText(new RegExp(`Older live activity was omitted — only the most recent ${FLIGHT_RECORDER_LIMIT} events are kept.`))).toBeInTheDocument();
    expect(screen.getByText(`live ${FLIGHT_RECORDER_LIMIT} · ledger 1`)).toBeInTheDocument();
  });

  it('shows an explicit empty state when nothing is retained or recorded', () => {
    useRuntimeStore.getState().hydrateRuntime({ ...state, messages: [], tools: [], subagents: [], agentTeams: [] });
    render(<ActivityPanel />);

    expect(screen.getByText('No activity yet')).toBeInTheDocument();
    expect(screen.getByText(/Live rows are session memory and are not durable/i)).toBeInTheDocument();
  });

  it('opens at the newest row and follows new rows only while pinned to the bottom', async () => {
    useRuntimeStore.getState().hydrateRuntime(state);
    mockQuery({ rows: [], truncated: false });
    render(<ActivityPanel />);

    await screen.findByRole('button', { name: 'Open Root tool: edit' });
    const list = document.querySelector('.activity-list');
    expect(list).not.toBeNull();
    expect(list?.getAttribute('data-follow-output')).toBe('auto');
    expect(Number(list?.getAttribute('data-initial-top-most-item-index'))).toBeGreaterThanOrEqual(0);
  });

  it('is reachable as the single Activity tab in the Run destination', async () => {
    const user = userEvent.setup();
    useRuntimeStore.getState().hydrateRuntime(state);
    useGoalMaxStore.setState({ projectPath: '/project', sessionId: 'parent-1', goal: null, loading: false, selectionGeneration: 1 });
    useUiStore.setState({
      inspectorTab: 'changes', inspectorLastViews: { work: 'changes', run: 'activity', system: 'context' }, inspectorCollapsed: false,
    });
    render(<Inspector />);

    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByText('Live rows are session memory and are not durable', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: 'Direct' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Recorder' })).not.toBeInTheDocument();
  });

  it('migrates persisted legacy recorder/attestations tabs to activity', () => {
    expect(useUiStore.persist.getOptions().migrate).toBeTypeOf('function');
    const migrated = (useUiStore.persist.getOptions().migrate as (state: unknown) => unknown)({
      inspectorTab: 'recorder',
      inspectorLastViews: { work: 'changes', run: 'attestations', system: 'context' },
    }) as { inspectorTab: string; inspectorLastViews: { run: string } };
    expect(migrated.inspectorTab).toBe('activity');
    expect(migrated.inspectorLastViews.run).toBe('activity');
  });

  it('never presents rows as causal origin, audit log, or provenance chain wording', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const panel = readFileSync(resolve(here, './ActivityPanel.tsx'), 'utf8').toLowerCase();
    for (const forbidden of ['origin', 'caused by', 'audit log', 'provenance chain']) {
      expect(panel).not.toContain(forbidden);
    }
    const changes = readFileSync(resolve(here, '../diffs/ChangesPanel.tsx'), 'utf8');
    expect(changes.toLowerCase()).not.toContain('recorded origin');
    expect(changes).toContain('Related activity');
  });
});
