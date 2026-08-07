import type { MusicQueue, MusicTrack } from '../../../shared/contracts/ipc';

export const MAX_LOCAL_AUDIO_TRACKS = 200;
export const MAX_LOCAL_AUDIO_BYTES = 1024 * 1024 * 1024;
export const MAX_MUSIC_QUEUE_TRACKS = 500;

export interface MusicQueueAppend {
  queue: MusicQueue;
  added: MusicTrack[];
  skipped: number;
  firstAddedIndex: number;
}

export function appendMusicQueue(current: MusicQueue | null, incoming: MusicQueue): MusicQueueAppend {
  const currentTracks = current?.tracks ?? [];
  const remaining = Math.max(0, MAX_MUSIC_QUEUE_TRACKS - currentTracks.length);
  const added = incoming.tracks.slice(0, remaining);
  const tracks = [...currentTracks, ...added];
  return {
    queue: {
      title: current ? 'Play queue' : incoming.title,
      tracks,
    },
    added,
    skipped: incoming.tracks.length - added.length,
    firstAddedIndex: currentTracks.length,
  };
}

const audioExtensions = new Set([
  'aac', 'aiff', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'weba', 'webm',
]);

export function isSupportedLocalAudio(file: Pick<File, 'name' | 'type' | 'size'>): boolean {
  if (file.size <= 0 || file.size > MAX_LOCAL_AUDIO_BYTES) return false;
  if (file.type.toLocaleLowerCase().startsWith('audio/')) return true;
  const extension = file.name.split('.').at(-1)?.toLocaleLowerCase();
  return extension !== undefined && audioExtensions.has(extension);
}

export function localAudioTitle(name: string): string {
  const withoutExtension = name.replace(/\.[^.]+$/u, '');
  const clean = withoutExtension.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return [...(clean || 'Local track')].slice(0, 300).join('');
}

export function remoteMusicSourceError(rawSource: string): string | null {
  const source = rawSource.trim();
  if (!source) return 'Paste a public HTTPS media link or open audio from this device.';
  if (source.length > 2_048) return 'The media link is too long.';

  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    return looksLikeLocalPath(source)
      ? 'Use Open local audio for files on this device.'
      : 'Enter a complete public HTTPS media link.';
  }

  if (parsed.protocol === 'file:' || looksLikeLocalPath(source)) {
    return 'Use Open local audio for files on this device.';
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    return 'Only public HTTPS media links are supported.';
  }
  return null;
}

function looksLikeLocalPath(value: string): boolean {
  return /^[a-z]:[\\/]/iu.test(value) || value.startsWith('\\\\') || value.startsWith('/') || value.startsWith('~/');
}
