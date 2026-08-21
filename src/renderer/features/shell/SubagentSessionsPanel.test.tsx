import { act, render, screen, waitFor, within } from '@testing-library/react';
import { Profiler } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeState, SubagentRun } from '../../../shared/contracts/ipc';
import type { AgentTeam } from '../../../shared/contracts/multiAgent';
import { useGoalMaxStore } from '../../stores/goalMaxStore';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { ToolCard } from '../chat/ToolCard';
import { Inspector } from './Inspector';
import { SubagentSessionsPanel } from './SubagentSessionsPanel';

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
  model: { provider: 'test', id: 'model', name: 'Model', reasoning: true, contextWindow: 100_000 },
  routingModels: [{ provider: 'test', id: 'model', name: 'Model', reasoning: true, contextWindow: 100_000 }],
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
  streaming: false, model: run.model, models: [run.model], thinkingLevel: 'medium', messages: [],
  tools: [{
    id: 'delegate-1', name: 'subagent', input: '{"task":"Inspect"}', output: 'Boundary confirmed.', outputTruncated: false,
    status: 'succeeded', startedAt: 1, updatedAt: 20, endedAt: 20, subagentRunIds: [run.id],
  }],
  sessions: [{
    id: 'parent-1', title: 'Runtime boundaries', firstMessage: 'Inspect runtime boundaries', path: '/sessions/parent.jsonl',
    createdAt: '2026-01-01T00:00:00.000Z', modifiedAt: '2026-01-01T00:01:00.000Z', messageCount: 2, active: true,
  }],
  subagents: [run], commands: [], error: null,
};

async function openAgentsInspector(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^Run(?:,|$)/u }));
  await user.click(screen.getByRole('tab', { name: /^Subagent sessions/u }));
}

describe('subagent session inspector', () => {
  beforeEach(() => {
    localStorage.clear();
    useRuntimeStore.getState().hydrateRuntime(state);
    useGoalMaxStore.setState({ projectPath: '/project', sessionId: 'parent-1', goal: null, loading: false, selectionGeneration: 1 });
    useUiStore.setState({
      inspectorTab: 'changes', inspectorLastViews: { work: 'changes', run: 'goal', system: 'context' },
      selectedAgent: null, inspectorCollapsed: false, flightDeckJump: null, toast: null,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'piDesktop');
  });

  it('shows only the active destination views and keeps agent counts at the Run entry', async () => {
    const user = userEvent.setup();
    render(<Inspector onCollapse={vi.fn()} />);

    expect(screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'))).toEqual(['Changes', 'Files']);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'))).toEqual(['Goal', 'Subagent sessions', 'Tools', 'Activity']);
    expect(screen.queryByRole('tab', { name: 'Changes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Resources' })).not.toBeInTheDocument();
  });

  it('marks goal-owned agents and exposes their assignment scope without duplicating the Flight Deck', async () => {
    const user = userEvent.setup();
    useGoalMaxStore.setState({
      goal: {
        criteria: [{ id: 'criterion-auth', title: 'Verify the authentication boundary' }],
        childAssignments: [{
          id: 'assignment-auth', goalId: 'goal-1', nodeId: run.id, label: 'Architecture Scout', lane: 'research',
          objective: run.task, criterionIds: ['criterion-auth'], evidenceIds: ['evidence-auth'], status: 'completed',
        }],
      } as never,
    });
    render(<SubagentSessionsPanel />);

    expect(screen.getByLabelText('Goal-linked research agent · 1 criterion · 1 evidence')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open Architecture Scout (@architecture-scout-1) child session: Completed' }));

    const scope = screen.getByRole('region', { name: 'Goal assignment' });
    expect(within(scope).getByText('research lane')).toBeVisible();
    expect(within(scope).getByText('1 criterion · 1 evidence')).toBeVisible();
  });

  it('does not rerender the Agents tree for unrelated goal usage updates', () => {
    const stableCriteria = [{ id: 'criterion-auth', title: 'Verify the authentication boundary' }];
    const stableAssignments = [{ nodeId: run.id, criterionIds: ['criterion-auth'], evidenceIds: [], lane: 'research' }];
    useGoalMaxStore.setState({ goal: { id: 'goal-1', criteria: stableCriteria, childAssignments: stableAssignments, tokensUsed: 1 } as never });
    const onRender = vi.fn();
    render(<Profiler id="agents" onRender={onRender}><SubagentSessionsPanel /></Profiler>);
    const initialRenders = onRender.mock.calls.length;

    act(() => useGoalMaxStore.setState({ goal: { id: 'goal-1', criteria: stableCriteria, childAssignments: stableAssignments, tokensUsed: 2 } as never }));

    expect(onRender).toHaveBeenCalledTimes(initialRenders);
  });

  it('does not repaint collapsed agent rows for hidden transcript tokens', async () => {
    const onRender = vi.fn();
    render(<Profiler id="agents" onRender={onRender}><SubagentSessionsPanel /></Profiler>);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    const initialRenders = onRender.mock.calls.length;
    const recorderVersion = useRuntimeStore.getState().subagentRecorderVersion;

    act(() => useRuntimeStore.getState().applyEvents([{
      type: 'subagent.event', runId: run.id, timestamp: 30,
      event: { type: 'assistant.text', messageId: 'answer', delta: ' hidden token', timestamp: 30 },
    }]));

    expect(onRender).toHaveBeenCalledTimes(initialRenders);
    expect(useRuntimeStore.getState().subagentRecorderVersion).toBe(recorderVersion);
    expect(useRuntimeStore.getState().subagentsById[run.id]?.messages).toContainEqual(expect.objectContaining({ id: 'answer', text: '**Boundary confirmed.** hidden token' }));
  });

  it('renders and announces an explicitly requested ten-agent team', async () => {
    const user = userEvent.setup();
    useRuntimeStore.getState().hydrateRuntime({
      ...state,
      subagents: Array.from({ length: 10 }, (_value, index) => ({
        ...run, id: `subagent-${index + 1}`, handle: `worker-${index + 1}`, displayName: `Worker ${index + 1}`, agentName: 'direct',
        status: 'running', endedAt: undefined, updatedAt: 25 + index,
      })),
    });
    render(<Inspector onCollapse={vi.fn()} />);

    await openAgentsInspector(user);
    expect(screen.getByRole('button', { name: 'Run, 10 active' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Open Worker \d+ \(@worker-\d+\) child session: Running/u })).toHaveLength(10);
  });

  it('resizes the read-only preview between the child list and chat area', async () => {
    const user = userEvent.setup();
    useRuntimeStore.getState().hydrateRuntime({ ...state, subagents: [] });
    render(<SubagentSessionsPanel />);

    const emptySessions = screen.getByText('No child sessions');
    const handle = screen.getByRole('separator', { name: 'Resize sub-agent chat preview' });
    const preview = screen.getByRole('region', { name: 'Sub-agent chat preview' });
    expect(emptySessions.compareDocumentPosition(handle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(handle.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(handle).toHaveAttribute('aria-valuenow', '260');

    handle.focus();
    await user.keyboard('{ArrowUp}');
    expect(handle).toHaveAttribute('aria-valuenow', '276');
    expect(preview).toHaveStyle({ flexBasis: '276px' });
  });

  it('renames a display label through the canonical handle without exposing the run ID', async () => {
    const user = userEvent.setup();
    const controlSubagent = vi.fn(async (input: { action: string; displayName?: string }) => ({
      ...state,
      subagents: [{ ...run, displayName: input.displayName ?? run.displayName }],
    }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { controlSubagent } });
    render(<Inspector onCollapse={vi.fn()} />);

    await openAgentsInspector(user);
    await user.click(screen.getByRole('button', { name: 'Rename @architecture-scout-1' }));
    const input = screen.getByRole('textbox', { name: 'Display name for @architecture-scout-1' });
    await user.clear(input);
    await user.type(input, 'Runtime Cartographer');
    await user.click(screen.getByRole('button', { name: 'Save display name' }));

    await waitFor(() => expect(controlSubagent).toHaveBeenCalledWith({ action: 'rename', target: '@architecture-scout-1', displayName: 'Runtime Cartographer' }));
    expect(useRuntimeStore.getState().subagentsById[run.id]?.displayName).toBe('Runtime Cartographer');
  });

  it('keeps a full final result inspectable when the live child transcript was bounded', async () => {
    const user = userEvent.setup();
    const fullResult = 'complete-result-'.repeat(4_000);
    useRuntimeStore.getState().hydrateRuntime({
      ...state,
      subagents: [{ ...run, result: fullResult, transcriptTruncated: true }],
    });
    render(<Inspector onCollapse={vi.fn()} />);

    await openAgentsInspector(user);
    await user.click(screen.getByRole('button', { name: 'Open Architecture Scout (@architecture-scout-1) child session: Completed' }));
    const preview = screen.getByRole('region', { name: 'Architecture Scout chat preview' });
    await user.click(within(preview).getByText('Full final result'));
    expect(preview.querySelector('.subagent-final-result pre')).toHaveTextContent(fullResult);
  });

  it('renders active and restart-paused workflow graphs visibly in the session inspector', async () => {
    const user = userEvent.setup();
    useRuntimeStore.getState().hydrateRuntime({
      ...state,
      subagents: [],
      subagentWorkflows: [{
        id: 'workflow-restartable', parentSessionId: 'parent-1', parentToolCallId: 'workflow-tool', status: 'paused',
        maxConcurrency: 2, notification: 'next-turn',
        usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.002, contextTokens: 25, turns: 1 },
        nodes: [
          { id: 'foundation', handle: 'foundation', displayName: 'Foundation', task: 'Build the foundation', status: 'completed', dependsOn: [], endedAt: 10 },
          { id: 'resume-me', handle: 'resume-me', displayName: 'Resume Worker', task: 'Resume after restart', status: 'interrupted', dependsOn: ['foundation'], error: 'Restarted' },
        ],
        livenessReports: [{
          id: 'workflow-restartable:adaptive-limit:1:9', trigger: 'adaptive-limit',
          reason: 'Aggregate turns crossed an advisory threshold.',
          evidence: [{ signal: 'turn-threshold', detail: 'Observed one turn.', count: 1 }],
          recentProgress: ['Foundation completed.'],
          counters: { turns: 1, completedNodes: 1, runningNodes: 0, pendingNodes: 0, totalNodes: 2, softTurnThreshold: 33 },
          timing: { detectedAt: 9, startedAt: 1, updatedAt: 9 },
          workflow: { id: 'workflow-restartable' },
          checkpointSummary: 'One workflow node completed before restart.',
          recommendedOptions: ['continue', 'steer', 'request-checkpoint', 'cancel'],
        }],
        createdAt: 1, updatedAt: 10, error: 'Resume explicitly.',
      }],
    });
    render(<Inspector onCollapse={vi.fn()} />);

    await openAgentsInspector(user);
    const workflows = screen.getByLabelText('Subagent workflows');
    expect(within(workflows).getByText('paused')).toBeInTheDocument();
    expect(within(workflows).getByText('@foundation')).toBeInTheDocument();
    expect(within(workflows).getByText('@resume-me')).toHaveAttribute('data-status', 'interrupted');
    expect(within(workflows).getByText('Workflow liveness checkpoint · adaptive-limit')).toBeInTheDocument();
  });

  it('consumes a retained tool jump after focus without clearing a newer nonce', async () => {
    const view = render(<ToolCard toolCallId="delegate-1" />);
    act(() => useUiStore.getState().requestFlightDeckJump('/project', 'parent-1', { kind: 'tool', toolCallId: 'delegate-1' }));
    const tool = screen.getByRole('article', { name: 'subagent tool completed' });
    await waitFor(() => expect(useUiStore.getState().flightDeckJump).toBeNull());
    expect(tool).toHaveFocus();
    expect(tool).not.toHaveAttribute('data-flight-focus');

    const clearFlightDeckJump = useUiStore.getState().clearFlightDeckJump;
    let requestedNewerJump = false;
    useUiStore.setState({
      clearFlightDeckJump: (nonce) => {
        if (!requestedNewerJump) {
          requestedNewerJump = true;
          useUiStore.getState().requestFlightDeckJump('/project', 'parent-1', { kind: 'agent', runId: 'newer-run' });
        }
        clearFlightDeckJump(nonce);
      },
    });
    act(() => useUiStore.getState().requestFlightDeckJump('/project', 'parent-1', { kind: 'tool', toolCallId: 'delegate-1' }));
    await waitFor(() => expect(useUiStore.getState().flightDeckJump?.target).toEqual({ kind: 'agent', runId: 'newer-run' }));
    useUiStore.setState({ clearFlightDeckJump });
    clearFlightDeckJump(useUiStore.getState().flightDeckJump?.nonce);
    view.unmount();

    render(<Inspector onCollapse={vi.fn()} />);
    act(() => useUiStore.getState().requestFlightDeckJump('/project', 'parent-1', { kind: 'tool', toolCallId: 'not-retained' }));
    await waitFor(() => expect(useUiStore.getState().flightDeckJump).toBeNull());
    expect(useUiStore.getState().toast).toMatchObject({ title: 'Activity not retained' });
  });

  it('consumes retained agent-run jumps and resolves missing runs once', async () => {
    act(() => useUiStore.getState().requestFlightDeckJump('/project', 'parent-1', { kind: 'agent', runId: run.id }));
    render(<SubagentSessionsPanel />);
    const preview = screen.getByRole('region', { name: 'Architecture Scout chat preview' });
    await waitFor(() => expect(useUiStore.getState().flightDeckJump).toBeNull());
    expect(preview).toHaveFocus();

    act(() => useUiStore.getState().requestFlightDeckJump('/project', 'parent-1', { kind: 'agent', runId: 'not-retained' }));
    await waitFor(() => expect(useUiStore.getState().flightDeckJump).toBeNull());
    expect(useUiStore.getState().toast).toMatchObject({ title: 'Activity not retained' });
  });

  it('collapses and restores an Agent Team branch directly below the main agent', async () => {
    const user = userEvent.setup();
    useRuntimeStore.getState().hydrateRuntime({ ...state, subagents: [], agentTeams: [team] });
    render(<SubagentSessionsPanel />);

    const toggle = screen.getByRole('button', { name: /^Review team · Current/u });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Reviewer Agent Team node ready')).toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Reviewer Agent Team node ready')).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Reviewer Agent Team node ready')).toBeInTheDocument();
  });

  it('uses a compact themed confirmation when deleting Agent Team history', async () => {
    const user = userEvent.setup();
    useRuntimeStore.getState().hydrateRuntime({ ...state, subagents: [], agentTeams: [{ ...team, status: 'closed' }] });
    render(<SubagentSessionsPanel />);

    await user.click(screen.getByRole('button', { name: 'Delete team history for Review team' }));

    const confirmation = screen.getByRole('alertdialog', { name: 'Delete Review team history?' });
    expect(within(confirmation).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(within(confirmation).queryByRole('button', { name: 'Delete history' })).not.toBeInTheDocument();
  });

  it('opens an Agent Team V2 child and shows its retained conversation', async () => {
    const user = userEvent.setup();
    useRuntimeStore.getState().hydrateRuntime({ ...state, subagents: [], agentTeams: [team] });
    render(<SubagentSessionsPanel />);

    const reviewer = screen.getByRole('button', { name: 'Reviewer Agent Team node ready' });
    await user.click(reviewer);

    expect(useUiStore.getState().selectedAgent).toEqual({ kind: 'team-node', teamId: team.id, nodeId: 'team-reviewer' });
    expect(reviewer).toHaveAttribute('aria-current', 'true');
    const preview = screen.getByRole('region', { name: 'Reviewer chat preview' });
    expect(within(preview).getByText('Review the change and report concrete risks.')).toBeInTheDocument();
    expect(within(preview).getByText('Review complete.')).toBeInTheDocument();
    expect(within(preview).getByText('read')).toBeInTheDocument();

    await user.click(within(preview).getByRole('button', { name: 'Close sub-agent chat preview' }));
    expect(useUiStore.getState().selectedAgent).toBeNull();
    expect(screen.getByRole('region', { name: 'Sub-agent chat preview' })).toBeInTheDocument();
  });

  it.each([
    ['team node', { kind: 'team-node' as const, teamId: team.id, nodeId: 'team-reviewer' }],
    ['team task', { kind: 'task' as const, teamId: team.id, taskId: 'team-task' }],
  ])('consumes a retained %s jump after focusing its rendered node', async (_label, target) => {
    useRuntimeStore.getState().hydrateRuntime({ ...state, agentTeams: [team] });
    render(<SubagentSessionsPanel />);
    expect(screen.getByRole('region', { name: 'Sub-agent chat preview' })).toBeInTheDocument();
    act(() => useUiStore.getState().requestFlightDeckJump('/project', 'parent-1', target));
    const node = screen.getByLabelText('Reviewer Agent Team node ready').closest('article');
    expect(node).not.toBeNull();
    await waitFor(() => expect(useUiStore.getState().flightDeckJump).toBeNull());
    expect(node).toHaveFocus();
    expect(node).not.toHaveAttribute('data-flight-focus');
  });

  it('shows the bound model and effort on the Main agent root like child rows', () => {
    render(<SubagentSessionsPanel />);

    const meta = document.querySelector('.agent-tree-root-meta');
    expect(meta).toHaveTextContent('root session · Model · Medium');
    expect(meta).toHaveAttribute('title', 'test/model');
  });

  it('keeps the Main agent root meta in sync with a pending model change', () => {
    act(() => useRuntimeStore.getState().hydrateRuntime({
      ...state,
      pendingModel: { provider: 'test', id: 'grok', name: 'Grok 4.6', reasoning: true, contextWindow: 100_000 },
      pendingThinkingLevel: 'high',
    }));
    render(<SubagentSessionsPanel />);

    expect(document.querySelector('.agent-tree-root-meta')).toHaveTextContent('root session · Grok 4.6 · High');
  });

  it('discovers nested children, opens a controlled transcript, and deep-links from the parent tool', async () => {
    const user = userEvent.setup();
    const view = render(<><Inspector onCollapse={vi.fn()} /><ToolCard toolCallId="delegate-1" /></>);

    await openAgentsInspector(user);
    const sessions = screen.getByRole('region', { name: 'Agent sessions' });
    expect(screen.getByText('Main agent')).toBeInTheDocument();
    expect(screen.getByText('Runtime boundaries')).toBeInTheDocument();
    expect(sessions).toHaveClass('subagent-sessions--has-children');
    expect(sessions.querySelector('.session-agent-mark')).not.toBeInTheDocument();
    expect(within(sessions).queryByText('Ready')).not.toBeInTheDocument();
    expect(within(sessions).queryByText('1 child session')).not.toBeInTheDocument();
    const child = screen.getByRole('button', { name: 'Open Architecture Scout (@architecture-scout-1) child session: Completed' });
    expect(child).toHaveTextContent('Inspect the runtime');

    await user.click(child);
    const preview = screen.getByRole('region', { name: 'Architecture Scout chat preview' });
    expect(screen.getByText('Main agent')).toBeInTheDocument();
    expect(preview.querySelector('.subagent-chat-preview-copy small')).toHaveTextContent('@architecture-scout-1');
    expect(within(preview).getByText('Read only')).toBeInTheDocument();
    expect(within(preview).getByText('Boundary confirmed.').tagName).toBe('STRONG');
    expect(within(preview).getByText('Reasoning')).toBeInTheDocument();
    expect(within(preview).getByText('read')).toBeInTheDocument();
    expect(within(preview).queryByRole('textbox')).not.toBeInTheDocument();

    await user.click(within(preview).getByRole('button', { name: 'Close sub-agent chat preview' }));
    expect(screen.getByRole('region', { name: 'Sub-agent chat preview' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'View subagent session' }));
    expect(useUiStore.getState()).toMatchObject({ inspectorTab: 'sessions', selectedAgent: { kind: 'subagent', runId: run.id }, inspectorCollapsed: false });
    expect(screen.getByRole('region', { name: 'Architecture Scout chat preview' })).toBeInTheDocument();

    view.unmount();
  });
});
