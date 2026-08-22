import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserState, PiDesktopApi } from '../../../shared/contracts/ipc';
import { useBrowserStore } from '../../stores/browserStore';
import { BrowserDeviceToolbar } from './BrowserDeviceToolbar';

const emulationState = (width: number, height: number): BrowserState => ({
  activeTabId: 'browser-main',
  visible: false,
  viewBlocked: false,
  sessionFullAccess: false,
  controlLevel: 'interact',
  mode: 'agent',
  deviceEmulation: { width, height, mobile: true, touch: true },
  tabs: [],
  grants: [],
});

describe('BrowserDeviceToolbar', () => {
  afterEach(() => {
    useBrowserStore.getState().reset();
    Reflect.deleteProperty(window, 'piDesktop');
  });

  it('renders nothing while device emulation is off', () => {
    useBrowserStore.getState().hydrate(emulationState(390, 844));
    render(<BrowserDeviceToolbar state={{ ...emulationState(390, 844), deviceEmulation: null }} />);
    expect(screen.queryByRole('toolbar', { name: 'Device toolbar' })).not.toBeInTheDocument();
  });

  it('commits a picked device preset', async () => {
    const setBrowserDeviceEmulation = vi.fn(async () => emulationState(375, 667));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { setBrowserDeviceEmulation } as unknown as PiDesktopApi });
    useBrowserStore.getState().hydrate(emulationState(390, 844));
    render(<BrowserDeviceToolbar state={useBrowserStore.getState().state} />);

    fireEvent.change(screen.getByRole('combobox', { name: 'Device preset' }), { target: { value: 'iphone-se' } });
    await vi.waitFor(() => expect(setBrowserDeviceEmulation).toHaveBeenCalledWith({ width: 375, height: 667, mobile: true, touch: true }));
  });

  it('rotates the emulated viewport', async () => {
    const setBrowserDeviceEmulation = vi.fn(async () => emulationState(844, 390));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { setBrowserDeviceEmulation } as unknown as PiDesktopApi });
    useBrowserStore.getState().hydrate(emulationState(390, 844));
    render(<BrowserDeviceToolbar state={useBrowserStore.getState().state} />);

    fireEvent.click(screen.getByRole('button', { name: 'Rotate viewport' }));
    await vi.waitFor(() => expect(setBrowserDeviceEmulation).toHaveBeenCalledWith({ width: 844, height: 390, mobile: true, touch: true }));
  });

  it('commits typed dimensions on blur and clamps invalid input', async () => {
    const setBrowserDeviceEmulation = vi.fn(async () => emulationState(500, 844));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { setBrowserDeviceEmulation } as unknown as PiDesktopApi });
    useBrowserStore.getState().hydrate(emulationState(390, 844));
    render(<BrowserDeviceToolbar state={useBrowserStore.getState().state} />);

    const width = screen.getByLabelText('Width in pixels');
    fireEvent.change(width, { target: { value: '500' } });
    fireEvent.blur(width);
    await vi.waitFor(() => expect(setBrowserDeviceEmulation).toHaveBeenCalledWith({ width: 500, height: 844, mobile: true, touch: true }));

    fireEvent.change(width, { target: { value: '40' } });
    fireEvent.blur(width);
    await vi.waitFor(() => expect(setBrowserDeviceEmulation).toHaveBeenCalledWith(expect.objectContaining({ width: 220 })));
    expect(screen.getByLabelText('Width in pixels')).toHaveValue(220);
  });
});
