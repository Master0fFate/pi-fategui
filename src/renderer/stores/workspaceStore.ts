import { create } from 'zustand';
import type {
  FileEntry,
  FilePreview,
  GitCombinedDiff,
  GitCommitDetails,
  GitHistory,
  GitOperation,
  GitOperationResult,
  GitDiff,
  GitStatus,
  GitWorktree,
} from '../../shared/contracts/ipc';

interface WorkspaceStore {
  projectPath: string | null;
  directories: Record<string, FileEntry[]>;
  expanded: Set<string>;
  loadingDirectories: Set<string>;
  treeTruncated: Set<string>;
  query: string;
  searchResults: FileEntry[];
  searchTruncated: boolean;
  searching: boolean;
  selectedFile: string | null;
  preview: FilePreview | null;
  previewLoading: boolean;
  git: GitStatus | null;
  gitLoading: boolean;
  gitOperation: GitOperation | null;
  worktrees: GitWorktree[];
  worktreesLoading: boolean;
  history: GitHistory | null;
  historyLoading: boolean;
  commitDetails: Record<string, GitCommitDetails>;
  commitDetailsLoading: Set<string>;
  selectedCommit: string | null;
  selectedChange: string | null;
  reviewedPaths: Set<string>;
  reviewPathRequest: { projectPath: string; path: string; nonce: number } | null;
  reviewNotice: string | null;
  diff: GitDiff | null;
  diffLoading: boolean;
  combinedDiff: GitCombinedDiff | null;
  combinedDiffLoading: boolean;
  error: string | null;
  initialize: (projectPath: string | null, surface?: 'files' | 'changes' | null) => Promise<void>;
  toggleDirectory: (path: string) => Promise<void>;
  setQuery: (query: string) => void;
  search: (query: string) => Promise<void>;
  selectFile: (path: string) => Promise<void>;
  openSelectedFile: () => Promise<void>;
  openPath: (path: string) => Promise<void>;
  refreshGit: () => Promise<void>;
  loadWorktrees: () => Promise<void>;
  loadHistory: (force?: boolean) => Promise<void>;
  loadCommitDetails: (hash: string) => Promise<void>;
  selectCommit: (hash: string | null) => void;
  loadCombinedDiff: () => Promise<void>;
  runGitOperation: (operation: GitOperation) => Promise<GitOperationResult>;
  selectChange: (path: string) => Promise<void>;
  toggleReviewed: (path: string) => void;
  requestReviewPath: (projectPath: string, path: string, nonce: number) => void;
  resolveReviewPath: () => Promise<void>;
}

function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return 'The project operation failed.';
  try {
    const parsed = JSON.parse(error.message) as { message?: string };
    return parsed.message ?? error.message;
  } catch {
    return error.message;
  }
}

export interface VisibleFileEntry extends FileEntry { depth: number }

let searchRequestSequence = 0;
let gitGeneration = 0;
let gitStatusRequestSequence = 0;
let worktreesRequestSequence = 0;
let historyRequestSequence = 0;
let commitDetailsRequestSequence = 0;
let combinedDiffRequestSequence = 0;
let fileDiffRequestSequence = 0;
let gitOperationRequestSequence = 0;

function isCurrentGitGeneration(projectPath: string, generation: number): boolean {
  return getWorkspaceProjectPath() === projectPath && gitGeneration === generation;
}

function getWorkspaceProjectPath(): string | null {
  return useWorkspaceStore.getState().projectPath;
}

export function flattenTree(directories: Record<string, FileEntry[]>, expanded: Set<string>): VisibleFileEntry[] {
  const result: VisibleFileEntry[] = [];
  const visit = (directory: string, depth: number) => {
    for (const entry of directories[directory] ?? []) {
      result.push({ ...entry, depth });
      if (entry.kind === 'directory' && expanded.has(entry.path)) visit(entry.path, depth + 1);
    }
  };
  visit('', 0);
  return result;
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  projectPath: null,
  directories: {},
  expanded: new Set(),
  loadingDirectories: new Set(),
  treeTruncated: new Set(),
  query: '',
  searchResults: [],
  searchTruncated: false,
  searching: false,
  selectedFile: null,
  preview: null,
  previewLoading: false,
  git: null,
  gitLoading: false,
  gitOperation: null,
  worktrees: [],
  worktreesLoading: false,
  history: null,
  historyLoading: false,
  commitDetails: {},
  commitDetailsLoading: new Set(),
  selectedCommit: null,
  selectedChange: null,
  reviewedPaths: new Set(),
  reviewPathRequest: null,
  reviewNotice: null,
  diff: null,
  diffLoading: false,
  combinedDiff: null,
  combinedDiffLoading: false,
  error: null,

  initialize: async (projectPath, surface = 'changes') => {
    const projectChanged = get().projectPath !== projectPath;
    if (projectChanged) {
      searchRequestSequence += 1;
      gitGeneration += 1;
      worktreesRequestSequence += 1;
      set({
        projectPath, directories: {}, expanded: new Set(), loadingDirectories: new Set(), treeTruncated: new Set(),
        query: '', searchResults: [], searchTruncated: false, searching: false, selectedFile: null, preview: null,
        previewLoading: false, git: null, gitLoading: false, gitOperation: null, worktrees: [], worktreesLoading: false,
        history: null, historyLoading: false, commitDetails: {}, commitDetailsLoading: new Set(), selectedCommit: null,
        selectedChange: null, reviewedPaths: new Set(), reviewPathRequest: null, reviewNotice: null,
        diff: null, diffLoading: false, combinedDiff: null, combinedDiffLoading: false, error: null,
      });
    }
    if (!projectPath || !surface || !('piDesktop' in window)) return;
    const desktop = window.piDesktop;
    const expected = projectPath;
    if (surface === 'files' && !get().directories[''] && !get().loadingDirectories.has('') && typeof desktop.listFiles === 'function') {
      set({ loadingDirectories: new Set([...get().loadingDirectories, '']) });
      try {
        const listing = await desktop.listFiles('');
        if (get().projectPath !== expected) return;
        const loadingDirectories = new Set(get().loadingDirectories);
        loadingDirectories.delete('');
        set({ directories: { '': listing.entries }, treeTruncated: listing.truncated ? new Set(['']) : new Set(), loadingDirectories });
      } catch (error) {
        if (get().projectPath === expected) {
          const loadingDirectories = new Set(get().loadingDirectories);
          loadingDirectories.delete('');
          set({ loadingDirectories, error: messageOf(error) });
        }
      }
    }
    if (surface === 'changes' && !get().git && !get().gitLoading && typeof desktop.getGitStatus === 'function') {
      const generation = gitGeneration;
      const requestSequence = ++gitStatusRequestSequence;
      set({ gitLoading: true });
      try {
        const git = await desktop.getGitStatus();
        if (isCurrentGitGeneration(expected, generation) && requestSequence === gitStatusRequestSequence) {
          const paths = new Set(git.changes.map((change) => change.path));
          const selectedChange = get().selectedChange;
          const hasChanges = git.repository && git.changes.length > 0;
          set({
            git,
            gitLoading: false,
            reviewedPaths: hasChanges ? new Set([...get().reviewedPaths].filter((path) => paths.has(path))) : new Set(),
            reviewNotice: null,
            ...(hasChanges ? {} : { reviewPathRequest: null }),
            ...(selectedChange && paths.has(selectedChange) ? {} : { selectedChange: null, diff: null, diffLoading: false }),
          });
          if (hasChanges) void get().resolveReviewPath();
        }
      } catch (error) {
        if (isCurrentGitGeneration(expected, generation) && requestSequence === gitStatusRequestSequence) set({
          gitLoading: false,
          error: messageOf(error),
          selectedChange: null,
          reviewedPaths: new Set(),
          reviewPathRequest: null,
          reviewNotice: null,
          diff: null,
          diffLoading: false,
        });
      }
    }
  },

  toggleDirectory: async (directoryPath) => {
    const state = get();
    if (state.expanded.has(directoryPath)) {
      const expanded = new Set(state.expanded);
      expanded.delete(directoryPath);
      set({ expanded });
      return;
    }
    const expanded = new Set(state.expanded);
    expanded.add(directoryPath);
    set({ expanded });
    if (state.directories[directoryPath] || state.loadingDirectories.has(directoryPath)) return;
    const loadingDirectories = new Set(get().loadingDirectories);
    loadingDirectories.add(directoryPath);
    set({ loadingDirectories });
    const expected = get().projectPath;
    try {
      const listing = await window.piDesktop.listFiles(directoryPath);
      if (get().projectPath !== expected) return;
      const nextLoading = new Set(get().loadingDirectories);
      nextLoading.delete(directoryPath);
      const treeTruncated = new Set(get().treeTruncated);
      if (listing.truncated) treeTruncated.add(directoryPath);
      set({ directories: { ...get().directories, [directoryPath]: listing.entries }, loadingDirectories: nextLoading, treeTruncated });
    } catch (error) {
      const nextLoading = new Set(get().loadingDirectories);
      nextLoading.delete(directoryPath);
      set({ loadingDirectories: nextLoading, error: messageOf(error) });
    }
  },

  setQuery: (query) => set({ query }),
  search: async (query) => {
    const requestSequence = ++searchRequestSequence;
    const trimmed = query.trim();
    if (!trimmed) {
      set({ searchResults: [], searchTruncated: false, searching: false });
      if (get().projectPath && 'piDesktop' in window && typeof window.piDesktop.searchFiles === 'function') void window.piDesktop.searchFiles('').catch(() => undefined);
      return;
    }
    const expectedProject = get().projectPath;
    set({ searching: true });
    try {
      const result = await window.piDesktop.searchFiles(trimmed);
      if (requestSequence !== searchRequestSequence || get().projectPath !== expectedProject || get().query.trim() !== trimmed) return;
      set({ searchResults: result.entries, searchTruncated: result.truncated, searching: false });
    } catch (error) {
      if (requestSequence !== searchRequestSequence || get().projectPath !== expectedProject || get().query.trim() !== trimmed) return;
      set({ searching: false, error: messageOf(error) });
    }
  },

  selectFile: async (path) => {
    const expectedProject = get().projectPath;
    set({ selectedFile: path, preview: null, previewLoading: true, error: null });
    try {
      const preview = await window.piDesktop.readFile(path);
      if (get().projectPath === expectedProject && get().selectedFile === path) set({ preview, previewLoading: false });
    } catch (error) {
      if (get().selectedFile === path) set({ previewLoading: false, error: messageOf(error) });
    }
  },

  openSelectedFile: async () => {
    const selected = get().selectedFile;
    if (selected) await get().openPath(selected);
  },

  openPath: async (path) => {
    try {
      const result = await window.piDesktop.openFile(path);
      if (!result.opened) set({ error: result.error ?? 'The file could not be opened.' });
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  refreshGit: async () => {
    const expectedProject = get().projectPath;
    if (!expectedProject) return;
    const generation = ++gitGeneration;
    worktreesRequestSequence += 1;
    const requestSequence = ++gitStatusRequestSequence;
    set({
      gitLoading: true,
      worktrees: [],
      worktreesLoading: false,
      history: null,
      historyLoading: false,
      commitDetails: {},
      commitDetailsLoading: new Set(),
      selectedCommit: null,
      selectedChange: null,
      reviewedPaths: new Set(),
      reviewPathRequest: null,
      reviewNotice: null,
      diff: null,
      diffLoading: false,
      combinedDiff: null,
      combinedDiffLoading: false,
      error: null,
    });
    try {
      const git = await window.piDesktop.getGitStatus();
      if (isCurrentGitGeneration(expectedProject, generation) && requestSequence === gitStatusRequestSequence) set({ git, gitLoading: false });
    } catch (error) {
      if (isCurrentGitGeneration(expectedProject, generation) && requestSequence === gitStatusRequestSequence) {
        set({ gitLoading: false, error: messageOf(error) });
        throw error;
      }
    }
  },

  loadWorktrees: async () => {
    const expectedProject = get().projectPath;
    if (!expectedProject || get().worktreesLoading) return;
    const generation = gitGeneration;
    const requestSequence = ++worktreesRequestSequence;
    set({ worktreesLoading: true, error: null });
    try {
      const worktrees = await window.piDesktop.listGitWorktrees();
      if (isCurrentGitGeneration(expectedProject, generation) && requestSequence === worktreesRequestSequence) set({ worktrees, worktreesLoading: false });
    } catch (error) {
      if (isCurrentGitGeneration(expectedProject, generation) && requestSequence === worktreesRequestSequence) set({ worktreesLoading: false, error: messageOf(error) });
    }
  },

  loadHistory: async (force = false) => {
    const expectedProject = get().projectPath;
    if (!expectedProject || (!force && (get().historyLoading || get().history))) return;
    const generation = gitGeneration;
    const requestSequence = ++historyRequestSequence;
    set({ historyLoading: true, ...(force ? { history: null, selectedCommit: null } : {}), error: null });
    try {
      const history = await window.piDesktop.getGitHistory();
      if (isCurrentGitGeneration(expectedProject, generation) && requestSequence === historyRequestSequence) set({ history, historyLoading: false });
    } catch (error) {
      if (isCurrentGitGeneration(expectedProject, generation) && requestSequence === historyRequestSequence) set({ historyLoading: false, error: messageOf(error) });
    }
  },

  loadCommitDetails: async (hash) => {
    const expectedProject = get().projectPath;
    const state = get();
    if (!expectedProject || state.commitDetails[hash] || state.commitDetailsLoading.has(hash)) return;
    const generation = gitGeneration;
    const requestSequence = ++commitDetailsRequestSequence;
    set({ commitDetailsLoading: new Set([hash]) });
    try {
      const details = await window.piDesktop.getGitCommitDetails(hash);
      if (!isCurrentGitGeneration(expectedProject, generation) || requestSequence !== commitDetailsRequestSequence) return;
      set({ commitDetails: { ...get().commitDetails, [hash]: details }, commitDetailsLoading: new Set() });
    } catch (error) {
      if (isCurrentGitGeneration(expectedProject, generation) && requestSequence === commitDetailsRequestSequence) {
        set({ commitDetailsLoading: new Set(), error: messageOf(error) });
      }
    }
  },

  selectCommit: (selectedCommit) => {
    commitDetailsRequestSequence += 1;
    set({ selectedCommit, commitDetailsLoading: new Set() });
  },

  loadCombinedDiff: async () => {
    const expectedProject = get().projectPath;
    if (!expectedProject || get().combinedDiffLoading) return;
    const generation = gitGeneration;
    const requestSequence = ++combinedDiffRequestSequence;
    fileDiffRequestSequence += 1;
    set({ selectedChange: null, diff: null, diffLoading: false, combinedDiff: null, combinedDiffLoading: true, error: null });
    try {
      const combinedDiff = await window.piDesktop.getGitCombinedDiff();
      if (isCurrentGitGeneration(expectedProject, generation) && requestSequence === combinedDiffRequestSequence) set({ combinedDiff, combinedDiffLoading: false });
    } catch (error) {
      if (isCurrentGitGeneration(expectedProject, generation) && requestSequence === combinedDiffRequestSequence) set({ combinedDiffLoading: false, error: messageOf(error) });
    }
  },

  runGitOperation: async (operation) => {
    const expectedProject = get().projectPath;
    if (!expectedProject || get().gitOperation) throw new Error('Another Git operation is already running.');
    const generation = gitGeneration;
    const requestSequence = ++gitOperationRequestSequence;
    set({ gitOperation: operation, error: null });
    try {
      const result = await window.piDesktop.runGitOperation(operation);
      if (isCurrentGitGeneration(expectedProject, generation) && requestSequence === gitOperationRequestSequence) {
        gitGeneration += 1;
        worktreesRequestSequence += 1;
        set({
          git: result.status,
          gitOperation: null,
          worktrees: [],
          worktreesLoading: false,
          history: null,
          historyLoading: false,
          commitDetails: {},
          commitDetailsLoading: new Set(),
          selectedCommit: null,
          selectedChange: null,
          reviewedPaths: new Set(),
          reviewPathRequest: null,
          reviewNotice: null,
          diff: null,
          diffLoading: false,
          combinedDiff: null,
          combinedDiffLoading: false,
        });
      }
      return result;
    } catch (error) {
      if (isCurrentGitGeneration(expectedProject, generation) && requestSequence === gitOperationRequestSequence) set({ gitOperation: null, error: messageOf(error) });
      throw error;
    }
  },

  toggleReviewed: (path) => {
    if (!get().git?.changes.some((change) => change.path === path)) return;
    const reviewedPaths = new Set(get().reviewedPaths);
    if (reviewedPaths.has(path)) reviewedPaths.delete(path);
    else reviewedPaths.add(path);
    set({ reviewedPaths });
  },

  requestReviewPath: (projectPath, path, nonce) => {
    if (get().projectPath !== projectPath) return;
    set({ reviewPathRequest: { projectPath, path, nonce }, reviewNotice: null });
    void get().resolveReviewPath();
  },

  resolveReviewPath: async () => {
    const request = get().reviewPathRequest;
    const git = get().git;
    if (!request || !git || get().projectPath !== request.projectPath) return;
    const change = git.changes.find((candidate) => candidate.path === request.path || candidate.oldPath === request.path);
    if (!change) {
      if (get().reviewPathRequest?.nonce === request.nonce) {
        set({ reviewPathRequest: null, reviewNotice: `${request.path} is no longer in the current change list.` });
      }
      return;
    }
    if (get().reviewPathRequest?.nonce === request.nonce) set({ reviewPathRequest: null, reviewNotice: null });
    await get().selectChange(change.path);
  },

  selectChange: async (path) => {
    const expectedProject = get().projectPath;
    if (!expectedProject) return;
    const generation = gitGeneration;
    const requestSequence = ++fileDiffRequestSequence;
    combinedDiffRequestSequence += 1;
    set({ selectedChange: path, diff: null, diffLoading: true, combinedDiff: null, combinedDiffLoading: false, error: null, reviewNotice: null });
    try {
      const diff = await window.piDesktop.getGitDiff(path);
      if (isCurrentGitGeneration(expectedProject, generation) && requestSequence === fileDiffRequestSequence && get().selectedChange === path) set({ diff, diffLoading: false });
    } catch (error) {
      if (isCurrentGitGeneration(expectedProject, generation) && requestSequence === fileDiffRequestSequence && get().selectedChange === path) set({ diffLoading: false, error: messageOf(error) });
    }
  },
}));
