import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { PiEventNormalizer, safeText } from './PiEventNormalizer';

const event = (value: unknown) => value as AgentSessionEvent;

describe('PiEventNormalizer', () => {
  it('normalizes assistant text and reasoning without exposing SDK events', () => {
    const normalizer = new PiEventNormalizer(() => 'run-1');
    const message = { role: 'assistant', content: [], timestamp: 1 };
    normalizer.normalize(event({ type: 'message_start', message }));
    expect(normalizer.normalize(event({ type: 'message_update', message, assistantMessageEvent: { type: 'text_delta', delta: 'hello' } }))[0]).toMatchObject({ type: 'assistant.text', delta: 'hello' });
    expect(normalizer.normalize(event({ type: 'message_update', message, assistantMessageEvent: { type: 'thinking_delta', delta: 'plan' } }))[0]).toMatchObject({ type: 'assistant.reasoning', delta: 'plan' });
  });

  it('normalizes tool transitions and bounds serialized output', () => {
    const normalizer = new PiEventNormalizer(() => 'run-1');
    expect(normalizer.normalize(event({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'x' } }))[0]).toMatchObject({ type: 'tool.started', toolCallId: 't1', name: 'read' });
    expect(normalizer.normalize(event({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'read', result: 'ok', isError: false }))[0]).toMatchObject({ type: 'tool.completed', error: false });
    expect(safeText('x'.repeat(70_000)).length).toBeLessThan(65_000);
  });
});
