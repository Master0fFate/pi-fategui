import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ConnectionProfileEditor } from './ConnectionProfileEditor';
import type { SaveSshProfile } from '../../../shared/contracts/connectionEditor';
const id = '10000000-0000-4000-8000-000000000001';
const selectionId = '10000000-0000-4000-8000-000000000002';
it('uses an opaque credential choice and explicit identity trust before saving', async () => {
  const pick = vi.fn(async () => ({ selectionId })), save = vi.fn(async (_input: SaveSshProfile) => ({ id, label: 'Host', hostId: id })), onSaved = vi.fn(async () => undefined);
  render(<ConnectionProfileEditor api={{ pickConnectionCredential: pick, saveSshConnectionProfile: save }} onSaved={onSaved} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add SSH host' }));
  expect(screen.getByRole('button', { name: 'Save host profile' })).toBeDisabled();
  for (const [name, value] of [['Host label', 'Host'], ['SSH config alias', 'fixture'], ['Verified server ID', id], ['Host workspace ID', id]] as const) fireEvent.change(screen.getByLabelText(name), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Choose private client credential' }));
  await waitFor(() => expect(screen.getByText('Private file selected')).toBeInTheDocument());
  expect(screen.queryByDisplayValue(selectionId)).toBeNull();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Save host profile' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledWith({ label: 'Host', hostId: id, sshAlias: 'fixture', remotePort: 47119,
    workspaceId: id, workspaceGeneration: 1, selectionId, trust: true });
});
it('resets trust when the pinned server identity changes', () => {
  render(<ConnectionProfileEditor api={{ pickConnectionCredential: async () => null, saveSshConnectionProfile: async () => ({ id, hostId: id, label: 'Host' }) }} onSaved={async () => undefined} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add SSH host' }));
  const trust = screen.getByRole('checkbox'); fireEvent.click(trust); expect(trust).toBeChecked();
  fireEvent.change(screen.getByLabelText('Verified server ID'), { target: { value: id } }); expect(trust).not.toBeChecked();
});
