import { beforeEach, describe, expect, it } from 'vitest';
import { normalizeProjectPath, PROJECT_STORE_VERSION, projectPathKey, useProjectStore } from './projectStore';

describe('project store', () => {
  beforeEach(() => {
    localStorage.clear();
    useProjectStore.setState({ projects: [], expandedByPath: {} });
  });

  it('adds new projects to the front but never reorders an existing project when it is focused again', () => {
    useProjectStore.getState().addProject({ path: '/a', name: 'a' });
    useProjectStore.getState().addProject({ path: '/b', name: 'b' });
    useProjectStore.getState().addProject({ path: '/a', name: 'a-renamed' });

    const { projects } = useProjectStore.getState();
    expect(projects.map((project) => project.path)).toEqual(['/b', '/a']);
    expect(projects[1]).toMatchObject({ path: '/a', name: 'a-renamed' });
  });

  it('forgets a project without touching the others', () => {
    useProjectStore.getState().addProject({ path: '/a', name: 'a' });
    useProjectStore.getState().addProject({ path: '/b', name: 'b' });
    useProjectStore.getState().setExpanded('/b', true);

    useProjectStore.getState().forgetProject('/a');

    expect(useProjectStore.getState().projects.map((project) => project.path)).toEqual(['/b']);
    expect(useProjectStore.getState().expandedByPath['/a']).toBeUndefined();
    expect(useProjectStore.getState().expandedByPath['/b']).toBe(true);
  });

  it('reorders projects by a full new path order and preserves unmentioned ones', () => {
    useProjectStore.getState().addProject({ path: '/a', name: 'a' });
    useProjectStore.getState().addProject({ path: '/b', name: 'b' });
    useProjectStore.getState().addProject({ path: '/c', name: 'c' });

    useProjectStore.getState().reorderProjects(['/c', '/a']);

    expect(useProjectStore.getState().projects.map((project) => project.path)).toEqual(['/c', '/a', '/b']);
  });

  it('tracks per-folder expansion canonically and persists it', () => {
    useProjectStore.getState().addProject({ path: 'C:/Repo', name: 'Repo' });
    useProjectStore.getState().toggleExpanded('c:\\repo');
    expect(useProjectStore.getState().expandedByPath['c:/repo']).toBe(true);
    useProjectStore.getState().setExpanded('C:/Repo', false);
    expect(useProjectStore.getState().expandedByPath).toEqual({ 'C:/Repo': false });

    expect(JSON.parse(localStorage.getItem(PROJECT_STORE_VERSION) ?? '{}').state?.expandedByPath).toEqual({ 'C:/Repo': false });
  });

  it('normalizes path variants and rejects malformed persisted entries', async () => {
    expect(normalizeProjectPath(' C:\\Repo\\ ')).toBe('C:/Repo');
    expect(projectPathKey('C:\\Repo')).toBe(projectPathKey('c:/repo'));
    localStorage.setItem(PROJECT_STORE_VERSION, JSON.stringify({
      state: {
        projects: [{ path: 'C:\\Repo\\', name: '' }, { path: 'c:/repo', name: 'duplicate' }, { path: 42, name: 'bad' }],
        expandedByPath: { 'C:\\Repo\\': true, '/unknown': true },
      },
      version: 0,
    }));
    await useProjectStore.persist.rehydrate();
    expect(useProjectStore.getState().projects).toEqual([{ path: 'C:/Repo', name: 'Repo' }]);
    expect(useProjectStore.getState().expandedByPath).toEqual({ 'C:/Repo': true });
  });

  it('clears all known projects and expansion state', () => {
    useProjectStore.getState().addProject({ path: '/a', name: 'a' });
    useProjectStore.getState().setExpanded('/a', true);
    useProjectStore.getState().clear();
    expect(useProjectStore.getState().projects).toEqual([]);
    expect(useProjectStore.getState().expandedByPath).toEqual({});
  });
});
