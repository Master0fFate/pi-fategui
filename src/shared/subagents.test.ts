import { describe, expect, it } from 'vitest';
import { subagentRunSchema, type SubagentRun } from './contracts/ipc';
import {
  MAX_SUBAGENT_ACTIVITY,
  MAX_SUBAGENT_TRANSCRIPT_CHARACTERS,
  boundSubagentRun,
  boundSubagentRuns,
} from './subagents';

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
});
