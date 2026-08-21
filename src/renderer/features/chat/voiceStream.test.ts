import { describe, expect, it, vi } from 'vitest';
import { SPEECH_SAMPLE_RATE } from '../../../shared/speech';
import { defaultSpeechGateConfig } from '../../../shared/speechGate';
import { VoiceStreamFeedQueue } from './voiceStream';

const chunk = (seconds: number, amplitude: number): Float32Array =>
  new Float32Array(Math.round(SPEECH_SAMPLE_RATE * seconds)).fill(amplitude);

const sentSampleCount = (send: ReturnType<typeof vi.fn>): number =>
  send.mock.calls.reduce((total, [audio]) => total + (audio as ArrayBuffer).byteLength / 4, 0);

describe('VoiceStreamFeedQueue speech gating', () => {
  it('never sends leading silence to the main process', async () => {
    const send = vi.fn(async (_audio: ArrayBuffer) => undefined);
    const queue = new VoiceStreamFeedQueue(send, () => undefined);
    for (let i = 0; i < 8; i += 1) queue.push(chunk(0.3, 0));
    await queue.closeAndDrain();
    expect(send).not.toHaveBeenCalled();
  });

  it('sends speech plus a hangover tail, then drops a thinking pause', async () => {
    const send = vi.fn(async (_audio: ArrayBuffer) => undefined);
    const queue = new VoiceStreamFeedQueue(send, () => undefined);
    queue.push(chunk(0.3, 0.5));
    queue.push(chunk(0.3, 0.5));
    queue.push(chunk(0.3, 0));
    queue.push(chunk(0.3, 0));
    for (let i = 0; i < 12; i += 1) queue.push(chunk(0.3, 0));
    await queue.closeAndDrain();
    const sentSamples = sentSampleCount(send);
    expect(sentSamples).toBeGreaterThan(SPEECH_SAMPLE_RATE * 0.5);
    expect(sentSamples).toBeLessThan(SPEECH_SAMPLE_RATE * 3);
  });

  it('sends speech that resumes after a 4 s pause, including pre-roll', async () => {
    const send = vi.fn(async (_audio: ArrayBuffer) => undefined);
    const queue = new VoiceStreamFeedQueue(send, () => undefined);
    queue.push(chunk(0.3, 0.4));
    for (let i = 0; i < 14; i += 1) queue.push(chunk(0.3, 0));
    queue.push(chunk(0.3, 0.4));
    await queue.closeAndDrain();
    expect(sentSampleCount(send)).toBeGreaterThan(SPEECH_SAMPLE_RATE * 0.5);
  });

  it('re-exports Handy streaming hangover defaults', () => {
    expect(defaultSpeechGateConfig.hangoverFrames).toBe(55);
    expect(defaultSpeechGateConfig.prefillFrames).toBe(15);
    expect(defaultSpeechGateConfig.rmsThreshold).toBeLessThan(0.01);
  });
});
