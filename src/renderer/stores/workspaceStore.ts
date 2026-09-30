import { create } from 'zustand';
import type { Capability, WireResultOf } from '../../shared/protocol/methods';
import { currentNetworkScope, useRuntimeStore, type NetworkWorkspaceApi, type ReadView, type RegisteredWorkspace } from './runtimeStore';
interface HostGitViews {
  scopeKey: string | null;
  status: ReadView<WireResultOf<'git.status'>>;
  history: ReadView<WireResultOf<'git.history'>>;
  diff: ReadView<WireResultOf<'git.diff'>>;
  combined: ReadView<WireResultOf<'git.combinedDiff'>>;
  commit: ReadView<WireResultOf<'git.commitDetails'>>;
  reviewedPaths: Set<string>;
}
const emptyHostGit = (): HostGitViews => ({ scopeKey: null, status: { status: 'loading' }, history: { status: 'loading' },
  diff: { status: 'unavailable' }, combined: { status: 'unavailable' }, commit: { status: 'unavailable' }, reviewedPaths: new Set() });
let hostGitRequest = 0;
let hostDiffRequest = 0;
let hostCommitRequest = 0;
export function selectGitStatusView(state: WorkspaceStore, source: 'desktop' | 'network') {
  if (source === 'desktop') return state.git;
  return state.hostGit.scopeKey === currentNetworkScope()?.key && state.hostGit.status.status === 'ready' ? state.hostGit.status.value : null;
}
import { getFateApi, getFateApiOptional, getDesktopApi, hasCapability } from '../platform/api';
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

export interface HostFileApi {
  readonly isConnected: boolean;
  supports(capability: Capability): boolean;
  listFiles(scope: RegisteredWorkspace, directoryId: string | null): Promise<WireResultOf<'file.list'>>;
  previewText(scope: RegisteredWorkspace, fileId: string): Promise<WireResultOf<'file.previewText'>>;
}
interface HostFiles {
  scopeKey: string | null;
  directories: Record<string, WireResultOf<'file.list'>>;
  expanded: Set<string>;
  loading: Set<string>;
  selected: string | null;
  preview: WireResultOf<'file.previewText'> | null;
  previewLoading: boolean;
  error: string | null;
}
const emptyHostFiles = (): HostFiles => ({ scopeKey: null, directories: {}, expanded: new Set(), loading: new Set(),
  selected: null, preview: null, previewLoading: false, error: null });
const MAX_HOST_FILE_DIRECTORIES = 64;
let hostFilesGeneration = 0;
let hostPreviewRequest = 0;
function confirmedHostFileScope() {
  const state = useRuntimeStore.getState();
  // readSnapshot already completed and acknowledged this view. Its page TTL
  // is not a live-view lease; identity/invalidation/adapter guards own freshness.
  if (state.source !== 'network' || state.phase !== 'observing' || !state.selected || !state.snapshot) return null;
  const header = state.snapshot.header;
  if (header.workspaceId !== state.selected.workspaceId || header.workspaceGeneration !== state.selected.workspaceGeneration) return null;
  return { scope: state.selected, key: `${header.serverEpoch}:${header.workspaceId}:${header.workspaceGeneration}:${header.sessionId}:${header.snapshotId}:${state.request}` };
}

/** Presentation references remain tagged: a resource UUID must never become a local path. */
export interface FileTreeRow {
  id: string; name: string; kind: 'file' | 'directory'; depth: number; symlink: boolean;
  reference: { kind: 'desktop-path'; path: string } | { kind: 'host-resource'; resourceId: string };
}
export function selectFileRows(state: WorkspaceStore, source: 'desktop' | 'network'): FileTreeRow[] {
  if (source === 'desktop') {
    const entries = state.query.trim() ? state.searchResults.map((entry) => ({ ...entry, depth: Math.max(0, entry.path.split('/').length - 1) }))
      : flattenTree(state.directories, state.expanded);
    return entries.map((entry) => ({ id: entry.path, name: entry.name, kind: entry.kind, depth: entry.depth,
      symlink: entry.symlink ?? false, reference: { kind: 'desktop-path', path: entry.path } }));
  }
  const result: FileTreeRow[] = [];
  if (state.hostFiles.scopeKey !== confirmedHostFileScope()?.key) return result;
  const visit = (directory: string, depth: number, ancestors: Set<string>) => {
    for (const entry of state.hostFiles.directories[directory]?.entries ?? []) {
      if (ancestors.has(entry.resourceId)) continue;
      result.push({ id: entry.resourceId, name: entry.name, kind: entry.kind, depth, symlink: false,
        reference: { kind: 'host-resource', resourceId: entry.resourceId } });
      if (entry.kind === 'directory' && state.hostFiles.expanded.has(entry.resourceId) && depth < 16) {
        visit(entry.resourceId, depth + 1, new Set([...ancestors, entry.resourceId]));
      }
    }
  };
  visit('root', 0, new Set());
  return result;
}

interface WorkspaceStore {
  hostGit: HostGitViews;
  loadNetworkGit: (api: NetworkWorkspaceApi) => Promise<void>;
  readNetworkDiff: (api: NetworkWorkspaceApi, path: string | null) => Promise<void>;
  readNetworkCommit: (api: NetworkWorkspaceApi, hash: string) => Promise<void>;
  markNetworkReviewed: (path: string) => void;
  hostFiles: HostFiles;
  initializeHostFiles: (api: HostFileApi) => Promise<void>;
  activateHostFile: (api: HostFileApi, row: FileTreeRow) => Promise<void>;
  resetHostFiles: () => void;
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
  revertPath: (path: string) => Promise<void>;
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
  hostGit: emptyHostGit(),
  loadNetworkGit: async (api) => {
    const captured = currentNetworkScope();
    if (!captured || !api.isConnected) return;
    const generation = ++hostGitRequest;
    hostDiffRequest++; hostCommitRequest++;
    set({ hostGit: { ...emptyHostGit(), scopeKey: captured.key } });
    const current = () => generation === hostGitRequest && api.isConnected && currentNetworkScope()?.key === captured.key;
    if (!api.supports('git.read')) { set({ hostGit: { ...get().hostGit, status: { status: 'unavailable' }, history: { status: 'unavailable' } } }); return; }
    await Promise.all([
      api.readGitStatus(captured.scope).then((value) => { if (current()) set({ hostGit: { ...get().hostGit, status: { status: 'ready', value } } }); }, () => { if (current()) set({ hostGit: { ...get().hostGit, status: { status: 'error' } } }); }),
      api.readGitHistory(captured.scope).then((value) => { if (current()) set({ hostGit: { ...get().hostGit, history: { status: 'ready', value } } }); }, () => { if (current()) set({ hostGit: { ...get().hostGit, history: { status: 'error' } } }); }),
    ]);
  },
  readNetworkDiff: async (api, path) => {
    const captured = currentNetworkScope();
    if (!captured || !api.isConnected || !api.supports('git.read') || get().hostGit.scopeKey !== captured.key) return;
    const request = ++hostDiffRequest;
    const generation = hostGitRequest;
    set({ hostGit: { ...get().hostGit, diff: { status: path === null ? 'unavailable' : 'loading' }, combined: { status: path === null ? 'loading' : 'unavailable' } } });
    try {
      if (path === null) {
        const value = await api.readGitCombinedDiff(captured.scope);
        if (request === hostDiffRequest && generation === hostGitRequest && api.isConnected && currentNetworkScope()?.key === captured.key) set({ hostGit: { ...get().hostGit, combined: { status: 'ready', value } } });
      } else {
        const value = await api.readGitDiff(captured.scope, path);
        if (value.path !== path) throw new Error('Diff path changed.');
        if (request === hostDiffRequest && generation === hostGitRequest && api.isConnected && currentNetworkScope()?.key === captured.key) set({ hostGit: { ...get().hostGit, diff: { status: 'ready', value } } });
      }
    } catch { if (request === hostDiffRequest && generation === hostGitRequest && currentNetworkScope()?.key === captured.key) set({ hostGit: { ...get().hostGit,
      ...(path === null ? { combined: { status: 'error' } as const } : { diff: { status: 'error' } as const }) } }); }
  },
  readNetworkCommit: async (api, hash) => {
    const captured = currentNetworkScope();
    if (!captured || !api.isConnected || !api.supports('git.read') || get().hostGit.scopeKey !== captured.key) return;
    const request = ++hostCommitRequest;
    const generation = hostGitRequest;
    set({ hostGit: { ...get().hostGit, commit: { status: 'loading' } } });
    try {
      const value = await api.readGitCommitDetails(captured.scope, hash);
      if (value.hash !== hash) throw new Error('Commit identity changed.');
      if (request === hostCommitRequest && generation === hostGitRequest && api.isConnected && currentNetworkScope()?.key === captured.key) set({ hostGit: { ...get().hostGit, commit: { status: 'ready', value } } });
    } catch { if (request === hostCommitRequest && generation === hostGitRequest && currentNetworkScope()?.key === captured.key) set({ hostGit: { ...get().hostGit, commit: { status: 'error' } } }); }
  },
  markNetworkReviewed: (path) => {
    const git = get().hostGit;
    if (git.scopeKey !== currentNetworkScope()?.key || git.diff.status !== 'ready' || git.diff.value.path !== path || git.diff.value.state !== 'text') return;
    const reviewedPaths = new Set(git.reviewedPaths);
    if (reviewedPaths.has(path)) reviewedPaths.delete(path); else reviewedPaths.add(path);
    set({ hostGit: { ...git, reviewedPaths } });
  },
  hostFiles: emptyHostFiles(),
  resetHostFiles: () => { hostFilesGeneration++; hostPreviewRequest++; set({ hostFiles: emptyHostFiles() }); },
  initializeHostFiles: async (api) => {
    get().resetHostFiles();
    const captured = confirmedHostFileScope();
    if (!captured || !api.isConnected || !api.supports('file.read')) return;
    const generation = hostFilesGeneration;
    const current = () => generation === hostFilesGeneration && api.isConnected && confirmedHostFileScope()?.key === captured.key;
    set({ hostFiles: { ...emptyHostFiles(), scopeKey: captured.key, loading: new Set(['root']) } });
    try {
      const listing = await api.listFiles(captured.scope, null);
      if (current()) set({ hostFiles: { ...get().hostFiles, directories: { root: listing }, loading: new Set() } });
    } catch {
      if (current()) set({ hostFiles: { ...get().hostFiles, loading: new Set(), error: 'Host files unavailable. Refresh this workspace.' } });
    }
  },
  activateHostFile: async (api, row) => {
    const captured = confirmedHostFileScope();
    if (row.reference.kind !== 'host-resource' || !captured || !api.isConnected || !api.supports('file.read')
      || get().hostFiles.scopeKey !== captured.key) return;
    const id = row.reference.resourceId;
    // Only entries already issued by this host may be activated.
    if (!Object.values(get().hostFiles.directories).some((listing) => listing.entries.some((entry) => entry.resourceId === id && entry.kind === row.kind))) return;
    const generation = hostFilesGeneration;
    const current = () => generation === hostFilesGeneration && api.isConnected && confirmedHostFileScope()?.key === captured.key;
    if (row.kind === 'directory') {
      const expanded = new Set(get().hostFiles.expanded);
      if (expanded.has(id)) { expanded.delete(id); set({ hostFiles: { ...get().hostFiles, expanded } }); return; }
      expanded.add(id);
      set({ hostFiles: { ...get().hostFiles, expanded } });
      if (get().hostFiles.directories[id] || get().hostFiles.loading.has(id)) return;
      if (Object.keys(get().hostFiles.directories).length + get().hostFiles.loading.size >= MAX_HOST_FILE_DIRECTORIES) {
        set({ hostFiles: { ...get().hostFiles, error: 'File view reached its 64-directory limit. Refresh the workspace to read other directories.' } });
        return;
      }
      set({ hostFiles: { ...get().hostFiles, loading: new Set([...get().hostFiles.loading, id]), error: null } });
      try {
        const listing = await api.listFiles(captured.scope, id);
        if (current()) set({ hostFiles: { ...get().hostFiles, directories: { ...get().hostFiles.directories, [id]: listing } } });
      } catch {
        if (current()) set({ hostFiles: { ...get().hostFiles, error: 'Directory unavailable. Refresh this workspace.' } });
      } finally {
        if (current()) { const loading = new Set(get().hostFiles.loading); loading.delete(id); set({ hostFiles: { ...get().hostFiles, loading } }); }
      }
      return;
    }
    const request = ++hostPreviewRequest;
    set({ hostFiles: { ...get().hostFiles, selected: id, preview: null, previewLoading: true, error: null } });
    try {
      const preview = await api.previewText(captured.scope, id);
      if (current() && request === hostPreviewRequest && preview.fileId === id) set({ hostFiles: { ...get().hostFiles, preview, previewLoading: false } });
    } catch {
      if (current() && request === hostPreviewRequest) set({ hostFiles: { ...get().hostFiles, previewLoading: false, error: 'Text preview unavailable. Refresh this workspace.' } });
    }
  },
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
    if (!projectPath || !surface || !getFateApiOptional()) return;
    const desktop = getFateApi();
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
      const listing = await getFateApi().listFiles(directoryPath);
      if (get().projectPath !== expected) return;
      const nextLoading = new Set(get().loadingDirectories);
      nextLoading.delete(directoryPath);
      const treeTruncated = new Set(get().treeTruncated);
      if (listing.truncated) treeTruncated.add(directoryPath);
      set({ directories: { ...get().directories, [directoryPath]: listing.entries }, loadingDirectories: nextLoading, treeTruncated });
    } catch (error) {
      if (get().projectPath !== expected) return;
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
      if (get().projectPath && Boolean(getFateApiOptional()) && typeof getFateApi().searchFiles === 'function') void getFateApi().searchFiles('').catch(() => undefined);
      return;
    }
    const expectedProject = get().projectPath;
    set({ searching: true });
    try {
      const result = await getFateApi().searchFiles(trimmed);
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
      const preview = await getFateApi().readFile(path);
      if (get().projectPath === expectedProject && get().selectedFile === path) set({ preview, previewLoading: false });
    } catch (error) {
      if (get().projectPath === expectedProject && get().selectedFile === path) set({ previewLoading: false, error: messageOf(error) });
    }
  },

  openSelectedFile: async () => {
    const selected = get().selectedFile;
    if (selected) await get().openPath(selected);
  },

  openPath: async (path) => {
    if (!hasCapability('localFileOpen')) { set({ error: 'This file is on the host. Open it in the host file view, not on this computer.' }); return; }
    try {
      const result = await getDesktopApi().openFile(path);
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
      const git = await getFateApi().getGitStatus();
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
      const worktrees = await getFateApi().listGitWorktrees();
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
      const history = await getFateApi().getGitHistory();
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
      const details = await getFateApi().getGitCommitDetails(hash);
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
      const combinedDiff = await getFateApi().getGitCombinedDiff();
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
      const result = await getFateApi().runGitOperation(operation);
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

  revertPath: async (path) => {
    const expectedProject = get().projectPath;
    if (!expectedProject) throw new Error('Open a project before reverting a change.');
    if (!getFateApiOptional() || typeof getFateApi().revertGitPath !== 'function') {
      throw new Error('Path revert is unavailable.');
    }
    const generation = gitGeneration;
    set({ error: null });
    const result = await getFateApi().revertGitPath(path);
    if (!isCurrentGitGeneration(expectedProject, generation)) return;
    gitGeneration += 1;
    const reviewedPaths = new Set(get().reviewedPaths);
    reviewedPaths.delete(path);
    const stillSelected = result.status.changes.some((change) => change.path === get().selectedChange);
    set({
      git: result.status,
      reviewedPaths,
      selectedChange: stillSelected ? get().selectedChange : null,
      diff: stillSelected ? get().diff : null,
      reviewNotice: `${path} restored to HEAD or removed if it was untracked.`,
    });
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
      const diff = await getFateApi().getGitDiff(path);
      if (isCurrentGitGeneration(expectedProject, generation) && requestSequence === fileDiffRequestSequence && get().selectedChange === path) set({ diff, diffLoading: false });
    } catch (error) {
      if (isCurrentGitGeneration(expectedProject, generation) && requestSequence === fileDiffRequestSequence && get().selectedChange === path) set({ diffLoading: false, error: messageOf(error) });
    }
  },
}));
