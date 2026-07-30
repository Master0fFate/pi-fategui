import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession, AgentSessionEvent, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PiEvent, SubagentRun, SubagentToolDetails } from '../../shared/contracts/ipc';
import { subagentToolDetailsSchema } from '../../shared/contracts/ipc';
import { SubagentCoordinator, type SubagentChildSessionFactory } from './SubagentCoordinator';

const model = {
  provider: 'test', id: 'model', name: 'Test Model', reasoning: true, contextWindow: 100_000,
  input: ['text'] as ('text' | 'image')[], api: 'test', baseUrl: 'https://example.test', maxTokens: 4_096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const alternateModel = {
  ...model,
  provider: 'alternate', id: 'glm', name: 'Alternate GLM', contextWindow: 200_000,
};

function runtime(models = [model, alternateModel]) {
  return {
    getAvailable: vi.fn(async () => models),
    getModel: vi.fn((provider: string, id: string) => models.find((candidate) => candidate.provider === provider && candidate.id === id)),
  } as unknown as ModelRuntime;
}

const sdkEvent = (event: unknown) => event as AgentSessionEvent;

afterEach(() => vi.useRealTimers());

function parentSession(messages: unknown[] = [], skills: Array<{ name: string; description: string; filePath: string; baseDir: string; disableModelInvocation: boolean; sourceInfo?: { source: string; scope: string } }> = []) {
  return {
    sessionId: 'parent-1', model, thinkingLevel: 'medium', messages,
    sessionManager: { getBranch: () => [] },
    resourceLoader: { getSkills: () => ({ skills, diagnostics: [] }) },
  } as unknown as AgentSession;
}

function context(cwd = '/project') {
  return {
    cwd,
    sessionManager: { getSessionId: () => 'parent-1' },
  } as never;
}

function childFactory(options: { delay?: number; waitForAbort?: boolean; failPrompts?: number; resultText?: string; holdUntilConcurrent?: number } = {}) {
  let concurrent = 0;
  let maximumConcurrent = 0;
  let concurrencyGateOpen = false;
  const concurrencyGateWaiters = new Set<() => void>();
  const inputs: Array<{
    role: string; permissionLevel: string; agentName: string; model: string; thinkingLevel: string; toolNames: string[];
    skillMode: string; skills: string[]; skillContent: string[];
  }> = [];
  const prompts: string[] = [];
  const sessions: AgentSession[] = [];
  let failedPrompts = 0;
  const factory: SubagentChildSessionFactory = async (input) => {
    inputs.push({
      role: input.role,
      permissionLevel: input.permissionLevel,
      agentName: input.agentName,
      model: `${input.model.provider}/${input.model.id}`,
      thinkingLevel: input.thinkingLevel,
      toolNames: input.toolNames,
      skillMode: input.skillMode,
      skills: input.selectedSkills.map((skill) => skill.name),
      skillContent: input.selectedSkills.flatMap((skill) => skill.content ? [skill.content] : []),
    });
    const listeners = new Set<(event: AgentSessionEvent) => void>();
    let aborted = false;
    let streaming = false;
    let selectedModel = input.model;
    let selectedThinking = input.thinkingLevel;
    let releaseAbort: (() => void) | undefined;
    const messages: unknown[] = [];
    const session = {
      sessionId: `child-${inputs.length}`,
      get model() { return selectedModel; },
      get thinkingLevel() { return selectedThinking; },
      get isStreaming() { return streaming; },
      messages,
      subscribe: (listener: (event: AgentSessionEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      prompt: vi.fn(async (prompt: string) => {
        prompts.push(prompt);
        if (failedPrompts < (options.failPrompts ?? 0)) {
          failedPrompts += 1;
          throw new Error('Configured provider attempt failed');
        }
        streaming = true;
        concurrent += 1;
        maximumConcurrent = Math.max(maximumConcurrent, concurrent);
        const emit = (event: unknown) => { for (const listener of listeners) listener(sdkEvent(event)); };
        const user = { role: 'user', content: [{ type: 'text', text: prompt }], timestamp: 1 };
        emit({ type: 'agent_start' });
        emit({ type: 'message_start', message: user });
        emit({ type: 'message_end', message: user });
        const assistant = { role: 'assistant', content: [], timestamp: 2 };
        emit({ type: 'message_start', message: assistant });
        emit({ type: 'message_update', message: assistant, assistantMessageEvent: { type: 'thinking_delta', delta: 'Inspect first.' } });
        emit({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'README.md' } });
        emit({ type: 'tool_execution_end', toolCallId: 'read-1', toolName: 'read', result: { content: [{ type: 'text', text: 'README' }] }, isError: false });
        if (options.waitForAbort) {
          await new Promise<void>((resolve) => { releaseAbort = resolve; });
        } else if (options.holdUntilConcurrent && !concurrencyGateOpen) {
          await new Promise<void>((resolve) => {
            concurrencyGateWaiters.add(resolve);
            if (concurrent < options.holdUntilConcurrent!) return;
            concurrencyGateOpen = true;
            for (const release of concurrencyGateWaiters) release();
            concurrencyGateWaiters.clear();
          });
        } else {
          await new Promise((resolve) => setTimeout(resolve, options.delay ?? 2));
        }
        const resultText = aborted ? 'Stopped.' : options.resultText ?? `Result for ${input.role}`;
        const final = {
          role: 'assistant',
          content: [{ type: 'text', text: resultText }],
          stopReason: aborted ? 'aborted' : 'stop',
          timestamp: 3,
          usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, totalTokens: 16, cost: { total: 0.01 } },
        };
        messages.push(user, final);
        emit({ type: 'message_update', message: assistant, assistantMessageEvent: { type: 'text_delta', delta: resultText } });
        emit({ type: 'message_end', message: final });
        emit({ type: 'agent_end', messages: [final] });
        concurrent -= 1;
        streaming = false;
      }),
      steer: vi.fn(async () => undefined),
      setModel: vi.fn(async (nextModel: typeof selectedModel) => { selectedModel = nextModel; }),
      setThinkingLevel: vi.fn((level: typeof selectedThinking) => { selectedThinking = level; }),
      abort: vi.fn(async () => { aborted = true; releaseAbort?.(); }),
      dispose: vi.fn(),
    } as unknown as AgentSession;
    sessions.push(session);
    return session;
  };
  return { factory, inputs, prompts, sessions, maximumConcurrent: () => maximumConcurrent };
}

function executeTool(
  coordinator: SubagentCoordinator,
  params: unknown,
  signal?: AbortSignal,
  onUpdate?: (result: unknown) => void,
  modelRuntime: ModelRuntime = {} as ModelRuntime,
  cwd = '/project',
) {
  const tool = coordinator.createTool(modelRuntime);
  return tool.execute('delegate-1', params, signal, onUpdate as never, context(cwd));
}

function executeNamedTool(
  coordinator: SubagentCoordinator,
  modelRuntime: ModelRuntime,
  name: string,
  toolCallId: string,
  params: unknown,
  signal?: AbortSignal,
  cwd = '/project',
) {
  const tool = coordinator.createTools(modelRuntime).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.execute(toolCallId, params, signal, undefined, context(cwd));
}

describe('SubagentCoordinator', () => {
  it('runs isolated children concurrently with capped permissions, streamed events, and durable details', async () => {
    const parent = parentSession();
    const emitted: PiEvent[] = [];
    const children = childFactory({ delay: 5 });
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'edit' }),
      emit: (_parentId, event) => emitted.push(event),
    }, children.factory);
    const updates: unknown[] = [];

    const result = await executeTool(coordinator, {
      tasks: [
        { task: 'Map runtime flow', role: 'scout', permission: 'read-only' },
        { task: 'Plan the change', role: 'planner', permission: 'read-only' },
        { task: 'Implement the change', role: 'worker', permission: 'edit' },
        { task: 'Review the result', role: 'reviewer', permission: 'full-access' },
      ],
    }, undefined, (update) => updates.push(update));

    const details = subagentToolDetailsSchema.parse(result.details);
    expect(details.runs).toHaveLength(4);
    expect(details.runs?.every((run) => run.status === 'completed')).toBe(true);
    expect(details.runs?.map((run) => run.permissionLevel)).toEqual(['read-only', 'read-only', 'edit', 'edit']);
    expect(details.runs?.every((run) => run.messages.length >= 2 && run.tools.length === 1)).toBe(true);
    expect(details.runs?.every((run) => run.usage.turns === 1 && run.usage.input === 10)).toBe(true);
    expect(details.runs?.map((run) => run.handle)).toEqual(['scout-1', 'planner-1', 'implementer-1', 'reviewer-1']);
    expect(details.runs?.map((run) => run.displayName)).toEqual(['Scout', 'Planner', 'Implementer', 'Reviewer']);
    expect(children.maximumConcurrent()).toBe(4);
    expect(emitted.filter((event) => event.type === 'subagent.started')).toHaveLength(4);
    expect(emitted.filter((event) => event.type === 'subagent.event').length).toBeGreaterThan(12);
    expect(emitted.filter((event) => event.type === 'subagent.completed')).toHaveLength(4);
    expect(updates.length).toBeGreaterThan(1);
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('4/4 completed') });
  });

  it('routes a child to another Pi-authenticated provider with independent thinking effort', async () => {
    const parent = parentSession();
    const children = childFactory();
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, children.factory);

    const result = await executeTool(coordinator, {
      task: 'Use the alternate model for this specialist pass',
      role: 'reviewer',
      model: { provider: 'alternate', id: 'glm' },
      thinkingLevel: 'high',
      tools: ['read', 'grep', 'bash'],
    }, undefined, undefined, runtime());
    const details = subagentToolDetailsSchema.parse(result.details);

    expect(children.inputs[0]).toMatchObject({
      role: 'reviewer', agentName: 'direct', model: 'alternate/glm', thinkingLevel: 'high',
      permissionLevel: 'read-only', toolNames: ['read', 'grep'],
    });
    expect(details.runs?.[0]).toMatchObject({
      status: 'completed', model: { provider: 'alternate', id: 'glm' }, thinkingLevel: 'high',
    });
  });

  it('launches reusable trusted-project Pi agents with profile model and tool defaults', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-subagent-integration-'));
    try {
      await fs.mkdir(path.join(directory, '.pi', 'agents'), { recursive: true });
      await fs.writeFile(path.join(directory, '.pi', 'agents', 'glm-reviewer.md'), [
        '---',
        'name: glm-reviewer',
        'description: Review with the authenticated alternate model',
        'tools: read, grep, bash',
        'model: alternate/glm',
        '---',
        'Review the assigned boundary and return evidence.',
      ].join('\n'));
      const parent = parentSession();
      const children = childFactory();
      const coordinator = new SubagentCoordinator({
        resolveParent: () => ({ projectPath: directory, session: parent, permissionLevel: 'full-access' }),
        emit: () => undefined,
      }, children.factory);

      const result = await executeTool(coordinator, {
        task: 'Review the runtime boundary',
        agent: 'project/glm-reviewer',
        permission: 'full-access',
        thinkingLevel: 'xhigh',
        tools: ['read', 'grep', 'bash', 'write'],
      }, undefined, undefined, runtime(), directory);
      const run = subagentToolDetailsSchema.parse(result.details).runs?.[0];

      expect(children.inputs[0]).toMatchObject({
        agentName: 'glm-reviewer', model: 'alternate/glm', thinkingLevel: 'xhigh',
        toolNames: ['read', 'grep', 'bash'],
      });
      expect(run).toMatchObject({ agentName: 'glm-reviewer', agentSource: 'project', enabledTools: ['read', 'grep', 'bash'] });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('lets the parent inspect, retarget, steer, and terminate a managed child mid-run', async () => {
    const parent = parentSession();
    const children = childFactory({ waitForAbort: true });
    const persisted: SubagentRun[] = [];
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
      persist: (_parentId, run) => persisted.push(run),
    }, children.factory);
    const modelRuntime = runtime();

    const launched = await executeNamedTool(coordinator, modelRuntime, 'subagent_start', 'start-1', {
      task: 'Investigate until redirected',
      role: 'worker',
      permission: 'edit',
      model: { provider: 'alternate', id: 'glm' },
      thinkingLevel: 'high',
      timeoutSeconds: 60,
    });
    const runId = (launched.details as SubagentToolDetails).runIds[0]!;
    const handle = coordinator.getRuns('parent-1')[0]?.handle;
    expect(handle).toBe('scout-1');
    expect(launched.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('@scout-1') });
    expect(coordinator.hasActiveRuns('parent-1')).toBe(true);
    await vi.waitFor(() => expect(children.maximumConcurrent()).toBe(1));

    const status = await executeNamedTool(coordinator, modelRuntime, 'subagent_manage', 'manage-status', {
      action: 'status', runIds: [`@${handle}`],
    });
    expect(status.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('alternate/glm') });
    expect(status.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Inspect first.') });

    await executeNamedTool(coordinator, modelRuntime, 'subagent_manage', 'manage-retarget', {
      action: 'retarget', runId: `@${handle}`, model: { provider: 'test', id: 'model' }, thinkingLevel: 'low',
    });
    await executeNamedTool(coordinator, modelRuntime, 'subagent_manage', 'manage-steer', {
      action: 'steer', runId: `@${handle}`, instruction: 'Stop exploring and summarize the evidence now.',
    });
    expect(children.sessions[0]?.setModel).toHaveBeenCalledWith(model);
    expect(children.sessions[0]?.setThinkingLevel).toHaveBeenCalledWith('low');
    expect(children.sessions[0]?.steer).toHaveBeenCalledWith('Stop exploring and summarize the evidence now.');

    const waiting = executeNamedTool(coordinator, modelRuntime, 'subagent_manage', 'manage-wait', {
      action: 'wait', runIds: [`@${handle}`], until: 'all', timeoutSeconds: 30,
    });
    const cancelled = await executeNamedTool(coordinator, modelRuntime, 'subagent_manage', 'manage-cancel', {
      action: 'cancel', runIds: [`@${handle}`], reason: 'The evidence is sufficient.',
    });
    const waited = await waiting;
    expect(subagentToolDetailsSchema.parse(waited.details).runs?.[0]?.status).toBe('cancelled');
    const final = subagentToolDetailsSchema.parse(cancelled.details).runs?.[0];
    expect(final).toMatchObject({
      status: 'cancelled', model: { provider: 'test', id: 'model' }, thinkingLevel: 'low', controlCount: 3,
    });
    expect(final?.error).toContain('evidence is sufficient');
    expect(persisted).toHaveLength(1);
    expect(coordinator.hasActiveRuns('parent-1')).toBe(false);

    const restoredParent = {
      ...parentSession(),
      sessionManager: {
        getBranch: () => [{
          type: 'custom', customType: 'fate-subagent-run',
          data: { kind: 'fate-subagent-snapshot', version: 1, run: persisted[0] },
        }],
      },
    } as unknown as AgentSession;
    const restored = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: restoredParent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, children.factory);
    restored.restoreParent(restoredParent);
    expect(restored.getRuns('parent-1')[0]).toMatchObject({ id: runId, handle: 'scout-1', displayName: 'Scout', status: 'cancelled', executionMode: 'managed' });
  });

  it('catalogs authenticated models and reusable Pi agent selectors without exposing prompts', async () => {
    const parent = parentSession();
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    });

    const result = await executeNamedTool(coordinator, runtime(), 'subagent_catalog', 'catalog-1', {});
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(/alternate\/glm[\s\S]*Capability contract/u),
    });
    expect(result.details).toMatchObject({ kind: 'fate-subagent-catalog', version: 2 });
    expect(JSON.stringify(result.details)).not.toContain('Complete only the delegated task');
    expect(JSON.stringify(result.details)).not.toContain('example.test');
  });

  it('preloads exact user-selected Pi skills without injecting a scenario prompt', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-subagent-skill-'));
    try {
      const skillDirectory = path.join(directory, 'skills', 'security-check');
      await fs.mkdir(skillDirectory, { recursive: true });
      const skillPath = path.join(skillDirectory, 'SKILL.md');
      const skillContent = [
        '---',
        'name: security-check',
        'description: User-defined security procedure',
        'required-tools: read, grep',
        '---',
        'Apply the user-defined checks exactly.',
      ].join('\n');
      await fs.writeFile(skillPath, skillContent);
      const parent = parentSession([], [{
        name: 'security-check', description: 'User-defined security procedure', filePath: skillPath,
        baseDir: skillDirectory, disableModelInvocation: false, sourceInfo: { source: 'user', scope: 'user' },
      }]);
      const children = childFactory();
      const coordinator = new SubagentCoordinator({
        resolveParent: () => ({ projectPath: directory, session: parent, permissionLevel: 'read-only' }),
        emit: () => undefined,
      }, children.factory);

      const catalog = await executeNamedTool(coordinator, runtime(), 'subagent_catalog', 'skill-catalog', { section: 'skills' }, undefined, directory);
      expect(catalog.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('security-check') });

      const result = await executeTool(coordinator, {
        task: 'Inspect exactly this boundary.',
        skills: ['security-check'], skillMode: 'selected', preloadSkills: true,
        tools: ['read', 'grep'],
      }, undefined, undefined, runtime(), directory);

      expect((result.details as SubagentToolDetails).runs?.[0]).toMatchObject({
        skills: ['security-check'], skillMode: 'selected', preloadedSkills: ['security-check'],
      });
      expect(children.inputs[0]).toMatchObject({ skillMode: 'selected', skills: ['security-check'], toolNames: ['read', 'grep'] });
      expect(children.inputs[0]?.skillContent[0]).toContain('Apply the user-defined checks exactly.');
      expect(children.prompts).toEqual(['Inspect exactly this boundary.']);
      await expect(executeTool(coordinator, {
        task: 'Attempt an under-scoped skill run.', skills: ['security-check'], skillMode: 'selected', tools: ['read'],
      }, undefined, undefined, runtime(), directory)).rejects.toThrow(/requires child tools that are not enabled/u);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps successful managed sessions as configured mailboxes for exact follow-up prompts', async () => {
    const parent = parentSession();
    const children = childFactory();
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, children.factory);
    const modelRuntime = runtime();

    const launched = await executeNamedTool(coordinator, modelRuntime, 'subagent_start', 'mailbox-start', {
      task: 'First exact prompt', mailboxTtlSeconds: 120,
    });
    const runId = (launched.details as SubagentToolDetails).runIds[0]!;
    await vi.waitFor(() => expect(coordinator.getRuns('parent-1')[0]?.mailbox.state).toBe('available'));
    expect(coordinator.hasActiveRuns('parent-1')).toBe(false);
    expect(coordinator.hasRetainedRuns('parent-1')).toBe(true);

    const followed = await executeNamedTool(coordinator, modelRuntime, 'subagent_manage', 'mailbox-followup', {
      action: 'followup', runId, message: 'Second exact prompt', extendMailboxTtlSeconds: 60,
    });
    expect((followed.details as SubagentToolDetails).runs?.[0]).toMatchObject({
      status: 'completed', mailbox: { state: 'available', ttlMs: 60_000, followUpCount: 1 },
    });
    expect(children.prompts).toEqual(['First exact prompt', 'Second exact prompt']);
    expect(children.sessions[0]?.dispose).not.toHaveBeenCalled();

    await executeNamedTool(coordinator, modelRuntime, 'subagent_manage', 'mailbox-close', { action: 'close', runIds: [runId] });
    expect(coordinator.getRuns('parent-1')[0]?.mailbox.state).toBe('closed');
    expect(children.sessions[0]?.dispose).toHaveBeenCalledOnce();

    const oneShot = await executeNamedTool(coordinator, modelRuntime, 'subagent_start', 'mailbox-one-shot', {
      task: 'Retain for exactly one follow-up', mailboxTtlSeconds: 120,
    });
    const oneShotId = (oneShot.details as SubagentToolDetails).runIds[0]!;
    await vi.waitFor(() => expect(coordinator.getRuns('parent-1').find((run) => run.id === oneShotId)?.mailbox.state).toBe('available'));
    const oneShotResult = await executeNamedTool(coordinator, modelRuntime, 'subagent_manage', 'mailbox-final-turn', {
      action: 'followup', runId: oneShotId, message: 'Final turn', extendMailboxTtlSeconds: 0,
    });
    expect((oneShotResult.details as SubagentToolDetails).runs?.[0]?.mailbox.state).toBe('disabled');
    expect(children.sessions[1]?.dispose).toHaveBeenCalledOnce();
  });

  it('applies inspector controls by handle while keeping the handle immutable', async () => {
    const parent = parentSession();
    const children = childFactory();
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, children.factory);
    const modelRuntime = runtime();

    await executeNamedTool(coordinator, modelRuntime, 'subagent_start', 'inspector-control', {
      task: 'Inspect the boundary', role: 'reviewer', mailboxTtlSeconds: 120,
    });
    await vi.waitFor(() => expect(coordinator.getRuns('parent-1')[0]?.mailbox.state).toBe('available'));
    const originalHandle = coordinator.getRuns('parent-1')[0]!.handle!;

    const renamed = await coordinator.controlRun('parent-1', { action: 'rename', target: `@${originalHandle}`, displayName: 'Boundary Analyst' }, modelRuntime);
    expect(renamed[0]).toMatchObject({ handle: originalHandle, displayName: 'Boundary Analyst' });

    const followed = await coordinator.controlRun('parent-1', { action: 'followUp', target: `@${originalHandle}`, message: 'Summarize the final boundary.' }, modelRuntime);
    expect(followed[0]).toMatchObject({ handle: originalHandle, displayName: 'Boundary Analyst', status: 'completed' });
    expect(children.prompts).toEqual(['Inspect the boundary', 'Summarize the final boundary.']);

    await coordinator.controlRun('parent-1', { action: 'close', target: `@${originalHandle}` }, modelRuntime);
    expect(coordinator.getRuns('parent-1')[0]).toMatchObject({ handle: originalHandle, displayName: 'Boundary Analyst', mailbox: { state: 'closed' } });
  });

  it('retains every explicitly requested mailbox instead of evicting an arbitrary oldest subset', async () => {
    const parent = parentSession();
    const children = childFactory();
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, children.factory);
    const launched = await executeNamedTool(coordinator, runtime(), 'subagent_start', 'ten-mailboxes', {
      tasks: Array.from({ length: 10 }, (_, index) => ({ task: `Retained ${index}`, mailboxTtlSeconds: 3_600 })),
    });
    const runIds = (launched.details as SubagentToolDetails).runIds;
    await vi.waitFor(() => expect(coordinator.getRuns('parent-1').filter((run) => run.mailbox.state === 'available')).toHaveLength(10));
    expect(children.sessions.every((session) => !vi.mocked(session.dispose).mock.calls.length)).toBe(true);
    await executeNamedTool(coordinator, runtime(), 'subagent_manage', 'close-ten-mailboxes', { action: 'close', runIds });
    expect(coordinator.getRuns('parent-1').every((run) => run.mailbox.state === 'closed')).toBe(true);
  });

  it('applies ordered routing retries and enforces observable token or cost budgets', async () => {
    const parent = parentSession();
    const routedChildren = childFactory({ failPrompts: 5 });
    const routed = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, routedChildren.factory);

    const retryResult = await executeTool(routed, {
      task: 'Retry through the explicit route',
      model: { provider: 'alternate', id: 'glm' },
      routing: { fallbackModels: [{ provider: 'test', id: 'model' }], maxAttempts: 6 },
    }, undefined, undefined, runtime());
    expect((retryResult.details as SubagentToolDetails).runs?.[0]).toMatchObject({
      status: 'completed', attempt: 6, maxAttempts: 6, model: { provider: 'test', id: 'model' },
    });
    expect(routedChildren.inputs.map((input) => input.model)).toEqual([
      'alternate/glm', 'test/model', 'test/model', 'test/model', 'test/model', 'test/model',
    ]);

    const budgetChildren = childFactory();
    const budgeted = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, budgetChildren.factory);
    const budgetResult = await executeTool(budgeted, { task: 'Stop at the cost boundary', budget: { maxCostUsd: 0.001 } });
    expect((budgetResult.details as SubagentToolDetails).runs?.[0]).toMatchObject({
      status: 'budget-exceeded', error: expect.stringContaining('budget exceeded'),
    });
  });

  it('refuses only context-window-overflow transfers and preserves full child work outside the parent context', async () => {
    const tinyModel = { ...model, id: 'tiny', name: 'Tiny Context', contextWindow: 500 };
    const tinyParent = { ...parentSession(), model: tinyModel } as unknown as AgentSession;
    const parentToChild = childFactory();
    const inbound = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: tinyParent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, parentToChild.factory);
    const inboundResult = await executeTool(inbound, { task: 'x'.repeat(2_400) }, undefined, undefined, runtime([tinyModel, alternateModel]));
    expect((inboundResult.details as SubagentToolDetails).runs?.[0]).toMatchObject({
      status: 'error', error: expect.stringMatching(/parent-to-child[\s\S]*maximum context window of 500 tokens/u),
    });
    expect(parentToChild.prompts).toEqual([]);

    const fullOutput = 'z'.repeat(2_400);
    const childToParent = childFactory({ resultText: fullOutput });
    const outbound = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: tinyParent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, childToParent.factory);
    const outboundResult = await executeTool(outbound, {
      task: 'Produce the requested artifact summary', model: { provider: 'alternate', id: 'glm' },
    }, undefined, undefined, runtime([tinyModel, alternateModel]));
    expect(outboundResult.content[0]).toMatchObject({
      type: 'text', text: expect.stringMatching(/Refused child-to-parent result[\s\S]*maximum context window of 500 tokens/u),
    });
    expect((outboundResult.details as SubagentToolDetails).runs?.[0]?.result).toBe(fullOutput);

    const mailboxChildren = childFactory();
    const mailbox = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: tinyParent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, mailboxChildren.factory);
    const launched = await executeNamedTool(mailbox, runtime([tinyModel]), 'subagent_start', 'tiny-mailbox', {
      task: 'Keep this context', mailboxTtlSeconds: 300,
    });
    const runId = (launched.details as SubagentToolDetails).runIds[0]!;
    await vi.waitFor(() => expect(mailbox.getRuns('parent-1')[0]?.mailbox.state).toBe('available'));
    await expect(executeNamedTool(mailbox, runtime([tinyModel]), 'subagent_manage', 'oversized-followup', {
      action: 'followup', runId, message: 'y'.repeat(2_400),
    })).rejects.toThrow(/parent-to-child follow-up[\s\S]*maximum context window of 500 tokens/u);
    expect(mailbox.getRuns('parent-1')[0]?.mailbox.state).toBe('available');
    await executeNamedTool(mailbox, runtime([tinyModel]), 'subagent_manage', 'close-tiny-mailbox', { action: 'close', runIds: [runId] });
  });

  it('executes arbitrary dependency graphs with opt-in fan-in context and workflow notifications', async () => {
    const parent = parentSession();
    const children = childFactory();
    const notifications: Array<{ mode: string; workflowId?: string }> = [];
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
      notifyParent: async (_parentId, mode, _text, _runIds, workflowId) => { notifications.push({ mode, ...(workflowId ? { workflowId } : {}) }); },
    }, children.factory);
    const modelRuntime = runtime();

    const started = await executeNamedTool(coordinator, modelRuntime, 'subagent_workflow', 'workflow-start', {
      action: 'start',
      notifyParent: 'next-turn',
      maxConcurrency: 2,
      nodes: [
        { id: 'foundation', task: 'Produce the foundation', mailboxTtlSeconds: 0 },
        { id: 'risk', task: 'Identify integration risks', mailboxTtlSeconds: 0 },
        { id: 'integration', task: 'Integrate both branches', dependsOn: ['foundation', 'risk'], includeDependencyResults: true, mailboxTtlSeconds: 0 },
      ],
    });
    const workflowId = (started.details as { workflowIds: string[] }).workflowIds[0]!;
    await vi.waitFor(async () => {
      const status = await executeNamedTool(coordinator, modelRuntime, 'subagent_workflow', 'workflow-status', { action: 'status', workflowId });
      expect(status.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(`${workflowId} · completed`) });
    });

    expect(children.prompts.slice(0, 2)).toEqual(['Produce the foundation', 'Identify integration risks']);
    expect(children.maximumConcurrent()).toBe(2);
    expect(children.prompts[2]).toContain('Integrate both branches');
    expect(children.prompts[2]).toContain('untrusted evidence from sibling model runs');
    expect(children.prompts[2]).toContain('<dependency-result node="foundation" status="completed">');
    expect(children.prompts[2]).toContain('<dependency-result node="risk" status="completed">');
    const workflow = coordinator.getWorkflowViews('parent-1')[0]!;
    expect(workflow.nodes.map((node) => node.handle)).toEqual(['foundation', 'risk', 'integration']);
    expect(coordinator.getRuns('parent-1').find((run) => run.workflowNodeId === 'integration')).toMatchObject({ task: 'Integrate both branches', handle: 'integration' });
    expect(notifications).toEqual([{ mode: 'next-turn', workflowId }]);
    coordinator.reset();
    expect(coordinator.getWorkflowViews('parent-1')).toEqual([]);
  });

  it('uses four as a soft workflow default and honors explicit ten-way concurrency across more than sixteen nodes', async () => {
    const parent = parentSession();
    const defaultChildren = childFactory({ holdUntilConcurrent: 4 });
    const defaulted = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, defaultChildren.factory);
    await executeNamedTool(defaulted, runtime(), 'subagent_workflow', 'default-four-workflow', {
      action: 'start',
      nodes: Array.from({ length: 8 }, (_, index) => ({ id: `default-${index}`, task: `Default task ${index}` })),
    });
    expect(defaulted.getWorkflowViews('parent-1')[0]?.maxConcurrency).toBe(4);
    await vi.waitFor(() => expect(defaulted.getWorkflowViews('parent-1')[0]?.status).toBe('completed'));
    expect(defaultChildren.maximumConcurrent()).toBe(4);

    const explicitChildren = childFactory({ holdUntilConcurrent: 10 });
    const explicit = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, explicitChildren.factory);
    await executeNamedTool(explicit, runtime(), 'subagent_workflow', 'explicit-ten-workflow', {
      action: 'start', maxConcurrency: 10,
      nodes: Array.from({ length: 20 }, (_, index) => ({ id: `explicit-${index}`, task: `Explicit task ${index}` })),
    });
    expect(explicit.getWorkflowViews('parent-1')[0]).toMatchObject({ maxConcurrency: 10, nodes: expect.any(Array) });
    expect(explicit.getWorkflowViews('parent-1')[0]?.nodes).toHaveLength(20);
    await vi.waitFor(() => expect(explicit.getWorkflowViews('parent-1')[0]?.status).toBe('completed'));
    expect(explicitChildren.maximumConcurrent()).toBe(10);
    expect(explicit.getRuns('parent-1')).toHaveLength(20);
  });

  it('fails child setup durably without rejecting the parent tool turn', async () => {
    const parent = parentSession();
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, vi.fn(async () => { throw new Error('Child provider unavailable'); }));

    const result = await executeTool(coordinator, { task: 'Inspect the project' });
    const details = subagentToolDetailsSchema.parse(result.details);

    expect(details.runs).toHaveLength(1);
    expect(details.runs?.[0]).toMatchObject({ status: 'error', error: 'Child provider unavailable' });
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('0/1 completed') });
  });

  it('rejects ambiguous requests but honors an explicit ten-child launch without a harness ceiling', async () => {
    const parent = parentSession();
    const children = childFactory({ holdUntilConcurrent: 10 });
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, children.factory);

    const invalid = await executeTool(coordinator, { task: 'One', tasks: [{ task: 'Two' }] });
    expect(invalid.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('exactly one') });
    expect((invalid.details as SubagentToolDetails).runIds).toEqual([]);

    const result = await executeNamedTool(coordinator, runtime(), 'subagent', 'explicit-ten', {
      tasks: Array.from({ length: 10 }, (_, index) => ({ task: `Task ${index + 1}` })),
    });
    const runIds = (result.details as SubagentToolDetails).runIds;
    expect(runIds).toHaveLength(10);
    expect((result.details as SubagentToolDetails).runs).toHaveLength(10);
    expect(children.maximumConcurrent()).toBe(10);

    const page = await executeNamedTool(coordinator, runtime(), 'subagent_manage', 'explicit-ten-page', {
      action: 'status',
      offset: 4,
      limit: 3,
    });
    expect((page.details as SubagentToolDetails).runIds).toEqual(runIds.slice(4, 7));
  });

  it('admits concurrent launch calls without a hidden cross-batch cap', async () => {
    const parent = parentSession();
    const children = childFactory({ waitForAbort: true });
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, children.factory);
    const modelRuntime = { getAvailable: vi.fn(async () => [parent.model!]) } as unknown as ModelRuntime;
    const tasks = (prefix: string) => ({ tasks: Array.from({ length: 3 }, (_, index) => ({ task: `${prefix} ${index}` })) });

    const results = await Promise.all([
      executeNamedTool(coordinator, modelRuntime, 'subagent_start', 'parallel-a', tasks('A')),
      executeNamedTool(coordinator, modelRuntime, 'subagent_start', 'parallel-b', tasks('B')),
    ]);

    expect(results.map((result) => (result.details as SubagentToolDetails).runIds.length)).toEqual([3, 3]);
    await vi.waitFor(() => expect(children.maximumConcurrent()).toBe(6));
    expect(coordinator.getRuns('parent-1').filter((run) => !['completed', 'error', 'cancelled', 'timed-out', 'interrupted'].includes(run.status))).toHaveLength(6);
    await coordinator.cancelAll();
  });

  it('restores completed snapshots and marks unmatched parent tool calls interrupted', async () => {
    const parent = parentSession();
    const children = childFactory();
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, children.factory);
    const result = await executeTool(coordinator, { task: 'Inspect the project', role: 'scout', permission: 'read-only' });
    const details = result.details as SubagentToolDetails;
    const history = [
      {
        role: 'assistant', timestamp: 10, content: [
          { type: 'toolCall', id: 'delegate-1', name: 'subagent', arguments: { task: 'Inspect the project', role: 'scout', permission: 'read-only' } },
          { type: 'toolCall', id: 'unfinished', name: 'subagent', arguments: { task: 'Finish later', role: 'worker', permission: 'edit' } },
        ],
      },
      { role: 'toolResult', toolCallId: 'delegate-1', toolName: 'subagent', details, content: [{ type: 'text', text: 'done' }] },
    ];
    const restoredParent = parentSession(history);
    const restored = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: restoredParent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, children.factory);

    restored.restoreParent(restoredParent);

    expect(restored.getRuns('parent-1').map((run) => run.status).sort()).toEqual(['completed', 'interrupted']);
    expect(restored.getRuns('parent-1').find((run) => run.status === 'interrupted')).toMatchObject({
      task: 'Finish later', role: 'worker', error: expect.stringContaining('restarted'),
    });
  });

  it('cancels promptly during child setup and disposes a session that arrives late', async () => {
    const parent = parentSession();
    let finishCreation: ((session: AgentSession) => void) | undefined;
    const lateChild = {
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
    } as unknown as AgentSession;
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, () => new Promise<AgentSession>((resolve) => { finishCreation = resolve; }));
    const controller = new AbortController();
    const running = executeTool(coordinator, { task: 'Initialize slowly' }, controller.signal);
    await vi.waitFor(() => expect(coordinator.getRuns('parent-1')[0]?.status).toBe('running'));

    controller.abort();
    const result = await running;
    expect((result.details as SubagentToolDetails).runs?.[0]?.status).toBe('cancelled');

    finishCreation?.(lateChild);
    await vi.waitFor(() => expect(lateChild.dispose).toHaveBeenCalledOnce());
    expect(lateChild.abort).toHaveBeenCalledOnce();
  });

  it('automatically terminates a child that exceeds its configured runtime', async () => {
    vi.useFakeTimers();
    const parent = parentSession();
    const children = childFactory({ waitForAbort: true });
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, children.factory);

    const running = executeTool(coordinator, { task: 'Never finish', timeoutSeconds: 30 });
    await vi.waitFor(() => expect(children.maximumConcurrent()).toBe(1));
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await running;

    expect((result.details as SubagentToolDetails).runs?.[0]).toMatchObject({
      status: 'timed-out', error: expect.stringContaining('30 second runtime limit'),
    });
  });

  it('leaves runtime unrestricted by default and accepts multi-hour limits when explicitly requested', async () => {
    vi.useFakeTimers();
    const parent = parentSession();
    const unrestrictedChildren = childFactory({ waitForAbort: true });
    const unrestricted = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, unrestrictedChildren.factory);
    const controller = new AbortController();
    const running = executeTool(unrestricted, { task: 'Work without an automatic deadline' }, controller.signal);
    await vi.waitFor(() => expect(unrestrictedChildren.maximumConcurrent()).toBe(1));
    expect(unrestricted.getRuns('parent-1')[0]).not.toHaveProperty('timeoutAt');
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1_000);
    expect(unrestricted.getRuns('parent-1')[0]?.status).toBe('running');
    controller.abort();
    await expect(running).resolves.toMatchObject({ details: expect.any(Object) });

    const limitedChildren = childFactory({ waitForAbort: true });
    const limited = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, limitedChildren.factory);
    const launched = await executeNamedTool(limited, runtime(), 'subagent_start', 'six-hour-run', {
      task: 'Use the user-defined six hour window', timeoutSeconds: 6 * 60 * 60,
    });
    const runId = (launched.details as SubagentToolDetails).runIds[0]!;
    await vi.waitFor(() => expect(limitedChildren.maximumConcurrent()).toBe(1));
    const limitedRun = limited.getRuns('parent-1')[0]!;
    expect(limitedRun.timeoutAt! - limitedRun.startedAt!).toBe(6 * 60 * 60 * 1_000);
    await executeNamedTool(limited, runtime(), 'subagent_manage', 'cancel-six-hour-run', { action: 'cancel', runIds: [runId] });
  });

  it('can enforce an opt-in no-activity timeout for stuck providers', async () => {
    vi.useFakeTimers();
    const parent = parentSession();
    const children = childFactory({ waitForAbort: true });
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, children.factory);

    const running = executeTool(coordinator, {
      task: 'Become observably stuck', timeoutSeconds: 60, idleTimeoutSeconds: 15,
    });
    await vi.waitFor(() => expect(children.maximumConcurrent()).toBe(1));
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await running;

    expect((result.details as SubagentToolDetails).runs?.[0]).toMatchObject({
      status: 'timed-out', error: expect.stringContaining('no observable activity for 15 seconds'),
    });
  });

  it('propagates parent cancellation and settles the child as cancelled', async () => {
    const parent = parentSession();
    const children = childFactory({ waitForAbort: true });
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, children.factory);
    const controller = new AbortController();
    const running = executeTool(coordinator, { task: 'Long task', role: 'worker', permission: 'edit' }, controller.signal);
    await vi.waitFor(() => expect(children.maximumConcurrent()).toBe(1));

    controller.abort();
    const result = await running;
    const runs = (result.details as SubagentToolDetails).runs as SubagentRun[];

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'cancelled', error: expect.stringContaining('Cancelled') });
  });

  it('preserves arbitrary role labels while capability scope remains permission-bounded and exact', async () => {
    const parent = parentSession();
    const children = childFactory();
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'read-only' }),
      emit: () => undefined,
    }, children.factory);

    const result = await executeTool(coordinator, {
      task: 'Perform the domain pass',
      role: 'database-migration-specialist',
      permission: 'full-access',
      tools: ['read', 'grep', 'bash', 'write'],
      skillMode: 'none',
    });
    const run = (result.details as SubagentToolDetails).runs?.[0];

    expect(children.inputs[0]).toMatchObject({
      role: 'database-migration-specialist', permissionLevel: 'read-only', toolNames: ['read', 'grep'], skillMode: 'none', skills: [],
    });
    expect(run).toMatchObject({
      role: 'database-migration-specialist', permissionLevel: 'read-only', enabledTools: ['read', 'grep'], skillMode: 'none',
    });
  });

  it('retargets an idle mailbox, follows up in the same session, emits completion notifications, and expires cleanly', async () => {
    vi.useFakeTimers();
    const parent = parentSession();
    const children = childFactory();
    const notifications: Array<{ mode: string; runIds: string[] }> = [];
    const settled = vi.fn();
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
      notifyParent: async (_parentId, mode, _text, runIds) => { notifications.push({ mode, runIds }); },
      settled,
    }, children.factory);
    const modelRuntime = runtime();

    const launched = await executeNamedTool(coordinator, modelRuntime, 'subagent_start', 'notify-start', {
      task: 'Initial turn', notifyParent: 'immediate', mailboxTtlSeconds: 10,
    });
    const runId = (launched.details as SubagentToolDetails).runIds[0]!;
    await vi.advanceTimersByTimeAsync(5);
    await vi.waitFor(() => expect(coordinator.getRuns('parent-1')[0]?.mailbox.state).toBe('available'));
    expect(notifications).toEqual([{ mode: 'immediate', runIds: [runId] }]);

    await executeNamedTool(coordinator, modelRuntime, 'subagent_manage', 'idle-retarget', {
      action: 'retarget', runId, model: { provider: 'alternate', id: 'glm' }, thinkingLevel: 'xhigh',
    });
    const following = executeNamedTool(coordinator, modelRuntime, 'subagent_manage', 'mailbox-turn', {
      action: 'followup', runId, message: 'Inspect one more edge', extendMailboxTtlSeconds: 10,
    });
    await vi.advanceTimersByTimeAsync(5);
    const followed = await following;
    expect((followed.details as SubagentToolDetails).runs?.[0]).toMatchObject({
      model: { provider: 'alternate', id: 'glm' }, thinkingLevel: 'xhigh', mailbox: { state: 'available', followUpCount: 1 },
    });
    expect(children.sessions).toHaveLength(1);
    expect(children.prompts).toEqual(['Initial turn', 'Inspect one more edge']);
    expect(notifications).toEqual([{ mode: 'immediate', runIds: [runId] }]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(coordinator.getRuns('parent-1')[0]?.mailbox.state).toBe('expired');
    expect(children.sessions[0]?.dispose).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalled();
  });

  it('rejects cyclic workflows and applies dependency-failure policy without launching skipped nodes', async () => {
    const parent = parentSession();
    const children = childFactory({ failPrompts: 1 });
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, children.factory);
    const modelRuntime = runtime();

    await expect(executeNamedTool(coordinator, modelRuntime, 'subagent_workflow', 'workflow-cycle', {
      action: 'start',
      nodes: [
        { id: 'a', task: 'A', dependsOn: ['b'] },
        { id: 'b', task: 'B', dependsOn: ['a'] },
      ],
    })).rejects.toThrow(/Invalid workflow graph/u);

    const started = await executeNamedTool(coordinator, modelRuntime, 'subagent_workflow', 'workflow-failure', {
      action: 'start',
      nodes: [
        { id: 'upstream', task: 'Fail once', routing: { maxAttempts: 1 } },
        { id: 'downstream', task: 'Must not run', dependsOn: ['upstream'] },
      ],
    });
    const workflowId = (started.details as { workflowIds: string[] }).workflowIds[0]!;
    await vi.waitFor(() => expect(coordinator.getWorkflowViews('parent-1')[0]?.status).toBe('error'));
    const workflow = coordinator.getWorkflowViews('parent-1')[0]!;
    expect(workflow.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'upstream', status: 'error' }),
      expect.objectContaining({ id: 'downstream', status: 'skipped' }),
    ]));
    expect(workflow.nodes.find((node) => node.id === 'downstream')).not.toHaveProperty('runId');
    expect(children.prompts).toEqual(['Fail once']);
  });

  it('enforces aggregate workflow budgets and cancels running and pending nodes', async () => {
    const parent = parentSession();
    const budgetChildren = childFactory();
    const budgeted = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, budgetChildren.factory);
    const modelRuntime = runtime();

    const started = await executeNamedTool(budgeted, modelRuntime, 'subagent_workflow', 'workflow-budget', {
      action: 'start', maxConcurrency: 1, budget: { maxCostUsd: 0.001 },
      nodes: [
        { id: 'one', task: 'Spend the observable budget' },
        { id: 'two', task: 'Do not launch', dependsOn: ['one'] },
      ],
    });
    const budgetWorkflowId = (started.details as { workflowIds: string[] }).workflowIds[0]!;
    await vi.waitFor(() => expect(budgeted.getWorkflowViews('parent-1')[0]?.status).toBe('error'));
    const budgetWorkflow = budgeted.getWorkflowViews('parent-1')[0]!;
    expect(budgetWorkflow.usage).toMatchObject({ turns: 1, cost: 0.01 });
    expect(budgetWorkflow.nodes[1]).toMatchObject({ status: 'skipped', error: expect.stringContaining('Workflow budget') });
    expect(budgetChildren.prompts).toEqual(['Spend the observable budget']);

    const stalledChildren = childFactory({ waitForAbort: true });
    const cancellable = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, stalledChildren.factory);
    const cancellableStart = await executeNamedTool(cancellable, modelRuntime, 'subagent_workflow', 'workflow-cancel', {
      action: 'start', maxConcurrency: 1,
      nodes: [
        { id: 'running', task: 'Remain active' },
        { id: 'pending', task: 'Remain pending', dependsOn: ['running'] },
      ],
    });
    const cancellableId = (cancellableStart.details as { workflowIds: string[] }).workflowIds[0]!;
    await vi.waitFor(() => expect(stalledChildren.maximumConcurrent()).toBe(1));
    await executeNamedTool(cancellable, modelRuntime, 'subagent_workflow', 'workflow-cancel-action', {
      action: 'cancel', workflowId: cancellableId, reason: 'Stop the graph now.',
    });
    expect(cancellable.getWorkflowViews('parent-1')[0]).toMatchObject({
      id: cancellableId, status: 'cancelled', nodes: [
        expect.objectContaining({ status: 'cancelled' }),
        expect.objectContaining({ status: 'cancelled' }),
      ],
    });
    expect(stalledChildren.sessions[0]?.abort).toHaveBeenCalled();
    expect(budgetWorkflowId).toBeTruthy();
  });

  it('restores an interrupted workflow snapshot and resumes unfinished nodes explicitly', async () => {
    const parent = parentSession();
    const stalledChildren = childFactory({ waitForAbort: true });
    const snapshots: Array<import('./SubagentWorkflow').SubagentWorkflow> = [];
    const first = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
      persistWorkflow: (_parentId, workflow) => snapshots.push(structuredClone(workflow)),
    }, stalledChildren.factory);
    const modelRuntime = runtime();

    const started = await executeNamedTool(first, modelRuntime, 'subagent_workflow', 'workflow-restart', {
      action: 'start', nodes: [{ id: 'resume-me', task: 'Continue after restart', mailboxTtlSeconds: 0 }],
    });
    const workflowId = (started.details as { workflowIds: string[] }).workflowIds[0]!;
    await vi.waitFor(() => expect(first.getWorkflowViews('parent-1')[0]?.nodes[0]?.status).toBe('running'));
    const activeSnapshot = [...snapshots].reverse().find((workflow) => workflow.status === 'running')!;
    await first.cancelAll();

    const restoredParent = {
      ...parentSession(),
      sessionManager: { getBranch: () => [{
        type: 'custom', customType: 'fate-subagent-workflow',
        data: { kind: 'fate-subagent-workflow-snapshot', version: 1, workflow: activeSnapshot },
      }] },
    } as unknown as AgentSession;
    const resumedChildren = childFactory();
    const restored = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: restoredParent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, resumedChildren.factory);
    restored.restoreParent(restoredParent);
    expect(restored.getWorkflowViews('parent-1')[0]).toMatchObject({ id: workflowId, status: 'paused', nodes: [expect.objectContaining({ handle: 'resume-me', status: 'interrupted' })] });

    const cancelledRestore = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: restoredParent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, childFactory().factory);
    cancelledRestore.restoreParent(restoredParent);
    await executeNamedTool(cancelledRestore, modelRuntime, 'subagent_workflow', 'paused-cancel', {
      action: 'cancel', workflowId, reason: 'Do not resume this recovered graph.',
    });
    expect(cancelledRestore.getWorkflowViews('parent-1')[0]).toMatchObject({
      status: 'cancelled', nodes: [expect.objectContaining({ status: 'cancelled' })],
    });

    await executeNamedTool(restored, modelRuntime, 'subagent_workflow', 'workflow-resume', { action: 'resume', workflowId });
    await vi.waitFor(() => expect(restored.getWorkflowViews('parent-1')[0]?.status).toBe('completed'));
    expect(restored.getRuns('parent-1')[0]?.handle).toBe('resume-me');
    expect(resumedChildren.prompts).toEqual(['Continue after restart']);
  });
});
