import * as Dialog from '@radix-ui/react-dialog';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppCommand, PiDesktopApi, PiEvent, RuntimeState } from '../../shared/contracts/ipc';
import type { BrowserState } from '../../shared/contracts/browser';
import { clearComposerSessionDrafts } from '../features/chat/Composer';
import { AssistantMarkdown, ConversationImageViewerProvider } from '../features/chat/RichMessageContent';
import { useBrowserStore } from '../stores/browserStore';
import { useRuntimeStore } from '../stores/runtimeStore';
import { useProjectStore } from '../stores/projectStore';
import { useGoalMaxStore } from '../stores/goalMaxStore';
import { LEFT_MAX, LEFT_MIN, RIGHT_MAX, RIGHT_MIN, useUiStore } from '../stores/uiStore';
import { App, hasBlockingBrowserOverlay, reconcileHydrationEvents } from './App';
import { hasCapability, installFateApi, resetFateApi } from '../platform/api';
import type { FateApi } from '../../client/FateApi';
import { desktopHostCapabilities, type ClientCapabilities } from '../../shared/protocol/capabilities';
import type { RendererFateApi } from '../platform/api';

describe('browser overlay ownership', () => {
  it('blocks only modal surfaces, not inline browser confirmations or popovers', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div role="dialog">Popover</div><div class="browser-workspace"><div role="alertdialog" aria-modal="true">Browser confirmation</div></div><div role="dialog" aria-modal="true" data-state="closed">Closed modal</div>';
    expect(hasBlockingBrowserOverlay(root)).toBe(false);

    root.insertAdjacentHTML('beforeend', '<div role="dialog" aria-modal="true" data-state="open">Image viewer</div>');
    expect(hasBlockingBrowserOverlay(root)).toBe(true);
  });

  it('detects the real cinematic image portal rather than assuming Radix emits aria-modal', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ConversationImageViewerProvider>
        <AssistantMarkdown text="" images={[{ data: 'iVBORw0KGgo=', mimeType: 'image/png', alt: 'Preview' }]} />
      </ConversationImageViewerProvider>,
    );
    expect(hasBlockingBrowserOverlay()).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Expand image: Preview' }));
    const dialog = screen.getByRole('dialog', { name: 'Preview' });
    expect(container).not.toContainElement(dialog);
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(hasBlockingBrowserOverlay()).toBe(true);
    expect(screen.getByRole('button', { name: 'Close image viewer' })).toHaveFocus();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Preview' })).not.toBeInTheDocument();
    expect(hasBlockingBrowserOverlay()).toBe(false);
  });
});

describe('first-launch shell', () => {
  beforeEach(() => {
    localStorage.clear();
    clearComposerSessionDrafts();
    delete document.documentElement.dataset.platform;
    delete document.documentElement.dataset.performanceMode;
    delete document.documentElement.dataset.reduceMotion;
    delete document.documentElement.dataset.holyShitMode;
    useUiStore.setState({
      sidebarCollapsed: false, sidebarTab: 'sessions', inspectorCollapsed: false, leftWidth: 264, rightWidth: 332,
      inspectorTab: 'changes', inspectorLastViews: { work: 'changes', run: 'goal', system: 'context' }, selectedAgent: null,
      terminalOpen: false, browserOpen: false, musicPlayerEnabled: false, musicPlaying: false, sendMessageWithModifier: false,
      paletteOpen: false, settingsOpen: false, toast: null, composerDraftRequest: null, goalEditorOpen: false,
    });
    useGoalMaxStore.setState({ projectPath: null, sessionId: null, goal: null, loading: false, selectionGeneration: 0 });
    useRuntimeStore.getState().setRuntime({
      status: 'disconnected', project: null, sessionId: null, sessionFile: null, streaming: false,
      model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null,
    });
  });

  afterEach(() => {
    resetFateApi();
    Reflect.deleteProperty(window, 'piDesktop');
  });

  it('hydrates once through an injected API without a preload bridge and cleans its event sink', async () => {
    const runtime: RuntimeState = {
      status: 'disconnected', project: null, sessionId: null, sessionFile: null, streaming: false,
      model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null,
    };
    const cleanup = vi.fn();
    const onEvents = vi.fn(() => cleanup);
    const getRuntimeState = vi.fn(async () => runtime);
    const dispose = installFateApi({ onEvents, getRuntimeState } as unknown as FateApi);
    expect(hasCapability('nativeBrowser')).toBe(false);
    expect(hasCapability('microphone')).toBe(false);
    expect(hasCapability('hotkeys')).toBe(false);
    expect(hasCapability('updater')).toBe(false);
    expect(hasCapability('ambientAudio')).toBe(false);
    expect(hasCapability('manualTerminal')).toBe(false);
    expect(hasCapability('monitor')).toBe(true);
    const mounted = render(<App />);
    await waitFor(() => expect(getRuntimeState).toHaveBeenCalledTimes(1));
    expect(onEvents).toHaveBeenCalledTimes(1);
    expect('piDesktop' in window).toBe(false);
    mounted.unmount();
    expect(cleanup).toHaveBeenCalledTimes(1);
    dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('renders honest first-launch navigation and inspector tabs', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Start with your AI connection' })).toBeInTheDocument();
    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Inspector destinations' })).toBeInTheDocument();
    expect(['Work', 'Run', 'System'].map((name) => screen.getByRole('button', { name }).textContent)).toEqual(['Work', 'Run', 'System']);
    expect(within(screen.getByRole('tablist', { name: 'Sidebar destinations' })).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Sessions', 'Agents', 'Resources']);
    expect(within(screen.getByRole('tablist', { name: 'Work views' })).getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'))).toEqual(['Changes', 'Files']);
    expect(screen.getByRole('button', { name: 'Model and reasoning settings' })).toBeDisabled();
  });

  it('does not initialize optional local services for a client without native capabilities', async () => {
    const runtime: RuntimeState = {
      status: 'ready', project: { path: 'C:/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: null,
      streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null,
    };
    const native = {
      initializeBrowser: vi.fn(), onBrowserEvents: vi.fn(), onBrowserLinkOpen: vi.fn(),
      onVoiceHotkey: vi.fn(), onSpeechStreamUpdate: vi.fn(), getSpeechStatus: vi.fn(),
      onSpeechDownload: vi.fn(), createTerminal: vi.fn(), onTerminalEvent: vi.fn(), checkForUpdates: vi.fn(), onUpdatesProgress: vi.fn(),
    };
    const client: ClientCapabilities = { version: 1, supported: {
      monitor: false, nativeBrowser: false, microphone: false, hotkeys: false, updater: false, ambientAudio: false,
      manualTerminal: false, localFileOpen: false, clipboardText: true,
    } };
    const dispose = installFateApi({
      getRuntimeState: vi.fn(async () => runtime), onEvents: vi.fn(() => () => undefined), desktop: native,
    } as unknown as RendererFateApi, desktopHostCapabilities, client);
    useRuntimeStore.getState().setRuntime(runtime);
    useUiStore.getState().setBrowserOpen(true);
    useUiStore.getState().setTerminalOpen(true);
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Native features unavailable/)).toBeInTheDocument());
    for (const spy of Object.values(native)) expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Built-in browser')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Manual integrated terminal')).not.toBeInTheDocument();
    dispose();
  });

  it('does not start the built-in browser until the workspace is opened', async () => {
    const runtime: RuntimeState = {
      status: 'ready', project: { path: 'C:/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: null,
      streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null,
    };
    const initializeBrowser = vi.fn(async () => {
      throw new Error('The built-in browser should not start until it is opened.');
    });
    const setBrowserOverlayBlocked = vi.fn(async () => {
      throw new Error('Browser overlay should not start the built-in browser.');
    });
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getRuntimeState: vi.fn(async () => runtime), onEvents: vi.fn(() => () => undefined),
        initializeBrowser, setBrowserOverlayBlocked,
      } as unknown as PiDesktopApi,
    });
    useRuntimeStore.getState().setRuntime(runtime);
    render(<App />);
    await act(async () => { await Promise.resolve(); });
    expect(initializeBrowser).not.toHaveBeenCalled();
    expect(setBrowserOverlayBlocked).not.toHaveBeenCalled();
    expect(useUiStore.getState().browserOpen).toBe(false);
  });

  it('blocks the browser for real image portals until the last modal closes', async () => {
    const runtime: RuntimeState = {
      status: 'ready', project: { path: 'C:/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: null,
      streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null,
    };
    const browserState: BrowserState = {
      activeTabId: 'browser-main', visible: true, viewBlocked: false, sessionFullAccess: true, controlLevel: 'interact', mode: 'annotate', deviceEmulation: null,
      tabs: [{ id: 'browser-main', profileId: 'project', url: 'http://localhost:4173/', title: 'Preview', loading: false, canGoBack: false, canGoForward: false, documentEpoch: 1, semanticAvailable: true }], grants: [],
    };
    const setBrowserOverlayBlocked = vi.fn(async (blocked: boolean) => ({ ...browserState, visible: !blocked, viewBlocked: blocked }));
    const setBrowserMode = vi.fn(async () => browserState);
    const setBrowserControlLevel = vi.fn(async () => browserState);
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getRuntimeState: vi.fn(async () => runtime), onEvents: vi.fn(() => () => undefined),
        initializeBrowser: vi.fn(async () => browserState), setBrowserOverlayBlocked, setBrowserMode, setBrowserControlLevel,
      } as unknown as PiDesktopApi,
    });
    useRuntimeStore.getState().setRuntime(runtime);
    useBrowserStore.getState().reset();
    useUiStore.getState().setBrowserOpen(true);
    const user = userEvent.setup();
    render(<><App /><ConversationImageViewerProvider>
      <AssistantMarkdown text="" images={[{ data: 'iVBORw0KGgo=', mimeType: 'image/png', alt: 'Preview' }]} />
    </ConversationImageViewerProvider></>);
    await waitFor(() => expect(setBrowserOverlayBlocked).toHaveBeenLastCalledWith(false));

    for (const dismissal of ['escape', 'backdrop', 'close'] as const) {
      await user.click(screen.getByRole('button', { name: 'Expand image: Preview' }));
      expect(screen.getByRole('dialog', { name: 'Preview' })).toHaveAttribute('aria-modal', 'true');
      await waitFor(() => expect(setBrowserOverlayBlocked).toHaveBeenLastCalledWith(true));
      expect(useUiStore.getState().browserOpen).toBe(true);
      expect(useBrowserStore.getState().state).toMatchObject({ viewBlocked: true, mode: 'annotate', controlLevel: 'interact', sessionFullAccess: true });

      if (dismissal === 'escape') await user.keyboard('{Escape}');
      else if (dismissal === 'backdrop') await user.click(document.querySelector<HTMLElement>('.cinematic-image-overlay')!);
      else await user.click(screen.getByRole('button', { name: 'Close image viewer' }));
      await waitFor(() => expect(setBrowserOverlayBlocked).toHaveBeenLastCalledWith(false));
      expect(screen.queryByRole('dialog', { name: 'Preview' })).not.toBeInTheDocument();
      expect(useUiStore.getState().browserOpen).toBe(true);
    }

    // The local viewer can also sit inside another modal. Closing only the
    // image must not release the native view from beneath its parent dialog.
    render(<Dialog.Root defaultOpen><Dialog.Portal><Dialog.Overlay />
      <Dialog.Content aria-modal="true" aria-describedby={undefined}>
        <Dialog.Title>Outer dialog</Dialog.Title>
        <AssistantMarkdown text="" images={[{ data: 'iVBORw0KGgo=', mimeType: 'image/png', alt: 'Nested preview' }]} />
        <Dialog.Close>Close outer dialog</Dialog.Close>
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root>);
    await waitFor(() => expect(setBrowserOverlayBlocked).toHaveBeenLastCalledWith(true));
    setBrowserOverlayBlocked.mockClear();
    await user.click(screen.getByRole('button', { name: 'Expand image: Nested preview' }));
    expect(screen.getByRole('dialog', { name: 'Nested preview' })).toHaveAttribute('aria-modal', 'true');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Outer dialog' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Nested preview' })).not.toBeInTheDocument();
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
    expect(setBrowserOverlayBlocked).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().state.viewBlocked).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Close outer dialog' }));
    await waitFor(() => expect(setBrowserOverlayBlocked).toHaveBeenLastCalledWith(false));
    expect(useBrowserStore.getState().state).toMatchObject({ visible: true, viewBlocked: false, mode: 'annotate', controlLevel: 'interact', sessionFullAccess: true });
    expect(setBrowserMode).not.toHaveBeenCalled();
    expect(setBrowserControlLevel).not.toHaveBeenCalled();
  });

  it('opens a link in the Browser workspace when the native link menu requests it', async () => {
    const runtime: RuntimeState = {
      status: 'ready', project: { path: 'C:/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: null,
      streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null,
    };
    const browserState = {
      activeTabId: 'browser-main', visible: false, viewBlocked: false, sessionFullAccess: false, controlLevel: 'off' as const, mode: 'agent' as const, deviceEmulation: null,
      tabs: [{ id: 'browser-main', profileId: 'project', url: 'http://localhost:4173/', title: 'Preview', loading: false, canGoBack: false, canGoForward: false, documentEpoch: 1, semanticAvailable: true }], grants: [],
    };
    let openLink: ((url: string) => void) | undefined;
    const navigateBrowser = vi.fn(async () => browserState);
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getRuntimeState: vi.fn(async () => runtime), onEvents: vi.fn(() => () => undefined), initializeBrowser: vi.fn(async () => browserState),
        onBrowserLinkOpen: vi.fn((listener: (url: string) => void) => { openLink = listener; return () => undefined; }), navigateBrowser,
      } as unknown as PiDesktopApi,
    });
    useRuntimeStore.getState().setRuntime(runtime);

    render(<App />);
    await waitFor(() => expect(openLink).toBeTypeOf('function'));
    act(() => openLink?.('localhost:4173'));

    await waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith('http://localhost:4173/'));
    expect(useUiStore.getState().browserOpen).toBe(true);
  });

  it('keeps project actions separate from provider connection on first launch', async () => {
    const user = userEvent.setup();
    const runtime = useRuntimeStore.getState().runtime;
    const selectProject = vi.fn(async () => runtime);
    const initializeProviderLogin = vi.fn(async () => ({
      ...runtime,
      providerLogin: {
        status: 'idle' as const, providerId: null, providerName: null, method: null, prompt: null, message: null, deviceCode: null,
        providers: [{ id: 'test', name: 'Test provider', methods: ['api_key'] as const, configured: false }],
      },
    }));
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getRuntimeState: vi.fn(async () => runtime),
        onEvents: vi.fn(() => () => undefined),
        selectProject,
        initializeProviderLogin,
      } as unknown as PiDesktopApi,
    });
    const { container } = render(<App />);

    const actionCards = [...container.querySelectorAll<HTMLButtonElement>('.action-card')];
    expect(actionCards.map((card) => card.textContent)).toEqual([
      expect.stringContaining('Connect your AI'),
      expect.stringContaining('Open project'),
      expect.stringContaining('Inspect codebase'),
      expect.stringContaining('Ship a change'),
    ]);
    await user.click(actionCards[0]!);
    await waitFor(() => expect(initializeProviderLogin).toHaveBeenCalledOnce());
    expect(selectProject).not.toHaveBeenCalled();
    // The dialog gates on the logo prefetch budget before mounting.
    expect(await screen.findByRole('dialog', { name: 'Connect a provider' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Connect a provider' })).not.toBeInTheDocument());
    for (const [index, card] of actionCards.slice(1).entries()) {
      await user.click(card);
      await waitFor(() => expect(selectProject).toHaveBeenCalledTimes(index + 1));
    }
    expect(container.querySelector('.brand-mark')).toHaveTextContent('ƒ');
    expect(container.querySelector('.welcome-symbol')).toHaveTextContent('ƒ');
  });

  it.each([
    ['Inspect codebase', 'Inspect this codebase.', 'Codebase inspection prompt ready.'],
    ['Ship a change', 'Help me ship a focused change', 'Change workflow prompt ready.'],
  ])('turns the %s first-launch choice into a reviewable workflow prompt', async (action, promptText, notice) => {
    const initial = useRuntimeStore.getState().runtime;
    const selected: RuntimeState = {
      status: 'ready', project: { path: 'C:/selected-project', name: 'selected-project', trusted: true }, sessionId: 's1', sessionFile: null,
      streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], sessions: [], error: null,
    };
    const selectProject = vi.fn(async () => selected);
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getRuntimeState: vi.fn(async () => initial),
        onEvents: vi.fn(() => () => undefined),
        selectProject,
      } as unknown as PiDesktopApi,
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: new RegExp(`^${action}`, 'u') }));

    await waitFor(() => expect(selectProject).toHaveBeenCalledOnce());
    await waitFor(() => expect((screen.getByLabelText('Message Pi') as HTMLTextAreaElement).value).toContain(promptText));
    expect(screen.getByText(new RegExp(notice, 'u'))).toBeInTheDocument();
    expect(useRuntimeStore.getState().runtime.messages).toEqual([]);
  });

  it('opens the session list immediately after project selection', async () => {
    const initial = useRuntimeStore.getState().runtime;
    const selected: RuntimeState = {
      status: 'ready', project: { path: 'C:/selected-project', name: 'selected-project', trusted: true }, sessionId: 's1', sessionFile: null,
      streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], sessions: [], error: null,
    };
    const selectProject = vi.fn(async () => selected);
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getRuntimeState: vi.fn(async () => initial),
        onEvents: vi.fn(() => () => undefined),
        selectProject,
      } as unknown as PiDesktopApi,
    });
    useUiStore.getState().setSidebarCollapsed(true);
    const user = userEvent.setup();
    const { container } = render(<App />);

    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
    await user.click(container.querySelectorAll<HTMLButtonElement>('.action-card')[1]!);

    await waitFor(() => expect(selectProject).toHaveBeenCalledOnce());
    await waitFor(() => expect(useUiStore.getState().sidebarCollapsed).toBe(false));
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument();
    expect(screen.getByLabelText('Message Pi')).toHaveValue('');
  });

  it('keeps app and command-palette new/model actions available while streaming', async () => {
    const current = { provider: 'test', id: 'current', name: 'Current Model', reasoning: true, contextWindow: 100_000 };
    const alternate = { provider: 'test', id: 'fast', name: 'Fast Model', reasoning: false, contextWindow: 200_000 };
    const runtime: RuntimeState = {
      status: 'ready', project: { path: 'C:/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: null,
      streaming: true, runningSessionCount: 1, model: current, pendingModel: null, models: [current, alternate], thinkingLevel: 'medium',
      messages: [], commands: [], sessions: [], sessionOperation: false, error: null,
    };
    useRuntimeStore.getState().setRuntime(runtime);
    const newSession = vi.fn(async () => runtime);
    const setModel = vi.fn(async () => ({ ...runtime, pendingModel: alternate }));
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getRuntimeState: vi.fn(async () => runtime),
        onEvents: vi.fn(() => () => undefined),
        newSession,
        setModel,
      } as unknown as PiDesktopApi,
    });
    const user = userEvent.setup();
    render(<App />);

    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    await waitFor(() => expect(newSession).toHaveBeenCalledOnce());

    act(() => useUiStore.getState().setPaletteOpen(true));
    // Long wait on purpose: the palette mounts in a portal and slow CI runners
    // can exceed the default 1 s findByRole timeout under load.
    const modelCommand = await screen.findByRole('option', { name: /Use model: Fast Model/u }, { timeout: 5_000 });
    expect(modelCommand).toBeEnabled();
    await user.click(modelCommand);
    await waitFor(() => expect(setModel).toHaveBeenCalledWith('test', 'fast'));

    act(() => useUiStore.getState().setPaletteOpen(true));
    const newCommand = await screen.findByRole('option', { name: /New session/u });
    expect(newCommand).toBeEnabled();
    await user.click(newCommand);
    await waitFor(() => expect(newSession).toHaveBeenCalledTimes(2));
  });

  it('explains unavailable native menu commands instead of silently doing nothing', async () => {
    let appCommand: ((command: AppCommand) => void) | undefined;
    const runtime = useRuntimeStore.getState().runtime;
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getRuntimeState: vi.fn(async () => runtime),
        onEvents: vi.fn(() => () => undefined),
        onAppCommand: vi.fn((listener: (command: AppCommand) => void) => { appCommand = listener; return () => undefined; }),
      } as unknown as PiDesktopApi,
    });
    render(<App />);
    await waitFor(() => expect(appCommand).toBeTypeOf('function'));

    act(() => appCommand?.('new-session'));
    expect(useUiStore.getState().toast).toMatchObject({ title: 'New session unavailable', message: 'Open a project before creating a session.' });

    act(() => appCommand?.('toggle-browser'));
    expect(useUiStore.getState()).toMatchObject({ browserOpen: false, toast: { title: 'Browser unavailable' } });

    act(() => appCommand?.('open-terminal'));
    expect(useUiStore.getState()).toMatchObject({ terminalOpen: false, toast: { title: 'Terminal unavailable' } });

    act(() => appCommand?.('focus-address'));
    expect(useUiStore.getState().toast).toMatchObject({ title: 'No input to focus' });

    act(() => appCommand?.('stop-generation'));
    expect(useUiStore.getState().toast).toMatchObject({ title: 'Nothing to stop' });
  });

  it('allows a native menu command to create the first session and reports operation failures', async () => {
    let appCommand: ((command: AppCommand) => void) | undefined;
    const runtime: RuntimeState = {
      status: 'ready', project: { path: 'C:/project', name: 'project', trusted: true }, sessionId: null, sessionFile: null,
      streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null,
    };
    useRuntimeStore.getState().setRuntime(runtime);
    const newSession = vi.fn(async () => { throw new Error(JSON.stringify({ message: 'Session storage is read-only.' })); });
    const abort = vi.fn(async () => undefined);
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getRuntimeState: vi.fn(async () => runtime),
        onEvents: vi.fn(() => () => undefined),
        onAppCommand: vi.fn((listener: (command: AppCommand) => void) => { appCommand = listener; return () => undefined; }),
        newSession,
        abort,
      } as unknown as PiDesktopApi,
    });
    render(<App />);
    await waitFor(() => expect(appCommand).toBeTypeOf('function'));

    act(() => appCommand?.('new-session'));
    await waitFor(() => expect(newSession).toHaveBeenCalledOnce());
    await waitFor(() => expect(useUiStore.getState().toast).toMatchObject({
      kind: 'error', title: 'Could not create session', message: 'Session storage is read-only.',
    }));

    act(() => useRuntimeStore.getState().setRuntime({ ...runtime, streaming: true }));
    act(() => appCommand?.('stop-generation'));
    await waitFor(() => expect(abort).toHaveBeenCalledOnce());
  });

  it('shows a questionnaire above the input and sends each answer with its exact question index', async () => {
    const first = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sessionId: 's1', index: 0, total: 2,
      question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }, { label: 'Other DB' }],
    };
    const runtime: RuntimeState = {
      status: 'ready', project: { path: 'C:/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: null,
      streaming: true, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null, questionnaire: first,
    };
    useRuntimeStore.getState().setRuntime(runtime);
    const answerQuestion = vi.fn(async () => runtime);
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: { getRuntimeState: vi.fn(async () => runtime), onEvents: vi.fn(() => () => undefined), answerQuestion } as unknown as PiDesktopApi,
    });
    const user = userEvent.setup();
    const { container } = render(<App />);
    expect(await screen.findByRole('heading', { name: 'Which database?' })).toBeInTheDocument();
    expect(container.querySelector('.composer-rails .question-card')).toBeInTheDocument();
    expect(screen.getByText('Question 1 / 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'SQLite' }));
    await waitFor(() => expect(answerQuestion).toHaveBeenCalledWith({ id: first.id, index: 0, answer: 'SQLite', source: 'option' }));

    const second = { ...first, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', index: 1, question: 'Which theme?' };
    act(() => useRuntimeStore.getState().setRuntime({ ...runtime, questionnaire: second }));
    expect(screen.getByText('Question 2 / 2')).toBeInTheDocument();
    const ownAnswer = screen.getByRole('textbox', { name: 'Write your own answer...' });
    await user.type(ownAnswer, '  My theme{Enter}');
    await waitFor(() => expect(answerQuestion).toHaveBeenLastCalledWith({ id: second.id, index: 1, answer: 'My theme', source: 'custom' }));
  });

  it('requires two Escape presses within three seconds to stop and keeps menu dismissal separate', async () => {
    const runtime: RuntimeState = {
      status: 'ready', project: { path: 'C:/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: null,
      streaming: true, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null,
    };
    useRuntimeStore.getState().setRuntime(runtime);
    const abort = vi.fn(async () => ({ aborted: true }));
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: { getRuntimeState: vi.fn(async () => runtime), onEvents: vi.fn(() => () => undefined), abort } as unknown as PiDesktopApi,
    });
    render(<App />);
    await waitFor(() => expect(useRuntimeStore.getState().runtime.sessionId).toBe('s1'));
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000);
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(abort).not.toHaveBeenCalled();
      expect(useUiStore.getState().toast?.title).toBe('Press Esc again to stop');
      now.mockReturnValue(4_001);
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(abort).not.toHaveBeenCalled();
      now.mockReturnValue(4_500);
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(abort).toHaveBeenCalledTimes(1));

      now.mockReturnValue(5_000);
      fireEvent.keyDown(window, { key: 'Escape' });
      const menu = document.createElement('div');
      menu.setAttribute('role', 'listbox');
      document.body.append(menu);
      fireEvent.keyDown(window, { key: 'Escape' });
      menu.remove();
      now.mockReturnValue(5_500);
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(abort).toHaveBeenCalledTimes(1);
      now.mockReturnValue(6_000);
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(abort).toHaveBeenCalledTimes(2));
    } finally {
      now.mockRestore();
    }
  });

  it('stops owned child work from the native stop-generation command', async () => {
    let appCommand: ((command: AppCommand) => void) | undefined;
    const runtime: RuntimeState = {
      status: 'ready', project: { path: 'C:/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: null,
      streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null,
      subagents: [{
        id: 'child-1', parentSessionId: 's1', parentToolCallId: 'delegate-1', task: 'Explore', role: 'explorer', handle: 'explorer-1',
        displayName: 'Explorer', agentName: 'direct', agentSource: 'direct', permissionLevel: 'read-only', enabledTools: ['read'],
        skills: [], skillMode: 'none', preloadedSkills: [], status: 'running',
        model: { provider: 'test', id: 'model', name: 'Model', reasoning: true, contextWindow: 100_000 }, routingModels: [], thinkingLevel: 'medium',
        executionMode: 'managed', controlCount: 0, attempt: 1, maxAttempts: 1, mailbox: { state: 'closed', ttlMs: 300_000, followUpCount: 0 },
        notification: 'never', dependsOn: [], createdAt: 1, updatedAt: 2, messages: [], tools: [], omittedActivity: 0, transcriptTruncated: false,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      }],
    };
    useRuntimeStore.getState().setRuntime(runtime);
    const abort = vi.fn(async () => ({ aborted: true }));
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getRuntimeState: vi.fn(async () => runtime),
        onEvents: vi.fn(() => () => undefined),
        onAppCommand: vi.fn((listener: (command: AppCommand) => void) => { appCommand = listener; return () => undefined; }),
        abort,
      } as unknown as PiDesktopApi,
    });
    render(<App />);
    await waitFor(() => expect(appCommand).toBeTypeOf('function'));

    act(() => appCommand?.('stop-generation'));
    await waitFor(() => expect(abort).toHaveBeenCalledOnce());
    expect(useUiStore.getState().toast).toBeNull();
  });

  it('shows playback activity beside the title only while the sidebar is expanded', async () => {
    useUiStore.setState({ musicPlaying: true });
    const user = userEvent.setup();
    const { container } = render(<App />);
    expect(container.querySelector('.music-equalizer')).toBeInTheDocument();
    expect(container.querySelectorAll('.music-equalizer i')).toHaveLength(4);

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    await waitFor(() => expect(container.querySelector('.music-equalizer')).not.toBeInTheDocument());
  });

  it('restores persisted manual session ordering as the active sort mode', async () => {
    const runtime: RuntimeState = {
      status: 'ready', project: { path: 'C:/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: null,
      streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null,
      sessions: [
        { id: 's1', title: 'First', firstMessage: 'First', path: 'one.jsonl', createdAt: '2025-01-01T00:00:00.000Z', modifiedAt: '2025-01-01T00:00:00.000Z', messageCount: 1, active: true },
        { id: 's2', title: 'Second', firstMessage: 'Second', path: 'two.jsonl', createdAt: '2025-01-01T00:00:00.000Z', modifiedAt: '2025-01-02T00:00:00.000Z', messageCount: 1, active: false },
      ],
    };
    localStorage.setItem('fate-ui:session-order:C:/project', JSON.stringify(['s1', 's2']));
    useRuntimeStore.getState().setRuntime(runtime);
    render(<App />);

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Sort sessions' })).toHaveTextContent('Manual order'));
  });

  it('puts fork, isolated worktree, clone, compact, rename, and delete on each eligible session row without import chrome', async () => {
    const user = userEvent.setup();
    const sessions: NonNullable<RuntimeState['sessions']> = [
      { id: 's1', title: 'First', firstMessage: 'First prompt', path: 'one.jsonl', createdAt: '2025-01-01T00:00:00.000Z', modifiedAt: '2025-01-01T00:00:00.000Z', messageCount: 2, active: true },
      { id: 's2', title: 'Second', firstMessage: 'Second prompt', path: 'two.jsonl', createdAt: '2025-01-01T00:00:00.000Z', modifiedAt: '2025-01-02T00:00:00.000Z', messageCount: 2, active: false },
    ];
    const runtime: RuntimeState = {
      status: 'ready', project: { path: 'C:/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: 'one.jsonl',
      streaming: false, sessionOperation: false, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null,
      sessions, sessionCapabilities: { fork: true, clone: true, compact: true, import: true },
      forkPoints: [{ entryId: 'first-entry', text: 'First prompt' }],
    };
    const switched: RuntimeState = {
      ...runtime, sessionId: 's2', sessionFile: 'two.jsonl', sessions: sessions.map((session) => ({ ...session, active: session.id === 's2' })),
      forkPoints: [{ entryId: 'second-entry', text: 'Second prompt' }],
    };
    const forked = { ...switched, sessionId: 'forked' };
    const switchSession = vi.fn(async () => switched);
    const forkSession = vi.fn(async () => ({ state: forked, selectedText: 'Edit this fork prompt' }));
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: { getRuntimeState: vi.fn(async () => runtime), onEvents: vi.fn(() => () => undefined), switchSession, forkSession } as unknown as PiDesktopApi,
    });
    useRuntimeStore.getState().setRuntime(runtime);
    useProjectStore.setState({ projects: [{ path: 'C:/project', name: 'project' }], expandedByPath: { 'C:/project': true } });
    const { container } = render(<App />);

    expect(screen.getByRole('button', { name: 'Create an isolated Git worktree session from First' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clone First' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Compact First' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename First' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Second' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Import session/i })).not.toBeInTheDocument();
    expect(container.querySelector('.session-action-bar')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create new session from latest prompt in Second' }));
    await waitFor(() => expect(switchSession).toHaveBeenCalledWith('s2'));
    expect(forkSession).toHaveBeenCalledWith('second-entry');
    expect(screen.getByLabelText('Message Pi')).toHaveValue('Edit this fork prompt');
    expect(screen.getByText(/This new session branches from “Second”/u)).toBeInTheDocument();
  });

  it('opens an isolated worktree session with the selected prompt and exact branch feedback', async () => {
    const user = userEvent.setup();
    const runtime: RuntimeState = {
      status: 'ready', project: { path: 'C:/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: 'one.jsonl',
      streaming: false, sessionOperation: false, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null,
      sessions: [{ id: 's1', title: 'Repair Git', firstMessage: 'Repair Git workflow', path: 'one.jsonl', createdAt: '2025-01-01T00:00:00.000Z', modifiedAt: '2025-01-01T00:00:00.000Z', messageCount: 2, active: true }],
      sessionCapabilities: { fork: true, clone: true, compact: true, import: true },
      forkPoints: [{ entryId: 'entry-1', text: 'Repair Git workflow' }],
    };
    const isolated = { ...runtime, project: { path: 'C:/worktrees/repair-git', name: 'project', trusted: true }, sessionId: 'isolated', sessions: [] };
    const createWorktreeSession = vi.fn(async () => ({
      state: isolated,
      selectedText: 'Repair Git workflow',
      worktree: { path: 'C:/worktrees/repair-git', branch: 'fate/repair-git-workflow', head: 'a'.repeat(40), detached: false, bare: false, current: true },
    }));
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: { getRuntimeState: vi.fn(async () => runtime), onEvents: vi.fn(() => () => undefined), createWorktreeSession } as unknown as PiDesktopApi,
    });
    useRuntimeStore.getState().setRuntime(runtime);
    useProjectStore.setState({ projects: [{ path: 'C:/project', name: 'project' }], expandedByPath: { 'C:/project': true } });
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Create an isolated Git worktree session from Repair Git' }));
    await waitFor(() => expect(createWorktreeSession).toHaveBeenCalledWith('entry-1'));
    expect(screen.getByLabelText('Message Pi')).toHaveValue('Repair Git workflow');
    expect(screen.getByText(/Isolated worktree ready on fate\/repair-git-workflow/u)).toBeInTheDocument();
    expect(useUiStore.getState().toast).toMatchObject({ title: 'Isolated session ready', message: expect.stringContaining('fate/repair-git-workflow') });
  });

  it('collapses and restores both side panes', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Collapse inspector' }));
    expect(screen.queryByRole('complementary', { name: 'Project inspector' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open inspector' })).toBeInTheDocument();
  });

  it('resizes panes with keyboard-accessible separators', async () => {
    const user = userEvent.setup();
    render(<App />);
    const sidebarHandle = screen.getByRole('separator', { name: 'Resize sidebar' });
    expect(sidebarHandle).toHaveAttribute('aria-valuenow', '264');
    sidebarHandle.focus();
    await user.keyboard('{ArrowRight}');
    expect(sidebarHandle).toHaveAttribute('aria-valuenow', '276');
  });

  it('keeps pointer and keyboard resizing within pane limits while preserving the center minimum', async () => {
    const user = userEvent.setup();
    render(<App />);
    const shell = document.querySelector<HTMLElement>('.app-shell');
    expect(shell?.style.gridTemplateColumns).toContain('min(264px, 27vw) 6px minmax(min(340px, 40vw), 1fr) 6px min(332px, 31vw)');
    const pointer = (type: 'pointerdown' | 'pointermove' | 'pointerup', pointerId: number, clientX: number) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, { pointerId: { value: pointerId }, clientX: { value: clientX } });
      return event;
    };

    const sidebarHandle = screen.getByRole('separator', { name: 'Resize sidebar' });
    expect(sidebarHandle).toHaveAttribute('aria-valuenow', '264');
    expect(sidebarHandle).toHaveAttribute('aria-valuemin', String(LEFT_MIN));
    expect(sidebarHandle).toHaveAttribute('aria-valuemax', String(LEFT_MAX));
    fireEvent(sidebarHandle, pointer('pointerdown', 1, 100));
    fireEvent(sidebarHandle, pointer('pointermove', 1, 1_000));
    fireEvent(sidebarHandle, pointer('pointerup', 1, 1_000));
    expect(sidebarHandle).toHaveAttribute('aria-valuenow', String(LEFT_MAX));

    const inspectorHandle = screen.getByRole('separator', { name: 'Resize inspector' });
    expect(inspectorHandle).toHaveAttribute('aria-valuenow', '332');
    expect(inspectorHandle).toHaveAttribute('aria-valuemin', String(RIGHT_MIN));
    expect(inspectorHandle).toHaveAttribute('aria-valuemax', String(RIGHT_MAX));
    fireEvent(inspectorHandle, pointer('pointerdown', 2, 1_000));
    fireEvent(inspectorHandle, pointer('pointermove', 2, 0));
    fireEvent(inspectorHandle, pointer('pointerup', 2, 0));
    expect(inspectorHandle).toHaveAttribute('aria-valuenow', String(RIGHT_MAX));

    act(() => {
      useUiStore.getState().setLeftWidth(264);
      useUiStore.getState().setRightWidth(332);
    });
    sidebarHandle.focus();
    for (let index = 0; index < 20; index += 1) await user.keyboard('{ArrowRight}');
    expect(sidebarHandle).toHaveAttribute('aria-valuenow', String(LEFT_MAX));
    inspectorHandle.focus();
    for (let index = 0; index < 20; index += 1) await user.keyboard('{ArrowLeft}');
    expect(inspectorHandle).toHaveAttribute('aria-valuenow', String(RIGHT_MAX));

    expect(shell?.style.gridTemplateColumns).toContain(`min(${LEFT_MAX}px, 27vw) 6px minmax(min(340px, 40vw), 1fr) 6px min(${RIGHT_MAX}px, 31vw)`);
  });

  it('buffers live events until startup state hydration completes', async () => {
    let resolveState: ((state: RuntimeState) => void) | undefined;
    let listener: ((events: PiEvent[]) => void) | undefined;
    const statePromise = new Promise<RuntimeState>((resolve) => { resolveState = resolve; });
    const initial: RuntimeState = {
      status: 'ready', project: { path: '/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: null,
      streaming: true, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null,
    };
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getRuntimeState: vi.fn(() => statePromise),
        onEvents: vi.fn((next: (events: PiEvent[]) => void) => { listener = next; return () => undefined; }),
      } as unknown as PiDesktopApi,
    });

    render(<App />);
    act(() => listener?.([{ type: 'assistant.text', messageId: 'live', delta: 'not lost', timestamp: 1 }]));
    await act(async () => { resolveState?.(initial); await statePromise; });
    await waitFor(() => expect(useRuntimeStore.getState().messagesById.live?.text).toBe('not lost'));
  });

  it('replays only events newer than the hydration watermark', async () => {
    let resolveState: ((state: RuntimeState) => void) | undefined;
    let listener: ((events: PiEvent[]) => void) | undefined;
    const statePromise = new Promise<RuntimeState>((resolve) => { resolveState = resolve; });
    const initial: RuntimeState = {
      status: 'ready', project: { path: '/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: null,
      streaming: true, model: null, models: [], thinkingLevel: 'medium', eventCursor: 4,
      messages: [{ id: 'live', role: 'assistant', text: '', reasoning: 'already', timestamp: 1 }],
      tools: [{ id: 'tool-live', name: 'search', input: '{}', output: '', outputTruncated: false, status: 'running', startedAt: 1, updatedAt: 1 }],
      commands: [], error: null,
    };
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getRuntimeState: vi.fn(() => statePromise),
        onEvents: vi.fn((next: (events: PiEvent[]) => void) => { listener = next; return () => undefined; }),
      } as unknown as PiDesktopApi,
    });

    render(<App />);
    act(() => listener?.([
      { type: 'assistant.reasoning', messageId: 'live', delta: 'already', timestamp: 2, cursor: 4 },
      { type: 'tool.started', toolCallId: 'tool-live', name: 'search', input: '{}', timestamp: 2, cursor: 3 },
      { type: 'tool.updated', toolCallId: 'tool-live', output: 'partial result', timestamp: 2, cursor: 4 },
      { type: 'assistant.reasoning', messageId: 'live', delta: ' new', timestamp: 3, cursor: 5 },
    ]));
    await act(async () => { resolveState?.(initial); await statePromise; });
    await waitFor(() => expect(useRuntimeStore.getState().reasoningByMessageId.live).toBe('already new'));
    expect(useRuntimeStore.getState().toolsById['tool-live']?.output).toBe('partial result');
  });

  it('does not append stale pre-watermark deltas after an authoritative rewritten completion', () => {
    const runtime: RuntimeState = {
      status: 'ready', project: null, sessionId: 's1', sessionFile: null, streaming: false,
      model: null, models: [], thinkingLevel: 'medium', eventCursor: 3, error: null,
      messages: [{ id: 'answer', role: 'assistant', text: 'Final rewritten answer', timestamp: 1 }],
    };
    const replay = reconcileHydrationEvents(runtime, [
      { type: 'assistant.text', messageId: 'answer', delta: 'draft text', timestamp: 1, cursor: 1 },
      { type: 'message.completed', messageId: 'answer', role: 'assistant', text: 'Final rewritten answer', timestamp: 2, cursor: 2 },
    ]);
    expect(replay).toEqual([]);
  });

  it('stops buffering and remains recoverable when hydration fails', async () => {
    let rejectState: ((error: Error) => void) | undefined;
    let listener: ((events: PiEvent[]) => void) | undefined;
    const statePromise = new Promise<RuntimeState>((_resolve, reject) => { rejectState = reject; });
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getRuntimeState: vi.fn(() => statePromise),
        onEvents: vi.fn((next: (events: PiEvent[]) => void) => { listener = next; return () => undefined; }),
      } as unknown as PiDesktopApi,
    });

    render(<App />);
    await act(async () => { rejectState?.(new Error('hydrate failed')); await statePromise.catch(() => undefined); });
    expect(await screen.findByRole('alert')).toHaveTextContent('hydrate failed');
    act(() => listener?.([{ type: 'assistant.text', messageId: 'after-failure', delta: 'still bounded', timestamp: 2, cursor: 2 }]));
    expect(useRuntimeStore.getState().messagesById['after-failure']?.text).toBe('still bounded');
  });

  it('does not replay a failed hydration after its subscription has been disposed', async () => {
    let rejectState!: (error: Error) => void;
    let listener!: (events: PiEvent[]) => void;
    const statePromise = new Promise<RuntimeState>((_resolve, reject) => { rejectState = reject; });
    const unsubscribe = vi.fn();
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getRuntimeState: vi.fn(() => statePromise),
        onEvents: vi.fn((next: (events: PiEvent[]) => void) => { listener = next; return unsubscribe; }),
      } as unknown as PiDesktopApi,
    });
    const view = render(<App />);
    await act(async () => { await Promise.resolve(); });
    act(() => listener([{ type: 'assistant.text', messageId: 'stale', delta: 'old session', timestamp: 1 }]));
    view.unmount();
    await act(async () => { rejectState(new Error('late failure')); await statePromise.catch(() => undefined); });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(useRuntimeStore.getState().messagesById.stale).toBeUndefined();
  });

  it('flushes Holy sh*t completion and discards presentation across session switches and unmounts', async () => {
    let listener!: (events: PiEvent[]) => void;
    const initial = useRuntimeStore.getState().runtime;
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getRuntimeState: vi.fn(async () => initial),
        onEvents: vi.fn((next: (events: PiEvent[]) => void) => { listener = next; return () => undefined; }),
      } as unknown as PiDesktopApi,
    });
    const view = render(<App />);
    await act(async () => { await Promise.resolve(); });
    document.documentElement.dataset.holyShitMode = 'true';
    try {
      act(() => listener([{ type: 'assistant.text', messageId: 'live', delta: 'not lost', timestamp: 1, cursor: 1 }]));
      expect(useRuntimeStore.getState().messagesById.live).toBeUndefined();
      act(() => listener([{ type: 'run.completed', runId: 'run', aborted: false, timestamp: 2, cursor: 2 }]));
      expect(useRuntimeStore.getState().messagesById.live?.text).toBe('not lost');
      act(() => listener([{ type: 'assistant.text', messageId: 'old-session', delta: 'old', timestamp: 3, cursor: 3 }]));
      act(() => useRuntimeStore.getState().setRuntime({ ...initial, sessionId: 'other-session' }));
      act(() => listener([{ type: 'run.completed', runId: 'other-run', aborted: false, timestamp: 4, cursor: 4 }]));
      expect(useRuntimeStore.getState().messagesById['old-session']).toBeUndefined();
      act(() => listener([{ type: 'assistant.text', messageId: 'stale', delta: 'disposed', timestamp: 5, cursor: 5 }]));
      view.unmount();
      expect(useRuntimeStore.getState().messagesById.stale).toBeUndefined();
    } finally {
      delete document.documentElement.dataset.holyShitMode;
    }
  });

  it('applies platform information from the existing bridge', async () => {
    const runtime = useRuntimeStore.getState().runtime;
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getAppInfo: vi.fn(async () => ({ name: 'Fate UI', version: '0.1.0', platform: 'win32', packaged: false })),
        getRuntimeState: vi.fn(async () => runtime),
        onEvents: vi.fn(() => () => undefined),
      } as unknown as PiDesktopApi,
    });
    render(<App />);
    await waitFor(() => expect(document.documentElement.dataset.platform).toBe('win32'));
    expect(document.querySelector('.app-shell')).toHaveClass('app-shell--inspector-open');
  });

  it('keeps platform discovery failure non-fatal', async () => {
    const runtime = useRuntimeStore.getState().runtime;
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getAppInfo: vi.fn(async () => { throw new Error('bridge unavailable'); }),
        getRuntimeState: vi.fn(async () => runtime),
        onEvents: vi.fn(() => () => undefined),
      } as unknown as PiDesktopApi,
    });
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Model and reasoning settings' })).toBeDisabled());
    expect(document.documentElement.dataset.platform).toBeUndefined();
  });

  it('hides first-launch content once a project is open with an empty timeline', () => {
    useRuntimeStore.getState().setRuntime({
      status: 'ready', project: { path: 'C:/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: null,
      streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null,
    });
    const { container } = render(<App />);
    expect(screen.queryByRole('heading', { name: 'What would you like Pi to do?' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Inspect codebase/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Message Pi')).toBeInTheDocument();
    expect(container.querySelector('.welcome')).not.toHaveAttribute('aria-labelledby');
  });

  it('floats extension status at workspace level instead of adding composer weight', () => {
    useRuntimeStore.getState().setRuntime({
      status: 'ready', project: { path: 'C:/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: null,
      streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null,
      extensionUi: { statuses: [{ key: 'mcp', text: 'MCP: 0/13 servers' }], widgets: [], working: null, title: null },
    });
    const { container } = render(<App />);

    expect(container.querySelector('.workspace > .workspace-status-row > .extension-status-rail')).toHaveTextContent('MCP: 0/13 servers');
    expect(container.querySelector('.composer .extension-status-rail')).toBeNull();
  });

  it('reports reveal-project failures without reintroducing titlebar connection chrome', async () => {
    const user = userEvent.setup();
    const runtime: RuntimeState = {
      status: 'ready', project: { path: 'C:/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: null,
      streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null,
    };
    useRuntimeStore.getState().setRuntime(runtime);
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        getRuntimeState: vi.fn(async () => runtime),
        onEvents: vi.fn(() => () => undefined),
        revealProject: vi.fn(async () => { throw new Error('Open the project again, then retry.'); }),
      } as unknown as PiDesktopApi,
    });
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Show project in file browser' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Open the project again, then retry.');
    expect(screen.getByRole('button', { name: 'Model and reasoning settings' })).toBeInTheDocument();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });

  it('does not rely on renderer Node globals', () => {
    render(<App />);
    expect('require' in window).toBe(false);
    expect('piDesktop' in window).toBe(false);
  });

});
