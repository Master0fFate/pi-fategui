import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeState, SubagentRun } from '../../../shared/contracts/ipc';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { ToolCard } from '../chat/ToolCard';
import { Inspector } from './Inspector';

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

describe('subagent session inspector', () => {
  beforeEach(() => {
    localStorage.clear();
    useRuntimeStore.getState().hydrateRuntime(state);
    useUiStore.setState({ inspectorTab: 'changes', selectedSubagentRunId: null, inspectorCollapsed: false });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'piDesktop');
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

    await user.click(screen.getByRole('tab', { name: 'Subagent sessions, 10 active' }));
    expect(screen.getAllByRole('button', { name: /Open Worker \d+ \(@worker-\d+\) child session: Running/u })).toHaveLength(10);
  });

  it('renames a display label through the canonical handle without exposing the run ID', async () => {
    const user = userEvent.setup();
    const controlSubagent = vi.fn(async (input: { action: string; displayName?: string }) => ({
      ...state,
      subagents: [{ ...run, displayName: input.displayName ?? run.displayName }],
    }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { controlSubagent } });
    render(<Inspector onCollapse={vi.fn()} />);

    await user.click(screen.getByRole('tab', { name: 'Subagent sessions' }));
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

    await user.click(screen.getByRole('tab', { name: 'Subagent sessions' }));
    await user.click(screen.getByRole('button', { name: 'Open Architecture Scout (@architecture-scout-1) child session: Completed' }));
    const detail = screen.getByRole('region', { name: 'Architecture Scout agent session' });
    await user.click(within(detail).getByText('Full final result'));
    expect(detail.querySelector('.subagent-final-result pre')).toHaveTextContent(fullResult);
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
        createdAt: 1, updatedAt: 10, error: 'Resume explicitly.',
      }],
    });
    render(<Inspector onCollapse={vi.fn()} />);

    await user.click(screen.getByRole('tab', { name: 'Subagent sessions' }));
    const workflows = screen.getByLabelText('Subagent workflows');
    expect(within(workflows).getByText('paused')).toBeInTheDocument();
    expect(within(workflows).getByText('@foundation')).toBeInTheDocument();
    expect(within(workflows).getByText('@resume-me')).toHaveAttribute('data-status', 'interrupted');
  });

  it('discovers nested children, opens a controlled transcript, and deep-links from the parent tool', async () => {
    const user = userEvent.setup();
    const view = render(<><Inspector onCollapse={vi.fn()} /><ToolCard toolCallId="delegate-1" /></>);

    await user.click(screen.getByRole('tab', { name: 'Subagent sessions' }));
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
    const detail = screen.getByRole('region', { name: 'Architecture Scout agent session' });
    expect(detail.querySelector('.subagent-detail-header small')).toHaveTextContent('@architecture-scout-1');
    expect(within(detail).getByText('user/architecture-scout')).toBeInTheDocument();
    expect(within(detail).getByText('test/model')).toBeInTheDocument();
    expect(within(detail).getByText('high')).toBeInTheDocument();
    expect(within(detail).getByText('read-only')).toBeInTheDocument();
    expect(within(detail).getByText('read, grep, find, ls')).toBeInTheDocument();
    expect(within(detail).getByText('Boundary confirmed.').tagName).toBe('STRONG');
    expect(within(detail).getByText('Reasoning')).toBeInTheDocument();
    expect(within(detail).getByText('read')).toBeInTheDocument();
    expect(within(detail).queryByRole('textbox')).not.toBeInTheDocument();

    await user.click(within(detail).getByRole('button', { name: 'Back to child sessions' }));
    expect(screen.getByRole('button', { name: 'Open Architecture Scout (@architecture-scout-1) child session: Completed' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'View subagent session' }));
    expect(useUiStore.getState()).toMatchObject({ inspectorTab: 'sessions', selectedSubagentRunId: run.id, inspectorCollapsed: false });
    expect(screen.getByRole('region', { name: 'Architecture Scout agent session' })).toBeInTheDocument();

    view.unmount();
  });
});
