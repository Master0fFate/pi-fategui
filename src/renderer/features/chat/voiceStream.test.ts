import { describe, expect, it, vi } from 'vitest';
import { SPEECH_SAMPLE_RATE } from '../../../shared/speech';
import { SpeechGate, VoiceStreamFeedQueue, defaultSpeechGateConfig } from './voiceStream';

const chunk = (seconds: number, amplitude: number): Float32Array =>
  new Float32Array(Math.round(SPEECH_SAMPLE_RATE * seconds)).fill(amplitude);

describe('SpeechGate', () => {
  it('drops sustained silence', () => {
    const gate = new SpeechGate();
    expect(gate.push(chunk(0.3, 0))).toBe(true); // 0.3 s: hangover open
    expect(gate.push(chunk(0.3, 0))).toBe(true); // 0.6 s: hangover open
    expect(gate.push(chunk(0.3, 0))).toBe(false); // 0.9 s: past 0.8 s hangover
    expect(gate.push(chunk(0.3, 0))).toBe(false);
  });

  it('always passes speech and resets the hangover', () => {
    const gate = new SpeechGate();
    expect(gate.push(chunk(0.3, 0.5))).toBe(true);
    expect(gate.push(chunk(0.3, 0.5))).toBe(true);
    expect(gate.push(chunk(0.3, 0))).toBe(true); // tail
    expect(gate.push(chunk(0.3, 0.5))).toBe(true); // speech again resets silence
    expect(gate.push(chunk(0.3, 0))).toBe(true); // 0.3 s of silence
    expect(gate.push(chunk(0.3, 0))).toBe(true); // 0.6 s, still in tail
    expect(gate.push(chunk(0.3, 0))).toBe(false); // 0.9 s, past the 0.8 s tail
  });

  it('reopens after a long pause when speech returns', () => {
    const gate = new SpeechGate();
    gate.push(chunk(0.3, 0.5));
    for (let i = 0; i < 10; i += 1) gate.push(chunk(0.3, 0)); // long silence
    expect(gate.push(chunk(0.3, 0.5))).toBe(true);
  });

  it('uses RMS, so a quiet sine below the threshold is gated', () => {
    const gate = new SpeechGate({ rmsThreshold: 0.1, hangoverSamples: 0 });
    const quiet = new Float32Array(4_800);
    for (let i = 0; i < quiet.length; i += 1) quiet[i] = 0.05 * Math.sin((i / 4_800) * Math.PI * 2 * 40);
    expect(gate.push(quiet)).toBe(false);
    expect(gate.push(new Float32Array(4_800).fill(0.4))).toBe(true);
  });
});

describe('VoiceStreamFeedQueue speech gating', () => {
  it('never sends sustained silence to the main process', async () => {
    const send = vi.fn(async (_audio: ArrayBuffer) => undefined);
    const queue = new VoiceStreamFeedQueue(send, () => undefined);
    for (let i = 0; i < 5; i += 1) queue.push(chunk(0.3, 0)); // 1.5 s of silence
    await queue.closeAndDrain();
    // Only the opening hangover window (≤ 0.8 s) can pass before the gate closes.
    const sentSamples = send.mock.calls.reduce((total, [audio]) => total + (audio as ArrayBuffer).byteLength / 4, 0);
    expect(sentSamples).toBeLessThanOrEqual(SPEECH_SAMPLE_RATE * 0.8);
    expect(send.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('sends speech and its tail', async () => {
    const send = vi.fn(async (_audio: ArrayBuffer) => undefined);
    const queue = new VoiceStreamFeedQueue(send, () => undefined);
    queue.push(chunk(0.3, 0.5));
    queue.push(chunk(0.3, 0.5));
    queue.push(chunk(0.3, 0)); // hangover tail
    queue.push(chunk(0.3, 0)); // still within 0.8 s tail
    queue.push(chunk(0.3, 0)); // gated
    await queue.closeAndDrain();
    const sentSamples = send.mock.calls.reduce((total, [audio]) => total + (audio as ArrayBuffer).byteLength / 4, 0);
    expect(sentSamples).toBeGreaterThan(0);
    expect(sentSamples).toBeLessThanOrEqual(SPEECH_SAMPLE_RATE * 1.2);
  });

  it('default config keeps an 0.8 s hangover at a conservative threshold', () => {
    expect(defaultSpeechGateConfig.hangoverSamples).toBe(SPEECH_SAMPLE_RATE * 0.8);
    expect(defaultSpeechGateConfig.rmsThreshold).toBeLessThan(0.01);
  });
});
