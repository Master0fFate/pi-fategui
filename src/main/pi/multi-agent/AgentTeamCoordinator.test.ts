import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AGENT_TEAM_MAX_MESSAGE_BYTES } from '../../../shared/contracts/multiAgent';
import type { ChildSessionInput } from '../SubagentSessionFactory';

const createdInputs: ChildSessionInput[] = [];
const childSessions: AgentSession[] = [];
const childUnsubscribes: ReturnType<typeof vi.fn>[] = [];
let promptBarrier: Promise<void> | null = null;

vi.mock('../SubagentSessionFactory', async () => {
  const actual = await vi.importActual<typeof import('../SubagentSessionFactory')>('../SubagentSessionFactory');
  return {
    ...actual,
    createSdkChildSession: vi.fn(async (input: ChildSessionInput) => {
      createdInputs.push(input);
      const messages: unknown[] = [];
      let listener: ((event: unknown) => void) | null = null;
      const unsubscribe = vi.fn(() => { listener = null; });
      childUnsubscribes.push(unsubscribe);
      const session = {
        sessionId: `child-${childSessions.length + 1}`,
        sessionFile: path.join(input.sessionDirectory ?? os.tmpdir(), `child-${childSessions.length + 1}.jsonl`),
        model: input.model,
        thinkingLevel: input.thinkingLevel,
        messages,
        isStreaming: false,
        sessionManager: { getSessionId: () => `child-${childSessions.length + 1}` },
        resourceLoader: { getSkills: () => ({ skills: [] }) },
        getToolDefinition: vi.fn((name: string) => input.collaborationTools?.find((tool) => tool.name === name)),
        subscribe: vi.fn((next: (event: unknown) => void) => { listener = next; return unsubscribe; }),
        prompt: vi.fn(async (text: string) => {
          messages.push({ role: 'user', content: text });
          listener?.({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'src/example.ts' } });
          listener?.({ type: 'tool_execution_end', toolCallId: 'read-1', toolName: 'read', result: 'ok', isError: false });
          if (promptBarrier) await promptBarrier;
          const assistant = { role: 'assistant', content: [{ type: 'text', text: `result:${input.teamIdentity?.path}` }], stopReason: 'stop' };
          messages.push(assistant);
          listener?.({ type: 'message_end', message: assistant });
        }),
        sendCustomMessage: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
        dispose: vi.fn(),
      } as unknown as AgentSession;
      if (session.sessionFile) {
        await fs.mkdir(path.dirname(session.sessionFile), { recursive: true });
        await fs.writeFile(session.sessionFile, '', { flag: 'a' });
      }
      childSessions.push(session);
      return session;
    }),
  };
});

import { AgentTeamCoordinator } from './AgentTeamCoordinator';

const model = { provider: 'test', id: 'model', name: 'Model', reasoning: true, contextWindow: 128_000, input: ['text'] } as const;
let dataRoot: string;

beforeEach(async () => {
  createdInputs.length = 0;
  childSessions.length = 0;
  childUnsubscribes.length = 0;
  promptBarrier = null;
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-agent-team-test-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dataRoot, { recursive: true, force: true });
});

function rootSession() {
  const messages: unknown[] = [];
  return {
    sessionId: 'root-session', model, thinkingLevel: 'max', messages,
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    sessionManager: { getBranch: () => [], appendCustomEntry: vi.fn(), getSessionId: () => 'root-session' },
    sendCustomMessage: vi.fn(async () => undefined),
    isStreaming: true,
  } as unknown as AgentSession;
}

function runtime() {
  return {
    getAvailable: vi.fn(async () => [model]),
    getModel: vi.fn(() => model),
  } as unknown as ModelRuntime;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('AgentTeamCoordinator vertical slice', () => {
  it('runs a child and grandchild with caller-scoped tools and direct-parent result routing', async () => {
    const root = rootSession();
    const emitted: unknown[] = [];
    const persisted: unknown[] = [];
    const sendRootMessage = vi.fn(async () => undefined);
    const coordinator = new AgentTeamCoordinator({
      resolveRoot: () => ({ projectPath: dataRoot, session: root, permissionLevel: 'full-access' }),
      sendRootMessage,
      emit: (_root, team) => emitted.push(team),
      persist: (_root, event) => persisted.push(event),
    }, dataRoot);
    const modelRuntime = runtime();
    const rootId = coordinator.rootNodeId('root-session');
    const child = await coordinator.spawn(rootId, { task: 'investigate', name: 'reviewer', permission: 'read-only' }, 'spawn-1', modelRuntime);
    await settle();
    const firstTeam = coordinator.getTeams('root-session')[0]!;
    expect(firstTeam.nodes.find((node) => node.id === child.nodeId)).toMatchObject({ path: '/root/reviewer', status: 'ready', depth: 1 });
    expect(firstTeam.tasks).toHaveLength(1);
    expect(firstTeam.envelopes.map((item) => item.kind)).toEqual(['NEW_TASK', 'FINAL_ANSWER']);
    expect(firstTeam.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool.started', nodeId: child.nodeId, toolName: 'read', provenance: expect.objectContaining({ actor: expect.objectContaining({ kind: 'team', nodeId: child.nodeId }), affectedPaths: [{ path: 'src/example.ts', operation: 'read' }] }) }),
      expect.objectContaining({ type: 'tool.completed', nodeId: child.nodeId, toolName: 'read' }),
      expect.objectContaining({ type: 'message.completed', nodeId: child.nodeId }),
    ]));
    expect(sendRootMessage).toHaveBeenCalledWith('root-session', expect.objectContaining({ customType: 'fate-agent-team-envelope' }), 'steer', false);
    expect(root.sendCustomMessage).not.toHaveBeenCalled();
    expect(createdInputs[0]?.collaborationTools?.map((tool) => tool.name)).toEqual(['spawn_agent', 'send_message', 'followup_task', 'wait_agent', 'interrupt_agent', 'list_agents']);

    const followUp = await coordinator.followUp(rootId, child.nodeId, 'continue with retained context', 'follow-1', modelRuntime);
    await settle();
    expect(coordinator.getTeams('root-session')[0]?.tasks.find((task) => task.id === followUp.taskId)?.status).toBe('completed');
    expect(childSessions).toHaveLength(1);

    const grandchild = await coordinator.spawn(child.nodeId, { task: 'verify', name: 'tester', permission: 'read-only' }, 'spawn-2', modelRuntime);
    await settle();
    const team = coordinator.getTeams('root-session')[0]!;
    expect(team.nodes.find((node) => node.id === grandchild.nodeId)).toMatchObject({ path: '/root/reviewer/tester', status: 'ready', depth: 2 });
    expect(childSessions[0]?.sendCustomMessage).toHaveBeenCalled();
    await expect(coordinator.spawn(grandchild.nodeId, { task: 'too deep' }, 'spawn-3', modelRuntime)).rejects.toThrow(/maximum descendant depth/);
    expect(emitted.length).toBeGreaterThan(2);
    expect(persisted.length).toBeGreaterThan(0);
  });

  it('waits for the terminal task result instead of an intermediate child change', async () => {
    let releasePrompt: () => void = () => undefined;
    promptBarrier = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const coordinator = new AgentTeamCoordinator({
      resolveRoot: () => ({ projectPath: dataRoot, session: rootSession(), permissionLevel: 'read-only' }),
      emit: () => undefined,
      persist: () => undefined,
    }, dataRoot);
    const rootId = coordinator.rootNodeId('root-session');
    const child = await coordinator.spawn(rootId, { task: 'verify', name: 'verifier' }, 'settlement-spawn', runtime());
    const settlement = coordinator.waitForTaskSettlement(rootId, child.path, 1_000);
    let resolved = false;
    void settlement.then(() => { resolved = true; });

    await settle();
    expect(resolved).toBe(false);

    releasePrompt();
    promptBarrier = null;
    await expect(settlement).resolves.toMatchObject({
      task: { assigneeNodeId: child.nodeId, status: 'completed' },
      envelope: { kind: 'FINAL_ANSWER', content: 'result:/root/verifier' },
    });
  });

  it('creates a bounded leaf child without collaboration tools', async () => {
    const coordinator = new AgentTeamCoordinator({
      resolveRoot: () => ({ projectPath: dataRoot, session: rootSession(), permissionLevel: 'read-only' }),
      emit: () => undefined,
      persist: () => undefined,
    }, dataRoot);
    const rootId = coordinator.rootNodeId('root-session');

    await coordinator.spawn(rootId, { task: 'verify directly', name: 'leaf-verifier' }, 'leaf-spawn', runtime(), undefined, { allowDelegation: false });
    await settle();

    expect(createdInputs[0]?.collaborationTools).toEqual([]);
    expect(coordinator.getTeams('root-session')[0]?.nodes.find((node) => node.path === '/root/leaf-verifier')?.status).toBe('ready');
  });

  it('enforces GoalMax delegation strategy while preserving internal read-only review', async () => {
    const root = rootSession();
    let agentStrategy: 'off' | 'read-only' = 'off';
    const coordinator = new AgentTeamCoordinator({
      resolveRoot: () => ({ projectPath: dataRoot, session: root, permissionLevel: 'full-access', agentStrategy }),
      emit: () => undefined,
      persist: () => undefined,
    }, dataRoot);
    const rootId = coordinator.rootNodeId('root-session');

    await expect(coordinator.spawn(rootId, { task: 'ordinary delegation', permission: 'edit' }, 'blocked-spawn', runtime()))
      .rejects.toThrow(/strategy is off/u);

    const review = await coordinator.spawn(
      rootId,
      { task: 'internal verification', permission: 'read-only' },
      'review-spawn',
      runtime(),
      undefined,
      { allowDelegation: false, bypassGoalPolicy: true },
    );
    await settle();
    expect(coordinator.getTeams('root-session')[0]?.nodes.find((node) => node.id === review.nodeId))
      .toMatchObject({ permissionLevel: 'read-only' });
    expect(createdInputs.at(-1)?.collaborationTools).toEqual([]);

    agentStrategy = 'read-only';
    const child = await coordinator.spawn(rootId, { task: 'requested writer', permission: 'full-access' }, 'read-only-spawn', runtime());
    await settle();
    expect(coordinator.getTeams('root-session')[0]?.nodes.find((node) => node.id === child.nodeId))
      .toMatchObject({ permissionLevel: 'read-only', writer: false });
  });

  it('rejects an oversized UTF-8 task before reserving a child node', async () => {
    const coordinator = new AgentTeamCoordinator({
      resolveRoot: () => ({ projectPath: dataRoot, session: rootSession(), permissionLevel: 'read-only' }),
      emit: () => undefined,
      persist: () => undefined,
    }, dataRoot);
    const rootId = coordinator.rootNodeId('root-session');
    const oversized = '🧪'.repeat(Math.floor(AGENT_TEAM_MAX_MESSAGE_BYTES / 4) + 1);

    await expect(coordinator.spawn(rootId, { task: oversized, name: 'too-large' }, 'oversized-spawn', runtime()))
      .rejects.toThrow(/limited to 32768 UTF-8 bytes/u);

    const team = coordinator.getTeams('root-session')[0]!;
    expect(team.nodes).toHaveLength(1);
    expect(team.nodes[0]?.childIds).toEqual([]);
    expect(team.tasks).toEqual([]);
    expect(team.envelopes).toEqual([]);
    expect(childSessions).toHaveLength(0);
  });

  it('restores durable team state and reopens retained child context for follow-up', async () => {
    const root = rootSession();
    const persisted: Array<{ sequence: number }> = [];
    const host = {
      resolveRoot: () => ({ projectPath: dataRoot, session: root, permissionLevel: 'read-only' as const }),
      emit: () => undefined,
      persist: (_root: string, event: { sequence: number }) => { persisted.push(event); },
    };
    const modelRuntime = runtime();
    const first = new AgentTeamCoordinator(host, dataRoot);
    const rootId = first.rootNodeId('root-session');
    const child = await first.spawn(rootId, { task: 'persist me', name: 'durable' }, 'persist-spawn', modelRuntime);
    await settle();
    await vi.waitFor(() => expect(persisted.length).toBeGreaterThan(1));

    const reopenedRoot = rootSession();
    vi.spyOn(reopenedRoot.sessionManager, 'getBranch').mockReturnValue(persisted.map((event) => ({ type: 'custom', id: `event-${event.sequence}`, parentId: null, timestamp: new Date().toISOString(), customType: 'fate-agent-team-event', data: event })) as never);
    const second = new AgentTeamCoordinator({
      resolveRoot: () => ({ projectPath: dataRoot, session: reopenedRoot, permissionLevel: 'read-only' }),
      emit: () => undefined,
      persist: () => undefined,
    }, dataRoot);
    second.restoreRoot(reopenedRoot);
    const restored = second.getTeams('root-session')[0]!;
    expect(restored.status).toBe('restored-interrupted');
    expect(restored.nodes.find((node) => node.id === child.nodeId)?.status).toBe('ready');
    const follow = await second.followUp(restored.rootNodeId, child.nodeId, 'resume after restart', 'resume-op', modelRuntime);
    await settle();
    expect(second.getTeams('root-session')[0]?.tasks.find((task) => task.id === follow.taskId)?.status).toBe('completed');
    expect(createdInputs.at(-1)?.sessionFile).toMatch(/\.jsonl$/u);
  });

  it('places default child storage beneath the configured cross-platform Fate GUI data root', async () => {
    const configuredRoot = path.join(dataRoot, 'portable-profile');
    vi.stubEnv('FATE_GUI_DATA_DIR', configuredRoot);
    const coordinator = new AgentTeamCoordinator({
      resolveRoot: () => ({ projectPath: dataRoot, session: rootSession(), permissionLevel: 'read-only' }),
      emit: () => undefined,
      persist: () => undefined,
    });
    const rootId = coordinator.rootNodeId('portable-root-session');
    await coordinator.spawn(rootId, { task: 'persist portably', name: 'portable' }, 'portable-spawn', runtime());
    await settle();

    const sessionDirectory = createdInputs[0]?.sessionDirectory;
    expect(sessionDirectory).toBeTruthy();
    expect(path.dirname(path.dirname(path.dirname(sessionDirectory!)))).toBe(path.join(path.resolve(configuredRoot), 'agent-teams'));
    await coordinator.cancelRoot('portable-root-session');
    coordinator.releaseRoot('portable-root-session');
  });

  it('deletes every persisted sibling and nested child session when its root session is deleted', async () => {
    const coordinator = new AgentTeamCoordinator({
      resolveRoot: () => ({ projectPath: dataRoot, session: rootSession(), permissionLevel: 'read-only' }),
      emit: () => undefined,
      persist: () => undefined,
    }, dataRoot);
    const modelRuntime = runtime();
    const rootId = coordinator.rootNodeId('root-session');
    const child = await coordinator.spawn(rootId, { task: 'persist first child', name: 'first' }, 'delete-spawn-1', modelRuntime);
    await settle();
    await coordinator.spawn(rootId, { task: 'persist sibling', name: 'sibling' }, 'delete-spawn-2', modelRuntime);
    await settle();
    await coordinator.spawn(child.nodeId, { task: 'persist grandchild', name: 'nested' }, 'delete-spawn-3', modelRuntime);
    await settle();
    const sessionDirectories = createdInputs.map((input) => input.sessionDirectory);
    expect(sessionDirectories).toHaveLength(3);
    await Promise.all(sessionDirectories.map((sessionDirectory) => expect(fs.stat(sessionDirectory!)).resolves.toBeDefined()));

    await coordinator.deleteRootStorage('root-session');

    await Promise.all(sessionDirectories.map((sessionDirectory) => expect(fs.stat(sessionDirectory!)).rejects.toMatchObject({ code: 'ENOENT' })));
    expect(coordinator.getTeams('root-session')).toEqual([]);
    expect(childSessions).toHaveLength(3);
    for (const childSession of childSessions) expect(childSession.dispose).toHaveBeenCalled();
  });

  it('deduplicates repeated operation IDs and rejects self-targeting', async () => {
    const root = rootSession();
    const coordinator = new AgentTeamCoordinator({
      resolveRoot: () => ({ projectPath: dataRoot, session: root, permissionLevel: 'read-only' }),
      emit: () => undefined,
      persist: () => undefined,
    }, dataRoot);
    const modelRuntime = runtime();
    const rootId = coordinator.rootNodeId('root-session');
    const first = await coordinator.spawn(rootId, { task: 'one', name: 'reader' }, 'same-op', modelRuntime);
    const second = await coordinator.spawn(rootId, { task: 'ignored duplicate', name: 'other' }, 'same-op', modelRuntime);
    expect(second.nodeId).toBe(first.nodeId);
    expect(coordinator.getTeams('root-session')[0]?.nodes).toHaveLength(2);
    await expect(coordinator.sendMessage(rootId, rootId, 'self', 'message-op')).rejects.toThrow(/message themselves/);
  });
});
