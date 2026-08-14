import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLogService } from '../logging/AppLogService';
import { MAX_SPEECH_STREAM_BACKLOG_SAMPLES, MAX_SPEECH_STREAM_FEED_SAMPLES } from '../../shared/speech';
import { SpeechService } from './SpeechService';
import type { SpeechModelDefinition } from './speechModels';

let directory = '';
const bytes = Buffer.from('verified-model');
const checksum = createHash('sha256').update(bytes).digest('hex');
const model: SpeechModelDefinition = {
  id: 'canary-flash', tier: 'mini', name: 'Mini', model: 'Test model', description: 'Test', detail: '14 B', bytes: bytes.length,
  fileName: 'mini.gguf', url: 'https://example.test/mini.gguf', sha256: checksum, streaming: false,
};
const definitions: readonly SpeechModelDefinition[] = [
  model,
  { ...model, id: 'parakeet-unified', tier: 'balanced', name: 'Medium', fileName: 'medium.gguf' },
  { ...model, id: 'cohere-transcribe', tier: 'max', name: 'Max', fileName: 'max.gguf' },
];

beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'fate-speech-')); });
afterEach(async () => {
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

async function installTestModel(): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, model.fileName), bytes);
  await writeFile(path.join(directory, `${model.fileName}.verified`), `${checksum}\n`);
}

function fakeRuntime() {
  const disposeModel = vi.fn();
  const disposeSession = vi.fn();
  const run = vi.fn(async (_pcm: Float32Array, _options: { signal: AbortSignal }) => ({ text: 'fast transcript', language: 'en' }));
  const loaded = {
    backend: 'cpu', device: { name: 'CPU', description: 'CPU', deviceType: 'cpu' },
    createSession: vi.fn(() => ({ run, dispose: disposeSession })), dispose: disposeModel,
  };
  const runtime = {
    getAvailableBackends: vi.fn(() => [{ name: 'CPU', description: 'CPU', kind: 'cpu', deviceType: 'cpu' }]),
    TranscribeModel: { load: vi.fn(async () => loaded) },
  };
  return { runtime: runtime as unknown as typeof import('transcribe-cpp'), loaded, run, disposeModel, disposeSession };
}

describe('SpeechService model downloads', () => {
  it('resumes a partial download, verifies SHA-256, and installs atomically', async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'mini.gguf.partial'), bytes.subarray(0, 4));
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string> | undefined)?.Range).toBe('bytes=4-');
      return new Response(bytes.subarray(4), { status: 206 });
    }) as unknown as typeof fetch;
    const progress = vi.fn();
    const service = new SpeechService(new AppLogService(), directory, fetcher, definitions);
    service.setEventSink(progress);

    await service.download('canary-flash');

    expect(await readFile(path.join(directory, 'mini.gguf'))).toEqual(bytes);
    expect((await readFile(path.join(directory, 'mini.gguf.verified'), 'utf8')).trim()).toBe(checksum);
    await expect(stat(path.join(directory, 'mini.gguf.partial'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'canary-flash', state: 'installed' }));
  });

  it('never installs a model whose checksum does not match', async () => {
    const corrupted = Buffer.from('corrupt-model!');
    const fetcher = vi.fn(async () => new Response(corrupted, { status: 200 })) as unknown as typeof fetch;
    const service = new SpeechService(new AppLogService(), directory, fetcher, definitions);

    await expect(service.download('canary-flash')).rejects.toThrow('checksum');
    await expect(stat(path.join(directory, 'mini.gguf'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(directory, 'mini.gguf.partial'))).toEqual(corrupted);
  });

  it('cancels an active download without deleting its resumable partial state', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })) as unknown as typeof fetch;
    const progress = vi.fn();
    const service = new SpeechService(new AppLogService(), directory, fetcher, definitions);
    service.setEventSink(progress);

    const operation = service.download('canary-flash');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(service.cancelDownload('canary-flash')).toBe(true);
    await expect(operation).rejects.toThrow('cancelled');
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'canary-flash', state: 'cancelled' }));
  });

  it('coalesces concurrent requests for the same model', async () => {
    let resolveResponse!: () => void;
    const wait = new Promise<void>((resolve) => { resolveResponse = resolve; });
    const fetcher = vi.fn(async () => { await wait; return new Response(bytes, { status: 200 }); }) as unknown as typeof fetch;
    const service = new SpeechService(new AppLogService(), directory, fetcher, definitions);

    const first = service.download('canary-flash');
    const second = service.download('canary-flash');
    resolveResponse();
    await Promise.all([first, second]);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('aborts active model downloads during application shutdown', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })) as unknown as typeof fetch;
    const service = new SpeechService(new AppLogService(), directory, fetcher, definitions);

    const operation = service.download('canary-flash');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await service.dispose();

    await expect(operation).rejects.toThrow('cancelled');
  });
});

describe('SpeechService backend selection', () => {
  it('forces CPU for streaming models on the macOS Metal backend but keeps batch models accelerated', async () => {
    await installTestModel();
    await mkdir(directory, { recursive: true });
    const streamingModel: SpeechModelDefinition = { ...model, id: 'parakeet-unified', fileName: 'streaming.gguf', streaming: true, streamFamily: { kind: 'parakeet_buffered' as const } };
    const batchModel: SpeechModelDefinition = { ...model, id: 'canary-flash', fileName: 'mini.gguf' };
    const definitions: readonly SpeechModelDefinition[] = [batchModel, streamingModel];
    await writeFile(path.join(directory, 'streaming.gguf'), bytes);
    await writeFile(path.join(directory, 'streaming.gguf.verified'), `${checksum}\n`);

    const loadCalls: { backend?: string }[] = [];
    const run = vi.fn(async () => ({ text: 'transcript', language: 'en' }));
    const loaded = {
      backend: 'cpu',
      device: { name: 'CPU', description: 'CPU', deviceType: 'cpu' },
      createSession: vi.fn(() => ({ run, dispose: vi.fn() })),
      dispose: vi.fn(),
    };
    const runtime = {
      getAvailableBackends: vi.fn(() => [
        { name: 'Apple M2', description: 'Metal', kind: 'metal', deviceType: 'gpu' },
        { name: 'CPU', description: 'CPU', kind: 'cpu', deviceType: 'cpu' },
      ]),
      TranscribeModel: { load: vi.fn(async (_file: string, opts?: { backend?: string }) => { loadCalls.push(opts ?? {}); return loaded; }) },
    };
    const service = new SpeechService(new AppLogService(), directory, fetch, definitions, async () => runtime as unknown as typeof import('transcribe-cpp'));

    await service.transcribe('parakeet-unified', new Float32Array([0]).buffer); // streaming -> CPU (Metal avoided)
    await service.transcribe('canary-flash', new Float32Array([0]).buffer);     // batch -> auto (Metal allowed)

    expect(loadCalls[0]).toMatchObject({ backend: 'cpu' });
    expect(loadCalls[1]).toMatchObject({ backend: 'auto' });
    await service.dispose();
  });
});

describe('SpeechService model lifecycle', () => {
  it('caches the native backend probe instead of reinitializing it on every status refresh', async () => {
    const fake = fakeRuntime();
    const service = new SpeechService(new AppLogService(), directory, fetch, definitions, async () => fake.runtime);

    await service.getStatus();
    await service.getStatus();

    expect(fake.runtime.getAvailableBackends).toHaveBeenCalledOnce();
    await service.dispose();
  });

  it('keeps a hot model loaded and resets the five-minute idle deadline after every use', async () => {
    vi.useFakeTimers();
    await installTestModel();
    const fake = fakeRuntime();
    const service = new SpeechService(new AppLogService(), directory, fetch, definitions, async () => fake.runtime);

    await service.transcribe('canary-flash', new Float32Array([0]).buffer);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await service.transcribe('canary-flash', new Float32Array([0]).buffer);
    expect(fake.runtime.TranscribeModel.load).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(fake.disposeModel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(fake.disposeModel).toHaveBeenCalledOnce();
    expect(fake.disposeSession).toHaveBeenCalledTimes(2);
  });

  it('unloads a hot model immediately when the service is disposed', async () => {
    await installTestModel();
    const fake = fakeRuntime();
    const service = new SpeechService(new AppLogService(), directory, fetch, definitions, async () => fake.runtime);

    await service.transcribe('canary-flash', new Float32Array([0]).buffer);
    const disposing = service.dispose();

    expect(fake.disposeModel).toHaveBeenCalledOnce();
    await disposing;
  });

  it('aborts and settles an active transcription before unloading on quit', async () => {
    await installTestModel();
    const fake = fakeRuntime();
    fake.run.mockImplementation(async (_pcm, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const service = new SpeechService(new AppLogService(), directory, fetch, definitions, async () => fake.runtime);

    const transcription = service.transcribe('canary-flash', new Float32Array([0]).buffer);
    await vi.waitFor(() => expect(fake.run).toHaveBeenCalledOnce());
    const disposing = service.dispose();
    expect(fake.disposeModel).not.toHaveBeenCalled();
    await expect(transcription).rejects.toThrow('Aborted');
    await disposing;
    expect(fake.disposeModel).toHaveBeenCalledOnce();
  });
});

describe('SpeechService live streaming', () => {
  it('starts, feeds, and finalizes a streaming session and emits committed text', async () => {
    await installTestModel();
    await writeFile(path.join(directory, 'balanced.gguf'), bytes);
    await writeFile(path.join(directory, 'balanced.gguf.verified'), `${checksum}\n`);
    const streamingModel: SpeechModelDefinition = { ...model, id: 'parakeet-unified', fileName: 'balanced.gguf', streaming: true, streamFamily: { kind: 'parakeet_buffered' as const } };
    const definitions: readonly SpeechModelDefinition[] = [streamingModel];

    const stream = {
      feed: vi.fn(async (_pcm: Float32Array) => ({ resultChanged: true, isFinal: false, revision: 1, inputReceivedMs: 0, audioCommittedMs: 0, bufferedMs: 0, committedChanged: true, tentativeChanged: false })),
      finalize: vi.fn(async () => ({ resultChanged: true, isFinal: true, revision: 2, inputReceivedMs: 0, audioCommittedMs: 0, bufferedMs: 0, committedChanged: true, tentativeChanged: false })),
      get text() { return { committed: 'hello world', tentative: '' }; },
      reset: vi.fn(),
    };
    const run = vi.fn(async (_pcm: Float32Array) => ({ text: 'hello from the full recording', language: 'en' }));
    const session = { stream: vi.fn(async () => stream), run, dispose: vi.fn() };
    const loaded = {
      backend: 'cpu',
      device: { name: 'CPU', description: 'CPU', deviceType: 'cpu' },
      createSession: vi.fn(() => session),
      dispose: vi.fn(),
    };
    const runtime = {
      getAvailableBackends: vi.fn(() => [{ name: 'CPU', description: 'CPU', kind: 'cpu', deviceType: 'cpu' }]),
      TranscribeModel: { load: vi.fn(async () => loaded) },
    } as unknown as typeof import('transcribe-cpp');

    const updates: { state: string; committed: string }[] = [];
    const service = new SpeechService(new AppLogService(), directory, fetch, definitions, async () => runtime);
    service.setStreamSink((update) => updates.push({ state: update.state, committed: update.committed }));

    // refine=true keeps the legacy behavior for this test: a full-recording
    // accuracy pass at stop. Default is now opt-in (CPU calm).
    await service.streamStart('parakeet-unified', 'en', true);
    // Performance regression: use transcribe.cpp's trained Parakeet defaults.
    // The old 5.6 s / 160 ms override forced frequent CPU decode calls, which
    // fell behind live audio after only a few words.
    expect(session.stream).toHaveBeenCalledWith(expect.objectContaining({ commitPolicy: 'stable_prefix', family: { kind: 'parakeet_buffered' } }));
    expect(updates.at(-1)).toMatchObject({ state: 'active' });

    await service.streamFeed(new Float32Array([0, 0, 0, 0]).buffer);
    expect(stream.feed).toHaveBeenCalledOnce();
    expect(updates.at(-1)).toMatchObject({ state: 'active', committed: 'hello world' });

    await service.streamStop();
    expect(stream.finalize).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(new Float32Array([0, 0, 0, 0]), expect.objectContaining({ language: 'en', timestamps: 'none', signal: expect.any(AbortSignal) }));
    expect(stream.finalize.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0]!);
    expect(session.dispose).toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ state: 'final', committed: 'hello from the full recording' });
    await service.dispose();
  });

  it('refuses streaming on a batch-only model', async () => {
    await installTestModel();
    const batchModel: SpeechModelDefinition = { ...model, id: 'canary-flash', fileName: 'mini.gguf', streaming: false };
    const service = new SpeechService(new AppLogService(), directory, fetch, [batchModel], async () => ({
      getAvailableBackends: () => [{ name: 'CPU', description: 'CPU', kind: 'cpu', deviceType: 'cpu' }],
      TranscribeModel: { load: vi.fn() },
    } as unknown as typeof import('transcribe-cpp')));
    await expect(service.streamStart('canary-flash', 'en')).rejects.toThrow('streaming');
    await service.dispose();
  });

  it('serializes concurrent feeds so a text read never overlaps an in-flight feed', async () => {
    await installTestModel();
    await writeFile(path.join(directory, 'balanced.gguf'), bytes);
    await writeFile(path.join(directory, 'balanced.gguf.verified'), `${checksum}\n`);
    const streamingModel: SpeechModelDefinition = { ...model, id: 'parakeet-unified', fileName: 'balanced.gguf', streaming: true, streamFamily: { kind: 'parakeet_buffered' as const } };
    const definitions: readonly SpeechModelDefinition[] = [streamingModel];

    // Model the transcribe.cpp stream contract: a feed()/finalize() computes on
    // a worker thread and text reads are rejected while one is in flight. The
    // renderer dispatches one feed per worklet message without waiting, so a
    // naive implementation lets two feeds overlap and the second read throws.
    let feeding = 0;
    const stream = {
      feed: vi.fn(async (_pcm: Float32Array) => {
        feeding += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        feeding -= 1;
        return { resultChanged: true, isFinal: false, revision: 1, inputReceivedMs: 0, audioCommittedMs: 0, bufferedMs: 0, committedChanged: true, tentativeChanged: false };
      }),
      finalize: vi.fn(async () => ({ resultChanged: true, isFinal: true, revision: 2, inputReceivedMs: 0, audioCommittedMs: 0, bufferedMs: 0, committedChanged: true, tentativeChanged: false })),
      get text() {
        if (feeding > 0) throw new Error('cannot read stream text while a feed()/finalize() is in flight; await it first');
        return { committed: 'hello world', tentative: '' };
      },
      reset: vi.fn(),
    };
    const session = { stream: vi.fn(async () => stream), run: vi.fn(async () => ({ text: 'hello world', language: 'en' })), dispose: vi.fn() };
    const loaded = {
      backend: 'cpu',
      device: { name: 'CPU', description: 'CPU', deviceType: 'cpu' },
      createSession: vi.fn(() => session),
      dispose: vi.fn(),
    };
    const runtime = {
      getAvailableBackends: vi.fn(() => [{ name: 'CPU', description: 'CPU', kind: 'cpu', deviceType: 'cpu' }]),
      TranscribeModel: { load: vi.fn(async () => loaded) },
    } as unknown as typeof import('transcribe-cpp');

    const updates: { state: string; committed: string }[] = [];
    const service = new SpeechService(new AppLogService(), directory, fetch, definitions, async () => runtime);
    service.setStreamSink((update) => updates.push({ state: update.state, committed: update.committed }));

    await service.streamStart('parakeet-unified', 'en');
    const chunk = new Float32Array([0, 0, 0, 0]).buffer;
    const feeds = [
      service.streamFeed(chunk),
      service.streamFeed(chunk),
      service.streamFeed(chunk),
    ];
    // Stop may arrive before renderer IPC responses for the last chunks. It
    // must queue behind those feeds rather than finalize early or race a read.
    const stopping = service.streamStop();
    await expect(Promise.all([...feeds, stopping])).resolves.toHaveLength(4);
    // The first feed starts immediately; later captures that arrive while it
    // computes share one ordered native batch.
    expect(stream.feed).toHaveBeenCalledTimes(2);
    expect(updates.filter((update) => update.state === 'active' && update.committed === 'hello world')).toHaveLength(2);
    expect(stream.finalize).toHaveBeenCalledOnce();
    expect(updates.at(-1)).toMatchObject({ state: 'final' });
    await service.dispose();
  });

  it('fails a sustained native backlog instead of retaining unlimited audio', async () => {
    await installTestModel();
    await writeFile(path.join(directory, 'balanced.gguf'), bytes);
    await writeFile(path.join(directory, 'balanced.gguf.verified'), `${checksum}\n`);
    const streamingModel: SpeechModelDefinition = { ...model, id: 'parakeet-unified', fileName: 'balanced.gguf', streaming: true, streamFamily: { kind: 'parakeet_buffered' as const } };
    const definitions: readonly SpeechModelDefinition[] = [streamingModel];
    let releaseFirstFeed!: () => void;
    const firstFeed = new Promise<void>((resolve) => { releaseFirstFeed = resolve; });
    const stream = {
      feed: vi.fn(async () => {
        await firstFeed;
        return { resultChanged: true, isFinal: false, revision: 1, inputReceivedMs: 0, audioCommittedMs: 0, bufferedMs: 0, committedChanged: true, tentativeChanged: false };
      }),
      finalize: vi.fn(),
      get text() { return { committed: '', tentative: '' }; },
      reset: vi.fn(),
    };
    const session = { stream: vi.fn(async () => stream), dispose: vi.fn() };
    const loaded = {
      backend: 'cpu',
      device: { name: 'CPU', description: 'CPU', deviceType: 'cpu' },
      createSession: vi.fn(() => session),
      dispose: vi.fn(),
    };
    const runtime = {
      getAvailableBackends: vi.fn(() => [{ name: 'CPU', description: 'CPU', kind: 'cpu', deviceType: 'cpu' }]),
      TranscribeModel: { load: vi.fn(async () => loaded) },
    } as unknown as typeof import('transcribe-cpp');
    const updates: { state: string; error: string | undefined }[] = [];
    const service = new SpeechService(new AppLogService(), directory, fetch, definitions, async () => runtime);
    service.setStreamSink((update) => updates.push({ state: update.state, error: update.error }));

    await service.streamStart('parakeet-unified', 'en');
    const feed = (value: number) => service.streamFeed(new Float32Array(MAX_SPEECH_STREAM_FEED_SAMPLES).fill(value).buffer);
    const first = feed(1);
    await vi.waitFor(() => expect(stream.feed).toHaveBeenCalledOnce());
    const accepted = Array.from(
      { length: MAX_SPEECH_STREAM_BACKLOG_SAMPLES / MAX_SPEECH_STREAM_FEED_SAMPLES - 1 },
      (_, index) => feed(index + 2),
    );
    const acceptedSettled = Promise.allSettled(accepted);

    await expect(feed(99)).rejects.toThrow('cannot keep up');
    await expect(acceptedSettled).resolves.toEqual(Array.from({ length: accepted.length }, () => expect.objectContaining({ status: 'rejected' })));
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(updates).toContainEqual(expect.objectContaining({ state: 'error', error: expect.stringContaining('cannot keep up') }));

    releaseFirstFeed();
    await expect(first).resolves.toBeUndefined();
    expect(stream.feed).toHaveBeenCalledOnce();
    await service.dispose();
  });

  it('coalesces a slow CPU backlog without dropping audio before finalizing', async () => {
    await installTestModel();
    await writeFile(path.join(directory, 'balanced.gguf'), bytes);
    await writeFile(path.join(directory, 'balanced.gguf.verified'), `${checksum}\n`);
    const streamingModel: SpeechModelDefinition = { ...model, id: 'parakeet-unified', fileName: 'balanced.gguf', streaming: true, streamFamily: { kind: 'parakeet_buffered' as const } };
    const definitions: readonly SpeechModelDefinition[] = [streamingModel];
    let releaseFirstFeed!: () => void;
    const firstFeed = new Promise<void>((resolve) => { releaseFirstFeed = resolve; });
    const nativeBatches: Float32Array[] = [];
    let feedCount = 0;
    const stream = {
      feed: vi.fn(async (pcm: Float32Array) => {
        nativeBatches.push(pcm.slice());
        feedCount += 1;
        if (feedCount === 1) await firstFeed;
        return { resultChanged: true, isFinal: false, revision: feedCount, inputReceivedMs: 0, audioCommittedMs: 0, bufferedMs: 0, committedChanged: true, tentativeChanged: false };
      }),
      finalize: vi.fn(async () => ({ resultChanged: true, isFinal: true, revision: 9, inputReceivedMs: 0, audioCommittedMs: 0, bufferedMs: 0, committedChanged: true, tentativeChanged: false })),
      get text() { return { committed: 'queued audio', tentative: '' }; },
      reset: vi.fn(),
    };
    const session = { stream: vi.fn(async () => stream), run: vi.fn(async () => ({ text: 'queued audio', language: 'en' })), dispose: vi.fn() };
    const loaded = {
      backend: 'cpu',
      device: { name: 'CPU', description: 'CPU', deviceType: 'cpu' },
      createSession: vi.fn(() => session),
      dispose: vi.fn(),
    };
    const runtime = {
      getAvailableBackends: vi.fn(() => [{ name: 'CPU', description: 'CPU', kind: 'cpu', deviceType: 'cpu' }]),
      TranscribeModel: { load: vi.fn(async () => loaded) },
    } as unknown as typeof import('transcribe-cpp');
    const service = new SpeechService(new AppLogService(), directory, fetch, definitions, async () => runtime);

    await service.streamStart('parakeet-unified', 'en');
    const chunkSamples = 4_800;
    const feeds = Array.from({ length: 8 }, (_, index) => service.streamFeed(new Float32Array(chunkSamples).fill(index + 1).buffer));
    await vi.waitFor(() => expect(stream.feed).toHaveBeenCalledOnce());
    const stopping = service.streamStop();
    expect(stream.finalize).not.toHaveBeenCalled();

    releaseFirstFeed();
    await Promise.all([...feeds, stopping]);

    expect(stream.feed).toHaveBeenCalledTimes(3);
    expect(nativeBatches.map((batch) => batch.length)).toEqual([chunkSamples, chunkSamples * 6, chunkSamples]);
    const pcm = new Float32Array(nativeBatches.reduce((total, batch) => total + batch.length, 0));
    let offset = 0;
    for (const batch of nativeBatches) {
      pcm.set(batch, offset);
      offset += batch.length;
    }
    expect(pcm).toHaveLength(chunkSamples * 8);
    expect(Array.from({ length: 8 }, (_, index) => pcm[index * chunkSamples]!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(stream.finalize).toHaveBeenCalledOnce();
    await service.dispose();
  });

  it('seals and finalizes at the three-minute limit instead of failing the stream', async () => {
    await installTestModel();
    await writeFile(path.join(directory, 'balanced.gguf'), bytes);
    await writeFile(path.join(directory, 'balanced.gguf.verified'), `${checksum}\n`);
    const streamingModel: SpeechModelDefinition = { ...model, id: 'parakeet-unified', fileName: 'balanced.gguf', streaming: true, streamFamily: { kind: 'parakeet_buffered' as const } };
    const definitions: readonly SpeechModelDefinition[] = [streamingModel];
    const runLengths: number[] = [];
    const stream = {
      feed: vi.fn(async () => ({ resultChanged: true, isFinal: false, revision: 1, inputReceivedMs: 0, audioCommittedMs: 0, bufferedMs: 0, committedChanged: true, tentativeChanged: false })),
      finalize: vi.fn(async () => ({ resultChanged: true, isFinal: true, revision: 2, inputReceivedMs: 0, audioCommittedMs: 0, bufferedMs: 0, committedChanged: true, tentativeChanged: false })),
      get text() { return { committed: 'ninety nine captures', tentative: '' }; },
      reset: vi.fn(),
    };
    const session = {
      stream: vi.fn(async () => stream),
      run: vi.fn(async (pcm: Float32Array) => { runLengths.push(pcm.length); return { text: 'full recording text', language: 'en' }; }),
      dispose: vi.fn(),
    };
    const loaded = {
      backend: 'cpu', device: { name: 'CPU', description: 'CPU', deviceType: 'cpu' },
      createSession: vi.fn(() => session), dispose: vi.fn(),
    };
    const runtime = {
      getAvailableBackends: vi.fn(() => [{ name: 'CPU', description: 'CPU', kind: 'cpu', deviceType: 'cpu' }]),
      TranscribeModel: { load: vi.fn(async () => loaded) },
    } as unknown as typeof import('transcribe-cpp');
    const updates: { state: string; committed: string }[] = [];
    const service = new SpeechService(new AppLogService(), directory, fetch, definitions, async () => runtime);
    service.setStreamSink((update) => updates.push({ state: update.state, committed: update.committed }));

    await service.streamStart('parakeet-unified', 'en', true);
    const chunkSamples = MAX_SPEECH_STREAM_FEED_SAMPLES * 0.9; // 1.8 s captures
    for (let index = 0; index < 99; index += 1) {
      await service.streamFeed(new Float32Array(chunkSamples).buffer);
    }
    // The next capture exceeds the 180 s cap. The part that still fits is kept
    // and the stream seals and finalizes; nothing is rejected.
    await expect(service.streamFeed(new Float32Array(chunkSamples + 1_600).buffer)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(updates.at(-1)).toMatchObject({ state: 'final', committed: 'full recording text' }));
    expect(updates).toContainEqual(expect.objectContaining({ state: 'finalizing' }));
    expect(stream.finalize).toHaveBeenCalledOnce();
    expect(runLengths).toEqual([16_000 * 180]);
    // Audio that arrives after the seal is dropped silently, never an error.
    await expect(service.streamFeed(new Float32Array(4).buffer)).resolves.toBeUndefined();
    // A delayed renderer stop for the already-finished stream resolves quietly.
    await expect(service.streamStop()).resolves.toBeUndefined();
    await service.dispose();
  });

  it('keeps the streamed text when the final accuracy pass exceeds its time budget', async () => {
    await installTestModel();
    await writeFile(path.join(directory, 'balanced.gguf'), bytes);
    await writeFile(path.join(directory, 'balanced.gguf.verified'), `${checksum}\n`);
    const streamingModel: SpeechModelDefinition = { ...model, id: 'parakeet-unified', fileName: 'balanced.gguf', streaming: true, streamFamily: { kind: 'parakeet_buffered' as const } };
    const definitions: readonly SpeechModelDefinition[] = [streamingModel];
    const stream = {
      feed: vi.fn(async () => ({ resultChanged: true, isFinal: false, revision: 1, inputReceivedMs: 0, audioCommittedMs: 0, bufferedMs: 0, committedChanged: true, tentativeChanged: false })),
      finalize: vi.fn(async () => ({ resultChanged: true, isFinal: true, revision: 2, inputReceivedMs: 0, audioCommittedMs: 0, bufferedMs: 0, committedChanged: true, tentativeChanged: false })),
      get text() { return { committed: 'streamed words', tentative: '' }; },
      reset: vi.fn(),
    };
    // The refinement run hangs until aborted, like a CPU pass that cannot keep up.
    const run = vi.fn((_pcm: Float32Array, options: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const session = { stream: vi.fn(async () => stream), run, dispose: vi.fn() };
    const loaded = {
      backend: 'cpu', device: { name: 'CPU', description: 'CPU', deviceType: 'cpu' },
      createSession: vi.fn(() => session), dispose: vi.fn(),
    };
    const runtime = {
      getAvailableBackends: vi.fn(() => [{ name: 'CPU', description: 'CPU', kind: 'cpu', deviceType: 'cpu' }]),
      TranscribeModel: { load: vi.fn(async () => loaded) },
    } as unknown as typeof import('transcribe-cpp');
    const updates: { state: string; committed: string }[] = [];
    const service = new SpeechService(new AppLogService(), directory, fetch, definitions, async () => runtime);
    service.setStreamSink((update) => updates.push({ state: update.state, committed: update.committed }));

    await service.streamStart('parakeet-unified', 'en', true);
    await service.streamFeed(new Float32Array(4).buffer);
    vi.useFakeTimers();
    const stopping = service.streamStop();
    // The 20 s floor is the budget for this tiny recording; the timeout aborts
    // the pass and the streamed text is kept instead of hanging the stop.
    await vi.advanceTimersByTimeAsync(21_000);
    await expect(stopping).resolves.toBeUndefined();
    expect(updates).toContainEqual(expect.objectContaining({ state: 'finalizing', committed: 'streamed words' }));
    expect(updates.at(-1)).toMatchObject({ state: 'final', committed: 'streamed words' });
    await service.dispose();
  });

  it('carries the last committed text on backlog failure and cancellation events', async () => {
    await installTestModel();
    await writeFile(path.join(directory, 'balanced.gguf'), bytes);
    await writeFile(path.join(directory, 'balanced.gguf.verified'), `${checksum}\n`);
    const streamingModel: SpeechModelDefinition = { ...model, id: 'parakeet-unified', fileName: 'balanced.gguf', streaming: true, streamFamily: { kind: 'parakeet_buffered' as const } };
    const definitions: readonly SpeechModelDefinition[] = [streamingModel];
    let feedGate: Promise<void> | null = null;
    const stream = {
      feed: vi.fn(async () => {
        if (feedGate) await feedGate;
        return { resultChanged: true, isFinal: false, revision: 1, inputReceivedMs: 0, audioCommittedMs: 0, bufferedMs: 0, committedChanged: true, tentativeChanged: false };
      }),
      finalize: vi.fn(),
      get text() { return { committed: 'partial words', tentative: '' }; },
      reset: vi.fn(),
    };
    const session = { stream: vi.fn(async () => stream), run: vi.fn(), dispose: vi.fn() };
    const loaded = {
      backend: 'cpu', device: { name: 'CPU', description: 'CPU', deviceType: 'cpu' },
      createSession: vi.fn(() => session), dispose: vi.fn(),
    };
    const runtime = {
      getAvailableBackends: vi.fn(() => [{ name: 'CPU', description: 'CPU', kind: 'cpu', deviceType: 'cpu' }]),
      TranscribeModel: { load: vi.fn(async () => loaded) },
    } as unknown as typeof import('transcribe-cpp');
    const updates: { state: string; committed: string; error?: string | undefined }[] = [];
    const service = new SpeechService(new AppLogService(), directory, fetch, definitions, async () => runtime);
    service.setStreamSink((update) => updates.push({ state: update.state, committed: update.committed, error: update.error }));

    // Failure path: the error event keeps the text the user already saw.
    await service.streamStart('parakeet-unified', 'en');
    // One ungated feed first, so committed text is read and recorded.
    await service.streamFeed(new Float32Array(4).buffer);
    let releaseGate!: () => void;
    feedGate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const blocked = service.streamFeed(new Float32Array(MAX_SPEECH_STREAM_FEED_SAMPLES).buffer);
    await vi.waitFor(() => expect(stream.feed).toHaveBeenCalledTimes(2));
    const oversubscribed = Array.from(
      { length: MAX_SPEECH_STREAM_BACKLOG_SAMPLES / MAX_SPEECH_STREAM_FEED_SAMPLES },
      () => service.streamFeed(new Float32Array(MAX_SPEECH_STREAM_FEED_SAMPLES).buffer).catch(() => undefined),
    );
    await Promise.all(oversubscribed);
    expect(updates).toContainEqual(expect.objectContaining({ state: 'error', committed: 'partial words', error: expect.stringContaining('cannot keep up') }));
    // The in-flight capture settles quietly once the native feed returns.
    releaseGate();
    await expect(blocked).resolves.toBeUndefined();

    // Cancellation path: the cancelled event keeps the committed text too.
    feedGate = null;
    releaseGate = () => undefined;
    await service.streamStart('parakeet-unified', 'en');
    await service.streamFeed(new Float32Array(4).buffer);
    await service.streamCancel();
    expect(updates).toContainEqual(expect.objectContaining({ state: 'cancelled', committed: 'partial words' }));
    await service.dispose();
  });
});
