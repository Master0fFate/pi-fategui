import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { PiSessionTitleGenerator, sanitizeGeneratedSessionTitle } from './PiSessionTitleGenerator';

const model = { provider: 'zai', id: 'glm-4.7', name: 'GLM-4.7', reasoning: true, contextWindow: 128_000, input: ['text'] as const };

function sessionFixture() {
  const agent = { state: { model, thinkingLevel: 'medium', messages: [], tools: [] }, streamFunction: vi.fn(), subscribe: vi.fn(() => () => undefined) };
  return { sessionId: 'session-1', model, thinkingLevel: 'medium', messages: [], agent } as unknown as AgentSession;
}

describe('sanitizeGeneratedSessionTitle', () => {
  it('normalizes model output into a bounded single-line sidebar title', () => {
    expect(sanitizeGeneratedSessionTitle('  "Fix Git worktree workflow"\nextra text  ')).toBe('Fix Git worktree workflow');
    expect(sanitizeGeneratedSessionTitle('')).toBe('New session');
    expect([...sanitizeGeneratedSessionTitle('🚀'.repeat(80))]).toHaveLength(50);
    expect(sanitizeGeneratedSessionTitle('🚀'.repeat(80)).endsWith('...')).toBe(true);
  });
});

describe('PiSessionTitleGenerator.generate', () => {
  afterEach(() => vi.restoreAllMocks());

  it('omits the reasoning option (adapter thinking-off signal) and leaves room for forced thinking so GLM still emits a title', async () => {
    // GLM-style failure: thinking stays on, burns tokens before the title.
    const completeSimple = vi.fn(async (_model: unknown, _context: unknown, _options: unknown) => ({
      stopReason: 'length',
      content: [
        { type: 'thinking', thinking: 'The user wants a sidebar title...' },
        { type: 'text', text: '"Fix session title generation"' },
      ],
    }));
    const modelRuntime = { completeSimple } as unknown as ModelRuntime;

    await expect(new PiSessionTitleGenerator().generate('fix the session title bug', modelRuntime, sessionFixture())).resolves.toBe('Fix session title generation');

    expect(completeSimple).toHaveBeenCalledWith(
      model,
      expect.objectContaining({ systemPrompt: expect.stringContaining('sidebar title') }),
      expect.objectContaining({ maxTokens: 512 }),
    );
    const options = completeSimple.mock.calls[0]?.[2];
    expect(options).not.toHaveProperty('reasoning');
  });

  it('returns null instead of a hardcoded name when a length stop cuts all text (GLM thinking-only response)', async () => {
    const completeSimple = vi.fn(async () => ({
      stopReason: 'length',
      content: [{ type: 'thinking', thinking: 'Consumed the entire budget before writing the title.' }],
    }));
    const modelRuntime = { completeSimple } as unknown as ModelRuntime;

    await expect(new PiSessionTitleGenerator().generate('anything', modelRuntime, sessionFixture())).resolves.toBeNull();
  });

  it('returns null on error or abort stops so the sidebar falls back to the first message', async () => {
    for (const stopReason of ['error', 'aborted'] as const) {
      const completeSimple = vi.fn(async () => ({ stopReason, content: [{ type: 'text', text: 'ignored' }] }));
      const modelRuntime = { completeSimple } as unknown as ModelRuntime;
      await expect(new PiSessionTitleGenerator().generate('anything', modelRuntime, sessionFixture())).resolves.toBeNull();
    }
  });
});
