import { describe, expect, it, vi } from 'vitest';
import { configurePackagedSpeechLibrary } from './packagedSpeechLibrary';

describe('configurePackagedSpeechLibrary', () => {
  it('locates the packaged library by platform and exposes it through the env override', () => {
    const setEnv = vi.fn();
    const exists = vi.fn((target: string) => {
      const normalized = target.replace(/\\/g, '/');
      return normalized === '/res/app.asar.unpacked/node_modules/@transcribe-cpp' || normalized.endsWith('libtranscribe.dylib');
    });
    const readDir = vi.fn(() => ['parakeet']);

    configurePackagedSpeechLibrary({ isPackaged: true, resourcesPath: '/res', platform: 'darwin', exists, readDir, setEnv });

    expect(readDir).toHaveBeenCalled();
    expect(setEnv).toHaveBeenCalledWith(expect.stringMatching(/@transcribe-cpp[/\\]+parakeet[/\\]+libtranscribe.dylib$/));
  });

  it('uses the platform-correct native suffix', () => {
    const setEnv = vi.fn();
    const exists = vi.fn((target: string) => {
      const normalized = target.replace(/\\/g, '/');
      return normalized === '/res/app.asar.unpacked/node_modules/@transcribe-cpp' || normalized.endsWith('transcribe.dll');
    });
    configurePackagedSpeechLibrary({ isPackaged: true, resourcesPath: '/res', platform: 'win32', exists, readDir: () => ['whisper'], setEnv });
    expect(setEnv).toHaveBeenCalledWith(expect.stringMatching(/@transcribe-cpp[/\\]+whisper[/\\]+transcribe.dll$/));
  });

  it('skips discovery when unpackaged', () => {
    const setEnv = vi.fn();
    configurePackagedSpeechLibrary({ isPackaged: false, resourcesPath: '/res', platform: 'darwin', exists: () => true, readDir: () => [], setEnv });
    expect(setEnv).not.toHaveBeenCalled();
  });

  it('skips discovery when an override is already set', () => {
    const setEnv = vi.fn();
    configurePackagedSpeechLibrary({ isPackaged: true, resourcesPath: '/res', platform: 'darwin', transcribeLibraryEnv: '/custom/libtranscribe.dylib', exists: () => true, readDir: () => [], setEnv });
    expect(setEnv).not.toHaveBeenCalled();
  });

  it('leaves the env unset when no provider ships the library', () => {
    const setEnv = vi.fn();
    const exists = vi.fn((target: string) => {
      const normalized = target.replace(/\\/g, '/');
      return normalized === '/res/app.asar.unpacked/node_modules/@transcribe-cpp';
    });
    configurePackagedSpeechLibrary({ isPackaged: true, resourcesPath: '/res', platform: 'linux', exists, readDir: () => ['parakeet'], setEnv });
    expect(setEnv).not.toHaveBeenCalled();
  });
});
