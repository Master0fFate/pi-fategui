import { describe, expect, it } from 'vitest';
import type { SubagentChildEvent, SubagentRun, SubagentUsage } from '../../shared/contracts/ipc';
import {
  CHECKPOINT_TOOL_INTERVAL,
  REPETITION_THRESHOLD,
  createSubagentLivenessState,
  observeSubagentLiveness,
} from './SubagentLiveness';

const usage = (turns = 1): SubagentUsage => ({
  input: turns * 10, output: turns * 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 100, turns,
});

function run(maxTurns?: number): SubagentRun {
  return {
    id: 'child-1', parentSessionId: 'parent-1', parentToolCallId: 'tool-1', task: 'Investigate and implement the requested change',
    role: 'worker', handle: 'worker-1', displayName: 'Worker', agentName: 'direct', agentSource: 'direct',
    permissionLevel: 'edit', enabledTools: ['read', 'edit'], skills: [], skillMode: 'all', preloadedSkills: [],
    status: 'running', model: { provider: 'test', id: 'model', name: 'Model', reasoning: true, contextWindow: 100_000, supportsImages: false },
    routingModels: [], thinkingLevel: 'medium', executionMode: 'managed', controlCount: 0, attempt: 1, maxAttempts: 1,
    mailbox: { state: 'closed', ttlMs: 0, followUpCount: 0 }, notification: 'never',
    ...(maxTurns === undefined ? {} : { budget: { maxTurns } }), dependsOn: [], createdAt: 0, updatedAt: 0, startedAt: 0,
    messages: [], tools: [], omittedActivity: 0, transcriptTruncated: false, usage: usage(0),
  };
}

function completeTool(target: SubagentRun, index: number, name: 'read' | 'edit', input: string, output: string, error = false): SubagentChildEvent {
  const timestamp = (index + 1) * 1_000;
  const id = `tool-${index}`;
  target.tools.push({
    id, name, input, output, outputTruncated: false, status: error ? 'error' : 'succeeded',
    startedAt: timestamp - 1, updatedAt: timestamp, endedAt: timestamp,
  });
  return { type: 'tool.completed', toolCallId: id, name, output, error, timestamp };
}

describe('SubagentLiveness', () => {
  it('does not flag a few legitimate repeated commands or recurring failures', () => {
    const target = run();
    const state = createSubagentLivenessState(target, 0);
    const reports = [];
    for (let index = 0; index < REPETITION_THRESHOLD - 1; index += 1) {
      reports.push(...observeSubagentLiveness(state, completeTool(target, index, 'read', '{"path":"status.log"}', 'same result'), target, usage()));
    }
    for (let index = REPETITION_THRESHOLD - 1; index < 11; index += 1) {
      reports.push(...observeSubagentLiveness(state, completeTool(target, index, 'read', '{"path":"failing-test.log"}', 'same test failure', true), target, usage()));
    }
    expect(reports.filter((report) => report.trigger === 'repetition')).toEqual([]);
  });

  it('reports sustained low-diversity repetition without changing child state', () => {
    const target = run();
    const state = createSubagentLivenessState(target, 0);
    const reports = [];
    for (let index = 0; index < REPETITION_THRESHOLD; index += 1) {
      reports.push(...observeSubagentLiveness(state, completeTool(target, index, 'read', '{"path":"same.txt"}', 'unchanged'), target, usage()));
    }
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      trigger: 'repetition', counters: { repeatedOccurrences: REPETITION_THRESHOLD },
      recommendedOptions: ['continue', 'steer', 'request-checkpoint', 'cancel'],
    });
    expect(target.status).toBe('running');
  });

  it('uses objective progress to reset and suppress repetition suspicion', () => {
    const target = run();
    const state = createSubagentLivenessState(target, 0);
    const reports = [];
    for (let index = 0; index < 6; index += 1) {
      reports.push(...observeSubagentLiveness(state, completeTool(target, index, 'read', '{"path":"same.txt"}', 'unchanged'), target, usage()));
    }
    reports.push(...observeSubagentLiveness(state, completeTool(target, 6, 'edit', '{"path":"same.txt"}', 'updated'), target, usage()));
    for (let index = 7; index < 13; index += 1) {
      reports.push(...observeSubagentLiveness(state, completeTool(target, index, 'read', '{"path":"same.txt"}', 'unchanged'), target, usage()));
    }
    expect(reports.filter((report) => report.trigger === 'repetition')).toEqual([]);
    expect(state.recentProgress.at(-1)?.summary).toContain('project-changing');
  });

  it('reports crossed cost and token thresholds once without changing child state', () => {
    const target = run();
    target.budget = { maxCostUsd: 0.01, maxInputTokens: 5, maxOutputTokens: 1, maxTotalTokens: 6 };
    const state = createSubagentLivenessState(target, 0);
    const observed = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.03, contextTokens: 12, turns: 1 };
    const first = observeSubagentLiveness(state, { type: 'run.started', runId: 'sdk-run', timestamp: 1_000 }, target, observed);
    const duplicate = observeSubagentLiveness(state, { type: 'run.completed', runId: 'sdk-run', aborted: false, timestamp: 2_000 }, target, observed);

    expect(first).toEqual([expect.objectContaining({
      trigger: 'resource-limit',
      evidence: expect.arrayContaining([
        expect.objectContaining({ signal: 'cost-threshold' }),
        expect.objectContaining({ signal: 'input-token-threshold' }),
        expect.objectContaining({ signal: 'output-token-threshold' }),
        expect.objectContaining({ signal: 'total-token-threshold' }),
      ]),
    })]);
    expect(duplicate).toEqual([]);
    expect(target.status).toBe('running');
  });

  it('emits adaptive turn and liberal checkpoint reports while execution remains advisory', () => {
    const limited = run(28);
    const limitedState = createSubagentLivenessState(limited, 0);
    const adaptive = observeSubagentLiveness(
      limitedState,
      { type: 'run.started', runId: 'sdk-run', timestamp: 29_000 },
      limited,
      usage(29),
    );
    expect(adaptive[0]).toMatchObject({ trigger: 'adaptive-limit', counters: { turns: 29 } });
    expect(adaptive[0]?.reason).toContain('not a budget failure');
    expect(limited.status).toBe('running');
    expect(limitedState.softTurnThreshold).toBeGreaterThan(29);

    const checkpointed = run();
    const checkpointState = createSubagentLivenessState(checkpointed, 0);
    const checkpoints = [];
    for (let index = 0; index < CHECKPOINT_TOOL_INTERVAL; index += 1) {
      checkpoints.push(...observeSubagentLiveness(
        checkpointState,
        completeTool(checkpointed, index, 'read', `{"path":"file-${index}.txt"}`, `result-${index}`),
        checkpointed,
        usage(10),
      ));
    }
    expect(checkpoints.filter((report) => report.trigger === 'checkpoint')).toHaveLength(1);
    expect(checkpointed.status).toBe('running');
  });
});
