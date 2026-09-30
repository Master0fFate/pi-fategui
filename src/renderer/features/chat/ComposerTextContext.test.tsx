import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingPromptReviewLookup, WebSnapshot, WebWorkspace } from '../../../client/WebFateApi';
import { UnconfirmedCommand } from '../../../client/HttpCommandTransport';
import type { CommandStatus } from '../../../shared/protocol/commandOutcomes';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { Composer, isComposerProjectReference, readComposerTextFile } from './Composer';

const fake = vi.hoisted(() => ({
  network: true,
  origin: 'http://127.0.0.1:49301', authenticatedSessionId: '80000000-0000-4000-8000-000000000008',
  serverEpoch: '10000000-0000-4000-8000-000000000001', isConnected: true, control: 7, estimatedHostTime: 0,
  supports: vi.fn(() => true), pendingPromptReview: vi.fn((): PendingPromptReviewLookup => ({ kind: 'none' })),
  assertPendingReviewStorageAvailable: vi.fn(), rememberPendingPromptReview: vi.fn(), clearPendingPromptReview: vi.fn(),
  uploadText: vi.fn(), cancelTextAttachment: vi.fn(), sendPrompt: vi.fn(), reviewPromptStatus: vi.fn(),
  claimControl: vi.fn(), releaseControl: vi.fn(),
}));
vi.mock('../../platform/api', () => ({
  getWebApiOptional: () => fake.network ? fake : undefined, getFateApiOptional: () => undefined, getFateApi: vi.fn(),
  getDesktopApiOptional: () => undefined, getDesktopApi: vi.fn(), hasCapability: () => false,
}));

const workspace: WebWorkspace = { workspaceId: '20000000-0000-4000-8000-000000000002', workspaceGeneration: 1, label: 'Alpha' };
const sessionId = '40000000-0000-4000-8000-000000000004';
const originalId = '10000000-0000-4000-8000-000000000001.1000.90000000-0000-4000-8000-000000000009';
const attachmentId = `ta1_${'a'.repeat(43)}`;
const snapshot = (session = sessionId): WebSnapshot => ({
  header: {
    version: 1, snapshotId: '50000000-0000-4000-8000-000000000005', capturedAt: Date.now(), expiresAt: Date.now() + 60_000,
    workspaceId: workspace.workspaceId, workspaceGeneration: 1, serverEpoch: fake.serverEpoch, sessionId: session,
    eventCursor: 0, selectionRevision: 4, pageIds: ['60000000-0000-4000-8000-000000000006'],
    controls: { status: 'ready', streaming: false, activeSessionRunning: false, runningSessionCount: 0,
      permissionLevel: 'edit', thinkingLevel: 'off', model: null, pendingModel: null, pendingThinkingLevel: null,
      sessionOperation: false, queue: { steering: 0, followUp: 0, pending: 0, held: 0, recovered: 0 } },
    goal: null, taskRevision: null, tasks: [], agents: [],
    omissions: { history: false, media: true, clippedItems: 0, agentRows: false, taskRows: false,
      goalText: false, taskText: false, agentText: false, queueContents: true }, warnings: [],
  }, items: [],
});
function file(name: string, bytes: Uint8Array, type = 'text/plain'): File {
  const value = new File([Uint8Array.from(bytes).buffer], name, { type });
  Object.defineProperty(value, 'arrayBuffer', { value: async () => Uint8Array.from(bytes).buffer });
  return value;
}
const textFile = (name = 'notes.txt', text = 'context') => file(name, new TextEncoder().encode(text));
const enterPrompt = () => fireEvent.change(screen.getByRole('textbox', { name: 'Message to selected host session' }), { target: { value: 'Review context' } });
const upload = (value: File) => fireEvent.change(screen.getByLabelText('Attach plain text file'), { target: { files: [value] } });

beforeEach(() => {
  vi.clearAllMocks();
  fake.network = true;
  fake.origin = 'http://127.0.0.1:49301';
  fake.authenticatedSessionId = crypto.randomUUID(); // isolate in-memory drafts, not fabricated RuntimeState
  fake.serverEpoch = '10000000-0000-4000-8000-000000000001'; fake.isConnected = true; fake.control = 7;
  fake.estimatedHostTime = Date.now();
  fake.pendingPromptReview.mockReturnValue({ kind: 'none' });
  fake.uploadText.mockResolvedValue({ attachmentId, byteLength: 7, expiresAt: Date.now() + 300_000 });
  fake.cancelTextAttachment.mockResolvedValue(undefined);
  fake.sendPrompt.mockResolvedValue({ outcome: 'accepted', requestId: originalId });
  useRuntimeStore.setState({ source: 'network', selected: workspace, snapshot: snapshot(), phase: 'observing', refresh: vi.fn(async () => undefined) });
});
afterEach(() => useRuntimeStore.getState().reset());

describe('bounded shared Composer text context (no tests executed by worker)', () => {
  it('mounts the actual common input/action in both desktop and network Composer controllers', () => {
    fake.network = false;
    useRuntimeStore.getState().reset(); // existing disconnected desktop state, not fabricated RuntimeState
    const view = render(<Composer onOpenProject={vi.fn()} />);
    const desktop = screen.getByRole('textbox', { name: 'Message Pi' });
    expect(desktop).toHaveAttribute('data-composer-entry', 'desktop');
    expect(desktop.closest('form')).toHaveAttribute('data-composer-source', 'desktop');
    expect(screen.getByRole('button', { name: 'Send message' })).toHaveAttribute('data-composer-action', 'desktop');
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    view.unmount();
    fake.network = true;
    useRuntimeStore.setState({ source: 'network', selected: workspace, snapshot: snapshot(), phase: 'observing' });
    render(<Composer onOpenProject={vi.fn()} connectionControlsMounted />);
    const network = screen.getByRole('textbox', { name: 'Message to selected host session' });
    expect(network).toHaveAttribute('data-composer-entry', 'network');
    expect(network.closest('form')).toHaveAttribute('data-composer-source', 'network');
    expect(screen.getByRole('button', { name: 'Send prompt' })).toHaveAttribute('data-composer-action', 'network');
    expect(screen.queryByRole('button', { name: 'Start voice recording' })).not.toBeInTheDocument();
    expect(screen.getByText(/native tools are unavailable/)).toBeInTheDocument();
  });

  it('strictly decodes UTF-8 and refuses media, HTML, archives, invalid bytes and over-limit files', async () => {
    expect(await readComposerTextFile(textFile('notes.md', 'é'))).toEqual({ name: 'notes.md', text: 'é' });
    for (const value of [file('notes.txt', new Uint8Array([0xff])), textFile('notes.txt', '\0'),
      textFile('page.html'), textFile('image.svg'), textFile('archive.zip'), textFile('/etc/passwd.txt'),
      file('notes.txt', new Uint8Array([1]), 'image/png'), textFile('notes.txt', 'x'.repeat(256 * 1024 + 1))]) {
      await expect(readComposerTextFile(value)).rejects.toThrow();
    }
    expect((await readComposerTextFile(textFile('limit.txt', 'é'.repeat(128 * 1024)))).text.length).toBe(128 * 1024);
  });

  it('rejects local absolute paths, traversal, UNC, drive paths and URLs as project references', () => {
    for (const value of ['/etc/passwd', 'C:/secret.txt', '\\\\host\\share', '../secret', 'src/../secret',
      'https://example.test/file', 'src//file', 'src/./file', 'src/file\0']) expect(isComposerProjectReference(value)).toBe(false);
    expect(isComposerProjectReference('src/example.ts')).toBe(true);
  });

  it('uploads only a basename and decoded text, then sends opaque IDs and registered relative references', async () => {
    render(<Composer onOpenProject={vi.fn()} />);
    const value = textFile(); Object.defineProperty(value, 'path', { value: 'C:\\private\\notes.txt' });
    upload(value);
    await waitFor(() => expect(fake.uploadText).toHaveBeenCalledWith(workspace, { name: 'notes.txt', text: 'context' }));
    await screen.findByRole('button', { name: 'Remove notes.txt' });
    fireEvent.change(screen.getByLabelText('Registered project file'), { target: { value: 'src/example.ts' } });
    fireEvent.click(screen.getByRole('button', { name: 'Attach project file' }));
    enterPrompt(); fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }));
    await waitFor(() => expect(fake.sendPrompt).toHaveBeenCalledWith(workspace, 'Review context', {
      attachments: [attachmentId], projectFiles: ['src/example.ts'],
    }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove notes.txt' })).not.toBeInTheDocument());
  });

  it('clears the unchanged submitted revision on an ordinary successful admission, including untrimmed editor text', async () => {
    render(<Composer onOpenProject={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message to selected host session' }), { target: { value: '  Original prompt  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }));
    await screen.findByText(/Prompt admitted for this session/);
    expect(fake.sendPrompt).toHaveBeenCalledWith(workspace, 'Original prompt');
    expect(fake.sendPrompt).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue('');
  });

  it.each(['new-content', 'same-content-new-revision'] as const)('preserves a newer scoped UNSENT draft when an old successful send settles (%s)', async (edit) => {
    let resolveSend!: (receipt: { outcome: 'accepted'; requestId: string }) => void;
    fake.sendPrompt.mockImplementationOnce(() => new Promise((resolve) => { resolveSend = resolve; }));
    render(<Composer onOpenProject={vi.fn()} />);
    upload(textFile()); await screen.findByRole('button', { name: 'Remove notes.txt' });
    fireEvent.change(screen.getByLabelText('Registered project file'), { target: { value: 'src/original.ts' } });
    fireEvent.click(screen.getByRole('button', { name: 'Attach project file' }));
    enterPrompt(); fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }));
    await waitFor(() => expect(fake.sendPrompt).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toBeDisabled();
    // A newly mounted editor can outlive the old busy callback. Ownership must
    // reside in the scoped cache, not in that callback's React state/closure.
    act(() => useRuntimeStore.setState({ snapshot: snapshot('70000000-0000-4000-8000-000000000007') }));
    act(() => useRuntimeStore.setState({ snapshot: snapshot() }));
    const newer = 'Unsent draft must not become an automatic reconnect prompt.';
    const editor = screen.getByRole('textbox', { name: 'Message to selected host session' });
    expect(editor).toBeEnabled();
    fireEvent.change(editor, { target: { value: newer } });
    if (edit === 'same-content-new-revision') fireEvent.change(editor, { target: { value: 'Review context' } });
    const newAttachmentId = `ta1_${'b'.repeat(43)}`;
    fake.uploadText.mockResolvedValueOnce({ attachmentId: newAttachmentId, byteLength: 3, expiresAt: Date.now() + 300_000 });
    upload(textFile('newer.txt', 'new')); await screen.findByRole('button', { name: 'Remove newer.txt' });
    fireEvent.change(screen.getByLabelText('Registered project file'), { target: { value: 'src/newer.ts' } });
    fireEvent.click(screen.getByRole('button', { name: 'Attach project file' }));
    await act(async () => resolveSend({ outcome: 'accepted', requestId: originalId }));
    const expected = edit === 'same-content-new-revision' ? 'Review context' : newer;
    expect(editor).toHaveValue(expected);
    expect(screen.queryByRole('button', { name: 'Remove notes.txt' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove src/original.ts' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove newer.txt' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove src/newer.ts' })).toBeInTheDocument();
    act(() => { fake.isConnected = false; useRuntimeStore.setState({ phase: 'disconnected' }); });
    expect(editor).toBeDisabled(); expect(editor).toHaveValue(expected);
    act(() => { fake.isConnected = true; useRuntimeStore.setState({ phase: 'observing', snapshot: snapshot() }); });
    expect(editor).toHaveValue(expected);
    expect(fake.sendPrompt).toHaveBeenCalledTimes(1); // No replay/new ID or admission of the newer draft.
  });

  it('never clears or retargets another selected scope when an old accepted send finishes', async () => {
    let resolveSend!: (receipt: { outcome: 'accepted'; requestId: string }) => void;
    fake.sendPrompt.mockImplementationOnce(() => new Promise((resolve) => { resolveSend = resolve; }));
    render(<Composer onOpenProject={vi.fn()} />); enterPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }));
    await waitFor(() => expect(fake.sendPrompt).toHaveBeenCalledTimes(1));
    act(() => useRuntimeStore.setState({ snapshot: snapshot('70000000-0000-4000-8000-000000000007') }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Message to selected host session' }), { target: { value: 'Other session UNSENT' } });
    await act(async () => resolveSend({ outcome: 'accepted', requestId: originalId }));
    expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue('Other session UNSENT');
    act(() => useRuntimeStore.setState({ snapshot: snapshot() }));
    expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue('');
    expect(fake.sendPrompt).toHaveBeenCalledWith(workspace, 'Review context');
    expect(fake.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('preserves a newer draft while the previous successful send refresh finishes and the event connection is lost', async () => {
    let resolveRefresh!: () => void;
    const refresh = vi.fn(() => new Promise<void>((resolve) => { resolveRefresh = resolve; }));
    useRuntimeStore.setState({ refresh });
    render(<Composer onOpenProject={vi.fn()} />); enterPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue('');
    act(() => useRuntimeStore.setState({ snapshot: snapshot('70000000-0000-4000-8000-000000000007') }));
    act(() => useRuntimeStore.setState({ snapshot: snapshot() }));
    const text = 'Unsent draft must not become an automatic reconnect prompt.';
    fireEvent.change(screen.getByRole('textbox', { name: 'Message to selected host session' }), { target: { value: text } });
    act(() => { fake.isConnected = false; useRuntimeStore.setState({ phase: 'disconnected' }); });
    await act(async () => resolveRefresh());
    expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue(text);
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled();
    expect(fake.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('retains an unsent scoped draft across metadata refresh and outage without any Composer send', () => {
    render(<Composer onOpenProject={vi.fn()} />);
    const text = 'Unsent draft must not become an automatic reconnect prompt.';
    fireEvent.change(screen.getByRole('textbox', { name: 'Message to selected host session' }), { target: { value: text } });
    act(() => {
      const next = snapshot();
      useRuntimeStore.setState({ snapshot: { ...next, header: { ...next.header, snapshotId: crypto.randomUUID() } }, phase: 'synchronizing' });
    });
    act(() => { fake.isConnected = false; useRuntimeStore.setState({ phase: 'disconnected' }); });
    expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue(text);
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled();
    act(() => { fake.isConnected = true; useRuntimeStore.setState({ phase: 'observing', snapshot: snapshot() }); });
    expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue(text);
    expect(fake.sendPrompt).not.toHaveBeenCalled();
  });

  it('keeps newer text on a late unknown send and later settles only the original submitted context on accepted review', async () => {
    let rejectSend!: (error: UnconfirmedCommand) => void;
    fake.sendPrompt.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSend = reject; }));
    render(<Composer onOpenProject={vi.fn()} />);
    upload(textFile()); await screen.findByRole('button', { name: 'Remove notes.txt' }); enterPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }));
    await waitFor(() => expect(fake.sendPrompt).toHaveBeenCalledTimes(1));
    act(() => useRuntimeStore.setState({ snapshot: snapshot('70000000-0000-4000-8000-000000000007') }));
    act(() => useRuntimeStore.setState({ snapshot: snapshot() }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Message to selected host session' }), { target: { value: 'Newer UNSENT revision' } });
    await act(async () => rejectSend(new UnconfirmedCommand(originalId)));
    expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue('Newer UNSENT revision');
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled();
    expect(screen.getByText(/Original request:/)).toHaveTextContent(originalId);
    fake.reviewPromptStatus.mockResolvedValueOnce({ state: 'settled', receipt: { kind: 'prompt', outcome: 'accepted',
      sessionId, requestId: originalId, runId: 'a0000000-0000-4000-8000-00000000000a', durability: 'journaled', viewRevision: 5 }, rejectionCode: null });
    fireEvent.click(screen.getByRole('button', { name: 'Review original request' }));
    await screen.findByText(/was admitted/);
    expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue('Newer UNSENT revision');
    expect(screen.queryByRole('button', { name: 'Remove notes.txt' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review original request' })).not.toBeInTheDocument();
    expect(fake.reviewPromptStatus).toHaveBeenCalledWith(workspace, originalId);
    expect(fake.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('refuses unsupported and expired uploads before sending context to the host', async () => {
    fake.uploadText.mockResolvedValueOnce({ attachmentId, byteLength: 7, expiresAt: fake.estimatedHostTime - 1 });
    render(<Composer onOpenProject={vi.fn()} />);
    upload(textFile('archive.zip'));
    await screen.findByText(/Only supported plain text files/);
    expect(fake.uploadText).not.toHaveBeenCalled();
    upload(textFile()); await screen.findByRole('button', { name: 'Remove notes.txt' });
    enterPrompt(); fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }));
    await screen.findByText(/Attached text expired/);
    expect(fake.sendPrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove notes.txt' })).not.toBeInTheDocument());
    expect(fake.cancelTextAttachment).not.toHaveBeenCalled(); // Host expiry cleanup is independent of the local reference.
  });

  it('isolates a changed host epoch from the original draft', async () => {
    render(<Composer onOpenProject={vi.fn()} />); enterPrompt(); upload(textFile());
    await screen.findByRole('button', { name: 'Remove notes.txt' });
    fireEvent.change(screen.getByLabelText('Registered project file'), { target: { value: 'src/example.ts' } });
    fireEvent.click(screen.getByRole('button', { name: 'Attach project file' }));
    const epoch = fake.serverEpoch;
    act(() => {
      fake.serverEpoch = '90000000-0000-4000-8000-000000000009';
      useRuntimeStore.setState({ snapshot: snapshot() });
    });
    expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Remove notes.txt' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove src/example.ts' })).not.toBeInTheDocument();
    act(() => { fake.serverEpoch = epoch; useRuntimeStore.setState({ snapshot: snapshot() }); });
    expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue('Review context');
    expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove src/example.ts' })).toBeInTheDocument();
    expect(fake.sendPrompt).not.toHaveBeenCalled();
  });

  it.each(['origin', 'client-auth', 'generation'] as const)('isolates text and attachment context across a changed %s', async (change) => {
    render(<Composer onOpenProject={vi.fn()} />); enterPrompt(); upload(textFile());
    await screen.findByRole('button', { name: 'Remove notes.txt' });
    const originalOrigin = fake.origin;
    const originalAuth = fake.authenticatedSessionId;
    act(() => {
      if (change === 'origin') fake.origin = 'http://127.0.0.1:49302';
      if (change === 'client-auth') fake.authenticatedSessionId = crypto.randomUUID();
      const selected = change === 'generation' ? { ...workspace, workspaceGeneration: 2 } : workspace;
      const next = snapshot();
      useRuntimeStore.setState({ selected, snapshot: { ...next, header: { ...next.header, workspaceGeneration: selected.workspaceGeneration } } });
    });
    expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Remove notes.txt' })).not.toBeInTheDocument();
    act(() => {
      fake.origin = originalOrigin; fake.authenticatedSessionId = originalAuth;
      useRuntimeStore.setState({ selected: workspace, snapshot: snapshot() });
    });
    expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue('Review context');
    expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBeInTheDocument();
    expect(fake.sendPrompt).not.toHaveBeenCalled();
  });

  it('cancels the opaque ID in its original scope without sending a path', async () => {
    render(<Composer onOpenProject={vi.fn()} />); upload(textFile());
    fireEvent.click(await screen.findByRole('button', { name: 'Remove notes.txt' }));
    await waitFor(() => expect(fake.cancelTextAttachment).toHaveBeenCalledWith(workspace, attachmentId));
    expect(fake.sendPrompt).not.toHaveBeenCalled();
  });

  it('keeps drafts and late upload receipts under their original session, never retargeting', async () => {
    let resolveUpload!: (receipt: { attachmentId: string; byteLength: number; expiresAt: number }) => void;
    fake.uploadText.mockImplementationOnce(() => new Promise((resolve) => { resolveUpload = resolve; }));
    render(<Composer onOpenProject={vi.fn()} />); enterPrompt(); upload(textFile());
    await waitFor(() => expect(fake.uploadText).toHaveBeenCalledTimes(1));
    act(() => useRuntimeStore.setState({ snapshot: snapshot('70000000-0000-4000-8000-000000000007') }));
    expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue('');
    await act(async () => resolveUpload({ attachmentId, byteLength: 7, expiresAt: Date.now() + 300_000 }));
    expect(screen.queryByRole('button', { name: 'Remove notes.txt' })).not.toBeInTheDocument();
    act(() => useRuntimeStore.setState({ snapshot: snapshot() }));
    expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue('Review context');
    expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBeInTheDocument();
    expect(fake.sendPrompt).not.toHaveBeenCalled();
  });

  it('does not overwrite newer draft edits when an upload finishes after away-and-back selection', async () => {
    let resolveUpload!: (receipt: { attachmentId: string; byteLength: number; expiresAt: number }) => void;
    fake.uploadText.mockImplementationOnce(() => new Promise((resolve) => { resolveUpload = resolve; }));
    render(<Composer onOpenProject={vi.fn()} />); enterPrompt(); upload(textFile());
    await waitFor(() => expect(fake.uploadText).toHaveBeenCalledTimes(1));
    act(() => useRuntimeStore.setState({ snapshot: snapshot('70000000-0000-4000-8000-000000000007') }));
    act(() => useRuntimeStore.setState({ snapshot: snapshot() }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Message to selected host session' }), { target: { value: 'Newer original-session draft' } });
    await act(async () => resolveUpload({ attachmentId, byteLength: 7, expiresAt: Date.now() + 300_000 }));
    expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue('Newer original-session draft');
    expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBeInTheDocument();
    expect(fake.sendPrompt).not.toHaveBeenCalled();
  });

  it('recovers and reviews only the original request after remount, without a resend', async () => {
    fake.sendPrompt.mockRejectedValueOnce(new UnconfirmedCommand(originalId));
    const view = render(<Composer onOpenProject={vi.fn()} />); enterPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }));
    await screen.findByRole('button', { name: 'Review original request' });
    expect(fake.rememberPendingPromptReview).toHaveBeenCalledWith(workspace, sessionId, originalId);
    view.unmount();
    fake.pendingPromptReview.mockReturnValue({ kind: 'match', value: { version: 1, method: 'runtime.prompt', origin: fake.origin,
      authSessionId: fake.authenticatedSessionId, workspaceId: workspace.workspaceId, workspaceGeneration: 1,
      sessionId, serverEpoch: fake.serverEpoch, requestId: originalId } });
    fake.reviewPromptStatus.mockResolvedValue({ state: 'absent', receipt: null, rejectionCode: null });
    render(<Composer onOpenProject={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Review original request' }));
    await waitFor(() => expect(fake.reviewPromptStatus).toHaveBeenCalledWith(workspace, originalId));
    expect(fake.sendPrompt).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled();
  });

  it('uses the host clock for expiry despite a skewed browser wall clock', async () => {
    fake.estimatedHostTime = Date.now() - 60_000;
    fake.uploadText.mockResolvedValueOnce({ attachmentId, byteLength: 7, expiresAt: fake.estimatedHostTime + 30_000 });
    render(<Composer onOpenProject={vi.fn()} />); upload(textFile());
    await screen.findByRole('button', { name: 'Remove notes.txt' });
    expect(screen.getByRole('list', { name: 'Attached text context' })).not.toHaveTextContent('expired');
    enterPrompt(); fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }));
    await waitFor(() => expect(fake.sendPrompt).toHaveBeenCalledTimes(1));
  });

  it('keeps text and attached context when the host rejects a combined oversized prompt', async () => {
    fake.sendPrompt.mockRejectedValueOnce(new Error('RESULT_TOO_LARGE: combined context exceeds the prompt bound'));
    render(<Composer onOpenProject={vi.fn()} />); upload(textFile());
    await screen.findByRole('button', { name: 'Remove notes.txt' }); enterPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }));
    await screen.findByText(/RESULT_TOO_LARGE/);
    expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue('Review context');
    expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBeInTheDocument();
    expect(fake.clearPendingPromptReview).not.toHaveBeenCalled();
  });

  it.each(['session', 'generation', 'epoch'] as const)('retains and reviews the original ID after a changed %s without clearing or replay', async (change) => {
    const original = { version: 1 as const, method: 'runtime.prompt' as const, origin: fake.origin,
      authSessionId: fake.authenticatedSessionId, workspaceId: workspace.workspaceId, workspaceGeneration: 1,
      sessionId, serverEpoch: fake.serverEpoch, requestId: originalId };
    fake.pendingPromptReview.mockReturnValue({ kind: 'match', value: original });
    render(<Composer onOpenProject={vi.fn()} />);
    act(() => {
      if (change === 'epoch') fake.serverEpoch = '90000000-0000-4000-8000-000000000009';
      if (change !== 'epoch') fake.pendingPromptReview.mockReturnValue({ kind: 'blocked', reason: 'mismatch', value: original });
      const next = snapshot(change === 'session' ? '70000000-0000-4000-8000-000000000007' : sessionId);
      const selected = change === 'generation' ? { ...workspace, workspaceGeneration: 2 } : workspace;
      useRuntimeStore.setState({ selected, snapshot: { ...next, header: { ...next.header, workspaceGeneration: selected.workspaceGeneration } } });
    });
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled();
    expect(screen.getByText(/Original request:/)).toHaveTextContent(originalId);
    fake.reviewPromptStatus.mockResolvedValue({ state: 'absent', receipt: null, rejectionCode: null });
    fireEvent.click(screen.getByRole('button', { name: 'Review original request' }));
    await waitFor(() => expect(fake.reviewPromptStatus).toHaveBeenCalledWith(
      change === 'generation' ? { ...workspace, workspaceGeneration: 2 } : workspace, originalId));
    await screen.findByText(/identity is retained/);
    expect(fake.clearPendingPromptReview).not.toHaveBeenCalled();
    expect(fake.sendPrompt).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled();
    expect(screen.getByText(/Original request:/)).toHaveTextContent(originalId);
  });

  it('does not expire an acknowledged live view when its snapshot assembly TTL elapses', () => {
    const confirmed = snapshot();
    fake.estimatedHostTime = confirmed.header.expiresAt + 1;
    useRuntimeStore.setState({ snapshot: confirmed });
    render(<Composer onOpenProject={vi.fn()} connectionControlsMounted />);
    expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toBeEnabled();
    enterPrompt();
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeEnabled();
  });

  it.each(['runtime.setModel', 'permission.confirm', 'session.select'] as const)('delegates pending %s exclusively to shared review and does not stick after settlement', (method) => {
    fake.pendingPromptReview.mockReturnValue({ kind: 'match', value: { version: 1, method, origin: fake.origin,
      authSessionId: fake.authenticatedSessionId, workspaceId: workspace.workspaceId, workspaceGeneration: 1,
      sessionId, serverEpoch: fake.serverEpoch, requestId: originalId } });
    render(<Composer onOpenProject={vi.fn()} connectionControlsMounted />);
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled();
    expect(screen.getByLabelText('Attach plain text file')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Review original request' })).not.toBeInTheDocument();
    expect(screen.getByText(/Original command:/)).toHaveTextContent(originalId);
    expect(screen.getByText(/Original command:/)).toHaveTextContent(method);
    expect(screen.getByText(/Original command:/)).toHaveTextContent('Review original command');
    const form = screen.getByRole('textbox', { name: 'Message to selected host session' }).closest('form');
    if (!form) throw new Error('Shared Composer form missing');
    fireEvent.submit(form);
    expect(fake.reviewPromptStatus).not.toHaveBeenCalled();
    expect(fake.clearPendingPromptReview).not.toHaveBeenCalled();
    expect(fake.sendPrompt).not.toHaveBeenCalled();
    act(() => {
      fake.pendingPromptReview.mockReturnValue({ kind: 'none' });
      useRuntimeStore.setState({ snapshot: snapshot() });
    });
    expect(screen.queryByRole('button', { name: 'Review original request' })).not.toBeInTheDocument();
    enterPrompt();
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeEnabled();
    expect(fake.sendPrompt).not.toHaveBeenCalled();
  });

  it('does not clear a non-prompt record that replaced the original prompt while its status read was in flight', async () => {
    let resolveStatus!: (status: { state: 'rejected'; receipt: null; rejectionCode: 'FORBIDDEN' }) => void;
    fake.reviewPromptStatus.mockImplementationOnce(() => new Promise<{ state: 'rejected'; receipt: null; rejectionCode: 'FORBIDDEN' }>((resolve) => { resolveStatus = resolve; }));
    render(<Composer onOpenProject={vi.fn()} connectionControlsMounted />);
    upload(textFile()); await screen.findByRole('button', { name: 'Remove notes.txt' }); enterPrompt();
    const original = { version: 1 as const, method: 'runtime.prompt' as const, origin: fake.origin,
      authSessionId: fake.authenticatedSessionId, workspaceId: workspace.workspaceId, workspaceGeneration: 1,
      sessionId, serverEpoch: fake.serverEpoch, requestId: originalId };
    act(() => { fake.pendingPromptReview.mockReturnValue({ kind: 'match', value: original }); useRuntimeStore.setState({ snapshot: snapshot() }); });
    fireEvent.click(screen.getByRole('button', { name: 'Review original request' }));
    await waitFor(() => expect(fake.reviewPromptStatus).toHaveBeenCalledWith(workspace, originalId));
    const replacementId = '10000000-0000-4000-8000-000000000001.1001.a0000000-0000-4000-8000-00000000000a';
    act(() => {
      fake.pendingPromptReview.mockReturnValue({ kind: 'match', value: { ...original, method: 'permission.confirm', requestId: replacementId } });
    });
    await act(async () => resolveStatus({ state: 'rejected', receipt: null, rejectionCode: 'FORBIDDEN' }));
    expect(fake.clearPendingPromptReview).not.toHaveBeenCalled();
    expect(fake.sendPrompt).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Review original request' })).not.toBeInTheDocument();
    expect(screen.getByText(/Original command:/)).toHaveTextContent(replacementId);
    expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue('Review context');
    expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled();
  });

  it.each(['accepted', 'not-accepted', 'rejected'] as const)('resolves only its original prompt cache when native review settles lookup to none (%s)', async (outcome) => {
    const original = { version: 1 as const, method: 'runtime.prompt' as const, origin: fake.origin,
      authSessionId: fake.authenticatedSessionId, workspaceId: workspace.workspaceId, workspaceGeneration: 1,
      sessionId, serverEpoch: fake.serverEpoch, requestId: originalId };
    fake.rememberPendingPromptReview.mockImplementationOnce(() => {
      fake.pendingPromptReview.mockReturnValue({ kind: 'match', value: original });
    });
    fake.sendPrompt.mockRejectedValueOnce(new UnconfirmedCommand(originalId));
    render(<Composer onOpenProject={vi.fn()} connectionControlsMounted />);
    upload(textFile()); await screen.findByRole('button', { name: 'Remove notes.txt' }); enterPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }));
    await screen.findByRole('button', { name: 'Review original request' });
    const status: CommandStatus = outcome === 'rejected'
      ? { state: 'rejected', receipt: null, rejectionCode: 'FORBIDDEN' }
      : { state: 'settled', receipt: { kind: 'prompt', outcome, sessionId, requestId: originalId,
        runId: 'a0000000-0000-4000-8000-00000000000a', durability: 'journaled', viewRevision: 5 }, rejectionCode: null };
    fake.reviewPromptStatus.mockImplementationOnce(async () => {
      // Actual native facade exposes only sending/unknown records. Core review settles BEFORE return/notify.
      fake.pendingPromptReview.mockReturnValue({ kind: 'none' });
      useRuntimeStore.setState({ snapshot: snapshot() });
      return status;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review original request' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Review original request' })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toBeEnabled());
    expect(fake.reviewPromptStatus).toHaveBeenCalledWith(workspace, originalId);
    expect(fake.reviewPromptStatus).toHaveBeenCalledTimes(1);
    expect(fake.clearPendingPromptReview).not.toHaveBeenCalled(); // Already settled native record: resolve only own cache/draft.
    expect(fake.sendPrompt).toHaveBeenCalledTimes(1);
    if (outcome === 'accepted') {
      expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue('');
      expect(screen.queryByRole('button', { name: 'Remove notes.txt' })).not.toBeInTheDocument();
    } else {
      expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue('Review context');
      expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBeInTheDocument();
    }
  });

  it.each(['absent', 'foreign-receipt'] as const)('retains the original prompt cache when none lacks terminal original proof (%s)', async (result) => {
    render(<Composer onOpenProject={vi.fn()} connectionControlsMounted />); enterPrompt();
    const original = { version: 1 as const, method: 'runtime.prompt' as const, origin: fake.origin,
      authSessionId: fake.authenticatedSessionId, workspaceId: workspace.workspaceId, workspaceGeneration: 1,
      sessionId, serverEpoch: fake.serverEpoch, requestId: originalId };
    act(() => { fake.pendingPromptReview.mockReturnValue({ kind: 'match', value: original }); useRuntimeStore.setState({ snapshot: snapshot() }); });
    const status: CommandStatus = result === 'absent' ? { state: 'absent', receipt: null, rejectionCode: null }
      : { state: 'settled', receipt: { kind: 'prompt', outcome: 'accepted',
        sessionId: '70000000-0000-4000-8000-000000000007', requestId: originalId,
        runId: 'a0000000-0000-4000-8000-00000000000a', durability: 'journaled', viewRevision: 5 }, rejectionCode: null };
    fake.reviewPromptStatus.mockImplementationOnce(async () => { fake.pendingPromptReview.mockReturnValue({ kind: 'none' }); return status; });
    fireEvent.click(screen.getByRole('button', { name: 'Review original request' }));
    await screen.findByText(/No record was cleared/);
    expect(screen.getByRole('button', { name: 'Review original request' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Message to selected host session' })).toHaveValue('Review context');
    expect(fake.clearPendingPromptReview).not.toHaveBeenCalled();
    expect(fake.sendPrompt).not.toHaveBeenCalled();
  });

  it('does not duplicate control actions when the parent confirms its separate compatible panel is mounted', () => {
    render(<Composer onOpenProject={vi.fn()} connectionControlsMounted />);
    expect(screen.queryByRole('button', { name: 'Claim control' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Release control' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Attach plain text file')).toBeInTheDocument();
  });
});
