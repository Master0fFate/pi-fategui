import type { AgentSessionRuntime, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiRuntimeService, type PiSdkAdapter } from './PiRuntimeService';
import type { PiSessionRepository } from './PiSessionRepository';

const model = { provider: 'test', id: 'model', name: 'Test Model', reasoning: true, contextWindow: 1000, input: ['text', 'image'] as const };

function fixture(availableModels: typeof model[] = [model]) {
  let settleRun: (() => void) | undefined;
  let streaming = false;
  const session = {
    sessionId: 'session-1', sessionFile: undefined, model, thinkingLevel: 'medium', messages: [],
    sessionManager: { getLeafId: vi.fn(() => 'leaf-1') },
    get isStreaming() { return streaming; },
    bindExtensions: vi.fn(async () => undefined),
    subscribe: vi.fn(() => vi.fn()),
    prompt: vi.fn((_text: string, options: { preflightResult: (accepted: boolean) => void; streamingBehavior?: 'steer' | 'followUp' }) => {
      options.preflightResult(true);
      if (options.streamingBehavior) return Promise.resolve();
      streaming = true;
      return new Promise<void>((resolve) => { settleRun = () => { streaming = false; resolve(); }; });
    }),
    steer: vi.fn(async () => undefined), followUp: vi.fn(async () => undefined),
    abort: vi.fn(async () => { streaming = false; settleRun?.(); }),
    setModel: vi.fn(async () => undefined), setThinkingLevel: vi.fn(),
  };
  const runtime = {
    session, diagnostics: [], setRebindSession: vi.fn(), setBeforeSessionInvalidate: vi.fn(),
    newSession: vi.fn(async () => ({ cancelled: false })),
    switchSession: vi.fn(async () => ({ cancelled: false })),
    fork: vi.fn(async () => ({ cancelled: false })),
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
  return { adapter, session, settle: () => settleRun?.() };
}

afterEach(() => vi.useRealTimers());

describe('PiRuntimeService', () => {
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

  it('passes validated image attachments only to an image-capable Pi model', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    const state = await service.openProject({ path: '/project', name: 'project', trusted: true });
    expect(state.model?.supportsImages).toBe(true);
    await service.prompt({
      text: 'inspect', behavior: 'prompt',
      images: [{ name: 'screen.png', mimeType: 'image/png', data: 'aGVsbG8=' }],
    });
    expect(fake.session.prompt).toHaveBeenCalledWith('inspect', expect.objectContaining({
      images: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
    }));
    fake.settle();
    await service.dispose();
  });

  it('queues through prompt preflight so acceptance reflects the real SDK result', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    await service.prompt({ text: 'work', behavior: 'prompt' });
    const acceptance = await service.prompt({ text: 'change direction', behavior: 'steer' });
    expect(acceptance.accepted).toBe(true);
    expect(fake.session.prompt).toHaveBeenLastCalledWith('change direction', expect.objectContaining({ streamingBehavior: 'steer' }));
    expect(fake.session.steer).not.toHaveBeenCalled();
    fake.settle();
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

  it('lists, searches, creates, and switches persistent sessions through the SDK owner', async () => {
    const fake = fixture();
    const saved = {
      id: 'saved', title: 'Saved work', firstMessage: 'Saved work', path: '/sessions/saved.jsonl',
      createdAt: '2025-01-01T00:00:00.000Z', modifiedAt: '2025-01-02T00:00:00.000Z', messageCount: 2, active: false,
    };
    const repository = {
      list: vi.fn(async (_cwd: string, activeId: string | null, query = '') => query ? [saved] : [{ ...saved, active: activeId === saved.id }]),
      resolve: vi.fn(async () => saved),
      branches: vi.fn(() => []),
    } as unknown as PiSessionRepository;
    const service = new PiRuntimeService(fake.adapter, repository);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    expect(await service.listSessions('saved')).toEqual([saved]);
    await service.newSession();
    expect((await fake.adapter.createRuntime('/project', {} as ModelRuntime)).newSession).toHaveBeenCalledOnce();
    await service.switchSession('saved');
    const runtime = await fake.adapter.createRuntime('/project', {} as ModelRuntime);
    expect(runtime.switchSession).toHaveBeenCalledWith('/sessions/saved.jsonl');
    expect(repository.resolve).toHaveBeenCalledWith('/project', 'saved');
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

  it('serializes replacement operations and reports a failed replacement as an error', async () => {
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
    expect(service.getState()).toMatchObject({ status: 'error', sessionOperation: false });
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
