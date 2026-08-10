import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLogService } from '../logging/AppLogService';
import { SpeechService } from './SpeechService';
import type { SpeechModelDefinition } from './speechModels';

let directory = '';
const bytes = Buffer.from('verified-model');
const checksum = createHash('sha256').update(bytes).digest('hex');
const model: SpeechModelDefinition = {
  id: 'mini', tier: 'mini', name: 'Mini', model: 'Test model', description: 'Test', detail: '14 B', bytes: bytes.length,
  fileName: 'mini.gguf', url: 'https://example.test/mini.gguf', sha256: checksum, streaming: false,
};
const definitions: readonly SpeechModelDefinition[] = [
  model,
  { ...model, id: 'balanced', tier: 'balanced', name: 'Medium', fileName: 'medium.gguf' },
  { ...model, id: 'max', tier: 'max', name: 'Max', fileName: 'max.gguf' },
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

    await service.download('mini');

    expect(await readFile(path.join(directory, 'mini.gguf'))).toEqual(bytes);
    expect((await readFile(path.join(directory, 'mini.gguf.verified'), 'utf8')).trim()).toBe(checksum);
    await expect(stat(path.join(directory, 'mini.gguf.partial'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'mini', state: 'installed' }));
  });

  it('never installs a model whose checksum does not match', async () => {
    const corrupted = Buffer.from('corrupt-model!');
    const fetcher = vi.fn(async () => new Response(corrupted, { status: 200 })) as unknown as typeof fetch;
    const service = new SpeechService(new AppLogService(), directory, fetcher, definitions);

    await expect(service.download('mini')).rejects.toThrow('checksum');
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

    const operation = service.download('mini');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(service.cancelDownload('mini')).toBe(true);
    await expect(operation).rejects.toThrow('cancelled');
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'mini', state: 'cancelled' }));
  });

  it('coalesces concurrent requests for the same model', async () => {
    let resolveResponse!: () => void;
    const wait = new Promise<void>((resolve) => { resolveResponse = resolve; });
    const fetcher = vi.fn(async () => { await wait; return new Response(bytes, { status: 200 }); }) as unknown as typeof fetch;
    const service = new SpeechService(new AppLogService(), directory, fetcher, definitions);

    const first = service.download('mini');
    const second = service.download('mini');
    resolveResponse();
    await Promise.all([first, second]);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('aborts active model downloads during application shutdown', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })) as unknown as typeof fetch;
    const service = new SpeechService(new AppLogService(), directory, fetcher, definitions);

    const operation = service.download('mini');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await service.dispose();

    await expect(operation).rejects.toThrow('cancelled');
  });
});

describe('SpeechService backend selection', () => {
  it('forces CPU for streaming models on the macOS Metal backend but keeps batch models accelerated', async () => {
    await installTestModel();
    await mkdir(directory, { recursive: true });
    const streamingModel: SpeechModelDefinition = { ...model, id: 'balanced', fileName: 'streaming.gguf', streaming: true };
    const batchModel: SpeechModelDefinition = { ...model, id: 'mini', fileName: 'mini.gguf' };
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

    await service.transcribe('balanced', new Float32Array([0]).buffer); // streaming -> CPU (Metal avoided)
    await service.transcribe('mini', new Float32Array([0]).buffer);     // batch -> auto (Metal allowed)

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

    await service.transcribe('mini', new Float32Array([0]).buffer);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await service.transcribe('mini', new Float32Array([0]).buffer);
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

    await service.transcribe('mini', new Float32Array([0]).buffer);
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

    const transcription = service.transcribe('mini', new Float32Array([0]).buffer);
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
    const streamingModel: SpeechModelDefinition = { ...model, id: 'balanced', fileName: 'balanced.gguf', streaming: true };
    const definitions: readonly SpeechModelDefinition[] = [streamingModel];

    const stream = {
      feed: vi.fn(async (_pcm: Float32Array) => ({ resultChanged: true, isFinal: false, revision: 1, inputReceivedMs: 0, audioCommittedMs: 0, bufferedMs: 0, committedChanged: true, tentativeChanged: false })),
      finalize: vi.fn(async () => ({ resultChanged: true, isFinal: true, revision: 2, inputReceivedMs: 0, audioCommittedMs: 0, bufferedMs: 0, committedChanged: true, tentativeChanged: false })),
      get text() { return { committed: 'hello world', tentative: '' }; },
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

    const updates: { state: string; committed: string }[] = [];
    const service = new SpeechService(new AppLogService(), directory, fetch, definitions, async () => runtime);
    service.setStreamSink((update) => updates.push({ state: update.state, committed: update.committed }));

    await service.streamStart('balanced', 'en');
    // BUG regression: the buffered-stream window must be a valid (left, chunk,
    // right) menu tuple — multiples of the 80 ms encoder frame. The old 300 ms
    // chunk made transcribe_stream_begin return TRANSCRIBE_ERR_INVALID_ARG.
    expect(session.stream).toHaveBeenCalledWith(expect.objectContaining({ commitPolicy: 'stable_prefix', family: expect.objectContaining({ kind: 'parakeet_buffered', leftMs: 5_600, chunkMs: 160, rightMs: 160 }) }));
    expect(updates.at(-1)).toMatchObject({ state: 'active' });

    await service.streamFeed(new Float32Array([0, 0, 0, 0]).buffer);
    expect(stream.feed).toHaveBeenCalledOnce();
    expect(updates.at(-1)).toMatchObject({ state: 'active', committed: 'hello world' });

    await service.streamStop();
    expect(stream.finalize).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ state: 'final' });
    await service.dispose();
  });

  it('refuses streaming on a batch-only model', async () => {
    await installTestModel();
    const batchModel: SpeechModelDefinition = { ...model, id: 'mini', fileName: 'mini.gguf', streaming: false };
    const service = new SpeechService(new AppLogService(), directory, fetch, [batchModel], async () => ({
      getAvailableBackends: () => [{ name: 'CPU', description: 'CPU', kind: 'cpu', deviceType: 'cpu' }],
      TranscribeModel: { load: vi.fn() },
    } as unknown as typeof import('transcribe-cpp')));
    await expect(service.streamStart('mini', 'en')).rejects.toThrow('streaming');
    await service.dispose();
  });
});
