import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HistoryPage } from '../../../shared/protocol/snapshots';
import { NetworkHistory } from './NetworkHistory';

const sessionId = '20000000-0000-4000-8000-000000000002';
const workspace = { workspaceId: '30000000-0000-4000-8000-000000000003', workspaceGeneration: 1, label: 'Project' };
const cursor = '40000000-0000-4000-8000-000000000004';
function page(text: string, nextPageId: string | null = null): HistoryPage {
  return { version: 1, sessionId, nextPageId, mediaOmitted: true, oversizedItems: 0,
    items: [{ id: text, kind: 'message', role: 'user', text, timestamp: 1, clipped: false, mediaOmitted: true }] };
}
describe('bounded saved history reader', () => {
  it('reads on demand and replaces pages instead of accumulating transcript state', async () => {
    const api = { supports: () => true, readHistory: vi.fn().mockResolvedValueOnce(page('first saved row', cursor)).mockResolvedValueOnce(page('second saved row')) };
    render(<NetworkHistory api={api} workspace={workspace} sessionId={sessionId} />);
    expect(api.readHistory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Read from start' }));
    await screen.findByText('first saved row');
    expect(screen.getByRole('heading', { name: 'Saved history · Page 1' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Next history page' }));
    await screen.findByText('second saved row');
    expect(screen.queryByText('first saved row')).not.toBeInTheDocument();
    expect(api.readHistory).toHaveBeenNthCalledWith(2, workspace, cursor);
    expect(screen.getByText('End of saved history.')).toBeInTheDocument();
    expect(screen.getByText('Some media or large items are omitted.')).toBeInTheDocument();
  });
  it('does not replay a cursor on error and rejects responses for another session', async () => {
    const api = { supports: () => true, readHistory: vi.fn().mockResolvedValueOnce(page('first', cursor)).mockRejectedValueOnce(new Error('expired'))
      .mockResolvedValueOnce({ ...page('private other session'), sessionId: cursor }) };
    render(<NetworkHistory api={api} workspace={workspace} sessionId={sessionId} />);
    fireEvent.click(screen.getByRole('button', { name: 'Read from start' }));
    await screen.findByText('first');
    fireEvent.click(screen.getByRole('button', { name: 'Next history page' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Next history page' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Read from start' }));
    await waitFor(() => expect(api.readHistory).toHaveBeenCalledTimes(3));
    expect(api.readHistory).toHaveBeenLastCalledWith(workspace, undefined);
    expect(screen.queryByText('private other session')).not.toBeInTheDocument();
  });
  it('discards pending results after a scope unmount', async () => {
    let finish!: (page: HistoryPage) => void;
    const api = { supports: () => true, readHistory: vi.fn(() => new Promise<HistoryPage>((resolve) => { finish = resolve; })) };
    const view = render(<NetworkHistory api={api} workspace={workspace} sessionId={sessionId} />);
    fireEvent.click(screen.getByRole('button', { name: 'Read from start' }));
    view.unmount();
    await act(async () => { finish(page('stale')); });
    expect(screen.queryByText('stale')).not.toBeInTheDocument();
  });
  it('does not advertise saved history when the host lacks the capability', () => {
    const api = { supports: () => false, readHistory: vi.fn() };
    render(<NetworkHistory api={api} workspace={workspace} sessionId={sessionId} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(api.readHistory).not.toHaveBeenCalled();
  });
});
