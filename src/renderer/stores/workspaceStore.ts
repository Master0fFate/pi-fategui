import { create } from 'zustand';
import type { FileEntry, FilePreview, GitDiff, GitStatus } from '../../shared/contracts/ipc';

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
  selectedChange: string | null;
  diff: GitDiff | null;
  diffLoading: boolean;
  error: string | null;
  initialize: (projectPath: string | null) => Promise<void>;
  toggleDirectory: (path: string) => Promise<void>;
  setQuery: (query: string) => void;
  search: (query: string) => Promise<void>;
  selectFile: (path: string) => Promise<void>;
  openSelectedFile: () => Promise<void>;
  openPath: (path: string) => Promise<void>;
  refreshGit: () => Promise<void>;
  selectChange: (path: string) => Promise<void>;
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
  selectedChange: null,
  diff: null,
  diffLoading: false,
  error: null,

  initialize: async (projectPath) => {
    if (get().projectPath === projectPath) return;
    set({
      projectPath, directories: {}, expanded: new Set(), loadingDirectories: new Set(), treeTruncated: new Set(),
      query: '', searchResults: [], searchTruncated: false, searching: false, selectedFile: null, preview: null,
      previewLoading: false, git: null, gitLoading: Boolean(projectPath), selectedChange: null, diff: null,
      diffLoading: false, error: null,
    });
    if (!projectPath || !('piDesktop' in window)) return;
    const desktop = window.piDesktop;
    // Keeps startup resilient across a preload/main version mismatch while a rebuild is in progress.
    if (typeof desktop.listFiles !== 'function' || typeof desktop.getGitStatus !== 'function') return;
    const expected = projectPath;
    const [listingResult, gitResult] = await Promise.allSettled([desktop.listFiles(''), desktop.getGitStatus()]);
    if (get().projectPath !== expected) return;
    const next: Partial<WorkspaceStore> = { gitLoading: false };
    if (listingResult.status === 'fulfilled') {
      next.directories = { '': listingResult.value.entries };
      next.treeTruncated = listingResult.value.truncated ? new Set(['']) : new Set();
    } else next.error = messageOf(listingResult.reason);
    if (gitResult.status === 'fulfilled') next.git = gitResult.value;
    else next.error = messageOf(gitResult.reason);
    set(next);
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
    const trimmed = query.trim();
    if (!trimmed) { set({ searchResults: [], searchTruncated: false, searching: false }); return; }
    const expectedProject = get().projectPath;
    set({ searching: true });
    try {
      const result = await window.piDesktop.searchFiles(trimmed);
      if (get().projectPath !== expectedProject || get().query.trim() !== trimmed) return;
      set({ searchResults: result.entries, searchTruncated: result.truncated, searching: false });
    } catch (error) {
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
    set({ gitLoading: true, error: null });
    try {
      const git = await window.piDesktop.getGitStatus();
      if (get().projectPath === expectedProject) set({ git, gitLoading: false });
    } catch (error) {
      set({ gitLoading: false, error: messageOf(error) });
    }
  },

  selectChange: async (path) => {
    const expectedProject = get().projectPath;
    set({ selectedChange: path, diff: null, diffLoading: true, error: null });
    try {
      const diff = await window.piDesktop.getGitDiff(path);
      if (get().projectPath === expectedProject && get().selectedChange === path) set({ diff, diffLoading: false });
    } catch (error) {
      if (get().selectedChange === path) set({ diffLoading: false, error: messageOf(error) });
    }
  },
}));
