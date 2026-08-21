import { describe, expect, it } from 'vitest';
import { SPEECH_SAMPLE_RATE } from './speech';
import {
  SpeechGate,
  SPEECH_GATE_FRAME_SAMPLES,
  batchSpeechTrimConfig,
  defaultSpeechGateConfig,
  frameHasSpeech,
  trimSpeechPcm,
} from './speechGate';

const samples = (seconds: number, amplitude: number): Float32Array =>
  new Float32Array(Math.round(SPEECH_SAMPLE_RATE * seconds)).fill(amplitude);

const forwardedSamples = (gate: SpeechGate, pcm: Float32Array): number =>
  gate.push(pcm)?.length ?? 0;

describe('frameHasSpeech', () => {
  it('rejects silence and accepts a speech-level frame', () => {
    expect(frameHasSpeech(new Float32Array(SPEECH_GATE_FRAME_SAMPLES))).toBe(false);
    expect(frameHasSpeech(new Float32Array(SPEECH_GATE_FRAME_SAMPLES).fill(0.05))).toBe(true);
  });

  it('accepts a short plosive that RMS alone would miss on a mixed frame', () => {
    const frame = new Float32Array(SPEECH_GATE_FRAME_SAMPLES);
    frame[10] = 0.4;
    expect(frameHasSpeech(frame)).toBe(true);
  });
});

describe('SpeechGate', () => {
  it('does not forward leading silence', () => {
    const gate = new SpeechGate();
    expect(gate.push(samples(0.3, 0))).toBeNull();
    expect(gate.push(samples(0.3, 0))).toBeNull();
    expect(gate.push(samples(1.5, 0))).toBeNull();
  });

  it('forwards speech after two 30 ms onset frames', () => {
    const gate = new SpeechGate();
    const first = gate.push(samples(0.03, 0.2));
    const second = gate.push(samples(0.03, 0.2));
    expect(first).toBeNull();
    expect(second).not.toBeNull();
    expect(second!.length).toBeGreaterThanOrEqual(SPEECH_GATE_FRAME_SAMPLES);
  });

  it('replays pre-roll so a word onset after a pause is not clipped', () => {
    const gate = new SpeechGate();
    for (let i = 0; i < 20; i += 1) expect(gate.push(samples(0.03, 0))).toBeNull();
    expect(gate.push(samples(0.03, 0.2))).toBeNull();
    const opened = gate.push(samples(0.03, 0.2));
    expect(opened).not.toBeNull();
    expect(opened!.length).toBeGreaterThan(SPEECH_GATE_FRAME_SAMPLES);
    expect(opened!.length).toBeGreaterThanOrEqual(defaultSpeechGateConfig.prefillFrames * SPEECH_GATE_FRAME_SAMPLES);
  });

  it('keeps a 1 s mid-sentence pause inside the hangover tail', () => {
    const gate = new SpeechGate();
    expect(forwardedSamples(gate, samples(0.3, 0.4))).toBeGreaterThan(0);
    const tail = forwardedSamples(gate, samples(1.0, 0));
    expect(tail).toBeGreaterThanOrEqual(SPEECH_SAMPLE_RATE * 0.9);
    expect(tail).toBeLessThanOrEqual(SPEECH_SAMPLE_RATE);
  });

  it('drops a 3–5 s thinking pause, then reopens when speech returns', () => {
    const gate = new SpeechGate();
    expect(forwardedSamples(gate, samples(0.4, 0.4))).toBeGreaterThan(0);
    let silentForwarded = 0;
    for (let i = 0; i < 14; i += 1) silentForwarded += forwardedSamples(gate, samples(0.3, 0));
    expect(silentForwarded).toBeGreaterThan(0);
    expect(silentForwarded).toBeLessThan(SPEECH_SAMPLE_RATE * 2.2);
    expect(gate.push(samples(0.3, 0))).toBeNull();
    expect(gate.push(samples(0.03, 0.25))).toBeNull();
    const resumed = gate.push(samples(0.3, 0.25));
    expect(resumed).not.toBeNull();
    expect(resumed!.length).toBeGreaterThan(0);
  });

  it('forwards a 50 ms onset inside a 300 ms mostly-silent capture', () => {
    const gate = new SpeechGate();
    const chunk = new Float32Array(SPEECH_SAMPLE_RATE * 0.3);
    chunk.fill(0.2, 0, Math.round(SPEECH_SAMPLE_RATE * 0.06));
    const forwarded = gate.push(chunk);
    expect(forwarded).not.toBeNull();
    expect(forwarded!.length).toBeGreaterThan(0);
  });

  it('does not treat a single click as speech', () => {
    const gate = new SpeechGate({ ...defaultSpeechGateConfig, hangoverFrames: 0 });
    const click = new Float32Array(SPEECH_GATE_FRAME_SAMPLES);
    click[8] = 0.9;
    expect(gate.push(click)).toBeNull();
    expect(gate.push(new Float32Array(SPEECH_GATE_FRAME_SAMPLES))).toBeNull();
  });

  it('flushes a trailing partial frame after speech', () => {
    const gate = new SpeechGate();
    expect(forwardedSamples(gate, samples(0.3, 0.3))).toBeGreaterThan(0);
    expect(gate.push(new Float32Array(100).fill(0.3))).toBeNull();
    const flushed = gate.flush();
    expect(flushed).not.toBeNull();
    expect(flushed!.length).toBe(100);
  });
});

describe('trimSpeechPcm', () => {
  it('returns empty PCM when the clip is only silence', () => {
    expect(trimSpeechPcm(samples(4, 0))).toHaveLength(0);
  });

  it('keeps a short energetic clip used by composer tests', () => {
    const clip = new Float32Array([0, 0.25, -0.25, 0]);
    expect(trimSpeechPcm(clip)).toBe(clip);
  });

  it('drops leading thinking silence and keeps the spoken tail', () => {
    const pcm = new Float32Array(SPEECH_SAMPLE_RATE * 6);
    pcm.fill(0.2, SPEECH_SAMPLE_RATE * 4);
    const trimmed = trimSpeechPcm(pcm);
    expect(trimmed.length).toBeGreaterThan(SPEECH_SAMPLE_RATE);
    expect(trimmed.length).toBeLessThan(pcm.length);
    expect(trimmed[trimmed.length - 1]).toBeCloseTo(0.2);
  });

  it('keeps a 4 s pause between two spoken phrases', () => {
    const pcm = new Float32Array(SPEECH_SAMPLE_RATE * 8);
    pcm.fill(0.2, 0, SPEECH_SAMPLE_RATE);
    pcm.fill(0.2, SPEECH_SAMPLE_RATE * 5, SPEECH_SAMPLE_RATE * 6);
    const trimmed = trimSpeechPcm(pcm);
    expect(trimmed.length).toBeGreaterThan(SPEECH_SAMPLE_RATE * 5);
    const mid = Math.floor(trimmed.length / 2);
    expect(trimmed[mid]).toBe(0);
  });

  it('uses the shorter offline hangover for batch trim', () => {
    expect(batchSpeechTrimConfig.hangoverFrames).toBe(15);
    expect(defaultSpeechGateConfig.hangoverFrames).toBe(55);
    expect(defaultSpeechGateConfig.prefillFrames * SPEECH_GATE_FRAME_SAMPLES).toBe(SPEECH_SAMPLE_RATE * 0.45);
  });
});
