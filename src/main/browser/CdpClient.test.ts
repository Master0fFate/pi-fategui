import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { CdpClient } from './CdpClient';

describe('CdpClient unbounded event waits', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const contentsWithListener = (capture: (listener: (event: unknown, method: string, params: unknown) => void) => void) => ({
    isDestroyed: () => false,
    debugger: {
      isAttached: () => true,
      attach: vi.fn(),
      detach: vi.fn(),
      on: vi.fn((_event: string, listener: (event: unknown, method: string, params: unknown) => void) => capture(listener)),
      off: vi.fn(),
      sendCommand: vi.fn(async (method: string) => method === 'Schema.getDomains'
        ? { domains: [{ name: 'Page' }, { name: 'DOM' }, { name: 'Accessibility' }, { name: 'DOMSnapshot' }, { name: 'Input' }] }
        : undefined),
    },
  } as unknown as WebContents);

  it('waits indefinitely for human-paced picker events when timeoutMs is Infinity', async () => {
    let message: ((event: unknown, method: string, params: unknown) => void) | undefined;
    const client = new CdpClient(contentsWithListener((listener) => { message = listener; }));
    await client.attach();
    const waiter = client.waitForEvent<{ backendNodeId?: number }>('Overlay.inspectNodeRequested', { timeoutMs: Number.POSITIVE_INFINITY });

    // Far beyond the previous 60s ceiling: still pending, no rejection.
    await vi.advanceTimersByTimeAsync(600_000);
    const settled = await Promise.race([waiter.then(() => true), Promise.resolve(false)]);
    expect(settled).toBe(false);

    message?.({}, 'Overlay.inspectNodeRequested', { backendNodeId: 42 });
    await expect(waiter).resolves.toEqual({ backendNodeId: 42 });
  });

  it('still honors the abort signal on an unbounded wait', async () => {
    const client = new CdpClient(contentsWithListener(() => undefined));
    const controller = new AbortController();
    const waiter = client.waitForEvent('Overlay.inspectNodeRequested', { signal: controller.signal, timeoutMs: Number.POSITIVE_INFINITY });

    await vi.advanceTimersByTimeAsync(600_000);
    controller.abort();
    await expect(waiter).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps the default bounded timeout for other waits', async () => {
    const client = new CdpClient(contentsWithListener(() => undefined));
    const waiter = client.waitForEvent('Overlay.inspectNodeRequested');
    // Attach the handler before advancing so the rejection is never unhandled.
    const expectation = expect(waiter).rejects.toThrow(/Timed out waiting for Overlay\.inspectNodeRequested/u);

    await vi.advanceTimersByTimeAsync(60_000);
    await expectation;
  });
});

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
