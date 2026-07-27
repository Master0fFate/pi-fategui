import { describe, expect, it, vi } from 'vitest';
import { enumerateMicrophones, microphoneAccessError, requestMicrophoneDevices } from './microphoneDevices';

function device(deviceId: string, label: string, kind: MediaDeviceKind = 'audioinput'): MediaDeviceInfo {
  return { deviceId, groupId: '', kind, label, toJSON: () => ({}) } as MediaDeviceInfo;
}

describe('microphone devices', () => {
  it('returns named physical inputs without reopening an already authorized microphone', async () => {
    const getUserMedia = vi.fn();
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => [
        device('default', 'Default - Studio Mic'),
        device('studio-mic', 'Studio Mic'),
        device('speakers', 'Speakers', 'audiooutput'),
      ]),
      getUserMedia,
    } as unknown as Pick<MediaDevices, 'enumerateDevices' | 'getUserMedia'>;

    await expect(requestMicrophoneDevices(mediaDevices)).resolves.toEqual([
      { deviceId: 'studio-mic', label: 'Studio Mic' },
    ]);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('requests permission for hidden labels and always releases the temporary stream', async () => {
    const stop = vi.fn();
    const enumerateDevices = vi.fn()
      .mockResolvedValueOnce([device('studio-mic', '')])
      .mockResolvedValueOnce([device('studio-mic', 'Studio Mic')]);
    const getUserMedia = vi.fn(async () => ({
      getAudioTracks: () => [{ label: 'Studio Mic', getSettings: () => ({ deviceId: 'studio-mic' }) }],
      getTracks: () => [{ stop }],
    }));
    const mediaDevices = { enumerateDevices, getUserMedia } as unknown as Pick<MediaDevices, 'enumerateDevices' | 'getUserMedia'>;

    await expect(requestMicrophoneDevices(mediaDevices)).resolves.toEqual([
      { deviceId: 'studio-mic', label: 'Studio Mic' },
    ]);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('filters system aliases and duplicate microphone IDs', async () => {
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => [
        device('default', 'Default'),
        device('communications', 'Communications'),
        device('usb-mic', 'USB microphone'),
        device('usb-mic', 'USB microphone'),
      ]),
    } as unknown as Pick<MediaDevices, 'enumerateDevices'>;

    await expect(enumerateMicrophones(mediaDevices)).resolves.toEqual([
      { deviceId: 'usb-mic', label: 'USB microphone' },
    ]);
  });

  it('provides actionable permission and hardware errors', () => {
    expect(microphoneAccessError(new DOMException('', 'NotAllowedError'))).toContain('privacy settings');
    expect(microphoneAccessError(new DOMException('', 'NotFoundError'))).toContain('No microphone');
    expect(microphoneAccessError(new DOMException('', 'NotReadableError'))).toContain('busy');
  });
});
