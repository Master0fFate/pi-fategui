import { describe, expect, it } from 'vitest';
import { MAX_SUBAGENT_IMAGE_CHARACTERS, subagentRunSchema, type SubagentRun } from './contracts/ipc';
import {
  MAX_SUBAGENT_ACTIVITY,
  MAX_SUBAGENT_TRANSCRIPT_CHARACTERS,
  applySubagentChildEvent,
  boundSubagentRun,
  boundSubagentRuns,
} from './subagents';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function runWith(messages: SubagentRun['messages']): SubagentRun {
  return {
    id: 'subagent-test',
    parentSessionId: 'parent-test',
    parentToolCallId: 'tool-test',
    task: 'Inspect bounded transcript behavior',
    role: 'scout',
    agentName: 'scout',
    agentSource: 'direct',
    permissionLevel: 'read-only',
    enabledTools: ['read', 'grep'],
    skills: [], skillMode: 'all', preloadedSkills: [],
    status: 'completed',
    model: {
      provider: 'test', id: 'model', name: 'Test Model', reasoning: true,
      contextWindow: 100_000, supportsImages: true,
    },
    routingModels: [{ provider: 'test', id: 'model', name: 'Test Model', reasoning: true, contextWindow: 100_000, supportsImages: true }],
    thinkingLevel: 'medium',
    executionMode: 'managed',
    controlCount: 0, attempt: 1, maxAttempts: 1,
    mailbox: { state: 'disabled', ttlMs: 0, followUpCount: 0 }, notification: 'never', dependsOn: [],
    createdAt: 1,
    updatedAt: 2,
    endedAt: 2,
    messages,
    tools: [],
    omittedActivity: 0,
    transcriptTruncated: false,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };
}

describe('subagent transcript bounds', () => {
  it('retains the newest activity while enforcing exact item and text budgets', () => {
    const messages = Array.from({ length: MAX_SUBAGENT_ACTIVITY + 10 }, (_, index) => ({
      id: `message-${index}`,
      role: 'assistant' as const,
      text: `${String(index).padStart(3, '0')}:${'x'.repeat(31_995)}`,
      timestamp: index,
      timelinePosition: index,
    }));

    const bounded = boundSubagentRun(runWith(messages));
    const characters = bounded.messages.reduce(
      (total, message) => total + message.text.length + (message.reasoning?.length ?? 0),
      0,
    );

    expect(bounded.messages).toHaveLength(MAX_SUBAGENT_ACTIVITY);
    expect(bounded.messages[0]?.id).toBe('message-10');
    expect(bounded.messages.at(-1)?.id).toBe(`message-${MAX_SUBAGENT_ACTIVITY + 9}`);
    expect(bounded.omittedActivity).toBe(10);
    expect(characters).toBeLessThanOrEqual(MAX_SUBAGENT_TRANSCRIPT_CHARACTERS);
    expect(bounded.transcriptTruncated).toBe(true);
    expect(() => subagentRunSchema.parse(bounded)).not.toThrow();
  });

  it('keeps a near-limit child event bounded without a second pass', () => {
    const messages = Array.from({ length: MAX_SUBAGENT_ACTIVITY + 10 }, (_, index) => ({
      id: `message-${index}`,
      role: 'assistant' as const,
      text: `${String(index).padStart(3, '0')}:${'x'.repeat(31_995)}`,
      timestamp: index,
      timelinePosition: index,
    }));
    const bounded = boundSubagentRun(runWith(messages));
    const updated = applySubagentChildEvent(bounded, {
      type: 'assistant.text', messageId: `message-${MAX_SUBAGENT_ACTIVITY + 9}`,
      delta: 'latest delta', timestamp: MAX_SUBAGENT_ACTIVITY + 10,
    });

    expect(updated.messages.at(-1)?.text).toMatch(/latest delta$/u);
    expect(boundSubagentRun(updated)).toEqual(updated);
  });

  it('keeps only newest images that fit the parent session budget', () => {
    const payload = 'a'.repeat(4_100_000);
    const withImage = (id: string, updatedAt: number) => ({
      ...runWith([{
        id: `message-${id}`, role: 'assistant' as const, text: '',
        images: [{ data: payload, mimeType: 'image/png' as const }], timestamp: updatedAt,
      }]),
      id,
      updatedAt,
    });
    const [older, newer] = boundSubagentRuns([withImage('older', 2), withImage('newer', 3)]);

    expect(newer?.messages[0]?.images).toHaveLength(1);
    expect(older?.messages[0]).toMatchObject({ text: expect.stringContaining('Image omitted') });
    expect(older?.messages[0]?.images).toBeUndefined();
    expect(older?.transcriptTruncated).toBe(true);
    expect(() => subagentRunSchema.parse(older)).not.toThrow();
    expect(() => subagentRunSchema.parse(newer)).not.toThrow();
  });

  it('preserves unchanged activity references without mutating the input', () => {
    const message = {
      id: 'message', role: 'assistant' as const, text: 'unchanged', reasoning: 'also unchanged', timestamp: 1,
    };
    const tool = {
      id: 'tool', name: 'read', input: 'input', output: 'output', outputTruncated: false,
      status: 'succeeded' as const, startedAt: 2, updatedAt: 3,
    };
    const input = { ...runWith([message]), tools: [tool] };
    const snapshot = structuredClone(input);

    const bounded = boundSubagentRun(input);

    expect(bounded).toEqual(snapshot);
    expect(input).toEqual(snapshot);
    expect(bounded.messages).toBe(input.messages);
    expect(bounded.tools).toBe(input.tools);
    expect(bounded.messages[0]).toBe(message);
    expect(bounded.tools[0]).toBe(tool);
  });

  it('copies only changed activity when a field is truncated', () => {
    const unchanged = { id: 'unchanged', role: 'assistant' as const, text: 'short', timestamp: 1 };
    const oversized = { id: 'oversized', role: 'assistant' as const, text: 'x'.repeat(32_001), timestamp: 2 };
    const input = runWith([unchanged, oversized]);
    const snapshot = structuredClone(input);

    const bounded = boundSubagentRun(input);

    expect(input).toEqual(snapshot);
    expect(bounded.messages).not.toBe(input.messages);
    expect(bounded.messages[0]).toBe(unchanged);
    expect(bounded.messages[1]).not.toBe(oversized);
    expect(bounded.messages[1]?.text).toHaveLength(32_000);
  });

  it('bounds fields and images and applies child updates from deeply frozen input', () => {
    const oversizedImage = 'a'.repeat(MAX_SUBAGENT_IMAGE_CHARACTERS + 1);
    const input = deepFreeze(runWith([{
      id: 'streaming', role: 'assistant', text: 'before', timestamp: 1, timelinePosition: 1,
    }, {
      id: 'oversized', role: 'assistant', text: 'x'.repeat(32_001), timestamp: 2, timelinePosition: 2,
      images: [{ data: oversizedImage, mimeType: 'image/png' }],
    }]));
    const snapshot = structuredClone(input);

    const bounded = boundSubagentRun(input);
    const updated = applySubagentChildEvent(input, {
      type: 'assistant.text', messageId: 'streaming', delta: ' after', timestamp: 3,
    });

    expect(input).toEqual(snapshot);
    expect(bounded.messages[0]).toBe(input.messages[0]);
    expect(bounded.messages[1]).not.toBe(input.messages[1]);
    expect(bounded.messages[1]?.text).toHaveLength(32_000);
    expect(bounded.messages[1]?.images).toBeUndefined();
    expect(updated.messages[0]?.text).toBe('before after');
    expect(updated.messages[1]?.images).toBeUndefined();
    expect(input.messages[1]?.images).toHaveLength(1);
  });

  it('preserves stable activity ties and legacy duplicate-ID retention at the item cap', () => {
    const messages = Array.from({ length: 61 }, (_, index) => ({
      id: index === 0 || index === 5 ? 'duplicate' : `message-${index}`,
      role: 'assistant' as const,
      text: `${index}`,
      timestamp: 1,
      timelinePosition: 1,
    }));
    const tools = Array.from({ length: 60 }, (_, index) => ({
      id: `tool-${index}`,
      name: 'read',
      input: '',
      output: '',
      outputTruncated: false,
      status: 'succeeded' as const,
      startedAt: 1,
      updatedAt: 1,
      timelinePosition: 1,
    }));

    const bounded = boundSubagentRun({ ...runWith(messages), tools });

    // Stable message-before-tool ties remove the first activity. Its duplicate ID is
    // retained because the later occurrence remains, matching the established behavior.
    expect(bounded.messages.map((message) => message.text)).toEqual(messages.map((message) => message.text));
    expect(bounded.tools).toHaveLength(60);
    expect(bounded.messages).toHaveLength(61);
    expect(bounded.omittedActivity).toBe(1);
    expect(bounded.transcriptTruncated).toBe(true);
  });

  it('preserves duplicate-ID image lookup and stable message-before-tool ties', () => {
    const duplicatePayload = 'a'.repeat(Math.floor(MAX_SUBAGENT_IMAGE_CHARACTERS / 2) + 1);
    const duplicateMessages: SubagentRun['messages'] = [{
      id: 'duplicate', role: 'assistant', text: '', timestamp: 1, timelinePosition: 1,
      images: [{ data: duplicatePayload, mimeType: 'image/png' }],
    }, {
      id: 'duplicate', role: 'assistant', text: 'second occurrence', timestamp: 1, timelinePosition: 1,
    }];
    const duplicateBounded = boundSubagentRun(runWith(duplicateMessages));

    expect(duplicateBounded.messages[0]).toMatchObject({ text: expect.stringContaining('Image omitted') });
    expect(duplicateBounded.messages[0]?.images).toBeUndefined();
    expect(duplicateMessages[0]?.images).toHaveLength(1);
    expect(duplicateBounded.messages[1]).toBe(duplicateMessages[1]);

    const messagePayload = 'b'.repeat(5_000_000);
    const toolPayload = 'c'.repeat(4_000_000);
    const tiedMessage = {
      id: 'message-image', role: 'assistant' as const, text: '', timestamp: 2, timelinePosition: 2,
      images: [{ data: messagePayload, mimeType: 'image/png' as const }],
    };
    const tiedTool = {
      id: 'tool-image', name: 'read', input: '', output: '', outputTruncated: false,
      status: 'succeeded' as const, startedAt: 2, updatedAt: 2, timelinePosition: 2,
      images: [{ data: toolPayload, mimeType: 'image/png' as const }],
    };
    const tiedBounded = boundSubagentRun({ ...runWith([tiedMessage]), tools: [tiedTool] });

    expect(tiedBounded.messages[0]?.images).toHaveLength(1);
    expect(tiedBounded.tools[0]?.images).toBeUndefined();
    expect(tiedBounded.tools[0]?.output).toContain('Image omitted');
  });

  it('spends the aggregate text budget newest-first across mixed activity', () => {
    const messages = Array.from({ length: 4 }, (_, index) => ({
      id: `message-${index}`,
      role: 'assistant' as const,
      text: String(index).repeat(32_000),
      timestamp: index * 2,
      timelinePosition: index * 2,
    }));
    const tools = Array.from({ length: 4 }, (_, index) => ({
      id: `tool-${index}`,
      name: 'read',
      input: 'i'.repeat(16_000),
      output: 'o'.repeat(16_000),
      outputTruncated: false,
      status: 'succeeded' as const,
      startedAt: index * 2 + 1,
      updatedAt: index * 2 + 1,
      timelinePosition: index * 2 + 1,
    }));
    const bounded = boundSubagentRun({ ...runWith(messages), tools, error: 'e'.repeat(100) });
    const characters = bounded.messages.reduce(
      (total, message) => total + message.text.length + (message.reasoning?.length ?? 0),
      0,
    ) + bounded.tools.reduce((total, tool) => total + tool.input.length + tool.output.length, 0)
      + (bounded.error?.length ?? 0);

    expect(characters).toBe(MAX_SUBAGENT_TRANSCRIPT_CHARACTERS);
    expect(bounded.messages[3]?.text).toBe(messages[3]?.text);
    expect(bounded.tools[3]?.input).toBe(tools[3]?.input);
    expect(bounded.tools[3]?.output).toBe(tools[3]?.output);
    expect(bounded.messages[0]?.text).toContain('subagent transcript truncated');
    expect(bounded.messages[0]?.text).toHaveLength(31_900);
    expect(bounded.transcriptTruncated).toBe(true);
  });
});
