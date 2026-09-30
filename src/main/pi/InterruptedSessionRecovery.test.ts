import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Message, ToolResultMessage } from '@earendil-works/pi-ai';
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages';
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionRuntime,
} from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiRuntimeService, type PiSdkAdapter } from './PiRuntimeService';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function sdkFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fate-interrupted-session-'));
  roots.push(root);
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'PI_CODING_AGENT_DIR', 'PI_AGENT_DIR', 'PI_CONFIG_DIR', 'FATE_GUI_DATA_DIR']) {
    const directory = path.join(root, key);
    await mkdir(directory);
    vi.stubEnv(key, directory);
  }
  vi.stubEnv('PI_OFFLINE', '1');
  const project = path.join(root, 'project');
  await mkdir(project);
  const sentinel = path.join(project, 'sentinel.txt');
  await writeFile(sentinel, 'unchanged');
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(root, 'auth.json'), modelsPath: null, modelsStorePath: path.join(root, 'models-store.json'), allowModelNetwork: false,
  });
  const model = modelRuntime.getModels().find((candidate) => candidate.api === 'openai-responses')!;
  expect(model).toBeDefined();
  vi.spyOn(modelRuntime, 'getAvailable').mockResolvedValue([model]);
  vi.spyOn(modelRuntime, 'hasConfiguredAuth').mockReturnValue(true);
  const manager = SessionManager.inMemory(project);
  const oldAssistant = {
    role: 'assistant' as const,
    api: model.api, provider: model.provider, model: model.id,
    content: [
      { type: 'toolCall' as const, id: 'old-read', name: 'read', arguments: { path: 'sentinel.txt' } },
      { type: 'toolCall' as const, id: 'old-bash', name: 'bash', arguments: { command: 'overwrite sentinel' } },
      { type: 'toolCall' as const, id: 'old-write', name: 'write', arguments: { path: 'sentinel.txt', content: 'changed' } },
    ],
    stopReason: 'toolUse' as const, timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Previous request' }], timestamp: 0 });
  manager.appendMessage(oldAssistant);
  manager.appendMessage({ role: 'toolResult', toolCallId: 'old-read', toolName: 'read', content: [{ type: 'text', text: 'unchanged' }], isError: false, timestamp: 2 });
  expect(manager.getBranch().filter((entry) => entry.type === 'message')).toHaveLength(3);
  const services = await createAgentSessionServices({
    cwd: project, modelRuntime, settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: { noExtensions: true, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true },
  });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model, thinkingLevel: 'off' });
  expect(session.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
  const runtime = { session, services, diagnostics: [], setRebindSession: vi.fn(), dispose: async () => { session.dispose(); } } as unknown as AgentSessionRuntime;
  const adapter: PiSdkAdapter = {
    createModelRuntime: async () => modelRuntime,
    createRuntime: async () => runtime,
  };
  const service = new PiRuntimeService(adapter);
  return { project, sentinel, session, manager, model, service };
}

/** Verify the actual Pi provider transform, rather than imposing extra rules on raw SDK history. */
function unansweredToolCalls(messages: readonly Message[]): string[] {
  const outstanding = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const part of message.content) if (part.type === 'toolCall') outstanding.add(part.id);
    } else if (message.role === 'toolResult') outstanding.delete(message.toolCallId);
  }
  return [...outstanding];
}

describe('interrupted SDK sessions', () => {
  it.each(['aborted', 'error'] as const)('does not fabricate a result for SDK-skipped %s assistant calls', async (stopReason) => {
    const { session, model, service } = await sdkFixture();
    try {
      const source = session.messages.find((message) => message.role === 'assistant');
      expect(source?.role).toBe('assistant');
      if (!source || source.role !== 'assistant') throw new Error('Fixture assistant unavailable');
      const partial = {
        ...source, stopReason,
        content: [{ type: 'toolCall' as const, id: `skipped-${stopReason}`, name: 'write', arguments: { path: 'sentinel.txt', content: 'wrong' } }],
      };
      const providerMessages = transformMessages([
        partial,
        { role: 'user', content: [{ type: 'text', text: 'Continue safely' }], timestamp: Date.now() },
      ], model);
      expect(providerMessages).not.toContainEqual(expect.objectContaining({ role: 'assistant' }));
      expect(providerMessages).not.toContainEqual(expect.objectContaining({ role: 'toolResult', toolCallId: `skipped-${stopReason}` }));
    } finally { await service.dispose(); }
  });

  it('leaves interrupted results to the SDK provider transform on explicit continuation without replaying tools', async () => {
    const fixture = await sdkFixture();
    const { service, session, manager, project, sentinel, model } = fixture;
    try {
      const invoked = vi.fn();
      const observed: Message[][] = [];
      const rawContext: Message[][] = [];
      const shell = session.getToolDefinition('bash');
      const write = session.getToolDefinition('write');
      expect(shell).toBeDefined();
      expect(write).toBeDefined();
      const shellExecute = vi.spyOn(shell!, 'execute');
      const writeExecute = vi.spyOn(write!, 'execute');
      session.agent.streamFunction = ((_model, context) => {
        rawContext.push(context.messages);
        const providerMessages = transformMessages(context.messages, model);
        observed.push(providerMessages);
        const missing = unansweredToolCalls(providerMessages);
        if (missing.length) throw new Error(`provider rejected missing tool results: ${missing.join(', ')}`);
        const answer = {
          role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          content: [{ type: 'text', text: 'Continued after the interrupted tools without replay.' }],
          stopReason: 'stop', timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } as const;
        invoked();
        return {
          async *[Symbol.asyncIterator]() { yield { type: 'done', message: answer }; },
          result: async () => answer,
        } as unknown as ReturnType<typeof session.agent.streamFunction>;
      }) as typeof session.agent.streamFunction;
      const initial = await service.openProject({ path: project, name: 'project', trusted: true });
      expect(initial.status, JSON.stringify(initial.error)).toBe('ready');
      expect(initial.tools?.map((tool) => [tool.id, tool.status])).toEqual([
        ['old-read', 'succeeded'], ['old-bash', 'error'], ['old-write', 'error'],
      ]);
      expect(initial.activeSessionRunning).toBe(false);
      const previousBranch = manager.getBranch().map((entry) => entry.id);
      // Merely opening/hydrating cannot send anything to a model or execute saved tools.
      expect(invoked).not.toHaveBeenCalled();
      expect(manager.getBranch().map((entry) => entry.id)).toEqual(previousBranch);
      expect((await service.prompt({ text: 'Continue, inspect the outcome first; do not rerun shell or writes.', behavior: 'prompt' })).accepted).toBe(true);
      await vi.waitFor(() => expect(observed).toHaveLength(1));
      await session.waitForIdle();
      expect(invoked).toHaveBeenCalledTimes(1);
      expect(unansweredToolCalls(rawContext[0]!)).toEqual(['old-bash', 'old-write']);
      expect(unansweredToolCalls(observed[0]!)).toEqual([]);
      expect(observed[0]!.filter((message) => message.role === 'toolResult').map((message) => message.toolCallId)).toEqual(['old-read', 'old-bash', 'old-write']);
      expect(observed[0]!.filter((message) => message.role === 'toolResult')).toEqual(expect.arrayContaining([
        expect.objectContaining({ toolCallId: 'old-bash', isError: true }),
        expect.objectContaining({ toolCallId: 'old-write', isError: true }),
        expect.objectContaining({ toolCallId: 'old-read', content: [{ type: 'text', text: 'unchanged' }], isError: false }),
      ]));
      const recovered = observed[0]!.filter((message): message is ToolResultMessage => message.role === 'toolResult' && message.isError);
      expect(recovered).toHaveLength(2);
      expect(recovered.every((result) => result.content.some((part) => part.type === 'text' && part.text === 'No result provided'))).toBe(true);
      expect(shellExecute).not.toHaveBeenCalled();
      expect(writeExecute).not.toHaveBeenCalled();
      expect(await readFile(sentinel, 'utf8')).toBe('unchanged');
      expect(manager.getBranch().slice(0, previousBranch.length).map((entry) => entry.id)).toEqual(previousBranch);
      expect(manager.getBranch().filter((entry) => entry.type === 'message' && entry.message.role === 'toolResult')).toHaveLength(1);
      await vi.waitFor(() => expect(service.getHydrationState()).toMatchObject({ streaming: false, activeSessionRunning: false, queue: { steering: 0, followUp: 0 } }));
      expect(service.getHydrationState().messages.at(-1)?.text).toContain('Continued after the interrupted tools');
    } finally { await service.dispose(); }
  });

  it('uses SDK pending tool ownership during hydration without treating older missing results as active', async () => {
    const fixture = await sdkFixture();
    const { service, session, project, model } = fixture;
    let releaseRead!: (result: { content: [{ type: 'text'; text: string }]; details: object }) => void;
    const pendingRead = new Promise<{ content: [{ type: 'text'; text: string }]; details: object }>((resolve) => { releaseRead = resolve; });
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    try {
      const read = session.getToolDefinition('read');
      expect(read).toBeDefined();
      vi.spyOn(read!, 'execute').mockImplementation(async () => { readStarted(); return pendingRead; });
      session.agent.toolExecution = 'sequential';
      let responses = 0;
      session.agent.streamFunction = ((_model, context) => {
        expect(unansweredToolCalls(transformMessages(context.messages, model))).toEqual([]);
        const first = responses++ === 0;
        const answer = {
          role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          content: first
            ? [
                { type: 'toolCall' as const, id: 'live-read', name: 'read', arguments: { path: 'sentinel.txt' } },
                { type: 'toolCall' as const, id: 'queued-read', name: 'read', arguments: { path: 'sentinel.txt' } },
              ]
            : [{ type: 'text' as const, text: 'Read finished.' }],
          stopReason: first ? 'toolUse' as const : 'stop' as const, timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        return {
          async *[Symbol.asyncIterator]() { yield { type: 'done', message: answer }; },
          result: async () => answer,
        } as unknown as ReturnType<typeof session.agent.streamFunction>;
      }) as typeof session.agent.streamFunction;
      await service.openProject({ path: project, name: 'project', trusted: true });
      expect((await service.prompt({ text: 'Read the current state.', behavior: 'prompt' })).accepted).toBe(true);
      await started;
      expect(session.agent.state.pendingToolCalls.has('live-read')).toBe(true);
      // Simulate losing selected-slot event memory while the SDK still owns the tool.
      const slot = (service as unknown as { selectedSlot: { normalizer: { resetSession(): void } } }).selectedSlot;
      slot.normalizer.resetSession();
      const active = service.getHydrationState();
      expect(active.tools?.find((tool) => tool.id === 'live-read')).toMatchObject({ status: 'running', output: '' });
      expect(active.tools?.find((tool) => tool.id === 'queued-read')).toBeUndefined();
      expect(active.tools?.find((tool) => tool.id === 'old-bash')).toMatchObject({ status: 'error' });
      releaseRead({ content: [{ type: 'text', text: 'unchanged' }], details: {} });
      await vi.waitFor(() => expect(service.getHydrationState().tools?.filter((tool) => tool.id === 'live-read' || tool.id === 'queued-read').map((tool) => tool.status)).toEqual(['succeeded', 'succeeded']));
      await session.waitForIdle();
      expect(session.agent.state.pendingToolCalls.size).toBe(0);
    } finally { await service.dispose(); }
  });
});
