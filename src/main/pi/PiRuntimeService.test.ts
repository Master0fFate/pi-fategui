import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  Theme,
  type AgentSessionRuntime,
  type ModelRuntime,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeToolsForPermission, assertOwnedToolDefinitions, PiRuntimeService, isCanonicalPathInside, selectUserExtensionPaths, type PiSdkAdapter } from './PiRuntimeService';
import type { PiEvent } from '../../shared/contracts/ipc';
import { PiSessionRepository } from './PiSessionRepository';
import type { SessionTitleGenerator } from './PiSessionTitleGenerator';
import { InMemorySessionPermissionStore } from './SessionPermissionStore';

const model = { provider: 'test', id: 'model', name: 'Test Model', reasoning: true, contextWindow: 1000, input: ['text', 'image'] as const };

function fixture(availableModels: typeof model[] = [model]) {
  let settleRun: (() => void) | undefined;
  let streaming = false;
  let sessionName: string | undefined;
  let activeTools = ['read', 'bash', 'edit', 'write', 'generate_image', 'imagegen'];
  let steeringMessages: string[] = [];
  let followUpMessages: string[] = [];
  const sessionListeners = new Set<(event: unknown) => void>();
  const agentListeners = new Set<(event: { type: string; message?: { role?: string; content?: unknown } }) => void | Promise<void>>();
  const agent = {
    state: { model, thinkingLevel: 'medium', messages: [] as unknown[], tools: [] as unknown[] },
    streamFunction: vi.fn(),
    subscribe: vi.fn((listener: (event: { type: string; message?: { role?: string; content?: unknown } }) => void | Promise<void>) => {
      agentListeners.add(listener);
      return () => { agentListeners.delete(listener); };
    }),
  };
  const session = {
    sessionId: 'session-1', sessionFile: undefined as string | undefined, model, thinkingLevel: 'medium', messages: [] as unknown[], agent,
    get sessionName() { return sessionName; },
    sessionManager: {
      getLeafId: vi.fn(() => 'leaf-1'),
      getSessionName: vi.fn(() => sessionName),
      appendSessionInfo: vi.fn((name: string) => { sessionName = name; return 'name-entry'; }),
      appendCustomEntry: vi.fn(() => 'custom-entry'),
    },
    resourceLoader: { getSkills: () => ({ skills: [], diagnostics: [] }) },
    get isStreaming() { return streaming; },
    bindExtensions: vi.fn(async () => undefined),
    subscribe: vi.fn((listener: (event: unknown) => void) => {
      sessionListeners.add(listener);
      return vi.fn(() => { sessionListeners.delete(listener); });
    }),
    prompt: vi.fn((_text: string, options: { preflightResult: (accepted: boolean) => void; streamingBehavior?: 'steer' | 'followUp' }) => {
      if (options.streamingBehavior === 'steer') steeringMessages.push(_text);
      if (options.streamingBehavior === 'followUp') followUpMessages.push(_text);
      options.preflightResult(true);
      if (options.streamingBehavior) return Promise.resolve();
      streaming = true;
      return new Promise<void>((resolve) => { settleRun = () => { streaming = false; resolve(); }; });
    }),
    steer: vi.fn(async (text: string) => { steeringMessages.push(text); }),
    followUp: vi.fn(async (text: string) => { followUpMessages.push(text); }),
    sendCustomMessage: vi.fn(async () => undefined),
    clearQueue: vi.fn(() => {
      const queued = { steering: [...steeringMessages], followUp: [...followUpMessages] };
      steeringMessages = [];
      followUpMessages = [];
      return queued;
    }),
    getSteeringMessages: vi.fn(() => [...steeringMessages]),
    getFollowUpMessages: vi.fn(() => [...followUpMessages]),
    abort: vi.fn(async () => { streaming = false; settleRun?.(); }),
    setModel: vi.fn(async (nextModel: typeof model) => {
      session.model = nextModel;
      agent.state.model = nextModel;
    }), setThinkingLevel: vi.fn((level: string) => {
      session.thinkingLevel = level;
      agent.state.thinkingLevel = level;
    }),
    getActiveToolNames: vi.fn(() => [...activeTools]),
    setActiveToolsByName: vi.fn((names: string[]) => { activeTools = [...names]; }),
    setSessionName: vi.fn((name: string) => { sessionName = name; }),
    getUserMessagesForForking: vi.fn(() => [{ entryId: 'entry-1', text: 'original prompt' }]),
    compact: vi.fn(async () => undefined),
  };
  const runtime = {
    session, diagnostics: [], setRebindSession: vi.fn(), setBeforeSessionInvalidate: vi.fn(),
    newSession: vi.fn(async () => ({ cancelled: false })),
    switchSession: vi.fn(async () => ({ cancelled: false })),
    fork: vi.fn(async () => ({ cancelled: false, selectedText: 'original prompt' })),
    importFromJsonl: vi.fn(async () => ({ cancelled: false })),
    dispose: vi.fn(async () => undefined),
  };
  const modelRuntime = {
    getAvailable: vi.fn(async () => availableModels), getModel: vi.fn((_provider: string, _id: string) => model),
  };
  const adapter: PiSdkAdapter = {
    supportsClone: true,
    createModelRuntime: vi.fn(async () => modelRuntime as unknown as ModelRuntime),
    createRuntime: vi.fn(async () => runtime as unknown as AgentSessionRuntime),
  };
  return {
    adapter, modelRuntime, runtime, session, agent,
    settle: () => settleRun?.(),
    setStreaming: (value: boolean) => { streaming = value; },
    emitSession: (event: unknown) => { for (const listener of sessionListeners) listener(event); },
    emitAgent: async (event: { type: string; message?: { role?: string; content?: unknown } }) => {
      for (const listener of agentListeners) await listener(event);
    },
    setQueue: (steering: string[], followUp: string[]) => {
      steeringMessages = [...steering];
      followUpMessages = [...followUp];
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('PiRuntimeService', () => {
  it('gates controlled tools without disabling active extension capabilities', () => {
    expect(activeToolsForPermission(['read', 'bash', 'edit', 'write', 'generate_image', 'imagegen'], 'edit')).toEqual(['read', 'edit', 'write', 'generate_image', 'imagegen']);
    expect(activeToolsForPermission(['read', 'edit', 'write', 'generate_image', 'imagegen'], 'read-only')).toEqual(['read', 'generate_image', 'imagegen']);
    expect(activeToolsForPermission(['read', 'generate_image', 'imagegen'], 'full-access')).toEqual(['read', 'generate_image', 'imagegen', 'write', 'edit', 'bash']);
  });

  it('fails closed if an extension replaces a Fate-owned orchestration tool', () => {
    const owned = { name: 'subagent' } as ToolDefinition;
    expect(() => assertOwnedToolDefinitions({ getToolDefinition: () => owned } as never, [owned])).not.toThrow();
    expect(() => assertOwnedToolDefinitions({ getToolDefinition: () => ({ name: 'subagent' }) } as never, [owned])).toThrow(/extension replaced Fate UI's owned subagent tool/u);
  });

  it('loads enabled global extensions but excludes executable project extensions', () => {
    expect(selectUserExtensionPaths([
      { path: '/global/parallax.ts', enabled: true, metadata: { scope: 'user' } },
      { path: '/project/.pi/extensions/untrusted.ts', enabled: true, metadata: { scope: 'project' } },
      { path: '/global/disabled.ts', enabled: false, metadata: { scope: 'user' } },
    ])).toEqual(['/global/parallax.ts']);
  });

  it('keeps inherited Pi context files inside the canonical project root', () => {
    expect(isCanonicalPathInside(process.cwd(), path.join(process.cwd(), 'package.json'))).toBe(true);
    expect(isCanonicalPathInside(process.cwd(), path.dirname(process.cwd()))).toBe(false);
  });

  it('initializes the SDK theme before runtime setup so mutation tools can render and execute', async () => {
    Reflect.deleteProperty(globalThis, Symbol.for('@earendil-works/pi-coding-agent:theme'));
    Reflect.deleteProperty(globalThis, Symbol.for('@mariozechner/pi-coding-agent:theme'));
    const fake = fixture();
    const createRuntime = fake.adapter.createRuntime as ReturnType<typeof vi.fn>;
    createRuntime.mockImplementationOnce(async () => {
      expect(Reflect.get(globalThis, Symbol.for('@earendil-works/pi-coding-agent:theme'))).toBeInstanceOf(Theme);
      return fake.runtime as unknown as AgentSessionRuntime;
    });
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    const sdkTheme = Reflect.get(globalThis, Symbol.for('@earendil-works/pi-coding-agent:theme')) as Theme;

    const writeFile = vi.fn(async () => undefined);
    const write = createWriteToolDefinition('/project', { operations: { mkdir: vi.fn(async () => undefined), writeFile } });
    write.renderCall?.(
      { path: 'probe.txt', content: 'before' },
      sdkTheme,
      { args: { path: 'probe.txt', content: 'before' }, toolCallId: 'write', invalidate: vi.fn(), lastComponent: undefined, state: undefined, cwd: '/project', executionStarted: false, argsComplete: true, isPartial: false, expanded: false, showImages: false, isError: false },
    );
    await write.execute('write', { path: 'probe.txt', content: 'before' }, undefined, undefined, {} as never);

    const editWriteFile = vi.fn(async () => undefined);
    const edit = createEditToolDefinition('/project', { operations: { access: vi.fn(async () => undefined), readFile: vi.fn(async () => Buffer.from('before')), writeFile: editWriteFile } });
    await edit.execute('edit', { path: 'probe.txt', edits: [{ oldText: 'before', newText: 'after' }] }, undefined, undefined, {} as never);

    const exec = vi.fn(async (_command: string, _cwd: string, options: { onData: (data: Buffer) => void }) => {
      options.onData(Buffer.from('ok'));
      return { exitCode: 0 };
    });
    const bash = createBashToolDefinition('/project', { operations: { exec } });
    await bash.execute('bash', { command: 'echo ok' }, undefined, undefined, {} as never);

    expect(writeFile).toHaveBeenCalledOnce();
    expect(editWriteFile).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledOnce();
    await service.dispose();
  });

  it('disposes a candidate runtime that fails after creation instead of exposing a partial session', async () => {
    const fake = fixture();
    fake.session.bindExtensions.mockRejectedValueOnce(new Error('extension binding failed'));
    const service = new PiRuntimeService(fake.adapter);

    await expect(service.openProject({ path: '/project', name: 'project', trusted: true })).resolves.toMatchObject({
      status: 'error',
      sessionId: null,
      error: { message: 'extension binding failed' },
    });
    expect(fake.runtime.dispose).toHaveBeenCalledOnce();
    await service.dispose();
  });

  it('restores an explicit disconnected no-project state for activation rollback', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });

    await expect(service.closeProject()).resolves.toMatchObject({ status: 'disconnected', project: null, error: null });
    expect(fake.runtime.dispose).toHaveBeenCalledOnce();
    expect(service.getState(false)).toMatchObject({ status: 'disconnected', project: null, sessionId: null });
    await service.dispose();
  });

  it('does not let a delayed close erase a newer project', async () => {
    const fake = fixture();
    let finishDispose: (() => void) | undefined;
    fake.runtime.dispose.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finishDispose = () => resolve(undefined); }));
    const successor = { ...fake.runtime, dispose: vi.fn(async () => undefined) };
    (fake.adapter.createRuntime as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(fake.runtime as unknown as AgentSessionRuntime)
      .mockResolvedValueOnce(successor as unknown as AgentSessionRuntime);
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project-a', name: 'A', trusted: true });

    const closing = service.closeProject();
    await vi.waitFor(() => expect(fake.runtime.dispose).toHaveBeenCalledOnce());
    await service.openProject({ path: '/project-b', name: 'B', trusted: true });
    finishDispose?.();
    await closing;

    expect(service.getState(false)).toMatchObject({ status: 'ready', project: { path: '/project-b' } });
    await service.dispose();
  });

  it('surfaces prompt preflight acceptance before the long-running prompt settles', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    const acceptance = await service.prompt({ text: 'work', behavior: 'prompt' });
    expect(acceptance.accepted).toBe(true);
    expect(service.getState().streaming).toBe(true);
    fake.settle();
    await Promise.resolve();
    await service.dispose();
  });

  it('makes a first prompt visible and titles its live session even when repository listing is stale', async () => {
    const fake = fixture();
    const source = { list: vi.fn(async () => []), rename: vi.fn() };
    let finishTitle: ((title: string) => void) | undefined;
    const titleGenerator: SessionTitleGenerator = {
      generate: vi.fn(() => new Promise<string>((resolve) => { finishTitle = resolve; })),
    };
    const service = new PiRuntimeService(
      fake.adapter,
      new PiSessionRepository(source),
      new InMemorySessionPermissionStore(),
      titleGenerator,
    );
    await service.openProject({ path: '/project', name: 'project', trusted: true });

    await expect(service.prompt({ text: 'Repair the Git workflow', behavior: 'prompt' })).resolves.toMatchObject({ accepted: true });
    expect(service.getState(false).sessions).toEqual([
      expect.objectContaining({ id: 'session-1', title: 'Repair the Git workflow', active: true }),
    ]);
    expect(source.list).toHaveBeenCalledOnce();
    finishTitle?.('Repair Git workflow');
    await vi.waitFor(() => expect(fake.session.sessionManager.appendSessionInfo).toHaveBeenCalledWith('Repair Git workflow'));
    expect(source.rename).not.toHaveBeenCalled();
    expect(service.getState(false).sessions?.[0]?.title).toBe('Repair Git workflow');
    fake.settle();
    await service.dispose();
  });

  it('never overwrites a manual rename that wins the first-title race', async () => {
    const fake = fixture();
    let finishTitle: ((title: string) => void) | undefined;
    const titleGenerator: SessionTitleGenerator = {
      generate: vi.fn(() => new Promise<string>((resolve) => { finishTitle = resolve; })),
    };
    const service = new PiRuntimeService(fake.adapter, undefined, undefined, titleGenerator);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    await service.prompt({ text: 'Investigate the race', behavior: 'prompt' });
    await service.renameSession('session-1', 'Manual title');
    finishTitle?.('Generated title');
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.session.setSessionName).toHaveBeenCalledWith('Manual title');
    expect(fake.session.sessionManager.appendSessionInfo).not.toHaveBeenCalled();
    expect(service.getState(false).sessions?.find((session) => session.id === 'session-1')?.title).toBe('Manual title');
    fake.settle();
    await service.dispose();
  });

  it('settles a prompt rejected after its session is invalidated', async () => {
    const fake = fixture();
    let rejectPrompt: ((error: Error) => void) | undefined;
    fake.session.prompt.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectPrompt = reject; }));
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project-a', name: 'A', trusted: true });

    const acceptance = service.prompt({ text: 'work', behavior: 'prompt' });
    await service.openProject({ path: '/project-b', name: 'B', trusted: false });
    rejectPrompt?.(new Error('old session closed'));

    await expect(acceptance).resolves.toMatchObject({ accepted: false });
    expect(service.getState().project?.path).toBe('/project-b');
    await service.dispose();
  });

  it('includes Pi\'s authoritative in-flight assistant message in hydration', async () => {
    const fake = fixture();
    Object.assign(fake.session, {
      agent: {
        state: {
          streamingMessage: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'live reasoning' }, { type: 'text', text: 'partial answer' }],
            timestamp: 5,
          },
        },
      },
    });
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    await service.prompt({ text: 'work', behavior: 'prompt' });

    expect(service.getHydrationState().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', text: 'partial answer', reasoning: 'live reasoning' }),
    ]));
    fake.settle();
    await service.dispose();
  });

  it('does not let stale project initialization overwrite a newer project', async () => {
    const fake = fixture();
    let rejectFirst: ((error: Error) => void) | undefined;
    const firstModelRuntime = new Promise<ModelRuntime>((_resolve, reject) => { rejectFirst = reject; });
    (fake.adapter.createModelRuntime as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => firstModelRuntime)
      .mockResolvedValueOnce(fake.modelRuntime as unknown as ModelRuntime);
    const service = new PiRuntimeService(fake.adapter);

    const first = service.openProject({ path: '/project-a', name: 'A', trusted: true });
    await vi.waitFor(() => expect(fake.adapter.createModelRuntime).toHaveBeenCalledTimes(1));
    const second = service.openProject({ path: '/project-b', name: 'B', trusted: true });
    await second;
    rejectFirst?.(new Error('stale initialization failed'));
    await first;

    expect(service.getState()).toMatchObject({ status: 'ready', project: { path: '/project-b' } });
    await service.dispose();
  });

  it('passes validated image attachments only to an image-capable Pi model', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    const state = await service.openProject({ path: '/project', name: 'project', trusted: true });
    expect(state.model?.supportsImages).toBe(true);
    const png = Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
    png.writeUInt32BE(1, 16);
    png.writeUInt32BE(1, 20);
    const data = png.toString('base64');
    await service.prompt({
      text: 'inspect', behavior: 'prompt',
      images: [{ name: 'screen.png', mimeType: 'image/png', data }],
    });
    expect(fake.session.prompt).toHaveBeenCalledWith('inspect', expect.objectContaining({
      images: [{ type: 'image', mimeType: 'image/png', data }],
    }));
    fake.settle();
    await service.dispose();
  });

  it('queues through prompt preflight and exposes the original follow-up preview', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    await service.prompt({ text: 'work', behavior: 'prompt' });
    const image = {
      name: 'screen.png',
      mimeType: 'image/png' as const,
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    };
    const acceptance = await service.prompt({ text: 'change direction', behavior: 'followUp', images: [image] });

    expect(acceptance.accepted).toBe(true);
    expect(fake.session.prompt).toHaveBeenLastCalledWith('change direction', expect.objectContaining({ streamingBehavior: 'followUp' }));
    expect(fake.session.followUp).not.toHaveBeenCalled();
    expect(service.getState(false).queue).toMatchObject({
      steering: 0,
      followUp: 1,
      items: [expect.objectContaining({ behavior: 'followUp', text: 'change direction', images: [image] })],
    });
    fake.settle();
    await service.dispose();
  });

  it('converts one queued follow-up to steering through the public Pi queue API', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    await service.prompt({ text: 'work', behavior: 'prompt' });
    await service.prompt({ text: 'first', behavior: 'followUp' });
    await service.prompt({ text: 'second', behavior: 'followUp' });
    const first = service.getState(false).queue?.items?.[0];

    const result = await service.mutateQueuedMessage({ id: first!.id, action: 'steer' });

    expect(fake.session.clearQueue).toHaveBeenCalledOnce();
    expect(fake.session.steer).toHaveBeenLastCalledWith('first', undefined);
    expect(fake.session.followUp).toHaveBeenLastCalledWith('second', undefined);
    expect(result.state.queue).toMatchObject({ steering: 1, followUp: 1 });
    expect(result.state.queue?.items?.map((item) => [item.text, item.behavior])).toEqual([
      ['first', 'steer'],
      ['second', 'followUp'],
    ]);
    fake.settle();
    await service.dispose();
  });

  it('edits and cancels duplicate queued messages by stable ID', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    await service.prompt({ text: 'work', behavior: 'prompt' });
    await service.prompt({ text: 'same text', behavior: 'followUp' });
    await service.prompt({ text: 'same text', behavior: 'followUp' });
    const [first, second] = service.getState(false).queue?.items ?? [];

    const edited = await service.mutateQueuedMessage({ id: first!.id, action: 'edit' });
    expect(edited.restored).toEqual({ text: 'same text' });
    expect(edited.state.queue?.items?.map((item) => item.id)).toEqual([second!.id]);

    const cancelled = await service.mutateQueuedMessage({ id: second!.id, action: 'cancel' });
    expect(cancelled.state.queue).toMatchObject({ steering: 0, followUp: 0, items: [] });
    fake.settle();
    await service.dispose();
  });

  it('rejects a stale queue mutation after Pi starts consuming the target', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    await service.prompt({ text: 'work', behavior: 'prompt' });
    await service.prompt({ text: 'next', behavior: 'followUp' });
    const target = service.getState(false).queue?.items?.[0];
    fake.setQueue([], []);

    await expect(service.mutateQueuedMessage({ id: target!.id, action: 'edit' })).rejects.toThrow('already being sent');
    expect(service.getState(false).queue).toMatchObject({ steering: 0, followUp: 0, items: [] });
    fake.settle();
    await service.dispose();
  });

  it('clears the mirrored queue when the active project is replaced', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project-a', name: 'A', trusted: true });
    await service.prompt({ text: 'work', behavior: 'prompt' });
    await service.prompt({ text: 'next', behavior: 'followUp' });
    await service.openProject({ path: '/project-b', name: 'B', trusted: true });

    expect(service.getState(false).queue?.items).toEqual([]);
    await service.dispose();
  });

  it('applies a staged idle model immediately before the next direct user prompt', async () => {
    const alternate = { ...model, id: 'fast', name: 'Fast Model' };
    const fake = fixture([model, alternate]);
    fake.modelRuntime.getModel.mockImplementation((_provider: string, id: string) => id === 'fast' ? alternate : model);
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });

    const staged = await service.setModel('test', 'fast');
    expect(staged.model?.id).toBe('model');
    expect(staged.pendingModel?.id).toBe('fast');
    expect(fake.session.setModel).not.toHaveBeenCalled();

    await service.prompt({ text: 'use the fast model', behavior: 'prompt' });
    expect(fake.session.setModel).toHaveBeenCalledWith(alternate);
    expect(fake.session.setModel.mock.invocationCallOrder[0]).toBeLessThan(fake.session.prompt.mock.invocationCallOrder[0]!);
    expect(service.getState(false)).toMatchObject({ model: { id: 'fast' }, pendingModel: null });
    fake.settle();
    await service.dispose();
  });

  it('stages reasoning and applies it immediately before the next direct user prompt', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });

    expect(service.setThinkingLevel('high')).toMatchObject({ thinkingLevel: 'medium', pendingThinkingLevel: 'high' });
    expect(fake.session.setThinkingLevel).not.toHaveBeenCalled();

    await service.prompt({ text: 'think deeply', behavior: 'prompt' });
    expect(fake.session.setThinkingLevel).toHaveBeenCalledWith('high');
    expect(fake.session.setThinkingLevel.mock.invocationCallOrder[0]).toBeLessThan(fake.session.prompt.mock.invocationCallOrder[0]!);
    expect(service.getState(false)).toMatchObject({ thinkingLevel: 'high', pendingThinkingLevel: null });
    fake.settle();
    await service.dispose();
  });

  it('restores a staged model when direct prompt preflight rejects the message', async () => {
    const alternate = { ...model, id: 'fast', name: 'Fast Model' };
    const fake = fixture([model, alternate]);
    fake.modelRuntime.getModel.mockImplementation((_provider: string, id: string) => id === 'fast' ? alternate : model);
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    await service.setModel('test', 'fast');
    fake.session.prompt.mockImplementationOnce((_text, options) => {
      options.preflightResult(false);
      return Promise.reject(new Error('rejected by input gate'));
    });

    await expect(service.prompt({ text: 'blocked', behavior: 'prompt' })).resolves.toMatchObject({ accepted: false });
    expect(service.getState(false)).toMatchObject({ pendingModel: { id: 'fast' } });
    expect(service.getState(false).objective).toBeUndefined();
    await service.dispose();
  });

  it('does not reserve a queue item or consume its model when a streaming extension command runs immediately', async () => {
    const alternate = { ...model, id: 'fast', name: 'Fast Model' };
    const fake = fixture([model, alternate]);
    fake.modelRuntime.getModel.mockImplementation((_provider: string, id: string) => id === 'fast' ? alternate : model);
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    await service.prompt({ text: 'current work', behavior: 'prompt' });
    await service.setModel('test', 'fast');
    fake.session.prompt.mockImplementationOnce((_text, options) => {
      options.preflightResult(true);
      return Promise.resolve();
    });

    await expect(service.prompt({ text: '/extension-command', behavior: 'followUp' })).resolves.toMatchObject({ accepted: true });
    expect(service.getState(false).queue?.items).toEqual([]);
    expect(service.getState(false).pendingModel?.id).toBe('fast');
    fake.settle();
    await service.dispose();
  });

  it('does not mutate the executing model until a bound queued user message is consumed', async () => {
    const alternate = { ...model, id: 'fast', name: 'Fast Model' };
    const fake = fixture([model, alternate]);
    const originalStreamFunction = fake.agent.streamFunction;
    const context = { systemPrompt: '', messages: [], tools: [] };
    fake.modelRuntime.getModel.mockImplementation((_provider: string, id: string) => id === 'fast' ? alternate : model);
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    await service.prompt({ text: 'current work', behavior: 'prompt' });

    await service.setModel('test', 'fast');
    service.setThinkingLevel('high');
    expect(fake.session.setModel).not.toHaveBeenCalled();
    expect(fake.session.setThinkingLevel).not.toHaveBeenCalled();
    await fake.emitAgent({ type: 'message_start', message: { role: 'toolResult', content: 'current continuation' } });
    fake.agent.streamFunction(model, context, { apiKey: 'current-key', reasoning: 'low' });
    expect(originalStreamFunction).toHaveBeenLastCalledWith(model, context, { apiKey: 'current-key', reasoning: 'low' });
    expect(fake.session.setModel).not.toHaveBeenCalled();

    await service.prompt({ text: 'next direction', behavior: 'followUp' });
    expect(service.getState(false).pendingModel).toBeNull();
    expect(fake.session.setModel).not.toHaveBeenCalled();
    fake.setQueue([], []);
    fake.emitSession({ type: 'queue_update', steering: [], followUp: [] });
    await fake.emitAgent({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'next direction' }] } });
    expect(fake.session.setModel).toHaveBeenCalledTimes(1);
    expect(fake.session.setModel).toHaveBeenCalledWith(alternate);
    expect(fake.session.setThinkingLevel).toHaveBeenCalledWith('high');
    fake.agent.streamFunction(model, context, { apiKey: 'captured-key', reasoning: 'low' });
    expect(originalStreamFunction).toHaveBeenLastCalledWith(alternate, context, { reasoning: 'high' });
    fake.settle();
    await service.dispose();
  });

  it('discards a cancelled queued model binding and preserves one restored for editing', async () => {
    const alternate = { ...model, id: 'fast', name: 'Fast Model' };
    const fake = fixture([model, alternate]);
    fake.modelRuntime.getModel.mockImplementation((_provider: string, id: string) => id === 'fast' ? alternate : model);
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    await service.prompt({ text: 'current work', behavior: 'prompt' });

    await service.setModel('test', 'fast');
    await service.prompt({ text: 'cancel me', behavior: 'followUp' });
    const cancelledTarget = service.getState(false).queue?.items?.[0];
    await service.mutateQueuedMessage({ id: cancelledTarget!.id, action: 'cancel' });
    expect(service.getState(false).pendingModel).toBeNull();
    fake.settle();
    await Promise.resolve();
    fake.session.setModel.mockClear();
    await service.prompt({ text: 'ordinary next prompt', behavior: 'prompt' });
    expect(fake.session.setModel).not.toHaveBeenCalled();
    fake.settle();

    await service.prompt({ text: 'work again', behavior: 'prompt' });
    await service.setModel('test', 'fast');
    await service.prompt({ text: 'edit me', behavior: 'followUp' });
    const editedTarget = service.getState(false).queue?.items?.[0];
    await service.mutateQueuedMessage({ id: editedTarget!.id, action: 'edit' });
    expect(service.getState(false).pendingModel?.id).toBe('fast');
    fake.settle();
    await service.dispose();
  });

  it('stages model and reasoning changes but rejects compaction and prompts that race an active operation', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    await service.prompt({ text: 'work', behavior: 'prompt' });

    await expect(service.setModel('test', 'model')).resolves.toMatchObject({ pendingModel: { provider: 'test', id: 'model' } });
    expect(fake.session.setModel).not.toHaveBeenCalled();
    expect(service.setThinkingLevel('high')).toMatchObject({ thinkingLevel: 'medium', pendingThinkingLevel: 'high' });
    expect(fake.session.setThinkingLevel).not.toHaveBeenCalled();
    await expect(service.compact()).rejects.toThrow('active Pi operation');
    fake.settle();
    await Promise.resolve();

    const runtime = await fake.adapter.createRuntime('/project', {} as ModelRuntime);
    let finishReplacement: (() => void) | undefined;
    (runtime.newSession as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<void>((resolve) => { finishReplacement = resolve; }));
    const replacement = service.newSession();
    await vi.waitFor(() => expect(service.getState().sessionOperation).toBe(true));
    await expect(service.prompt({ text: 'too soon', behavior: 'prompt' })).rejects.toThrow('session change');
    finishReplacement?.();
    await replacement;
    await service.dispose();
  });

  it('consumes staged model and reasoning settings when creating a new session', async () => {
    const alternate = { ...model, id: 'fast', name: 'Fast Model' };
    const fake = fixture([model, alternate]);
    fake.modelRuntime.getModel.mockImplementation((_provider: string, id: string) => id === 'fast' ? alternate : model);
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    await service.setModel('test', 'fast');
    service.setThinkingLevel('high');
    fake.session.setThinkingLevel.mockClear();
    fake.session.setModel.mockImplementationOnce(async (nextModel) => {
      expect(service.getState().sessionOperation).toBe(true);
      fake.session.model = nextModel;
    });

    const state = await service.newSession({ thinkingLevel: 'medium', defaultModel: 'test/model' });
    expect(fake.modelRuntime.getModel).toHaveBeenCalledWith('test', 'fast');
    expect(fake.session.setThinkingLevel).toHaveBeenCalledWith('high');
    expect(fake.session.setModel).toHaveBeenCalledWith(alternate);
    expect(fake.session.setModel.mock.invocationCallOrder[0]).toBeLessThan(fake.session.setThinkingLevel.mock.invocationCallOrder[0]!);
    expect(state).toMatchObject({ sessionOperation: false, pendingModel: null, pendingThinkingLevel: null });
    await service.dispose();
  });

  it('switches between default full access, read-only, and project edit tool sets', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    const initial = await service.openProject({ path: '/project', name: 'project', trusted: true });

    expect(initial.permissionLevel).toBe('full-access');
    expect(fake.session.setActiveToolsByName).toHaveBeenLastCalledWith(['read', 'bash', 'edit', 'write', 'generate_image', 'imagegen']);

    const readOnly = await service.setPermissionLevel('read-only');
    expect(readOnly.permissionLevel).toBe('read-only');
    expect(fake.session.setActiveToolsByName).toHaveBeenLastCalledWith(['read', 'generate_image', 'imagegen']);

    const fullAccess = await service.setPermissionLevel('full-access');
    expect(fullAccess.permissionLevel).toBe('full-access');
    expect(fake.session.setActiveToolsByName).toHaveBeenLastCalledWith(['read', 'generate_image', 'imagegen', 'write', 'edit', 'bash']);

    const editable = await service.setPermissionLevel('edit');
    expect(editable.permissionLevel).toBe('edit');
    expect(fake.session.setActiveToolsByName).toHaveBeenLastCalledWith(['read', 'generate_image', 'imagegen', 'write', 'edit']);
    await service.dispose();
  });

  it('restores host-owned permissions per session and defaults unseen sessions to Full access', async () => {
    const fake = fixture();
    const permissions = new InMemorySessionPermissionStore();
    await permissions.set('/project', 'session-2', 'read-only');
    await permissions.set('/project', 'session-3', 'edit');
    const service = new PiRuntimeService(fake.adapter, undefined, permissions);

    const initial = await service.openProject({ path: '/project', name: 'project', trusted: true });
    expect(initial.permissionLevel).toBe('full-access');
    expect(fake.adapter.createRuntime).toHaveBeenCalledWith(
      '/project', fake.modelRuntime, true,
      expect.arrayContaining([
        expect.objectContaining({ name: 'subagent' }),
        expect.objectContaining({ name: 'subagent_start' }),
        expect.objectContaining({ name: 'subagent_manage' }),
        expect.objectContaining({ name: 'subagent_catalog' }),
      ]),
    );

    const rebind = fake.runtime.setRebindSession.mock.calls[0]?.[0] as ((session: typeof fake.session) => Promise<void>) | undefined;
    const secondSession = { ...fake.session, sessionId: 'session-2' };
    fake.runtime.session = secondSession;
    await rebind?.(secondSession);
    expect(service.getState(false).permissionLevel).toBe('read-only');

    const thirdSession = { ...fake.session, sessionId: 'session-3' };
    fake.runtime.session = thirdSession;
    await rebind?.(thirdSession);
    expect(service.getState(false).permissionLevel).toBe('edit');

    const newSession = { ...fake.session, sessionId: 'session-new' };
    fake.runtime.session = newSession;
    await rebind?.(newSession);
    expect(service.getState(false).permissionLevel).toBe('full-access');

    fake.runtime.session = fake.session;
    await rebind?.(fake.session);
    expect(service.getState(false).permissionLevel).toBe('full-access');
    await service.setPermissionLevel('read-only');
    await expect(permissions.get('/project', 'session-1')).resolves.toBe('read-only');
    await service.dispose();
  });

  it('keeps the previous permission when the SDK rejects a privileged tool set', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    fake.session.setActiveToolsByName.mockImplementationOnce(() => { throw new Error('bash unavailable'); });

    await expect(service.setPermissionLevel('full-access')).rejects.toThrow('bash unavailable');
    expect(service.getState().permissionLevel).toBe('full-access');
    await service.dispose();
  });

  it('aborts an active run', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    await service.prompt({ text: 'work', behavior: 'prompt' });
    expect(await service.abort()).toEqual({ aborted: true });
    expect(fake.session.abort).toHaveBeenCalledOnce();
    await service.dispose();
  });

  it('lets Stop terminate managed children even when the main agent is idle', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    const coordinator = (service as unknown as { subagents: { hasActiveRuns: (sessionId: string) => boolean; cancelParent: (sessionId: string) => Promise<void> } }).subagents;
    const active = vi.spyOn(coordinator, 'hasActiveRuns').mockReturnValue(true);
    const cancel = vi.spyOn(coordinator, 'cancelParent').mockResolvedValue();

    expect(await service.abort()).toEqual({ aborted: true });
    expect(cancel).toHaveBeenCalledWith('session-1');
    expect(fake.session.abort).not.toHaveBeenCalled();

    active.mockRestore();
    cancel.mockRestore();
    await service.dispose();
  });

  it('delivers opt-in child completion notifications to the model without cluttering the chat', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    const coordinator = (service as unknown as {
      subagents: { host: { notifyParent: (sessionId: string, mode: 'immediate', text: string, runIds: string[], workflowId?: string) => Promise<void> } };
    }).subagents;

    await coordinator.host.notifyParent('session-1', 'immediate', 'Child settled.', ['run-1'], 'workflow-1');

    expect(fake.session.sendCustomMessage).toHaveBeenCalledWith({
      customType: 'fate-subagent-notification',
      content: [{ type: 'text', text: 'Child settled.' }],
      display: false,
      details: { runIds: ['run-1'], workflowId: 'workflow-1' },
    }, { triggerTurn: true, deliverAs: 'nextTurn' });
    await service.dispose();
  });

  it('queues immediate child notifications as follow-ups while streaming and leaves next-turn notifications passive', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    const coordinator = (service as unknown as {
      subagents: { host: { notifyParent: (sessionId: string, mode: 'immediate' | 'next-turn', text: string, runIds: string[]) => Promise<void> } };
    }).subagents;
    fake.setStreaming(true);

    await coordinator.host.notifyParent('session-1', 'immediate', 'Wake after the active turn.', ['run-1']);
    await coordinator.host.notifyParent('session-1', 'next-turn', 'Attach to a future turn.', ['run-2']);

    expect(fake.session.sendCustomMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      customType: 'fate-subagent-notification', details: { runIds: ['run-1'] },
    }), { triggerTurn: true, deliverAs: 'followUp' });
    expect(fake.session.sendCustomMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      customType: 'fate-subagent-notification', details: { runIds: ['run-2'] },
    }), { triggerTurn: false, deliverAs: 'nextTurn' });
    await service.dispose();
  });

  it('reconstructs persisted tool calls and results when hydrating session history', async () => {
    const fake = fixture();
    fake.session.messages = [
      { role: 'user', content: [{ type: 'text', text: 'Inspect' }, { type: 'image', data: 'dXNlcg==', mimeType: 'image/jpeg' }], timestamp: 1 },
      {
        role: 'assistant', timestamp: 2, content: [
          { type: 'thinking', thinking: 'I should inspect the file' },
          { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'README.md' } },
        ],
      },
      { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', content: [{ type: 'text', text: '# Project' }, { type: 'image', data: 'dG9vbA==', mimeType: 'image/webp' }], isError: false, timestamp: 3 },
      { role: 'assistant', content: [{ type: 'text', text: '**Done**' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }], timestamp: 4 },
      { role: 'custom', customType: 'parallax', content: 'Parallax enabled', display: true, timestamp: 5 },
      { role: 'custom', customType: 'private-context', content: 'Hidden context', display: false, timestamp: 6 },
    ];
    const service = new PiRuntimeService(fake.adapter);
    const state = await service.openProject({ path: '/project', name: 'project', trusted: true });

    expect(state.tools).toEqual([expect.objectContaining({
      id: 'read-1', name: 'read', input: '{"path":"README.md"}', output: '# Project', status: 'succeeded',
      images: [{ data: 'dG9vbA==', mimeType: 'image/webp', alt: 'Generated image 1' }],
    })]);
    expect(state.messages.map((message) => message.text)).toEqual(['Inspect', '', '**Done**', 'Parallax enabled']);
    expect(state.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'assistant', 'system']);
    expect(state.messages[0]?.images).toEqual([{ data: 'dXNlcg==', mimeType: 'image/jpeg', alt: 'Attached image 1' }]);
    expect(state.messages[2]?.images).toEqual([{ data: 'aGVsbG8=', mimeType: 'image/png', alt: 'Generated image 1' }]);
    await service.dispose();
  });

  it('publishes Pi extension, prompt, and canonical skill commands for the composer', async () => {
    const fake = fixture();
    Object.assign(fake.session, {
      extensionRunner: {
        getRegisteredCommands: () => [{ invocationName: 'parallax', description: 'Control Parallax' }],
      },
      promptTemplates: [{ name: 'review', description: 'Review changes' }],
    });
    const getSkills = vi.fn(() => ({ skills: [{ name: 'vibesecurity', description: 'Defensive security review' }], diagnostics: [] }));
    Object.assign(fake.runtime, {
      services: { resourceLoader: { getSkills } },
    });
    const service = new PiRuntimeService(fake.adapter);
    const state = await service.openProject({ path: '/project', name: 'project', trusted: true });

    expect(state.commands).toEqual([
      { name: 'parallax', description: 'Control Parallax', source: 'extension' },
      { name: 'review', description: 'Review changes', source: 'prompt' },
      { name: 'skill:vibesecurity', description: 'Defensive security review', source: 'skill' },
    ]);
    await service.dispose();
  });

  it('adds confined nested project resources to the transport prompt', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'fate-runtime-resources-'));
    try {
      mkdirSync(path.join(directory, 'src', 'nested'), { recursive: true });
      writeFileSync(path.join(directory, 'src', 'main.ts'), 'main');
      writeFileSync(path.join(directory, 'src', 'nested', 'view.tsx'), 'view');
      const fake = fixture();
      const service = new PiRuntimeService(fake.adapter);
      await service.openProject({ path: directory, name: 'project', trusted: true });

      await service.prompt({ text: 'Review #src', behavior: 'prompt' });
      expect(fake.session.prompt).toHaveBeenCalledWith(
        expect.stringContaining('- src/nested/view.tsx'),
        expect.objectContaining({ preflightResult: expect.any(Function) }),
      );
      expect(fake.session.prompt.mock.calls[0]?.[0]).toContain('- src/main.ts');
      fake.settle();
      await service.dispose();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('promotes an inline skill before handing the prompt to Pi expansion', async () => {
    const fake = fixture();
    Object.assign(fake.runtime, {
      services: {
        resourceLoader: {
          getSkills: () => ({ skills: [{ name: 'vibesecurity', description: 'Defensive security review' }], diagnostics: [] }),
        },
      },
    });
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });

    await service.prompt({ text: 'Inspect this with /skill:vibesecurity carefully', behavior: 'prompt' });
    expect(fake.session.prompt).toHaveBeenCalledWith(
      '/skill:vibesecurity Inspect this with carefully',
      expect.objectContaining({ preflightResult: expect.any(Function) }),
    );
    fake.settle();
    await service.dispose();
  });

  it('loads every skill tagged in the same prompt before handing it to Pi', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'fate-runtime-skills-'));
    const firstPath = path.join(directory, 'first.md');
    const secondPath = path.join(directory, 'second.md');
    try {
      writeFileSync(firstPath, '---\nname: first\ndescription: First skill\n---\n\nFirst workflow.');
      writeFileSync(secondPath, '---\nname: second\ndescription: Second skill\n---\n\nSecond workflow.');
      const fake = fixture();
      const skills = [
        { name: 'first', description: 'First skill', filePath: firstPath, baseDir: directory },
        { name: 'second', description: 'Second skill', filePath: secondPath, baseDir: directory },
      ];
      Object.assign(fake.session.resourceLoader, { getSkills: () => ({ skills, diagnostics: [] }) });
      const service = new PiRuntimeService(fake.adapter);
      await service.openProject({ path: '/project', name: 'project', trusted: true });

      await service.prompt({ text: '/skill:first /skill:second Fix the issue', behavior: 'prompt' });
      const promptText = fake.session.prompt.mock.calls[0]?.[0] ?? '';
      expect(promptText).toContain(`<skill name="first" location="${firstPath}">`);
      expect(promptText).toContain(`<skill name="second" location="${secondPath}">`);
      expect(promptText).not.toContain('/skill:first');
      expect(promptText).not.toContain('/skill:second');
      expect(promptText).toMatch(/<\/skill>\n\nFix the issue$/u);
      expect(service.getState(false).objective).toBe('/skill:first /skill:second Fix the issue');
      fake.settle();
      await service.dispose();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('lists, searches, creates, and switches persistent sessions through the SDK owner', async () => {
    const fake = fixture();
    const saved = {
      id: 'saved', title: 'Saved work', firstMessage: 'Saved work', path: '/sessions/saved.jsonl',
      createdAt: '2025-01-01T00:00:00.000Z', modifiedAt: '2025-01-02T00:00:00.000Z', messageCount: 2, active: false,
    };
    const repository = {
      list: vi.fn(async (_cwd: string, activeId: string | null, query = '') => query ? [saved] : [{ ...saved, active: activeId === saved.id }]),
      resolve: vi.fn(async () => saved),
      delete: vi.fn(async () => undefined),
      branches: vi.fn(() => []),
    } as unknown as PiSessionRepository;
    const service = new PiRuntimeService(fake.adapter, repository);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    expect(await service.listSessions('saved')).toEqual([{ ...saved, attention: null }]);
    await service.newSession();
    expect((await fake.adapter.createRuntime('/project', {} as ModelRuntime)).newSession).toHaveBeenCalledOnce();
    await service.switchSession('saved');
    const runtime = await fake.adapter.createRuntime('/project', {} as ModelRuntime);
    expect(runtime.switchSession).toHaveBeenCalledWith('/sessions/saved.jsonl', { cwdOverride: '/project' });
    expect(repository.resolve).not.toHaveBeenCalled();
    await service.deleteSession('saved');
    expect(repository.delete).toHaveBeenCalledWith('/project', 'saved');
    await service.dispose();
  });

  it('does not block a session switch on a redundant project-wide session-list refresh', async () => {
    const fake = fixture();
    const saved = {
      id: 'saved', title: 'Saved work', firstMessage: 'Saved work', path: '/sessions/saved.jsonl',
      createdAt: '2025-01-01T00:00:00.000Z', modifiedAt: '2025-01-02T00:00:00.000Z', messageCount: 2, active: false,
    };
    const never = new Promise<never>(() => undefined);
    const repository = {
      list: vi.fn()
        .mockResolvedValueOnce([saved])
        .mockImplementation(() => never),
      resolve: vi.fn(() => never),
      branches: vi.fn(() => []),
    } as unknown as PiSessionRepository;
    const service = new PiRuntimeService(fake.adapter, repository);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    fake.runtime.switchSession.mockImplementationOnce(async () => {
      fake.session.sessionId = saved.id;
      fake.session.sessionFile = saved.path;
      await fake.runtime.setRebindSession.mock.calls[0]![0](fake.session);
      return { cancelled: false };
    });

    await expect(service.switchSession(saved.id)).resolves.toMatchObject({ sessionId: saved.id });
    expect(repository.resolve).not.toHaveBeenCalled();
    expect(repository.list).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it('preserves recent-session order while switching until the session receives a prompt', async () => {
    const fake = fixture();
    const saved = {
      id: 'saved', title: 'Saved work', firstMessage: 'Saved work', path: '/sessions/saved.jsonl',
      createdAt: '2025-01-01T00:00:00.000Z', modifiedAt: '2025-01-02T00:00:00.000Z', messageCount: 2, active: false,
    };
    const repository = {
      list: vi.fn(async (_cwd: string, activeId: string | null) => [{ ...saved, active: activeId === saved.id }]),
      resolve: vi.fn(async () => saved),
      delete: vi.fn(async () => undefined),
      branches: vi.fn(() => []),
    } as unknown as PiSessionRepository;
    const service = new PiRuntimeService(fake.adapter, repository);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    fake.runtime.switchSession.mockImplementationOnce(async () => {
      fake.session.sessionId = saved.id;
      fake.session.sessionFile = saved.path;
      await fake.runtime.setRebindSession.mock.calls[0]![0](fake.session);
      return { cancelled: false };
    });

    await service.switchSession(saved.id);
    expect(service.getState(false).sessions?.find((summary) => summary.id === saved.id)?.modifiedAt).toBe(saved.modifiedAt);

    await service.prompt({ text: 'Continue this work', behavior: 'prompt' });
    expect(service.getState(false).sessions?.find((summary) => summary.id === saved.id)?.modifiedAt).not.toBe(saved.modifiedAt);
    fake.settle();
    await service.dispose();
  });

  it('preserves the owning parent slot when a managed child outlives the main turn', async () => {
    const first = fixture();
    const second = fixture();
    second.session.sessionId = 'session-2';
    const createRuntime = vi.fn()
      .mockResolvedValueOnce(first.runtime as unknown as AgentSessionRuntime)
      .mockResolvedValueOnce(second.runtime as unknown as AgentSessionRuntime);
    const service = new PiRuntimeService({ ...first.adapter, createRuntime });
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    const coordinator = (service as unknown as { subagents: { hasActiveRuns: (sessionId: string) => boolean } }).subagents;
    const active = vi.spyOn(coordinator, 'hasActiveRuns').mockImplementation((sessionId) => sessionId === 'session-1');

    const state = await service.newSession();

    expect(state).toMatchObject({ sessionId: 'session-2', runningSessionCount: 1 });
    expect(first.runtime.newSession).not.toHaveBeenCalled();
    expect(first.runtime.dispose).not.toHaveBeenCalled();
    expect(state.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'session-1', attention: 'running', active: false }),
    ]));

    active.mockRestore();
    await service.dispose();
  });

  it('promotes exact live slots while other sessions keep running and isolates their extension state', async () => {
    const first = fixture();
    const second = fixture();
    const third = fixture();
    second.session.sessionId = 'session-2';
    second.session.sessionFile = '/sessions/two.jsonl';
    third.session.sessionId = 'session-3';
    third.session.sessionFile = '/sessions/three.jsonl';
    const createRuntime = vi.fn()
      .mockResolvedValueOnce(first.runtime as unknown as AgentSessionRuntime)
      .mockResolvedValueOnce(second.runtime as unknown as AgentSessionRuntime)
      .mockResolvedValueOnce(third.runtime as unknown as AgentSessionRuntime);
    const adapter: PiSdkAdapter = { ...first.adapter, createRuntime };
    const service = new PiRuntimeService(adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    await service.prompt({ text: 'long first task', behavior: 'prompt' });

    const secondState = await service.newSession();
    expect(secondState).toMatchObject({ sessionId: 'session-2', streaming: false, activeSessionRunning: false, runningSessionCount: 1 });
    expect(first.session.abort).not.toHaveBeenCalled();
    expect(secondState.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'session-1', attention: 'running', active: false }),
    ]));

    const promoted = await service.switchSession('session-1');
    expect(promoted).toMatchObject({ sessionId: 'session-1', streaming: true, activeSessionRunning: true });
    expect(second.runtime.dispose).toHaveBeenCalledOnce();
    expect(promoted.sessions?.find((session) => session.id === 'session-1')?.attention).toBeNull();

    await service.newSession();
    const firstUi = (first.session.bindExtensions.mock.calls as unknown as Array<[{ uiContext: { setStatus: (key: string, text?: string) => void } }]>)[0]![0].uiContext;
    firstUi.setStatus('background', 'must stay isolated');
    expect(service.getState(false).extensionUi?.statuses).toEqual([]);

    first.settle();
    await Promise.resolve();
    first.emitSession({ type: 'agent_settled' });
    await vi.waitFor(() => expect(first.runtime.dispose).toHaveBeenCalledOnce());
    expect(service.getState(false)).toMatchObject({ sessionId: 'session-3', activeSessionRunning: false, runningSessionCount: 0 });
    expect(service.getState(false).sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'session-1', attention: 'completed', active: false }),
    ]));
    await service.dispose();
  });

  it('marks a recovered background run completed after an earlier failure', async () => {
    const first = fixture();
    const second = fixture();
    second.session.sessionId = 'session-2';
    const adapter: PiSdkAdapter = {
      ...first.adapter,
      createRuntime: vi.fn()
        .mockResolvedValueOnce(first.runtime as unknown as AgentSessionRuntime)
        .mockResolvedValueOnce(second.runtime as unknown as AgentSessionRuntime),
    };
    const service = new PiRuntimeService(adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    await service.prompt({ text: 'recover this task', behavior: 'prompt' });
    await service.newSession();

    first.emitSession({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error' } });
    first.emitSession({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Recovered and finished.' }], stopReason: 'stop' } });
    first.settle();
    first.emitSession({ type: 'agent_settled' });

    await vi.waitFor(() => expect(first.runtime.dispose).toHaveBeenCalledOnce());
    expect(service.getState(false).sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'session-1', attention: 'completed', active: false }),
    ]));
    await service.dispose();
  });

  it('keeps the selected run intact when creating the next slot fails', async () => {
    const first = fixture();
    const candidate = fixture();
    candidate.session.sessionId = 'candidate';
    candidate.session.bindExtensions.mockRejectedValueOnce(new Error('candidate extension failed'));
    const adapter: PiSdkAdapter = {
      ...first.adapter,
      createRuntime: vi.fn()
        .mockResolvedValueOnce(first.runtime as unknown as AgentSessionRuntime)
        .mockResolvedValueOnce(candidate.runtime as unknown as AgentSessionRuntime),
    };
    const service = new PiRuntimeService(adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    await service.prompt({ text: 'keep running', behavior: 'prompt' });

    await expect(service.newSession()).rejects.toThrow('candidate extension failed');
    expect(service.getState(false)).toMatchObject({ sessionId: 'session-1', streaming: true, runningSessionCount: 1 });
    expect(first.runtime.dispose).not.toHaveBeenCalled();
    expect(first.session.abort).not.toHaveBeenCalled();
    expect(candidate.runtime.dispose).toHaveBeenCalledOnce();
    first.settle();
    await service.dispose();
  });

  it('disposes a settled background slot before a slow repository refresh and never resurrects acknowledged attention', async () => {
    const first = fixture();
    const second = fixture();
    const reopened = fixture();
    first.session.sessionFile = '/sessions/one.jsonl';
    second.session.sessionId = 'session-2';
    second.session.sessionFile = '/sessions/two.jsonl';
    reopened.session.sessionId = 'session-1';
    reopened.session.sessionFile = '/sessions/one.jsonl';
    const adapter: PiSdkAdapter = {
      ...first.adapter,
      createRuntime: vi.fn()
        .mockResolvedValueOnce(first.runtime as unknown as AgentSessionRuntime)
        .mockResolvedValueOnce(second.runtime as unknown as AgentSessionRuntime)
        .mockResolvedValueOnce(reopened.runtime as unknown as AgentSessionRuntime),
    };
    let markRefreshStarted: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
    let rejectRefresh: ((error: Error) => void) | undefined;
    const delayedRefresh = new Promise<never>((_resolve, reject) => { rejectRefresh = reject; });
    let listCalls = 0;
    const saved = {
      id: 'session-1', title: 'First', firstMessage: 'keep running', path: '/sessions/one.jsonl',
      createdAt: '2025-01-01T00:00:00.000Z', modifiedAt: '2025-01-01T00:00:01.000Z', messageCount: 2, active: false,
    };
    const repository = {
      invalidate: vi.fn(),
      list: vi.fn(() => {
        listCalls += 1;
        if (listCalls === 3) {
          markRefreshStarted?.();
          return delayedRefresh;
        }
        return Promise.resolve([]);
      }),
      resolve: vi.fn(async () => saved),
      branches: vi.fn(() => []),
    } as unknown as PiSessionRepository;
    const service = new PiRuntimeService(adapter, repository);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    await service.prompt({ text: 'keep running', behavior: 'prompt' });
    await service.newSession();
    await service.prompt({ text: 'second run', behavior: 'prompt' });

    first.emitSession({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error' } });
    first.settle();
    first.emitSession({ type: 'agent_settled' });
    await refreshStarted;
    expect(first.runtime.dispose).toHaveBeenCalledOnce();
    expect(service.getState(false).sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'session-1', attention: 'error' }),
    ]));

    await expect(service.switchSession('session-1')).resolves.toMatchObject({ sessionId: 'session-1' });
    rejectRefresh?.(new Error('stale repository failure'));
    await delayedRefresh.catch(() => undefined);
    await Promise.resolve();
    expect(service.getState(false).sessions?.find((session) => session.id === 'session-1')?.attention).toBeNull();
    second.settle();
    await service.dispose();
  });

  it('refuses a fifth live runtime without aborting or evicting four running sessions', async () => {
    const fakes = Array.from({ length: 5 }, () => fixture());
    fakes.forEach((fake, index) => { fake.session.sessionId = `session-${index + 1}`; });
    const createRuntime = vi.fn();
    for (const fake of fakes) createRuntime.mockResolvedValueOnce(fake.runtime as unknown as AgentSessionRuntime);
    const adapter: PiSdkAdapter = { ...fakes[0]!.adapter, createRuntime };
    const service = new PiRuntimeService(adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });

    for (let index = 0; index < 4; index += 1) {
      await service.prompt({ text: `task ${index}`, behavior: 'prompt' });
      if (index < 3) await service.newSession();
    }
    expect(service.getState(false).runningSessionCount).toBe(4);
    await expect(service.newSession()).rejects.toThrow('Up to 4 Pi sessions');
    expect(createRuntime).toHaveBeenCalledTimes(4);
    expect(fakes.slice(0, 4).every((fake) => fake.session.abort.mock.calls.length === 0)).toBe(true);
    await service.dispose();
  });

  it('clones through the current leaf rather than truncating at the latest user prompt', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    const state = await service.cloneSession();
    const runtime = await fake.adapter.createRuntime('/project', {} as ModelRuntime);
    expect(runtime.fork).toHaveBeenCalledWith('leaf-1', { position: 'at' });
    expect(state.sessionOperation).toBe(false);
    await service.dispose();
  });

  it('renames the active session and returns fork text for the composer', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    await service.renameSession('session-1', 'Focused work');
    expect(fake.session.setSessionName).toHaveBeenCalledWith('Focused work');

    const result = await service.forkSession('entry-1');
    expect(result.selectedText).toBe('original prompt');
    expect(result.state.sessionId).toBe('session-1');
    await service.dispose();
  });

  it('publishes Pi’s post-compaction estimate, then replaces it with measured usage', async () => {
    const fake = fixture();
    let usage: { tokens: number | null; contextWindow: number; percent: number | null } = {
      tokens: null,
      contextWindow: 1_000,
      percent: null,
    };
    Object.assign(fake.session, { getContextUsage: vi.fn(() => usage) });
    fake.session.compact.mockImplementationOnce(async () => {
      fake.emitSession({
        type: 'compaction_end',
        reason: 'manual',
        result: { estimatedTokensAfter: 240 },
        aborted: false,
        willRetry: false,
      });
    });
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });

    const compacted = await service.compact();
    expect(compacted.contextUsage).toEqual({
      tokens: 240,
      contextWindow: 1_000,
      percent: 24,
      estimated: true,
    });

    usage = { tokens: 310, contextWindow: 1_000, percent: 31 };
    expect(service.getState(false).contextUsage).toEqual(usage);
    await service.dispose();
  });

  it('keeps expected compact preconditions nonfatal and actionable', async () => {
    const fake = fixture();
    fake.session.compact.mockRejectedValueOnce(new Error('Nothing to compact (session too small)'));
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    await expect(service.compact()).rejects.toThrow('not enough conversation context');
    expect(service.getState()).toMatchObject({ status: 'ready', error: { code: 'INVALID_REQUEST', retryable: true } });
    await service.dispose();
  });

  it('prevents stale replacement callbacks from invalidating a newer project', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project-a', name: 'A', trusted: true });
    const oldRebind = fake.runtime.setRebindSession.mock.calls[0]?.[0] as ((session: unknown) => Promise<void>) | undefined;
    let finishReplacement: ((value: { cancelled: false }) => void) | undefined;
    fake.runtime.newSession.mockImplementationOnce(() => new Promise((resolve) => { finishReplacement = resolve; }));
    const replacement = service.newSession();
    await vi.waitFor(() => expect(service.getState().sessionOperation).toBe(true));

    await service.openProject({ path: '/project-b', name: 'B', trusted: true });
    const subscriptionsBeforeStaleCallback = fake.session.subscribe.mock.calls.length;
    await oldRebind?.(fake.session);
    expect(fake.session.subscribe).toHaveBeenCalledTimes(subscriptionsBeforeStaleCallback);
    finishReplacement?.({ cancelled: false });
    await expect(replacement).rejects.toThrow('superseded by a newer project');
    expect(service.getState().project?.path).toBe('/project-b');
    await service.dispose();
  });

  it('does not let a delayed old-runtime disposal or invalidation erase a newer project', async () => {
    const first = fixture();
    const successor = fixture();
    successor.session.sessionId = 'session-c';
    let releaseDispose: (() => void) | undefined;
    first.runtime.dispose.mockImplementationOnce(() => new Promise<undefined>((resolve) => { releaseDispose = () => resolve(undefined); }));
    const createRuntime = vi.fn()
      .mockResolvedValueOnce(first.runtime as unknown as AgentSessionRuntime)
      .mockResolvedValueOnce(successor.runtime as unknown as AgentSessionRuntime);
    const adapter: PiSdkAdapter = { ...first.adapter, createRuntime };
    const service = new PiRuntimeService(adapter);
    await service.openProject({ path: '/project-a', name: 'A', trusted: true });
    const oldInvalidate = first.runtime.setBeforeSessionInvalidate.mock.calls[0]?.[0] as (() => void) | undefined;
    const oldExtensionContext = (first.session.bindExtensions.mock.calls as unknown as Array<[{
      uiContext?: { notify: (message: string) => void };
      commandContextActions?: { newSession: (options?: unknown) => Promise<{ cancelled: boolean }> };
    }]>)[0]?.[0];
    const emitted: PiEvent[] = [];
    service.setEventSink((events) => emitted.push(...events));

    const supersededOpen = service.openProject({ path: '/project-b', name: 'B', trusted: true });
    await vi.waitFor(() => expect(first.runtime.dispose).toHaveBeenCalledOnce());
    const currentOpen = service.openProject({ path: '/project-c', name: 'C', trusted: true });
    await currentOpen;
    oldInvalidate?.();
    oldExtensionContext?.uiContext?.notify('stale extension output');
    const staleCommand = await oldExtensionContext?.commandContextActions?.newSession();
    expect(staleCommand).toEqual({ cancelled: true });
    releaseDispose?.();
    await supersededOpen;

    service.getHydrationState();
    expect(successor.runtime.newSession).not.toHaveBeenCalled();
    expect(emitted.some((event) => event.type === 'message.completed' && event.text.includes('stale extension output'))).toBe(false);
    expect(service.getState()).toMatchObject({ project: { path: '/project-c' }, sessionId: 'session-c', status: 'ready' });
    await service.dispose();
  });

  it('does not let delayed failed-replacement disposal overwrite a successor runtime', async () => {
    const first = fixture();
    const successor = fixture();
    successor.session.sessionId = 'successor';
    let releaseDispose: (() => void) | undefined;
    first.runtime.dispose.mockImplementationOnce(() => new Promise<undefined>((resolve) => { releaseDispose = () => resolve(undefined); }));
    const adapter: PiSdkAdapter = {
      ...first.adapter,
      createRuntime: vi.fn()
        .mockResolvedValueOnce(first.runtime as unknown as AgentSessionRuntime)
        .mockResolvedValueOnce(successor.runtime as unknown as AgentSessionRuntime),
    };
    const service = new PiRuntimeService(adapter);
    await service.openProject({ path: '/project-a', name: 'A', trusted: true });
    const invalidate = first.runtime.setBeforeSessionInvalidate.mock.calls[0]?.[0] as (() => void) | undefined;
    first.runtime.newSession.mockImplementationOnce(async () => { invalidate?.(); throw new Error('replacement failed'); });

    const replacement = service.newSession();
    await vi.waitFor(() => expect(first.runtime.dispose).toHaveBeenCalledOnce());
    await service.openProject({ path: '/project-c', name: 'C', trusted: true });
    releaseDispose?.();
    await expect(replacement).rejects.toThrow(/superseded/);

    expect(service.getState()).toMatchObject({ project: { path: '/project-c' }, sessionId: 'successor', status: 'ready' });
    await service.dispose();
  });

  it('tracks extension-triggered session replacements through the serialized ownership gate', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    const context = (fake.session.bindExtensions.mock.calls as unknown as Array<[{
      commandContextActions: { newSession: (options?: unknown) => Promise<{ cancelled: boolean }> };
    }]>)[0]![0];
    let finish: (() => void) | undefined;
    fake.runtime.newSession.mockImplementationOnce(() => new Promise<{ cancelled: false }>((resolve) => { finish = () => resolve({ cancelled: false }); }));

    const pending = context.commandContextActions.newSession();
    await vi.waitFor(() => expect(service.getState(false).sessionOperation).toBe(true));
    finish?.();
    await expect(pending).resolves.toEqual({ cancelled: false });
    expect(service.getState(false).sessionOperation).toBe(false);
    await service.dispose();
  });

  it('serializes replacements and keeps the bound runtime after a recoverable preflight failure', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    const runtime = await fake.adapter.createRuntime('/project', {} as ModelRuntime);
    let release: (() => void) | undefined;
    (runtime.newSession as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));

    const first = service.newSession();
    const second = service.newSession();
    await Promise.resolve();
    expect(runtime.newSession).toHaveBeenCalledTimes(1);
    release?.();
    await first;
    await second;
    expect(runtime.newSession).toHaveBeenCalledTimes(2);

    (runtime.newSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('replacement failed'));
    await expect(service.newSession()).rejects.toThrow('replacement failed');
    expect(service.getState()).toMatchObject({ status: 'ready', sessionId: 'session-1', sessionOperation: false });
    expect(runtime.dispose).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('gates clone when the adapter has not verified position-at support', async () => {
    const fake = fixture();
    fake.adapter.supportsClone = false;
    const service = new PiRuntimeService(fake.adapter);
    const state = await service.openProject({ path: '/project', name: 'project', trusted: true });
    expect(state.sessionCapabilities?.clone).toBe(false);
    await expect(service.cloneSession()).rejects.toThrow('not supported');
    await service.dispose();
  });

  it('rebinds normalized event subscriptions when Pi replaces the session', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    const runtime = await fake.adapter.createRuntime('/project', {} as ModelRuntime);
    // The runtime host callback is the contract Pi calls after new/switch/fork replacement.
    const callback = (runtime.setRebindSession as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ((session: unknown) => Promise<void>) | undefined;
    expect(callback).toBeTypeOf('function');
    await callback?.(fake.session);
    expect(fake.session.subscribe).toHaveBeenCalledTimes(2);
    await service.dispose();
  });

  it('coalesces concurrent rebinds so model hooks are installed and removed exactly once', async () => {
    const fake = fixture();
    const originalStreamFunction = fake.agent.streamFunction;
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    const callback = fake.runtime.setRebindSession.mock.calls[0]?.[0] as ((session: typeof fake.session) => Promise<void>) | undefined;
    let markBindingStarted: (() => void) | undefined;
    const bindingStarted = new Promise<void>((resolve) => { markBindingStarted = resolve; });
    let releaseBinding: (() => void) | undefined;
    fake.session.bindExtensions.mockImplementationOnce(() => {
      markBindingStarted?.();
      return new Promise<undefined>((resolve) => { releaseBinding = () => resolve(undefined); });
    });

    const first = callback?.(fake.session);
    const second = callback?.(fake.session);
    await bindingStarted;
    expect(fake.session.bindExtensions).toHaveBeenCalledTimes(2);
    releaseBinding?.();
    await Promise.all([first, second]);
    expect(fake.session.subscribe).toHaveBeenCalledTimes(2);
    expect(fake.agent.subscribe).toHaveBeenCalledTimes(2);

    await service.dispose();
    expect(fake.agent.streamFunction).toBe(originalStreamFunction);
  });

  it('synchronously detaches and ignores queued or late events from an old session generation', async () => {
    vi.useFakeTimers();
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    const emitted: Array<{ type: string; delta?: string }> = [];
    service.setEventSink((batch) => emitted.push(...batch));
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    vi.runAllTimers();
    emitted.length = 0;

    const subscriptionCalls = fake.session.subscribe.mock.calls as unknown as Array<[(event: unknown) => void]>;
    const oldListener = subscriptionCalls[0]![0];
    const oldUnsubscribe = fake.session.subscribe.mock.results[0]!.value as ReturnType<typeof vi.fn>;
    const runtime = await fake.adapter.createRuntime('/project', {} as ModelRuntime);
    const invalidate = (runtime.setBeforeSessionInvalidate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as () => void;
    const rebind = (runtime.setRebindSession as ReturnType<typeof vi.fn>).mock.calls[0]![0] as (session: unknown) => Promise<void>;

    const oldMessage = { role: 'assistant', content: [] };
    oldListener({ type: 'message_start', message: oldMessage });
    oldListener({ type: 'message_update', message: oldMessage, assistantMessageEvent: { type: 'text_delta', delta: 'stale queued' } });
    invalidate();
    expect(oldUnsubscribe).toHaveBeenCalledOnce();
    await rebind(fake.session);

    oldListener({ type: 'message_update', message: oldMessage, assistantMessageEvent: { type: 'text_delta', delta: 'stale late' } });
    const newListener = subscriptionCalls[1]![0];
    const newMessage = { role: 'assistant', content: [] };
    newListener({ type: 'message_start', message: newMessage });
    newListener({ type: 'message_update', message: newMessage, assistantMessageEvent: { type: 'text_delta', delta: 'current' } });
    vi.runAllTimers();

    expect(emitted.filter((event) => event.type === 'assistant.text').map((event) => event.delta)).toEqual(['current']);
    await service.dispose();
  });

  it('hydrates the complete persisted branch across compaction instead of only the model context', async () => {
    const fake = fixture();
    fake.session.messages = [{ role: 'assistant', content: [{ type: 'text', text: 'Compacted model context only' }], timestamp: 9 }];
    Object.assign(fake.session.sessionManager, {
      getBranch: () => [
        { type: 'message', id: 'u1', parentId: null, timestamp: '2025-01-01T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Original prompt' }], timestamp: 1 } },
        { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2025-01-01T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'read-old', name: 'read', arguments: { path: 'old.ts' } }], timestamp: 2 } },
        { type: 'message', id: 't1', parentId: 'a1', timestamp: '2025-01-01T00:00:02.000Z', message: { role: 'toolResult', toolCallId: 'read-old', toolName: 'read', content: [{ type: 'text', text: 'persisted output' }], timestamp: 3 } },
        { type: 'compaction', id: 'c1', parentId: 't1', timestamp: '2025-01-01T00:00:03.000Z', summary: 'summary', firstKeptEntryId: 'u1', tokensBefore: 100 },
        { type: 'message', id: 'a2', parentId: 'c1', timestamp: '2025-01-01T00:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'After compaction' }], timestamp: 4 } },
      ],
    });
    const service = new PiRuntimeService(fake.adapter);
    const state = await service.openProject({ path: '/project', name: 'project', trusted: true });

    expect(state.messages.map((message) => message.text)).toEqual(['Original prompt', '', 'Context compacted', 'After compaction']);
    expect(state.tools).toEqual([expect.objectContaining({ id: 'read-old', output: 'persisted output', status: 'succeeded' })]);
    await service.dispose();
  });

  it('enforces an aggregate hydration budget for pathological persisted history', async () => {
    const fake = fixture();
    Object.assign(fake.session.sessionManager, {
      getBranch: () => Array.from({ length: 200 }, (_value, index) => ({
        type: 'message', id: `m${index}`, parentId: index ? `m${index - 1}` : null,
        timestamp: new Date(index * 1_000).toISOString(),
        message: { role: index % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: 'x'.repeat(64_000) }], timestamp: index },
      })),
    });
    const service = new PiRuntimeService(fake.adapter);
    const state = await service.openProject({ path: '/project', name: 'project', trusted: true });

    expect(state.messages.length).toBeLessThan(200);
    expect(state.messages[0]).toMatchObject({ role: 'system', text: expect.stringContaining('earlier history entries') });
    expect(state.messages.reduce((total, message) => total + message.text.length + (message.reasoning?.length ?? 0), 0)).toBeLessThanOrEqual(8 * 1024 * 1024 + 500);
    await service.dispose();
  });

  it('preserves the true omission count when a capped branch also has a live tail', async () => {
    const fake = fixture();
    Object.assign(fake.session.sessionManager, {
      getBranch: () => Array.from({ length: 6_000 }, (_value, index) => ({
        type: 'message', id: `m${index}`, parentId: index ? `m${index - 1}` : null,
        timestamp: new Date(index * 1_000).toISOString(),
        message: { role: index % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `message ${index}` }], timestamp: index },
      })),
    });
    Object.assign(fake.session, {
      agent: { state: { streamingMessage: { role: 'assistant', content: [{ type: 'text', text: 'live tail' }], timestamp: 7_000 } } },
    });
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    await service.prompt({ text: 'continue', behavior: 'prompt' });
    const state = service.getHydrationState();

    expect(state.messages).toHaveLength(5_000);
    expect(state.messages[0]).toMatchObject({ role: 'system', text: expect.stringContaining('1,002 earlier history entries') });
    expect(state.messages.at(-1)?.text).toBe('live tail');
    fake.settle();
    await service.dispose();
  });

  it('caps hydrated timeline entities when each message carries reasoning and a tool call', async () => {
    const fake = fixture();
    Object.assign(fake.session.sessionManager, {
      getBranch: () => Array.from({ length: 2_500 }, (_value, index) => ({
        type: 'message', id: `rich-${index}`, parentId: index ? `rich-${index - 1}` : null,
        timestamp: new Date(index * 1_000).toISOString(),
        message: {
          role: 'assistant', timestamp: index,
          content: [
            { type: 'thinking', thinking: 'reason' },
            { type: 'text', text: `answer ${index}` },
            { type: 'toolCall', id: `tool-${index}`, name: 'read', arguments: { path: 'file.ts' } },
          ],
        },
      })),
    });
    const service = new PiRuntimeService(fake.adapter);
    const state = await service.openProject({ path: '/project', name: 'project', trusted: true });
    const entities = state.messages.length
      + state.messages.filter((message) => Boolean(message.reasoning)).length
      + (state.tools?.length ?? 0);

    expect(entities).toBeLessThanOrEqual(5_000);
    expect(state.messages[0]).toMatchObject({ role: 'system', historyOmitted: expect.any(Number) });
    await service.dispose();
  });

  it('reports extension-cancelled session replacement without claiming success', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    fake.runtime.newSession.mockResolvedValueOnce({ cancelled: true });

    await expect(service.newSession()).rejects.toThrow('cancelled by a Pi extension');
    expect(service.getState()).toMatchObject({ status: 'ready', sessionOperation: false });
    await service.dispose();
  });

  it('keeps rename and delete available when model authentication expires', async () => {
    const fake = fixture([]);
    const saved = {
      id: 'saved', title: 'Saved', firstMessage: 'Saved', path: '/sessions/saved.jsonl',
      createdAt: '2025-01-01T00:00:00.000Z', modifiedAt: '2025-01-02T00:00:00.000Z', messageCount: 1, active: false,
    };
    const repository = {
      list: vi.fn(async () => [saved]), resolve: vi.fn(async () => saved), delete: vi.fn(async () => undefined), branches: vi.fn(() => []),
    } as unknown as PiSessionRepository;
    const service = new PiRuntimeService(fake.adapter, repository);
    await service.openProject({ path: '/project', name: 'project', trusted: true });

    await expect(service.renameSession('session-1', 'Offline title')).resolves.toMatchObject({ status: 'auth-required' });
    expect(fake.session.setSessionName).toHaveBeenCalledWith('Offline title');
    await expect(service.deleteSession('saved')).resolves.toMatchObject({ status: 'auth-required' });
    expect(repository.delete).toHaveBeenCalledWith('/project', 'saved');
    await service.dispose();
  });

  it('bounds oversized extension errors before typed event dispatch', async () => {
    const fake = fixture();
    const events: PiEvent[] = [];
    const service = new PiRuntimeService(fake.adapter);
    service.setEventSink((batch) => events.push(...batch));
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    const context = (fake.session.bindExtensions.mock.calls as unknown as Array<[{ onError: (error: { error: string }) => void }]>)[0]?.[0];
    context?.onError({ error: 'x'.repeat(1_000_000) });
    service.getHydrationState();
    const notice = events.find((event) => event.type === 'message.completed' && event.role === 'system');
    expect(notice && notice.type === 'message.completed' ? notice.text.length : 0).toBeLessThan(65_000);
    await service.dispose();
  });

  it('includes authoritative Pi queue counts even when previews predate this runtime', async () => {
    const fake = fixture();
    fake.setQueue(['one'], ['two', 'three']);
    const service = new PiRuntimeService(fake.adapter);
    const state = await service.openProject({ path: '/project', name: 'project', trusted: true });
    expect(state.queue).toEqual({ steering: 1, followUp: 2, items: [] });
    await service.dispose();
  });

  it('flushes a monotonic event watermark for race-free renderer hydration', async () => {
    const fake = fixture();
    const emitted: Array<{ cursor: number | undefined }> = [];
    const service = new PiRuntimeService(fake.adapter);
    service.setEventSink((events) => emitted.push(...events.map((event) => ({ cursor: event.cursor }))));
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    const state = service.getHydrationState();

    expect(state.eventCursor).toBeGreaterThan(0);
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.every((event) => event.cursor !== undefined && event.cursor <= state.eventCursor!)).toBe(true);
    expect([...emitted.map((event) => event.cursor!)]).toEqual([...emitted.map((event) => event.cursor!)].sort((left, right) => left - right));
    await service.dispose();
  });

  it('initializes project-bound services before reporting missing authentication', async () => {
    const fake = fixture([]);
    const service = new PiRuntimeService(fake.adapter);
    const state = await service.openProject({ path: '/project', name: 'project', trusted: true });
    expect(state.status).toBe('auth-required');
    expect(state.sessionId).toBe('session-1');
    expect(state.error?.actionable).toContain('/login');
    expect(fake.adapter.createRuntime).toHaveBeenCalledOnce();
    expect(fake.session.bindExtensions).toHaveBeenCalledOnce();
    await service.dispose();
  });
});
