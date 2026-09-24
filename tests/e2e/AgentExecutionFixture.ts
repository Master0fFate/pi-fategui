import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionManager, type AgentSession, type ModelRuntime, type createWriteToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentsHost } from '../../src/main/agents/AgentsService';
import type { AgentExecutionHandle, AgentExecutionInput } from '../../src/main/agents/AgentExecutor';
import { readAgentSessionPreset } from '../../src/main/agents/AgentSessionPreset';
import { projectSessionDirectory } from '../../src/main/pi/PiSessionRepository';
import { createProjectConfinedTools } from '../../src/main/pi/PiToolPolicy';
import type { FakePiRuntimeService } from './FakePiRuntimeService';

export function agentExecutionFixture(runtime: FakePiRuntimeService, sessionsRoot: string) {
  const find = async (sessionId: string) => {
    const project = runtime.getState().project;
    if (!project) throw new Error('No E2E project.');
    const directory = projectSessionDirectory(project.path, sessionsRoot);
    for (const name of await fs.readdir(directory)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(directory, name);
      if (SessionManager.open(file).getSessionId() === sessionId) return file;
    }
    throw new Error('E2E Agent session not found.');
  };
  const open = async (sessionId: string) => {
    const file = await find(sessionId);
    const manager = SessionManager.open(file);
    const preset = readAgentSessionPreset(manager)!;
    runtime.registerAgentSession({ id: sessionId, title: manager.getSessionName() ?? preset.name, firstMessage: '', path: file, createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString(), messageCount: manager.buildSessionContext().messages.length, active: true }, preset.background ? 'read-only' : preset.defaults.permission);
    return runtime.switchSession(sessionId);
  };
  const create = async (sessionFile: string, input?: AgentExecutionInput): Promise<AgentExecutionHandle> => {
    const manager = SessionManager.open(sessionFile);
    const preset = readAgentSessionPreset(manager)!;
    const messages: AgentSession['messages'] = [];
    const controller = new AbortController();
    const tools = await createProjectConfinedTools(preset.projectPath, { fullAccess: false, get permissionLevel() { return input?.context().permission ?? preset.defaults.permission; } });
    const write = tools.find((tool) => tool.name === 'write') as ReturnType<typeof createWriteToolDefinition>;
    return {
      sessionId: manager.getSessionId(), messages,
      prompt: async (text) => {
        const user = { role: 'user' as const, content: text, timestamp: Date.now() };
        messages.push(user); manager.appendMessage(user);
        if (text === 'E2E approved file effect' && input) {
          await input.approvals.execute(`e2e-${randomUUID()}`, 'write', { path: 'agent-approved.txt', content: 'Approved through real confined SDK tool.\n' }, async (args) => {
            await input.validate?.();
            return write.execute('e2e-approved-write', args, controller.signal, undefined, {} as never);
          }, controller.signal);
        }
        const response = { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Deterministic Agent result; no provider was called.' }], api: 'anthropic-messages' as const, provider: 'test', model: 'deterministic', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop' as const, timestamp: Date.now() };
        messages.push(response); manager.appendMessage(response);
      },
      abort: async () => { controller.abort(); }, dispose: () => undefined,
    };
  };
  const host: AgentsHost['runtime'] = {
    getState: () => runtime.getState(),
    agentAuthority: (id) => runtime.agentAuthority(id),
    agentModelRuntime: async () => ({ getAvailable: async () => runtime.getState().models } as unknown as ModelRuntime),
    agentResources: async () => ({ skills: [], contextPrompts: [] }),
    openAgentSavedSession: open,
    createAgentForegroundExecution: async (id) => { await open(id); return create(await find(id)); },
  };
  return { host, execute: (input: AgentExecutionInput) => create(input.sessionFile, input) };
}
