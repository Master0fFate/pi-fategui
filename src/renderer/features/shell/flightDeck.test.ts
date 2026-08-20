import { describe, expect, it } from 'vitest';
import { createTeamRuntime, projectTeam } from '../../../main/pi/multi-agent/AgentTeamStore';
import type { RuntimeState, RuntimeTool } from '../../../shared/contracts/ipc';
import { FLIGHT_RECORDER_LIMIT, selectActivityPulse, selectChangeOrigins, selectFlightRecorder, writerConflictState } from './flightDeck';

function runtime(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    status: 'ready', project: { path: 'C:/project', name: 'project', trusted: true }, sessionId: 'session-1', sessionFile: null,
    streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], error: null, ...overrides,
  };
}

const rootTool: RuntimeTool = {
  id: 'edit-1', name: 'edit', input: '{}', output: '', outputTruncated: false, status: 'succeeded', startedAt: 10, updatedAt: 11, endedAt: 11,
  provenance: { actor: { kind: 'root' }, affectedPaths: [{ path: 'src/old.ts', operation: 'edit' }] },
};

describe('Flight Deck selectors', () => {
  it('uses stable pulse precedence and honest context availability', () => {
    const base = { tools: [] as RuntimeTool[], subagents: [], workflows: [], teams: [], changedFiles: 2 };
    expect(selectActivityPulse({ ...base, runtime: runtime({ sessionOperation: true }) })).toMatchObject({ label: 'Changing session', context: 'Context unavailable' });
    expect(selectActivityPulse({ ...base, runtime: runtime({ status: 'auth-required' }) }).label).toBe('Authentication required');
    expect(selectActivityPulse({ ...base, runtime: runtime({ streaming: true, contextUsage: { tokens: 50, contextWindow: 100, percent: 50, estimated: true } }) })).toMatchObject({ label: 'Thinking', context: '~50.0% context' });
    expect(selectActivityPulse({ ...base, runtime: runtime({ activeSessionRunning: true }) }).label).toBe('Thinking');
    expect(selectActivityPulse({ ...base, runtime: runtime(), tools: [{ ...rootTool, status: 'running' }] }).label).toBe('Editing src/old.ts');
    expect(selectActivityPulse({ ...base, runtime: runtime(), changedFiles: 2 })).toMatchObject({ label: 'Ready', evidence: ['2 changed'] });
    expect(selectActivityPulse({ ...base, runtime: runtime(), changedFiles: 0 }).label).toBe('Ready');
  });

  it('orders deterministically, caps rendering, and reports omission', () => {
    const timelineOrder = Array.from({ length: 300 }, (_, index) => `message:m${index}`);
    const timelineById = Object.fromEntries(timelineOrder.map((id, index) => [id, { id, kind: 'message' as const, messageId: `m${index}`, timestamp: index }]));
    const messagesById = Object.fromEntries(timelineOrder.map((_id, index) => [`m${index}`, { id: `m${index}`, role: 'assistant' as const, text: 'retained', timestamp: index }]));
    const result = selectFlightRecorder({ timelineOrder, timelineById, messagesById, toolsById: {}, subagents: [], teams: [] });
    expect(result.rows).toHaveLength(FLIGHT_RECORDER_LIMIT);
    expect(result.omitted).toBe(true);
    expect(result.rows[0]?.timestamp).toBe(44);
    expect(result.rows.at(-1)?.timestamp).toBe(299);
  });

  it('exposes only retained conversation targets and never copies raw runtime errors', () => {
    const result = selectFlightRecorder({
      timelineOrder: ['message:kept', 'reasoning:kept', 'message:missing', 'error:1'],
      timelineById: {
        'message:kept': { id: 'message:kept', kind: 'message', messageId: 'kept', timestamp: 1 },
        'reasoning:kept': { id: 'reasoning:kept', kind: 'reasoning', messageId: 'kept', timestamp: 2 },
        'message:missing': { id: 'message:missing', kind: 'message', messageId: 'missing', timestamp: 3 },
        'error:1': { id: 'error:1', kind: 'error', error: { message: 'secret '.repeat(10_000) }, timestamp: 4 },
      },
      visibleTimelineIds: new Set(['message:kept', 'reasoning:kept']),
      messagesById: { kept: { id: 'kept', role: 'assistant', text: 'answer', timestamp: 1 } },
      reasoningByMessageId: { kept: 'reason' }, toolsById: {}, subagents: [], teams: [],
    });
    expect(result.rows.map((row) => row.target)).toEqual([
      { kind: 'message', messageId: 'kept' },
      { kind: 'message', messageId: 'kept', timelineId: 'reasoning:kept' },
      undefined,
      undefined,
    ]);
    expect(result.rows.at(-1)?.detail).toBe('Runtime error target is no longer retained');
    expect(result.rows.at(-1)?.detail).not.toContain('secret');
  });

  it('does not claim omission merely because a complete team timeline has 256 entries', () => {
    const team = projectTeam(createTeamRuntime('session-1', '/project', { provider: 'test', id: 'model', name: 'Model', reasoning: true, contextWindow: 100_000 }, 'medium', 'read-only'));
    team.timeline = Array.from({ length: FLIGHT_RECORDER_LIMIT }, (_value, index) => ({
      id: `event-${index}`, sequence: index + 1, type: 'team.created' as const, summary: 'Lifecycle event', timestamp: index,
    }));
    const result = selectFlightRecorder({ timelineOrder: [], timelineById: {}, messagesById: {}, toolsById: {}, subagents: [], teams: [team] });
    expect(result.rows).toHaveLength(FLIGHT_RECORDER_LIMIT);
    expect(result.omitted).toBe(false);
  });

  it('reports omission when a team-only timeline overflows its visible limit, even with no other source overflow', () => {
    const team = projectTeam(createTeamRuntime('session-1', '/project', { provider: 'test', id: 'model', name: 'Model', reasoning: true, contextWindow: 100_000 }, 'medium', 'read-only'));
    team.timeline = Array.from({ length: FLIGHT_RECORDER_LIMIT + 5 }, (_value, index) => ({
      id: `event-${index}`, sequence: index + 1, type: 'team.created' as const, summary: 'Lifecycle event', timestamp: index,
    }));
    const result = selectFlightRecorder({ timelineOrder: [], timelineById: {}, messagesById: {}, toolsById: {}, subagents: [], teams: [team] });
    // The team source dropped events before merging, so omission is reported even
    // though the merged row count fits the recorder limit.
    expect(result.rows).toHaveLength(FLIGHT_RECORDER_LIMIT);
    expect(result.omitted).toBe(true);
  });

  it('matches only structured provenance against current and renamed Git paths', () => {
    const sources = {
      timelineOrder: ['tool:edit-1', 'tool:bash-1'],
      timelineById: {
        'tool:edit-1': { id: 'tool:edit-1', kind: 'tool' as const, toolCallId: 'edit-1', timestamp: 10 },
        'tool:bash-1': { id: 'tool:bash-1', kind: 'tool' as const, toolCallId: 'bash-1', timestamp: 12 },
      },
      messagesById: {},
      toolsById: {
        'edit-1': rootTool,
        'bash-1': { ...rootTool, id: 'bash-1', name: 'bash', provenance: undefined },
      },
      subagents: [], teams: [],
    };
    const origins = selectChangeOrigins({ path: 'src/new.ts', oldPath: 'src/old.ts', indexStatus: 'R', workTreeStatus: ' ', additions: 1, deletions: 1, binary: false }, sources);
    expect(origins).toHaveLength(1);
    expect(origins[0]).toMatchObject({ toolName: 'edit', target: { kind: 'tool', toolCallId: 'edit-1' } });
    expect(selectChangeOrigins({ path: 'src/other.ts', indexStatus: 'M', workTreeStatus: ' ', additions: 1, deletions: 0, binary: false }, sources)).toEqual([]);
  });

  it('marks a path ambiguous when more than one actor has related activity', () => {
    const root = {
      id: 'root', actorLabel: 'Main agent', toolName: 'edit', timestamp: 1,
      provenance: { actor: { kind: 'root' as const }, affectedPaths: [{ path: 'src/a.ts', operation: 'edit' as const }] },
      target: { kind: 'tool' as const, toolCallId: 't1' },
    };
    const child = {
      ...root, id: 'child', actorLabel: 'Agent run-2',
      provenance: { actor: { kind: 'legacy' as const, runId: 'run-2', parentToolCallId: 'parent-1' }, affectedPaths: [{ path: 'src/a.ts', operation: 'edit' as const }] },
    };
    expect(writerConflictState([])).toBe('none');
    expect(writerConflictState([root])).toBe('single');
    expect(writerConflictState([root, child])).toBe('ambiguous');
  });
});
