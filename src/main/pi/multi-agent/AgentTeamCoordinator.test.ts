import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ChildSessionInput } from '../SubagentSessionFactory';

const createdInputs: ChildSessionInput[] = [];
const childSessions: AgentSession[] = [];

vi.mock('../SubagentSessionFactory', async () => {
  const actual = await vi.importActual<typeof import('../SubagentSessionFactory')>('../SubagentSessionFactory');
  return {
    ...actual,
    createSdkChildSession: vi.fn(async (input: ChildSessionInput) => {
      createdInputs.push(input);
      const messages: unknown[] = [];
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
        prompt: vi.fn(async (text: string) => {
          messages.push({ role: 'user', content: text });
          messages.push({ role: 'assistant', content: [{ type: 'text', text: `result:${input.teamIdentity?.path}` }], stopReason: 'stop' });
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
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-agent-team-test-'));
});
afterEach(async () => { await fs.rm(dataRoot, { recursive: true, force: true }); });

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
    const coordinator = new AgentTeamCoordinator({
      resolveRoot: () => ({ projectPath: dataRoot, session: root, permissionLevel: 'full-access' }),
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
    expect(root.sendCustomMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: 'fate-agent-team-envelope' }), expect.anything());
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
