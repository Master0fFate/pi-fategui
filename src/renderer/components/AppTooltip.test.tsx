import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
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
