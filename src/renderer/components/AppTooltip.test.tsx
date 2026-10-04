import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppTooltip } from './AppTooltip';

describe('AppTooltip', () => {
  it('opens from keyboard focus and preserves explicit line breaks and long text', async () => {
    const user = userEvent.setup();
    render(
      <AppTooltip content={'First line\nA-very-long-unbroken-value-that-must-wrap-safely'} delayDuration={0}>
        <button type="button">Inspect</button>
      </AppTooltip>,
    );

    await user.tab();
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('First line A-very-long-unbroken-value-that-must-wrap-safely');
    expect(tooltip.querySelector('.tooltip-content')).toHaveTextContent('First line A-very-long-unbroken-value-that-must-wrap-safely');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });

  it('opens from keyboard focus on a wrapped trigger, where the wrapper itself never has focus', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AppTooltip content="Settings" delayDuration={0} wrapTrigger>
        <button type="button">Wrapped</button>
      </AppTooltip>,
    );
    await user.tab();
    expect(screen.getByRole('button', { name: 'Wrapped' })).toHaveFocus();
    expect(container.querySelector('.tooltip-trigger')).not.toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Settings');
  });

  it('stays closed for a wrapped trigger whose button gets a non-keyboard programmatic focus', async () => {
    render(
      <AppTooltip content="Settings" delayDuration={0} wrapTrigger>
        <button type="button">Wrapped opener</button>
      </AppTooltip>,
    );
    const opener = screen.getByRole('button', { name: 'Wrapped opener' });
    const matches = vi.spyOn(opener, 'matches').mockImplementation((selector) => selector !== ':focus-visible');
    try {
      opener.focus();
      expect(opener).toHaveFocus();
      expect(matches).toHaveBeenCalledWith(':focus-visible');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    } finally { matches.mockRestore(); }
  });

  it('stays closed for a programmatic focus return that is not keyboard focus', async () => {
    render(
      <AppTooltip content="Settings" delayDuration={0}>
        <button type="button">Opener</button>
      </AppTooltip>,
    );
    const opener = screen.getByRole('button', { name: 'Opener' });
    // jsdom has no input modality. Report what a browser reports after a
    // pointer-closed dialog returns focus: focused, but not :focus-visible.
    const matches = vi.spyOn(opener, 'matches').mockImplementation((selector) => selector !== ':focus-visible');
    try {
      opener.focus();
      expect(opener).toHaveFocus();
      expect(matches).toHaveBeenCalledWith(':focus-visible');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      expect(opener).not.toHaveAttribute('aria-describedby');
    } finally { matches.mockRestore(); }
  });

  it('keeps a tooltip hoverable when its button is disabled', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AppTooltip content="Unavailable while a session operation is running" delayDuration={0} wrapTrigger>
        <button type="button" disabled>Isolated worktree</button>
      </AppTooltip>,
    );

    await user.hover(container.querySelector('.tooltip-trigger')!);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Unavailable while a session operation is running');
  });

  it('does not add tooltip plumbing when there is no content', () => {
    render(<AppTooltip content={undefined}><button type="button">No detail</button></AppTooltip>);
    expect(screen.getByRole('button', { name: 'No detail' })).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});
