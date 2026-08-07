import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import type { SpeechDownloadProgress, SpeechModelId, SpeechStatus, SpeechTranscription } from '../../shared/contracts/ipc';
import type { AppLogService } from '../logging/AppLogService';
import { speechModels, type SpeechModelDefinition } from './speechModels';

const MODEL_IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_AUDIO_SAMPLES = 16_000 * 180;
const CPU_THREADS = Math.max(1, Math.min(8, Math.ceil(os.availableParallelism() / 2)));
const LEGACY_MODEL_FILES = [
  'parakeet-tdt_ctc-110m-Q5_K_M.gguf',
  'parakeet-tdt-0.6b-v2-Q4_K_M.gguf',
  'whisper-large-v3-turbo-Q4_K_M.gguf',
] as const;
type TranscribeModule = typeof import('transcribe-cpp');
type LoadedModel = Awaited<ReturnType<TranscribeModule['TranscribeModel']['load']>>;

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
    if (this.activeRun) throw new Error('Another voice transcription is already running.');

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

  async dispose(): Promise<void> {
    for (const controller of this.downloadControllers.values()) controller.abort();
    this.cancel();
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
      const available = runtime.getAvailableBackends();
      const unstableVulkan = available.some((candidate) => candidate.kind === 'vulkan');
      const backend = unstableVulkan ? 'cpu' : 'auto';
      if (unstableVulkan) {
        this.logs.write('warn', 'speech', `${definition.model} is using CPU because the transcribe.cpp Vulkan model loader is unstable on this platform.`);
      }
      const model = await runtime.TranscribeModel.load(this.modelPath(definition), { backend });
      this.loaded = { id: definition.id, model };
      this.logs.write('info', 'speech', `${definition.model} loaded on ${model.device.name || model.backend}.`);
      return model;
    } catch (error) {
      throw new Error(`The selected voice model could not load: ${this.message(error)}`);
    }
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
