import { describe, expect, it } from 'vitest';
import { MAX_LOCAL_AUDIO_BYTES, MAX_MUSIC_QUEUE_TRACKS, appendMusicQueue, isSupportedLocalAudio, localAudioTitle, remoteMusicSourceError } from './musicSources';

describe('music source validation', () => {
  it('routes Windows, POSIX, UNC, and file URLs to the local audio picker', () => {
    expect(remoteMusicSourceError('C:\\Music\\focus.mp3')).toMatch(/Open local audio/);
    expect(remoteMusicSourceError('/home/user/Music/focus.mp3')).toMatch(/Open local audio/);
    expect(remoteMusicSourceError('\\\\server\\share\\focus.mp3')).toMatch(/Open local audio/);
    expect(remoteMusicSourceError('file:///Users/me/Music/focus.mp3')).toMatch(/Open local audio/);
  });

  it('accepts public HTTPS syntax and rejects malformed or credentialed input before IPC', () => {
    expect(remoteMusicSourceError('https://music.example/playlist?id=1')).toBeNull();
    expect(remoteMusicSourceError('')).toMatch(/public HTTPS/);
    expect(remoteMusicSourceError('not a link')).toMatch(/complete public HTTPS/);
    expect(remoteMusicSourceError('http://music.example/audio.mp3')).toMatch(/Only public HTTPS/);
    expect(remoteMusicSourceError('https://user:secret@music.example/audio.mp3')).toMatch(/Only public HTTPS/);
  });

  it('accepts typed audio and known extensions while bounding empty and enormous files', () => {
    expect(isSupportedLocalAudio({ name: 'focus.bin', type: 'audio/mpeg', size: 10 })).toBe(true);
    expect(isSupportedLocalAudio({ name: 'FOCUS.MP3', type: '', size: 10 })).toBe(true);
    expect(isSupportedLocalAudio({ name: 'notes.txt', type: 'text/plain', size: 10 })).toBe(false);
    expect(isSupportedLocalAudio({ name: 'empty.mp3', type: 'audio/mpeg', size: 0 })).toBe(false);
    expect(isSupportedLocalAudio({ name: 'huge.mp3', type: 'audio/mpeg', size: MAX_LOCAL_AUDIO_BYTES + 1 })).toBe(false);
  });

  it('appends queue entries without replacing earlier tracks and enforces the aggregate bound', () => {
    const first = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'First', duration: 10 };
    const second = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'Second', duration: 20 };
    const appended = appendMusicQueue({ title: 'First source', tracks: [first] }, { title: 'Second source', tracks: [second] });
    expect(appended.queue).toEqual({ title: 'Play queue', tracks: [first, second] });
    expect(appended.firstAddedIndex).toBe(1);
    expect(appended.skipped).toBe(0);

    const full = { title: 'Full', tracks: Array.from({ length: MAX_MUSIC_QUEUE_TRACKS }, (_value, index) => ({
      id: `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`, title: `Track ${index}`, duration: null,
    })) };
    expect(appendMusicQueue(full, { title: 'Extra', tracks: [second] })).toMatchObject({ added: [], skipped: 1 });
  });

  it('creates bounded Unicode-safe local titles', () => {
    expect(localAudioTitle('Čudesna pjesma.mp3')).toBe('Čudesna pjesma');
    expect(localAudioTitle('bad\nname.wav')).toBe('bad name');
    expect([...localAudioTitle(`${'音'.repeat(400)}.flac`)]).toHaveLength(300);
  });
});
