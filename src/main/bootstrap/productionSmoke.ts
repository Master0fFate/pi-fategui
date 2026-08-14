/**
 * Opt-in production smoke check wired on the initial window's first load.
 *
 * Six seconds of silence exercise the buffered streaming window, bounded worker
 * feed queue, finalize path, and CPU fallback without a microphone, followed by
 * the small batch transcribe path. Music, themes, and the terminal are checked
 * alongside speech. All side effects go through injected adapters so the marker
 * output and quit/exit ordering are testable without Electron.
 */
export interface SpeechSmokeSurface {
  download(model: string): Promise<unknown>;
  streamStart(model: string, language: string): Promise<unknown>;
  streamFeed(samples: ArrayBuffer): Promise<unknown>;
  streamStop(): Promise<unknown>;
  streamCancel(): Promise<unknown>;
  transcribe(model: string, samples: ArrayBuffer, language: string): Promise<unknown>;
  getStatus(): Promise<{ backend: string }>;
}

export interface MusicStatusSurface {
  getStatus(): Promise<{ available: boolean; version: string | null; message?: string | undefined }>;
}

export interface ThemesSurface {
  loadThemes(): Promise<readonly { name: string; tone: string }[]>;
}

export interface ProductionSmokeDeps {
  speech: SpeechSmokeSurface;
  music: MusicStatusSurface;
  settings: ThemesSurface;
  smokeTerminalRuntime: (cwd: string) => Promise<string>;
  cwd: string;
  streamSmokeEnabled: boolean;
  now(): number;
  log: (line: string) => void;
  error: (line: string) => void;
  quit: () => void;
  exit: (code: number) => void;
  /** Delay before a successful smoke quits. Defaults to 100ms. */
  quitDelayMs?: number;
}

async function smokeParakeetStream(speech: SpeechSmokeSurface): Promise<void> {
  await speech.download('parakeet-unified');
  await speech.streamStart('parakeet-unified', 'en');
  try {
    const feeds = Array.from({ length: 38 }, () => speech.streamFeed(new Float32Array(16_000 * 0.16).buffer));
    const stopping = speech.streamStop();
    await Promise.all([...feeds, stopping]);
  } catch (error) {
    await speech.streamCancel().catch(() => undefined);
    throw error;
  }
}

async function smokeBatchSpeech(speech: SpeechSmokeSurface): Promise<void> {
  await speech.download('canary-flash');
  await speech.transcribe('canary-flash', new Float32Array(16_000 * 6).buffer, 'en');
}

export async function runProductionSmoke(deps: ProductionSmokeDeps): Promise<void> {
  try {
    const [speechStatus, musicStatus, themes, terminalShell] = await Promise.all([
      deps.speech.getStatus(),
      deps.music.getStatus(),
      deps.settings.loadThemes(),
      deps.smokeTerminalRuntime(deps.cwd),
    ]);
    if (!musicStatus.available) throw new Error(musicStatus.message ?? 'Bundled yt-dlp is unavailable.');
    const piThemes = themes.filter((theme) => theme.name.startsWith('Pi · '));
    if (!piThemes.some((theme) => theme.tone === 'dark') || !piThemes.some((theme) => theme.tone === 'light')) {
      throw new Error('Standard Pi themes are unavailable.');
    }
    if (deps.streamSmokeEnabled) {
      const streamStartedAt = deps.now();
      await smokeParakeetStream(deps.speech);
      deps.log(`PI_DESKTOP_PARAKEET_STREAM_OK ${Math.round(deps.now() - streamStartedAt)}ms`);
      const batchStartedAt = deps.now();
      await smokeBatchSpeech(deps.speech);
      deps.log(`PI_DESKTOP_BATCH_SPEECH_OK ${Math.round(deps.now() - batchStartedAt)}ms`);
    }
    deps.log(`PI_DESKTOP_SPEECH_OK ${speechStatus.backend}`);
    deps.log(`PI_DESKTOP_YT_DLP_OK ${musicStatus.version}`);
    deps.log('PI_DESKTOP_THEMES_OK');
    deps.log(`PI_DESKTOP_TERMINAL_OK ${terminalShell}`);
    deps.log('PI_DESKTOP_SMOKE_OK');
    setTimeout(() => deps.quit(), deps.quitDelayMs ?? 100);
  } catch (error: unknown) {
    deps.error(`PI_DESKTOP_RUNTIME_SMOKE_FAILED ${error instanceof Error ? error.message : String(error)}`);
    deps.exit(1);
  }
}
