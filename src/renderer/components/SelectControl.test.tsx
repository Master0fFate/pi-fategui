import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SelectControl } from './SelectControl';

const options = [
  { value: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5', detail: 'anthropic' },
  { value: 'openai/gpt-4o', label: 'GPT-4o', detail: 'openai' },
  { value: 'openai/o3', label: 'o3', detail: 'openai' },
] as const;

function renderSearchable(onValueChange: (value: string) => void = () => {}) {
  return render(
    <SelectControl
      label="Model"
      value="anthropic/claude-sonnet-4-5"
      options={options}
      searchable
      searchPlaceholder="Filter by name or provider"
      onValueChange={onValueChange}
    />,
  );
}

async function openSearchable(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('combobox', { name: 'Model' }));
  return {
    input: await screen.findByPlaceholderText('Filter by name or provider'),
    listbox: () => screen.getByRole('listbox'),
  };
}

describe('SelectControl searchable filter', () => {
  it('nests a filter input inside the open dropdown', async () => {
    const user = userEvent.setup();
    renderSearchable();
    expect(screen.queryByPlaceholderText('Filter by name or provider')).not.toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    expect(await screen.findByPlaceholderText('Filter by name or provider')).toBeInTheDocument();
    expect(screen.getByRole('search')).toBeInTheDocument();
  });

  it('filters options by name while typing', async () => {
    const user = userEvent.setup();
    renderSearchable();
    const { input, listbox } = await openSearchable(user);

    await user.type(input, 'gpt');
    const list = listbox();
    expect(within(list).getByText('GPT-4o')).toBeInTheDocument();
    expect(within(list).queryByText('o3')).not.toBeInTheDocument();
  });

  it('keeps the current selection pinned at the top while it does not match', async () => {
    const user = userEvent.setup();
    renderSearchable();
    const { input, listbox } = await openSearchable(user);

    await user.type(input, 'gpt');
    const list = listbox();
    const items = within(list).getAllByRole('option');
    expect(items[0]).toHaveTextContent('Claude Sonnet 4.5');
    expect(items[1]).toHaveTextContent('GPT-4o');
  });

  it('filters options by provider', async () => {
    const user = userEvent.setup();
    renderSearchable();
    const { input, listbox } = await openSearchable(user);

    await user.type(input, 'openai');
    const list = listbox();
    expect(within(list).getByText('GPT-4o')).toBeInTheDocument();
    expect(within(list).getByText('o3')).toBeInTheDocument();
    expect(within(list).getByText('Claude Sonnet 4.5')).toBeInTheDocument(); // pinned selection
  });

  it('shows an empty state when nothing matches', async () => {
    const user = userEvent.setup();
    renderSearchable();
    const { input, listbox } = await openSearchable(user);

    await user.type(input, 'zzz');
    expect(screen.getByRole('status')).toHaveTextContent('No options match “zzz”');
    const list = listbox();
    expect(within(list).getByText('Claude Sonnet 4.5')).toBeInTheDocument(); // pinned selection
    expect(within(list).queryByText('GPT-4o')).not.toBeInTheDocument();
  });

  it('clears the filter on Escape without closing the dropdown, then closes on a second Escape', async () => {
    const user = userEvent.setup();
    renderSearchable();
    const { input, listbox } = await openSearchable(user);
    await user.type(input, 'gpt');
    expect(within(listbox()).queryByText('o3')).not.toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(input).toHaveValue(''));
    expect(within(listbox()).getByText('o3')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  });

  it('clears the filter from the inline clear button', async () => {
    const user = userEvent.setup();
    renderSearchable();
    const { input, listbox } = await openSearchable(user);
    await user.type(input, 'o3');
    expect(within(listbox()).queryByText('GPT-4o')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear filter' }));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(within(listbox()).getByText('GPT-4o')).toBeInTheDocument();
  });

  it('selects the first match with Enter while the filter is active', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderSearchable(onValueChange);
    const { input } = await openSearchable(user);

    await user.type(input, 'gpt');
    await user.keyboard('{Enter}');
    expect(onValueChange).toHaveBeenCalledWith('openai/gpt-4o');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  });

  it('does not render a filter input for non-searchable selects', async () => {
    const user = userEvent.setup();
    render(
      <SelectControl label="Theme" value="dark" options={[{ value: 'dark', label: 'Dark' }]} onValueChange={() => {}} />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Theme' }));
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    expect(screen.queryByRole('search')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Filter by name or provider')).not.toBeInTheDocument();
  });

  it('opens on the requested side so the anchored edge never moves', async () => {
    const user = userEvent.setup();
    render(
      <SelectControl
        label="Model"
        value="openai/gpt-4o"
        options={options}
        side="top"
        searchable
        searchPlaceholder="Filter by name or provider"
        onValueChange={() => {}}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    expect(await screen.findByRole('listbox')).toHaveAttribute('data-side', 'top');
  });

  it('defaults to opening below the trigger', async () => {
    const user = userEvent.setup();
    renderSearchable();
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    expect(await screen.findByRole('listbox')).toHaveAttribute('data-side', 'bottom');
  });
});
