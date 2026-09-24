import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionManager, type AgentSession, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeState } from '../../shared/contracts/ipc';
import type { AgentDraft, AgentRun, SavedAgentSession } from '../../shared/contracts/agents';
import { LegacyAutomations, legacyDocumentPath } from '../automations/LegacyAutomations';
import { projectSessionDirectory } from '../pi/PiSessionRepository';
import { AgentRepository } from './AgentRepository';
import { AgentsService, type AgentsHost } from './AgentsService';
import { readAgentSessionPreset } from './AgentSessionPreset';
import type { AgentExecutionHandle, AgentExecutionInput } from './AgentExecutor';

const roots: string[] = [];
const services: AgentsService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.dispose())); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
const draft: AgentDraft = { name: 'Analyst', scope: 'project', description: '', instructions: 'Agent system persona.', skillRefs: [], enabled: true, defaults: { model: { provider: 'test', id: 'model' }, thinkingLevel: 'high', permission: 'edit', workspace: 'shared' } };
async function fixture(effect = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agents-service-')));
  roots.push(root);
  const projectPath = path.join(root, 'project');
  await fs.mkdir(projectPath);
  const state = { status: 'ready', project: { path: projectPath, name: 'project', trusted: true }, sessionId: 'owner', sessionFile: null, streaming: false, model: { provider: 'test', id: 'model', name: 'Fixture', reasoning: true, contextWindow: 1000, input: ['text'] }, models: [], thinkingLevel: 'high', messages: [], permissionLevel: 'edit', error: null } as RuntimeState;
  let authorityRevision = 0;
  const modelRuntime = { getAvailable: vi.fn(async () => [state.model!]) } as unknown as ModelRuntime;
  const accepted: Array<{ text: string; preset: SavedAgentSession | null; role: string }> = [];
  const makeSession = (file: string, input?: AgentExecutionInput): AgentExecutionHandle => {
    const manager = SessionManager.open(file, undefined, projectPath);
    const messages: AgentSession['messages'] = [];
    const controller = new AbortController();
    return {
      sessionId: manager.getSessionId(), messages,
      prompt: vi.fn(async (text) => {
        accepted.push({ text, preset: readAgentSessionPreset(manager), role: 'user' });
        manager.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
        if (effect && input) await input.approvals.execute('effect-1', 'write', { path: 'approved.txt', content: 'approved bytes' }, async (args) => {
          await input.validate?.();
          if (!input.context().trusted || input.context().permission === 'read-only') throw new Error('Live authority revoked.');
          await fs.writeFile(path.join(projectPath, args.path), args.content);
        }, controller.signal);
        messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Local test result.' }], stopReason: 'stop' } as never);
      }),
      abort: async () => { controller.abort(); }, dispose: vi.fn(),
    };
  };
  const host: AgentsHost = {
    runtime: {
      getState: () => state,
      agentAuthority: () => ({ level: state.permissionLevel ?? 'read-only', revision: authorityRevision }),
      agentModelRuntime: async () => modelRuntime,
      agentResources: async () => ({ skills: [], contextPrompts: [] }),
      openAgentSavedSession: vi.fn(async () => state),
      createAgentForegroundExecution: vi.fn(async (id) => {
        const directory = projectSessionDirectory(projectPath, path.join(root, 'sessions'));
        for (const name of await fs.readdir(directory)) {
          if (!name.endsWith('.jsonl')) continue;
          const file = path.join(directory, name);
          if (SessionManager.open(file).getSessionId() === id) return makeSession(file);
        }
        throw new Error('Missing foreground session fixture.');
      }),
    },
    workspacePolicy: () => ({ preferredMode: 'shared', strict: false }), disabledModels: () => [],
    sessionsRoot: path.join(root, 'sessions'), notify: vi.fn(),
  };
  const repository = new AgentRepository(path.join(root, 'data'));
  const automations = new LegacyAutomations({ write: vi.fn() }, path.join(root, 'automations'));
  const execute = vi.fn(async (input: AgentExecutionInput) => makeSession(input.sessionFile, input));
  const service = new AgentsService(host, repository, automations, execute);
  services.push(service);
  const agent = await service.saveAgent({ expected: null, value: draft });
  const task = await service.saveTask({ expected: null, value: { name: 'Task', scope: 'project', prompt: '/command @live ~saved\nExact user request.', enabled: true, permissionCeiling: 'edit' } });
  return { root, projectPath, state, service, host, repository, automations, execute, accepted, agent, task, changePermission: (level: RuntimeState['permissionLevel']) => { state.permissionLevel = level; authorityRevision += 1; } };
}
async function settled(service: AgentsService, id: string): Promise<AgentRun> {
  let run: AgentRun | undefined;
  await vi.waitFor(async () => { run = (await service.list()).runs.find((item) => item.id === id); expect(['succeeded', 'failed']).toContain(run?.status); });
  return run!;
}

 describe('Agents production service boundaries', () => {
  it('opens one retained home concurrently, preserves applied revision after rename, and blocks disabled actions', async () => {
    const { service, agent, host } = await fixture();
    const homes = await Promise.all([service.open(agent.id, 'home'), service.open(agent.id, 'home')]);
    expect(homes[0]).toEqual(homes[1]);
    const library = await service.list();
    await service.saveAgent({ id: agent.id, expected: library.revisions[`agent:${agent.id}`]!, value: { ...draft, name: 'Renamed', instructions: 'Changed persona.' } });
    expect(await service.open(agent.id, 'home')).toEqual(homes[0]);
    expect(host.runtime.openAgentSavedSession).toHaveBeenCalledWith(homes[0]!.sessionId);
    const updated = await service.list();
    await service.saveAgent({ id: agent.id, expected: updated.revisions[`agent:${agent.id}`]!, value: { ...draft, enabled: false } });
    await expect(service.open(agent.id, 'home')).rejects.toThrow(/Enable/);
    expect((await service.list()).states[0]?.homeSessionId).toBe(homes[0]!.sessionId);
  });

  it('retains old home defaults when new defaults are unavailable and refuses silent replacement of a missing home', async () => {
    const { service, agent, root, projectPath } = await fixture();
    const home = await service.open(agent.id, 'home');
    const library = await service.list();
    await service.saveAgent({ id: agent.id, expected: library.revisions[`agent:${agent.id}`]!, value: { ...draft, defaults: { ...draft.defaults, model: { provider: 'missing', id: 'unavailable' } } } });
    expect(await service.open(agent.id, 'home')).toEqual(home);
    await expect(service.open(agent.id, 'new')).rejects.toThrow(/unavailable/);
    const file = path.join(projectSessionDirectory(projectPath, path.join(root, 'sessions')), `${agent.id}.jsonl`);
    await fs.unlink(file);
    await expect(service.open(agent.id, 'home')).rejects.toThrow(/ownership was not silently reassigned/);
    expect((await service.list()).states[0]?.homeSessionId).toBe(home.sessionId);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('runs a foreground task through the workbench host with exact user payload and narrowed permission', async () => {
    const { service, agent, task, accepted, changePermission, host } = await fixture();
    changePermission('read-only');
    const run = await service.run({ agentId: agent.id, taskTemplateId: task.id });
    expect(await settled(service, run.id)).toMatchObject({ status: 'succeeded', permission: 'read-only', resultSummary: 'Local test result.', taskTemplateRevision: 1 });
    expect(host.runtime.createAgentForegroundExecution).toHaveBeenCalledOnce();
    expect(accepted).toEqual([expect.objectContaining({ text: task.prompt, role: 'user', preset: expect.objectContaining({ instructions: draft.instructions, defaults: expect.objectContaining({ permission: 'read-only' }) }) })]);
  });

  it('persists a background needs-attention action before writing, then admits one explicit approval', async () => {
    const { service, agent, task, projectPath } = await fixture(true);
    const routine = await service.saveRoutine({ expected: null, value: { name: 'Every minute', agentId: agent.id, taskTemplateId: task.id, intervalMinutes: 1, timeZone: 'UTC', permissionCeiling: 'edit', enabled: true, notify: true, osNotify: false } });
    const admitted = await service.run({ agentId: agent.id, taskTemplateId: task.id, routineId: routine.id });
    let pending!: AgentRun;
    await vi.waitFor(async () => { pending = (await service.list()).runs.find((run) => run.id === admitted.id)!; expect(pending.status).toBe('needs-attention'); });
    await expect(fs.stat(path.join(projectPath, 'approved.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const action = pending.approvals[0]!;
    await service.approve({ runId: pending.id, approvalId: action.id, approved: true, expected: { revision: action.revision, digest: action.digest } });
    expect(await settled(service, pending.id)).toMatchObject({ status: 'succeeded', approvals: [expect.objectContaining({ status: 'approved' })] });
    expect(await fs.readFile(path.join(projectPath, 'approved.txt'), 'utf8')).toBe('approved bytes');
    await expect(service.approve({ runId: pending.id, approvalId: action.id, approved: true, expected: { revision: action.revision, digest: action.digest } })).rejects.toThrow(/no longer suspended/);
  });

  it('does not revive an approval after live authority is lowered and raised again', async () => {
    const { service, agent, task, projectPath, changePermission } = await fixture(true);
    const routine = await service.saveRoutine({ expected: null, value: { name: 'Approval', agentId: agent.id, taskTemplateId: task.id, intervalMinutes: 1, timeZone: 'UTC', permissionCeiling: 'edit', enabled: true, notify: true, osNotify: false } });
    const run = await service.run({ agentId: agent.id, taskTemplateId: task.id, routineId: routine.id });
    let pending!: AgentRun;
    await vi.waitFor(async () => { pending = (await service.list()).runs.find((candidate) => candidate.id === run.id)!; expect(pending.status).toBe('needs-attention'); });
    changePermission('read-only'); changePermission('edit');
    const approval = pending.approvals[0]!;
    await expect(service.approve({ runId: run.id, approvalId: approval.id, approved: true, expected: { revision: approval.revision, digest: approval.digest } })).rejects.toThrow(/Approval/);
    await service.cancel(run.id);
    expect((await settled(service, run.id)).status).toBe('failed');
    await expect(fs.stat(path.join(projectPath, 'approved.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('audits expired approvals as failed without any file effect', async () => {
    const { service, agent, task, projectPath, execute } = await fixture(true);
    const routine = await service.saveRoutine({ expected: null, value: { name: 'Expiry', agentId: agent.id, taskTemplateId: task.id, intervalMinutes: 1, timeZone: 'UTC', permissionCeiling: 'edit', enabled: true, notify: true, osNotify: false } });
    const run = await service.run({ agentId: agent.id, taskTemplateId: task.id, routineId: routine.id });
    await vi.waitFor(async () => expect((await service.list()).runs.find((item) => item.id === run.id)?.status).toBe('needs-attention'));
    await execute.mock.calls[0]![0].approvals.deny('effect-1', 'expired');
    expect(await settled(service, run.id)).toMatchObject({ status: 'failed', approvals: [expect.objectContaining({ status: 'expired' })] });
    await expect(fs.stat(path.join(projectPath, 'approved.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to launch a paused Routine through a stale explicit test run', async () => {
    const { service, agent, task, execute } = await fixture();
    const routine = await service.saveRoutine({ expected: null, value: { name: 'Paused', agentId: agent.id, taskTemplateId: task.id, intervalMinutes: 1, timeZone: 'UTC', permissionCeiling: 'edit', enabled: true, notify: true, osNotify: false } });
    const library = await service.list();
    await service.saveRoutine({ id: routine.id, expected: library.revisions[`routine:${routine.id}`]!, value: { name: 'Paused', agentId: agent.id, taskTemplateId: task.id, intervalMinutes: 1, timeZone: 'UTC', permissionCeiling: 'edit', enabled: false, notify: true, osNotify: false } });
    await expect(service.run({ agentId: agent.id, taskTemplateId: task.id, routineId: routine.id })).rejects.toThrow(/Enable/);
    expect(execute).not.toHaveBeenCalled();
    expect((await service.list(routine.id)).runs).toHaveLength(0);
  });

  it('fails closed for unavailable models, incompatible global workspaces and revoked trust', async () => {
    const { service, agent, task, host, state } = await fixture();
    host.workspacePolicy = () => ({ preferredMode: 'worktree', strict: true });
    const blocked = await service.run({ agentId: agent.id, taskTemplateId: task.id });
    expect(blocked).toMatchObject({ status: 'failed', error: expect.stringMatching(/strict/) });
    host.workspacePolicy = () => ({ preferredMode: 'shared', strict: false });
    host.disabledModels = () => ['test/model'];
    expect((await service.run({ agentId: agent.id, taskTemplateId: task.id })).status).toBe('failed');
    state.project!.trusted = false;
    await expect(service.list()).rejects.toThrow(/trust/);
    await expect(service.run({ agentId: agent.id, taskTemplateId: task.id })).rejects.toThrow(/trust/);
  });

  it('imports legacy Automations idempotently and rolls back without modifying source bytes', async () => {
    const { service, automations, projectPath, root } = await fixture();
    const source = {
      id: '00000000-0000-4000-8000-000000000111', projectPath, name: 'Original Automation', prompt: 'x'.repeat(200_000), permissionLevel: 'edit' as const,
      createdAt: 1, updatedAt: 2, lastLaunchedAt: null, lastLaunchOutcome: null, launchCount: 0,
    };
    const sourceFile = legacyDocumentPath(projectPath, path.join(root, 'automations'));
    const document = JSON.stringify({ version: 1, projectPath, automations: [source] }, null, 2) + '\n';
    await fs.mkdir(path.dirname(sourceFile), { recursive: true });
    await fs.writeFile(sourceFile, document, 'utf8');
    const bytes = await fs.readFile(sourceFile);
    const preview = await service.previewCopy(source.id);
    const copied = await service.copyAutomation(source.id, preview.sourceDigest);
    expect((await service.copyAutomation(source.id, preview.sourceDigest)).id).toBe(copied.id);
    expect(copied.prompt).toBe(source.prompt);
    expect(copied.automationSource && JSON.parse(copied.automationSource.source)).toEqual(source);
    const library = await service.list();
    await service.rollbackCopy(copied.id, library.revisions[`task:${copied.id}`]!);
    expect(await fs.readFile(sourceFile)).toEqual(bytes);
    expect((await automations.list(projectPath))[0]).toEqual(source);
    expect((await service.list()).tasks.some((task) => task.id === copied.id)).toBe(false);
  });

  it('admits and executes a due Routine once, retaining its watermark on repeated ticks', async () => {
    const { service, agent, task, execute } = await fixture();
    const routine = await service.saveRoutine({ expected: null, value: { name: 'Schedule', agentId: agent.id, taskTemplateId: task.id, intervalMinutes: 1, timeZone: 'UTC', permissionCeiling: 'read-only', enabled: true, notify: false, osNotify: false } });
    const due = (await service.list()).nextDue[routine.id]!;
    await service.tick(due);
    await service.tick(due);
    const runs = (await service.list(routine.id)).runs;
    expect(runs).toHaveLength(1);
    expect(await settled(service, runs[0]!.id)).toMatchObject({ status: 'succeeded', routineRevision: 1 });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('does not admit a scheduled occurrence after its Agent is disabled', async () => {
    const { service, agent, task, execute } = await fixture();
    const routine = await service.saveRoutine({ expected: null, value: { name: 'Schedule', agentId: agent.id, taskTemplateId: task.id, intervalMinutes: 1, timeZone: 'UTC', permissionCeiling: 'read-only', enabled: true, notify: false, osNotify: false } });
    const library = await service.list();
    await service.saveAgent({ id: agent.id, expected: library.revisions[`agent:${agent.id}`]!, value: { scope: agent.scope, name: agent.name, description: agent.description, instructions: agent.instructions, skillRefs: agent.skillRefs, defaults: agent.defaults, enabled: false } });
    const due = (await service.list()).nextDue[routine.id]!;
    await service.tick(due);
    expect((await service.list(routine.id)).runs).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  });
});
