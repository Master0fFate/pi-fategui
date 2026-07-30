import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { assertContextTransfer, contextTransferEstimate, estimateTransferTokens } from './SubagentContext';

const receiver = { provider: 'test', id: 'context-model', contextWindow: 100 } as const;

describe('subagent context transfer admission', () => {
  it('uses Pi-compatible conservative token estimates and admits an exact fit', () => {
    expect(estimateTransferTokens('x'.repeat(40))).toBe(10);
    const session = { getContextUsage: () => ({ tokens: 90, contextWindow: 100, percent: 90 }) } as unknown as AgentSession;
    expect(assertContextTransfer('parent-to-child', receiver, 'x'.repeat(40), session)).toEqual({
      currentTokens: 90, transferTokens: 10, projectedTokens: 100, contextWindow: 100,
    });
  });

  it('refuses overflow with the receiver model and exact maximum in the error', () => {
    const session = { getContextUsage: () => ({ tokens: 90, contextWindow: 100, percent: 90 }) } as unknown as AgentSession;
    expect(() => assertContextTransfer('child-to-parent', receiver, 'x'.repeat(44), session)).toThrow(
      /Refused child-to-parent transfer[\s\S]*test\/context-model[\s\S]*maximum context window of 100 tokens[\s\S]*Automatic compaction was not used/u,
    );
  });

  it('falls back to model-neutral estimation when provider usage is unavailable', () => {
    const session = {
      getContextUsage: () => ({ tokens: null, contextWindow: 100, percent: null }),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(40) }] }],
      agent: { state: { systemPrompt: 's'.repeat(40), tools: [] } },
    } as unknown as AgentSession;
    expect(contextTransferEstimate(receiver, 'y'.repeat(40), session)).toMatchObject({
      currentTokens: 20, transferTokens: 10, projectedTokens: 30,
    });
  });
});
