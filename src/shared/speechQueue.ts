/**
 * Shared bounded-feed batching for live speech transcription.
 *
 * The renderer voice queue and the main-process stream drain must obey the same
 * rule: take the oldest pending capture plus as many followers as fit inside
 * one bounded native feed, in original order. One implementation on both sides
 * of the IPC boundary prevents the copies from drifting apart.
 */

/** Remove the next ordered batch from `queue` whose combined sample count stays
 *  within `maxBatchSamples`. The oldest item is always taken even when it alone
 *  exceeds the limit, so a single oversized capture still flows instead of
 *  blocking the queue. `onTake` runs for each removed item so the caller can
 *  keep its pending-sample accounting in sync. */
export function takeSampleBatch<T>(
  queue: T[],
  maxBatchSamples: number,
  samplesOf: (item: T) => number,
  onTake: (item: T) => void,
): T[] {
  const batch: T[] = [];
  let samples = 0;
  while (queue.length > 0) {
    const next = queue[0]!;
    const nextSamples = samplesOf(next);
    if (batch.length > 0 && samples + nextSamples > maxBatchSamples) break;
    queue.shift();
    onTake(next);
    batch.push(next);
    samples += nextSamples;
  }
  return batch;
}

/** Combine batched captures into one contiguous PCM buffer. */
export function combineSampleBatch<T>(batch: readonly T[], pcmOf: (item: T) => Float32Array): Float32Array {
  if (batch.length === 1) return pcmOf(batch[0]!);
  const samples = batch.reduce((total, item) => total + pcmOf(item).length, 0);
  const pcm = new Float32Array(samples);
  let offset = 0;
  for (const item of batch) {
    const chunk = pcmOf(item);
    pcm.set(chunk, offset);
    offset += chunk.length;
  }
  return pcm;
}
