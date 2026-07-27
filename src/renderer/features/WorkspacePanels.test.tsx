import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiDesktopApi } from '../../shared/contracts/ipc';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { buildCommitGraphRows, ChangeRow, ChangesPanel } from './diffs/ChangesPanel';
import { FilesPanel } from './files/FilesPanel';
import { ResourcesPanel } from './resources/ResourcesPanel';
import { useRuntimeStore } from '../stores/runtimeStore';
import { useUiStore } from '../stores/uiStore';

vi.mock('./files/LazyMonaco', () => ({
  LazyFileViewer: ({ path }: { path: string }) => <div data-testid="file-monaco">file:{path}</div>,
  LazyDiffViewer: ({ path }: { path: string }) => <div data-testid="diff-monaco">diff:{path}</div>,
}));

const reset = () => useWorkspaceStore.setState({
  projectPath: 'C:/project', directories: {}, expanded: new Set(), loadingDirectories: new Set(), treeTruncated: new Set(),
  query: '', searchResults: [], searchTruncated: false, searching: false, selectedFile: null, preview: null,
  previewLoading: false, git: null, gitLoading: false, gitOperation: null, worktrees: [], worktreesLoading: false,
  history: null, historyLoading: false, commitDetails: {}, commitDetailsLoading: new Set(), selectedCommit: null,
  selectedChange: null, diff: null, diffLoading: false, combinedDiff: null, combinedDiffLoading: false, error: null,
});

describe('workspace inspector panels', () => {
  beforeEach(() => {
    reset();
    useRuntimeStore.setState((state) => ({ runtime: { ...state.runtime, streaming: false, sessionOperation: false, project: { path: 'C:/project', name: 'project', trusted: true } } }));
  });
  afterEach(() => {
    Reflect.deleteProperty(window, 'piDesktop');
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('loads only the inspector surface that is actually visible', async () => {
    const listFiles = vi.fn(async () => ({ path: '', entries: [], truncated: false }));
    const getGitStatus = vi.fn(async () => ({ repository: true, branch: 'main', upstream: 'origin/main', pushTarget: 'origin/main', ahead: 0, behind: 0, changes: [], additions: 0, deletions: 0, truncated: false }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { listFiles, getGitStatus } as unknown as PiDesktopApi });

    await useWorkspaceStore.getState().initialize('C:/project', null);
    expect(listFiles).not.toHaveBeenCalled();
    expect(getGitStatus).not.toHaveBeenCalled();
    await useWorkspaceStore.getState().initialize('C:/project', 'files');
    expect(listFiles).toHaveBeenCalledOnce();
    expect(getGitStatus).not.toHaveBeenCalled();
    await useWorkspaceStore.getState().initialize('C:/project', 'changes');
    expect(getGitStatus).toHaveBeenCalledOnce();
  });

  it('does not send an empty search request before a project is open', async () => {
    const searchFiles = vi.fn(async () => ({ entries: [], truncated: false }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { searchFiles } as unknown as PiDesktopApi });
    useWorkspaceStore.setState({ projectPath: null, query: '' });

    await useWorkspaceStore.getState().search('');

    expect(searchFiles).not.toHaveBeenCalled();
  });

  it('clears stale diff state before an explicit Git refresh', async () => {
    const getGitStatus = vi.fn(async () => ({ repository: true, branch: 'main', upstream: 'origin/main', pushTarget: 'origin/main', ahead: 0, behind: 0, changes: [], additions: 0, deletions: 0, truncated: false }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { getGitStatus } as unknown as PiDesktopApi });
    useWorkspaceStore.setState({
      selectedChange: 'stale.ts',
      diff: { path: 'stale.ts', state: 'text', original: 'old', modified: 'new', language: 'typescript', openable: true },
    });

    const refresh = useWorkspaceStore.getState().refreshGit();
    expect(useWorkspaceStore.getState()).toMatchObject({ selectedChange: null, diff: null, diffLoading: false });
    await refresh;
  });

  it('keeps a stable view toggle and loads branch history on demand', async () => {
    const status = { repository: true, branch: 'main', upstream: 'origin/main', pushTarget: 'origin/main', ahead: 1, behind: 0, changes: [], additions: 0, deletions: 0, truncated: false };
    const getGitStatus = vi.fn(async () => status);
    const getGitHistory = vi.fn(async () => ({ head: null, commits: [], truncated: false }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { getGitStatus, getGitHistory } as unknown as PiDesktopApi });
    useWorkspaceStore.setState({ git: status });
    render(<ChangesPanel />);
    expect(screen.getByRole('button', { name: 'Switch to branch history' })).toHaveTextContent('Diff');
    expect(screen.queryByRole('button', { name: 'Go to current history item' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Fetch all remotes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pull current branch' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Push current branch' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh Git status' }));
    await vi.waitFor(() => expect(getGitStatus).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(useUiStore.getState().toast).toMatchObject({ title: 'Git status refreshed' }));

    fireEvent.click(screen.getByRole('button', { name: 'Switch to branch history' }));
    await vi.waitFor(() => expect(getGitHistory).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Switch to working-tree diff' })).toHaveTextContent('Branch');
    expect(screen.getByLabelText('Branch history')).toBeInTheDocument();
  });

  it('keeps manual refresh available on detached HEAD without remote controls', async () => {
    const detachedStatus = { repository: true, branch: '', upstream: null, pushTarget: null, ahead: 0, behind: 0, changes: [], additions: 0, deletions: 0, truncated: false };
    const getGitStatus = vi.fn(async () => detachedStatus);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { getGitStatus } as unknown as PiDesktopApi });
    useWorkspaceStore.setState({ git: detachedStatus });

    render(<ChangesPanel />);
    expect(screen.getByRole('button', { name: 'Change worktree. Current branch: HEAD' })).toHaveTextContent('HEAD');
    expect(screen.getByRole('button', { name: 'Refresh detached HEAD status' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /fetch|pull|push/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh detached HEAD status' }));
    await vi.waitFor(() => expect(getGitStatus).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(useUiStore.getState().toast).toMatchObject({
      title: 'Git status refreshed',
      message: 'Detached HEAD status is current.',
    }));
  });

  it('keeps aggregate metrics in the header and opens file and combined bounded diffs', async () => {
    const branch = 'feature/a-very-long-worktree-name';
    const getGitDiff = vi.fn(async () => ({ path: 'src/hello world ü.ts', state: 'text' as const, original: 'old', modified: 'new', language: 'typescript', openable: true }));
    const getGitCombinedDiff = vi.fn(async () => ({ patch: 'diff --git a/src/a.ts b/src/a.ts', truncated: false }));
    const listGitWorktrees = vi.fn(async () => [{ path: 'C:/project', head: 'abc1234567890abc1234567890abc1234567890', branch, bare: false, detached: false, current: true }]);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { getGitDiff, getGitCombinedDiff, listGitWorktrees } as unknown as PiDesktopApi });
    useWorkspaceStore.setState({
      git: {
        repository: true, branch, upstream: `origin/${branch}`, pushTarget: `origin/${branch}`, ahead: 0, behind: 0, additions: 3, deletions: 2, truncated: false,
        changes: [
          { path: 'src/hello world ü.ts', indexStatus: ' ', workTreeStatus: 'M', additions: 3, deletions: 2, binary: false },
          ...Array.from({ length: 999 }, (_value, index) => ({ path: `src/generated-${index}.ts`, indexStatus: ' ', workTreeStatus: 'M', additions: 0, deletions: 0, binary: false })),
        ],
      },
    });
    await useWorkspaceStore.getState().selectChange('src/hello world ü.ts');
    const { container } = render(<div style={{ height: 700 }}><ChangesPanel /></div>);
    expect(screen.getByRole('button', { name: '1000 changed files. Open combined diff' })).toHaveTextContent('1000');
    expect(screen.getByRole('button', { name: '3 lines added. Open combined diff' })).toHaveTextContent('+3');
    expect(screen.getByRole('button', { name: '2 lines removed. Open combined diff' })).toHaveTextContent('−2');
    const worktree = screen.getByLabelText(`Change worktree. Current branch: ${branch}`);
    expect(worktree).toHaveTextContent(branch);
    fireEvent.click(worktree);
    expect(await screen.findByText('Changing worktrees reopens Pi at that project root.')).toBeInTheDocument();
    render(<ChangeRow change={{ path: 'src/changed.ts', indexStatus: ' ', workTreeStatus: 'M', additions: 1, deletions: 0, binary: false }} selected={false} onSelect={vi.fn()} />);
    expect(screen.getAllByLabelText('Modified file').length).toBeGreaterThan(0);
    expect(container.querySelector('.change-counts')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Changed files').querySelector('[data-virtuoso-scroller]')).toBeInTheDocument();
    expect(await screen.findByTestId('diff-monaco')).toHaveTextContent('src/hello world ü.ts');
    expect(getGitDiff).toHaveBeenCalledWith('src/hello world ü.ts');
    fireEvent.click(screen.getByRole('button', { name: '1000 changed files. Open combined diff' }));
    expect(await screen.findByTestId('file-monaco')).toHaveTextContent('working-tree.diff');
    expect(getGitCombinedDiff).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: /revert|accept/i })).not.toBeInTheDocument();
  });

  it('renders a bounded graph, lazy commit card, refs, and selected commit file tree', async () => {
    const commit = {
      hash: 'abc1234567890abc1234567890abc1234567890', parents: [],
      authorName: 'Master0fFate', authorEmail: 'author@example.test', authoredAt: '2026-07-22T12:14:00.000Z',
      subject: 'Add galaxy CTA backdrop', refs: [{ name: 'main', kind: 'head' as const }, { name: 'origin/main', kind: 'remote' as const }],
    };
    const getGitHistory = vi.fn(async () => ({ head: commit.hash, commits: [commit], truncated: false }));
    const getGitCommitDetails = vi.fn(async () => ({
      ...commit, filesChanged: 2, additions: 15, deletions: 4,
      files: [{ path: 'components/standards-section.tsx', status: 'M', additions: 15, deletions: 4, binary: false }],
      filesTruncated: false, githubUrl: `https://github.com/example/project/commit/${commit.hash}`,
    }));
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { getGitHistory, getGitCommitDetails } as unknown as PiDesktopApi });
    useWorkspaceStore.setState({ git: { repository: true, branch: 'main', upstream: 'origin/main', pushTarget: 'origin/main', ahead: 0, behind: 0, changes: [], additions: 0, deletions: 0, truncated: false } });
    expect(buildCommitGraphRows([commit])).toMatchObject([{ lane: 0, commit: { hash: commit.hash } }]);
    render(<div style={{ height: 700 }}><ChangesPanel /></div>);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to branch history' }));
    const row = await screen.findByRole('button', { name: /Add galaxy CTA backdrop/ });
    fireEvent.pointerEnter(row);
    const card = await screen.findByLabelText('Commit details for Add galaxy CTA backdrop');
    expect(within(card).getByText('Master0fFate')).toBeInTheDocument();
    expect(await within(card).findByText('2 files changed')).toBeInTheDocument();
    expect(within(card).getByText('15 insertions(+)')).toBeInTheDocument();
    expect(within(card).getByText('4 deletions(-)')).toBeInTheDocument();
    expect(within(card).getByText('origin/main')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Open on GitHub' })).toBeInTheDocument();
    const copyHash = within(card).getByRole('button', { name: `Copy commit hash ${commit.hash.slice(0, 12)}` });
    expect(copyHash).toHaveTextContent(commit.hash.slice(0, 12));
    expect(copyHash).not.toHaveTextContent(commit.hash);
    fireEvent.click(copyHash);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(commit.hash));
    fireEvent.click(row);
    expect(await screen.findByLabelText('Files changed in Add galaxy CTA backdrop')).toHaveTextContent('components/standards-section.tsx');
    expect(getGitCommitDetails).toHaveBeenCalledWith(commit.hash);
  });

  it('browses incremental tree entries and shows a lazy text file preview', async () => {
    const readFile = vi.fn(async () => ({ path: 'src/app.ts', name: 'app.ts', size: 12, state: 'text' as const, content: 'export {};', language: 'typescript' }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { readFile } as unknown as PiDesktopApi });
    useWorkspaceStore.setState({ directories: { '': [{ path: 'src/app.ts', name: 'app.ts', kind: 'file', symlink: false }] } });
    await useWorkspaceStore.getState().selectFile('src/app.ts');
    render(<div style={{ height: 700 }}><FilesPanel /></div>);
    expect(screen.getByLabelText('Project file tree').querySelector('[data-virtuoso-scroller]')).toBeInTheDocument();
    expect(await screen.findByTestId('file-monaco')).toHaveTextContent('src/app.ts');
    expect(readFile).toHaveBeenCalledWith('src/app.ts');
  });

  it('renders bounded raster files and changed images in the lower preview', () => {
    const imageData = Buffer.from('preview').toString('base64');
    useWorkspaceStore.setState({
      preview: { path: 'assets/icon.png', name: 'icon.png', size: 7, state: 'image', content: imageData, mimeType: 'image/png', language: 'plaintext', openable: false },
    });
    const { unmount } = render(<div style={{ height: 700 }}><FilesPanel /></div>);
    expect(screen.getByRole('img', { name: 'Preview of assets/icon.png' })).toHaveAttribute('src', `data:image/png;base64,${imageData}`);
    unmount();

    useWorkspaceStore.setState({
      diff: { path: 'assets/icon.jpg', state: 'image', imageData, mimeType: 'image/jpeg', language: 'plaintext', openable: false, message: 'Working-tree image preview' },
    });
    render(<div style={{ height: 700 }}><ChangesPanel /></div>);
    expect(screen.getByRole('img', { name: 'Preview of assets/icon.jpg' })).toHaveAttribute('src', `data:image/jpeg;base64,${imageData}`);
  });

  it('shows complete Pi resources with an authored empty state', () => {
    useRuntimeStore.setState((state) => ({ runtime: { ...state.runtime, commands: [], skills: [] } }));
    const { rerender } = render(<ResourcesPanel />);
    expect(screen.getByText('No Pi resources loaded')).toBeInTheDocument();

    useRuntimeStore.setState((state) => ({
      runtime: {
        ...state.runtime,
        commands: [
          { name: 'parallax', description: 'Control Parallax', source: 'extension' },
          { name: 'review', description: 'Review current changes', source: 'prompt' },
          { name: 'skill:vibesecurity', description: 'Review security', source: 'skill' },
        ],
        skills: [{ name: 'release', description: 'Prepare a release' }, { name: 'vibesecurity', description: 'Review security' }],
      },
    }));
    rerender(<ResourcesPanel />);
    const extensions = screen.getByLabelText('Extension commands');
    const prompts = screen.getByLabelText('Prompt templates');
    const skillGroup = screen.getByLabelText('Skills');
    expect(within(extensions).getByText('/parallax')).toBeInTheDocument();
    expect(within(prompts).getByText('/review')).toBeInTheDocument();
    expect(within(prompts).queryByText(/vibesecurity/)).not.toBeInTheDocument();
    expect(within(skillGroup).getByText('release')).toBeInTheDocument();
    expect(within(skillGroup).getByText('vibesecurity')).toBeInTheDocument();
    fireEvent.click(within(skillGroup).getByText('Skills'));
    expect(skillGroup).not.toHaveAttribute('open');
  });
});
