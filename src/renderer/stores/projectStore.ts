import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface KnownProject {
  path: string;
  name: string;
}

export const PROJECT_STORE_VERSION = 'pi-desktop-projects-v1';
const MAX_KNOWN_PROJECTS = 200;

export interface ProjectStoreState {
  /** User-controlled project order. Focusing a project never reorders it. */
  projects: KnownProject[];
  /** Per-path expanded state for folder headers in the sidebar. */
  expandedByPath: Record<string, boolean>;
  addProject: (project: KnownProject) => void;
  forgetProject: (path: string) => void;
  reorderProjects: (paths: string[]) => void;
  setExpanded: (path: string, expanded: boolean) => void;
  toggleExpanded: (path: string) => void;
  clear: () => void;
}

/** Normalize separators and harmless trailing separators without pretending to canonicalize the filesystem. */
export function normalizeProjectPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let normalized = value.trim().replaceAll('\\', '/');
  if (!normalized) return null;
  normalized = normalized.replace(/\/{2,}/gu, (match, offset: number) => offset === 0 ? '//' : '/');
  if (normalized.length > 1 && normalized.endsWith('/') && !/^[A-Za-z]:\/$/u.test(normalized) && normalized !== '//') normalized = normalized.replace(/\/+$/u, '');
  return normalized;
}

/** Equality key for persisted project paths; Windows drive/UNC paths are case-insensitive. */
export function projectPathKey(value: string): string {
  const normalized = normalizeProjectPath(value) ?? '';
  return /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith('//') ? normalized.toLocaleLowerCase() : normalized;
}

function fallbackProjectName(path: string): string {
  const withoutTrailing = path.replace(/\/+$/u, '');
  return withoutTrailing.split('/').at(-1) || withoutTrailing || 'Project';
}

function sanitizeProjects(value: unknown): KnownProject[] {
  if (!Array.isArray(value)) return [];
  const result: KnownProject[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    const path = normalizeProjectPath(record.path);
    if (!path) continue;
    const key = projectPathKey(path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim().slice(0, 200) : fallbackProjectName(path);
    result.push({ path, name });
    if (result.length >= MAX_KNOWN_PROJECTS) break;
  }
  return result;
}

function sanitizeExpanded(value: unknown, projects: readonly KnownProject[]): Record<string, boolean> {
  if (!value || typeof value !== 'object') return {};
  const known = new Map(projects.map((project) => [projectPathKey(project.path), project.path]));
  const result: Record<string, boolean> = {};
  for (const [rawPath, expanded] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeProjectPath(rawPath);
    if (!normalized || typeof expanded !== 'boolean') continue;
    const storedPath = known.get(projectPathKey(normalized));
    if (storedPath) result[storedPath] = expanded;
  }
  return result;
}

export const useProjectStore = create<ProjectStoreState>()(
  persist(
    (set) => ({
      projects: [],
      expandedByPath: {},
      addProject: (project) => set((state) => {
        const path = normalizeProjectPath(project.path);
        if (!path) return state;
        const nextProject = { path, name: project.name.trim().slice(0, 200) || fallbackProjectName(path) };
        const key = projectPathKey(path);
        const existingIndex = state.projects.findIndex((candidate) => projectPathKey(candidate.path) === key);
        if (existingIndex < 0) return { projects: [nextProject, ...state.projects].slice(0, MAX_KNOWN_PROJECTS) };
        const projects = [...state.projects];
        projects[existingIndex] = nextProject;
        return { projects };
      }),
      forgetProject: (path) => set((state) => {
        const key = projectPathKey(path);
        return {
          projects: state.projects.filter((project) => projectPathKey(project.path) !== key),
          expandedByPath: Object.fromEntries(Object.entries(state.expandedByPath).filter(([storedPath]) => projectPathKey(storedPath) !== key)),
        };
      }),
      reorderProjects: (paths) => set((state) => {
        const byPath = new Map(state.projects.map((project) => [projectPathKey(project.path), project]));
        const next: KnownProject[] = [];
        const seen = new Set<string>();
        for (const path of paths) {
          const project = byPath.get(projectPathKey(path));
          if (project && !seen.has(projectPathKey(project.path))) {
            next.push(project);
            seen.add(projectPathKey(project.path));
          }
        }
        for (const project of state.projects) {
          if (!seen.has(projectPathKey(project.path))) next.push(project);
        }
        return { projects: next };
      }),
      setExpanded: (path, expanded) => set((state) => {
        const normalized = normalizeProjectPath(path);
        if (!normalized) return state;
        const key = projectPathKey(normalized);
        const expandedByPath = Object.fromEntries(Object.entries(state.expandedByPath).filter(([storedPath]) => projectPathKey(storedPath) !== key));
        return { expandedByPath: { ...expandedByPath, [normalized]: expanded } };
      }),
      toggleExpanded: (path) => set((state) => {
        const normalized = normalizeProjectPath(path);
        if (!normalized) return state;
        const key = projectPathKey(normalized);
        const stored = Object.entries(state.expandedByPath).find(([storedPath]) => projectPathKey(storedPath) === key);
        const expandedByPath = Object.fromEntries(Object.entries(state.expandedByPath).filter(([storedPath]) => projectPathKey(storedPath) !== key));
        return { expandedByPath: { ...expandedByPath, [normalized]: !(stored?.[1] ?? false) } };
      }),
      clear: () => set({ projects: [], expandedByPath: {} }),
    }),
    {
      name: PROJECT_STORE_VERSION,
      partialize: ({ projects, expandedByPath }) => ({ projects, expandedByPath }),
      merge: (persisted, current) => {
        const record = persisted && typeof persisted === 'object' ? persisted as Record<string, unknown> : {};
        const projects = sanitizeProjects(record.projects);
        return {
          ...current,
          projects,
          expandedByPath: sanitizeExpanded(record.expandedByPath, projects),
        };
      },
    },
  ),
);
