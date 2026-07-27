import {
  ArrowRight,
  ChevronUp,
  FolderOpen,
  Link2,
  ListMusic,
  ListX,
  LoaderCircle,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { type ChangeEvent, type CSSProperties, type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { MusicQueue, MusicStream, MusicTrack } from '../../../shared/contracts/ipc';
import { AppTooltip } from '../../components/AppTooltip';
import { useUiStore } from '../../stores/uiStore';
import { MAX_LOCAL_AUDIO_TRACKS, MAX_MUSIC_QUEUE_TRACKS, appendMusicQueue, isSupportedLocalAudio, localAudioTitle, remoteMusicSourceError } from './musicSources';

function bridgeMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message.trim()) return fallback;
  const jsonStart = error.message.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(error.message.slice(jsonStart)) as { message?: unknown };
      if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message;
    } catch {
      // Keep the original bridge message when it is not a serialized AppError.
    }
  }
  return error.message;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const rounded = Math.floor(seconds);
  const minutes = Math.floor(rounded / 60);
  return `${minutes}:${String(rounded % 60).padStart(2, '0')}`;
}

export function MusicPlayerDock() {
  const enabled = useUiStore((state) => state.musicPlayerEnabled);
  const playing = useUiStore((state) => state.musicPlaying);
  const setPlaying = useUiStore((state) => state.setMusicPlaying);
  const [open, setOpen] = useState(false);
  const [playlistOpen, setPlaylistOpen] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [source, setSource] = useState('');
  const [queue, setQueue] = useState<MusicQueue | null>(null);
  const [trackIndex, setTrackIndex] = useState(0);
  const [stream, setStream] = useState<MusicStream | null>(null);
  const [busy, setBusy] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [notice, setNotice] = useState('Paste a public media link or open local audio.');
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const playlistRef = useRef<HTMLElement>(null);
  const sourceRef = useRef<HTMLInputElement>(null);
  const localFileInputRef = useRef<HTMLInputElement>(null);
  const queueRef = useRef<MusicQueue | null>(null);
  const localStreamsRef = useRef(new Map<string, { url: string; title: string }>());
  const requestId = useRef(0);
  const playWhenReady = useRef(false);
  const lastAudibleVolume = useRef(1);

  const clearLocalAudio = useCallback(() => {
    for (const local of localStreamsRef.current.values()) URL.revokeObjectURL(local.url);
    localStreamsRef.current.clear();
  }, []);

  useEffect(() => () => {
    clearLocalAudio();
    setPlaying(false);
  }, [clearLocalAudio, setPlaying]);

  useEffect(() => {
    if (!enabled) {
      requestId.current += 1;
      queueRef.current = null;
      setOpen(false);
      setPlaylistOpen(false);
      setQueue(null);
      setStream(null);
      setPlaying(false);
      clearLocalAudio();
      return;
    }
    if (!('piDesktop' in window) || typeof window.piDesktop.getMusicStatus !== 'function') {
      setAvailable(false);
      setNotice('Restart Fate UI to activate the music bridge.');
      return;
    }
    let active = true;
    setAvailable(null);
    setNotice('Checking yt-dlp…');
    void window.piDesktop.getMusicStatus().then((status) => {
      if (!active) return;
      setAvailable(status.available);
      setNotice(status.available ? `yt-dlp ${status.version ?? ''} ready`.trim() : status.message ?? 'yt-dlp is unavailable.');
    }).catch((reason: unknown) => {
      if (!active) return;
      setAvailable(false);
      setNotice(bridgeMessage(reason, 'yt-dlp could not be detected.'));
    });
    return () => { active = false; };
  }, [clearLocalAudio, enabled, setPlaying]);

  useEffect(() => {
    if (panelRef.current) panelRef.current.inert = !open;
    if (playlistRef.current) playlistRef.current.inert = !open || !playlistOpen;
    if (open && !queue) requestAnimationFrame(() => sourceRef.current?.focus());
  }, [open, playlistOpen, queue]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (playlistOpen) setPlaylistOpen(false);
      else setOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [open, playlistOpen]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    setPlaying(false);
    setCurrentTime(0);
    if (!stream) {
      audio.removeAttribute('src');
      return;
    }
    audio.src = stream.url;
    setDuration(stream.duration ?? 0);
    audio.load();
    return () => {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    };
  }, [stream]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = volume;
    audio.muted = muted;
  }, [muted, volume]);

  const prepareTrack = useCallback(async (track: MusicTrack, index: number, autoPlay: boolean) => {
    const currentRequest = ++requestId.current;
    playWhenReady.current = autoPlay;
    setTrackIndex(index);
    setStream(null);
    setBusy(true);
    setError(null);

    const local = localStreamsRef.current.get(track.id);
    if (local) {
      setStream({ trackId: track.id, title: local.title, duration: track.duration, url: local.url });
      setDuration(track.duration ?? 0);
      setNotice('');
      setBusy(false);
      return;
    }

    if (!('piDesktop' in window) || typeof window.piDesktop.resolveMusicTrack !== 'function') {
      playWhenReady.current = false;
      setBusy(false);
      setError('The music bridge is unavailable. Restart Fate UI and try again.');
      return;
    }

    setNotice('Resolving audio stream…');
    try {
      const nextStream = await window.piDesktop.resolveMusicTrack(track.id);
      if (currentRequest !== requestId.current) return;
      setStream(nextStream);
      setDuration(nextStream.duration ?? track.duration ?? 0);
      setNotice('');
    } catch (reason) {
      if (currentRequest !== requestId.current) return;
      playWhenReady.current = false;
      setError(bridgeMessage(reason, 'This track could not be resolved.'));
      setNotice('Playback unavailable');
    } finally {
      if (currentRequest === requestId.current) setBusy(false);
    }
  }, []);

  const loadSource = async (event: FormEvent) => {
    event.preventDefault();
    const link = source.trim();
    if (!link || busy) return;
    if ((queueRef.current?.tracks.length ?? 0) >= MAX_MUSIC_QUEUE_TRACKS) {
      setError('The play queue is full. Clear it before adding more tracks.');
      setNotice('Queue full');
      return;
    }
    const validationError = remoteMusicSourceError(link);
    if (validationError) {
      setError(validationError);
      setNotice('Link unavailable');
      return;
    }
    if (available !== true) {
      setError(available === null ? 'yt-dlp is still being checked.' : 'Install yt-dlp to load web media, or open a local audio file.');
      return;
    }
    if (!('piDesktop' in window) || typeof window.piDesktop.loadMusic !== 'function') {
      setError('The music bridge is unavailable. Restart Fate UI and try again.');
      return;
    }
    const currentRequest = ++requestId.current;
    setBusy(true);
    setError(null);
    setNotice('Reading link…');
    try {
      const incomingQueue = await window.piDesktop.loadMusic(link);
      if (currentRequest !== requestId.current) return;
      const hadQueue = Boolean(queueRef.current?.tracks.length);
      const appended = appendMusicQueue(queueRef.current, incomingQueue);
      queueRef.current = appended.queue;
      setQueue(appended.queue);
      setSource('');
      if (!hadQueue) {
        await prepareTrack(appended.added[0]!, appended.firstAddedIndex, true);
        if (appended.skipped > 0) setNotice(`Queue ready · ${appended.skipped} tracks skipped`);
      } else {
        setBusy(false);
        const count = appended.added.length;
        setNotice(`Added ${count} ${count === 1 ? 'track' : 'tracks'} to queue${appended.skipped > 0 ? ` · ${appended.skipped} skipped` : ''}`);
      }
    } catch (reason) {
      if (currentRequest !== requestId.current) return;
      setError(bridgeMessage(reason, 'The media link could not be loaded.'));
      setNotice('Link unavailable');
      setBusy(false);
    }
  };

  const loadLocalAudio = async (event: ChangeEvent<HTMLInputElement>) => {
    const incoming = [...(event.target.files ?? [])];
    event.target.value = '';
    const remaining = MAX_MUSIC_QUEUE_TRACKS - (queueRef.current?.tracks.length ?? 0);
    if (remaining <= 0) {
      setError('The play queue is full. Clear it before adding more tracks.');
      setNotice('Queue full');
      return;
    }
    const accepted = incoming.filter(isSupportedLocalAudio).slice(0, Math.min(MAX_LOCAL_AUDIO_TRACKS, remaining));
    if (accepted.length === 0) {
      setError('Choose a supported, non-empty audio file under 1 GB.');
      setNotice('Local audio unavailable');
      return;
    }

    const tracks: MusicTrack[] = accepted.flatMap((file) => {
      try {
        const id = crypto.randomUUID();
        const title = localAudioTitle(file.name);
        localStreamsRef.current.set(id, { title, url: URL.createObjectURL(file) });
        return [{ id, title, duration: null }];
      } catch {
        return [];
      }
    });
    if (tracks.length === 0) {
      setError('Fate UI could not open those local audio files.');
      setNotice('Local audio unavailable');
      return;
    }

    const skipped = incoming.length - tracks.length;
    const hadQueue = Boolean(queueRef.current?.tracks.length);
    const incomingQueue: MusicQueue = { title: tracks.length === 1 ? 'Local audio' : 'Local playlist', tracks };
    const appended = appendMusicQueue(queueRef.current, incomingQueue);
    queueRef.current = appended.queue;
    setQueue(appended.queue);
    setSource('');
    setError(null);
    if (!hadQueue) {
      await prepareTrack(appended.added[0]!, appended.firstAddedIndex, true);
      if (skipped > 0) setNotice(`${skipped} ${skipped === 1 ? 'file' : 'files'} skipped`);
    } else {
      const count = appended.added.length;
      setNotice(`Added ${count} local ${count === 1 ? 'track' : 'tracks'} to queue${skipped > 0 ? ` · ${skipped} skipped` : ''}`);
    }
  };

  const clearQueue = async () => {
    if (!busy && !queueRef.current) return;
    requestId.current += 1;
    playWhenReady.current = false;
    setBusy(true);
    setError(null);

    const audio = audioRef.current;
    audio?.pause();
    audio?.removeAttribute('src');
    audio?.load();
    queueRef.current = null;
    setQueue(null);
    setTrackIndex(0);
    setStream(null);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    clearLocalAudio();
    setNotice('Queue cleared');

    if (!('piDesktop' in window) || typeof window.piDesktop.clearMusicQueue !== 'function') {
      setBusy(false);
      setError('Restart Fate UI to activate queue clearing.');
      return;
    }
    try {
      await window.piDesktop.clearMusicQueue();
    } catch (reason) {
      setError(bridgeMessage(reason, 'The queue was cleared locally, but the music bridge could not be reset.'));
    } finally {
      setBusy(false);
    }
  };

  const move = (offset: number, autoPlay = true) => {
    const activeQueue = queueRef.current;
    if (!activeQueue || busy) return;
    const nextIndex = trackIndex + offset;
    const track = activeQueue.tracks[nextIndex];
    if (!track) return;
    void prepareTrack(track, nextIndex, autoPlay);
  };

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio || !stream || busy) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
      return;
    }
    try {
      await audio.play();
      setPlaying(true);
      setError(null);
    } catch {
      setError('Playback was blocked. Press play again after the stream finishes loading.');
    }
  };

  const selectTrack = (track: MusicTrack, index: number) => {
    if (busy) return;
    if (index === trackIndex && stream) {
      if (!playing) void togglePlayback();
      return;
    }
    void prepareTrack(track, index, true);
  };

  const changeVolume = (nextVolume: number) => {
    const clamped = Math.min(1, Math.max(0, nextVolume));
    if (clamped > 0) lastAudibleVolume.current = clamped;
    setVolume(clamped);
    if (clamped > 0) setMuted(false);
  };

  const toggleMute = () => {
    if (muted) {
      setMuted(false);
      return;
    }
    if (volume === 0) {
      setVolume(lastAudibleVolume.current);
      setMuted(false);
      return;
    }
    setMuted(true);
  };

  const toggleDock = () => {
    if (open) setPlaylistOpen(false);
    setOpen((value) => !value);
  };

  const activeTrack = queue?.tracks[trackIndex] ?? null;
  const resolvedDuration = Number.isFinite(duration) && duration > 0 ? duration : activeTrack?.duration ?? 0;
  const queuePosition = queue ? `${trackIndex + 1} / ${queue.tracks.length}` : '—';
  const collectionLabel = queue ? (queue.tracks.length > 1 ? queue.title : 'Now playing') : 'Fate audio';
  const volumePercent = Math.round(volume * 100);
  const silent = muted || volume === 0;
  const VolumeIcon = silent ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  if (!enabled) return null;

  return (
    <div className="music-dock" data-open={open} data-playlist-open={playlistOpen}>
      <aside
        ref={playlistRef}
        id="music-playlist"
        className="music-queue-panel"
        aria-label="Playlist"
        aria-hidden={!open || !playlistOpen}
      >
        <header className="music-queue-heading">
          <div className="music-queue-title">
            <span>Playlist</span>
            <AppTooltip content={queue?.title}><strong>{queue?.title ?? 'Queue'}</strong></AppTooltip>
          </div>
          <div className="music-queue-actions">
            <small>{queue ? `${queue.tracks.length} ${queue.tracks.length === 1 ? 'track' : 'tracks'}` : 'Empty'}</small>
            <AppTooltip content="Clear playlist"><button type="button" aria-label="Clear playlist" disabled={!queue && !busy} onClick={() => void clearQueue()}>
              <ListX size={14} aria-hidden="true" />
            </button></AppTooltip>
          </div>
        </header>
        {open && playlistOpen && (queue ? (
          <ol className="music-queue-list">
            {queue.tracks.map((track, index) => (
              <li key={track.id}>
                <button
                  type="button"
                  data-active={index === trackIndex}
                  aria-current={index === trackIndex ? 'true' : undefined}
                  aria-label={`Play ${track.title}`}
                  disabled={busy}
                  onClick={() => selectTrack(track, index)}
                >
                  <span className="music-queue-index">{String(index + 1).padStart(2, '0')}</span>
                  <span className="music-queue-copy">
                    <AppTooltip content={track.title}><strong>{track.title}</strong></AppTooltip>
                    <small>{formatTime(track.duration ?? 0)}</small>
                  </span>
                  {index === trackIndex && <span className="music-queue-state">{playing ? 'Playing' : 'Current'}</span>}
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <div className="music-queue-empty">
            <ListMusic size={18} aria-hidden="true" />
            <strong>Nothing queued</strong>
            <span>Open local audio or load a public media link.</span>
          </div>
        ))}
      </aside>

      <section ref={panelRef} className="music-player-panel" aria-label="Music player" aria-hidden={!open}>
        <form className="music-source" onSubmit={(event) => void loadSource(event)}>
          <Link2 size={14} aria-hidden="true" />
          <label className="visually-hidden" htmlFor="music-source-url">Media or playlist link</label>
          <input
            ref={sourceRef}
            id="music-source-url"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={source}
            placeholder="Paste media link here"
            disabled={busy}
            onChange={(event) => {
              setSource(event.target.value);
              setError(null);
            }}
          />
          <input
            ref={localFileInputRef}
            className="visually-hidden"
            type="file"
            accept="audio/*,.aac,.aiff,.flac,.m4a,.mp3,.oga,.ogg,.opus,.wav,.weba,.webm"
            multiple
            onChange={(event) => void loadLocalAudio(event)}
          />
          <AppTooltip content="Open local audio"><button className="music-local-button" type="button" aria-label="Open local audio" disabled={busy} onClick={() => localFileInputRef.current?.click()}>
            <FolderOpen size={14} aria-hidden="true" />
          </button></AppTooltip>
          <AppTooltip content="Load link"><button type="submit" aria-label="Load music link" disabled={busy || !source.trim()}>
            {busy && !queue ? <LoaderCircle className="tool-spinner" size={14} /> : <ArrowRight size={14} />}
          </button></AppTooltip>
        </form>

        <div className="music-track-copy">
          <span>{collectionLabel}</span>
          <AppTooltip content={stream?.title ?? activeTrack?.title ?? undefined}><strong>{stream?.title ?? activeTrack?.title ?? 'Nothing queued'}</strong></AppTooltip>
        </div>

        <input
          className="music-progress"
          type="range"
          aria-label="Playback position"
          min={0}
          max={Math.max(resolvedDuration, 1)}
          step={0.1}
          value={Math.min(currentTime, Math.max(resolvedDuration, 1))}
          style={{ '--music-progress': `${resolvedDuration > 0 ? Math.min(100, currentTime / resolvedDuration * 100) : 0}%` } as CSSProperties}
          disabled={!stream || resolvedDuration <= 0}
          onChange={(event) => {
            const nextTime = Number(event.target.value);
            if (audioRef.current) audioRef.current.currentTime = nextTime;
            setCurrentTime(nextTime);
          }}
        />
        <div className="music-time-row" aria-hidden="true">
          <span>{formatTime(currentTime)}</span><span>{queuePosition}</span><span>{formatTime(resolvedDuration)}</span>
        </div>

        <div className="music-controls">
          <AppTooltip content={playlistOpen ? 'Hide playlist' : 'Show playlist'}>
            <button
              className="music-playlist-button"
              type="button"
              aria-label={playlistOpen ? 'Hide playlist' : 'Show playlist'}
              aria-controls="music-playlist"
              aria-expanded={playlistOpen}
              onClick={() => setPlaylistOpen((value) => !value)}
            >
              <ListMusic size={16} />
            </button>
          </AppTooltip>

          <div className="music-transport">
            <AppTooltip content="Previous"><button type="button" aria-label="Previous track" disabled={!queue || trackIndex === 0 || busy} onClick={() => move(-1)}><SkipBack size={16} /></button></AppTooltip>
            <AppTooltip content={playing ? 'Pause' : 'Play'}><button className="music-play" type="button" aria-label={playing ? 'Pause music' : 'Play music'} disabled={!stream || busy} onClick={() => void togglePlayback()}>
              {busy ? <LoaderCircle className="tool-spinner" size={16} /> : playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
            </button></AppTooltip>
            <AppTooltip content="Next"><button type="button" aria-label="Next track" disabled={!queue || trackIndex >= queue.tracks.length - 1 || busy} onClick={() => move(1)}><SkipForward size={16} /></button></AppTooltip>
          </div>

          <div className="music-volume-control">
            <input
              className="music-volume"
              type="range"
              aria-label="Volume"
              aria-valuetext={muted ? 'Muted' : `${volumePercent}%`}
              min={0}
              max={100}
              step={1}
              value={volumePercent}
              style={{ '--music-volume': `${volumePercent}%` } as CSSProperties}
              onChange={(event) => changeVolume(Number(event.target.value) / 100)}
            />
            <AppTooltip content={silent ? 'Unmute' : `Mute · ${volumePercent}%`}><button
              type="button"
              aria-label={silent ? 'Unmute music' : 'Mute music'}
              onClick={toggleMute}
            >
              <VolumeIcon size={16} />
            </button></AppTooltip>
          </div>
        </div>

        <p className="visually-hidden" role={error ? 'alert' : 'status'}>{error ?? notice}</p>
      </section>

      <AppTooltip content={open ? 'Close music player' : 'Open music player'}>
        <button
          className="music-dock-toggle"
          type="button"
          aria-label={open ? 'Close music player' : 'Open music player'}
          aria-expanded={open}
          onClick={toggleDock}
        >
          <ChevronUp size={18} />
        </button>
      </AppTooltip>

      <audio
        ref={audioRef}
        preload="none"
        onCanPlay={() => {
          if (!playWhenReady.current || !audioRef.current) return;
          playWhenReady.current = false;
          void audioRef.current.play().then(() => setPlaying(true)).catch(() => setError('Press play to start this track.'));
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onDurationChange={(event) => {
          if (!Number.isFinite(event.currentTarget.duration)) return;
          const nextDuration = event.currentTarget.duration;
          setDuration(nextDuration);
          setQueue((current) => {
            if (!current || !stream) return current;
            const next = { ...current, tracks: current.tracks.map((track) => track.id === stream.trackId ? { ...track, duration: nextDuration } : track) };
            queueRef.current = next;
            return next;
          });
        }}
        onEnded={() => {
          setPlaying(false);
          if (queueRef.current && trackIndex < queueRef.current.tracks.length - 1) move(1, true);
        }}
        onError={() => {
          if (!stream) return;
          playWhenReady.current = false;
          setPlaying(false);
          setError(stream.url.startsWith('blob:')
            ? 'This local audio file could not be decoded.'
            : 'This stream could not play. Update yt-dlp or try another track.');
        }}
      />
    </div>
  );
}
