/**
 * Handy-style speech gate for local dictation.
 *
 * Handy wraps Silero VAD in SmoothedVad: 30 ms frames, a pre-roll buffer so
 * word onsets are not clipped, an onset count so clicks do not open the gate,
 * and a hangover tail so short pauses stay in context. This port keeps that
 * state machine and uses per-frame energy instead of ONNX, so Windows, macOS,
 * and Linux share one PCM path with no extra native dependency.
 *
 * Do not score a whole 300 ms capture as one RMS. A short onset after a
 * thinking pause then looks like silence and the decoder never sees the voice.
 */

import { SPEECH_SAMPLE_RATE } from './speech';

/** 30 ms at 16 kHz — the same frame size Handy feeds Silero. */
export const SPEECH_GATE_FRAME_SAMPLES = Math.round(SPEECH_SAMPLE_RATE * 0.03);

export interface SpeechGateConfig {
  /** Frame RMS at or above this counts as voice. */
  readonly rmsThreshold: number;
  /** Frame peak at or above this also counts as voice, so plosives pass. */
  readonly peakThreshold: number;
  /** Frames kept before onset and replayed when speech starts. */
  readonly prefillFrames: number;
  /** Silent frames that still flow after speech so word tails are not cut. */
  readonly hangoverFrames: number;
  /** Consecutive voice frames required to open the gate. */
  readonly onsetFrames: number;
}

/** Streaming hangover is ~1.65 s (55 × 30 ms), matching Handy. */
export const defaultSpeechGateConfig: SpeechGateConfig = {
  rmsThreshold: 0.003,
  peakThreshold: 0.015,
  prefillFrames: 15,
  hangoverFrames: 55,
  onsetFrames: 2,
};

/** Batch trim uses the same detector with Handy’s shorter offline tail. */
export const batchSpeechTrimConfig: SpeechGateConfig = {
  ...defaultSpeechGateConfig,
  hangoverFrames: 15,
};

export function frameHasSpeech(frame: Float32Array, config: SpeechGateConfig = defaultSpeechGateConfig): boolean {
  if (frame.length === 0) return false;
  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const sample = frame[i]!;
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / frame.length) >= config.rmsThreshold || peak >= config.peakThreshold;
}

/**
 * Drop leading and trailing silence. Keep pauses in the middle, including
 * 3–5 s thinking gaps, so the model still hears sentence boundaries.
 * Returns the original buffer when there is nothing to trim.
 */
export function trimSpeechPcm(pcm: Float32Array, config: SpeechGateConfig = batchSpeechTrimConfig): Float32Array {
  if (pcm.length === 0) return pcm;
  const frame = SPEECH_GATE_FRAME_SAMPLES;
  if (pcm.length < frame) return frameHasSpeech(pcm, config) ? pcm : new Float32Array(0);

  const needed = config.onsetFrames;
  let run = 0;
  let first = -1;
  let last = -1;
  const mark = (index: number, length: number) => {
    run += 1;
    if (first < 0) {
      if (run < needed) return;
      first = Math.max(0, index - (needed - 1) * frame);
    }
    last = index + length;
  };
  const miss = () => { run = 0; };

  let offset = 0;
  while (offset + frame <= pcm.length) {
    if (frameHasSpeech(pcm.subarray(offset, offset + frame), config)) mark(offset, frame);
    else miss();
    offset += frame;
  }
  if (offset < pcm.length) {
    if (frameHasSpeech(pcm.subarray(offset), config)) mark(offset, pcm.length - offset);
    else miss();
  }
  if (first < 0) return new Float32Array(0);

  const start = Math.max(0, first - config.prefillFrames * frame);
  const end = Math.min(pcm.length, last + config.hangoverFrames * frame);
  if (start === 0 && end === pcm.length) return pcm;
  return pcm.subarray(start, end);
}

function concatPcm(chunks: readonly Float32Array[]): Float32Array | null {
  if (chunks.length === 0) return null;
  if (chunks.length === 1) return chunks[0]!;
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Streaming speech gate. Leading silence never opens the gate. */
export class SpeechGate {
  private remainder = new Float32Array(0);
  private readonly frameBuffer: Float32Array[] = [];
  private hangoverCounter = 0;
  private onsetCounter = 0;
  private inSpeech = false;

  constructor(private readonly config: SpeechGateConfig = defaultSpeechGateConfig) {}

  /** Forward speech (plus pre-roll/hangover). Null means drop this capture. */
  push(pcm: Float32Array): Float32Array | null {
    if (pcm.length === 0) return null;
    const input = this.remainder.length === 0 ? pcm : concatPcm([this.remainder, pcm])!;
    const frame = SPEECH_GATE_FRAME_SAMPLES;
    const complete = input.length - (input.length % frame);
    const forwarded: Float32Array[] = [];
    for (let offset = 0; offset < complete; offset += frame) {
      const kept = this.pushFrame(input.subarray(offset, offset + frame));
      if (kept) forwarded.push(kept);
    }
    this.remainder = complete < input.length
      ? Float32Array.from(input.subarray(complete))
      : new Float32Array(0);
    return concatPcm(forwarded);
  }

  /** Emit a trailing partial frame when capture stops. */
  flush(): Float32Array | null {
    if (this.remainder.length === 0) return null;
    const tail = this.remainder;
    this.remainder = new Float32Array(0);
    return this.pushFrame(tail);
  }

  private pushFrame(frame: Float32Array): Float32Array | null {
    this.frameBuffer.push(Float32Array.from(frame));
    const maxBuffered = this.config.prefillFrames + 1;
    while (this.frameBuffer.length > maxBuffered) this.frameBuffer.shift();

    const isVoice = frameHasSpeech(frame, this.config);
    if (!this.inSpeech && isVoice) {
      this.onsetCounter += 1;
      if (this.onsetCounter < this.config.onsetFrames) return null;
      this.inSpeech = true;
      this.hangoverCounter = this.config.hangoverFrames;
      this.onsetCounter = 0;
      return concatPcm(this.frameBuffer);
    }
    if (this.inSpeech && isVoice) {
      this.hangoverCounter = this.config.hangoverFrames;
      return Float32Array.from(frame);
    }
    if (this.inSpeech && !isVoice) {
      this.onsetCounter = 0;
      if (this.hangoverCounter > 0) {
        this.hangoverCounter -= 1;
        return Float32Array.from(frame);
      }
      this.inSpeech = false;
      return null;
    }
    this.onsetCounter = 0;
    return null;
  }
}
