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

  it('checks for updates through the pathless typed IPC channel', async () => {
    electron.invoke.mockResolvedValueOnce({
      status: 'available',
      message: 'Update available. Click to download.',
      installedVersion: '1.9.0',
      productionVersion: '1.10.0',
    });

    await expect(piDesktopApi.checkForUpdates()).resolves.toMatchObject({ status: 'available' });
    expect(electron.invoke).toHaveBeenCalledWith(ipcChannels.updatesCheck, {});
  });

  it('opens downloads only after validating main-process confirmation', async () => {
    electron.invoke.mockResolvedValueOnce({ opened: true });
    await expect(piDesktopApi.openUpdateDownload()).resolves.toBeUndefined();
    expect(electron.invoke).toHaveBeenCalledWith(ipcChannels.updatesOpenDownload, {});

    electron.invoke.mockResolvedValueOnce({ opened: false });
    await expect(piDesktopApi.openUpdateDownload()).rejects.toThrow();
  });
});
