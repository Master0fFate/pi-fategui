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
    const split = normalizer.normalize(event({ type: 'message_update', message, assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(70_000) } }));
    expect(split).toHaveLength(3);
    expect(split.every((item) => item.type === 'assistant.text' && item.delta.length <= 32_000)).toBe(true);
  });

  it('keeps one assistant ID across fresh SDK update, streaming, and final objects', () => {
    const normalizer = new PiEventNormalizer(() => 'run-1');
    const started = normalizer.normalize(event({ type: 'message_start', message: { role: 'assistant', content: [] } }))[0];
    const updateObject = { role: 'assistant', content: [{ type: 'text', text: 'partial' }] };
    const update = normalizer.normalize(event({ type: 'message_update', message: updateObject, assistantMessageEvent: { type: 'text_delta', delta: 'partial' } }))[0];
    const finalObject = { role: 'assistant', content: [{ type: 'text', text: 'complete' }] };
    const completed = normalizer.normalize(event({ type: 'message_end', message: finalObject }))[0];

    expect(started).toMatchObject({ type: 'message.started' });
    expect(update).toMatchObject({ type: 'assistant.text', messageId: started && 'messageId' in started ? started.messageId : '' });
    expect(normalizer.currentAssistantMessageId()).toBeNull();
    expect(completed).toMatchObject({ type: 'message.completed', messageId: started && 'messageId' in started ? started.messageId : '' });
    expect(normalizer.messageId(finalObject)).toBe(started && 'messageId' in started ? started.messageId : '');
  });

  it('normalizes tool transitions and bounds serialized output without duplicating tool-result messages', () => {
    const normalizer = new PiEventNormalizer(() => 'run-1');
    expect(normalizer.normalize(event({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'x' } }))[0]).toMatchObject({ type: 'tool.started', toolCallId: 't1', name: 'read' });
    expect(normalizer.normalize(event({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'read', result: 'ok', isError: false }))[0]).toMatchObject({ type: 'tool.completed', error: false });
    const toolMessage = { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'ok' }] };
    expect(normalizer.normalize(event({ type: 'message_start', message: toolMessage }))).toEqual([]);
    expect(normalizer.normalize(event({ type: 'message_end', message: toolMessage }))).toEqual([]);
    expect(safeText('x'.repeat(70_000)).length).toBeLessThan(65_000);
    const pathological = Object.fromEntries(Array.from({ length: 10_000 }, (_value, index) => [`key-${index}`, 'x'.repeat(1_000)]));
    expect(safeText(pathological).length).toBeLessThan(65_000);

    const longAssistant = normalizer.normalize(event({
      type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1_000_000) }] },
    }))[0];
    const longTool = normalizer.normalize(event({
      type: 'tool_execution_end', toolCallId: 't2', toolName: 'custom', result: { content: [{ type: 'text', text: 'y'.repeat(1_000_000) }] }, isError: false,
    }))[0];
    expect(longAssistant).toMatchObject({ type: 'message.completed' });
    expect(longTool).toMatchObject({ type: 'tool.completed' });
    expect(longAssistant && 'text' in longAssistant ? longAssistant.text.length : 0).toBeLessThan(65_000);
    expect(longTool && 'output' in longTool ? longTool.output.length : 0).toBeLessThan(65_000);
  });

  it('preserves attached and tool-generated images in live events', () => {
    const normalizer = new PiEventNormalizer(() => 'run-1');
    const userMessage = { role: 'user', content: [{ type: 'text', text: 'Inspect this' }, { type: 'image', data: 'dXNlcg==', mimeType: 'image/png' }] };
    expect(normalizer.normalize(event({ type: 'message_end', message: userMessage }))[0]).toMatchObject({
      type: 'message.completed',
      role: 'user',
      text: 'Inspect this',
      images: [{ data: 'dXNlcg==', mimeType: 'image/png', alt: 'Attached image 1' }],
    });

    const result = { content: [{ type: 'text', text: 'Generated preview' }, { type: 'image', data: 'dG9vbA==', mimeType: 'image/webp' }] };
    expect(normalizer.normalize(event({ type: 'tool_execution_end', toolCallId: 'image-1', toolName: 'generate_image', result, isError: false }))[0]).toMatchObject({
      type: 'tool.completed',
      output: 'Generated preview',
      images: [{ data: 'dG9vbA==', mimeType: 'image/webp', alt: 'Generated image 1' }],
    });
  });

  it('surfaces visible extension messages as system output and keeps hidden context hidden', () => {
    const normalizer = new PiEventNormalizer(() => null);
    const visible = { role: 'custom', customType: 'parallax', content: 'Parallax active', display: true, timestamp: 1 };
    expect(normalizer.normalize(event({ type: 'message_start', message: visible }))[0]).toMatchObject({ type: 'message.started', role: 'system' });
    expect(normalizer.normalize(event({ type: 'message_end', message: visible }))[0]).toMatchObject({ type: 'message.completed', role: 'system', text: 'Parallax active' });

    const hidden = { ...visible, display: false };
    expect(normalizer.normalize(event({ type: 'message_start', message: hidden }))).toEqual([]);
    expect(normalizer.normalize(event({ type: 'message_end', message: hidden }))).toEqual([]);
  });

  it('preserves compaction failure instead of reporting false success', () => {
    const normalizer = new PiEventNormalizer(() => null);
    expect(normalizer.normalize(event({ type: 'compaction_end', aborted: false, errorMessage: 'Nothing to compact (session too small)' }))[0]).toMatchObject({
      type: 'context.compaction',
      phase: 'failed',
      error: { code: 'INVALID_REQUEST', message: 'There is not enough conversation context to compact yet.' },
    });
  });
});
