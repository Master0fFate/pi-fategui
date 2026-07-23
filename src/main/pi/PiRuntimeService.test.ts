import type { AgentSessionRuntime, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { PiRuntimeService, type PiSdkAdapter } from './PiRuntimeService';

const model = { provider: 'test', id: 'model', name: 'Test Model', reasoning: true, contextWindow: 1000 };

function fixture(availableModels: typeof model[] = [model]) {
  let settleRun: (() => void) | undefined;
  let streaming = false;
  const session = {
    sessionId: 'session-1', sessionFile: undefined, model, thinkingLevel: 'medium', messages: [],
    get isStreaming() { return streaming; },
    bindExtensions: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
    prompt: vi.fn((_text: string, options: { preflightResult: (accepted: boolean) => void }) => {
      streaming = true;
      options.preflightResult(true);
      return new Promise<void>((resolve) => { settleRun = () => { streaming = false; resolve(); }; });
    }),
    steer: vi.fn(async () => undefined), followUp: vi.fn(async () => undefined),
    abort: vi.fn(async () => { streaming = false; settleRun?.(); }),
    setModel: vi.fn(async () => undefined), setThinkingLevel: vi.fn(),
  };
  const runtime = {
    session, diagnostics: [], setRebindSession: vi.fn(), newSession: vi.fn(), dispose: vi.fn(async () => undefined),
  };
  const modelRuntime = {
    getAvailable: vi.fn(async () => availableModels), getModel: vi.fn(() => model),
  };
  const adapter: PiSdkAdapter = {
    createModelRuntime: vi.fn(async () => modelRuntime as unknown as ModelRuntime),
    createRuntime: vi.fn(async () => runtime as unknown as AgentSessionRuntime),
  };
  return { adapter, session, settle: () => settleRun?.() };
}

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

  it('aborts an active run', async () => {
    const fake = fixture();
    const service = new PiRuntimeService(fake.adapter);
    await service.openProject({ path: '/project', name: 'project', trusted: true });
    await service.prompt({ text: 'work', behavior: 'prompt' });
    expect(await service.abort()).toEqual({ aborted: true });
    expect(fake.session.abort).toHaveBeenCalledOnce();
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
