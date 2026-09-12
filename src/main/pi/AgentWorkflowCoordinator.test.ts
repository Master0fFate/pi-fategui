import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession, ModelRuntime, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import type { PiEvent } from '../../shared/contracts/ipc';
import { emptyUsage, type SubagentChildSessionFactory } from './SubagentSessionFactory';
import type { SubagentWorkflow } from './SubagentWorkflow';
import { AgentWorkflowCoordinator } from './AgentWorkflowCoordinator';
import { AgentTeamCoordinator } from './multi-agent/AgentTeamCoordinator';

const model = { provider: 'test', id: 'primary', name: 'Primary', reasoning: true, contextWindow: 128_000, input: ['text'] } as const;
const fallback = { ...model, id: 'fallback', name: 'Fallback' } as const;
const modelRuntime = {
  getAvailable: vi.fn(async () => [model, fallback]),
  getModel: vi.fn((provider: string, id: string) => [model, fallback].find((candidate) => candidate.provider === provider && candidate.id === id)),
} as unknown as ModelRuntime;

type PlannedResult = { status: 'completed' | 'failed'; text?: string; usage?: Partial<ReturnType<typeof emptyUsage>>; hold?: boolean; missingEnvelope?: boolean; resultTransportError?: string };

function harness(plans: PlannedResult[]) {
  let sequence = 0;
  const nodes = new Map<string, any>();
  const settlements = new Map<string, { promise: Promise<any>; resolve: (value: any) => void }>();
  const activityListeners = new Map<string, Set<() => void>>();
  const spawnInputs: any[] = [];
  const spawnOptions: any[] = [];
  const tasks: any[] = [];
  const envelopes: any[] = [];
  const operationReceipts: any[] = [];
  const release = vi.fn(async (_root: string, nodeId: string) => { nodes.get(nodeId).status = 'released'; });
  const interrupt = vi.fn(async (_root: string, nodeId: string, reason?: string) => {
    const node = nodes.get(nodeId);
    if (node) node.status = 'interrupted';
    settlements.get(nodeId)?.resolve({ task: { status: 'interrupted', error: reason, startedAt: 1, endedAt: 2 } });
    return { nodeId, path: node?.path ?? '/root/missing', status: 'interrupted' };
  });
  const teams = {
    rootNodeId: vi.fn(() => 'root-node'),
    selectedTeamId: vi.fn(() => 'team-1'),
    getTeams: vi.fn(() => [{
      id: 'team-1', rootNodeId: 'root-node', selected: true, limits: { maxNodes: 16, maxActiveTurns: 3, maxMessages: 256, maxMessageBytes: 32 * 1024 },
      nodes: [{ id: 'root-node', depth: 0, handle: 'root', displayName: 'Root', status: 'ready' }, ...nodes.values()],
      tasks, envelopes, operationReceipts,
    }]),
    inspectNode: vi.fn((_root: string, target: string) => {
      if (target === 'root-node') return { teamId: 'team-1', node: { id: 'root-node', depth: 0, handle: 'root', displayName: 'Root', status: 'ready' } };
      return { teamId: 'team-1', node: nodes.get(target) };
    }),
    spawn: vi.fn(async (_root: string, input: any, _operationId: string, _runtime: ModelRuntime, _signal: AbortSignal, options: any) => {
      spawnInputs.push(structuredClone(input));
      spawnOptions.push(structuredClone(options));
      const plan = plans.shift() ?? { status: 'completed', text: 'ok' };
      const nodeId = `node-${++sequence}`;
      const selectedModel = input.model?.id === 'fallback' ? fallback : model;
      const node = {
        id: nodeId, depth: 1, path: `/root/${nodeId}`, handle: nodeId, displayName: input.name,
        status: 'active', createdAt: sequence, updatedAt: Date.now(), permissionLevel: input.permission,
        enabledTools: input.tools ?? ['read'], thinkingLevel: input.thinkingLevel ?? 'medium', model: selectedModel,
        usage: { ...emptyUsage(), turns: 1, ...(plan.usage ?? {}) },
      };
      nodes.set(nodeId, node);
      let resolve!: (value: any) => void;
      const promise = new Promise<any>((done) => { resolve = done; });
      settlements.set(nodeId, { promise, resolve });
      if (!plan.hold) queueMicrotask(() => {
        node.status = plan.status === 'completed' ? 'ready' : 'failed';
        resolve({
          task: {
            status: plan.status === 'completed' ? 'completed' : 'failed',
            ...(plan.status === 'failed' ? { error: plan.text ?? 'failed' } : {}),
            ...(plan.resultTransportError ? { resultTransportError: plan.resultTransportError } : {}),
            startedAt: Date.now() - 1,
            endedAt: Date.now(),
          },
          ...(plan.missingEnvelope ? {} : { envelope: { content: plan.text ?? '(no text output)' } }),
        });
      });
      return { nodeId, path: node.path, handle: node.handle, status: node.status };
    }),
    waitForTaskSettlement: vi.fn(async (_root: string, nodeId: string) => settlements.get(nodeId)!.promise),
    subscribeNodeActivity: vi.fn((_root: string, nodeId: string, listener: () => void) => {
      let listeners = activityListeners.get(nodeId);
      if (!listeners) {
        listeners = new Set();
        activityListeners.set(nodeId, listeners);
      }
      listeners.add(listener);
      return vi.fn(() => {
        listeners!.delete(listener);
        if (listeners!.size === 0) activityListeners.delete(nodeId);
      });
    }),
    release,
    interrupt,
  };
  const events: PiEvent[] = [];
  const snapshots: SubagentWorkflow[] = [];
  const notifications: Array<{ mode: string; text: string; runIds: string[]; workflowId?: string }> = [];
  const session = {
    sessionId: 'parent-1', model, thinkingLevel: 'medium', messages: [],
    sessionManager: { getSessionId: () => 'parent-1', getBranch: () => [], appendCustomEntry: vi.fn() },
  } as unknown as AgentSession;
  const coordinator = new AgentWorkflowCoordinator(teams as unknown as AgentTeamCoordinator, {
    resolveParent: () => ({ projectPath: '/project', session }),
    emit: (_parent, event) => events.push(event),
    persist: (_parent, workflow) => snapshots.push(structuredClone(workflow)),
    notifyParent: async (_parent, mode, text, runIds, workflowId) => { notifications.push({ mode, text, runIds, ...(workflowId ? { workflowId } : {}) }); },
  });
  const tool = coordinator.createTool(modelRuntime);
  return { coordinator, tool, teams, session, spawnInputs, spawnOptions, events, snapshots, notifications, interrupt, release, nodes, tasks, envelopes, operationReceipts, settlements, activityListeners };
}

function execute(tool: ToolDefinition, id: string, params: unknown) {
  return tool.execute(id, params as never, undefined, undefined, { cwd: '/project', sessionManager: { getSessionId: () => 'parent-1' } } as never);
}

interface RealPromptContext {
  childNumber: number;
  input: Parameters<SubagentChildSessionFactory>[0];
  text: string;
  aborted: Promise<'aborted'>;
}

async function realTeamHarness(promptHandler: (context: RealPromptContext) => Promise<string>) {
  const dataRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fate-workflow-team-test-')));
  const rootMessages: unknown[] = [];
  const root = {
    sessionId: 'parent-1', model, thinkingLevel: 'medium', messages: rootMessages,
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    sessionManager: { getSessionId: () => 'parent-1', getBranch: () => [], appendCustomEntry: vi.fn() },
    sendCustomMessage: vi.fn(async (message: unknown) => { rootMessages.push(message); }),
    isStreaming: false,
  } as unknown as AgentSession;
  const children: AgentSession[] = [];
  let activePrompts = 0;
  let maximumActivePrompts = 0;
  const childFactory: SubagentChildSessionFactory = vi.fn(async (input) => {
    const childNumber = children.length + 1;
    const messages: unknown[] = [];
    let releaseAbort!: () => void;
    const aborted = new Promise<'aborted'>((resolve) => { releaseAbort = () => resolve('aborted'); });
    const session = {
      sessionId: `child-${childNumber}`, model: input.model, thinkingLevel: input.thinkingLevel, messages,
      sessionManager: { getSessionId: () => `child-${childNumber}` },
      resourceLoader: { getSkills: () => ({ skills: [] }) },
      subscribe: vi.fn(() => () => undefined),
      prompt: vi.fn(async (text: string) => {
        messages.push({ role: 'user', content: text });
        activePrompts += 1;
        maximumActivePrompts = Math.max(maximumActivePrompts, activePrompts);
        try {
          const result = await promptHandler({ childNumber, input, text, aborted });
          messages.push({ role: 'assistant', content: [{ type: 'text', text: result }], stopReason: 'stop' });
        } finally {
          activePrompts -= 1;
        }
      }),
      sendCustomMessage: vi.fn(),
      abort: vi.fn(async () => { releaseAbort(); }),
      dispose: vi.fn(),
      isStreaming: false,
    } as unknown as AgentSession;
    children.push(session);
    return session;
  });
  const teams = new AgentTeamCoordinator({
    resolveRoot: () => ({ projectPath: dataRoot, session: root, permissionLevel: 'read-only' }),
    getAgentWorkspacePolicy: () => ({ preferredMode: 'shared', strict: false }),
    emit: () => undefined,
    persist: () => undefined,
  }, dataRoot, childFactory);
  const coordinator = new AgentWorkflowCoordinator(teams, {
    resolveParent: () => ({ projectPath: dataRoot, session: root }),
    emit: () => undefined,
    persist: () => undefined,
  });
  const tool = coordinator.createTool(modelRuntime);
  const context = { cwd: dataRoot, sessionManager: { getSessionId: () => 'parent-1' } } as never;
  return {
    dataRoot, root, children, teams, coordinator, tool, context,
    maximumActivePrompts: () => maximumActivePrompts,
    cleanup: async () => {
      if (coordinator.hasAnyActive()) await coordinator.cancelAll().catch(() => undefined);
      coordinator.reset();
      await teams.cancelAll();
      await fs.rm(dataRoot, { recursive: true, force: true });
    },
  };
}

describe('AgentWorkflowCoordinator', () => {
  it('validates the graph and routes dependency scheduling, context, workspace, and budgets through Team nodes', async () => {
    const run = harness([
      { status: 'completed', text: 'foundation result', usage: { turns: 2 } },
      { status: 'completed', text: 'review result', usage: { turns: 1 } },
      { status: 'completed', text: 'integration result', usage: { turns: 1 } },
    ]);
    await expect(execute(run.tool, 'cycle', {
      action: 'start', nodes: [{ id: 'a', task: 'a', dependsOn: ['b'] }, { id: 'b', task: 'b', dependsOn: ['a'] }],
    })).rejects.toThrow(/Invalid workflow graph/u);
    expect(run.teams.spawn).not.toHaveBeenCalled();

    const started = await execute(run.tool, 'dag', {
      action: 'start', maxConcurrency: 2, budget: { maxTurns: 1 }, nodes: [
        { id: 'foundation', task: 'Build foundation', permission: 'edit', tools: ['read', 'write'], workspace: { mode: 'shared' }, budget: { maxTurns: 1 } },
        { id: 'review', task: 'Review foundation', dependsOn: ['foundation'], includeDependencyResults: true },
        { id: 'integration', task: 'Integrate', dependsOn: ['review'], includeDependencyResults: true },
      ],
    });
    const workflowId = (started.details as { workflowIds: string[] }).workflowIds[0]!;
    await vi.waitFor(() => expect(run.coordinator.getWorkflowViews('parent-1')[0]?.status).toBe('completed'));

    expect(run.spawnInputs[0]).toMatchObject({ task: 'Build foundation', permission: 'edit', tools: ['read', 'write'], workspace: { mode: 'shared' } });
    expect(run.spawnOptions[0]).toEqual({ allowDelegation: false, deliverFinalAnswer: false });
    expect(run.spawnInputs[1].task).toContain('<dependency-result node="foundation" status="completed">\nfoundation result');
    expect(run.spawnInputs[2].task).toContain('<dependency-result node="review" status="completed">\nreview result');
    expect(run.coordinator.getWorkflowViews('parent-1')[0]).toMatchObject({
      id: workflowId,
      status: 'completed',
      usage: { turns: 4 },
      nodes: [expect.objectContaining({ runId: 'node-1' }), expect.objectContaining({ runId: 'node-2' }), expect.objectContaining({ runId: 'node-3' })],
      livenessReports: expect.arrayContaining([expect.objectContaining({ trigger: 'adaptive-limit', reason: expect.stringContaining('foundation') })]),
    });
    expect(run.release).toHaveBeenCalledTimes(3);
  });

  it('treats positive runtime and observable-Team-idle thresholds as advisory checkpoints', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const run = harness([{ status: 'completed', text: 'eventually complete', hold: true }]);
      await execute(run.tool, 'timed', {
        action: 'start', nodes: [{ id: 'timed', task: 'Timed task', timeoutSeconds: 1, idleTimeoutSeconds: 1 }],
      });
      await vi.waitFor(() => expect(run.teams.spawn).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(750);
      run.nodes.get('node-1').updatedAt = Date.now();
      await vi.advanceTimersByTimeAsync(251);
      expect(run.coordinator.getWorkflowViews('parent-1')[0]?.livenessReports).toEqual(expect.arrayContaining([
        expect.objectContaining({ trigger: 'runtime-limit', evidence: [expect.objectContaining({ signal: 'runtime-duration' })] }),
      ]));
      expect(run.coordinator.getWorkflowViews('parent-1')[0]?.livenessReports?.some((report) => report.trigger === 'idle')).toBe(false);
      await vi.advanceTimersByTimeAsync(750);
      expect(run.coordinator.getWorkflowViews('parent-1')[0]?.livenessReports).toEqual(expect.arrayContaining([
        expect.objectContaining({
          trigger: 'idle',
          evidence: [expect.objectContaining({ signal: 'idle-duration', detail: expect.stringContaining('last observable Agent Team node update') })],
          timing: expect.objectContaining({ lastObservableTeamUpdateAt: expect.any(Number) }),
        }),
      ]));
      expect(run.coordinator.getWorkflowViews('parent-1')[0]).toMatchObject({ status: 'running', nodes: [expect.objectContaining({ status: 'running' })] });
      run.nodes.get('node-1').status = 'ready';
      run.settlements.get('node-1')!.resolve({ task: { status: 'completed', startedAt: 1_000, endedAt: Date.now() }, envelope: { content: 'eventually complete' } });
      await vi.waitFor(() => expect(run.coordinator.getWorkflowViews('parent-1')[0]?.status).toBe('completed'));
      expect(run.teams.spawn).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('observes configured node budgets before prompt settlement and tears down the bounded activity observer', async () => {
    const run = harness([{ status: 'completed', text: 'held after usage', hold: true }]);
    await execute(run.tool, 'live-budget', {
      action: 'start', nodes: [{ id: 'budgeted', task: 'Hold after message completion', budget: { maxInputTokens: 5 } }],
    });
    await vi.waitFor(() => expect(run.teams.spawn).toHaveBeenCalledOnce());
    expect(run.activityListeners.get('node-1')?.size).toBe(1);
    expect(run.coordinator.getWorkflowViews('parent-1')[0]).toMatchObject({ status: 'running', nodes: [expect.objectContaining({ status: 'running' })] });

    run.nodes.get('node-1').usage = { ...emptyUsage(), input: 6, output: 2, contextTokens: 8, turns: 1 };
    for (const listener of run.activityListeners.get('node-1') ?? []) listener();

    const live = run.coordinator.getWorkflowViews('parent-1')[0]!;
    expect(live.status).toBe('running');
    expect(live.livenessReports).toEqual(expect.arrayContaining([
      expect.objectContaining({
        trigger: 'resource-limit',
        node: { id: 'budgeted', runId: 'node-1' },
        evidence: [expect.objectContaining({ signal: 'input-token-threshold', count: 6 })],
      }),
    ]));
    run.nodes.get('node-1').status = 'ready';
    run.settlements.get('node-1')!.resolve({ task: { status: 'completed', startedAt: 1, endedAt: 2 }, envelope: { content: 'held after usage' } });
    await vi.waitFor(() => expect(run.coordinator.getWorkflowViews('parent-1')[0]?.status).toBe('completed'));
    expect(run.activityListeners.has('node-1')).toBe(false);
    expect(run.coordinator.getWorkflowViews('parent-1')[0]?.livenessReports?.filter((report) => report.evidence.some((item) => item.signal === 'input-token-threshold'))).toHaveLength(1);
  });

  it('normalizes positive fractional durations to engine-safe integer milliseconds and rejects unsafe values before launch', async () => {
    const run = harness([{ status: 'completed', text: 'fractional durations preserved' }]);
    await execute(run.tool, 'fractional-durations', {
      action: 'start', nodes: [{
        id: 'fractional', task: 'Preserve fractional durations',
        timeoutSeconds: 0.0001, idleTimeoutSeconds: 1.2341, mailboxTtlSeconds: 2.5,
      }],
    });
    await vi.waitFor(() => expect(run.coordinator.getWorkflowViews('parent-1')[0]?.status).toBe('completed'));
    expect(run.spawnOptions[0]).toEqual({ allowDelegation: false, deliverFinalAnswer: false, idleReleaseMs: 2_500 });
    expect(run.snapshots.find((snapshot) => snapshot.nodes[0]?.request.timeoutMs === 1)?.nodes[0]?.request).toMatchObject({
      timeoutMs: 1, idleTimeoutMs: 1_235, mailboxTtlMs: 2_500,
    });

    const unsafe = harness([]);
    await expect(execute(unsafe.tool, 'unsafe-duration', {
      action: 'start', nodes: [
        { id: 'would-run', task: 'Must not run' },
        { id: 'unsafe', task: 'Unsafe duration', mailboxTtlSeconds: Number.MAX_SAFE_INTEGER / 1_000 + 1 },
      ],
    })).rejects.toThrow(/invalid mailboxTtlSeconds[\s\S]*safe integer milliseconds[\s\S]*Nothing was started/u);
    expect(unsafe.teams.spawn).not.toHaveBeenCalled();
  });

  it('preflights retained and finite Team ledger capacity but permits logical graphs beyond sixteen nodes', async () => {
    const run = harness([]);
    await expect(execute(run.tool, 'retained-overflow', {
      action: 'start',
      nodes: [
        ...Array.from({ length: 16 }, (_, index) => ({ id: `retained-${index}`, task: `Retained ${index}`, mailboxTtlSeconds: 60 })),
        { id: 'transient', task: 'Needs a transient slot' },
      ],
    })).rejects.toThrow(/requires 17 simultaneous Team node slots[\s\S]*no partial graph/u);
    expect(run.teams.spawn).not.toHaveBeenCalled();

    run.envelopes.push(...Array.from({ length: 255 }, (_, index) => ({ id: `existing-${index}` })));
    await expect(execute(run.tool, 'ledger-overflow', {
      action: 'start', nodes: [{ id: 'one-more', task: 'Would require input and result envelopes' }],
    })).rejects.toThrow(/requires 2 additional message envelopes[\s\S]*255\/256 occupied[\s\S]*nothing was started/iu);
    expect(run.teams.spawn).not.toHaveBeenCalled();
    run.envelopes.length = 0;

    const retryFootprint = harness([]);
    await expect(execute(retryFootprint.tool, 'retry-ledger-overflow', {
      action: 'start',
      nodes: Array.from({ length: 65 }, (_, index) => ({
        id: `retry-${index}`, task: `Retry ${index}`,
        routing: { fallbackModels: [{ provider: 'test', id: 'fallback' }], maxAttempts: 2 },
      })),
    })).rejects.toThrow(/requires 260 additional message envelopes[\s\S]*nothing was started/iu);
    expect(retryFootprint.teams.spawn).not.toHaveBeenCalled();

    const oversizedInput = harness([]);
    await expect(execute(oversizedInput.tool, 'oversized-input', {
      action: 'start', nodes: [{ id: 'oversized', task: '😀'.repeat(9_000) }],
    })).rejects.toThrow(/36000-byte input envelope[\s\S]*32768-byte limit[\s\S]*Nothing was started/u);
    expect(oversizedInput.teams.spawn).not.toHaveBeenCalled();

    await execute(run.tool, 'large-sequential', {
      action: 'start', maxConcurrency: 1,
      nodes: Array.from({ length: 17 }, (_, index) => ({
        id: `node-${index}`,
        task: `Task ${index}`,
        ...(index ? { dependsOn: [`node-${index - 1}`] } : {}),
      })),
    });
    await vi.waitFor(() => expect(run.coordinator.getWorkflowViews('parent-1')[0]?.status).toBe('completed'));
    expect(run.teams.spawn).toHaveBeenCalledTimes(17);
    expect(run.release).toHaveBeenCalledTimes(17);
  });

  it('retains a successful workflow Team node for the requested mailbox lifetime', async () => {
    const run = harness([{ status: 'completed', text: 'retained result' }]);
    await execute(run.tool, 'retained', {
      action: 'start', nodes: [{ id: 'retained', task: 'Retained task', mailboxTtlSeconds: 60 }],
    });
    await vi.waitFor(() => expect(run.coordinator.getWorkflowViews('parent-1')[0]?.status).toBe('completed'));
    expect(run.release).not.toHaveBeenCalled();
    expect(run.spawnOptions[0]).toEqual({ allowDelegation: false, deliverFinalAnswer: false, idleReleaseMs: 60_000 });
    expect(run.coordinator.getWorkflowViews('parent-1')[0]?.nodes[0]).toMatchObject({ status: 'completed', runId: 'node-1' });
    run.coordinator.reset();
  });

  it('reports missing result transport as explicit non-retryable failure and applies dependency policy', async () => {
    const run = harness([
      { status: 'completed', text: 'must not be trusted after transport failure', resultTransportError: 'FINAL_ANSWER transport failed after execution.' },
      { status: 'completed', text: 'ran under dependencyFailure=run' },
    ]);
    await execute(run.tool, 'missing-result', {
      action: 'start', maxConcurrency: 1, nodes: [
        { id: 'side-effect', task: 'Execute exactly once', routing: { fallbackModels: [{ provider: 'test', id: 'fallback' }], maxAttempts: 2 } },
        { id: 'skip', task: 'Skip without trustworthy result', dependsOn: ['side-effect'], dependencyFailure: 'skip' },
        { id: 'run', task: 'Run despite transport failure', dependsOn: ['side-effect'], dependencyFailure: 'run', includeDependencyResults: true },
      ],
    });
    await vi.waitFor(() => expect(run.coordinator.getWorkflowViews('parent-1')[0]?.status).toBe('error'));
    expect(run.teams.spawn).toHaveBeenCalledTimes(2);
    expect(run.coordinator.getWorkflowViews('parent-1')[0]?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'side-effect', status: 'error', error: expect.stringContaining('execution succeeded, but its result is unavailable') }),
      expect.objectContaining({ id: 'skip', status: 'skipped' }),
      expect.objectContaining({ id: 'run', status: 'completed' }),
    ]));
    expect(run.spawnInputs[1].task).toContain('<dependency-result node="side-effect" status="error">');
    expect(run.spawnInputs[1].task).toContain('will not rerun this side-effectful task');
    expect(run.spawnInputs[1].task).not.toContain('must not be trusted after transport failure');
  });

  it('does not downgrade or retry completed Team work when zero-TTL cleanup loses a follow-up race', async () => {
    const run = harness([{ status: 'completed', text: 'authoritative success' }]);
    run.release.mockRejectedValueOnce(new Error('Cannot release while work is active.'));
    await execute(run.tool, 'cleanup-race', {
      action: 'start', nodes: [{ id: 'success', task: 'Complete once', routing: { fallbackModels: [{ provider: 'test', id: 'fallback' }], maxAttempts: 2 } }],
    });
    await vi.waitFor(() => expect(run.coordinator.getWorkflowViews('parent-1')[0]?.status).toBe('completed'));
    expect(run.teams.spawn).toHaveBeenCalledOnce();
    expect(run.coordinator.getWorkflowViews('parent-1')[0]?.nodes[0]).toMatchObject({ status: 'completed' });
  });

  it('preserves never, next-turn, and immediate notification delivery modes', async () => {
    const silent = harness([{ status: 'completed', text: 'silent' }]);
    await execute(silent.tool, 'silent-notify', { action: 'start', nodes: [{ id: 'silent', task: 'Silent', notifyParent: 'never' }] });
    await vi.waitFor(() => expect(silent.coordinator.getWorkflowViews('parent-1')[0]?.status).toBe('completed'));
    expect(silent.notifications).toEqual([]);

    const delivered = harness([{ status: 'completed', text: 'node' }]);
    await execute(delivered.tool, 'delivered-notify', {
      action: 'start', notifyParent: 'immediate', nodes: [{ id: 'node', task: 'Notify', notifyParent: 'next-turn' }],
    });
    await vi.waitFor(() => expect(delivered.coordinator.getWorkflowViews('parent-1')[0]?.status).toBe('completed'));
    expect(delivered.notifications.map((notification) => notification.mode)).toEqual(['next-turn', 'immediate']);
  });

  it('suppresses lifecycle-cancellation notifications without mutating policy, and a fresh explicit resume keeps it', async () => {
    const stopped = harness([{ status: 'completed', hold: true }]);
    const started = await execute(stopped.tool, 'lifecycle-stop', {
      action: 'start', notifyParent: 'immediate', nodes: [{ id: 'held', task: 'Wait for Stop', notifyParent: 'immediate' }],
    });
    const workflowId = (started.details as { workflowIds: string[] }).workflowIds[0]!;
    await vi.waitFor(() => expect(stopped.teams.spawn).toHaveBeenCalledOnce());
    const resumableSnapshot = structuredClone(stopped.snapshots.find((snapshot) => snapshot.id === workflowId && snapshot.status === 'running')!);

    await stopped.coordinator.cancelParent('parent-1');

    expect(stopped.notifications).toEqual([]);
    expect(stopped.coordinator.getWorkflowViews('parent-1')[0]).toMatchObject({ status: 'cancelled', notification: 'immediate' });

    const resumed = harness([{ status: 'completed', text: 'fresh resumed completion' }]);
    resumableSnapshot.status = 'running';
    resumableSnapshot.notification = 'immediate';
    resumableSnapshot.nodes[0]!.status = 'running';
    resumableSnapshot.nodes[0]!.request.notification = 'immediate';
    (resumed.session.sessionManager.getBranch as unknown as ReturnType<typeof vi.fn>) = vi.fn(() => [{
      type: 'custom', customType: 'fate-subagent-workflow', data: { kind: 'fate-subagent-workflow-snapshot', version: 1, workflow: resumableSnapshot },
    }]);
    resumed.coordinator.restoreParent(resumed.session);
    expect(resumed.coordinator.getWorkflowViews('parent-1')[0]).toMatchObject({ status: 'paused', notification: 'immediate' });
    await execute(resumed.tool, 'lifecycle-resume', { action: 'resume', workflowId });
    await vi.waitFor(() => expect(resumed.coordinator.getWorkflowViews('parent-1')[0]?.status).toBe('completed'));
    expect(resumed.notifications.map((notification) => notification.mode)).toEqual(['immediate', 'immediate']);
  });

  it('surfaces Team workspace-policy admission failures without a legacy fallback', async () => {
    const run = harness([]);
    vi.mocked(run.teams.spawn).mockRejectedValue(new Error('Strict workspace policy requires worktree mode.'));
    await execute(run.tool, 'strict-policy', {
      action: 'start', nodes: [{ id: 'policy', task: 'Respect policy', workspace: { mode: 'shared' } }],
    });
    await vi.waitFor(() => expect(run.coordinator.getWorkflowViews('parent-1')[0]?.status).toBe('error'));
    expect(run.coordinator.getWorkflowViews('parent-1')[0]?.nodes[0]).toMatchObject({
      status: 'error', error: 'Strict workspace policy requires worktree mode.',
    });
    expect(run.teams.spawn).toHaveBeenCalledOnce();
  });

  it('inherits the primary model before trying an explicit fallback', async () => {
    const run = harness([
      { status: 'failed', text: 'primary runtime failed' },
      { status: 'completed', text: 'fallback recovered' },
    ]);
    await execute(run.tool, 'inherited-routing', {
      action: 'start', nodes: [{
        id: 'retry', task: 'Retry after inheritance',
        routing: { fallbackModels: [{ provider: 'test', id: 'fallback' }], maxAttempts: 2 },
      }],
    });
    await vi.waitFor(() => expect(run.coordinator.getWorkflowViews('parent-1')[0]?.status).toBe('completed'));
    expect(run.spawnInputs[0].model).toBeUndefined();
    expect(run.spawnInputs[1].model).toEqual({ provider: 'test', id: 'fallback' });
  });

  it('uses explicit fallback routing and honors skip/run dependency failure behavior', async () => {
    const run = harness([
      { status: 'failed', text: 'primary failed' },
      { status: 'completed', text: 'fallback recovered' },
      { status: 'failed', text: 'hard failure' },
      { status: 'completed', text: 'ran after failure' },
    ]);
    await execute(run.tool, 'routing', {
      action: 'start', maxConcurrency: 1, nodes: [
        { id: 'retry', task: 'Retry exactly', model: { provider: 'test', id: 'primary' }, routing: { fallbackModels: [{ provider: 'test', id: 'fallback' }], maxAttempts: 2 } },
        { id: 'failure', task: 'Fail', dependsOn: ['retry'] },
        { id: 'skip', task: 'Skip me', dependsOn: ['failure'], dependencyFailure: 'skip' },
        { id: 'run', task: 'Run anyway', dependsOn: ['failure'], dependencyFailure: 'run', includeDependencyResults: true },
      ],
    });
    await vi.waitFor(() => expect(run.coordinator.getWorkflowViews('parent-1')[0]?.status).toBe('error'));

    expect(run.spawnInputs.slice(0, 2).map((input) => input.model.id)).toEqual(['primary', 'fallback']);
    expect(run.spawnInputs[3].task).toContain('<dependency-result node="failure" status="error">');
    expect(run.coordinator.getWorkflowViews('parent-1')[0]?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'retry', status: 'completed', runId: 'node-2' }),
      expect.objectContaining({ id: 'skip', status: 'skipped' }),
      expect.objectContaining({ id: 'run', status: 'completed' }),
    ]));
  });

  it('cancels active Team nodes without retrying interruption and restored workflows resume only explicitly', async () => {
    const active = harness([{ status: 'completed', hold: true }]);
    const started = await execute(active.tool, 'cancel-start', {
      action: 'start',
      nodes: [{ id: 'held', task: 'Wait', routing: { fallbackModels: [{ provider: 'test', id: 'fallback' }], maxAttempts: 2 } }],
    });
    const workflowId = (started.details as { workflowIds: string[] }).workflowIds[0]!;
    await vi.waitFor(() => expect(active.teams.spawn).toHaveBeenCalledOnce());
    await execute(active.tool, 'cancel', { action: 'cancel', workflowId, reason: 'Stop graph' });
    expect(active.interrupt).toHaveBeenCalledWith('root-node', 'node-1', 'Stop graph');
    expect(active.release).toHaveBeenCalledWith('root-node', 'node-1', true);
    expect(active.teams.spawn).toHaveBeenCalledOnce();
    expect(active.coordinator.getWorkflowViews('parent-1')[0]).toMatchObject({ status: 'cancelled' });

    const snapshot = active.snapshots.find((candidate) => candidate.status === 'running')!;
    const resumed = harness([{ status: 'completed', text: 'resumed' }]);
    vi.mocked(resumed.teams.rootNodeId).mockReturnValue('selected-root');
    vi.mocked(resumed.teams.getTeams).mockImplementation(() => [{
      id: 'team-1', rootNodeId: 'root-node', selected: false, limits: { maxNodes: 16, maxActiveTurns: 3, maxMessages: 256, maxMessageBytes: 32 * 1024 },
      nodes: [{ id: 'root-node', depth: 0, handle: 'root', displayName: 'Root', status: 'ready' }], tasks: [], envelopes: [], operationReceipts: [],
    }, {
      id: 'team-2', rootNodeId: 'selected-root', selected: true, limits: { maxNodes: 16, maxActiveTurns: 3, maxMessages: 256, maxMessageBytes: 32 * 1024 },
      nodes: [{ id: 'selected-root', depth: 0, handle: 'root', displayName: 'Root', status: 'ready' }], tasks: [], envelopes: [], operationReceipts: [],
    }] as never);
    (resumed.session.sessionManager.getBranch as unknown as ReturnType<typeof vi.fn>) = vi.fn(() => [{
      type: 'custom', customType: 'fate-subagent-workflow', data: { kind: 'fate-subagent-workflow-snapshot', version: 1, workflow: snapshot },
    }]);
    resumed.coordinator.restoreParent(resumed.session);
    expect(resumed.coordinator.getWorkflowViews('parent-1')[0]).toMatchObject({ status: 'paused', nodes: [expect.objectContaining({ status: 'interrupted' })] });
    expect(resumed.teams.spawn).not.toHaveBeenCalled();
    await execute(resumed.tool, 'resume', { action: 'resume', workflowId });
    await vi.waitFor(() => expect(resumed.coordinator.getWorkflowViews('parent-1')[0]?.status).toBe('completed'));
    expect(resumed.teams.spawn).toHaveBeenCalledOnce();
    expect(resumed.teams.spawn).toHaveBeenCalledWith('root-node', expect.any(Object), expect.any(String), modelRuntime, expect.any(AbortSignal), { allowDelegation: false, deliverFinalAnswer: false });
  });

  it('surfaces Team interruption failures from workflow cancellation', async () => {
    const run = harness([{ status: 'completed', hold: true }]);
    await execute(run.tool, 'cancel-error-start', { action: 'start', nodes: [{ id: 'held', task: 'Wait' }] });
    await vi.waitFor(() => expect(run.teams.spawn).toHaveBeenCalledOnce());
    const interrupt = run.interrupt.getMockImplementation()!;
    run.interrupt.mockImplementation(async (...args: Parameters<typeof interrupt>) => {
      await interrupt(...args);
      throw new Error('interrupt failed after settlement');
    });
    const workflowId = run.coordinator.getWorkflowViews('parent-1')[0]!.id;
    await expect(execute(run.tool, 'cancel-error', { action: 'cancel', workflowId })).rejects.toThrow('interrupt failed after settlement');
  });

  it('recycles real Team capacity across a sequential graph larger than sixteen nodes', async () => {
    const run = await realTeamHarness(async ({ input }) => `result:${input.teamIdentity?.path}`);
    try {
      await run.tool.execute('real-large-sequential', {
        action: 'start',
        nodes: Array.from({ length: 20 }, (_, index) => ({
          id: `step-${index}`,
          task: `Step ${index}`,
          mailboxTtlSeconds: 0,
          ...(index ? { dependsOn: [`step-${index - 1}`] } : {}),
        })),
      } as never, undefined, undefined, run.context);
      await vi.waitFor(() => expect(run.coordinator.getWorkflowViews('parent-1')[0]?.status).toBe('completed'));
      expect(run.children).toHaveLength(20);
      expect(run.teams.getTeams('parent-1')[0]?.nodes.filter((node) => node.depth > 0 && node.status !== 'released')).toHaveLength(0);
    } finally {
      await run.cleanup();
    }
  });

  it('preserves default workflow concurrency four as an upper bound under the real Team active-turn limit three', async () => {
    let releasePrompts!: () => void;
    const promptGate = new Promise<void>((resolve) => { releasePrompts = resolve; });
    const run = await realTeamHarness(async () => { await promptGate; return 'done'; });
    try {
      const started = await run.tool.execute('real-default-concurrency', {
        action: 'start',
        nodes: Array.from({ length: 6 }, (_, index) => ({ id: `parallel-${index}`, task: `Parallel ${index}`, mailboxTtlSeconds: 0 })),
      } as never, undefined, undefined, run.context);
      expect(run.coordinator.getWorkflowViews('parent-1').find((workflow) => workflow.id === (started.details as { workflowIds: string[] }).workflowIds[0])?.maxConcurrency).toBe(4);
      await vi.waitFor(() => expect(run.children).toHaveLength(3));
      expect(run.maximumActivePrompts()).toBe(3);
      releasePrompts();
      await vi.waitFor(() => expect(run.coordinator.getWorkflowViews('parent-1')[0]?.status).toBe('completed'));
      expect(run.children).toHaveLength(6);
      expect(run.maximumActivePrompts()).toBe(3);
    } finally {
      releasePrompts();
      await run.cleanup();
    }
  });

  it('emits a real-Team runtime checkpoint without aborting or retrying the active node', async () => {
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const run = await realTeamHarness(async () => { await promptGate; return 'finished after advisory'; });
    try {
      await run.tool.execute('real-advisory', {
        action: 'start', nodes: [{ id: 'advisory', task: 'Continue past checkpoint', timeoutSeconds: 1, mailboxTtlSeconds: 0 }],
      } as never, undefined, undefined, run.context);
      await vi.waitFor(() => expect(run.children).toHaveLength(1));
      await vi.waitFor(() => expect(run.coordinator.getWorkflowViews('parent-1')[0]?.livenessReports?.some((report) => report.trigger === 'runtime-limit')).toBe(true), { timeout: 2_500 });
      expect(run.coordinator.getWorkflowViews('parent-1')[0]).toMatchObject({ status: 'running', nodes: [expect.objectContaining({ status: 'running' })] });
      expect(run.children[0]!.abort).not.toHaveBeenCalled();
      releasePrompt();
      await vi.waitFor(() => expect(run.coordinator.getWorkflowViews('parent-1')[0]?.status).toBe('completed'));
      expect(run.children).toHaveLength(1);
    } finally {
      releasePrompt();
      await run.cleanup();
    }
  }, 10_000);

  it('leaves retained workflow mailbox follow-up and expiry entirely to the real Team engine', async () => {
    const run = await realTeamHarness(async ({ text }) => `answer:${text}`);
    try {
      await run.tool.execute('real-retained', {
        action: 'start', nodes: [{ id: 'retained', task: 'Initial retained task', mailboxTtlSeconds: 1 }],
      } as never, undefined, undefined, run.context);
      await vi.waitFor(() => expect(run.coordinator.getWorkflowViews('parent-1')[0]?.status).toBe('completed'));
      const workflowNode = run.coordinator.getWorkflowViews('parent-1')[0]!.nodes[0]!;
      const rootNodeId = run.teams.getTeams('parent-1')[0]!.rootNodeId;
      const firstDeadline = run.teams.getTeams('parent-1')[0]!.nodes.find((node) => node.id === workflowNode.runId)!.idleReleaseAt!;
      const followup = await run.teams.followUp(rootNodeId, workflowNode.runId!, 'Engine-owned follow-up', 'workflow-followup', modelRuntime);
      await vi.waitFor(() => {
        const team = run.teams.getTeams('parent-1')[0]!;
        expect(team.tasks.find((task) => task.id === followup.taskId)?.status).toBe('completed');
        expect(team.nodes.find((node) => node.id === workflowNode.runId)?.idleReleaseAt).toBeGreaterThan(firstDeadline);
      });
      expect(run.children).toHaveLength(1);
      await vi.waitFor(() => expect(run.teams.getTeams('parent-1')[0]!.nodes.find((node) => node.id === workflowNode.runId)?.status).toBe('released'), { timeout: 2_500 });
    } finally {
      await run.cleanup();
    }
  }, 10_000);

  it('keeps a real Team graph bound to its original root across selection change and cancellation', async () => {
    const dataRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fate-workflow-team-test-')));
    try {
      const rootMessages: unknown[] = [];
      const root = {
        sessionId: 'parent-1', model, thinkingLevel: 'medium', messages: rootMessages,
        resourceLoader: { getSkills: () => ({ skills: [] }) },
        sessionManager: { getSessionId: () => 'parent-1', getBranch: () => [], appendCustomEntry: vi.fn() },
        sendCustomMessage: vi.fn(async (message: unknown) => { rootMessages.push(message); }),
        isStreaming: false,
      } as unknown as AgentSession;
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const children: AgentSession[] = [];
      const childFactory: SubagentChildSessionFactory = vi.fn(async (input) => {
        const childNumber = children.length + 1;
        const messages: unknown[] = [];
        let releaseAbort!: () => void;
        const aborted = new Promise<'aborted'>((resolve) => { releaseAbort = () => resolve('aborted'); });
        const session = {
          sessionId: `child-${childNumber}`, model: input.model, thinkingLevel: input.thinkingLevel, messages,
          sessionManager: { getSessionId: () => `child-${childNumber}` },
          resourceLoader: { getSkills: () => ({ skills: [] }) },
          subscribe: vi.fn(() => () => undefined),
          prompt: vi.fn(async (text: string) => {
            messages.push({ role: 'user', content: text });
            const outcome = await Promise.race([childNumber === 1 ? firstGate.then(() => 'released' as const) : new Promise<never>(() => undefined), aborted]);
            if (outcome === 'aborted') throw Object.assign(new Error('interrupted'), { name: 'AbortError' });
            messages.push({ role: 'assistant', content: [{ type: 'text', text: `result:${input.teamIdentity?.path}` }], stopReason: 'stop' });
          }),
          sendCustomMessage: vi.fn(),
          abort: vi.fn(async () => { releaseAbort(); }),
          dispose: vi.fn(),
        } as unknown as AgentSession;
        children.push(session);
        return session;
      });
      const teams = new AgentTeamCoordinator({
        resolveRoot: () => ({ projectPath: dataRoot, session: root, permissionLevel: 'read-only' }),
        getAgentWorkspacePolicy: () => ({ preferredMode: 'shared', strict: false }),
        emit: () => undefined,
        persist: () => undefined,
      }, dataRoot, childFactory);
      const coordinator = new AgentWorkflowCoordinator(teams, {
        resolveParent: () => ({ projectPath: dataRoot, session: root }),
        emit: () => undefined,
        persist: () => undefined,
      });
      const tool = coordinator.createTool(modelRuntime);
      const started = await tool.execute('real-team', {
        action: 'start', maxConcurrency: 1, nodes: [
          { id: 'first', task: 'First' },
          { id: 'second', task: 'Second', dependsOn: ['first'], routing: { fallbackModels: [{ provider: 'test', id: 'fallback' }], maxAttempts: 2 } },
        ],
      } as never, undefined, undefined, { cwd: dataRoot, sessionManager: { getSessionId: () => 'parent-1' } } as never);
      const workflowId = (started.details as { workflowIds: string[] }).workflowIds[0]!;
      await vi.waitFor(() => expect(children).toHaveLength(1));
      const original = teams.getTeams('parent-1')[0]!;
      const selected = teams.createTeam('parent-1', 'Selected later');
      expect(selected.rootNodeId).not.toBe(original.rootNodeId);
      releaseFirst();
      await vi.waitFor(() => expect(children).toHaveLength(2));
      await tool.execute('real-cancel', { action: 'cancel', workflowId, reason: 'Stop selected-independent graph' } as never, undefined, undefined, { cwd: dataRoot, sessionManager: { getSessionId: () => 'parent-1' } } as never);
      expect(coordinator.getWorkflowViews('parent-1')[0]).toMatchObject({ status: 'cancelled' });
      expect(teams.getTeams('parent-1').find((team) => team.id === original.id)?.nodes.filter((node) => node.depth > 0)).toHaveLength(2);
      expect(teams.getTeams('parent-1').find((team) => team.id === selected.id)?.nodes.filter((node) => node.depth > 0)).toHaveLength(0);
      expect(children[1]!.abort).toHaveBeenCalled();
      expect(teams.getTeams('parent-1').find((team) => team.id === original.id)?.nodes.filter((node) => node.depth > 0 && node.status !== 'released')).toHaveLength(0);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(children).toHaveLength(2);
      coordinator.reset();
      await teams.cancelAll();
    } finally {
      await fs.rm(dataRoot, { recursive: true, force: true });
    }
  });

  it('selects the newest persisted snapshot before running-state restart normalization', async () => {
    const active = harness([{ status: 'completed', hold: true }]);
    await execute(active.tool, 'restore-order', { action: 'start', nodes: [{ id: 'held', task: 'Wait' }] });
    await vi.waitFor(() => expect(active.snapshots.some((candidate) => candidate.status === 'running')).toBe(true));
    const olderRunning = structuredClone(active.snapshots.find((candidate) => candidate.status === 'running')!);
    olderRunning.updatedAt = 100;
    const newerCompleted = structuredClone(olderRunning);
    newerCompleted.status = 'completed';
    newerCompleted.updatedAt = 200;
    newerCompleted.endedAt = 200;
    newerCompleted.nodes[0]!.status = 'completed';
    newerCompleted.nodes[0]!.endedAt = 200;

    const restored = harness([]);
    (restored.session.sessionManager.getBranch as unknown as ReturnType<typeof vi.fn>) = vi.fn(() => [
      { type: 'custom', customType: 'fate-subagent-workflow', data: { kind: 'fate-subagent-workflow-snapshot', version: 1, workflow: newerCompleted } },
      { type: 'custom', customType: 'fate-subagent-workflow', data: { kind: 'fate-subagent-workflow-snapshot', version: 1, workflow: olderRunning } },
    ]);
    restored.coordinator.restoreParent(restored.session);
    expect(restored.coordinator.getWorkflowViews('parent-1')[0]).toMatchObject({ status: 'completed', updatedAt: 200 });
  });
});
