import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { MusicService, executableCandidates, type MusicProcessRunner } from './MusicService';

const publicDns = vi.fn(async () => ['93.184.216.34']);

function runner(outputs: string[]): MusicProcessRunner & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async () => outputs.shift() ?? '{}');
  return {
    getVersion: vi.fn(async () => '2026.03.17\n'),
    run,
    dispose: vi.fn(),
  };
}

describe('MusicService', () => {
  it('never resolves yt-dlp from a relative or project-local executable path', () => {
    const previous = process.env.YT_DLP_PATH;
    process.env.YT_DLP_PATH = 'yt-dlp';
    try {
      const root = path.resolve(process.cwd());
      expect(executableCandidates().every((candidate) => {
        const relative = path.relative(root, candidate);
        return path.isAbsolute(candidate) && relative !== '' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
      })).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.YT_DLP_PATH;
      else process.env.YT_DLP_PATH = previous;
    }
  });

  it('returns an honest unavailable state when yt-dlp is missing', async () => {
    const unavailable: MusicProcessRunner = {
      getVersion: vi.fn(async () => { throw new Error('missing'); }),
      run: vi.fn(async () => ''),
      dispose: vi.fn(),
    };
    await expect(new MusicService(unavailable, publicDns).getStatus()).resolves.toMatchObject({
      available: false,
      version: null,
      message: expect.stringContaining('Install yt-dlp'),
    });
  });

  it('loads a bounded flat playlist and resolves only its opaque track IDs', async () => {
    const process = runner([
      JSON.stringify({
        title: 'Focus queue',
        entries: [
          { title: 'First track', webpage_url: 'https://media.example/one', duration: 61 },
          { title: 'Second track', webpage_url: 'https://media.example/two', duration: 122 },
        ],
      }),
      JSON.stringify({ title: 'First track', duration: 61, url: 'https://cdn.example/audio.m4a?token=short-lived' }),
    ]);
    const service = new MusicService(process, publicDns);

    const queue = await service.load('https://media.example/playlist?id=focus');
    expect(queue.title).toBe('Focus queue');
    expect(queue.tracks).toHaveLength(2);
    expect(queue.tracks[0]).not.toHaveProperty('sourceUrl');
    expect(process.run.mock.calls[0]?.[0]).toEqual(expect.arrayContaining(['--flat-playlist', '--playlist-end', '200']));

    const stream = await service.resolveTrack(queue.tracks[0]!.id);
    expect(stream.url).toBe('https://cdn.example/audio.m4a?token=short-lived');
    expect(process.run.mock.calls[1]?.[0]).toEqual(expect.arrayContaining(['--no-playlist', '--format']));
    await expect(service.resolveTrack('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).rejects.toThrow(/no longer/);
    service.reset();
    expect(process.dispose).toHaveBeenCalledOnce();
    await expect(service.resolveTrack(queue.tracks[0]!.id)).rejects.toThrow(/no longer/);
  });

  it('keeps earlier URL tracks resolvable across queue appends until explicitly cleared', async () => {
    const process = runner([
      JSON.stringify({ title: 'First source', webpage_url: 'https://media.example/one' }),
      JSON.stringify({ title: 'Second source', webpage_url: 'https://media.example/two' }),
      JSON.stringify({ title: 'First source', duration: 61, url: 'https://cdn.example/one.m4a' }),
    ]);
    const service = new MusicService(process, publicDns);

    const first = await service.load('https://media.example/one');
    await service.load('https://media.example/two');
    await expect(service.resolveTrack(first.tracks[0]!.id)).resolves.toMatchObject({ title: 'First source' });

    service.clearQueue();
    await expect(service.resolveTrack(first.tracks[0]!.id)).rejects.toThrow(/no longer/);
    expect(process.dispose).toHaveBeenCalledOnce();
  });

  it('blocks private, local, credentialed, and non-HTTPS sources before invoking yt-dlp', async () => {
    const process = runner([]);
    const privateDns = vi.fn(async () => ['127.0.0.1']);
    const service = new MusicService(process, privateDns);

    await expect(service.load('http://example.com/audio')).rejects.toThrow(/public HTTPS/);
    await expect(service.load('https://user:pass@example.com/audio')).rejects.toThrow(/public HTTPS/);
    await expect(service.load('https://localhost/audio')).rejects.toThrow(/public HTTPS/);
    await expect(service.load('https://example.com/audio')).rejects.toThrow(/private network/);
    expect(process.run).not.toHaveBeenCalled();
  });

  it('does not spawn yt-dlp when Clear cancels a request during DNS validation', async () => {
    let releaseDns: ((addresses: string[]) => void) | undefined;
    const deferredDns = vi.fn(() => new Promise<string[]>((resolve) => { releaseDns = resolve; }));
    const process = runner([]);
    const service = new MusicService(process, deferredDns);
    const pending = service.load('https://media.example/slow');
    await vi.waitFor(() => expect(deferredDns).toHaveBeenCalledOnce());

    service.clearQueue();
    releaseDns?.(['93.184.216.34']);
    await expect(pending).rejects.toThrow(/queue changed/);
    expect(process.run).not.toHaveBeenCalled();
  });

  it('serializes extraction work so rapid requests cannot fan out processes', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<string>((resolve) => { release = () => resolve(JSON.stringify({ title: 'One', webpage_url: 'https://media.example/one' })); });
    const process: MusicProcessRunner = {
      getVersion: vi.fn(async () => '2026.03.17'),
      run: vi.fn(() => pending),
      dispose: vi.fn(),
    };
    const service = new MusicService(process, publicDns);
    const first = service.load('https://media.example/one');
    await Promise.resolve();
    await expect(service.load('https://media.example/two')).rejects.toThrow(/still being resolved/);
    release?.();
    await expect(first).resolves.toMatchObject({ tracks: [expect.objectContaining({ title: 'One' })] });
  });
});
