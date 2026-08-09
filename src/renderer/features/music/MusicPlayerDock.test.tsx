import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiDesktopApi } from '../../../shared/contracts/ipc';
import { useUiStore } from '../../stores/uiStore';
import { MusicPlayerDock } from './MusicPlayerDock';

const firstId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secondId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

beforeEach(() => {
  useUiStore.setState({ musicPlayerEnabled: true, musicPlaying: false });
  Object.defineProperties(URL, {
    createObjectURL: { configurable: true, value: vi.fn(() => 'blob:local-audio') },
    revokeObjectURL: { configurable: true, value: vi.fn() },
  });
  Object.defineProperties(HTMLMediaElement.prototype, {
    load: { configurable: true, value: vi.fn() },
    play: { configurable: true, value: vi.fn(async () => undefined) },
    pause: { configurable: true, value: vi.fn() },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, 'piDesktop');
  useUiStore.setState({ musicPlayerEnabled: false, musicPlaying: false });
  vi.restoreAllMocks();
});

describe('MusicPlayerDock', () => {
  it('stays fully unmounted while disabled in settings', () => {
    useUiStore.setState({ musicPlayerEnabled: false });
    render(<MusicPlayerDock />);
    expect(screen.queryByRole('button', { name: 'Open music player' })).not.toBeInTheDocument();
  });

  it('loads a playlist, resolves lazily, and controls the whole queue', async () => {
    const getMusicStatus = vi.fn(async () => ({ available: true, version: '2026.03.17' as string, message: undefined }));
    const loadMusic = vi.fn(async () => ({
      title: 'Focus queue',
      tracks: [
        { id: firstId, title: 'First track', duration: 61 },
        { id: secondId, title: 'Second track', duration: 122 },
      ],
    }));
    const resolveMusicTrack = vi.fn(async (trackId: string) => ({
      trackId,
      title: trackId === firstId ? 'First track' : 'Second track',
      duration: trackId === firstId ? 61 : 122,
      url: `https://cdn.example/${trackId}.m4a`,
    }));
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: { getMusicStatus, loadMusic, resolveMusicTrack } as unknown as PiDesktopApi,
    });
    const user = userEvent.setup();
    const { container } = render(<MusicPlayerDock />);

    await waitFor(() => expect(getMusicStatus).toHaveBeenCalledOnce());
    await user.click(screen.getByRole('button', { name: 'Open music player' }));
    await user.type(screen.getByLabelText('Media or playlist link'), 'https://media.example/playlist');
    await user.click(screen.getByRole('button', { name: 'Load music link' }));

    await waitFor(() => expect(container.querySelector('.music-track-copy strong')).toHaveTextContent('First track'));
    expect(loadMusic).toHaveBeenCalledWith('https://media.example/playlist');
    expect(resolveMusicTrack).toHaveBeenCalledWith(firstId);
    const audio = container.querySelector('audio')!;
    await waitFor(() => expect(audio).toHaveAttribute('src', `https://cdn.example/${firstId}.m4a`));

    await user.click(screen.getByRole('button', { name: 'Show playlist' }));
    expect(screen.getByRole('complementary', { name: 'Playlist' })).toBeInTheDocument();
    expect(screen.getByText('2 tracks')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Play Second track' }));
    await waitFor(() => expect(container.querySelector('.music-track-copy strong')).toHaveTextContent('Second track'));
    expect(resolveMusicTrack).toHaveBeenLastCalledWith(secondId);
    expect(screen.getByText('2 / 2')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '35' } });
    await waitFor(() => expect(audio.volume).toBeCloseTo(0.35));
    await user.click(screen.getByRole('button', { name: 'Mute music' }));
    expect(audio.muted).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Unmute music' }));
    expect(audio.muted).toBe(false);
  });

  it('cycles queue and current-track looping without re-resolving a repeated track', async () => {
    const resolveMusicTrack = vi.fn(async (trackId: string) => ({
      trackId,
      title: trackId === firstId ? 'First track' : 'Second track',
      duration: 60,
      url: `https://cdn.example/${trackId}.m4a`,
    }));
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getMusicStatus: vi.fn(async () => ({ available: true, version: '2026.03.17', message: undefined })),
        loadMusic: vi.fn(async () => ({
          title: 'Loop queue',
          tracks: [
            { id: firstId, title: 'First track', duration: 60 },
            { id: secondId, title: 'Second track', duration: 60 },
          ],
        })),
        resolveMusicTrack,
      } as unknown as PiDesktopApi,
    });
    const user = userEvent.setup();
    const { container } = render(<MusicPlayerDock />);
    await user.click(screen.getByRole('button', { name: 'Open music player' }));
    await user.type(screen.getByLabelText('Media or playlist link'), 'https://media.example/loop');
    await user.click(screen.getByRole('button', { name: 'Load music link' }));
    await waitFor(() => expect(container.querySelector('audio')).toHaveAttribute('src', `https://cdn.example/${firstId}.m4a`));
    await user.click(screen.getByRole('button', { name: 'Next track' }));
    await waitFor(() => expect(container.querySelector('audio')).toHaveAttribute('src', `https://cdn.example/${secondId}.m4a`));

    const queueLoop = screen.getByRole('button', { name: 'Loop mode: Off. Activate to loop queue' });
    await user.click(queueLoop);
    expect(screen.getByRole('button', { name: 'Loop mode: Queue. Activate to loop current track' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.ended(container.querySelector('audio')!);
    await waitFor(() => expect(container.querySelector('audio')).toHaveAttribute('src', `https://cdn.example/${firstId}.m4a`));

    await user.click(screen.getByRole('button', { name: 'Loop mode: Queue. Activate to loop current track' }));
    const audio = container.querySelector('audio')!;
    expect(audio).toHaveAttribute('loop');
    const resolutionsBeforeReplay = resolveMusicTrack.mock.calls.length;
    fireEvent.ended(audio);
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    expect(resolveMusicTrack).toHaveBeenCalledTimes(resolutionsBeforeReplay);

    await user.click(screen.getByRole('button', { name: 'Loop mode: Current track. Activate to turn looping off' }));
    expect(screen.getByRole('button', { name: 'Loop mode: Off. Activate to loop queue' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('appends URL and local imports without interrupting the active track, then clears explicitly', async () => {
    const loadMusic = vi.fn()
      .mockResolvedValueOnce({ title: 'First source', tracks: [{ id: firstId, title: 'First track', duration: 61 }] })
      .mockResolvedValueOnce({ title: 'Second source', tracks: [{ id: secondId, title: 'Second track', duration: 122 }] });
    const resolveMusicTrack = vi.fn(async (trackId: string) => ({
      trackId, title: 'First track', duration: 61, url: `https://cdn.example/${trackId}.m4a`,
    }));
    const clearMusicQueue = vi.fn(async () => undefined);
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getMusicStatus: vi.fn(async () => ({ available: true, version: '2026.03.17', message: undefined })),
        loadMusic,
        resolveMusicTrack,
        clearMusicQueue,
      } as unknown as PiDesktopApi,
    });
    const user = userEvent.setup();
    const { container } = render(<MusicPlayerDock />);
    await user.click(screen.getByRole('button', { name: 'Open music player' }));

    const source = screen.getByLabelText('Media or playlist link');
    await user.type(source, 'https://media.example/one');
    await user.click(screen.getByRole('button', { name: 'Load music link' }));
    const audio = container.querySelector('audio')!;
    await waitFor(() => expect(audio).toHaveAttribute('src', `https://cdn.example/${firstId}.m4a`));
    fireEvent.play(audio);
    expect(useUiStore.getState().musicPlaying).toBe(true);

    await user.type(source, 'https://media.example/two');
    await user.click(screen.getByRole('button', { name: 'Load music link' }));
    await waitFor(() => expect(screen.getByText('Added 1 track to queue')).toBeInTheDocument());
    expect(audio).toHaveAttribute('src', `https://cdn.example/${firstId}.m4a`);
    expect(container.querySelector('.music-track-copy strong')).toHaveTextContent('First track');
    expect(resolveMusicTrack).toHaveBeenCalledTimes(1);

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(fileInput, { target: { files: [new File(['audio'], 'Local third.mp3', { type: 'audio/mpeg' })] } });
    expect(await screen.findByText('Added 1 local track to queue')).toBeInTheDocument();
    expect(audio).toHaveAttribute('src', `https://cdn.example/${firstId}.m4a`);

    await user.click(screen.getByRole('button', { name: 'Show playlist' }));
    expect(screen.getByText('3 tracks')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Loop mode: Off. Activate to loop queue' }));
    await user.click(screen.getByRole('button', { name: 'Clear playlist' }));
    await waitFor(() => expect(clearMusicQueue).toHaveBeenCalledOnce());
    expect(screen.getByRole('complementary', { name: 'Playlist' })).toHaveTextContent('Nothing queued');
    expect(audio).not.toHaveAttribute('src');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-audio');
    expect(screen.getByRole('button', { name: 'Loop mode: Off. Activate to loop queue' })).toHaveAttribute('aria-pressed', 'false');
    expect(useUiStore.getState().musicPlaying).toBe(false);
  });

  it('starts a newly queued track when the previous queue ended naturally', async () => {
    const loadMusic = vi.fn()
      .mockResolvedValueOnce({ title: 'First source', tracks: [{ id: firstId, title: 'First track', duration: 61 }] })
      .mockResolvedValueOnce({ title: 'Second source', tracks: [{ id: secondId, title: 'Second track', duration: 122 }] });
    const resolveMusicTrack = vi.fn(async (trackId: string) => ({
      trackId,
      title: trackId === firstId ? 'First track' : 'Second track',
      duration: trackId === firstId ? 61 : 122,
      url: `https://cdn.example/${trackId}.m4a`,
    }));
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getMusicStatus: vi.fn(async () => ({ available: true, version: '2026.03.17', message: undefined })),
        loadMusic,
        resolveMusicTrack,
      } as unknown as PiDesktopApi,
    });
    const user = userEvent.setup();
    const { container } = render(<MusicPlayerDock />);
    await user.click(screen.getByRole('button', { name: 'Open music player' }));
    const source = screen.getByLabelText('Media or playlist link');
    await user.type(source, 'https://media.example/one');
    await user.click(screen.getByRole('button', { name: 'Load music link' }));
    const audio = container.querySelector('audio')!;
    await waitFor(() => expect(audio).toHaveAttribute('src', `https://cdn.example/${firstId}.m4a`));

    fireEvent.ended(audio);
    expect(useUiStore.getState().musicPlaying).toBe(false);
    await user.type(source, 'https://media.example/two');
    await user.click(screen.getByRole('button', { name: 'Load music link' }));

    await waitFor(() => expect(audio).toHaveAttribute('src', `https://cdn.example/${secondId}.m4a`));
    expect(resolveMusicTrack).toHaveBeenLastCalledWith(secondId);
    fireEvent.canPlay(audio);
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
  });

  it('does not auto-start a queued track when the current track was paused', async () => {
    const loadMusic = vi.fn()
      .mockResolvedValueOnce({ title: 'First source', tracks: [{ id: firstId, title: 'First track', duration: 61 }] })
      .mockResolvedValueOnce({ title: 'Second source', tracks: [{ id: secondId, title: 'Second track', duration: 122 }] });
    const resolveMusicTrack = vi.fn(async (trackId: string) => ({
      trackId, title: trackId === firstId ? 'First track' : 'Second track', duration: 61, url: `https://cdn.example/${trackId}.m4a`,
    }));
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getMusicStatus: vi.fn(async () => ({ available: true, version: '2026.03.17', message: undefined })),
        loadMusic, resolveMusicTrack,
      } as unknown as PiDesktopApi,
    });
    const user = userEvent.setup();
    const { container } = render(<MusicPlayerDock />);
    await user.click(screen.getByRole('button', { name: 'Open music player' }));
    const source = screen.getByLabelText('Media or playlist link');
    await user.type(source, 'https://media.example/one');
    await user.click(screen.getByRole('button', { name: 'Load music link' }));
    const audio = container.querySelector('audio')!;
    await waitFor(() => expect(audio).toHaveAttribute('src', `https://cdn.example/${firstId}.m4a`));
    fireEvent.play(audio);
    fireEvent.pause(audio);

    await user.type(source, 'https://media.example/two');
    await user.click(screen.getByRole('button', { name: 'Load music link' }));
    await waitFor(() => expect(screen.getByText('Added 1 track to queue')).toBeInTheDocument());
    expect(resolveMusicTrack).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().musicPlaying).toBe(false);
  });

  it('lets Clear playlist cancel an in-flight extractor before a queue exists', async () => {
    let finishLoad: ((queue: { title: string; tracks: Array<{ id: string; title: string; duration: number }> }) => void) | undefined;
    const loadMusic = vi.fn(() => new Promise<{ title: string; tracks: Array<{ id: string; title: string; duration: number }> }>((resolve) => { finishLoad = resolve; }));
    const clearMusicQueue = vi.fn(async () => undefined);
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getMusicStatus: vi.fn(async () => ({ available: true, version: '2026.03.17', message: undefined })),
        loadMusic,
        clearMusicQueue,
      } as unknown as PiDesktopApi,
    });
    const user = userEvent.setup();
    render(<MusicPlayerDock />);
    await user.click(screen.getByRole('button', { name: 'Open music player' }));
    await user.type(screen.getByLabelText('Media or playlist link'), 'https://media.example/slow');
    await user.click(screen.getByRole('button', { name: 'Load music link' }));
    await user.click(screen.getByRole('button', { name: 'Show playlist' }));

    const clear = screen.getByRole('button', { name: 'Clear playlist' });
    expect(clear).toBeEnabled();
    await user.click(clear);
    await waitFor(() => expect(clearMusicQueue).toHaveBeenCalledOnce());
    finishLoad?.({ title: 'Stale', tracks: [{ id: firstId, title: 'Stale track', duration: 10 }] });
    await waitFor(() => expect(screen.getByRole('complementary', { name: 'Playlist' })).toHaveTextContent('Nothing queued'));
  });

  it('offers play, pause, progress seeking, and an honest unavailable state', async () => {
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getMusicStatus: vi.fn(async () => ({ available: false, version: null, message: 'Install yt-dlp on PATH, then restart Fate UI.' })),
      } as unknown as PiDesktopApi,
    });
    const user = userEvent.setup();
    render(<MusicPlayerDock />);
    await user.click(screen.getByRole('button', { name: 'Open music player' }));
    expect(await screen.findByText(/Install yt-dlp/)).toBeInTheDocument();
    expect(screen.getByLabelText('Media or playlist link')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Open local audio' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Show playlist' }));
    expect(screen.getByRole('complementary', { name: 'Playlist' })).toHaveTextContent('Nothing queued');

    fireEvent.change(screen.getByLabelText('Playback position'), { target: { value: '10' } });
    expect(screen.getByLabelText('Playback position')).toBeDisabled();
  });

  it('opens local audio without yt-dlp and rejects pasted device paths before IPC', async () => {
    const loadMusic = vi.fn();
    const resolveMusicTrack = vi.fn();
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getMusicStatus: vi.fn(async () => ({ available: false, version: null, message: 'yt-dlp unavailable' })),
        loadMusic,
        resolveMusicTrack,
      } as unknown as PiDesktopApi,
    });
    const user = userEvent.setup();
    const { container, unmount } = render(<MusicPlayerDock />);
    await user.click(screen.getByRole('button', { name: 'Open music player' }));

    const sourceInput = screen.getByLabelText('Media or playlist link');
    await user.type(sourceInput, 'C:\\Music\\Čudesna pjesma.mp3');
    await user.click(screen.getByRole('button', { name: 'Load music link' }));
    expect(await screen.findByText('Use Open local audio for files on this device.')).toBeInTheDocument();
    expect(loadMusic).not.toHaveBeenCalled();

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(fileInput, { target: { files: [new File(['audio'], 'Čudesna pjesma.mp3', { type: 'audio/mpeg' })] } });
    await waitFor(() => expect(container.querySelector('.music-track-copy strong')).toHaveTextContent('Čudesna pjesma'));
    expect(resolveMusicTrack).not.toHaveBeenCalled();
    expect(container.querySelector('audio')).toHaveAttribute('src', 'blob:local-audio');
    expect(screen.queryByText(/Local audio ready/i)).not.toBeInTheDocument();

    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-audio');
  });
});
