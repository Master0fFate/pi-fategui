import { describe, expect, it } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { sanitizedRecentTurns } from './AgentContextForker';

describe('sanitizedRecentTurns', () => {
  it('keeps bounded prose while stripping orchestration calls and non-conversation entries', () => {
    const session = {
      messages: [
        { role: 'system', content: 'secret parent boundary' },
        { role: 'user', content: [{ type: 'text', text: 'first request' }] },
        { role: 'assistant', content: [{ type: 'toolCall', id: 'x', name: 'spawn_agent', arguments: { task: 'hidden' } }] },
        { role: 'toolResult', toolName: 'spawn_agent', content: [{ type: 'text', text: 'tool output' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'safe answer' }] },
        { role: 'custom', customType: 'fate-agent-team-envelope', content: 'control' },
        { role: 'user', content: [{ type: 'text', text: 'latest request' }] },
      ],
    } as unknown as AgentSession;
    const result = sanitizedRecentTurns(session, 2);
    expect(result).toContain('first request');
    expect(result).toContain('safe answer');
    expect(result).toContain('latest request');
    expect(result).not.toContain('spawn_agent');
    expect(result).not.toContain('tool output');
    expect(result).not.toContain('secret parent boundary');
  });

  it('rejects context modes outside the MVP range', () => {
    const session = { messages: [] } as unknown as AgentSession;
    expect(() => sanitizedRecentTurns(session, 0)).toThrow(/1 to 5/);
    expect(() => sanitizedRecentTurns(session, 6)).toThrow(/1 to 5/);
  });
});
