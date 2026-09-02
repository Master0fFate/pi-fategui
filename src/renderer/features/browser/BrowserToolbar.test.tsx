import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserState, PiDesktopApi } from '../../../shared/contracts/ipc';
import { useBrowserStore } from '../../stores/browserStore';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { BrowserToolbar } from './BrowserToolbar';

const state = (grant = false, mode: BrowserState['mode'] = 'agent'): BrowserState => ({
  activeTabId: 'browser-main', visible: false, viewBlocked: false, sessionFullAccess: false, controlLevel: 'interact', mode,
  deviceEmulation: null,
  tabs: [{
    id: 'browser-main', profileId: 'project', url: 'https://example.test/page', title: 'Example', loading: false,
    canGoBack: true, canGoForward: false, documentEpoch: 1, semanticAvailable: true,
  }],
  grants: grant ? [{ origin: 'https://example.test', read: true, interact: true, scope: 'task', allowPrivateNetwork: false }] : [],
});

describe('BrowserToolbar', () => {
  beforeEach(() => {
    useRuntimeStore.setState((current) => ({
      runtime: { ...current.runtime, project: { path: 'C:/project', name: 'project', trusted: true } },
    }));
    useBrowserStore.getState().reset();
    useBrowserStore.getState().hydrate(state(), 'C:/project');
  });
  afterEach(() => Reflect.deleteProperty(window, 'piDesktop'));

  it('disables browser input until the project browser is initialized', async () => {
    useBrowserStore.getState().hydrate(state(), null);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: {} as PiDesktopApi });
    render(<BrowserToolbar />);

    expect(screen.getByRole('textbox', { name: 'Browser address' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open local HTML file' })).toBeDisabled();

    useBrowserStore.getState().hydrate(state(), 'C:/project');
    await vi.waitFor(() => expect(screen.getByRole('textbox', { name: 'Browser address' })).toBeEnabled());
  });

  it('keeps agent control always on and requests scoped access without a mode switch', async () => {
    const setBrowserOriginGrant = vi.fn(async () => state(true));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: {
      setBrowserOriginGrant,
    } as unknown as PiDesktopApi });

    render(<BrowserToolbar />);
    // The Agent button is gone: agent interaction is always on.
    expect(screen.queryByRole('button', { name: 'Agent' })).not.toBeInTheDocument();
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
  });

  it('toggles the annotate picker while agent control stays interactive', async () => {
    const setBrowserMode = vi.fn(async (mode: BrowserState['mode']) => state(true, mode));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { setBrowserMode } as unknown as PiDesktopApi });
    render(<BrowserToolbar />);

    const annotate = screen.getByRole('button', { name: 'Annotate' });
    expect(annotate).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(annotate);
    await vi.waitFor(() => expect(setBrowserMode).toHaveBeenCalledWith('annotate'));

    useBrowserStore.getState().hydrate(state(true, 'annotate'));
    await vi.waitFor(() => expect(annotate).toHaveAttribute('aria-pressed', 'true'));
    // Agent control level is untouched by annotating.
    expect(useBrowserStore.getState().state.controlLevel).toBe('interact');

    fireEvent.click(annotate);
    await vi.waitFor(() => expect(setBrowserMode).toHaveBeenCalledWith('agent'));
  });

  it('toggles the device toolbar independently of annotate', async () => {
    const setBrowserDeviceEmulation = vi.fn(async (emulation: BrowserState['deviceEmulation']) => ({
      ...state(true, 'annotate'),
      deviceEmulation: emulation,
    }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { setBrowserDeviceEmulation } as unknown as PiDesktopApi });
    render(<BrowserToolbar />);

    const device = screen.getByRole('button', { name: 'Toggle device toolbar' });
    expect(device).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(device);
    await vi.waitFor(() => expect(setBrowserDeviceEmulation).toHaveBeenCalledWith({ width: 390, height: 844, mobile: true, touch: true }));

    useBrowserStore.getState().hydrate({ ...state(true, 'annotate'), deviceEmulation: { width: 390, height: 844, mobile: true, touch: true } });
    await vi.waitFor(() => expect(device).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByRole('button', { name: 'Annotate' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(device);
    await vi.waitFor(() => expect(setBrowserDeviceEmulation).toHaveBeenCalledWith(null));
  });

  it('opens a local file through the main-process chooser', async () => {
    const openBrowserLocalFile = vi.fn(async () => ({ ...state(true), tabs: [{ ...state(true).tabs[0]!, url: 'file:///C:/demo/index.html' }] }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { openBrowserLocalFile } as unknown as PiDesktopApi });
    render(<BrowserToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Open local HTML file' }));
    await vi.waitFor(() => expect(openBrowserLocalFile).toHaveBeenCalledTimes(1));
  });
});
