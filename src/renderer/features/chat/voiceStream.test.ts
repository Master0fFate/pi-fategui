import { describe, expect, it, vi } from 'vitest';
import { MAX_VOICE_STREAM_BACKLOG_SAMPLES, MAX_VOICE_STREAM_BATCH_SAMPLES, VoiceStreamFeedQueue } from './voiceStream';

const CHUNK_SAMPLES = 4_800;

const chunk = (value: number) => new Float32Array(CHUNK_SAMPLES).fill(value);

function joinedBatches(batches: readonly Float32Array[]): Float32Array {
  const output = new Float32Array(batches.reduce((total, batch) => total + batch.length, 0));
  let offset = 0;
  for (const batch of batches) {
    output.set(batch, offset);
    offset += batch.length;
  }
  return output;
}

describe('VoiceStreamFeedQueue', () => {
  it('batches delayed worklet captures in order and drains them before normal stop', async () => {
    let releaseFirstSend!: () => void;
    const firstSend = new Promise<void>((resolve) => { releaseFirstSend = resolve; });
    const sent: Float32Array[] = [];
    const send = vi.fn((audio: ArrayBuffer): Promise<void> => {
      sent.push(new Float32Array(audio.slice(0)));
      return sent.length === 1 ? firstSend : Promise.resolve();
    });
    const onError = vi.fn();
    const queue = new VoiceStreamFeedQueue(send, onError);

    expect(queue.push(chunk(1))).toBe(true);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    for (let value = 2; value <= 8; value += 1) expect(queue.push(chunk(value))).toBe(true);

    const stopping = queue.closeAndDrain();
    expect(queue.push(chunk(9))).toBe(false);
    expect(sent).toHaveLength(1);

    releaseFirstSend();
    await stopping;

    expect(onError).not.toHaveBeenCalled();
    expect(sent.map((batch) => batch.length)).toEqual([CHUNK_SAMPLES, CHUNK_SAMPLES * 6, CHUNK_SAMPLES]);
    expect(sent[1]!.length).toBeLessThanOrEqual(MAX_VOICE_STREAM_BATCH_SAMPLES);
    const pcm = joinedBatches(sent);
    expect(pcm).toHaveLength(CHUNK_SAMPLES * 8);
    expect(Array.from({ length: 8 }, (_, index) => pcm[index * CHUNK_SAMPLES]!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('fails explicitly when a slow IPC send reaches the bounded backlog', async () => {
    let releaseFirstSend!: () => void;
    const firstSend = new Promise<void>((resolve) => { releaseFirstSend = resolve; });
    const send = vi.fn(() => firstSend);
    const onError = vi.fn();
    const queue = new VoiceStreamFeedQueue(send, onError);
    const fullFeed = (value: number) => new Float32Array(MAX_VOICE_STREAM_BATCH_SAMPLES).fill(value);

    expect(queue.push(fullFeed(1))).toBe(true);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const acceptedFeeds = MAX_VOICE_STREAM_BACKLOG_SAMPLES / MAX_VOICE_STREAM_BATCH_SAMPLES;
    for (let value = 2; value <= acceptedFeeds; value += 1) expect(queue.push(fullFeed(value))).toBe(true);

    expect(queue.push(fullFeed(99))).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('cannot keep up') }));
    expect(send).toHaveBeenCalledOnce();

    releaseFirstSend();
    await expect(queue.closeAndDrain()).rejects.toThrow('cannot keep up');
    expect(send).toHaveBeenCalledOnce();
  });

  it('drops only unsent captures when cancelled', async () => {
    let releaseFirstSend!: () => void;
    const firstSend = new Promise<void>((resolve) => { releaseFirstSend = resolve; });
    let sendCount = 0;
    const send = vi.fn((_audio: ArrayBuffer): Promise<void> => {
      sendCount += 1;
      return sendCount === 1 ? firstSend : Promise.resolve();
    });
    const onError = vi.fn();
    const queue = new VoiceStreamFeedQueue(send, onError);

    queue.push(chunk(1));
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    queue.push(chunk(2));
    queue.cancel();
    releaseFirstSend();
    await queue.closeAndDrain();

    expect(send).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });
});
