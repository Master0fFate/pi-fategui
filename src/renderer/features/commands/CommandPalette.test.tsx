import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiDesktopApi, RuntimeState } from '../../../shared/contracts/ipc';
import { useAutomationStore } from '../../stores/automationStore';
import { useBrowserStore } from '../../stores/browserStore';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { CommandPalette } from './CommandPalette';

const ready = (overrides: Partial<RuntimeState> = {}): RuntimeState => ({
  status: 'ready',
  project: { path: '/project', name: 'project', trusted: true },
  sessionId: 's1',
  sessionFile: '/sessions/s1.jsonl',
  streaming: false,
  model: null,
  models: [],
  thinkingLevel: 'medium',
  permissionLevel: 'edit',
  messages: [],
  commands: [{ name: 'review', description: 'Review current changes', source: 'prompt' }],
  sessions: [],
  error: null,
  ...overrides,
});

describe('CommandPalette resource search', () => {
  beforeEach(() => {
    useRuntimeStore.getState().setRuntime(ready());
    useUiStore.setState({ paletteOpen: true, sidebarCollapsed: false, sidebarTab: 'sessions', inspectorCollapsed: false, composerDraftRequest: null, automationOpenRequest: null, toast: null });
    useWorkspaceStore.setState({ projectPath: '/project', directories: {}, selectedFile: null, preview: null, error: null });
    useAutomationStore.getState().reset();
    useBrowserStore.getState().reset();
  });

  afterEach(() => Reflect.deleteProperty(window, 'piDesktop'));

  it('opens the approved left-sidebar destinations from commands', async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);

    await user.click(screen.getByRole('option', { name: 'Open resources' }));

    expect(useUiStore.getState()).toMatchObject({ paletteOpen: false, sidebarCollapsed: false, sidebarTab: 'resources' });
  });

  it('searches project files through the confined backend and opens their real preview', async () => {
    const searchFiles = vi.fn(async () => ({ entries: [{ path: 'src/App.tsx', name: 'App.tsx', kind: 'file' as const, symlink: false }], truncated: false }));
    const listFiles = vi.fn(async () => ({ path: '', entries: [], truncated: false }));
    const readFile = vi.fn(async () => ({ path: 'src/App.tsx', name: 'App.tsx', size: 12, state: 'text' as const, content: 'export {}', language: 'typescript', openable: true }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { searchFiles, listFiles, readFile } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<CommandPalette />);

    await user.type(screen.getByRole('textbox', { name: 'Search commands and resources' }), 'App');
    await waitFor(() => expect(searchFiles).toHaveBeenCalledWith('App', 40));
    await user.click(await screen.findByRole('option', { name: /App\.tsx/u }));

    await waitFor(() => expect(readFile).toHaveBeenCalledWith('src/App.tsx'));
    expect(useWorkspaceStore.getState().selectedFile).toBe('src/App.tsx');
    expect(useUiStore.getState()).toMatchObject({ paletteOpen: false, inspectorTab: 'files', inspectorCollapsed: false });
  });

  it('does not leave file results from the previous query actionable while the next search is pending', async () => {
    const searchFiles = vi.fn()
      .mockResolvedValueOnce({ entries: [{ path: 'src/old.ts', name: 'old.ts', kind: 'file' as const, symlink: false }], truncated: false })
      .mockImplementation(() => new Promise(() => undefined));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { searchFiles } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<CommandPalette />);
    const input = screen.getByRole('textbox', { name: 'Search commands and resources' });

    await user.type(input, 'old');
    expect(await screen.findByRole('option', { name: /old\.ts/u })).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, 'new');

    await waitFor(() => expect(searchFiles).toHaveBeenCalledWith('new', 40));
    await waitFor(() => expect(screen.queryByRole('option', { name: /old\.ts/u })).not.toBeInTheDocument());
  });

  it('does not expose directory matches as broken file actions', async () => {
    const searchFiles = vi.fn(async () => ({
      entries: [
        { path: 'src/target-folder', name: 'target-folder', kind: 'directory' as const, symlink: false },
        { path: 'src/target.ts', name: 'target.ts', kind: 'file' as const, symlink: false },
      ],
      truncated: false,
    }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { searchFiles } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<CommandPalette />);

    await user.type(screen.getByRole('textbox', { name: 'Search commands and resources' }), 'target');
    await waitFor(() => expect(searchFiles).toHaveBeenCalledWith('target', 40));

    expect(await screen.findByRole('option', { name: /target\.ts/u })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /target-folder/u })).not.toBeInTheDocument();
  });

  it('routes a specific automation result to an exact transient open request', async () => {
    const automation = {
      id: '00000000-0000-4000-8000-000000000001', projectPath: '/project', name: 'Review auth', prompt: 'Review authentication changes.',
      permissionLevel: 'read-only' as const, createdAt: 1, updatedAt: 1, lastLaunchedAt: null, lastLaunchOutcome: null, launchCount: 0,
    };
    useAutomationStore.setState({ projectPath: '/project', items: [automation], loading: false, error: null });
    const user = userEvent.setup();
    render(<CommandPalette />);

    await user.type(screen.getByRole('textbox', { name: 'Search commands and resources' }), 'Review auth');
    await user.click(await screen.findByRole('option', { name: /Review auth/u }));

    expect(useUiStore.getState()).toMatchObject({
      paletteOpen: false,
      sidebarCollapsed: false,
      sidebarTab: 'automations',
      automationOpenRequest: { projectPath: '/project', automationId: automation.id },
    });
  });

  it('disables contextual commands instead of closing on a no-op', async () => {
    useRuntimeStore.getState().setRuntime(ready({ status: 'disconnected', project: null, sessionId: null }));
    const user = userEvent.setup();
    render(<CommandPalette />);

    const focus = screen.getByRole('option', { name: 'Focus composer' });
    expect(focus).toBeDisabled();
    expect(focus).toHaveAttribute('title', 'Open and trust a project before focusing the composer.');

    const input = screen.getByRole('textbox', { name: 'Search commands and resources' });
    await user.type(input, 'Thinking level: high');
    const thinking = await screen.findByRole('option', { name: 'Thinking level: high' });
    expect(thinking).toBeDisabled();
    expect(useUiStore.getState().paletteOpen).toBe(true);
  });

  it('keeps model and reasoning staging available while streaming when the next model supports it', async () => {
    const current = { provider: 'test', id: 'reasoning', name: 'Reasoning', reasoning: true, contextWindow: 100_000 };
    const runtime = ready({ streaming: true, model: current, pendingModel: null, models: [current] });
    useRuntimeStore.getState().setRuntime(runtime);
    const setThinkingLevel = vi.fn(async () => ({ ...runtime, pendingThinkingLevel: 'high' as const }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { setThinkingLevel } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<CommandPalette />);

    await user.type(screen.getByRole('textbox', { name: 'Search commands and resources' }), 'Thinking level: high');
    const thinking = await screen.findByRole('option', { name: 'Thinking level: high' });
    expect(thinking).toBeEnabled();
    await user.click(thinking);

    await waitFor(() => expect(setThinkingLevel).toHaveBeenCalledWith('high'));
    expect(useRuntimeStore.getState().runtime.pendingThinkingLevel).toBe('high');
  });

  it('uses the pending model to disable invalid reasoning commands', async () => {
    const current = { provider: 'test', id: 'reasoning', name: 'Reasoning', reasoning: true, contextWindow: 100_000 };
    const next = { provider: 'test', id: 'plain', name: 'Plain', reasoning: false, contextWindow: 100_000 };
    useRuntimeStore.getState().setRuntime(ready({ streaming: true, model: current, pendingModel: next, models: [current, next] }));
    const user = userEvent.setup();
    render(<CommandPalette />);

    await user.type(screen.getByRole('textbox', { name: 'Search commands and resources' }), 'Thinking level: high');
    const thinking = await screen.findByRole('option', { name: 'Thinking level: high' });
    expect(thinking).toBeDisabled();
    expect(thinking).toHaveAttribute('title', 'The model selected for the next message does not support reasoning.');
  });

  it('surfaces command failures and still permits a connected project to create its first session', async () => {
    useRuntimeStore.getState().setRuntime(ready({ sessionId: null, sessionFile: null }));
    const newSession = vi.fn(async () => { throw new Error(JSON.stringify({ message: 'Session storage is read-only.' })); });
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { newSession } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<CommandPalette />);

    expect(screen.getByRole('option', { name: /New session/u })).toBeEnabled();
    expect(screen.getByRole('option', { name: 'Focus composer' })).toBeEnabled();
    await user.click(screen.getByRole('option', { name: /New session/u }));

    await waitFor(() => expect(useUiStore.getState().toast).toMatchObject({
      kind: 'error', title: 'New session failed', message: 'Session storage is read-only.',
    }));
  });

  it('inserts a Pi resource into the composer instead of sending or replacing it', async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);

    await user.type(screen.getByRole('textbox', { name: 'Search commands and resources' }), 'review');
    await user.click(await screen.findByRole('option', { name: /\/review/u }));

    expect(useUiStore.getState().composerDraftRequest).toMatchObject({ text: '/review ', mode: 'insert' });
    expect(useUiStore.getState().paletteOpen).toBe(false);
  });
});
