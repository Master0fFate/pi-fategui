import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from '../stores/uiStore';
import { App } from './App';

describe('first-launch shell', () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({ sidebarCollapsed: false, inspectorCollapsed: false, leftWidth: 264, rightWidth: 332 });
  });

  it('renders honest first-launch navigation and inspector tabs', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'What would you like Pi to do?' })).toBeInTheDocument();
    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Changes/ })).toBeInTheDocument();
    expect(screen.getByText('Ready to connect')).toBeInTheDocument();
  });

  it('collapses and restores both side panes', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Collapse inspector' }));
    expect(screen.queryByRole('complementary', { name: 'Project inspector' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open inspector' })).toBeInTheDocument();
  });

  it('resizes panes with keyboard-accessible separators', async () => {
    const user = userEvent.setup();
    render(<App />);
    const sidebarHandle = screen.getByRole('separator', { name: 'Resize sidebar' });
    expect(sidebarHandle).toHaveAttribute('aria-valuenow', '264');
    sidebarHandle.focus();
    await user.keyboard('{ArrowRight}');
    expect(sidebarHandle).toHaveAttribute('aria-valuenow', '276');
  });

  it('does not rely on renderer Node globals', () => {
    render(<App />);
    expect('require' in window).toBe(false);
    expect('piDesktop' in window).toBe(false);
  });
});
