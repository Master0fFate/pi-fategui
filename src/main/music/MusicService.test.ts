import { describe, expect, it, vi } from 'vitest';
import { connect } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MusicService, PublicHttpsProxy, executableCandidates, isPublicIpAddress, type AudioDownloadRequest, type AudioDownloadResult, type AudioDownloader, type MusicProcessRunner } from './MusicService';

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
  it('rejects private, translated, and non-canonical loopback addresses', () => {
    for (const address of [
      '127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', 'fc00::1',
      '::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1', '64:ff9b::7f00:1',
    ]) expect(isPublicIpAddress(address), address).toBe(false);
    expect(isPublicIpAddress('93.184.216.34')).toBe(true);
    expect(isPublicIpAddress('2606:4700:4700::1111')).toBe(true);
  });

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
    const proxyIndex = process.run.mock.calls[0]?.[0].indexOf('--proxy') ?? -1;
    expect(process.run.mock.calls[0]?.[0][proxyIndex + 1]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);

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

  it('revalidates every yt-dlp CONNECT target and blocks DNS rebinding to loopback', async () => {
    const privateDns = vi.fn(async () => ['127.0.0.1']);
    const proxy = new PublicHttpsProxy(privateDns);
    const proxyUrl = new URL(await proxy.start());
    try {
      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect(Number(proxyUrl.port), proxyUrl.hostname);
        let received = '';
        const timeout = setTimeout(() => { socket.destroy(); reject(new Error('Proxy response timed out.')); }, 2_000);
        socket.setEncoding('utf8');
        socket.once('connect', () => socket.write('CONNECT attacker.example:443 HTTP/1.1\r\nHost: attacker.example:443\r\n\r\n'));
        socket.on('data', (chunk) => {
          received += chunk;
          if (!received.includes('\r\n\r\n')) return;
          clearTimeout(timeout);
          socket.destroy();
          resolve(received);
        });
        socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
      });
      expect(response).toMatch(/^HTTP\/1\.1 403 Forbidden/u);
      expect(privateDns).toHaveBeenCalledWith('attacker.example', expect.any(AbortSignal));
    } finally {
      proxy.dispose();
    }
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

  it('backfills missing playlist durations in the background and reports them', async () => {
    const sink = vi.fn<(updates: ReadonlyArray<{ trackId: string; duration: number }>) => void>();
    const process = runner([
      JSON.stringify({
        title: 'Quiet queue',
        entries: [
          { title: 'One', webpage_url: 'https://media.example/one' },
          { title: 'Two', webpage_url: 'https://media.example/two', duration: 120 },
        ],
      }),
      `${JSON.stringify({ title: 'One', duration: 61, webpage_url: 'https://media.example/one' })}\n`,
    ]);
    const service = new MusicService(process, publicDns);
    service.setDurationSink(sink);

    const queue = await service.load('https://media.example/playlist');
    expect(queue.tracks.map((track) => track.duration)).toEqual([null, 120]);

    await vi.waitFor(() => expect(sink).toHaveBeenCalledWith([{ trackId: queue.tracks[0]!.id, duration: 61 }]));
    expect(process.run.mock.calls[1]?.[0]).toEqual(expect.arrayContaining([
      '--no-playlist', '--flat-playlist', '--ignore-errors', '--dump-json', 'https://media.example/one',
    ]));
  });

  it('stops background duration work when the queue is cleared', async () => {
    const sink = vi.fn();
    const process = runner([
      JSON.stringify({
        title: 'Quiet queue',
        entries: [
          { title: 'One', webpage_url: 'https://media.example/one' },
          { title: 'Two', webpage_url: 'https://media.example/two' },
        ],
      }),
    ]);
    const service = new MusicService(process, publicDns);
    service.setDurationSink(sink);

    await service.load('https://media.example/playlist');
    service.clearQueue();
    await new Promise((resolve) => { setTimeout(resolve, 60); });
    expect(process.run).toHaveBeenCalledTimes(1);
    expect(sink).not.toHaveBeenCalled();
  });

  it('gives up after unreadable duration batches instead of retrying forever', async () => {
    const sink = vi.fn();
    const process = runner([
      JSON.stringify({
        title: 'Quiet queue',
        entries: [{ title: 'One', webpage_url: 'https://media.example/one' }],
      }),
      'not json at all\n',
    ]);
    const service = new MusicService(process, publicDns);
    service.setDurationSink(sink);

    await service.load('https://media.example/playlist');
    await vi.waitFor(() => expect(process.run).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => { setTimeout(resolve, 60); });
    expect(process.run).toHaveBeenCalledTimes(2);
    expect(sink).not.toHaveBeenCalled();
  });

  it('pre-empts background duration work when the user plays a track', async () => {
    const sink = vi.fn();
    let releaseChunk!: (value: string) => void;
    const run = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        title: 'Quiet queue',
        entries: [{ title: 'One', webpage_url: 'https://media.example/one' }],
      }))
      .mockImplementationOnce(() => new Promise<string>((resolve) => { releaseChunk = resolve; }))
      .mockResolvedValueOnce(JSON.stringify({ title: 'One', duration: 61, url: 'https://cdn.example/one.m4a' }));
    const process: MusicProcessRunner = { getVersion: vi.fn(async () => '2026.03.17'), run, dispose: vi.fn() };
    const service = new MusicService(process, publicDns);
    service.setDurationSink(sink);

    const queue = await service.load('https://media.example/playlist');
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));

    const streamPromise = service.resolveTrack(queue.tracks[0]!.id);
    releaseChunk(`${JSON.stringify({ title: 'One', duration: 61, webpage_url: 'https://media.example/one' })}\n`);
    await expect(streamPromise).resolves.toMatchObject({ duration: 61, url: 'https://cdn.example/one.m4a' });
    expect(run.mock.calls[2]?.[0]).toEqual(expect.arrayContaining(['--no-playlist', '--format']));

    await vi.waitFor(() => expect(sink).toHaveBeenCalledWith([{ trackId: queue.tracks[0]!.id, duration: 61 }]));
    await new Promise((resolve) => { setTimeout(resolve, 60); });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('answers repeated track resolutions from the stream cache without re-running yt-dlp', async () => {
    const process = runner([
      JSON.stringify({ title: 'Loop queue', entries: [{ title: 'One', webpage_url: 'https://media.example/one', duration: 61 }] }),
      JSON.stringify({ title: 'One', duration: 61, url: 'https://cdn.example/one.m4a?token=short-lived' }),
    ]);
    const service = new MusicService(process, publicDns);

    const queue = await service.load('https://media.example/playlist');
    const first = await service.resolveTrack(queue.tracks[0]!.id);
    const second = await service.resolveTrack(queue.tracks[0]!.id);
    expect(second.url).toBe(first.url);
    expect(process.run).toHaveBeenCalledTimes(2);
  });

  it('prefetches the next queue track in the background and serves it from the local media cache', async () => {
    const prefetchBytes = Buffer.from('PREFETCHED-AUDIO');
    const download = vi.fn(async (request: AudioDownloadRequest) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(request.destination, prefetchBytes);
      expect(request.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect(request.bytesPerSecond).toBeLessThan(1024 * 1024);
      return { contentType: 'audio/mp4', bytes: prefetchBytes.length };
    });
    const process = runner([
      JSON.stringify({
        title: 'Focus queue',
        entries: [
          { title: 'One', webpage_url: 'https://media.example/one', duration: 61 },
          { title: 'Two', webpage_url: 'https://media.example/two', duration: 122 },
        ],
      }),
      JSON.stringify({ title: 'One', duration: 61, url: 'https://cdn.example/one.m4a?token=a' }),
      JSON.stringify({ title: 'Two', duration: 122, url: 'https://cdn.example/two.m4a?token=b' }),
    ]);
    const service = new MusicService(process, publicDns, download);

    const queue = await service.load('https://media.example/playlist');
    await service.resolveTrack(queue.tracks[0]!.id);
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());

    const second = await service.resolveTrack(queue.tracks[1]!.id);
    expect(second.url).toMatch(/^fate-media:\/\/audio\/[0-9a-f]{32}$/u);
    expect(process.run).toHaveBeenCalledTimes(3);

    const served = service.openMediaRequest('GET', second.url, null);
    expect(served).toMatchObject({ status: 200, totalBytes: prefetchBytes.length, contentType: 'audio/mp4' });
    if (!('file' in served)) throw new Error('The media request should have resolved a cache file.');
    await expect(readFile(served.file)).resolves.toEqual(prefetchBytes);

    expect(service.openMediaRequest('GET', second.url, 'bytes=0-3')).toMatchObject({ status: 206, start: 0, end: 3 });
    expect(service.openMediaRequest('GET', second.url, 'bytes=999-')).toMatchObject({ status: 416 });
    expect(service.openMediaRequest('GET', second.url.replace(/[0-9a-f]{32}/u, '0'.repeat(32)), null)).toMatchObject({ status: 404 });
    expect(service.openMediaRequest('POST', second.url, null)).toMatchObject({ status: 405 });
  });

  it('tolerates prefetch download failures and still resolves the track on demand', async () => {
    const download = vi.fn(async () => { throw new Error('network reset'); });
    const process = runner([
      JSON.stringify({
        title: 'Focus queue',
        entries: [
          { title: 'One', webpage_url: 'https://media.example/one', duration: 61 },
          { title: 'Two', webpage_url: 'https://media.example/two', duration: 122 },
        ],
      }),
      JSON.stringify({ title: 'One', duration: 61, url: 'https://cdn.example/one.m4a?token=a' }),
      JSON.stringify({ title: 'Two', duration: 122, url: 'https://cdn.example/two.m4a?token=b' }),
    ]);
    const service = new MusicService(process, publicDns, download);

    const queue = await service.load('https://media.example/playlist');
    await service.resolveTrack(queue.tracks[0]!.id);
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    await new Promise((resolve) => { setTimeout(resolve, 60); });

    await expect(service.resolveTrack(queue.tracks[1]!.id)).resolves.toMatchObject({ url: 'https://cdn.example/two.m4a?token=b' });
    expect(process.run).toHaveBeenCalledTimes(3);
    expect(download).toHaveBeenCalledOnce();
  });

  it('does not stall user resolutions behind an in-flight prefetch download', async () => {
    const { writeFile } = await import('node:fs/promises');
    let releaseDownload!: () => void;
    const download: AudioDownloader = vi.fn((request) => new Promise<AudioDownloadResult>((resolve, reject) => {
      void writeFile(request.destination, Buffer.from('NEXT')).catch(() => reject(new Error('write failed')));
      releaseDownload = () => resolve({ contentType: 'audio/mp4', bytes: 4 });
      request.signal.addEventListener('abort', () => resolve({ contentType: 'audio/mp4', bytes: 4 }));
    }));
    const process = runner([
      JSON.stringify({
        title: 'Focus queue',
        entries: [
          { title: 'One', webpage_url: 'https://media.example/one', duration: 61 },
          { title: 'Two', webpage_url: 'https://media.example/two', duration: 122 },
          { title: 'Three', webpage_url: 'https://media.example/three', duration: 183 },
        ],
      }),
      JSON.stringify({ title: 'One', duration: 61, url: 'https://cdn.example/one.m4a?token=a' }),
      JSON.stringify({ title: 'Two', duration: 122, url: 'https://cdn.example/two.m4a?token=b' }),
      JSON.stringify({ title: 'Three', duration: 183, url: 'https://cdn.example/three.m4a?token=c' }),
    ]);
    const service = new MusicService(process, publicDns, download);

    const queue = await service.load('https://media.example/playlist');
    await service.resolveTrack(queue.tracks[0]!.id);
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());

    // The hanging background download must not block an explicit user action.
    await expect(service.resolveTrack(queue.tracks[2]!.id)).resolves.toMatchObject({ url: 'https://cdn.example/three.m4a?token=c' });
    expect(process.run).toHaveBeenCalledTimes(4);

    releaseDownload();
    await vi.waitFor(() => expect(service.resolveTrack(queue.tracks[1]!.id)).resolves.toMatchObject({ url: /^fate-media:\/\/audio\//u }));
  });

  it('invalidates media tokens and cached files when the queue is cleared', async () => {
    const { writeFile } = await import('node:fs/promises');
    const download = vi.fn(async (request: AudioDownloadRequest) => {
      await writeFile(request.destination, Buffer.from('GONE'));
      return { contentType: 'audio/mp4', bytes: 4 };
    });
    const process = runner([
      JSON.stringify({
        title: 'Focus queue',
        entries: [
          { title: 'One', webpage_url: 'https://media.example/one', duration: 61 },
          { title: 'Two', webpage_url: 'https://media.example/two', duration: 122 },
        ],
      }),
      JSON.stringify({ title: 'One', duration: 61, url: 'https://cdn.example/one.m4a?token=a' }),
      JSON.stringify({ title: 'Two', duration: 122, url: 'https://cdn.example/two.m4a?token=b' }),
    ]);
    const service = new MusicService(process, publicDns, download);

    const queue = await service.load('https://media.example/playlist');
    await service.resolveTrack(queue.tracks[0]!.id);
    const cached = await vi.waitFor(async () => {
      const stream = await service.resolveTrack(queue.tracks[1]!.id);
      expect(stream.url).toMatch(/^fate-media:\/\/audio\//u);
      return stream.url;
    });

    service.clearQueue();
    expect(service.openMediaRequest('GET', cached, null)).toMatchObject({ status: 404 });
    await expect(service.resolveTrack(queue.tracks[1]!.id)).rejects.toThrow(/no longer/u);
  });
});
