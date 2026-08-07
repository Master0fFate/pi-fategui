import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationDefinition, PiDesktopApi } from '../../shared/contracts/ipc';
import { useAutomationStore } from './automationStore';

const automation = (id: string, projectPath = '/project'): AutomationDefinition => ({
  id,
  projectPath,
  name: `Automation ${id.slice(-1)}`,
  prompt: 'Review the current changes.',
  permissionLevel: 'read-only',
  createdAt: 1,
  updatedAt: 1,
  lastLaunchedAt: null,
  lastLaunchOutcome: null,
  launchCount: 0,
});

describe('automation store', () => {
  beforeEach(() => useAutomationStore.getState().reset());
  afterEach(() => Reflect.deleteProperty(window, 'piDesktop'));

  it('loads and mutates project-scoped definitions through the typed desktop bridge', async () => {
    const initial = automation('00000000-0000-4000-8000-000000000001');
    const created = { ...automation('00000000-0000-4000-8000-000000000002'), updatedAt: 2 };
    const updated = { ...created, name: 'Updated automation', updatedAt: 3 };
    const listAutomations = vi.fn(async () => [initial]);
    const createAutomation = vi.fn(async () => created);
    const updateAutomation = vi.fn(async () => updated);
    const deleteAutomation = vi.fn(async () => undefined);
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: { listAutomations, createAutomation, updateAutomation, deleteAutomation } as unknown as PiDesktopApi,
    });

    await act(() => useAutomationStore.getState().initialize('/project'));
    expect(useAutomationStore.getState().items).toEqual([initial]);

    await act(() => useAutomationStore.getState().create({ name: created.name, prompt: created.prompt, permissionLevel: 'read-only' }));
    expect(useAutomationStore.getState().items.map((item) => item.id)).toEqual([created.id, initial.id]);

    await act(() => useAutomationStore.getState().update({ id: created.id, name: updated.name, prompt: updated.prompt, permissionLevel: 'read-only' }));
    expect(useAutomationStore.getState().items[0]?.name).toBe('Updated automation');

    await act(() => useAutomationStore.getState().remove(created.id));
    expect(useAutomationStore.getState().items).toEqual([initial]);
    expect(deleteAutomation).toHaveBeenCalledWith(created.id);
  });

  it('ignores a stale list response after the active project changes', async () => {
    let resolveFirst: ((items: AutomationDefinition[]) => void) | undefined;
    const first = new Promise<AutomationDefinition[]>((resolve) => { resolveFirst = resolve; });
    const listAutomations = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce([automation('00000000-0000-4000-8000-000000000002', '/project-b')]);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { listAutomations } as unknown as PiDesktopApi });

    const firstLoad = useAutomationStore.getState().initialize('/project-a');
    await useAutomationStore.getState().initialize('/project-b');
    resolveFirst?.([automation('00000000-0000-4000-8000-000000000001', '/project-a')]);
    await firstLoad;

    expect(useAutomationStore.getState()).toMatchObject({ projectPath: '/project-b', loading: false });
    expect(useAutomationStore.getState().items.map((item) => item.projectPath)).toEqual(['/project-b']);
  });

  it('keeps launch telemetry best-effort and updates successful records', async () => {
    const initial = automation('00000000-0000-4000-8000-000000000001');
    const launched = { ...initial, updatedAt: 2, lastLaunchedAt: 2, lastLaunchOutcome: 'accepted' as const, launchCount: 1 };
    const recordAutomationLaunch = vi.fn(async () => launched);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { recordAutomationLaunch } as unknown as PiDesktopApi });
    useAutomationStore.setState({ projectPath: '/project', items: [initial] });

    await act(() => useAutomationStore.getState().recordLaunch(initial.id, 'accepted'));

    expect(useAutomationStore.getState().items[0]).toEqual(launched);
  });
});
