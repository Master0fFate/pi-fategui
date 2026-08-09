import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntime, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { PiEvent, ProjectState } from '../../shared/contracts/ipc';
import { defaultImageGenerationSettings } from '../../shared/imageGeneration';
import { InMemorySessionPermissionStore } from './SessionPermissionStore';
import { InMemoryGoalMaxRepository } from './goalmaxxing/GoalMaxRepository';
import { MultiProjectPiRuntime, backgroundAttentionUpdate } from './MultiProjectPiRuntime';
import type { PiSdkAdapter } from './PiRuntimeService';

const started = { type: 'run.started', runId: 'run-1', timestamp: 1 } satisfies PiEvent;
const completed = { type: 'run.completed', runId: 'run-1', aborted: false, timestamp: 2 } satisfies PiEvent;
const aborted = { type: 'run.completed', runId: 'run-1', aborted: true, timestamp: 2 } satisfies PiEvent;
const failed = {
  type: 'error',
  timestamp: 2,
  error: { code: 'PI_RUNTIME_ERROR', message: 'failed', retryable: true },
} satisfies PiEvent;

describe('backgroundAttentionUpdate', () => {
  it('tracks running and successful completion for a globally background selected session', () => {
    expect(backgroundAttentionUpdate([started])).toBe('running');
    expect(backgroundAttentionUpdate([completed])).toBe('completed');
  });

  it('uses chronological event order and clears attention for an aborted run', () => {
    expect(backgroundAttentionUpdate([completed, failed])).toBe('error');
    expect(backgroundAttentionUpdate([completed, started])).toBe('running');
    expect(backgroundAttentionUpdate([failed, started, completed])).toBe('completed');
    expect(backgroundAttentionUpdate([aborted])).toBeNull();
    expect(backgroundAttentionUpdate([])).toBeUndefined();
  });
});

const model = { provider: 'test', id: 'model', name: 'Test Model', reasoning: true, contextWindow: 1000, input: ['text', 'image'] as const };

// A complete-enough fake AgentSessionRuntime so PiRuntimeService.openProject
// reaches the 'ready' status (mirrors the working fixture in
// PiRuntimeService.test.ts). One runtime is created per project.
function makeFakeRuntime(): AgentSessionRuntime {
  const session = {
    sessionId: 'session-1', sessionFile: undefined as string | undefined, model, thinkingLevel: 'medium', messages: [] as unknown[],
    agent: { state: { model, thinkingLevel: 'medium', messages: [], tools: [] }, subscribe: vi.fn(() => () => undefined), streamFunction: vi.fn() },
    sessionManager: { getLeafId: vi.fn(() => 'leaf-1'), getBranch: vi.fn(() => []), getSessionName: vi.fn(() => undefined), appendSessionInfo: vi.fn(), appendCustomEntry: vi.fn() },
    resourceLoader: { getSkills: () => ({ skills: [], diagnostics: [] }) },
    get isStreaming() { return false; },
    bindExtensions: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
    prompt: vi.fn(async () => undefined), steer: vi.fn(async () => undefined), followUp: vi.fn(async () => undefined), sendCustomMessage: vi.fn(async () => undefined),
    clearQueue: vi.fn(() => ({ steering: [], followUp: [] })), getSteeringMessages: vi.fn(() => []), getFollowUpMessages: vi.fn(() => []),
    getSessionStats: vi.fn(() => ({ sessionFile: undefined, sessionId: 'session-1', userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 })),
    abort: vi.fn(async () => undefined), setModel: vi.fn(async () => undefined), setThinkingLevel: vi.fn(() => undefined),
    getActiveToolNames: vi.fn(() => []), setActiveToolsByName: vi.fn(() => undefined), setSessionName: vi.fn(() => undefined),
    getUserMessagesForForking: vi.fn(() => []), navigateTree: vi.fn(async () => ({ cancelled: false })), compact: vi.fn(async () => undefined),
  };
  return {
    session, diagnostics: [], setRebindSession: vi.fn(), setBeforeSessionInvalidate: vi.fn(),
    newSession: vi.fn(async () => ({ cancelled: false })),
    switchSession: vi.fn(async () => ({ cancelled: false })),
    fork: vi.fn(async () => ({ cancelled: false })),
    importFromJsonl: vi.fn(async () => ({ cancelled: false })),
    dispose: vi.fn(async () => undefined),
  } as unknown as AgentSessionRuntime;
}

function makeMulti() {
  const created = vi.fn();
  const modelRuntime = { getAvailable: vi.fn(async () => [model]), getModel: vi.fn(() => model) };
  const adapter: PiSdkAdapter = {
    supportsClone: true,
    createModelRuntime: vi.fn(async () => modelRuntime as unknown as ModelRuntime),
    createRuntime: vi.fn(async () => { created(); return makeFakeRuntime(); }),
  };
  const multi = new MultiProjectPiRuntime({
    adapter,
    sessionPermissions: new InMemorySessionPermissionStore(),
    getImageGenerationSettings: () => defaultImageGenerationSettings,
    createGoalPersistence: () => new InMemoryGoalMaxRepository(),
    browserIntegration: null,
    defaults: async () => ({ thinkingLevel: 'medium', defaultModel: null }),
  });
  return { multi, created };
}

describe('MultiProjectPiRuntime multi-folder', () => {
  it('keeps folder A alive after opening folder B and re-focuses A as live', async () => {
    const { multi } = makeMulti();
    const a: ProjectState = { path: '/proj-A', name: 'A', trusted: true };
    const b: ProjectState = { path: '/proj-B', name: 'B', trusted: true };

    await multi.openProject(a);
    await multi.openProject(b);

    // A must still be live in the background after B opened.
    expect(multi.focusedProjectPath).toBe('/proj-B');

    // Re-focusing A reuses its live runtime and returns a ready (not
    // disconnected) state.
    const refocused = await multi.focusProject(a);
    expect(refocused.status).not.toBe('disconnected');
    expect(multi.focusedProjectPath).toBe('/proj-A');
    await multi.dispose();
  });

  it('re-opens a folder with a live runtime via the fast path (no re-spawn, no preview flash)', async () => {
    const { multi, created } = makeMulti();
    const a: ProjectState = { path: '/proj-A', name: 'A', trusted: true };
    const b: ProjectState = { path: '/proj-B', name: 'B', trusted: true };

    await multi.openProject(a);
    await multi.openProject(b);
    expect(created).toHaveBeenCalledTimes(2);

    // Re-open A: its runtime is already live, so this must re-focus it without
    // spawning again and without returning a disconnected/empty preview.
    const reopened = await multi.openProject(a);
    expect(created).toHaveBeenCalledTimes(2);
    expect(reopened.status).not.toBe('disconnected');
    expect(multi.focusedProjectPath).toBe('/proj-A');
    await multi.dispose();
  });

  it('focuses a folder with no live runtime as a cheap preview without spawning an agent (lazy, titles-only)', async () => {
    const { multi, created } = makeMulti();
    const a: ProjectState = { path: '/proj-A', name: 'A', trusted: true };
    const c: ProjectState = { path: '/proj-C', name: 'C', trusted: true };

    // Open A so a runtime exists and is focused.
    await multi.openProject(a);
    expect(created).toHaveBeenCalledTimes(1);

    // C has never been opened (no live runtime). Focusing it must NOT spawn an
    // agent — it shows a lightweight preview so the user can browse session
    // titles. The agent spawns lazily only when a session is opened.
    const focused = await multi.focusProject(c);
    expect(created).toHaveBeenCalledTimes(1);
    expect(focused.project?.path).toBe('/proj-C');
    expect(focused.status).toBe('disconnected');
    expect(multi.focusedProjectPath).toBe('/proj-C');
    await multi.dispose();
  });
});
