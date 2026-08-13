import { afterEach, describe, expect, it, vi } from 'vitest';
import { resampleVoiceAudio, resampleVoiceAudioOptimized } from './Composer';

const originalOfflineAudioContext = globalThis.OfflineAudioContext;
afterEach(() => {
  if (originalOfflineAudioContext) vi.stubGlobal('OfflineAudioContext', originalOfflineAudioContext);
  else Reflect.deleteProperty(globalThis, 'OfflineAudioContext');
});

describe('voice audio preparation', () => {
  it('mixes channels and resamples captured audio to 16 kHz mono', () => {
    const channels = [new Float32Array([1, 0, -1, 0]), new Float32Array([0, 1, 0, -1])];
    const buffer = {
      length: 4,
      numberOfChannels: 2,
      sampleRate: 8_000,
      getChannelData: (channel: number) => channels[channel]!,
    } as AudioBuffer;

    const output = resampleVoiceAudio(buffer);

    expect(output).toHaveLength(8);
    expect(output[0]).toBeCloseTo(0.5);
    expect(output[2]).toBeCloseTo(0.5);
    expect(output[4]).toBeCloseTo(-0.5);
  });

  it('reuses decoded PCM when it is already 16 kHz mono', () => {
    const samples = new Float32Array([0.25, -0.25]);
    const buffer = {
      length: samples.length,
      numberOfChannels: 1,
      sampleRate: 16_000,
      getChannelData: () => samples,
    } as unknown as AudioBuffer;

    expect(resampleVoiceAudio(buffer)).toBe(samples);
  });

  it('uses the asynchronous native Web Audio resampler when available without a second PCM copy', async () => {
    const rendered = new Float32Array([0.25, -0.25]);
    const startRendering = vi.fn(async () => ({ getChannelData: () => rendered }));
    vi.stubGlobal('OfflineAudioContext', class {
      destination = {};
      createBufferSource = () => ({ buffer: null, connect: vi.fn(), start: vi.fn() });
      startRendering = startRendering;
    });
    const buffer = { length: 6, numberOfChannels: 1, sampleRate: 48_000 } as AudioBuffer;

    const output = await resampleVoiceAudioOptimized(buffer);

    expect(startRendering).toHaveBeenCalledOnce();
    expect(output).toBe(rendered);
  });
});
