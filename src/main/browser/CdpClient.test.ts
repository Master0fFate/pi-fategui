import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { CdpClient } from './CdpClient';

describe('CdpClient disposal hardening', () => {
  it('disposes without touching a destroyed webContents', async () => {
    const debuggerGetter = vi.fn(() => {
      throw new Error('Object has been destroyed.');
    });
    const contents = {
      isDestroyed: () => true,
      get debugger() { debuggerGetter(); return undefined; },
    } as unknown as WebContents;
    const client = new CdpClient(contents);

    await expect(client.dispose()).resolves.toBeUndefined();
    expect(debuggerGetter).not.toHaveBeenCalled();
  });

  it('treats a detach failure on a dead renderer as success', async () => {
    const contents = {
      isDestroyed: () => false,
      debugger: {
        isAttached: () => true,
        detach: vi.fn(() => {
          throw new Error('The renderer process is gone.');
        }),
        off: vi.fn(),
        on: vi.fn(),
      },
    } as unknown as WebContents;
    const client = new CdpClient(contents);

    await expect(client.dispose()).resolves.toBeUndefined();
    expect(contents.debugger.detach).toHaveBeenCalledOnce();
  });

  it('is idempotent and safe to call concurrently', async () => {
    let attached = true;
    const detach = vi.fn(() => { attached = false; });
    const contents = {
      isDestroyed: () => false,
      debugger: { isAttached: () => attached, detach, off: vi.fn(), on: vi.fn() },
    } as unknown as WebContents;
    const client = new CdpClient(contents);

    await Promise.all([client.dispose(), client.dispose()]);
    expect(detach).toHaveBeenCalledOnce();

    await client.dispose();
    expect(detach).toHaveBeenCalledOnce();
  });
});
