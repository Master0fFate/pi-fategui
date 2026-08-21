/**
 * Live microphone tap for streaming transcription. Captures mono audio, downsamples
 * to the 16 kHz float32 PCM the model expects, and emits fixed-size chunks the
 * renderer forwards to SpeechService.streamFeed. The worklet is built from a Blob
 * URL so it needs no separate asset or bundler plumbing.
 *
 * The node is connected to the destination through a silent gain node: a worklet
 * whose output is not (transitively) connected to the destination is not pulled,
 * so without this the mic would be captured but `process()` would never run.
 */

import { SpeechGate } from '../../../shared/speechGate';
import { MAX_SPEECH_STREAM_BACKLOG_SAMPLES, MAX_SPEECH_STREAM_FEED_SAMPLES, SPEECH_SAMPLE_RATE } from '../../../shared/speech';
import { combineSampleBatch, takeSampleBatch } from '../../../shared/speechQueue';

export { SpeechGate, defaultSpeechGateConfig, type SpeechGateConfig } from '../../../shared/speechGate';

export interface VoiceStreamController {
  /** Flush the final partial PCM capture, then stop the mic and close the graph. */
  stop: () => Promise<void>;
}

const PROCESSOR_NAME = 'fate-voice-downsample';
const TARGET_RATE = SPEECH_SAMPLE_RATE;
/** Match the main-process IPC limit: combine delayed 300 ms captures, but never
 *  make an unbounded native feed. */
export const MAX_VOICE_STREAM_BATCH_SAMPLES = MAX_SPEECH_STREAM_FEED_SAMPLES;
export const MAX_VOICE_STREAM_BACKLOG_SAMPLES = MAX_SPEECH_STREAM_BACKLOG_SAMPLES;

/** Serializes renderer-to-main audio sends. AudioWorklet messages cannot await
 *  IPC, so this queues them while a slow CPU feed is in flight, then sends a
 *  bounded PCM batch in capture order. closeAndDrain() is the stop barrier: all
 *  accepted audio reaches main before stream finalization starts.
 *  A Handy-style speech gate drops long thinking pauses before they are queued.
 *  Speech, pre-roll, and a hangover tail still reach the decoder. */
export class VoiceStreamFeedQueue {
  private readonly pending: Float32Array[] = [];
  private pendingSamples = 0;
  private inFlightSamples = 0;
  private draining: Promise<void> | null = null;
  private closed = false;
  private cancelled = false;
  private failure: unknown | null = null;

  constructor(
    private readonly send: (audio: ArrayBuffer) => Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly gate: SpeechGate = new SpeechGate(),
  ) {}

  push(pcm: Float32Array): boolean {
    if (this.closed || this.failure || pcm.length === 0) return false;
    const forwarded = this.gate.push(pcm);
    if (!forwarded || forwarded.length === 0) return false;
    return this.enqueue(forwarded);
  }

  async closeAndDrain(): Promise<void> {
    this.closed = true;
    const tail = this.gate.flush();
    if (tail && tail.length > 0 && !this.failure && !this.cancelled) this.enqueue(tail);
    while (this.draining) await this.draining;
    if (this.failure) throw this.failure;
  }

  /** Cancellation may discard audio that has not been sent. It never waits for
   *  a slow native feed, so unmount and session changes remain responsive. */
  cancel(): void {
    this.closed = true;
    this.cancelled = true;
    this.pending.length = 0;
    this.pendingSamples = 0;
  }

  private enqueue(pcm: Float32Array): boolean {
    if (this.failure || this.cancelled || pcm.length === 0) return false;
    if (this.pendingSamples + this.inFlightSamples + pcm.length > MAX_VOICE_STREAM_BACKLOG_SAMPLES) {
      this.fail(new Error('Live transcription cannot keep up with this computer. Try a shorter recording or a faster voice model.'));
      return false;
    }
    this.pending.push(pcm);
    this.pendingSamples += pcm.length;
    this.startDrain();
    return true;
  }

  private startDrain(): void {
    if (this.draining || this.failure || this.cancelled) return;
    this.draining = this.drain().finally(() => {
      this.draining = null;
      if (this.pending.length > 0 && !this.failure && !this.cancelled) this.startDrain();
    });
  }

  private async drain(): Promise<void> {
    while (!this.cancelled && this.pending.length > 0) {
      const batch = this.takeBatch();
      this.inFlightSamples = batch.length;
      try {
        const audio = batch.buffer.slice(batch.byteOffset, batch.byteOffset + batch.byteLength) as ArrayBuffer;
        await this.send(audio);
      } catch (error) {
        if (!this.cancelled) this.fail(error);
        return;
      } finally {
        this.inFlightSamples = 0;
      }
    }
  }

  private takeBatch(): Float32Array {
    const chunks = takeSampleBatch(
      this.pending,
      MAX_VOICE_STREAM_BATCH_SAMPLES,
      (chunk) => chunk.length,
      (chunk) => { this.pendingSamples -= chunk.length; },
    );
    return combineSampleBatch(chunks, (chunk) => chunk);
  }

  private fail(error: unknown): void {
    if (this.failure || this.cancelled) return;
    this.failure = error;
    this.closed = true;
    this.pending.length = 0;
    this.pendingSamples = 0;
    this.onError(error);
  }
}

const WORKLET_SOURCE = `
class DownsampleProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chunkSamples = (options.processorOptions && options.processorOptions.chunkSamples) || 4800;
    this.out = [];
    this.leftover = [];
    this.fraction = 0;
    this.ratio = ${TARGET_RATE} / sampleRate;
    this.stopped = false;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'flush' && !this.stopped) {
        this.stopped = true;
        if (this.out.length > 0) {
          const buffer = new Float32Array(this.out);
          this.out = [];
          this.port.postMessage(buffer, [buffer.buffer]);
        }
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }
  process(inputs) {
    if (this.stopped) return false;
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;
    if (sampleRate === ${TARGET_RATE}) {
      for (let i = 0; i < channel.length; i++) this.out.push(channel[i]);
    } else {
      const combined = this.leftover;
      for (let i = 0; i < channel.length; i++) combined.push(channel[i]);
      let pos = this.fraction;
      while (pos + 1 < combined.length) {
        const i0 = pos | 0;
        const frac = pos - i0;
        this.out.push(combined[i0] + (combined[i0 + 1] - combined[i0]) * frac);
        pos += 1 / this.ratio;
      }
      const consumed = pos | 0;
      this.leftover = combined.slice(consumed);
      this.fraction = pos - consumed;
    }
    while (this.out.length >= this.chunkSamples) {
      const chunk = this.out.splice(0, this.chunkSamples);
      const buffer = new Float32Array(chunk);
      this.port.postMessage(buffer, [buffer.buffer]);
    }
    return true;
  }
}
registerProcessor('${PROCESSOR_NAME}', DownsampleProcessor);
`;

/** Start capturing the microphone and emit ~chunkSamples-sized 16 kHz mono PCM.
 *  Throws the same DOMException shapes getUserMedia produces. */
export async function startVoiceStream(
  deviceId: string | null,
  chunkSamples: number,
  onChunk: (pcm: Float32Array) => void,
): Promise<VoiceStreamController> {
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') {
    throw new Error('Microphone streaming is not supported on this system.');
  }
  const preferred: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: preferred, video: false });
  } catch (error) {
    if (!deviceId || !(error instanceof DOMException) || !['NotFoundError', 'OverconstrainedError'].includes(error.name)) throw error;
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  }

  let context: AudioContext;
  try {
    // Let Chromium perform its native, band-limited conversion when the device
    // supports a 16 kHz graph. The worklet keeps its resampler as a fallback.
    context = new AudioContext({ sampleRate: TARGET_RATE });
  } catch {
    context = new AudioContext();
  }
  let source: MediaStreamAudioSourceNode;
  let node: AudioWorkletNode;
  let mute: GainNode;
  let resolveFlush: (() => void) | null = null;
  let processorFailed = false;
  try {
    await context.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' })));
    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: { chunkSamples },
    });
    node.port.onmessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type === 'flushed') {
        resolveFlush?.();
        resolveFlush = null;
        return;
      }
      if (event.data instanceof Float32Array) onChunk(event.data);
    };
    node.onprocessorerror = () => {
      processorFailed = true;
      resolveFlush?.();
    };
    mute = context.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute);
    mute.connect(context.destination);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    await context.close().catch(() => undefined);
    throw error;
  }

  let stopping: Promise<void> | null = null;
  return {
    stop: () => {
      stopping ??= (async () => {
        if (!processorFailed) {
          await new Promise<void>((resolve) => {
            resolveFlush = resolve;
            try { node.port.postMessage({ type: 'flush' }); } catch { resolve(); }
          });
        }
        node.port.onmessage = null;
        node.onprocessorerror = null;
        try { source.disconnect(); node.disconnect(); mute.disconnect(); } catch { /* graph already torn down */ }
        stream.getTracks().forEach((track) => track.stop());
        await context.close().catch(() => undefined);
      })();
      return stopping;
    },
  };
}
