import { describe, expect, it } from 'vitest';
import { combineSampleBatch, takeSampleBatch } from './speechQueue';

describe('shared speech queue batching', () => {
  it('combines pending captures up to the batch limit in original order', () => {
    const queue = [1, 2, 3, 4].map((value) => new Float32Array([value]));
    const pendingCounts: number[] = [];
    const batch = takeSampleBatch(
      queue,
      3,
      (chunk) => chunk.length,
      () => pendingCounts.push(1),
    );
    expect(batch).toHaveLength(3);
    expect(queue).toHaveLength(1);
    expect(combineSampleBatch(batch, (chunk) => chunk)).toEqual(new Float32Array([1, 2, 3]));
    expect(pendingCounts).toHaveLength(3);
    // The remainder is taken by the next pass.
    const rest = takeSampleBatch(queue, 3, (chunk) => chunk.length, () => undefined);
    expect(combineSampleBatch(rest, (chunk) => chunk)).toEqual(new Float32Array([4]));
  });

  it('stops before exceeding the batch limit and keeps the remainder queued', () => {
    const queue = [new Float32Array(2), new Float32Array(2), new Float32Array(2)];
    const batch = takeSampleBatch(queue, 3, (chunk) => chunk.length, () => undefined);
    expect(batch).toHaveLength(1);
    expect(queue).toHaveLength(2);
    expect(combineSampleBatch(batch, (chunk) => chunk)).toHaveLength(2);
  });

  it('always takes the oldest item even when it alone exceeds the limit', () => {
    const oversized = new Float32Array(10);
    const queue = [oversized, new Float32Array(1)];
    const batch = takeSampleBatch(queue, 3, (chunk) => chunk.length, () => undefined);
    expect(batch).toEqual([oversized]);
    expect(queue).toHaveLength(1);
  });

  it('returns an empty batch for an empty queue', () => {
    const queue: Float32Array[] = [];
    expect(takeSampleBatch(queue, 100, (chunk) => chunk.length, () => undefined)).toEqual([]);
    expect(combineSampleBatch([], (chunk) => chunk)).toHaveLength(0);
  });

  it('keeps sample accounting in sync through onTake', () => {
    const queue = [new Float32Array(2), new Float32Array(1)];
    let pending = 3;
    takeSampleBatch(
      queue,
      100,
      (chunk) => chunk.length,
      (chunk) => { pending -= chunk.length; },
    );
    expect(pending).toBe(0);
  });
});
