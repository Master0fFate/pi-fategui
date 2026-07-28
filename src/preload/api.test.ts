import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcChannels } from '../shared/contracts/ipc';

const electron = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcRenderer: electron,
}));

import { piDesktopApi } from './api';

describe('preload desktop bridge', () => {
  beforeEach(() => {
    electron.invoke.mockReset();
  });

  it('writes bounded plain text through the clipboard IPC channel', async () => {
    electron.invoke.mockResolvedValueOnce({ written: true });

    await piDesktopApi.writeClipboardText('Copied response');

    expect(electron.invoke).toHaveBeenCalledWith(ipcChannels.clipboardWriteText, { text: 'Copied response' });
  });

  it('rejects malformed clipboard responses instead of reporting false success', async () => {
    electron.invoke.mockResolvedValueOnce({ written: false });

    await expect(piDesktopApi.writeClipboardText('Copied response')).rejects.toThrow();
  });
});
