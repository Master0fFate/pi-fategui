import path from 'node:path';
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  Theme,
  type AgentSessionRuntime,
  type ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeToolsForPermission, PiRuntimeService, isCanonicalPathInside, selectUserExtensionPaths, type PiSdkAdapter } from './PiRuntimeService';
import type { PiEvent } from '../../shared/contracts/ipc';
import { PiSessionRepository } from './PiSessionRepository';
import type { SessionTitleGenerator } from './PiSessionTitleGenerator';
import { InMemorySessionPermissionStore } from './SessionPermissionStore';

const model = { provider: 'test', id: 'model', name: 'Test Model', reasoning: true, contextWindow: 1000, input: ['text', 'image'] as const };

function fixture(availableModels: typeof model[] = [model]) {
  let settleRun: (() => void) | undefined;
  let streaming = false;
  let activeTools = ['read', 'bash', 'edit', 'write', 'generate_image', 'imagegen'];
  let steeringMessages: string[] = [];
  let followUpMessages: string[] = [];
  const session = {
    sessionId: 'session-1', sessionFile: undefined, model, thinkingLevel: 'medium', messages: [] as unknown[],
    sessionManager: { getLeafId: vi.fn(() => 'leaf-1') },
    get isStreaming() { return streaming; },
    bindExtensions: vi.fn(async () => undefined),
    subscribe: vi.fn(() => vi.fn()),
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
    clearQueue: vi.fn(() => {
      const queued = { steering: [...steeringMessages], followUp: [...followUpMessages] };
      steeringMessages = [];
      followUpMessages = [];
      return queued;
    }),
    getSteeringMessages: vi.fn(() => [...steeringMessages]),
    getFollowUpMessages: vi.fn(() => [...followUpMessages]),
    abort: vi.fn(async () => { streaming = false; settleRun?.(); }),
    setModel: vi.fn(async () => undefined), setThinkingLevel: vi.fn(),
    getActiveToolNames: vi.fn(() => [...activeTools]),
    setActiveToolsByName: vi.fn((names: string[]) => { activeTools = [...names]; }),
    setSessionName: vi.fn(),
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
    getAvailable: vi.fn(async () => availableModels), getModel: vi.fn(() => model),
  };
  const adapter: PiSdkAdapter = {
    supportsClone: true,
    createModelRuntime: vi.fn(async () => modelRuntime as unknown as ModelRuntime),
    createRuntime: vi.fn(async () => runtime as unknown as AgentSessionRuntime),
  };
  return {
    adapter, modelRuntime, runtime, session,
    settle: () => settleRun?.(),
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

  it('generates a first-turn title in the background without delaying prompt acceptance', async () => {
    const fake = fixture();
    let name: string | undefined;
    const source = {
      list: vi.fn(async () => [{
        path: '/sessions/one.jsonl', id: 'session-1', cwd: '/project', ...(name === undefined ? {} : { name }),
        created: new Date('2026-01-01T00:00:00.000Z'), modified: new Date('2026-01-01T00:00:00.000Z'),
        messageCount: 0, firstMessage: '(no messages)', allMessagesText: '',
      }]),
      rename: vi.fn((_path: string, nextName: string) => { name = nextName; }),
    };
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
    expect(source.rename).not.toHaveBeenCalled();
    finishTitle?.('Repair Git workflow');
    await vi.waitFor(() => expect(source.rename).toHaveBeenCalledWith('/sessions/one.jsonl', 'Repair Git workflow'));
    expect(service.getState(false).sessions?.[0]?.title).toBe('Repair Git workflow');
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

  it('rejects settings, compaction, and new prompts that race an active operation', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    await service.prompt({ text: 'work', behavior: 'prompt' });

    await expect(service.setModel('test', 'model')).rejects.toThrow('active Pi operation');
    expect(() => service.setThinkingLevel('high')).toThrow('active Pi operation');
    await expect(service.compact()).rejects.toThrow('active Pi operation');
    fake.settle();
    await Promise.resolve();

    const runtime = await fake.adapter.createRuntime('/project', {} as ModelRuntime);
    let finishReplacement: (() => void) | undefined;
    (runtime.newSession as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<void>((resolve) => { finishReplacement = resolve; }));
    const replacement = service.newSession();
    await vi.waitFor(() => expect(service.getState().sessionOperation).toBe(true));
    expect(() => service.prompt({ text: 'too soon', behavior: 'prompt' })).toThrow('session change');
    finishReplacement?.();
    await replacement;
    await service.dispose();
  });

  it('applies saved model and thinking defaults before a new session becomes ready', async () => {
    const alternate = { ...model, id: 'fast', name: 'Fast Model' };
    const fake = fixture([model, alternate]);
    fake.modelRuntime.getModel.mockReturnValue(alternate);
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    fake.session.setThinkingLevel.mockClear();
    fake.session.setModel.mockImplementationOnce(async () => {
      expect(service.getState().sessionOperation).toBe(true);
    });

    const state = await service.newSession({ thinkingLevel: 'high', defaultModel: 'test/fast' });
    expect(fake.session.setThinkingLevel).toHaveBeenCalledWith('high');
    expect(fake.session.setModel).toHaveBeenCalledWith(alternate);
    expect(fake.session.setModel.mock.invocationCallOrder[0]).toBeLessThan(fake.session.setThinkingLevel.mock.invocationCallOrder[0]!);
    expect(state.sessionOperation).toBe(false);
    await service.dispose();
  });

  it('switches between read-only, project edit, and explicit full-access tool sets', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    const initial = await service.openProject({ path: '/project', name: 'project', trusted: true });

    expect(initial.permissionLevel).toBe('edit');
    expect(fake.session.setActiveToolsByName).toHaveBeenLastCalledWith(['read', 'edit', 'write', 'generate_image', 'imagegen']);

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

  it('restores host-owned permissions per session and defaults unseen sessions to Edit files', async () => {
    const fake = fixture();
    const permissions = new InMemorySessionPermissionStore();
    await permissions.set('/project', 'session-1', 'full-access');
    await permissions.set('/project', 'session-2', 'read-only');
    const service = new PiRuntimeService(fake.adapter, undefined, permissions);

    const initial = await service.openProject({ path: '/project', name: 'project', trusted: true });
    expect(initial.permissionLevel).toBe('full-access');
    expect(fake.adapter.createRuntime).toHaveBeenCalledWith('/project', fake.modelRuntime, true);

    const rebind = fake.runtime.setRebindSession.mock.calls[0]?.[0] as ((session: typeof fake.session) => Promise<void>) | undefined;
    const secondSession = { ...fake.session, sessionId: 'session-2' };
    fake.runtime.session = secondSession;
    await rebind?.(secondSession);
    expect(service.getState(false).permissionLevel).toBe('read-only');

    const newSession = { ...fake.session, sessionId: 'session-new' };
    fake.runtime.session = newSession;
    await rebind?.(newSession);
    expect(service.getState(false).permissionLevel).toBe('edit');

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
    expect(service.getState().permissionLevel).toBe('edit');
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
    expect(await service.listSessions('saved')).toEqual([saved]);
    await service.newSession();
    expect((await fake.adapter.createRuntime('/project', {} as ModelRuntime)).newSession).toHaveBeenCalledOnce();
    await service.switchSession('saved');
    const runtime = await fake.adapter.createRuntime('/project', {} as ModelRuntime);
    expect(runtime.switchSession).toHaveBeenCalledWith('/sessions/saved.jsonl', { cwdOverride: '/project' });
    expect(repository.resolve).toHaveBeenCalledWith('/project', 'saved');
    await service.deleteSession('saved');
    expect(repository.delete).toHaveBeenCalledWith('/project', 'saved');
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
