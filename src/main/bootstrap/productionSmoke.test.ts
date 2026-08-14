import { describe, expect, it, vi } from 'vitest';
import { runProductionSmoke, type ProductionSmokeDeps } from './productionSmoke';

const flushQuit = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

function makeDeps(overrides: Partial<ProductionSmokeDeps> = {}): { deps: ProductionSmokeDeps; log: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; quit: ReturnType<typeof vi.fn>; exit: ReturnType<typeof vi.fn> } {
  const log = vi.fn();
  const error = vi.fn();
  const quit = vi.fn();
  const exit = vi.fn();
  const deps: ProductionSmokeDeps = {
    speech: {
      getStatus: async () => ({ backend: 'cpu' }),
      download: async () => undefined,
      streamStart: async () => undefined,
      streamFeed: async () => undefined,
      streamStop: async () => undefined,
      streamCancel: async () => undefined,
      transcribe: async () => undefined,
    },
    music: { getStatus: async () => ({ available: true, version: '2024.01.01', message: undefined }) },
    settings: { loadThemes: async () => [{ name: 'Pi · Midnight', tone: 'dark' }, { name: 'Pi · Daylight', tone: 'light' }] },
    smokeTerminalRuntime: async () => 'bash',
    cwd: '.',
    streamSmokeEnabled: false,
    now: () => 0,
    log,
    error,
    quit,
    exit,
    quitDelayMs: 0,
    ...overrides,
  };
  return { deps, log, error, quit, exit };
}

describe('runProductionSmoke', () => {
  it('emits the success markers and schedules a quit', async () => {
    const { deps, log, quit, exit } = makeDeps();
    await runProductionSmoke(deps);

    expect(log).toHaveBeenCalledWith('PI_DESKTOP_SMOKE_OK');
    expect(log).toHaveBeenCalledWith('PI_DESKTOP_SPEECH_OK cpu');
    expect(log).toHaveBeenCalledWith('PI_DESKTOP_YT_DLP_OK 2024.01.01');
    expect(log).toHaveBeenCalledWith('PI_DESKTOP_THEMES_OK');
    expect(log).toHaveBeenCalledWith('PI_DESKTOP_TERMINAL_OK bash');
    expect(exit).not.toHaveBeenCalled();
    await flushQuit();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('fails fast and exits when the bundled runtime is unavailable', async () => {
    const { deps, error, exit, quit } = makeDeps({
      music: { getStatus: async () => ({ available: false, version: null, message: 'missing' }) },
    });
    await runProductionSmoke(deps);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('PI_DESKTOP_RUNTIME_SMOKE_FAILED'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('missing'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(quit).not.toHaveBeenCalled();
  });

  it('fails when standard Pi themes are missing', async () => {
    const { deps, error, exit } = makeDeps({
      settings: { loadThemes: async () => [{ name: 'Custom', tone: 'dark' }] },
    });
    await runProductionSmoke(deps);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Standard Pi themes are unavailable'));
    expect(exit).toHaveBeenCalledWith(1);
  });
});
