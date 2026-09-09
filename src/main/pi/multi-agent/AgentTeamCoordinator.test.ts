import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AGENT_TEAM_MAX_MESSAGE_BYTES, type AgentTeam } from '../../../shared/contracts/multiAgent';
import { AgentWorkspaceGitService } from '../../git/AgentWorkspaceGitService';
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
      let releaseAbort: () => void = () => undefined;
      const aborted = new Promise<void>((resolve) => { releaseAbort = resolve; });
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
          if (promptBarrier) await Promise.race([promptBarrier, aborted]);
          const assistant = { role: 'assistant', content: [{ type: 'text', text: `result:${input.teamIdentity?.path}` }], stopReason: 'stop' };
          messages.push(assistant);
          listener?.({ type: 'message_end', message: assistant });
        }),
        sendCustomMessage: vi.fn(async (message: Parameters<AgentSession['sendCustomMessage']>[0]) => {
          const accepted = { ...message, role: 'custom' };
          messages.push(accepted);
          listener?.({ type: 'message_end', message: accepted });
        }),
        abort: vi.fn(async () => { releaseAbort(); }),
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
  dataRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fate-agent-team-test-')));
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
    sendCustomMessage: vi.fn(async (message: Parameters<AgentSession['sendCustomMessage']>[0]) => { messages.push({ ...message, role: 'custom' }); }),
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

describe('AgentTeamCoordinator spawn preflight', () => {
  function coordinatorFor(root = rootSession(), permissionLevel: 'read-only' | 'full-access' = 'full-access') {
    return new AgentTeamCoordinator({
      resolveRoot: () => ({ projectPath: dataRoot, session: root, permissionLevel }),
      emit: () => undefined,
      persist: () => undefined,
    }, dataRoot);
  }

  async function expectRejectedSpawn(specification: Record<string, unknown>, error: RegExp, modelRuntime = runtime()) {
    const coordinator = coordinatorFor();
    await expect(coordinator.spawn(coordinator.rootNodeId('root-session'), { task: 'inspect', ...specification }, 'preflight-spawn', modelRuntime))
      .rejects.toThrow(error);
    expect(createdInputs).toHaveLength(0);
    expect(coordinator.getTeams('root-session')[0]).toMatchObject({ nodes: [expect.objectContaining({ depth: 0 })], tasks: [], envelopes: [], operationReceipts: [] });
  }

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['string', 'test/model'],
    ['array', []],
    ['missing provider', { id: 'model' }],
    ['missing id', { provider: 'test' }],
    ['non-string provider', { provider: 1, id: 'model' }],
    ['non-string id', { provider: 'test', id: 1 }],
    ['empty provider', { provider: '', id: 'model' }],
    ['blank id', { provider: 'test', id: '  ' }],
    ['oversized provider', { provider: 'p'.repeat(201), id: 'model' }],
    ['oversized id', { provider: 'test', id: 'm'.repeat(501) }],
    ['extra selector field', { provider: 'test', id: 'model', fallback: true }],
  ])('rejects an explicit malformed model (%s) rather than inheriting the caller model', async (_label, requestedModel) => {
    await expectRejectedSpawn({ model: requestedModel }, /model requires exact non-empty provider and id/);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['non-array', 'read'],
    ['unsupported tool', ['read', 'not_a_tool']],
    ['malformed entry', ['read', 42]],
  ])('rejects explicit unsupported tools (%s) rather than dropping them', async (_label, tools) => {
    await expectRejectedSpawn({ tools }, /tools must be an array of supported child tools/);
  });

  it.each([
    ['permission', undefined], ['permission', null], ['permission', 'admin'], ['permission', 1],
    ['thinkingLevel', undefined], ['thinkingLevel', null], ['thinkingLevel', 'turbo'], ['thinkingLevel', 1],
  ])('rejects unsupported explicit %s value %s', async (field, value) => {
    await expectRejectedSpawn({ [field as string]: value }, new RegExp(`${field} must be one of`));
  });

  it('preserves the exact authenticated provider/model and explicit thinking without widening default authority', async () => {
    const selected = { ...model, provider: 'authenticated-provider', id: 'vendor/model-v2' };
    const modelRuntime = runtime();
    vi.mocked(modelRuntime.getAvailable).mockResolvedValue([model, selected] as unknown as Awaited<ReturnType<ModelRuntime['getAvailable']>>);
    const coordinator = coordinatorFor();
    await coordinator.spawn(coordinator.rootNodeId('root-session'), {
      task: 'inspect', model: { provider: selected.provider, id: selected.id }, thinkingLevel: 'high', tools: ['read'],
    }, 'exact-model-spawn', modelRuntime);
    await settle();
    expect(createdInputs[0]).toMatchObject({ model: selected, thinkingLevel: 'high', permissionLevel: 'read-only', toolNames: ['read'] });
    expect(createdInputs[0]?.model).toBe(selected);
  });

  it('does not fall back to the caller for an unauthenticated explicit model', async () => {
    await expectRejectedSpawn({ model: { provider: 'other-provider', id: model.id } }, /not currently authenticated/);
  });

  it('caps a valid explicit permission at caller authority', async () => {
    const coordinator = coordinatorFor(rootSession(), 'read-only');
    await coordinator.spawn(coordinator.rootNodeId('root-session'), { task: 'inspect', permission: 'full-access', tools: ['read'] }, 'capped-spawn', runtime());
    await settle();
    expect(createdInputs[0]).toMatchObject({ permissionLevel: 'read-only', toolNames: ['read'] });
  });

  it('rejects explicit tools blocked by the resolved profile while preserving implicit profile narrowing', async () => {
    const directory = path.join(dataRoot, '.pi', 'agents');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'reader.md'), '---\nname: reader\ndescription: Read-only inspection\ntools: read\n---\nInspect files.');
    await expectRejectedSpawn({ agent: 'project/reader', tools: ['read', 'grep'] }, /'grep'.*not enabled by agent profile 'project\/reader'/);

    const coordinator = coordinatorFor();
    await coordinator.spawn(coordinator.rootNodeId('root-session'), { task: 'inspect', agent: 'project/reader' }, 'profile-default-spawn', runtime());
    await settle();
    expect(createdInputs[0]).toMatchObject({ agentName: 'reader', profileSystemPrompt: 'Inspect files.', toolNames: ['read'] });
  });

  it.each([
    ['non-reasoning', { ...model, reasoning: false }],
    ['explicitly unsupported effort', { ...model, thinkingLevelMap: { high: null } }],
  ])('rejects explicit thinking incompatible with a %s model', async (_label, selected) => {
    const modelRuntime = runtime();
    vi.mocked(modelRuntime.getAvailable).mockResolvedValue([selected] as unknown as Awaited<ReturnType<ModelRuntime['getAvailable']>>);
    await expectRejectedSpawn({ model: { provider: model.provider, id: model.id }, thinkingLevel: 'high' }, /does not support requested thinking level 'high'/, modelRuntime);
  });

  it.each([undefined, 'off'])('allows non-reasoning models with omitted or off thinking (%s) and an empty tool allowlist', async (thinkingLevel) => {
    const selected = { ...model, reasoning: false };
    const modelRuntime = runtime();
    vi.mocked(modelRuntime.getAvailable).mockResolvedValue([selected] as unknown as Awaited<ReturnType<ModelRuntime['getAvailable']>>);
    const coordinator = coordinatorFor();
    await coordinator.spawn(coordinator.rootNodeId('root-session'), {
      task: 'inspect', model: { provider: model.provider, id: model.id }, tools: [], ...(thinkingLevel ? { thinkingLevel } : {}),
    }, 'no-thinking-spawn', modelRuntime);
    await settle();
    expect(createdInputs[0]).toMatchObject({ thinkingLevel: 'off', toolNames: [], permissionLevel: 'read-only' });
  });
});

describe('AgentTeamCoordinator vertical slice', () => {
  async function workspaceFixture() {
    const repository = await fs.mkdtemp(path.join(dataRoot, 'repository-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
    git('init', '-b', 'main');
    git('config', 'user.email', 'agent@example.test');
    git('config', 'user.name', 'Agent Test');
    git('config', 'core.autocrlf', 'false');
    await fs.writeFile(path.join(repository, 'tracked.txt'), 'base\n');
    git('add', '.');
    git('commit', '-m', 'base');
    const root = rootSession();
    const service = new AgentWorkspaceGitService(path.join(dataRoot, 'managed'));
    const host = { resolveRoot: () => ({ projectPath: repository, session: root, permissionLevel: 'full-access' as const }), emit: () => undefined, persist: () => undefined };
    const coordinator = new AgentTeamCoordinator(host, dataRoot, undefined, service);
    const rootId = coordinator.rootNodeId('root-session');
    const child = await coordinator.spawn(rootId, { task: 'implement', name: 'worker', permission: 'edit', workspace: { mode: 'worktree' } }, 'spawn-workspace', runtime());
    await vi.waitFor(() => expect(coordinator.getTeams('root-session')[0]!.activeTurns).toBe(0));
    return { repository, root, service, host, coordinator, rootId, child, git };
  }

  it('rolls back a cancelled worktree spawn and does not grant worktree creation to a read-only parent', async () => {
    const { coordinator, rootId, child, service, git } = await workspaceFixture();
    const controller = new AbortController();
    const create = service.create.bind(service);
    const creation = vi.spyOn(service, 'create').mockImplementationOnce(async (...args) => {
      const created = await create(...args);
      controller.abort();
      return created;
    });
    await expect(coordinator.spawn(rootId, { task: 'cancel', workspace: { mode: 'worktree', branch: 'agents/cancelled' } }, 'cancelled-workspace', runtime(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    creation.mockRestore();
    expect(() => git('show-ref', '--verify', 'refs/heads/agents/cancelled')).toThrow();
    expect(coordinator.getTeams('root-session')[0]!.nodes).toHaveLength(2);
    coordinator.lowerRootPermission('root-session', 'read-only');
    await expect(coordinator.spawn(rootId, { task: 'no ref mutation', workspace: { mode: 'worktree' } }, 'readonly-workspace', runtime())).rejects.toThrow('requires edit or full-access');
    coordinator.lowerRootPermission('root-session', 'full-access');
    await coordinator.release(rootId, child.nodeId);
    await coordinator.workspace(rootId, child.nodeId, 'cleanup');
  }, 30_000);

  it('requires the exact retained review and parent branch before integration', async () => {
    const { coordinator, rootId, child, git } = await workspaceFixture();
    await fs.writeFile(path.join(child.workspace!.path, 'result.txt'), 'first');
    await coordinator.workspace(rootId, child.nodeId, 'checkpoint', { message: 'first result' });
    await coordinator.workspace(rootId, child.nodeId, 'review');
    const review = coordinator.getTeams('root-session')[0]!.nodes.find((node) => node.id === child.nodeId)!.workspace!.review!;
    await expect(coordinator.workspace(rootId, child.nodeId, 'integrate')).rejects.toThrow('exact source and target heads');
    await expect(coordinator.workspace(rootId, child.nodeId, 'integrate', { expectedSourceHead: 'f'.repeat(40), expectedTargetHead: review.targetHead })).rejects.toThrow('exactly match');
    git('checkout', '-b', 'different-target');
    await expect(coordinator.workspace(rootId, child.nodeId, 'integrate', { expectedSourceHead: review.sourceHead, expectedTargetHead: review.targetHead })).rejects.toThrow('Parent branch changed');
    git('checkout', 'main');
    await coordinator.workspace(rootId, child.nodeId, 'integrate', { expectedSourceHead: review.sourceHead, expectedTargetHead: review.targetHead });
    expect(coordinator.getTeams('root-session')[0]!.nodes.find((node) => node.id === child.nodeId)!.workspace!.review).toBeUndefined();
    await coordinator.release(rootId, child.nodeId);
    await expect(fs.stat(child.workspace!.path)).resolves.toBeDefined();
    await expect(coordinator.resetTeam('root-session', coordinator.getTeams('root-session')[0]!.id)).rejects.toThrow('retained');
    await coordinator.workspace(rootId, child.nodeId, 'cleanup');
  }, 30_000);

  it('holds checkout operation locks across teams until Git integration settles', async () => {
    const { coordinator, rootId, child, service } = await workspaceFixture();
    await fs.writeFile(path.join(child.workspace!.path, 'result.txt'), 'result');
    await coordinator.workspace(rootId, child.nodeId, 'checkpoint', { message: 'result' });
    await coordinator.workspace(rootId, child.nodeId, 'review');
    const review = coordinator.getTeams('root-session')[0]!.nodes.find((node) => node.id === child.nodeId)!.workspace!.review!;
    let unblock!: () => void;
    const barrier = new Promise<void>((resolve) => { unblock = resolve; });
    const integrate = vi.spyOn(service, 'integrate').mockImplementation(async () => { await barrier; return review.sourceHead; });
    const integration = coordinator.workspace(rootId, child.nodeId, 'integrate', { expectedSourceHead: review.sourceHead, expectedTargetHead: review.targetHead });
    try {
      await vi.waitFor(() => expect(integrate).toHaveBeenCalled());
      const other = coordinator.createTeam('root-session', 'other');
      await expect(coordinator.spawn(other.rootNodeId, { task: 'read during integration', permission: 'read-only' }, 'locked-reader', runtime())).rejects.toThrow('workspace operation');
      const create = vi.spyOn(service, 'create');
      await expect(coordinator.spawn(other.rootNodeId, { task: 'isolate during integration', permission: 'edit', workspace: { mode: 'worktree' } }, 'locked-worktree', runtime())).rejects.toThrow('workspace operation');
      expect(create).not.toHaveBeenCalled();
      create.mockRestore();
    } finally { unblock(); await integration; integrate.mockRestore(); }
    await coordinator.release(rootId, child.nodeId);
    await coordinator.workspace(rootId, child.nodeId, 'cleanup');
  }, 30_000);

  it('rejects forged restored ownership and refuses to reopen a removed inherited checkout', async () => {
    const { coordinator, host, root, rootId, child, service, repository } = await workspaceFixture();
    const team = coordinator.getTeams('root-session')[0]!;
    const forged: AgentTeam = structuredClone(team);
    forged.nodes.find((node) => node.id === child.nodeId)!.workspace!.path = repository;
    vi.spyOn(root.sessionManager, 'getBranch').mockReturnValue([{ type: 'custom', customType: 'fate-agent-team-event', data: { kind: 'fate-agent-team-event', version: 1, teamId: team.id, sequence: 1, timestamp: 1, type: 'snapshot', payload: { team: forged } } }] as never);
    const restored = new AgentTeamCoordinator(host, dataRoot, undefined, service);
    restored.restoreRoot(root);
    await expect(restored.workspace(team.rootNodeId, child.nodeId, 'review')).rejects.toThrow();
    const shared = await coordinator.spawn(child.nodeId, { task: 'inherit', workspace: { mode: 'shared' } }, 'inherited', runtime());
    await vi.waitFor(() => expect(coordinator.getTeams('root-session')[0]!.activeTurns).toBe(0));
    expect(shared.workspace!.path).toBe(child.workspace!.path);
    await coordinator.release(rootId, child.nodeId);
    await coordinator.workspace(rootId, child.nodeId, 'cleanup');
    expect(coordinator.getTeams('root-session')[0]!.nodes.find((node) => node.id === shared.nodeId)!.workspace!.state).toBe('removed');
    expect(() => coordinator.followUp(child.nodeId, shared.nodeId, 'must not touch root', 'removed-followup', runtime())).toThrow();
    expect(createdInputs.at(-1)!.projectPath).toBe(child.workspace!.path);
  }, 30_000);

  it('creates managed worktrees and pins shared descendants/reopens to the caller checkout', async () => {
    const repository = await fs.mkdtemp(path.join(dataRoot, 'repository-'));
    execFileSync('git', ['init'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'agent@example.test'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Agent Test'], { cwd: repository });
    await fs.writeFile(path.join(repository, 'tracked.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repository });
    const root = rootSession();
    let releasePrompt: () => void = () => undefined;
    promptBarrier = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const coordinator = new AgentTeamCoordinator({ resolveRoot: () => ({ projectPath: repository, session: root, permissionLevel: 'full-access' }), emit: () => undefined, persist: () => undefined }, dataRoot, undefined, new AgentWorkspaceGitService(path.join(dataRoot, 'managed')));
    const rootId = coordinator.rootNodeId('root-session');
    coordinator.configureWorkspace('root-session', coordinator.getTeams('root-session')[0]!.id, { mode: 'worktree', branchPrefix: 'fate/test' });
    const child = await coordinator.spawn(rootId, { task: 'isolate', name: 'isolated', permission: 'full-access' }, 'workspace-spawn', runtime());
    await settle();
    const childNode = coordinator.getTeams('root-session')[0]!.nodes.find((node) => node.id === child.nodeId)!;
    expect(childNode.workspace).toMatchObject({ mode: 'worktree', state: 'ready', parentPath: repository });
    expect(createdInputs.at(-1)?.projectPath).toBe(childNode.workspace?.path);
    coordinator.lowerRootPermission('root-session', 'read-only');
    await expect(coordinator.workspace(rootId, child.nodeId, 'checkpoint', { message: 'must be denied' })).rejects.toThrow(/requires edit or full-access/);
    coordinator.lowerRootPermission('root-session', 'full-access');
    const secondIsolated = await coordinator.spawn(rootId, { task: 'second isolate', name: 'isolated-two', permission: 'full-access' }, 'workspace-second-isolated', runtime());
    expect(coordinator.getTeams('root-session')[0]!.nodes.find((node) => node.id === secondIsolated.nodeId)?.status).toBe('active');
    await coordinator.interrupt(rootId, secondIsolated.nodeId);
    await coordinator.release(rootId, secondIsolated.nodeId);
    await coordinator.workspace(rootId, secondIsolated.nodeId, 'cleanup');
    const sharedWriter = await coordinator.spawn(rootId, { task: 'shared write', name: 'shared-writer', permission: 'full-access', workspace: { mode: 'shared' } }, 'workspace-shared-writer', runtime());
    await expect(coordinator.spawn(rootId, { task: 'blocked shared write', name: 'blocked-shared-writer', permission: 'full-access', workspace: { mode: 'shared' } }, 'workspace-shared-blocked', runtime())).rejects.toThrow(/writer lease/);
    const grandchild = await coordinator.spawn(child.nodeId, { task: 'inherit', name: 'shared', permission: 'read-only', workspace: { mode: 'shared' } }, 'workspace-grandchild', runtime());
    await settle();
    expect(createdInputs.at(-1)?.projectPath).toBe(childNode.workspace?.path);
    releasePrompt();
    promptBarrier = null;
    await settle();
    await coordinator.release(rootId, sharedWriter.nodeId);
    await coordinator.release(rootId, child.nodeId);
    await coordinator.workspace(rootId, child.nodeId, 'cleanup');
    expect(coordinator.getTeams('root-session')[0]!.nodes.find((node) => node.id === grandchild.nodeId)?.workspace?.state).toBe('removed');
  }, 20_000);

  it('threads team identity into the child factory and resolves current task/permission dynamically', async () => {
    const root = rootSession();
    const coordinator = new AgentTeamCoordinator({
      resolveRoot: () => ({ projectPath: dataRoot, session: root, permissionLevel: 'full-access' }),
      sendRootMessage: vi.fn(async () => undefined),
      emit: () => undefined,
      persist: () => undefined,
    }, dataRoot);
    const modelRuntime = runtime();
    const rootId = coordinator.rootNodeId('root-session');
    const child = await coordinator.spawn(rootId, { task: 'investigate', name: 'reviewer', permission: 'read-only' }, 'attest-spawn', modelRuntime);
    const team = coordinator.getTeams('root-session')[0]!;
    const input = createdInputs.at(-1)!;
    expect(input.teamIdentity?.teamId).toBe(team.id);
    expect(input.teamIdentity?.nodeId).toBe(child.nodeId);
    expect(coordinator.currentPermissionForNode(team.id, child.nodeId)).toBe('read-only');
    expect(coordinator.currentTaskIdForNode(team.id, child.nodeId)).toBe(team.tasks[0]?.id);
  });

  it('refuses Agent Team children that would use a Fate-disabled model', async () => {
    const root = rootSession();
    const coordinator = new AgentTeamCoordinator({
      resolveRoot: () => ({ projectPath: dataRoot, session: root, permissionLevel: 'full-access' }),
      getDisabledModels: () => ['test/model'],
      sendRootMessage: vi.fn(async () => undefined),
      emit: () => undefined,
      persist: () => undefined,
    }, dataRoot);
    await expect(coordinator.spawn(coordinator.rootNodeId('root-session'), { task: 'investigate' }, 'disabled-spawn', runtime())).rejects.toThrow(/disabled in Fate UI settings/);
  });

  it('returns undefined for the current permission/task of a closed node, not stale state', async () => {
    const root = rootSession();
    const coordinator = new AgentTeamCoordinator({
      resolveRoot: () => ({ projectPath: dataRoot, session: root, permissionLevel: 'full-access' }),
      sendRootMessage: vi.fn(async () => undefined),
      emit: () => undefined,
      persist: () => undefined,
    }, dataRoot);
    const modelRuntime = runtime();
    const rootId = coordinator.rootNodeId('root-session');
    const child = await coordinator.spawn(rootId, { task: 'investigate', name: 'reviewer', permission: 'edit' }, 'close-spawn', modelRuntime);
    const team = coordinator.getTeams('root-session')[0]!;
    expect(coordinator.currentPermissionForNode(team.id, child.nodeId)).toBe('edit');
    expect(coordinator.currentTaskIdForNode(team.id, child.nodeId)).toBe(team.tasks[0]?.id);

    await settle();
    await coordinator.close(rootId, child.nodeId);

    // A closed node is gone: its writes must not be attributed to stale authority/task state.
    expect(coordinator.currentPermissionForNode(team.id, child.nodeId)).toBeUndefined();
    expect(coordinator.currentTaskIdForNode(team.id, child.nodeId)).toBeUndefined();
  });
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
    expect(createdInputs[0]?.collaborationTools?.map((tool) => tool.name)).toEqual(['spawn_agent', 'agent_workspace', 'send_message', 'followup_task', 'wait_agent', 'interrupt_agent', 'inspect_agent', 'close_agent', 'release_agent', 'list_agents']);

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

  it('projects a direct root message reply into the root timeline without waking its model', async () => {
    let releasePrompt: () => void = () => undefined;
    promptBarrier = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const sendRootMessage = vi.fn(async () => undefined);
    const coordinator = new AgentTeamCoordinator({
      resolveRoot: () => ({ projectPath: dataRoot, session: rootSession(), permissionLevel: 'read-only' }),
      sendRootMessage,
      emit: () => undefined,
      persist: () => undefined,
    }, dataRoot);
    const rootId = coordinator.rootNodeId('root-session');
    const child = await coordinator.spawn(rootId, { task: 'review', name: 'reviewer' }, 'direct-message-spawn', runtime());
    await coordinator.sendMessage(rootId, child.nodeId, 'Reply with the result.', 'direct-message', 'steer', runtime(), true);
    releasePrompt();
    promptBarrier = null;
    await settle();
    expect(sendRootMessage).toHaveBeenCalledWith('root-session', expect.objectContaining({
      customType: 'fate-live-agent-reply',
      display: true,
      content: [expect.objectContaining({ text: expect.stringContaining('Direct reply from /root/reviewer') })],
    }), 'steer', false);
  });

  it('grants an explicitly requested bash tool when the effective permission allows it', async () => {
    const coordinator = new AgentTeamCoordinator({
      resolveRoot: () => ({ projectPath: dataRoot, session: rootSession(), permissionLevel: 'full-access' }),
      emit: () => undefined,
      persist: () => undefined,
    }, dataRoot);
    const rootId = coordinator.rootNodeId('root-session');
    const child = await coordinator.spawn(rootId, { task: 'run the suite', name: 'runner', permission: 'full-access', tools: ['bash', 'read', 'write', 'edit'] }, 'bash-grant-spawn', runtime());
    await settle();
    expect(createdInputs[0]?.toolNames).toEqual(expect.arrayContaining(['bash', 'read', 'write', 'edit']));
    expect(coordinator.getTeams('root-session')[0]!.nodes.find((node) => node.id === child.nodeId)).toMatchObject({ status: 'ready' });
  });

  it('rejects an explicitly requested bash tool at edit permission with an actionable error instead of silently dropping it', async () => {
    const coordinator = new AgentTeamCoordinator({
      resolveRoot: () => ({ projectPath: dataRoot, session: rootSession(), permissionLevel: 'full-access' }),
      emit: () => undefined,
      persist: () => undefined,
    }, dataRoot);
    const rootId = coordinator.rootNodeId('root-session');
    await expect(coordinator.spawn(rootId, { task: 'run the suite', name: 'runner', permission: 'edit', tools: ['bash'] }, 'bash-denied-spawn', runtime()))
      .rejects.toThrow(/requires 'full-access'/u);
    expect(createdInputs).toHaveLength(0);
  });

  it('rejects a grandchild tool request that the calling node does not hold', async () => {
    const coordinator = new AgentTeamCoordinator({
      resolveRoot: () => ({ projectPath: dataRoot, session: rootSession(), permissionLevel: 'full-access' }),
      emit: () => undefined,
      persist: () => undefined,
    }, dataRoot);
    const rootId = coordinator.rootNodeId('root-session');
    const child = await coordinator.spawn(rootId, { task: 'investigate', name: 'reviewer', permission: 'full-access', tools: ['read'] }, 'cap-spawn-1', runtime());
    await settle();
    await expect(coordinator.spawn(child.nodeId, { task: 'verify', name: 'tester', permission: 'full-access', tools: ['bash'] }, 'cap-spawn-2', runtime()))
      .rejects.toThrow(/caller already holds/u);
    expect(createdInputs).toHaveLength(1);
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
  it('creates, selects, and isolates two teams under one root session', async () => {
    const coordinator = new AgentTeamCoordinator({
      resolveRoot: () => ({ projectPath: dataRoot, session: rootSession(), permissionLevel: 'read-only' }),
      emit: () => undefined,
      persist: () => undefined,
    }, dataRoot);
    const firstRoot = coordinator.rootNodeId('root-session');
    const first = await coordinator.spawn(firstRoot, { task: 'first', name: 'worker' }, 'first-spawn', runtime());
    await settle();
    const secondTeam = coordinator.createTeam('root-session', 'Second team');
    coordinator.selectTeam('root-session', secondTeam.id);
    const secondRoot = coordinator.rootNodeId('root-session');
    const second = await coordinator.spawn(secondRoot, { task: 'second', name: 'worker' }, 'second-spawn', runtime());
    await settle();

    expect(coordinator.getTeams('root-session')).toHaveLength(2);
    expect(coordinator.selectedTeamId('root-session')).toBe(secondTeam.id);
    expect(first.nodeId).not.toBe(second.nodeId);
    await expect(coordinator.sendMessage(secondRoot, first.nodeId, 'cross-team', 'cross-team-message')).rejects.toThrow(/same-team|foreign|Unknown/u);
  });

  it('restores the latest durable snapshot for every team without collapsing siblings', async () => {
    const root = rootSession();
    const persisted: Array<{ teamId: string; sequence: number }> = [];
    const host = {
      resolveRoot: () => ({ projectPath: dataRoot, session: root, permissionLevel: 'read-only' as const }),
      emit: () => undefined,
      persist: (_root: string, event: { teamId: string; sequence: number }) => { persisted.push(event); },
    };
    const first = new AgentTeamCoordinator(host, dataRoot);
    const firstRoot = first.rootNodeId('root-session');
    await first.spawn(firstRoot, { task: 'one', name: 'one' }, 'restore-one', runtime());
    await settle();
    const second = first.createTeam('root-session', 'Second');
    first.selectTeam('root-session', second.id);
    await first.spawn(first.rootNodeId('root-session'), { task: 'two', name: 'two' }, 'restore-two', runtime());
    await settle();

    const reopened = rootSession();
    vi.spyOn(reopened.sessionManager, 'getBranch').mockReturnValue(persisted.map((event) => ({ type: 'custom', id: `${event.teamId}-${event.sequence}`, parentId: null, timestamp: new Date().toISOString(), customType: 'fate-agent-team-event', data: event })) as never);
    const restored = new AgentTeamCoordinator({ resolveRoot: () => ({ projectPath: dataRoot, session: reopened, permissionLevel: 'read-only' }), emit: () => undefined, persist: () => undefined }, dataRoot);
    restored.restoreRoot(reopened);
    expect(restored.getTeams('root-session')).toHaveLength(2);
    expect(restored.selectedTeamId('root-session')).toBe(second.id);
  });

  it('releases ready and active nodes idempotently and makes team capacity reusable', async () => {
    const coordinator = new AgentTeamCoordinator({
      resolveRoot: () => ({ projectPath: dataRoot, session: rootSession(), permissionLevel: 'read-only' }),
      emit: () => undefined,
      persist: () => undefined,
    }, dataRoot);
    const rootId = coordinator.rootNodeId('root-session');
    const ready = await coordinator.spawn(rootId, { task: 'ready', name: 'ready-node' }, 'ready-spawn', runtime());
    await settle();
    await coordinator.control('root-session', { action: 'release', target: ready.nodeId }, runtime());
    await coordinator.control('root-session', { action: 'release', target: ready.nodeId }, runtime());
    expect(coordinator.getTeams('root-session')[0]?.nodes.find((node) => node.id === ready.nodeId)?.status).toBe('released');

    let releasePrompt: () => void = () => undefined;
    promptBarrier = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const active = await coordinator.spawn(rootId, { task: 'active', name: 'active-node' }, 'active-spawn', runtime());
    await expect(coordinator.control('root-session', { action: 'release', target: active.nodeId }, runtime())).rejects.toThrow(/Use force/u);
    await coordinator.control('root-session', { action: 'release', target: active.nodeId, force: true }, runtime());
    expect(coordinator.getTeams('root-session')[0]?.nodes.find((node) => node.id === active.nodeId)?.status).toBe('released');
    const replacement = await coordinator.spawn(rootId, { task: 'replacement', name: 'replacement' }, 'replacement-spawn', runtime());
    expect(replacement.status).toBe('active');
    releasePrompt();
    promptBarrier = null;
    await settle();
  });

  it('refuses unsafe team close, force-closes work, and permits a new team', async () => {
    let releasePrompt: () => void = () => undefined;
    promptBarrier = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const coordinator = new AgentTeamCoordinator({
      resolveRoot: () => ({ projectPath: dataRoot, session: rootSession(), permissionLevel: 'read-only' }),
      emit: () => undefined,
      persist: () => undefined,
    }, dataRoot);
    const rootId = coordinator.rootNodeId('root-session');
    await coordinator.spawn(rootId, { task: 'active', name: 'worker' }, 'close-spawn', runtime());
    const teamId = coordinator.getTeams('root-session')[0]!.id;
    await expect(coordinator.closeTeam('root-session', teamId)).rejects.toThrow(/Use force/u);
    await coordinator.closeTeam('root-session', teamId, true);
    expect(coordinator.getTeams('root-session')[0]?.status).toBe('closed');
    expect(coordinator.createTeam('root-session', 'Replacement').status).toBe('active');
    releasePrompt();
    promptBarrier = null;
  });
});

describe('Agent Team V2 send_message delivery modes', () => {
  function makeCoordinator() {
    const root = rootSession();
    const sendRootMessage = vi.fn(async (_sessionId: string, _message: Parameters<AgentSession['sendCustomMessage']>[0]) => undefined);
    const coordinator = new AgentTeamCoordinator({
      resolveRoot: () => ({ projectPath: dataRoot, session: root, permissionLevel: 'full-access' }),
      sendRootMessage,
      emit: () => undefined,
      persist: () => undefined,
    }, dataRoot);
    return { coordinator, root, sendRootMessage };
  }

  it('does not acknowledge a root mailbox handoff until the recipient records it', async () => {
    const { coordinator, root, sendRootMessage } = makeCoordinator();
    const rootId = coordinator.rootNodeId('root-session');
    const child = await coordinator.spawn(rootId, { task: 'work', name: 'reporter' }, 'ack-spawn', runtime());
    await settle();
    const receipt = await coordinator.sendMessage(child.nodeId, '/root', 'retained report', 'ack-message', 'queue');
    expect(receipt.state).toBe('dispatching');
    const message = { ...sendRootMessage.mock.calls.at(-1)![1], role: 'custom' };
    const state = () => coordinator.getTeams('root-session')[0]!.envelopes.find((item) => item.id === receipt.envelopeId)!.state;
    coordinator.observeDeliveredMessage('root-session', childSessions[0]!, message);
    expect(state()).toBe('dispatching');
    coordinator.observeDeliveredMessage('root-session', root, message);
    expect(state()).toBe('delivered');
    const calls = sendRootMessage.mock.calls.length;
    await coordinator.sendMessage(child.nodeId, '/root', 'retained report', 'ack-message', 'queue');
    expect(sendRootMessage).toHaveBeenCalledTimes(calls);
  });

  it('queue holds a message until the recipient task settles, then delivers it once', async () => {
    let releasePrompt: () => void = () => undefined;
    promptBarrier = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const { coordinator } = makeCoordinator();
    const rootId = coordinator.rootNodeId('root-session');
    const child = await coordinator.spawn(rootId, { task: 'work', name: 'worker' }, 'queue-spawn', runtime());
    await settle();
    const held = await coordinator.sendMessage(rootId, child.path, 'held note', 'queue-msg', 'queue');
    expect(held.state).toBe('queued');
    expect(childSessions[0]?.sendCustomMessage).not.toHaveBeenCalled();
    releasePrompt();
    promptBarrier = null;
    await vi.waitFor(() => expect(coordinator.getTeams('root-session')[0]?.envelopes.find((env) => env.id === held.envelopeId)?.state).toBe('delivered'));
    expect(childSessions[0]?.sendCustomMessage).toHaveBeenCalledTimes(1);
    expect(childSessions[0]?.sendCustomMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: 'fate-agent-team-envelope' }), { triggerTurn: false });
  });

  it('steer injects into a streaming recipient and never starts a new executable task', async () => {
    let releasePrompt: () => void = () => undefined;
    promptBarrier = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const { coordinator } = makeCoordinator();
    const rootId = coordinator.rootNodeId('root-session');
    const child = await coordinator.spawn(rootId, { task: 'work', name: 'steered' }, 'steer-spawn', runtime());
    await settle();
    (childSessions[0] as unknown as { isStreaming: boolean }).isStreaming = true;
    const receipt = await coordinator.sendMessage(rootId, child.path, 'nudge', 'steer-msg', 'steer');
    expect(receipt.state).toBe('delivered');
    expect(childSessions[0]?.sendCustomMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: 'fate-agent-team-envelope' }), { triggerTurn: false, deliverAs: 'steer' });
    expect(coordinator.getTeams('root-session')[0]?.tasks).toHaveLength(1);
    releasePrompt();
    promptBarrier = null;
    await settle();
  });

  it('delivers a queued message to an idle recipient without waking it', async () => {
    const { coordinator } = makeCoordinator();
    const rootId = coordinator.rootNodeId('root-session');
    const child = await coordinator.spawn(rootId, { task: 'work', name: 'idle' }, 'idle-spawn', runtime());
    await settle();
    const receipt = await coordinator.sendMessage(rootId, child.path, 'note', 'idle-msg', 'queue');
    expect(receipt.state).toBe('delivered');
    expect(childSessions[0]?.sendCustomMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: 'fate-agent-team-envelope' }), { triggerTurn: false });
    expect(childSessions[0]?.prompt).toHaveBeenCalledTimes(1);
  });

  it('defaults a missing delivery mode to queue (hold until settlement)', async () => {
    let releasePrompt: () => void = () => undefined;
    promptBarrier = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const { coordinator } = makeCoordinator();
    const rootId = coordinator.rootNodeId('root-session');
    const child = await coordinator.spawn(rootId, { task: 'work', name: 'legacy' }, 'legacy-spawn', runtime());
    await settle();
    const held = await coordinator.sendMessage(rootId, child.path, 'legacy note', 'legacy-msg');
    expect(held.state).toBe('queued');
    expect(childSessions[0]?.sendCustomMessage).not.toHaveBeenCalled();
    releasePrompt();
    promptBarrier = null;
    await vi.waitFor(() => expect(coordinator.getTeams('root-session')[0]?.envelopes.find((env) => env.id === held.envelopeId)?.state).toBe('delivered'));
  });
});
