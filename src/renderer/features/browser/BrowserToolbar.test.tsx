import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserState, PiDesktopApi } from '../../../shared/contracts/ipc';
import { useBrowserStore } from '../../stores/browserStore';
import { BrowserToolbar } from './BrowserToolbar';

const state = (grant = false, mode: BrowserState['mode'] = 'agent'): BrowserState => ({
  activeTabId: 'browser-main', visible: false, viewBlocked: false, sessionFullAccess: false, controlLevel: mode === 'annotate' ? 'observe' : 'interact', mode,
  tabs: [{
    id: 'browser-main', profileId: 'project', url: 'https://example.test/page', title: 'Example', loading: false,
    canGoBack: true, canGoForward: false, documentEpoch: 1, semanticAvailable: true,
  }],
  grants: grant ? [{ origin: 'https://example.test', read: true, interact: true, scope: 'task', allowPrivateNetwork: false }] : [],
});

describe('BrowserToolbar', () => {
  beforeEach(() => {
    useBrowserStore.getState().reset();
    useBrowserStore.getState().hydrate(state());
  });
  afterEach(() => Reflect.deleteProperty(window, 'piDesktop'));

  it('offers only Agent and Annotate modes and automatically requests scoped access', async () => {
    const setBrowserMode = vi.fn(async (mode: BrowserState['mode']) => state(false, mode));
    const setBrowserOriginGrant = vi.fn(async () => state(true));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: {
      setBrowserMode, setBrowserOriginGrant,
    } as unknown as PiDesktopApi });

    render(<BrowserToolbar />);
    expect(screen.queryByRole('button', { name: 'Browse' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Agent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Annotate' })).toBeInTheDocument();
    expect(await screen.findByText('Let Pi use this site?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Allow agent' }));
    await vi.waitFor(() => expect(setBrowserOriginGrant).toHaveBeenCalledWith({
      origin: 'https://example.test', read: true, interact: true, scope: 'task', allowPrivateNetwork: false,
    }));
  });

  it('does not ask for site access when the selected session already has Full access', () => {
    useBrowserStore.getState().hydrate({ ...state(), sessionFullAccess: true });
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: {} as PiDesktopApi });

    render(<BrowserToolbar />);

    expect(screen.queryByText('Let Pi use this site?')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Agent' })).not.toHaveAttribute('data-attention');
  });

  it('enters annotation mode directly from the toolbar', async () => {
    const setBrowserMode = vi.fn(async (mode: BrowserState['mode']) => state(true, mode));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { setBrowserMode } as unknown as PiDesktopApi });
    render(<BrowserToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Annotate' }));
    await vi.waitFor(() => expect(setBrowserMode).toHaveBeenCalledWith('annotate'));
  });

  it('opens a local file through the main-process chooser', async () => {
    const openBrowserLocalFile = vi.fn(async () => ({ ...state(true), tabs: [{ ...state(true).tabs[0]!, url: 'file:///C:/demo/index.html' }] }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { openBrowserLocalFile } as unknown as PiDesktopApi });
    render(<BrowserToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Open local HTML file' }));
    await vi.waitFor(() => expect(openBrowserLocalFile).toHaveBeenCalledTimes(1));
  });
});
