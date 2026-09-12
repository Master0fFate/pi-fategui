import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

function Launcher({ busy = false, error, confirm }: { busy?: boolean; error?: string; confirm: () => void }) {
  const [open, setOpen] = useState(false);
  return <div data-testid="narrow-toolbar" style={{ width: 24, overflow: 'auto' }}>
    <button type="button" onClick={() => setOpen(true)}>Remove</button>
    {open ? <ConfirmDialog title="Delete history?" message="Saved conversations will be removed." confirmLabel="Delete history" busy={busy} error={error ?? null} onCancel={() => setOpen(false)} onConfirm={confirm} /> : null}
  </div>;
}

describe('ConfirmDialog', () => {
  it('portals out of a narrow toolbar and restores focus after Escape', async () => {
    const user = userEvent.setup();
    const confirm = vi.fn();
    render(<Launcher confirm={confirm} />);
    const trigger = screen.getByRole('button', { name: 'Remove' });
    await user.click(trigger);

    expect(screen.getByRole('alertdialog', { name: 'Delete history?' })).toBeInTheDocument();
    expect(screen.getByTestId('narrow-toolbar').querySelector('[role="alertdialog"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('keeps the destructive action explicit and leaves error recovery available', async () => {
    const user = userEvent.setup();
    const confirm = vi.fn();
    render(<Launcher confirm={confirm} error="Review the retained worktree first." />);
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('status')).toHaveTextContent('Review the retained worktree first.');
    await user.click(screen.getByRole('button', { name: 'Delete history' }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('prevents dismissal or duplicate confirmation while busy', async () => {
    const user = userEvent.setup();
    const confirm = vi.fn();
    const view = render(<Launcher confirm={confirm} />);
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    view.rerender(<Launcher confirm={confirm} busy />);
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Delete history' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('returns focus to the stable region when deletion removes its trigger', async () => {
    const user = userEvent.setup();
    function Example() {
      const [present, setPresent] = useState(true);
      return <section tabIndex={-1} data-dialog-return-focus data-testid="stable-region">
        {present ? <Launcher confirm={() => setPresent(false)} /> : <span>No history</span>}
      </section>;
    }
    render(<Example />);
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Delete history' }));
    await waitFor(() => expect(screen.getByTestId('stable-region')).toHaveFocus());
  });
});
