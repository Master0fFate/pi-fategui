export interface MicrophoneDevice {
  deviceId: string;
  label: string;
}

type MicrophoneMediaDevices = Pick<MediaDevices, 'enumerateDevices' | 'getUserMedia'>;

const systemDeviceIds = new Set(['default', 'communications']);

function normalizeMicrophones(devices: readonly MediaDeviceInfo[]): MicrophoneDevice[] {
  const microphones = new Map<string, MicrophoneDevice>();
  for (const device of devices) {
    const deviceId = device.deviceId.trim();
    if (device.kind !== 'audioinput' || !deviceId || systemDeviceIds.has(deviceId)) continue;
    microphones.set(deviceId, { deviceId, label: device.label.trim() });
  }
  return [...microphones.values()];
}

export async function enumerateMicrophones(mediaDevices: Pick<MediaDevices, 'enumerateDevices'>): Promise<MicrophoneDevice[]> {
  return normalizeMicrophones(await mediaDevices.enumerateDevices());
}

/**
 * Request access only when labels are still hidden, then release the temporary stream immediately.
 * Chromium exposes stable device names only after microphone permission has been granted.
 */
export async function requestMicrophoneDevices(mediaDevices: MicrophoneMediaDevices): Promise<MicrophoneDevice[]> {
  const visible = await enumerateMicrophones(mediaDevices).catch(() => []);
  if (visible.length > 0 && visible.every((device) => device.label.length > 0)) return visible;

  const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
  try {
    const microphones = await enumerateMicrophones(mediaDevices);
    const activeTrack = stream.getAudioTracks()[0];
    const activeDeviceId = activeTrack?.getSettings().deviceId?.trim();
    const activeLabel = activeTrack?.label.trim() ?? '';
    if (activeDeviceId && !systemDeviceIds.has(activeDeviceId) && activeLabel) {
      const active = microphones.find((device) => device.deviceId === activeDeviceId);
      if (active && !active.label) active.label = activeLabel;
      else if (!active) microphones.unshift({ deviceId: activeDeviceId, label: activeLabel });
    }
    return microphones;
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

export function microphoneAccessError(error: unknown): string {
  const name = error instanceof DOMException
    ? error.name
    : typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Microphone access is blocked. Enable Fate UI in your operating system’s microphone privacy settings, then restart Fate UI.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No microphone was detected. Connect one, then reopen Voice settings.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The microphone is busy or unavailable. Close other audio apps, then reopen Voice settings.';
    case 'SecurityError':
      return 'Microphone access is blocked by system security settings.';
    default:
      return error instanceof Error && error.message
        ? `Microphones could not be listed: ${error.message}`
        : 'Microphones could not be listed.';
  }
}
