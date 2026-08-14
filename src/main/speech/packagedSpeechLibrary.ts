import path from 'node:path';

/**
 * Locate the packaged native transcribe library and expose it through the
 * TRANSCRIBE_LIBRARY environment variable. The SpeechService itself reads that
 * variable, so this helper never touches SpeechService internals.
 */
export interface PackagedSpeechLibraryDeps {
  isPackaged: boolean;
  resourcesPath: string;
  platform: string;
  /** Existing override; when set, packaged discovery is skipped. */
  transcribeLibraryEnv?: string;
  exists: (filePath: string) => boolean;
  readDir: (directoryPath: string) => readonly string[];
  setEnv: (value: string) => void;
}

export function configurePackagedSpeechLibrary(deps: PackagedSpeechLibraryDeps): void {
  if (!deps.isPackaged || deps.transcribeLibraryEnv) return;
  const libraryName = deps.platform === 'win32'
    ? 'transcribe.dll'
    : deps.platform === 'darwin' ? 'libtranscribe.dylib' : 'libtranscribe.so';
  const providers = path.join(deps.resourcesPath, 'app.asar.unpacked', 'node_modules', '@transcribe-cpp');
  if (!deps.exists(providers)) return;
  const library = deps
    .readDir(providers)
    .map((provider) => path.join(providers, provider, libraryName))
    .find((candidate) => deps.exists(candidate));
  if (library) deps.setEnv(library);
}
