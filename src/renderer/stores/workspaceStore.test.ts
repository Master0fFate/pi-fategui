import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GitCombinedDiff,
  GitCommitDetails,
  GitDiff,
  GitHistory,
  GitOperationResult,
  GitStatus,
  GitWorktree,
  PiDesktopApi,
} from '../../shared/contracts/ipc';
import { useWorkspaceStore } from './workspaceStore';

const HASH = 'abc1234567890abc1234567890abc1234567890';
const OTHER_HASH = 'def1234567890def1234567890def1234567890';

const status = (branch = 'main'): GitStatus => ({
  repository: true,
  branch,
  upstream: branch ? `origin/${branch}` : null,
  pushTarget: branch ? `origin/${branch}` : null,
  ahead: 0,
  behind: 0,
  changes: [],
  additions: 0,
  deletions: 0,
  truncated: false,
});

const history: GitHistory = {
  head: HASH,
  commits: [{
    hash: HASH,
    parents: [],
    authorName: 'Author',
    authorEmail: 'author@example.test',
    authoredAt: '2026-07-22T12:14:00.000Z',
    subject: 'First commit',
    refs: [],
  }],
  truncated: false,
};

const details: GitCommitDetails = {
  ...history.commits[0]!,
  filesChanged: 1,
  additions: 1,
  deletions: 0,
  files: [{ path: 'src/a.ts', status: 'M', additions: 1, deletions: 0, binary: false }],
  filesTruncated: false,
  githubUrl: null,
};

const diff = (path: string): GitDiff => ({
  path,
  state: 'text',
  original: 'old',
  modified: 'new',
  language: 'typescript',
  openable: true,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const reset = () => useWorkspaceStore.setState({
  projectPath: 'C:/project', directories: {}, expanded: new Set(), loadingDirectories: new Set(), treeTruncated: new Set(),
  query: '', searchResults: [], searchTruncated: false, searching: false, selectedFile: null, preview: null,
  previewLoading: false, git: status(), gitLoading: false, gitOperation: null, worktrees: [], worktreesLoading: false,
  history: null, historyLoading: false, commitDetails: {}, commitDetailsLoading: new Set(), selectedCommit: null,
  selectedChange: null, diff: null, diffLoading: false, combinedDiff: null, combinedDiffLoading: false, error: null,
});

describe('workspaceStore Git request invalidation', () => {
  beforeEach(() => {
    reset();
    Reflect.deleteProperty(window, 'piDesktop');
  });

  it('clears all derived Git state immediately and ignores pre-refresh responses and errors', async () => {
    const historyRequest = deferred<GitHistory>();
    const detailsRequest = deferred<GitCommitDetails>();
    const diffRequest = deferred<GitDiff>();
    const statusRequest = deferred<GitStatus>();
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getGitHistory: vi.fn(() => historyRequest.promise),
        getGitCommitDetails: vi.fn(() => detailsRequest.promise),
        getGitDiff: vi.fn(() => diffRequest.promise),
        getGitStatus: vi.fn(() => statusRequest.promise),
      } as unknown as PiDesktopApi,
    });

    const pendingHistory = useWorkspaceStore.getState().loadHistory();
    const pendingDetails = useWorkspaceStore.getState().loadCommitDetails(HASH);
    const pendingDiff = useWorkspaceStore.getState().selectChange('src/a.ts');
    useWorkspaceStore.setState({
      history,
      selectedCommit: HASH,
      combinedDiff: { patch: 'stale', truncated: false },
      combinedDiffLoading: true,
    });

    const refresh = useWorkspaceStore.getState().refreshGit();
    expect(useWorkspaceStore.getState()).toMatchObject({
      history: null,
      historyLoading: false,
      commitDetails: {},
      selectedCommit: null,
      selectedChange: null,
      diff: null,
      diffLoading: false,
      combinedDiff: null,
      combinedDiffLoading: false,
      error: null,
    });

    historyRequest.resolve(history);
    detailsRequest.resolve(details);
    diffRequest.reject(new Error('stale diff failed'));
    await Promise.all([pendingHistory, pendingDetails, pendingDiff]);
    expect(useWorkspaceStore.getState()).toMatchObject({ history: null, commitDetails: {}, diff: null, error: null });

    statusRequest.resolve(status('updated'));
    await refresh;
    expect(useWorkspaceStore.getState()).toMatchObject({ git: status('updated'), gitLoading: false });
  });

  it('does not let a pre-refresh combined diff repopulate state', async () => {
    const combinedRequest = deferred<GitCombinedDiff>();
    const statusRequest = deferred<GitStatus>();
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getGitCombinedDiff: vi.fn(() => combinedRequest.promise),
        getGitStatus: vi.fn(() => statusRequest.promise),
      } as unknown as PiDesktopApi,
    });

    const pendingCombined = useWorkspaceStore.getState().loadCombinedDiff();
    const refresh = useWorkspaceStore.getState().refreshGit();
    combinedRequest.resolve({ patch: 'stale combined diff', truncated: false });
    await pendingCombined;
    expect(useWorkspaceStore.getState()).toMatchObject({ combinedDiff: null, combinedDiffLoading: false });

    statusRequest.resolve(status());
    await refresh;
  });

  it('clears stale worktree loading on refresh and ignores the old result', async () => {
    const firstRequest = deferred<GitWorktree[]>();
    const secondRequest = deferred<GitWorktree[]>();
    const statusRequest = deferred<GitStatus>();
    const currentWorktree: GitWorktree = { path: 'C:/project', branch: 'main', head: HASH, detached: false, bare: false, current: true };
    let worktreeCall = 0;
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        listGitWorktrees: vi.fn(() => worktreeCall++ === 0 ? firstRequest.promise : secondRequest.promise),
        getGitStatus: vi.fn(() => statusRequest.promise),
      } as unknown as PiDesktopApi,
    });

    const staleLoad = useWorkspaceStore.getState().loadWorktrees();
    expect(useWorkspaceStore.getState().worktreesLoading).toBe(true);

    const refresh = useWorkspaceStore.getState().refreshGit();
    expect(useWorkspaceStore.getState()).toMatchObject({ worktrees: [], worktreesLoading: false });

    const currentLoad = useWorkspaceStore.getState().loadWorktrees();
    expect(useWorkspaceStore.getState().worktreesLoading).toBe(true);
    firstRequest.resolve([currentWorktree]);
    await staleLoad;
    expect(useWorkspaceStore.getState()).toMatchObject({ worktrees: [], worktreesLoading: true, error: null });

    secondRequest.resolve([currentWorktree]);
    await currentLoad;
    statusRequest.resolve(status('updated'));
    await refresh;
    expect(useWorkspaceStore.getState()).toMatchObject({ worktrees: [currentWorktree], worktreesLoading: false, git: status('updated') });
  });

  it('clears stale worktree loading after a successful Git operation and ignores the old error', async () => {
    const firstRequest = deferred<GitWorktree[]>();
    const secondRequest = deferred<GitWorktree[]>();
    const operationResult: GitOperationResult = { operation: 'fetch', message: 'fetch complete', status: status('main') };
    const currentWorktree: GitWorktree = { path: 'C:/project', branch: 'main', head: HASH, detached: false, bare: false, current: true };
    let worktreeCall = 0;
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        listGitWorktrees: vi.fn(() => worktreeCall++ === 0 ? firstRequest.promise : secondRequest.promise),
        runGitOperation: vi.fn(async () => operationResult),
      } as unknown as PiDesktopApi,
    });

    const staleLoad = useWorkspaceStore.getState().loadWorktrees();
    await useWorkspaceStore.getState().runGitOperation('fetch');
    expect(useWorkspaceStore.getState()).toMatchObject({ worktrees: [], worktreesLoading: false });

    const currentLoad = useWorkspaceStore.getState().loadWorktrees();
    expect(useWorkspaceStore.getState().worktreesLoading).toBe(true);
    firstRequest.reject(new Error('stale worktree failed'));
    await staleLoad;
    expect(useWorkspaceStore.getState()).toMatchObject({ worktrees: [], worktreesLoading: true, error: null });

    secondRequest.resolve([currentWorktree]);
    await currentLoad;
    expect(useWorkspaceStore.getState()).toMatchObject({ worktrees: [currentWorktree], worktreesLoading: false, error: null });
  });

  it('lets only the latest changed-file selection publish success or error state', async () => {
    const first = deferred<GitDiff>();
    const second = deferred<GitDiff>();
    const getGitDiff = vi.fn((path: string) => path === 'src/first.ts' ? first.promise : second.promise);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { getGitDiff } as unknown as PiDesktopApi });

    const firstSelection = useWorkspaceStore.getState().selectChange('src/first.ts');
    const secondSelection = useWorkspaceStore.getState().selectChange('src/second.ts');
    first.reject(new Error('stale selection failed'));
    await firstSelection;
    expect(useWorkspaceStore.getState()).toMatchObject({ selectedChange: 'src/second.ts', diff: null, diffLoading: true, error: null });

    second.resolve(diff('src/second.ts'));
    await secondSelection;
    expect(useWorkspaceStore.getState()).toMatchObject({ selectedChange: 'src/second.ts', diff: diff('src/second.ts'), diffLoading: false, error: null });
  });

  it('lets only the latest commit selection publish details', async () => {
    const first = deferred<GitCommitDetails>();
    const second = deferred<GitCommitDetails>();
    const otherDetails: GitCommitDetails = { ...details, hash: OTHER_HASH, subject: 'Second commit' };
    const getGitCommitDetails = vi.fn((hash: string) => hash === HASH ? first.promise : second.promise);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { getGitCommitDetails } as unknown as PiDesktopApi });

    const firstRequest = useWorkspaceStore.getState().loadCommitDetails(HASH);
    useWorkspaceStore.getState().selectCommit(OTHER_HASH);
    const secondRequest = useWorkspaceStore.getState().loadCommitDetails(OTHER_HASH);
    first.resolve(details);
    await firstRequest;
    expect(useWorkspaceStore.getState()).toMatchObject({ selectedCommit: OTHER_HASH, commitDetails: {} });

    second.resolve(otherDetails);
    await secondRequest;
    expect(useWorkspaceStore.getState().commitDetails).toEqual({ [OTHER_HASH]: otherDetails });
  });

  it('does not publish combined diff results after a newer file selection', async () => {
    const combinedRequest = deferred<GitCombinedDiff>();
    const fileRequest = deferred<GitDiff>();
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getGitCombinedDiff: vi.fn(() => combinedRequest.promise),
        getGitDiff: vi.fn(() => fileRequest.promise),
      } as unknown as PiDesktopApi,
    });

    const pendingCombined = useWorkspaceStore.getState().loadCombinedDiff();
    const pendingFile = useWorkspaceStore.getState().selectChange('src/new.ts');
    combinedRequest.reject(new Error('stale combined diff failed'));
    await pendingCombined;
    expect(useWorkspaceStore.getState()).toMatchObject({ selectedChange: 'src/new.ts', combinedDiff: null, diffLoading: true, error: null });

    fileRequest.resolve(diff('src/new.ts'));
    await pendingFile;
    expect(useWorkspaceStore.getState().diff).toEqual(diff('src/new.ts'));
  });

  it('ignores history and detail failures after switching projects', async () => {
    const historyRequest = deferred<GitHistory>();
    const detailsRequest = deferred<GitCommitDetails>();
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getGitHistory: vi.fn(() => historyRequest.promise),
        getGitCommitDetails: vi.fn(() => detailsRequest.promise),
      } as unknown as PiDesktopApi,
    });

    const pendingHistory = useWorkspaceStore.getState().loadHistory();
    const pendingDetails = useWorkspaceStore.getState().loadCommitDetails(OTHER_HASH);
    await useWorkspaceStore.getState().initialize('C:/other', null);
    historyRequest.reject(new Error('old history failed'));
    detailsRequest.reject(new Error('old details failed'));
    await Promise.all([pendingHistory, pendingDetails]);

    expect(useWorkspaceStore.getState()).toMatchObject({ projectPath: 'C:/other', history: null, commitDetails: {}, error: null });
  });

  it('invalidates pending history and details after a successful Git operation', async () => {
    const historyRequest = deferred<GitHistory>();
    const detailsRequest = deferred<GitCommitDetails>();
    const operationResult: GitOperationResult = { operation: 'fetch', message: 'fetch complete', status: status('main') };
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getGitHistory: vi.fn(() => historyRequest.promise),
        getGitCommitDetails: vi.fn(() => detailsRequest.promise),
        runGitOperation: vi.fn(async () => operationResult),
      } as unknown as PiDesktopApi,
    });

    const pendingHistory = useWorkspaceStore.getState().loadHistory();
    const pendingDetails = useWorkspaceStore.getState().loadCommitDetails(HASH);
    await useWorkspaceStore.getState().runGitOperation('fetch');
    expect(useWorkspaceStore.getState()).toMatchObject({ history: null, historyLoading: false, commitDetails: {}, selectedCommit: null });

    historyRequest.resolve(history);
    detailsRequest.resolve(details);
    await Promise.all([pendingHistory, pendingDetails]);
    expect(useWorkspaceStore.getState()).toMatchObject({ history: null, commitDetails: {}, error: null });
  });
});
