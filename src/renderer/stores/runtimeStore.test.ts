import { beforeEach, describe, expect, it } from 'vitest';
import type { PiEvent, SubagentRun, SubagentWorkflowLivenessReport } from '../../shared/contracts/ipc';
import { createTeamRuntime, projectTeam } from '../../main/pi/multi-agent/AgentTeamStore';
import { MAX_LIVE_TIMELINE_ENTITIES, MAX_LIVE_TOOL_OUTPUT, useRuntimeStore } from './runtimeStore';

const resetRuntime = (sessionId: string) => ({
  status: 'ready' as const,
  project: { path: '/project', name: 'project', trusted: true },
  sessionId,
  sessionFile: null,
  streaming: false,
  model: null,
  models: [],
  thinkingLevel: 'medium' as const,
  messages: [],
  commands: [],
  error: null,
});

const reset = () => useRuntimeStore.setState({
  runtime: { status: 'disconnected', project: null, sessionId: null, sessionFile: null, streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null },
  messagesById: {}, messageOrder: [], reasoningByMessageId: {}, toolsById: {}, toolOrder: [],
  subagentsById: {}, subagentOrder: [],
  agentTeamsById: {}, agentTeamOrder: [], agentNodesById: {}, agentTasksById: {}, agentEnvelopesById: {},
  timelineById: {}, timelineOrder: [], visibleTimelineOrder: [], visibleTimelineIds: new Set(),
  messagesVersion: 0, reasoningVersion: 0, toolsVersion: 0, timelineVersion: 0, waitPollVersion: 0, subagentRecorderVersion: 0,
  queue: { steering: 0, followUp: 0, items: [] }, lastError: null,
  sequence: 0, timelineSequence: 0, activeCompactionId: null,
});

describe('runtimeStore event reducer', () => {
  beforeEach(reset);

  it('normalizes Agent Team V2 projections and merges sibling teams atomically on events', () => {
    const runtime = createTeamRuntime('session', '/project', { provider: 'test', id: 'model', name: 'Model', reasoning: true, contextWindow: 100_000 }, 'high', 'read-only');
    const team = projectTeam(runtime);
    useRuntimeStore.getState().applyEvents([{ type: 'agent-team.updated', team, timestamp: 1 }]);
    const state = useRuntimeStore.getState();
    expect(state.agentTeamOrder).toEqual([team.id]);
    expect(state.agentTeamsById[team.id]).toEqual(team);
    expect(state.agentNodesById[team.rootNodeId]?.path).toBe('/root');
    expect(state.runtime.agentTeams).toEqual([team]);

    const second = projectTeam(createTeamRuntime('session', '/project', { provider: 'test', id: 'model', name: 'Model', reasoning: true, contextWindow: 100_000 }, 'high', 'read-only', { name: 'Second', selected: false, now: team.createdAt + 1 }));
    useRuntimeStore.getState().applyEvents([{ type: 'agent-team.updated', team: second, timestamp: 2 }]);
    expect(useRuntimeStore.getState().agentTeamOrder).toEqual([team.id, second.id]);
    expect(useRuntimeStore.getState().runtime.agentTeams).toEqual([team, second]);

    reset();
    expect(useRuntimeStore.getState().agentTeamOrder).toEqual([]);
  });

  it('ignores duplicate and regressive cursored events without breaking uncursored fixtures', () => {
    useRuntimeStore.getState().hydrateRuntime({
      ...resetRuntime('session-a'), eventCursor: 5,
      messages: [{ id: 'stream', role: 'assistant', text: 'snapshot', timestamp: 1 }],
    });
    useRuntimeStore.getState().applyEvents([
      { type: 'assistant.text', messageId: 'stream', delta: '-duplicate', timestamp: 2, cursor: 5 },
      { type: 'assistant.text', messageId: 'stream', delta: '-new', timestamp: 3, cursor: 6 },
      { type: 'assistant.text', messageId: 'stream', delta: '-regressive', timestamp: 4, cursor: 4 },
      { type: 'assistant.text', messageId: 'stream', delta: '-same', timestamp: 5, cursor: 6 },
    ]);
    expect(useRuntimeStore.getState().messagesById.stream?.text).toBe('snapshot-new');
    expect(useRuntimeStore.getState().sequence).toBe(6);

    useRuntimeStore.getState().applyEvents([{ type: 'assistant.text', messageId: 'stream', delta: '-fixture', timestamp: 6 }]);
    expect(useRuntimeStore.getState().messagesById.stream?.text).toBe('snapshot-new-fixture');
  });

  it('does not let a stale tool start overwrite a cursored completion', () => {
    useRuntimeStore.getState().hydrateRuntime(resetRuntime('session-a'));
    useRuntimeStore.getState().applyEvents([
      { type: 'tool.completed', toolCallId: 'edit-1', name: 'edit', output: 'done', error: false, timestamp: 4, cursor: 4 },
      { type: 'tool.started', toolCallId: 'edit-1', name: 'edit', input: '{}', timestamp: 3, cursor: 3 },
    ]);
    expect(useRuntimeStore.getState().toolsById['edit-1']).toMatchObject({ status: 'succeeded', output: 'done', endedAt: 4 });
  });

  it('accepts a lower cursor only across an authoritative project/session boundary', () => {
    useRuntimeStore.getState().hydrateRuntime({ ...resetRuntime('session-a'), eventCursor: 50 });
    useRuntimeStore.getState().applyEvents([{
      type: 'state.changed', cursor: 1, timestamp: 1, messagesIncluded: true,
      state: { ...resetRuntime('session-b'), eventCursor: 1 },
    }, {
      type: 'message.completed', cursor: 2, messageId: 'new-session', role: 'assistant', text: 'fresh', timestamp: 2,
    }]);
    expect(useRuntimeStore.getState().runtime.sessionId).toBe('session-b');
    expect(useRuntimeStore.getState().messagesById['new-session']?.text).toBe('fresh');
    expect(useRuntimeStore.getState().sequence).toBe(2);
  });

  it('updates only the streamed message entity across a batched delta', () => {
    useRuntimeStore.getState().applyEvents([
      { type: 'message.started', messageId: 'm1', role: 'assistant', timestamp: 1 },
      { type: 'message.started', messageId: 'm2', role: 'user', timestamp: 1 },
    ]);
    const untouched = useRuntimeStore.getState().messagesById.m2;
    const order = useRuntimeStore.getState().messageOrder;
    const timelineOrder = useRuntimeStore.getState().timelineOrder;

    useRuntimeStore.getState().applyEvents([
      { type: 'assistant.text', messageId: 'm1', delta: 'hello ', timestamp: 2 },
      { type: 'assistant.text', messageId: 'm1', delta: 'world', timestamp: 3 },
      { type: 'assistant.reasoning', messageId: 'm1', delta: 'checked', timestamp: 3 },
    ]);
    expect(useRuntimeStore.getState().messagesById.m1?.text).toBe('hello world');
    expect(useRuntimeStore.getState().messagesById.m2).toBe(untouched);
    expect(useRuntimeStore.getState().messageOrder).toBe(order);
    expect(useRuntimeStore.getState().reasoningByMessageId.m1).toBe('checked');
    // Reasoning is inserted directly before its answer without rebuilding the
    // pre-existing message entities.
    expect(timelineOrder).toEqual(['message:m1', 'message:m2']);
    expect(useRuntimeStore.getState().timelineOrder).toEqual(['reasoning:m1', 'message:m1', 'message:m2']);
  });

  it('invalidates broad projections with scalar versions without cloning normalized records', () => {
    useRuntimeStore.getState().applyEvents([
      { type: 'message.started', messageId: 'stream', role: 'assistant', timestamp: 1 },
      { type: 'assistant.text', messageId: 'stream', delta: 'first', timestamp: 2 },
      { type: 'tool.started', toolCallId: 'tool', name: 'subagent_manage', input: '{"action":"wait","runIds":["@worker"]}', timestamp: 3 },
    ]);
    const initial = useRuntimeStore.getState();
    const messagesRecord = initial.messagesById;
    const toolsRecord = initial.toolsById;
    const timelineRecord = initial.timelineById;

    useRuntimeStore.getState().applyEvents([
      { type: 'assistant.text', messageId: 'stream', delta: ' second', timestamp: 4 },
      { type: 'tool.updated', toolCallId: 'tool', output: 'progress', timestamp: 4 },
    ]);
    const updated = useRuntimeStore.getState();
    expect(updated.messagesById).toBe(messagesRecord);
    expect(updated.toolsById).toBe(toolsRecord);
    expect(updated.timelineById).toBe(timelineRecord);
    expect(updated.messagesById.stream?.text).toBe('first second');
    expect(updated.messagesVersion).toBe(initial.messagesVersion + 1);
    expect(updated.toolsVersion).toBe(initial.toolsVersion + 1);
    expect(updated.timelineVersion).toBe(initial.timelineVersion);
    expect(updated.waitPollVersion).toBe(initial.waitPollVersion);

    useRuntimeStore.getState().applyEvents([
      { type: 'tool.completed', toolCallId: 'tool', name: 'subagent_manage', output: 'done', error: false, timestamp: 5 },
    ]);
    expect(useRuntimeStore.getState().waitPollVersion).toBe(updated.waitPollVersion + 1);
  });

  it('coalesces adjacent renderer deltas without changing reducer semantics', () => {
    const events: PiEvent[] = [
      { type: 'message.started', messageId: 'stream', role: 'assistant', timestamp: 1 },
      { type: 'assistant.text', messageId: 'stream', delta: 'a'.repeat(40_000), timestamp: 2 },
      { type: 'assistant.text', messageId: 'stream', delta: 'b'.repeat(40_000), timestamp: 3 },
      { type: 'assistant.text', messageId: 'stream', delta: 'c'.repeat(1_000), timestamp: 4 },
      { type: 'assistant.reasoning', messageId: 'stream', delta: 'first ', timestamp: 5 },
      { type: 'assistant.reasoning', messageId: 'stream', delta: 'second', timestamp: 6 },
      { type: 'tool.started', toolCallId: 'tool', name: 'read', input: '{}', timestamp: 7 },
    ];
    useRuntimeStore.getState().applyEvents(events);
    const batched = {
      message: useRuntimeStore.getState().messagesById.stream,
      reasoning: useRuntimeStore.getState().reasoningByMessageId.stream,
      timeline: useRuntimeStore.getState().timelineOrder,
      tool: useRuntimeStore.getState().toolsById.tool,
    };

    reset();
    for (const event of events) useRuntimeStore.getState().applyEvents([event]);
    expect({
      message: useRuntimeStore.getState().messagesById.stream,
      reasoning: useRuntimeStore.getState().reasoningByMessageId.stream,
      timeline: useRuntimeStore.getState().timelineOrder,
      tool: useRuntimeStore.getState().toolsById.tool,
    }).toEqual(batched);
  });

  it('keeps the visible timeline stable across subsequent deltas in a long session', () => {
    useRuntimeStore.getState().applyEvents([
      { type: 'message.started', messageId: 'stream', role: 'assistant', timestamp: 1 },
      { type: 'assistant.text', messageId: 'stream', delta: 'a', timestamp: 2 },
    ]);
    const visibleOrder = useRuntimeStore.getState().visibleTimelineOrder;
    const visibleIds = useRuntimeStore.getState().visibleTimelineIds;
    useRuntimeStore.getState().applyEvents(Array.from({ length: 1_000 }, (_value, index) => ({
      type: 'assistant.text' as const, messageId: 'stream', delta: 'x', timestamp: index + 3,
    })));

    expect(useRuntimeStore.getState().visibleTimelineOrder).toBe(visibleOrder);
    expect(useRuntimeStore.getState().visibleTimelineIds).toBe(visibleIds);
    expect(useRuntimeStore.getState().visibleTimelineOrder).toEqual(['message:stream']);
  });

  it('preserves streamed entities when a bounded lifecycle snapshot omits message history', () => {
    useRuntimeStore.getState().applyEvents([
      { type: 'message.started', messageId: 'm1', role: 'assistant', timestamp: 1 },
      { type: 'assistant.text', messageId: 'm1', delta: 'answer', timestamp: 2 },
      { type: 'assistant.reasoning', messageId: 'm1', delta: 'reason', timestamp: 2 },
      {
        type: 'state.changed',
        timestamp: 3,
        messagesIncluded: false,
        state: { status: 'ready', project: null, sessionId: 's1', sessionFile: null, streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], error: null },
      },
    ]);
    expect(useRuntimeStore.getState().messagesById.m1?.text).toBe('answer');
    expect(useRuntimeStore.getState().reasoningByMessageId.m1).toBe('reason');
  });

  it('preserves objective and history fields across metadata-only same-session states', () => {
    useRuntimeStore.getState().setRuntime({
      status: 'ready', project: { path: '/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: null,
      streaming: false, model: null, models: [], thinkingLevel: 'medium', error: null,
      objective: 'Keep this objective', messages: [{ id: 'user', role: 'user', text: 'Keep this objective', timestamp: 1 }],
    });
    useRuntimeStore.getState().setRuntime({
      status: 'ready', project: { path: '/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: null,
      streaming: true, model: null, models: [], thinkingLevel: 'high', error: null, messages: [],
    });
    expect(useRuntimeStore.getState().runtime.objective).toBe('Keep this objective');
    expect(useRuntimeStore.getState().runtime.messages).toHaveLength(1);
  });

  it('authoritatively replaces same-session entities during hydration resynchronization', () => {
    const initial = {
      status: 'ready' as const, project: { path: '/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: null,
      streaming: true, model: null, models: [], thinkingLevel: 'medium' as const, error: null,
      messages: [{ id: 'stale', role: 'assistant' as const, text: 'stale', timestamp: 1 }],
    };
    useRuntimeStore.getState().setRuntime(initial);
    useRuntimeStore.getState().hydrateRuntime({
      ...initial,
      streaming: false,
      messages: [{ id: 'fresh', role: 'assistant', text: 'fresh', timestamp: 2 }],
    });
    expect(useRuntimeStore.getState().messagesById.stale).toBeUndefined();
    expect(useRuntimeStore.getState().messagesById.fresh?.text).toBe('fresh');
  });

  it('bounds direct hydration by timeline entities, not only message count', () => {
    useRuntimeStore.getState().setRuntime({
      status: 'ready', project: null, sessionId: 'large', sessionFile: null, streaming: false,
      model: null, models: [], thinkingLevel: 'medium', error: null,
      messages: Array.from({ length: 3_000 }, (_value, index) => ({
        id: `h${index}`, role: 'assistant' as const, text: 'answer', reasoning: 'reason', timestamp: index,
      })),
    });
    expect(useRuntimeStore.getState().timelineOrder).toHaveLength(MAX_LIVE_TIMELINE_ENTITIES);
    expect(useRuntimeStore.getState().messagesById.h0).toBeUndefined();
    expect(useRuntimeStore.getState().messagesById.h2999).toBeDefined();
    expect(useRuntimeStore.getState().runtime.messages.length).toBeLessThanOrEqual(MAX_LIVE_TIMELINE_ENTITIES);
    expect(Object.values(useRuntimeStore.getState().messagesById).some((message) => message.historyOmitted !== undefined)).toBe(true);
  });

  it('hydrates completed reasoning from an authoritative runtime state', () => {
    useRuntimeStore.getState().setRuntime({
      status: 'ready', project: null, sessionId: 's1', sessionFile: null, streaming: false,
      model: null, models: [], thinkingLevel: 'medium', error: null,
      messages: [{ id: 'stable', role: 'assistant', text: 'answer', reasoning: 'reason', timestamp: 1 }],
    });
    expect(useRuntimeStore.getState().reasoningByMessageId.stable).toBe('reason');
    expect(useRuntimeStore.getState().timelineOrder).toEqual(['reasoning:stable', 'message:stable']);
  });

  it('hydrates persisted tool calls into their original timeline position', () => {
    useRuntimeStore.getState().setRuntime({
      status: 'ready', project: null, sessionId: 'history', sessionFile: null, streaming: false,
      model: null, models: [], thinkingLevel: 'medium', error: null,
      messages: [
        { id: 'user', role: 'user', text: 'Inspect', timestamp: 1, timelinePosition: 0 },
        { id: 'assistant', role: 'assistant', text: '', reasoning: 'Checking', timestamp: 2, timelinePosition: 1 },
      ],
      tools: [{
        id: 'read-1', name: 'read', input: '{}', output: 'done', outputTruncated: false,
        status: 'succeeded', startedAt: 2, updatedAt: 3, endedAt: 3, timelinePosition: 1.5,
      }],
    });
    expect(useRuntimeStore.getState().toolsById['read-1']).toMatchObject({ output: 'done', status: 'succeeded' });
    expect(useRuntimeStore.getState().timelineOrder).toEqual([
      'message:user', 'reasoning:assistant', 'message:assistant', 'tool:read-1',
    ]);
  });

  it('evicts oldest live image payloads at the aggregate hydration-sized budget', () => {
    useRuntimeStore.getState().applyEvents([
      { type: 'message.completed', messageId: 'older-image', role: 'assistant', text: '', images: [{ data: 'a'.repeat(20_000_000), mimeType: 'image/png' }], timestamp: 1 },
      { type: 'message.completed', messageId: 'newer-image', role: 'assistant', text: '', images: [{ data: 'b', mimeType: 'image/png' }], timestamp: 2 },
    ]);
    expect(useRuntimeStore.getState().messagesById['older-image']?.images).toBeUndefined();
    expect(useRuntimeStore.getState().messagesById['older-image']?.text).toMatch(/omitted/i);
    expect(useRuntimeStore.getState().messagesById['newer-image']?.images).toHaveLength(1);
  });

  it('models structured tool transitions and bounds live output', () => {
    useRuntimeStore.getState().applyEvents([
      { type: 'tool.started', toolCallId: 't1', name: 'edit', input: '{"path":"src/app.ts"}', provenance: { actor: { kind: 'root' }, affectedPaths: [{ path: 'src/app.ts', operation: 'edit' }] }, timestamp: 10 },
      { type: 'tool.updated', toolCallId: 't1', output: 'x'.repeat(MAX_LIVE_TOOL_OUTPUT + 100), timestamp: 11 },
    ]);
    expect(useRuntimeStore.getState().toolsById.t1?.status).toBe('running');
    expect(useRuntimeStore.getState().toolsById.t1?.output.length).toBeLessThan(MAX_LIVE_TOOL_OUTPUT + 100);
    expect(useRuntimeStore.getState().toolsById.t1?.outputTruncated).toBe(true);

    useRuntimeStore.getState().applyEvents([
      { type: 'tool.completed', toolCallId: 't1', name: 'edit', output: 'failed', error: true, timestamp: 20 },
    ]);
    expect(useRuntimeStore.getState().toolsById.t1).toMatchObject({ status: 'error', output: 'failed', startedAt: 10, endedAt: 20, provenance: { actor: { kind: 'root' }, affectedPaths: [{ path: 'src/app.ts', operation: 'edit' }] } });
    expect(useRuntimeStore.getState().timelineOrder).toEqual(['tool:t1']);
  });

  it('keeps child streams isolated while linking the parent tool to its controlled session', () => {
    const run: SubagentRun = {
      id: 'subagent-1', parentSessionId: 's1', parentToolCallId: 'delegate-1', task: 'Inspect runtime state',
      role: 'scout', handle: 'runtime-scout-1', displayName: 'Runtime Scout', agentName: 'scout', agentSource: 'direct' as const,
      permissionLevel: 'read-only' as const, enabledTools: ['read', 'grep'], skills: [], skillMode: 'all', preloadedSkills: [], status: 'queued' as const,
      model: { provider: 'test', id: 'model', name: 'Model', reasoning: true, contextWindow: 100_000 },
      routingModels: [{ provider: 'test', id: 'model', name: 'Model', reasoning: true, contextWindow: 100_000 }],
      thinkingLevel: 'medium' as const, executionMode: 'managed' as const, controlCount: 0, attempt: 1, maxAttempts: 1,
      mailbox: { state: 'closed', ttlMs: 300_000, followUpCount: 0 }, notification: 'never', dependsOn: [],
      createdAt: 1, updatedAt: 1, messages: [], tools: [], omittedActivity: 0, transcriptTruncated: false,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    };
    useRuntimeStore.getState().applyEvents([
      { type: 'tool.started', toolCallId: 'delegate-1', name: 'subagent', input: '{}', timestamp: 1 },
      { type: 'subagent.started', run, timestamp: 1 },
      { type: 'subagent.updated', runId: run.id, status: 'running', startedAt: 2, updatedAt: 2, timestamp: 2 },
      { type: 'subagent.event', runId: run.id, timestamp: 3, event: { type: 'message.started', messageId: 'child-answer', role: 'assistant', timestamp: 3 } },
      { type: 'subagent.event', runId: run.id, timestamp: 4, event: { type: 'assistant.reasoning', messageId: 'child-answer', delta: 'Checking.', timestamp: 4 } },
      { type: 'subagent.event', runId: run.id, timestamp: 5, event: { type: 'assistant.text', messageId: 'child-answer', delta: 'Found it.', timestamp: 5 } },
      {
        type: 'subagent.updated', runId: run.id, status: 'running', updatedAt: 6, timestamp: 6,
        model: { provider: 'alternate', id: 'glm', name: 'GLM', reasoning: true, contextWindow: 200_000 },
        thinkingLevel: 'high', controlCount: 1, displayName: 'Boundary Scout',
      },
      { type: 'tool.completed', toolCallId: 'delegate-1', name: 'subagent', output: 'Found it.', error: false, subagentRunIds: [run.id], timestamp: 7 },
    ]);

    expect(useRuntimeStore.getState().messagesById['child-answer']).toBeUndefined();
    expect(useRuntimeStore.getState().subagentsById[run.id]?.messages[0]).toMatchObject({ text: 'Found it.', reasoning: 'Checking.' });
    expect(useRuntimeStore.getState().subagentsById[run.id]).toMatchObject({
      status: 'running', displayName: 'Boundary Scout', model: { provider: 'alternate', id: 'glm' }, thinkingLevel: 'high', controlCount: 1,
    });
    expect(useRuntimeStore.getState().toolsById['delegate-1']?.subagentRunIds).toEqual([run.id]);
    expect(useRuntimeStore.getState().runtime.subagents).toHaveLength(1);

    useRuntimeStore.getState().applyEvents(Array.from({ length: 59 }, (_, index): PiEvent => ({
      type: 'subagent.started',
      run: { ...run, id: `subagent-${index + 2}`, parentToolCallId: `delegate-${index + 2}`, createdAt: index + 2, updatedAt: index + 2 },
      timestamp: index + 2,
    })));
    expect(useRuntimeStore.getState().subagentOrder).toHaveLength(60);
    expect(useRuntimeStore.getState().runtime.subagents).toHaveLength(60);
  });

  it('projects live workflow graph updates without mixing them into the parent transcript', () => {
    useRuntimeStore.getState().applyEvents([{
      type: 'subagent.workflow.updated',
      timestamp: 2,
      workflow: {
        id: 'workflow-1', parentSessionId: 's1', parentToolCallId: 'workflow-tool', status: 'running',
        maxConcurrency: 2, notification: 'next-turn', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        nodes: [{ id: 'node-a', task: 'Inspect', status: 'pending', dependsOn: [] }], createdAt: 1, updatedAt: 2,
      },
    }]);

    const report: SubagentWorkflowLivenessReport = {
      id: 'workflow-1:adaptive-limit:1:3',
      trigger: 'adaptive-limit',
      reason: 'Aggregate turns crossed an advisory threshold.',
      evidence: [{ signal: 'turn-threshold', detail: 'Observed two turns.', count: 2 }],
      recentProgress: ['Node a completed.'],
      counters: { turns: 2, completedNodes: 1, runningNodes: 1, pendingNodes: 0, totalNodes: 2, softTurnThreshold: 34 },
      timing: { detectedAt: 3, startedAt: 1, updatedAt: 2 },
      workflow: { id: 'workflow-1' },
      checkpointSummary: 'One node completed; one remains active.',
      recommendedOptions: ['continue', 'steer', 'request-checkpoint', 'cancel'],
    };
    useRuntimeStore.getState().applyEvents([
      { type: 'subagent.workflow.liveness', workflowId: 'workflow-1', report, timestamp: 3 },
      { type: 'subagent.workflow.liveness', workflowId: 'workflow-1', report, timestamp: 3 },
    ]);

    expect(useRuntimeStore.getState().runtime.subagentWorkflows).toEqual([
      expect.objectContaining({
        id: 'workflow-1', status: 'running', nodes: [expect.objectContaining({ id: 'node-a' })],
        livenessReports: [expect.objectContaining({ id: report.id, trigger: 'adaptive-limit' })],
      }),
    ]);
    expect(useRuntimeStore.getState().messageOrder).toEqual([]);
  });

  it('preserves tool history when controls update the same runtime session', () => {
    useRuntimeStore.getState().setRuntime({
      status: 'ready', project: { path: '/project', name: 'project', trusted: true }, sessionId: 'same', sessionFile: null,
      streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null,
    });
    useRuntimeStore.getState().applyEvents([
      { type: 'tool.started', toolCallId: 't1', name: 'read', input: '{}', timestamp: 1 },
      { type: 'tool.completed', toolCallId: 't1', name: 'read', output: 'ok', error: false, timestamp: 2 },
    ]);
    useRuntimeStore.getState().setRuntime({
      ...useRuntimeStore.getState().runtime,
      thinkingLevel: 'high',
      messages: [],
    });
    expect(useRuntimeStore.getState().toolsById.t1?.status).toBe('succeeded');
    expect(useRuntimeStore.getState().timelineOrder).toContain('tool:t1');
  });

  it('indexes 5,000 entries without replacing the ordered entity model', () => {
    const events: PiEvent[] = Array.from({ length: 5_000 }, (_value, index) => ({
      type: 'message.started', messageId: `m${index}`, role: index % 2 ? 'assistant' : 'user', timestamp: index,
    }));
    useRuntimeStore.getState().applyEvents(events);
    expect(useRuntimeStore.getState().timelineOrder).toHaveLength(5_000);
    expect(useRuntimeStore.getState().visibleTimelineOrder).toHaveLength(2_500);
    expect(Object.keys(useRuntimeStore.getState().messagesById)).toHaveLength(5_000);

    useRuntimeStore.getState().applyEvents([{ type: 'message.started', messageId: 'm5000', role: 'user', timestamp: 5_000 }]);
    expect(useRuntimeStore.getState().timelineOrder).toHaveLength(MAX_LIVE_TIMELINE_ENTITIES);
    expect(useRuntimeStore.getState().messagesById.m0).toBeUndefined();
    expect(useRuntimeStore.getState().messagesById.m5000).toBeDefined();

    const firstBoundary = Object.values(useRuntimeStore.getState().messagesById).find((message) => message.historyOmitted !== undefined);
    useRuntimeStore.getState().applyEvents(Array.from({ length: 250 }, (_value, index) => ({
      type: 'message.started' as const, messageId: `after-cap-${index}`, role: 'user' as const, timestamp: 5_001 + index,
    })));
    const bounded = useRuntimeStore.getState();
    const boundary = Object.values(bounded.messagesById).find((message) => message.historyOmitted !== undefined);
    expect(bounded.timelineOrder).toHaveLength(MAX_LIVE_TIMELINE_ENTITIES);
    expect(bounded.timelineOrder[0]).toBe(`message:${boundary?.id}`);
    expect(boundary?.historyOmitted).toBe((firstBoundary?.historyOmitted ?? 0) + 250);
    expect(bounded.messagesById['after-cap-249']).toBeDefined();
    expect(Object.keys(bounded.timelineById)).toHaveLength(MAX_LIVE_TIMELINE_ENTITIES);
  });

  it('hydrates queue counts and clears them on authoritative session replacement', () => {
    const base = {
      status: 'ready' as const, project: null, sessionId: 'queued', sessionFile: null, streaming: true,
      model: null, models: [], thinkingLevel: 'medium' as const, messages: [], error: null,
    };
    useRuntimeStore.getState().hydrateRuntime({ ...base, queue: { steering: 2, followUp: 3 } });
    expect(useRuntimeStore.getState().queue).toEqual({ steering: 2, followUp: 3 });
    useRuntimeStore.getState().applyEvents([{
      type: 'state.changed', messagesIncluded: true, timestamp: 2,
      state: { ...base, sessionId: 'replacement', streaming: false },
    }]);
    expect(useRuntimeStore.getState().queue).toEqual({ steering: 0, followUp: 0, items: [] });
  });

  it('preserves queued previews across count events and drops the item Pi consumed first', () => {
    const first = { id: '00000000-0000-4000-8000-000000000001', behavior: 'followUp' as const, text: 'first', createdAt: 1 };
    const second = { id: '00000000-0000-4000-8000-000000000002', behavior: 'followUp' as const, text: 'second', createdAt: 2 };
    useRuntimeStore.setState({ queue: { steering: 0, followUp: 2, items: [first, second] } });

    useRuntimeStore.getState().applyEvents([{ type: 'queue.changed', steering: 0, followUp: 1, timestamp: 3 }]);

    expect(useRuntimeStore.getState().queue).toEqual({ steering: 0, followUp: 1, items: [second] });
  });

  it('adds error and compaction entities and tracks queue state', () => {
    useRuntimeStore.getState().applyEvents([
      { type: 'context.compaction', phase: 'started', timestamp: 1 },
      { type: 'context.compaction', phase: 'completed', aborted: false, timestamp: 2 },
      { type: 'context.compaction', phase: 'started', timestamp: 2.1 },
      { type: 'context.compaction', phase: 'failed', error: { code: 'INVALID_REQUEST', message: 'Too small', retryable: true }, timestamp: 2.2 },
      { type: 'queue.changed', steering: 1, followUp: 2, timestamp: 3 },
      { type: 'error', error: { code: 'UNKNOWN', message: 'Failed', retryable: true }, timestamp: 4 },
    ]);
    expect(useRuntimeStore.getState().timelineOrder).toHaveLength(3);
    expect(useRuntimeStore.getState().queue).toEqual({ steering: 1, followUp: 2, items: [] });
    expect(Object.values(useRuntimeStore.getState().timelineById).map((item) => item.kind)).toEqual(['compaction', 'compaction', 'error']);
    expect(useRuntimeStore.getState().lastError?.message).toBe('Failed');
  });
});
