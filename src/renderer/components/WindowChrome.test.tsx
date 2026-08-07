import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PiDesktopApi, WindowControlAction, WindowState } from '../../shared/contracts/ipc';
import { WindowChrome } from './WindowChrome';

afterEach(() => {
  Reflect.deleteProperty(window, 'piDesktop');
});

describe('WindowChrome', () => {
  it('routes every title-bar action through the live desktop bridge', async () => {
    let state: WindowState = { maximized: false, minimized: false };
    const controlWindow = vi.fn(async (action: WindowControlAction) => {
      if (action === 'toggle-maximize') state = { maximized: !state.maximized, minimized: false };
      if (action === 'minimize') state = { ...state, minimized: true };
      return state;
    });
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getAppInfo: vi.fn(async () => ({ name: 'Fate UI', version: 'test', platform: 'win32', packaged: false })),
        getWindowState: vi.fn(async () => state),
        controlWindow,
        onWindowState: vi.fn(() => () => undefined),
      } as unknown as PiDesktopApi,
    });
    const user = userEvent.setup();
    render(<WindowChrome />);

    await waitFor(() => expect(screen.getByLabelText('Window controls')).toHaveAttribute('data-bridge-status', 'ready'));
    await user.click(screen.getByRole('button', { name: 'Maximize window' }));
    expect(screen.getByRole('button', { name: 'Restore window' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Minimize window' }));
    await user.click(screen.getByRole('button', { name: 'Close window' }));

    expect(controlWindow.mock.calls.map(([action]) => action)).toEqual(['toggle-maximize', 'minimize', 'close']);
  });

  it('makes a stale or missing preload visible instead of failing silently', async () => {
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: {} as PiDesktopApi });
    render(<WindowChrome />);
    expect(await screen.findByRole('status')).toHaveTextContent('Window controls disconnected');
    expect(screen.getByLabelText('Window controls')).toHaveAttribute('data-bridge-status', 'error');
  });
});
