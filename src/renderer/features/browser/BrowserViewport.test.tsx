import { render, waitFor } from '@testing-library/react';
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
  afterEach(() => Reflect.deleteProperty(window, 'piDesktop'));

  it('keeps workspace visibility requested while a confirmation blocker hides the native view', async () => {
    const setBrowserVisible = vi.fn(async () => blockedState);
    const setBrowserBounds = vi.fn(async () => blockedState);
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: { setBrowserVisible, setBrowserBounds } as unknown as PiDesktopApi,
    });

    render(<BrowserViewport visible />);

    await waitFor(() => expect(setBrowserVisible).toHaveBeenCalledWith(true));
    expect(setBrowserVisible).not.toHaveBeenCalledWith(false);
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
