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

export interface VoiceStreamController {
  /** Stop the mic, tear down the audio graph, and close the context. */
  stop: () => void;
}

const PROCESSOR_NAME = 'fate-voice-downsample';
const TARGET_RATE = 16_000;

const WORKLET_SOURCE = `
class DownsampleProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chunkSamples = (options.processorOptions && options.processorOptions.chunkSamples) || 4800;
    this.out = [];
    this.leftover = [];
    this.fraction = 0;
    this.ratio = ${TARGET_RATE} / sampleRate;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;
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

  const context = new AudioContext();
  let source: MediaStreamAudioSourceNode;
  let node: AudioWorkletNode;
  let mute: GainNode;
  try {
    await context.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' })));
    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: { chunkSamples },
    });
    node.port.onmessage = (event: MessageEvent) => onChunk(event.data as Float32Array);
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

  return {
    stop: () => {
      node.port.onmessage = null;
      try { source.disconnect(); node.disconnect(); mute.disconnect(); } catch { /* graph already torn down */ }
      stream.getTracks().forEach((track) => track.stop());
      void context.close().catch(() => undefined);
    },
  };
}
