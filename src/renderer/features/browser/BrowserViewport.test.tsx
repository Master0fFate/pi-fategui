import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserState, PiDesktopApi } from '../../../shared/contracts/ipc';
import { useBrowserStore } from '../../stores/browserStore';
import { BrowserViewport } from './BrowserViewport';

const blockedState: BrowserState = {
  activeTabId: 'browser-main',
  visible: false,
  viewBlocked: true,
  sessionFullAccess: false,
  controlLevel: 'interact',
  mode: 'agent',
  deviceEmulation: null,
  tabs: [{
    id: 'browser-main', profileId: 'project', url: 'https://example.test/', title: 'Example', loading: false,
    canGoBack: false, canGoForward: false, documentEpoch: 1, semanticAvailable: true,
  }],
  grants: [],
};

describe('BrowserViewport', () => {
  beforeEach(() => {
    useBrowserStore.getState().reset();
    useBrowserStore.getState().hydrate(blockedState);
  });
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'piDesktop');
    vi.restoreAllMocks();
  });

  it('keeps workspace visibility requested while a confirmation blocker hides the native view', async () => {
    const setBrowserVisible = vi.fn(async () => blockedState);
    const setBrowserBounds = vi.fn(async () => blockedState);
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: { setBrowserVisible, setBrowserBounds } as unknown as PiDesktopApi,
    });

    render(<BrowserViewport visible />);

    await waitFor(() => expect(setBrowserVisible).toHaveBeenCalledWith(true));
    act(() => useBrowserStore.getState().hydrate({ ...blockedState, visible: true, viewBlocked: false }));
    expect(setBrowserVisible).toHaveBeenCalledTimes(1);
    expect(setBrowserVisible).not.toHaveBeenCalledWith(false);
  });

  it('only observes a visible workspace and cancels its queued bounds when hidden', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
    const setBrowserVisible = vi.fn(async () => blockedState);
    const setBrowserBounds = vi.fn(async () => blockedState);
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: { setBrowserVisible, setBrowserBounds } as unknown as PiDesktopApi,
    });
    const view = render(<BrowserViewport visible={false} />);
    await waitFor(() => expect(setBrowserVisible).toHaveBeenCalledWith(false));
    expect(frames.size).toBe(0);
    view.rerender(<BrowserViewport visible />);
    await waitFor(() => expect(setBrowserVisible).toHaveBeenCalledWith(true));
    expect(frames.size).toBe(1);
    view.rerender(<BrowserViewport visible={false} />);
    expect(cancel).toHaveBeenCalledWith(1);
    expect(frames.size).toBe(0);
    window.dispatchEvent(new Event('resize'));
    expect(frames.size).toBe(0);
    expect(setBrowserBounds).not.toHaveBeenCalled();

    view.rerender(<BrowserViewport visible />);
    await act(async () => {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(0);
    });
    expect(setBrowserBounds).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    view.unmount();
    expect(setBrowserVisible).toHaveBeenLastCalledWith(false);
  });

  it('does not poll native bounds while the active tab is blank', async () => {
    const blankState: BrowserState = {
      ...blockedState,
      viewBlocked: false,
      tabs: [{ ...blockedState.tabs[0]!, url: 'about:blank', title: '' }],
    };
    useBrowserStore.getState().hydrate(blankState);
    const setBrowserVisible = vi.fn(async () => blankState);
    const setBrowserBounds = vi.fn(async () => blankState);
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: { setBrowserVisible, setBrowserBounds } as unknown as PiDesktopApi,
    });

    render(<BrowserViewport visible />);

    await waitFor(() => expect(setBrowserVisible).toHaveBeenCalledWith(false));
    expect(setBrowserBounds).not.toHaveBeenCalled();
  });
});
