import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PiEvent } from '../../shared/contracts/ipc';
import { PiEventBatcher } from './PiEventBatcher';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PiEventBatcher', () => {
  it('coalesces stream deltas and flushes on a bounded cadence', () => {
    vi.useFakeTimers();
    const emitted: PiEvent[][] = [];
    const batcher = new PiEventBatcher((batch) => emitted.push(batch), { intervalMs: 20 });
    batcher.enqueue({ type: 'assistant.text', messageId: 'm', delta: 'a', timestamp: 1 });
    batcher.enqueue({ type: 'assistant.text', messageId: 'm', delta: 'b', timestamp: 2 });
    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(20);
    expect(emitted[0]).toEqual([{ type: 'assistant.text', messageId: 'm', delta: 'ab', timestamp: 2 }]);
  });

  it('updates merged stream byte counts incrementally instead of reserializing the growing event', () => {
    const emitted: PiEvent[][] = [];
    const stringify = vi.spyOn(JSON, 'stringify');
    const batcher = new PiEventBatcher((batch) => emitted.push(batch), { maxDeltaLength: 10_000 });
    for (let index = 0; index < 2_000; index += 1) {
      batcher.enqueue({ type: 'assistant.text', messageId: 'm', delta: 'x', timestamp: index });
    }
    batcher.flush();

    expect(emitted).toHaveLength(1);
    expect((emitted[0]?.[0] as { delta?: string }).delta).toHaveLength(2_000);
    expect(stringify.mock.calls.length).toBeLessThanOrEqual(2_005);
  });

  it('never emits more than 100 events in one IPC batch', () => {
    const emitted: PiEvent[][] = [];
    const batcher = new PiEventBatcher((batch) => emitted.push(batch), { maxBatchSize: 100 });
    for (let index = 0; index < 250; index++) batcher.enqueue({ type: 'run.started', runId: String(index), timestamp: index });
    batcher.flush();
    expect(emitted.flat()).toHaveLength(250);
    expect(Math.max(...emitted.map((batch) => batch.length))).toBeLessThanOrEqual(100);
  });

  it('replaces an event that exceeds the absolute transport ceiling with a bounded error', () => {
    const emitted: PiEvent[][] = [];
    const batcher = new PiEventBatcher((batch) => emitted.push(batch), { maxBatchBytes: 64_000, maxEventBytes: 64_000 });
    batcher.enqueue({ type: 'tool.updated', toolCallId: 'oversized', output: 'x'.repeat(100_000), timestamp: 1 });
    batcher.flush();
    expect(emitted.flat()).toEqual([expect.objectContaining({ type: 'error', error: expect.objectContaining({ code: 'PI_RUNTIME_ERROR' }) })]);
    expect(Buffer.byteLength(JSON.stringify(emitted[0]), 'utf8')).toBeLessThan(64_000);
  });

  it('bounds serialized IPC batches even when tool outputs are individually large', () => {
    const emitted: PiEvent[][] = [];
    const maximum = 130_000;
    const batcher = new PiEventBatcher((batch) => emitted.push(batch), { maxBatchBytes: maximum });
    for (let index = 0; index < 8; index++) {
      batcher.enqueue({ type: 'tool.updated', toolCallId: `tool-${index}`, output: 'x'.repeat(60_000), timestamp: index });
    }
    batcher.flush();
    expect(emitted.flat()).toHaveLength(8);
    expect(emitted.every((batch) => Buffer.byteLength(JSON.stringify(batch), 'utf8') <= maximum + 2)).toBe(true);
  });
});
