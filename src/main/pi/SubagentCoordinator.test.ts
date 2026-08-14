import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession, AgentSessionEvent, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PiEvent, SubagentLivenessReport, SubagentRun, SubagentToolDetails, SubagentWorkflowLivenessReport } from '../../shared/contracts/ipc';
import { subagentToolDetailsSchema } from '../../shared/contracts/ipc';
import { SubagentCoordinator, type SubagentChildSessionFactory } from './SubagentCoordinator';
import type { ChildSessionInput } from './SubagentSessionFactory';

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

function childFactory(options: { delay?: number; waitForAbort?: boolean; failPrompts?: number; resultText?: string; holdUntilConcurrent?: number; usageTurnsBeforeWait?: number; compactionError?: boolean } = {}) {
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
  const subscriberCallbacks: Array<(event: AgentSessionEvent) => void> = [];
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
      subscribe: (listener: (event: AgentSessionEvent) => void) => {
        listeners.add(listener);
        subscriberCallbacks.push(listener);
        return () => listeners.delete(listener);
      },
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
        for (let index = 0; index < (options.usageTurnsBeforeWait ?? 0); index += 1) {
          messages.push({
            role: 'assistant', content: [], timestamp: index + 1,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
          });
        }
        emit({ type: 'agent_start' });
        emit({ type: 'message_start', message: user });
        emit({ type: 'message_end', message: user });
        const assistant = { role: 'assistant', content: [], timestamp: 2 };
        emit({ type: 'message_start', message: assistant });
        emit({ type: 'message_update', message: assistant, assistantMessageEvent: { type: 'thinking_delta', delta: 'Inspect first.' } });
        emit({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'README.md' } });
        emit({ type: 'tool_execution_end', toolCallId: 'read-1', toolName: 'read', result: { content: [{ type: 'text', text: 'README' }] }, isError: false });
        if (options.compactionError) emit({ type: 'compaction_end', aborted: false, errorMessage: 'Nothing to compact (session too small)' });
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
      getActiveToolNames: vi.fn(() => [...input.toolNames]),
      setActiveToolsByName: vi.fn(),
      abort: vi.fn(async () => { aborted = true; releaseAbort?.(); }),
      dispose: vi.fn(),
    } as unknown as AgentSession;
    sessions.push(session);
    return session;
  };
  return { factory, inputs, prompts, sessions, subscriberCallbacks, maximumConcurrent: () => maximumConcurrent };
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
  it('threads legacy runId and parentToolCallId into the child session input', async () => {
    const parent = parentSession();
    const captured: ChildSessionInput[] = [];
    const inner = childFactory();
    const factory: SubagentChildSessionFactory = async (input) => { captured.push(input); return inner.factory(input); };
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'edit' }),
      emit: () => undefined,
    }, factory);
    await executeTool(coordinator, { task: 'inspect', role: 'scout', permission: 'read-only' }, undefined, undefined, runtime());
    expect(captured[0]?.parentToolCallId).toBe('delegate-1');
    expect(captured[0]?.runId).toBeTruthy();
  });
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

  it('resolves the current legacy child permission dynamically and undefined for a missing context', async () => {
    const parent = parentSession();
    const children = childFactory({ waitForAbort: true });
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, children.factory);
    const modelRuntime = runtime();

    const launched = await executeNamedTool(coordinator, modelRuntime, 'subagent_start', 'start-perm', {
      task: 'Investigate', role: 'worker', permission: 'edit',
    });
    const runId = (launched.details as SubagentToolDetails).runIds[0]!;
    expect(coordinator.currentPermissionForRun(runId)).toBe('edit');

    // A goal-policy cap lowers the live permission and is reflected at write time.
    coordinator.capDelegationPermission('parent-1', 'read-only');
    expect(coordinator.currentPermissionForRun(runId)).toBe('read-only');

    // A run whose context is gone (closed or never launched) resolves no permission.
    expect(coordinator.currentPermissionForRun('never-launched')).toBeUndefined();

    // Wait until the child is actually running, then cancel; the retained context is removed.
    await vi.waitFor(() => expect(children.maximumConcurrent()).toBe(1));
    await coordinator.cancelParent('parent-1');
    expect(coordinator.currentPermissionForRun(runId)).toBeUndefined();
  });

  it('enforces GoalMax delegation strategy without weakening read-only child work', async () => {
    const parent = parentSession();
    const children = childFactory();
    let agentStrategy: 'off' | 'read-only' = 'off';
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access', agentStrategy }),
      emit: () => undefined,
    }, children.factory);

    await expect(executeTool(coordinator, { task: 'ordinary delegation', permission: 'edit' }, undefined, undefined, runtime()))
      .rejects.toThrow(/strategy is off/u);
    expect(children.inputs).toEqual([]);

    agentStrategy = 'read-only';
    // An explicit tool request beyond the effective permission is rejected loudly
    // instead of being silently dropped.
    await expect(executeTool(coordinator, {
      task: 'inspect without writing', role: 'reviewer', permission: 'full-access', tools: ['read', 'grep', 'write', 'edit', 'bash'],
    }, undefined, undefined, runtime())).rejects.toThrow(/not granted at the effective child permission 'read-only'/u);
    expect(children.inputs).toEqual([]);

    const result = await executeTool(coordinator, {
      task: 'inspect without writing', role: 'reviewer', permission: 'read-only', tools: ['read', 'grep'],
    }, undefined, undefined, runtime());
    const details = subagentToolDetailsSchema.parse(result.details);

    expect(details.runs?.[0]).toMatchObject({ status: 'completed', permissionLevel: 'read-only' });
    expect(children.inputs[0]).toMatchObject({ permissionLevel: 'read-only', toolNames: ['read', 'grep'] });
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
      tools: ['read', 'grep'],
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
    expect(children.sessions[0]?.dispose).toHaveBeenCalledOnce();
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

  it('ignores late callbacks from a previous retained turn', async () => {
    const parent = parentSession();
    const children = childFactory({ delay: 20 });
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, children.factory);
    const modelRuntime = runtime();

    const launched = await executeNamedTool(coordinator, modelRuntime, 'subagent_start', 'epoch-start', {
      task: 'Complete an initial turn', mailboxTtlSeconds: 120,
    });
    const runId = (launched.details as SubagentToolDetails).runIds[0]!;
    await vi.waitFor(() => expect(coordinator.getRuns('parent-1')[0]?.mailbox.state).toBe('available'));
    const staleListener = children.subscriberCallbacks[0]!;

    const following = executeNamedTool(coordinator, modelRuntime, 'subagent_manage', 'epoch-followup', {
      action: 'followup', runId, message: 'Complete the retained follow-up', extendMailboxTtlSeconds: 120,
    });
    await vi.waitFor(() => expect(coordinator.getRuns('parent-1')[0]?.status).toBe('running'));
    staleListener(sdkEvent({ type: 'tool_execution_start', toolCallId: 'stale-tool', toolName: 'bash', args: { command: 'echo stale' } }));
    await following;
    staleListener(sdkEvent({ type: 'tool_execution_end', toolCallId: 'stale-tool', toolName: 'bash', result: { content: [{ type: 'text', text: 'stale' }] }, isError: false }));

    expect(coordinator.getRuns('parent-1')[0]?.tools.some((tool) => tool.name === 'bash')).toBe(false);
    await executeNamedTool(coordinator, modelRuntime, 'subagent_manage', 'epoch-close', { action: 'close', runIds: [runId] });
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

  it('ignores late callbacks from a discarded provider attempt', async () => {
    const parent = parentSession();
    const children = childFactory({ failPrompts: 1, waitForAbort: true });
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, children.factory);
    const controller = new AbortController();

    const running = executeTool(coordinator, {
      task: 'Retry after one provider failure', routing: { maxAttempts: 2 },
    }, controller.signal);
    await vi.waitFor(() => expect(children.sessions).toHaveLength(2));
    children.subscriberCallbacks[0]!(sdkEvent({
      type: 'tool_execution_start', toolCallId: 'stale-attempt-tool', toolName: 'bash', args: { command: 'echo stale' },
    }));

    expect(coordinator.getRuns('parent-1')[0]?.tools.some((tool) => tool.name === 'bash')).toBe(false);
    controller.abort();
    await expect(running).resolves.toMatchObject({ details: expect.any(Object) });
  });

  it('applies ordered provider retries and treats resource thresholds as parent-supervised advisories', async () => {
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

    const budgetChildren = childFactory({ compactionError: true });
    const emitted: PiEvent[] = [];
    const notifications: SubagentLivenessReport[] = [];
    const budgeted = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: (_parentId, event) => { emitted.push(event); },
      notifyParent: async (_parentId, _mode, _text, _runIds, _workflowId, report) => {
        if (report && 'child' in report) notifications.push(report);
      },
    }, budgetChildren.factory);
    const budgetResult = await executeTool(budgeted, {
      task: 'Continue beyond every resource checkpoint',
      budget: { maxCostUsd: 0.001, maxInputTokens: 1, maxOutputTokens: 1, maxTotalTokens: 2 },
    });
    expect((budgetResult.details as SubagentToolDetails).runs?.[0]).toMatchObject({
      status: 'completed',
      livenessReports: [expect.objectContaining({ trigger: 'resource-limit' })],
    });
    expect(notifications).toEqual([]);
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'subagent.liveness', report: expect.objectContaining({ trigger: 'resource-limit' }) }),
      expect.objectContaining({ type: 'subagent.event', event: expect.objectContaining({ type: 'context.compaction', phase: 'failed' }) }),
    ]));
    expect(budgetChildren.sessions[0]?.abort).not.toHaveBeenCalled();
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
    const children = childFactory({ holdUntilConcurrent: 2 });
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

  it('restores interrupted children once and keeps repeated management reads terminal and idempotent', async () => {
    const parent = parentSession();
    const children = childFactory();
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, children.factory);
    const result = await executeTool(coordinator, { task: 'Inspect the project', role: 'scout', permission: 'read-only' });
    const details = result.details as SubagentToolDetails;
    const staleManagedRun: SubagentRun = {
      ...details.runs![0]!,
      id: 'managed-before-restart',
      parentToolCallId: 'managed-start',
      task: 'Persist through restart',
      executionMode: 'managed',
      status: 'running',
      mailbox: { state: 'available', ttlMs: 120_000, expiresAt: 1, followUpCount: 2 },
      updatedAt: 20,
      endedAt: undefined,
      result: undefined,
      error: 'stale provider metadata',
    };
    const history = [
      {
        role: 'assistant', timestamp: 10, content: [
          { type: 'toolCall', id: 'delegate-1', name: 'subagent', arguments: { task: 'Inspect the project', role: 'scout', permission: 'read-only' } },
          { type: 'toolCall', id: 'unfinished', name: 'subagent', arguments: { task: 'Finish later', role: 'worker', permission: 'edit' } },
          { type: 'toolCall', id: 'managed-start', name: 'subagent_start', arguments: { task: 'Persist through restart', mailboxTtlSeconds: 120 } },
        ],
      },
      { role: 'toolResult', toolCallId: 'delegate-1', toolName: 'subagent', details, content: [{ type: 'text', text: 'done' }] },
      { role: 'toolResult', toolCallId: 'managed-start', toolName: 'subagent_start', details: { kind: 'fate-subagent', version: 3, runIds: [staleManagedRun.id], runs: [staleManagedRun] }, content: [{ type: 'text', text: 'launched' }] },
    ];
    const restoredParent = parentSession(history);
    const restored = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: restoredParent, permissionLevel: 'full-access' }),
      emit: () => undefined,
    }, children.factory);

    restored.restoreParent(restoredParent);

    expect(restored.getRuns('parent-1').map((run) => run.status).sort()).toEqual(['completed', 'interrupted', 'interrupted']);
    const interrupted = restored.getRuns('parent-1').find((run) => run.task === 'Finish later');
    expect(interrupted).toMatchObject({
      task: 'Finish later', role: 'worker', status: 'interrupted', mailbox: { state: 'disabled' },
      result: 'Fate UI restarted before this child run settled.',
    });
    expect(interrupted?.error).toBeUndefined();
    const persistedInterrupted = restored.getRuns('parent-1').find((run) => run.id === staleManagedRun.id);
    expect(persistedInterrupted).toMatchObject({
      status: 'interrupted', result: 'Fate UI restarted before this child run settled.',
      mailbox: { state: 'expired', ttlMs: 120_000, followUpCount: 2 },
    });
    expect(persistedInterrupted?.error).toBeUndefined();
    expect(persistedInterrupted?.timeoutAt).toBeUndefined();

    const recoveredState = restored.getRuns('parent-1');
    const modelRuntime = runtime();
    const list = await executeNamedTool(restored, modelRuntime, 'subagent_manage', 'restart-list-1', { action: 'list' });
    const listAgain = await executeNamedTool(restored, modelRuntime, 'subagent_manage', 'restart-list-2', { action: 'list' });
    const status = await executeNamedTool(restored, modelRuntime, 'subagent_manage', 'restart-status-1', { action: 'status', runIds: [`@${persistedInterrupted?.handle}`] });
    const statusAgain = await executeNamedTool(restored, modelRuntime, 'subagent_manage', 'restart-status-2', { action: 'status', runIds: [`@${persistedInterrupted?.handle}`] });
    const waited = await executeNamedTool(restored, modelRuntime, 'subagent_manage', 'restart-wait-1', { action: 'wait', runIds: [`@${persistedInterrupted?.handle}`], until: 'all', timeoutSeconds: 0 });
    const waitedAgain = await executeNamedTool(restored, modelRuntime, 'subagent_manage', 'restart-wait-2', { action: 'wait', runIds: [`@${persistedInterrupted?.handle}`], until: 'all', timeoutSeconds: 0 });

    expect(listAgain.content).toEqual(list.content);
    expect(statusAgain.content).toEqual(status.content);
    expect(waitedAgain.content).toEqual(waited.content);
    for (const response of [status, statusAgain, waited, waitedAgain]) {
      expect(subagentToolDetailsSchema.parse(response.details).runs?.[0]).toMatchObject({
        id: persistedInterrupted?.id, status: 'interrupted', result: 'Fate UI restarted before this child run settled.',
      });
      expect(subagentToolDetailsSchema.parse(response.details).runs?.[0]?.error).toBeUndefined();
    }
    expect(restored.getRuns('parent-1')).toEqual(recoveredState);
    expect(children.prompts).toEqual(['Inspect the project']);
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

  it('emits an active runtime threshold as telemetry without queuing a parent turn', async () => {
    vi.useFakeTimers();
    const parent = parentSession();
    const children = childFactory({ waitForAbort: true });
    const notifications: SubagentLivenessReport[] = [];
    const emitted: PiEvent[] = [];
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: (_parentId, event) => emitted.push(event),
      notifyParent: async (_parentId, _mode, _text, _runIds, _workflowId, report) => {
        if (report && 'child' in report) notifications.push(report);
      },
    }, children.factory);
    const controller = new AbortController();

    const running = executeTool(coordinator, { task: 'Continue after the advisory', timeoutSeconds: 30 }, controller.signal);
    await vi.waitFor(() => expect(children.maximumConcurrent()).toBe(1));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(coordinator.getRuns('parent-1')[0]?.livenessReports).toHaveLength(1));

    expect(coordinator.getRuns('parent-1')[0]?.livenessReports?.[0]).toMatchObject({
      trigger: 'runtime-limit', child: { runId: expect.any(String), handle: 'agent-1' },
      evidence: [expect.objectContaining({ signal: 'runtime-duration' })],
      recommendedOptions: ['continue', 'steer', 'request-checkpoint', 'cancel'],
    });
    expect(notifications).toEqual([]);
    expect(emitted.some((event) => event.type === 'subagent.liveness' && event.report.trigger === 'runtime-limit')).toBe(true);
    expect(coordinator.getRuns('parent-1')[0]).toMatchObject({ status: 'running', livenessReports: [expect.objectContaining({ trigger: 'runtime-limit' })] });
    expect(children.sessions[0]?.abort).not.toHaveBeenCalled();

    controller.abort();
    const result = await running;
    expect((result.details as SubagentToolDetails).runs?.[0]?.status).toBe('cancelled');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(coordinator.getRuns('parent-1')[0]?.livenessReports).toHaveLength(1);
    expect(notifications).toEqual([]);
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

  it('reports idle providers as telemetry with cooldown and never terminates them', async () => {
    vi.useFakeTimers();
    const parent = parentSession();
    const children = childFactory({ waitForAbort: true });
    const notifications: SubagentLivenessReport[] = [];
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
      notifyParent: async (_parentId, _mode, _text, _runIds, _workflowId, report) => { if (report && 'child' in report) notifications.push(report); },
    }, children.factory);
    const controller = new AbortController();

    const running = executeTool(coordinator, {
      task: 'Become observably stuck', timeoutSeconds: 60, idleTimeoutSeconds: 15,
    }, controller.signal);
    await vi.waitFor(() => expect(children.maximumConcurrent()).toBe(1));
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(coordinator.getRuns('parent-1')[0]?.livenessReports).toHaveLength(1));

    expect(coordinator.getRuns('parent-1')[0]?.livenessReports?.[0]).toMatchObject({ trigger: 'idle', timing: { idleForMs: 15_000, cooldownMs: 300_000 } });
    expect(notifications).toEqual([]);
    expect(coordinator.getRuns('parent-1')[0]?.status).toBe('running');
    expect(children.sessions[0]?.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    const reports = coordinator.getRuns('parent-1')[0]?.livenessReports ?? [];
    expect(reports).toHaveLength(2);
    expect(reports.map((report) => report.trigger)).toEqual(['idle', 'runtime-limit']);

    controller.abort();
    const result = await running;
    expect((result.details as SubagentToolDetails).runs?.[0]?.status).toBe('cancelled');
  });

  it('treats the former 28-turn budget failure as adaptive telemetry and continues', async () => {
    const parent = parentSession();
    const children = childFactory({ waitForAbort: true, usageTurnsBeforeWait: 29 });
    const notifications: SubagentLivenessReport[] = [];
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
      notifyParent: async (_parentId, _mode, _text, _runIds, _workflowId, report) => { if (report && 'child' in report) notifications.push(report); },
    }, children.factory);
    const controller = new AbortController();

    const running = executeTool(coordinator, { task: 'Work beyond the old turn cap', budget: { maxTurns: 28 } }, controller.signal);
    await vi.waitFor(() => expect(coordinator.getRuns('parent-1')[0]?.livenessReports?.some((report) => report.trigger === 'adaptive-limit')).toBe(true));
    expect(notifications).toEqual([]);
    expect(coordinator.getRuns('parent-1')[0]).toMatchObject({ status: 'running', usage: { turns: 29 } });
    expect(children.sessions[0]?.abort).not.toHaveBeenCalled();

    controller.abort();
    const result = await running;
    const final = (result.details as SubagentToolDetails).runs?.[0];
    expect(final?.status).toBe('cancelled');
    expect(final?.error).not.toContain('budget exceeded');
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

    // An explicit bash/write request beyond the read-only parent is rejected
    // loudly; a narrowed request still preserves the role label and bounds.
    await expect(executeTool(coordinator, {
      task: 'Perform the domain pass',
      role: 'database-migration-specialist',
      permission: 'full-access',
      tools: ['read', 'grep', 'bash', 'write'],
      skillMode: 'none',
    })).rejects.toThrow(/not granted at the effective child permission 'read-only'/u);
    expect(children.inputs).toEqual([]);

    const result = await executeTool(coordinator, {
      task: 'Perform the domain pass',
      role: 'database-migration-specialist',
      permission: 'full-access',
      tools: ['read', 'grep'],
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

  it('persists and emits a structured aggregate workflow turn report while continuing remaining nodes', async () => {
    const parent = parentSession();
    const children = childFactory();
    const events: PiEvent[] = [];
    const snapshots: Array<import('./SubagentWorkflow').SubagentWorkflow> = [];
    const notifications: Array<{ mode: string; text: string; workflowId?: string; report?: SubagentWorkflowLivenessReport }> = [];
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: (_parentId, event) => { events.push(event); },
      persistWorkflow: (_parentId, workflow) => { snapshots.push(structuredClone(workflow)); },
      notifyParent: async (_parentId, mode, text, _runIds, workflowId, report) => {
        notifications.push({
          mode,
          text,
          ...(workflowId ? { workflowId } : {}),
          ...(report && 'workflow' in report ? { report } : {}),
        });
      },
    }, children.factory);

    const started = await executeNamedTool(coordinator, runtime(), 'subagent_workflow', 'workflow-soft-turns', {
      action: 'start', maxConcurrency: 1, budget: { maxTurns: 1 },
      nodes: [
        { id: 'first', task: 'Complete first' },
        { id: 'second', task: 'Complete second', dependsOn: ['first'] },
        { id: 'third', task: 'Continue after the checkpoint', dependsOn: ['second'] },
      ],
    });
    const workflowId = (started.details as { workflowIds: string[] }).workflowIds[0]!;
    await vi.waitFor(() => expect(coordinator.getWorkflowViews('parent-1')[0]?.status).toBe('completed'));

    expect(children.prompts).toEqual(['Complete first', 'Complete second', 'Continue after the checkpoint']);
    expect(coordinator.getWorkflowViews('parent-1')[0]).toMatchObject({
      status: 'completed', usage: { turns: 3 }, nodes: [
        expect.objectContaining({ status: 'completed' }),
        expect.objectContaining({ status: 'completed' }),
        expect.objectContaining({ status: 'completed' }),
      ],
      livenessReports: [expect.objectContaining({
        trigger: 'adaptive-limit', workflow: { id: workflowId }, counters: expect.objectContaining({ turns: 2, completedNodes: 2, pendingNodes: 1 }),
      })],
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'subagent.workflow.liveness', workflowId, report: expect.objectContaining({ trigger: 'adaptive-limit' }) }),
      expect.objectContaining({ type: 'subagent.workflow.updated', workflow: expect.objectContaining({ livenessReports: expect.any(Array) }) }),
    ]));
    expect(snapshots.some((workflow) => workflow.livenessReports?.some((report) => report.workflow.id === workflowId))).toBe(true);
    expect(notifications).toEqual([]);
  });

  it('drops a workflow checkpoint detected only after the final node settles', async () => {
    const parent = parentSession();
    const children = childFactory();
    const notifications = vi.fn(async () => undefined);
    const coordinator = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: () => undefined,
      notifyParent: notifications,
    }, children.factory);

    await executeNamedTool(coordinator, runtime(), 'subagent_workflow', 'workflow-terminal-checkpoint', {
      action: 'start', maxConcurrency: 1, budget: { maxTurns: 1 },
      nodes: [
        { id: 'first', task: 'Complete first' },
        { id: 'final', task: 'Complete last', dependsOn: ['first'] },
      ],
    });
    await vi.waitFor(() => expect(coordinator.getWorkflowViews('parent-1')[0]?.status).toBe('completed'));

    expect(coordinator.getWorkflowViews('parent-1')[0]?.livenessReports).toBeUndefined();
    expect(notifications).not.toHaveBeenCalled();
  });

  it('reports aggregate resource thresholds without stopping nodes and preserves explicit parent cancellation', async () => {
    const parent = parentSession();
    const budgetChildren = childFactory();
    const budgetEvents: PiEvent[] = [];
    const budgetNotifications: SubagentWorkflowLivenessReport[] = [];
    const budgeted = new SubagentCoordinator({
      resolveParent: () => ({ projectPath: '/project', session: parent, permissionLevel: 'full-access' }),
      emit: (_parentId, event) => { budgetEvents.push(event); },
      notifyParent: async (_parentId, _mode, _text, _runIds, _workflowId, report) => {
        if (report && 'workflow' in report) budgetNotifications.push(report);
      },
    }, budgetChildren.factory);
    const modelRuntime = runtime();

    const started = await executeNamedTool(budgeted, modelRuntime, 'subagent_workflow', 'workflow-budget', {
      action: 'start', maxConcurrency: 1, budget: { maxCostUsd: 0.001 },
      nodes: [
        { id: 'one', task: 'Cross the advisory resource threshold' },
        { id: 'two', task: 'Continue after the advisory', dependsOn: ['one'] },
      ],
    });
    const budgetWorkflowId = (started.details as { workflowIds: string[] }).workflowIds[0]!;
    await vi.waitFor(() => expect(budgeted.getWorkflowViews('parent-1')[0]?.status).toBe('completed'));
    const budgetWorkflow = budgeted.getWorkflowViews('parent-1')[0]!;
    expect(budgetWorkflow).toMatchObject({
      usage: { turns: 2, cost: 0.02 },
      nodes: [expect.objectContaining({ status: 'completed' }), expect.objectContaining({ status: 'completed' })],
      livenessReports: [expect.objectContaining({ trigger: 'resource-limit' })],
    });
    expect(budgetChildren.prompts).toEqual(['Cross the advisory resource threshold', 'Continue after the advisory']);
    expect(budgetWorkflow.livenessReports?.[0]).toMatchObject({
      trigger: 'resource-limit', evidence: [expect.objectContaining({ signal: 'cost-threshold' })],
    });
    expect(budgetNotifications).toEqual([]);
    expect(budgetEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'subagent.workflow.liveness', report: expect.objectContaining({ trigger: 'resource-limit' }) }),
    ]));

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
