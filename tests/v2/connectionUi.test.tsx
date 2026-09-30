import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { FilesPanel } from '../../src/renderer/features/files/FilesPanel';
import { useRuntimeStore, type BoundedSnapshot, type WorkspaceViewApi } from '../../src/renderer/stores/runtimeStore';
import { useWorkspaceStore } from '../../src/renderer/stores/workspaceStore';

const { openFile, revealFile, host } = vi.hoisted(() => ({ openFile: vi.fn(), revealFile: vi.fn(), host: {
  isConnected: true, supports: () => true,
  listFiles: vi.fn(async () => ({ directoryId: null, truncated: false, entries: [{
    resourceId: '60000000-0000-4000-8000-000000000006', name: 'remote.txt', kind: 'file' as const }] })),
  previewText: vi.fn(async () => ({ fileId: '60000000-0000-4000-8000-000000000006',
    content: 'file:///C:/remote/private.txt\n<script>never execute this project text</script>', truncated: false })),
} }));
vi.mock('../../src/renderer/platform/api', () => ({
  getWebApiOptional: () => host, getDesktopApiOptional: () => ({ openFile, revealFile }),
  getDesktopApi: () => ({ openFile, revealFile }), getFateApiOptional: () => null,
  getFateApi: () => { throw new Error('Local core must not be called'); }, hasCapability: () => false,
}));
vi.mock('react-virtuoso', () => ({ Virtuoso: ({ data, itemContent }: {
  data: unknown[]; itemContent: (index: number, item: unknown) => ReactNode;
}) => <>{data.map((item, index) => <div key={index}>{itemContent(index, item)}</div>)}</> }));
const scope = { workspaceId: '30000000-0000-4000-8000-000000000003', workspaceGeneration: 2, label: 'Remote repository' };
afterEach(() => { useRuntimeStore.getState().reset(); useWorkspaceStore.getState().resetHostFiles(); vi.clearAllMocks(); });

describe('mounted host-file control routing', () => {
  it('opens a host resource as inert text, never as a local system file or script', async () => {
    const snapshot: BoundedSnapshot = { header: {
      version: 1, snapshotId: '40000000-0000-4000-8000-000000000004', ...scope,
      sessionId: '20000000-0000-4000-8000-000000000002', selectionRevision: 1,
      capturedAt: Date.now(), expiresAt: Date.now() + 60_000, serverEpoch: '10000000-0000-4000-8000-000000000001',
      eventCursor: 0, pageIds: ['50000000-0000-4000-8000-000000000005'], controls: {
        status: 'ready', streaming: false, activeSessionRunning: false, runningSessionCount: 0,
        permissionLevel: 'read-only', thinkingLevel: 'medium', model: null, pendingModel: null,
        pendingThinkingLevel: null, sessionOperation: false, queue: { steering: 0, followUp: 0, pending: 0, held: 0, recovered: 0 },
      }, goal: null, taskRevision: null, tasks: [], agents: [], omissions: {
        history: false, media: false, clippedItems: 0, agentRows: false, taskRows: false,
        goalText: false, taskText: false, agentText: false, queueContents: false,
      }, warnings: [],
    }, items: [] };
    const view: WorkspaceViewApi = { isConnected: true, reconnectError: null,
      listWorkspaces: async () => [scope], readSnapshot: async () => snapshot };
    await useRuntimeStore.getState().initialize(view);
    await useRuntimeStore.getState().refresh(view);
    render(<FilesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'remote.txt' }));
    await waitFor(() => expect(host.previewText).toHaveBeenCalledWith(scope, '60000000-0000-4000-8000-000000000006'));
    expect(await screen.findByText(/file:\/\/\/C:\/remote\/private.txt/)).toHaveTextContent('<script>never execute this project text</script>');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in the system editor' })).not.toBeInTheDocument();
    expect(document.querySelector('.file-preview script')).toBeNull();
    expect(openFile).not.toHaveBeenCalled(); expect(revealFile).not.toHaveBeenCalled();
  });
});
