import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import type { SpeechDownloadProgress, SpeechModelId, SpeechStatus, SpeechStreamUpdate, SpeechTranscription } from '../../shared/contracts/ipc';
import { MAX_SPEECH_STREAM_BACKLOG_SAMPLES, MAX_SPEECH_STREAM_FEED_SAMPLES, SPEECH_PCM_BYTES_PER_SAMPLE } from '../../shared/speech';
import type { AppLogService } from '../logging/AppLogService';
import type { Backend } from 'transcribe-cpp';
import { speechModels, type SpeechModelDefinition } from './speechModels';

const MODEL_IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_AUDIO_SAMPLES = 16_000 * 180;
const CPU_THREADS = Math.max(1, Math.min(8, Math.ceil(os.availableParallelism() / 2)));
const MAX_STREAM_CHUNK_BYTES = MAX_SPEECH_STREAM_FEED_SAMPLES * SPEECH_PCM_BYTES_PER_SAMPLE;
const LEGACY_MODEL_FILES = [
  'parakeet-tdt_ctc-110m-Q5_K_M.gguf',
  'parakeet-tdt-0.6b-v2-Q4_K_M.gguf',
  'whisper-large-v3-turbo-Q4_K_M.gguf',
] as const;
type TranscribeModule = typeof import('transcribe-cpp');
type LoadedModel = Awaited<ReturnType<TranscribeModule['TranscribeModel']['load']>>;
type SpeechSession = ReturnType<LoadedModel['createSession']>;
type SpeechStream = Awaited<ReturnType<SpeechSession['stream']>>;
type QueuedStreamFeed = { pcm: Float32Array; resolve: () => void; reject: (error: unknown) => void };
type ActiveSpeechStream = {
  definition: SpeechModelDefinition;
  session: SpeechSession;
  stream: SpeechStream;
  settled: Promise<void>;
  resolveSettled: () => void;
  accepting: boolean;
  pendingFeeds: QueuedStreamFeed[];
  pendingSamples: number;
  inFlightSamples: number;
  draining: Promise<void> | null;
  stopping: Promise<void> | null;
  failure: unknown | null;
};

export class SpeechService {
  private readonly downloads = new Map<SpeechModelId, Promise<void>>();
  private readonly downloadControllers = new Map<SpeechModelId, AbortController>();
  private readonly installedModels = new Set<SpeechModelId>();
  private loaded: { id: SpeechModelId; model: LoadedModel } | null = null;
  private unloadTimer: NodeJS.Timeout | null = null;
  private activeRun: AbortController | null = null;
  private activeSettled: Promise<void> | null = null;
  private resolveActiveSettled: (() => void) | null = null;
  private eventSink: ((progress: SpeechDownloadProgress) => void) | null = null;
  private streamSink: ((update: SpeechStreamUpdate) => void) | null = null;
  private activeStream: ActiveSpeechStream | null = null;
  private modulePromise: Promise<TranscribeModule> | null = null;
  private backendProbe: Promise<Pick<SpeechStatus, 'backend' | 'accelerated'>> | null = null;
  private legacyCleanup: Promise<void> | null = null;

  constructor(
    private readonly logs: AppLogService,
    private readonly modelRoot = path.join(
      process.env.FATE_GUI_DATA_DIR
        ? path.resolve(process.env.FATE_GUI_DATA_DIR)
        : path.join(os.homedir(), '.pi', 'fateGUI'),
      'models',
      'speech',
    ),
    private readonly fetcher: typeof fetch = fetch,
    private readonly definitions: readonly SpeechModelDefinition[] = speechModels,
    private readonly runtimeLoader: () => Promise<TranscribeModule> = () => import('transcribe-cpp'),
    private readonly idleTimeoutMs = MODEL_IDLE_TIMEOUT_MS,
  ) {}

  setEventSink(sink: (progress: SpeechDownloadProgress) => void): void {
    this.eventSink = sink;
  }

  setStreamSink(sink: (update: SpeechStreamUpdate) => void): void {
    this.streamSink = sink;
  }

  async getStatus(): Promise<SpeechStatus> {
    await this.cleanupLegacyModels();
    const models = await Promise.all(this.definitions.map(async (definition) => {
      const installed = await this.isInstalled(definition);
      const downloadedBytes = installed
        ? definition.bytes
        : await fs.stat(`${this.modelPath(definition)}.partial`).then((stat) => Math.min(stat.size, definition.bytes), () => 0);
      return { ...this.publicModel(definition), installed, downloadedBytes };
    }));
    const backend = await this.getBackendStatus();
    return { models, ...backend };
  }

  async download(modelId: SpeechModelId): Promise<void> {
    if (await this.isInstalled(this.definition(modelId))) return;
    const existing = this.downloads.get(modelId);
    if (existing) return existing;
    const controller = new AbortController();
    this.downloadControllers.set(modelId, controller);
    const operation = this.downloadModel(this.definition(modelId), controller.signal).finally(() => {
      this.downloads.delete(modelId);
      this.downloadControllers.delete(modelId);
    });
    this.downloads.set(modelId, operation);
    return operation;
  }

  cancelDownload(modelId: SpeechModelId): boolean {
    const controller = this.downloadControllers.get(modelId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async remove(modelId: SpeechModelId): Promise<void> {
    if (this.downloads.has(modelId)) throw new Error('Wait for this model download to finish before removing it.');
    this.installedModels.delete(modelId);
    if (this.loaded?.id === modelId) this.unload();
    const definition = this.definition(modelId);
    await Promise.all([
      fs.rm(this.modelPath(definition), { force: true }),
      fs.rm(`${this.modelPath(definition)}.partial`, { force: true }),
      fs.rm(`${this.modelPath(definition)}.verified`, { force: true }),
    ]);
  }

  async transcribe(modelId: SpeechModelId, audio: ArrayBuffer, language?: string): Promise<SpeechTranscription> {
    if (audio.byteLength === 0 || audio.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) throw new Error('The captured audio is malformed.');
    const pcm = new Float32Array(audio);
    if (pcm.length > MAX_AUDIO_SAMPLES) throw new Error('Voice recordings are limited to three minutes.');
    if (!(await this.isInstalled(this.definition(modelId)))) throw new Error('Download the selected voice model before transcribing.');
    if (this.activeRun || this.activeStream) throw new Error('Another voice transcription is already running.');

    const controller = new AbortController();
    this.activeRun = controller;
    this.activeSettled = new Promise<void>((resolve) => { this.resolveActiveSettled = resolve; });
    try {
      const definition = this.definition(modelId);
      const startedAt = performance.now();
      const warm = this.loaded?.id === modelId;
      const model = await this.load(definition);
      const loadMs = performance.now() - startedAt;
      const session = model.createSession({ nThreads: CPU_THREADS });
      let result: Awaited<ReturnType<typeof session.run>>;
      try {
        result = await session.run(pcm, {
          signal: controller.signal,
          timestamps: 'none',
          language: language && language !== 'auto' ? language : 'en',
        });
      } finally {
        session.dispose();
      }
      const elapsedMs = performance.now() - startedAt;
      this.logs.write('info', 'speech', `${definition.model} transcribed ${(pcm.length / 16_000).toFixed(1)}s of audio in ${Math.round(elapsedMs)}ms (${warm ? 'warm' : `${Math.round(loadMs)}ms load`}, ${model.device.name || model.backend}).`);
      return {
        text: result.text.trim(),
        language: result.language || language || 'unknown',
        backend: model.device.name || model.device.description || model.backend,
        accelerated: model.device.deviceType !== 'cpu',
      };
    } finally {
      if (this.loaded?.id === modelId) this.scheduleUnload();
      if (this.activeRun === controller) this.activeRun = null;
      this.resolveActiveSettled?.();
      this.resolveActiveSettled = null;
      this.activeSettled = null;
    }
  }

  cancel(): boolean {
    if (!this.activeRun) return false;
    this.activeRun.abort();
    return true;
  }

  /** Begin a live streaming transcription. Only streaming-family models
   *  (Parakeet) support this; batch models throw. The stream holds the model's
   *  single compute slot until streamStop/streamCancel, so batch transcribe()
   *  is refused while it is active. */
  async streamStart(modelId: SpeechModelId, language?: string): Promise<void> {
    if (this.activeRun || this.activeStream) throw new Error('Another voice transcription is already running.');
    const definition = this.definition(modelId);
    if (!definition.streaming) throw new Error('Live transcription is only supported by streaming voice models.');
    if (!(await this.isInstalled(definition))) throw new Error('Download the selected voice model before transcribing.');
    const model = await this.load(definition);
    const session = model.createSession({ nThreads: CPU_THREADS });
    let stream: SpeechStream;
    try {
      stream = await session.stream({
        language: language && language !== 'auto' ? language : 'en',
        timestamps: 'none',
        commitPolicy: 'stable_prefix',
        // Let transcribe.cpp select Parakeet's trained default stream menu.
        // The old 5.6 s / 160 ms override decoded every tiny audio chunk, which
        // falls behind real time on CPU. The native default batches audio at a
        // stable cadence and is also the higher-accuracy configuration.
        family: { kind: 'parakeet_buffered' },
      });
    } catch (error) {
      session.dispose();
      throw new Error(`Live transcription could not start: ${this.message(error)}`);
    }
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    this.activeStream = { definition, session, stream, settled, resolveSettled, accepting: true, pendingFeeds: [], pendingSamples: 0, inFlightSamples: 0, draining: null, stopping: null, failure: null };
    this.logs.write('info', 'speech', `${definition.model} live transcription started.`);
    this.emitStream({ state: 'active', committed: '', tentative: '' });
  }

  /** Accept a PCM capture for the live stream. The buffer is copied before it
   *  crosses into native code, because transcribe.cpp borrows that buffer until
   *  feed() settles. When CPU inference falls behind, pending 300 ms captures
   *  are merged in original order into bounded two-second native feeds. */
  async streamFeed(audio: ArrayBuffer): Promise<void> {
    if (audio.byteLength === 0 || audio.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) throw new Error('The captured audio is malformed.');
    if (audio.byteLength > MAX_STREAM_CHUNK_BYTES) throw new Error('The live audio chunk is too large.');
    const active = this.activeStream;
    if (!active || !active.accepting) throw new Error('No live transcription is running.');
    const samples = audio.byteLength / SPEECH_PCM_BYTES_PER_SAMPLE;
    if (active.pendingSamples + active.inFlightSamples + samples > MAX_SPEECH_STREAM_BACKLOG_SAMPLES) {
      const error = new Error('Live transcription cannot keep up with this computer. Try a shorter recording or a faster voice model.');
      this.failStreamCapacity(active, error);
      throw error;
    }
    const pcm = new Float32Array(audio.slice(0));
    return new Promise<void>((resolve, reject) => {
      active.pendingFeeds.push({ pcm, resolve, reject });
      active.pendingSamples += pcm.length;
      this.startStreamDrain(active);
    });
  }

  /** Stop accepting input, drain every accepted PCM capture, then finalize. */
  async streamStop(): Promise<void> {
    const active = this.activeStream;
    if (!active) throw new Error('No live transcription is running.');
    if (active.stopping) return active.stopping;
    active.accepting = false;
    active.stopping = this.finishStreamStop(active);
    return active.stopping;
  }

  private async finishStreamStop(active: ActiveSpeechStream): Promise<void> {
    try {
      await this.waitForStreamDrain(active);
      if (active.failure) throw active.failure;
      if (this.activeStream !== active) return; // cancelled while draining
      await active.stream.finalize();
      if (this.activeStream === active) {
        const { committed } = active.stream.text;
        this.logs.write('info', 'speech', `${active.definition.model} live transcription finalized.`);
        this.emitStream({ state: 'final', committed, tentative: '' });
      }
    } catch (error) {
      this.emitStream({ state: 'error', committed: '', tentative: '', error: this.message(error) });
      throw error;
    } finally {
      this.endStream(active);
    }
  }

  /** Abort the active stream without finalizing. Safe to call when idle. */
  async streamCancel(): Promise<void> {
    const active = this.activeStream;
    if (!active) return;
    this.endStream(active);
    this.emitStream({ state: 'cancelled', committed: '', tentative: '' });
  }

  private startStreamDrain(active: ActiveSpeechStream): void {
    if (active.draining || active.failure) return;
    active.draining = this.drainStreamFeeds(active).finally(() => {
      active.draining = null;
      // A normal stop closes input before it waits. Keep draining captures that
      // were already accepted, even if they arrive at this drain boundary.
      if (this.activeStream === active && !active.failure && active.pendingFeeds.length > 0) this.startStreamDrain(active);
    });
  }

  /** Feed complete, ordered batches. This is the only code path that touches a
   *  live session, so text reads cannot overlap native feed/finalize work. */
  private async drainStreamFeeds(active: ActiveSpeechStream): Promise<void> {
    while (this.activeStream === active && active.pendingFeeds.length > 0) {
      const batch = this.takeStreamBatch(active);
      const pcm = this.combineStreamBatch(batch);
      active.inFlightSamples = pcm.length;
      try {
        await active.stream.feed(pcm);
        if (this.activeStream !== active) {
          for (const queued of batch) queued.resolve(); // cancellation intentionally abandons the stream
          return;
        }
        const { committed, tentative } = active.stream.text;
        this.emitStream({ state: 'active', committed, tentative });
        for (const queued of batch) queued.resolve();
      } catch (error) {
        if (this.activeStream !== active) {
          for (const queued of batch) queued.resolve(); // disposal is safe during a native call
          return;
        }
        active.accepting = false;
        active.failure = error;
        for (const queued of batch) queued.reject(error);
        for (const queued of active.pendingFeeds.splice(0)) queued.reject(error);
        active.pendingSamples = 0;
        return;
      } finally {
        active.inFlightSamples = 0;
      }
    }
  }

  private takeStreamBatch(active: ActiveSpeechStream): QueuedStreamFeed[] {
    const batch: QueuedStreamFeed[] = [];
    let samples = 0;
    while (active.pendingFeeds.length > 0) {
      const next = active.pendingFeeds[0]!;
      if (batch.length > 0 && samples + next.pcm.length > MAX_SPEECH_STREAM_FEED_SAMPLES) break;
      active.pendingFeeds.shift();
      active.pendingSamples -= next.pcm.length;
      batch.push(next);
      samples += next.pcm.length;
    }
    return batch;
  }

  private combineStreamBatch(batch: readonly QueuedStreamFeed[]): Float32Array {
    if (batch.length === 1) return batch[0]!.pcm;
    const samples = batch.reduce((total, queued) => total + queued.pcm.length, 0);
    const pcm = new Float32Array(samples);
    let offset = 0;
    for (const queued of batch) {
      pcm.set(queued.pcm, offset);
      offset += queued.pcm.length;
    }
    return pcm;
  }

  private async waitForStreamDrain(active: ActiveSpeechStream): Promise<void> {
    while (this.activeStream === active) {
      if (!active.draining && !active.failure && active.pendingFeeds.length > 0) this.startStreamDrain(active);
      const draining = active.draining;
      if (!draining) return;
      await draining;
    }
  }

  /** A sustained native deficit cannot be repaired without keeping unlimited
   *  PCM. Fail explicitly and tear down safely; normal stop never reaches here
   *  and still drains every capture it accepted. */
  private failStreamCapacity(active: ActiveSpeechStream, error: Error): void {
    if (this.activeStream !== active) return;
    active.accepting = false;
    active.failure = error;
    for (const queued of active.pendingFeeds.splice(0)) queued.reject(error);
    active.pendingSamples = 0;
    this.emitStream({ state: 'error', committed: '', tentative: '', error: error.message });
    this.endStream(active);
    // The native feed can still be in flight. Its queued promise already has a
    // handler, so it must not become an unhandled rejection after teardown.
    void active.draining?.catch(() => undefined);
  }

  private endStream(active: ActiveSpeechStream): void {
    active.accepting = false;
    for (const queued of active.pendingFeeds.splice(0)) queued.resolve();
    active.pendingSamples = 0;
    if (this.activeStream === active) this.activeStream = null;
    try { active.session.dispose(); } catch { /* teardown is best-effort */ }
    if (this.loaded?.id === active.definition.id) this.scheduleUnload();
    active.resolveSettled();
  }

  private emitStream(update: SpeechStreamUpdate): void {
    this.streamSink?.(update);
  }

  async dispose(): Promise<void> {
    for (const controller of this.downloadControllers.values()) controller.abort();
    this.cancel();
    if (this.activeStream) await this.streamCancel();
    const activeSettled = this.activeSettled;
    if (activeSettled) await activeSettled.catch(() => undefined);
    this.unload();
  }

  private async downloadModel(definition: SpeechModelDefinition, signal: AbortSignal): Promise<void> {
    await fs.mkdir(this.modelRoot, { recursive: true });
    const target = this.modelPath(definition);
    const partial = `${target}.partial`;
    const present = await fs.stat(partial).then((stat) => Math.min(stat.size, definition.bytes), () => 0);
    if (present === definition.bytes && await this.verify(partial, definition.sha256)) {
      await this.installVerified(partial, target, definition);
      return;
    }
    if (present >= definition.bytes) await fs.rm(partial, { force: true });
    const offset = present >= definition.bytes ? 0 : present;
    const freeBytes = await fs.statfs(this.modelRoot).then((stats) => stats.bavail * stats.bsize, () => Number.POSITIVE_INFINITY);
    const requiredBytes = definition.bytes - offset + 64 * 1024 * 1024;
    if (freeBytes < requiredBytes) throw new Error(`Not enough disk space for ${definition.name}. Free at least ${Math.ceil(requiredBytes / 1024 / 1024)} MB and try again.`);
    this.emit({ modelId: definition.id, state: 'downloading', downloadedBytes: offset, totalBytes: definition.bytes });

    let response: Response;
    try {
      response = await this.fetcher(definition.url, {
        redirect: 'follow',
        signal,
        ...(offset > 0 ? { headers: { Range: `bytes=${offset}-` } } : {}),
      });
    } catch (error) {
      if (!signal.aborted) throw error;
      this.emit({ modelId: definition.id, state: 'cancelled', downloadedBytes: offset, totalBytes: definition.bytes });
      throw new Error('Model download cancelled.');
    }
    if (!response.ok || !response.body) throw new Error(`Model download failed with HTTP ${response.status}.`);
    const append = offset > 0 && response.status === 206;
    const start = append ? offset : 0;
    const hash = createHash('sha256');
    if (append) {
      try {
        await pipeline(createReadStream(partial), new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(); } }), { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
        this.emit({ modelId: definition.id, state: 'cancelled', downloadedBytes: offset, totalBytes: definition.bytes });
        throw new Error('Model download cancelled.');
      }
    }
    let downloaded = start;
    let lastUpdate = 0;
    const progress = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        downloaded += chunk.length;
        hash.update(chunk);
        if (downloaded > definition.bytes) return callback(new Error('The model download exceeded its declared size.'));
        const now = Date.now();
        if (now - lastUpdate > 150 || downloaded === definition.bytes) {
          lastUpdate = now;
          this.emit({ modelId: definition.id, state: 'downloading', downloadedBytes: downloaded, totalBytes: definition.bytes });
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(response.body as never), progress, createWriteStream(partial, { flags: append ? 'a' : 'w', mode: 0o600 }), { signal });
      if (downloaded !== definition.bytes) throw new Error(`Model download was incomplete (${downloaded} of ${definition.bytes} bytes).`);
      this.emit({ modelId: definition.id, state: 'verifying', downloadedBytes: downloaded, totalBytes: definition.bytes });
      if (hash.digest('hex') !== definition.sha256) throw new Error('Model checksum verification failed. Delete the partial download and try again.');
      await this.installVerified(partial, target, definition);
      this.logs.write('info', 'speech', `${definition.model} installed and checksum verified.`);
    } catch (error) {
      if (signal.aborted) {
        this.emit({ modelId: definition.id, state: 'cancelled', downloadedBytes: downloaded, totalBytes: definition.bytes });
        throw new Error('Model download cancelled.');
      }
      this.emit({ modelId: definition.id, state: 'error', downloadedBytes: downloaded, totalBytes: definition.bytes, error: this.message(error) });
      throw error;
    }
  }

  private async installVerified(partial: string, target: string, definition: SpeechModelDefinition): Promise<void> {
    await fs.rm(target, { force: true });
    await fs.rename(partial, target);
    await fs.writeFile(`${target}.verified`, `${definition.sha256}\n`, { encoding: 'utf8', mode: 0o600 });
    this.installedModels.add(definition.id);
    this.emit({ modelId: definition.id, state: 'installed', downloadedBytes: definition.bytes, totalBytes: definition.bytes });
  }

  private async verify(file: string, expected: string): Promise<boolean> {
    const hash = createHash('sha256');
    await pipeline(createReadStream(file), new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(); } }));
    return hash.digest('hex') === expected;
  }

  private cleanupLegacyModels(): Promise<void> {
    this.legacyCleanup ??= Promise.all(LEGACY_MODEL_FILES.flatMap((fileName) => [
      fs.rm(path.join(this.modelRoot, fileName), { force: true }),
      fs.rm(path.join(this.modelRoot, `${fileName}.partial`), { force: true }),
      fs.rm(path.join(this.modelRoot, `${fileName}.verified`), { force: true }),
    ])).then(() => undefined).catch((error: unknown) => {
      this.logs.write('warn', 'speech', `Legacy voice models could not be removed: ${this.message(error)}`);
    });
    return this.legacyCleanup;
  }

  private async isInstalled(definition: SpeechModelDefinition): Promise<boolean> {
    if (this.installedModels.has(definition.id)) return true;
    const [stat, marker] = await Promise.all([
      fs.stat(this.modelPath(definition)).catch(() => null),
      fs.readFile(`${this.modelPath(definition)}.verified`, 'utf8').catch(() => ''),
    ]);
    if (!stat || stat.size !== definition.bytes || marker.trim() !== definition.sha256) return false;
    this.installedModels.add(definition.id);
    return true;
  }

  private getBackendStatus(): Promise<Pick<SpeechStatus, 'backend' | 'accelerated'>> {
    this.backendProbe ??= this.runtime().then((runtime) => {
      const available = runtime.getAvailableBackends();
      const gpu = available.find((candidate) => candidate.deviceType === 'gpu' || candidate.deviceType === 'igpu' || candidate.deviceType === 'accel');
      if (!gpu) return { backend: 'CPU', accelerated: false };
      const name = gpu.name || gpu.description || gpu.kind;
      return gpu.kind === 'vulkan'
        ? { backend: `${name} detected · CPU safety mode active`, accelerated: false }
        : { backend: name, accelerated: true };
    }).catch((error: unknown) => {
      this.logs.write('warn', 'speech', `Speech acceleration probe fell back to CPU: ${this.message(error)}`);
      return { backend: 'CPU', accelerated: false };
    });
    return this.backendProbe;
  }

  private async load(definition: SpeechModelDefinition): Promise<LoadedModel> {
    if (this.loaded?.id === definition.id) {
      this.clearUnloadTimer();
      return this.loaded.model;
    }
    this.unload();
    const runtime = await this.runtime();
    try {
      const backend = this.selectBackend(runtime, definition);
      const model = await runtime.TranscribeModel.load(this.modelPath(definition), { backend });
      this.loaded = { id: definition.id, model };
      this.logs.write('info', 'speech', `${definition.model} loaded on ${model.device.name || model.backend}.`);
      return model;
    } catch (error) {
      throw new Error(`The selected voice model could not load: ${this.message(error)}`);
    }
  }

  /** Choose the compute backend for a model. "auto" lets transcribe.cpp pick the
   *  best accelerator; we override it to CPU only where a backend is known to be
   *  unstable for this model class:
   *    - Vulkan's model loader is unstable on every platform that ships it, so
   *      it is always forced to CPU (matches the upstream note).
   *    - Streaming-family models (Parakeet RNN-T/TDT) abort inside the Metal
   *      decode graph on macOS, while CPU is stable. Batch models (Canary,
   *      Cohere Transcribe) run fine on Metal, so they keep the accelerator. */
  private selectBackend(runtime: TranscribeModule, definition: SpeechModelDefinition): Backend {
    const available = runtime.getAvailableBackends();
    if (available.some((candidate) => candidate.kind === 'vulkan')) {
      this.logs.write('warn', 'speech', `${definition.model} is using CPU because the transcribe.cpp Vulkan model loader is unstable on this platform.`);
      return 'cpu';
    }
    if (definition.streaming && available.some((candidate) => candidate.kind === 'metal')) {
      this.logs.write('warn', 'speech', `${definition.model} is using CPU because streaming voice models are unstable on the transcribe.cpp Metal backend on macOS.`);
      return 'cpu';
    }
    return 'auto';
  }

  private scheduleUnload(): void {
    this.clearUnloadTimer();
    this.unloadTimer = setTimeout(() => this.unload(), this.idleTimeoutMs);
    this.unloadTimer.unref();
  }

  private clearUnloadTimer(): void {
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = null;
  }

  private unload(): void {
    this.clearUnloadTimer();
    this.loaded?.model.dispose();
    this.loaded = null;
  }

  private runtime(): Promise<TranscribeModule> {
    this.modulePromise ??= this.runtimeLoader();
    return this.modulePromise;
  }

  private definition(modelId: SpeechModelId): SpeechModelDefinition {
    const definition = this.definitions.find((candidate) => candidate.id === modelId);
    if (!definition) throw new Error(`Unknown speech model: ${modelId}`);
    return definition;
  }

  private modelPath(definition: SpeechModelDefinition): string {
    return path.join(this.modelRoot, definition.fileName);
  }

  private publicModel(definition: SpeechModelDefinition) {
    const { fileName: _fileName, url: _url, sha256: _sha256, ...model } = definition;
    return model;
  }

  private emit(progress: SpeechDownloadProgress): void {
    this.eventSink?.(progress);
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
