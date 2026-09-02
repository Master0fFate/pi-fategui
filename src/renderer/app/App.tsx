import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { defaultSpeechSettings, type AppCommand, type PiEvent, type RuntimeState } from '../../shared/contracts/ipc';
import { AppToast } from '../components/AppToast';
import { applyNonThemeVisualSettings, applyVisualSettings } from '../appearance';
import { useRuntimeStore } from '../stores/runtimeStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useUiStore } from '../stores/uiStore';
import { useGoalMaxStore } from '../stores/goalMaxStore';
import { useTaskStore } from '../stores/taskStore';
import { useBrowserStore } from '../stores/browserStore';
import { fallbackThemes } from '../theme';
import { attachBrowserAnnotationToSession } from '../features/chat/Composer';
import { openBrowserLink } from '../features/browser/browserLink';

const MAX_HYDRATION_BUFFER_EVENTS = 1_000;
const MAX_HYDRATION_BUFFER_BYTES = 32 * 1024 * 1024;

function appCommandErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  try {
    const parsed = JSON.parse(error.message) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message : error.message;
  } catch {
    return error.message || fallback;
  }
}

export function hasBlockingBrowserOverlay(root: ParentNode = document): boolean {
  return [...root.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')]
    .some((element) => element.dataset.state !== 'closed' && !element.closest('.browser-workspace'));
}

export function reconcileHydrationEvents(runtime: RuntimeState, events: readonly PiEvent[]): PiEvent[] {
  const watermark = runtime.eventCursor;
  if (watermark === undefined) return [...events];
  const messages = new Map(runtime.messages.map((message) => [message.id, message]));
  const tools = new Map((runtime.tools ?? []).map((tool) => [tool.id, tool]));
  const representedDeltaIndexes = new Set<number>();
  const completedMessageIds = new Set(events.flatMap((event) =>
    event.type === 'message.completed'
      && event.cursor !== undefined
      && event.cursor <= watermark
      && messages.has(event.messageId)
      ? [event.messageId]
      : [],
  ));

  for (const kind of ['assistant.text', 'assistant.reasoning'] as const) {
    const groups = new Map<string, Array<{ event: Extract<PiEvent, { type: typeof kind }>; index: number }>>();
    events.forEach((event, index) => {
      if (event.type !== kind || event.cursor === undefined || event.cursor > watermark) return;
      const group = groups.get(event.messageId) ?? [];
      group.push({ event, index });
      groups.set(event.messageId, group);
    });
    for (const [messageId, group] of groups) {
      if (completedMessageIds.has(messageId)) {
        for (const item of group) representedDeltaIndexes.add(item.index);
        continue;
      }
      const message = messages.get(messageId);
      const snapshot = kind === 'assistant.text' ? message?.text ?? '' : message?.reasoning ?? '';
      let combined = '';
      let representedCount = 0;
      group.forEach(({ event }, index) => {
        combined += event.delta;
        if (snapshot.endsWith(combined)) representedCount = index + 1;
      });
      for (let index = 0; index < representedCount; index += 1) representedDeltaIndexes.add(group[index]!.index);
    }
  }

  return events.filter((event, index) => {
    if (event.cursor === undefined || event.cursor > watermark) return true;
    if (representedDeltaIndexes.has(index)) return false;
    if (event.type === 'assistant.text' || event.type === 'assistant.reasoning') return true;
    if (event.type === 'message.started' || event.type === 'message.completed') return !messages.has(event.messageId);
    if (event.type === 'tool.started') return !tools.has(event.toolCallId);
    if (event.type === 'tool.updated') {
      const tool = tools.get(event.toolCallId);
      if (tool && tool.status !== 'running') return false;
      return !tool || (!tool.output.endsWith(event.output) && tool.output !== event.output);
    }
    if (event.type === 'tool.completed') return tools.get(event.toolCallId)?.status === 'running' || !tools.has(event.toolCallId);
    if (event.type === 'state.changed' || event.type === 'run.accepted' || event.type === 'run.started' || event.type === 'run.completed') return false;
    // Queue, compaction, and error events own renderer-only presentation state
    // that is not fully represented by RuntimeState.
    return true;
  }).map((event) => {
    if (event.cursor === undefined || event.cursor > watermark) return event;
    // The reconciliation above proved this pre-watermark event is not represented
    // by the authoritative snapshot. Replay that specific gap as uncursored so the
    // store's monotonic cursor gate can still reject every duplicate/regression.
    const { cursor: _representedCursor, ...reconciledGap } = event;
    return reconciledGap as PiEvent;
  });
}
const MusicPlayerDock = lazy(() => import('../features/music/MusicPlayerDock').then((module) => ({ default: module.MusicPlayerDock })));
const CommandPalette = lazy(() => import('../features/commands/CommandPalette').then((module) => ({ default: module.CommandPalette })));
const SettingsDialog = lazy(() => import('../features/settings/SettingsDialog').then((module) => ({ default: module.SettingsDialog })));
import { AppShell } from './AppShell';

function BrowserInitializer() {
  const projectPath = useRuntimeStore((state) => state.runtime.project?.path ?? null);
  const projectTrusted = useRuntimeStore((state) => state.runtime.project?.trusted ?? false);
  const browserOpen = useUiStore((state) => state.browserOpen);
  const hydrate = useBrowserStore((state) => state.hydrate);
  const applyEvents = useBrowserStore((state) => state.applyEvents);
  const setAnnotations = useBrowserStore((state) => state.setAnnotations);
  const reset = useBrowserStore((state) => state.reset);
  const setBrowserOpen = useUiStore((state) => state.setBrowserOpen);

  useEffect(() => {
    if (!('piDesktop' in window) || typeof window.piDesktop.onBrowserEvents !== 'function') return undefined;
    return window.piDesktop.onBrowserEvents((events) => {
      applyEvents(events);
      for (const event of events) {
        if (event.type === 'annotation-created') {
          attachBrowserAnnotationToSession(event.projectPath, event.sessionId, event.annotation.id);
        }
      }
    });
  }, [applyEvents]);

  useEffect(() => {
    if (!('piDesktop' in window) || typeof window.piDesktop.onBrowserLinkOpen !== 'function') return undefined;
    return window.piDesktop.onBrowserLinkOpen((url) => { void openBrowserLink(url); });
  }, []);

  useEffect(() => {
    const desktop = 'piDesktop' in window ? window.piDesktop : undefined;
    if (!projectPath || !projectTrusted || !browserOpen || typeof desktop?.initializeBrowser !== 'function') {
      if (!projectPath || !projectTrusted) {
        reset();
        setBrowserOpen(false);
      }
      return undefined;
    }
    let active = true;
    void desktop.initializeBrowser().then(async (state) => {
      const current = useRuntimeStore.getState().runtime.project;
      if (!active || current?.path !== projectPath || !current.trusted) return;
      hydrate(state, projectPath);
      if (typeof desktop.listBrowserAnnotations === 'function') {
        const annotations = await desktop.listBrowserAnnotations();
        const latest = useRuntimeStore.getState().runtime.project;
        if (active && latest?.path === projectPath && latest.trusted) setAnnotations(annotations);
      }
    }).catch((error: unknown) => {
      if (active) useBrowserStore.getState().setError(error instanceof Error ? error.message : 'The built-in browser could not start.');
    });
    return () => { active = false; };
  }, [browserOpen, hydrate, projectPath, projectTrusted, reset, setAnnotations, setBrowserOpen]);

  return null;
}

function WorkspaceInitializer() {
  const projectPath = useRuntimeStore((state) => state.runtime.project?.path ?? null);
  const initializeWorkspace = useWorkspaceStore((state) => state.initialize);
  const surface = useUiStore((state) => state.inspectorCollapsed
    ? null
    : state.inspectorTab === 'files'
      ? 'files'
      : state.inspectorTab === 'changes'
        ? 'changes'
        : null);

  useEffect(() => {
    void initializeWorkspace(projectPath, surface).then(() => {
      const workspace = useWorkspaceStore.getState();
      const desktop = 'piDesktop' in window ? window.piDesktop : undefined;
      if (projectPath && workspace.projectPath === projectPath && !workspace.git && typeof desktop?.getGitStatus === 'function') return workspace.refreshGit();
      return undefined;
    });
  }, [initializeWorkspace, projectPath, surface]);

  return null;
}

export function App() {
  const setRuntime = useRuntimeStore((state) => state.setRuntime);
  const hydrateRuntime = useRuntimeStore((state) => state.hydrateRuntime);
  const applyEvents = useRuntimeStore((state) => state.applyEvents);
  const applyGoalEvents = useGoalMaxStore((state) => state.applyEvents);
  const selectGoalSession = useGoalMaxStore((state) => state.selectSession);
  const hydrateGoal = useGoalMaxStore((state) => state.hydrate);
  const selectTaskSession = useTaskStore((state) => state.selectSession);
  const hydrateTask = useTaskStore((state) => state.hydrate);
  const applyTaskEvents = useTaskStore((state) => state.applyEvents);
  const projectPath = useRuntimeStore((state) => state.runtime.project?.path ?? null);
  const projectTrusted = useRuntimeStore((state) => state.runtime.project?.trusted ?? false);
  const sessionId = useRuntimeStore((state) => state.runtime.sessionId);
  const musicPlayerEnabled = useUiStore((state) => state.musicPlayerEnabled);
  const paletteOpen = useUiStore((state) => state.paletteOpen);
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const browserOpen = useUiStore((state) => state.browserOpen);
  const goalEditorOpen = useUiStore((state) => state.goalEditorOpen);
  const [portalDialogOpen, setPortalDialogOpen] = useState(false);
  const [paletteActivated, setPaletteActivated] = useState(false);
  const [settingsActivated, setSettingsActivated] = useState(false);
  const [themeCatalog, setThemeCatalog] = useState(() => fallbackThemes);
  const [hydrationAttempt, setHydrationAttempt] = useState(0);
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  const [recoveryBanner, setRecoveryBanner] = useState<string | null>(null);
  const sessionReplacementBusy = useRef(false);

  useEffect(() => { if (paletteOpen) setPaletteActivated(true); }, [paletteOpen]);
  useEffect(() => { if (settingsOpen) setSettingsActivated(true); }, [settingsOpen]);

  useEffect(() => {
    if (!browserOpen || !projectTrusted) {
      setPortalDialogOpen(false);
      return undefined;
    }
    let frame = 0;
    const update = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setPortalDialogOpen(hasBlockingBrowserOverlay());
      });
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'aria-modal', 'data-state'] });
    setPortalDialogOpen(hasBlockingBrowserOverlay());
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [browserOpen, projectTrusted]);

  useEffect(() => {
    const desktop = 'piDesktop' in window ? window.piDesktop : undefined;
    if (!browserOpen || !projectPath || !projectTrusted || typeof desktop?.setBrowserOverlayBlocked !== 'function') return undefined;
    let active = true;
    void desktop.setBrowserOverlayBlocked(paletteOpen || settingsOpen || goalEditorOpen || portalDialogOpen).then((state) => {
      const project = useRuntimeStore.getState().runtime.project;
      if (active && project?.path === projectPath && project.trusted) useBrowserStore.getState().hydrate(state, projectPath);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [browserOpen, goalEditorOpen, paletteOpen, portalDialogOpen, projectPath, projectTrusted, settingsOpen]);

  useEffect(() => {
    const jump = useUiStore.getState().flightDeckJump;
    if (jump && (jump.projectPath !== projectPath || jump.sessionId !== sessionId)) {
      useUiStore.getState().clearFlightDeckJump(jump.nonce);
    }
  }, [projectPath, sessionId]);

  useEffect(() => {
    if (!('piDesktop' in window) || typeof window.piDesktop.getSettings !== 'function') return undefined;
    let active = true;
    const settingsPromise = window.piDesktop.getSettings();
    const themesPromise = typeof window.piDesktop.getThemes === 'function'
      ? window.piDesktop.getThemes().catch(() => fallbackThemes)
      : Promise.resolve(fallbackThemes);
    // Do not make basic UI preferences wait for Pi theme discovery. Theme
    // scanning can touch several user/project locations and must not block the
    // session list or the Compact sessions setting.
    void themesPromise.then((themes) => {
      if (!active) return;
      setThemeCatalog(themes);
      void settingsPromise.then((settings) => {
        if (active) applyVisualSettings(settings, themes);
      }).catch(() => undefined);
    });
    void settingsPromise.then((settings) => {
      if (!active) return;
      // Built-in themes are safe to paint the moment settings resolve. A custom
      // or Pi theme is not in the fallback catalog: painting the fallback would
      // flash the default palette until theme discovery finishes, so apply only
      // fonts/motion now and let the themesPromise path apply the exact theme.
      if (fallbackThemes.some((theme) => theme.id === settings.themeId)) {
        applyVisualSettings(settings, fallbackThemes);
      } else {
        applyNonThemeVisualSettings(settings);
      }
      useUiStore.getState().setMusicPlayerEnabled(settings.musicPlayerEnabled);
      useUiStore.getState().setSendMessageWithModifier(settings.sendMessageWithModifier);
      useUiStore.getState().setCompactMode(settings.compactMode);
      useUiStore.getState().setCompactSessions(settings.compactSessions);
      useUiStore.getState().setAdvancedPromptImprovement(settings.advancedPromptImprovement);
      useUiStore.getState().setDisabledModels(settings.disabledModels ?? []);
      useUiStore.getState().setSpeech(settings.speech ?? defaultSpeechSettings);
      void window.piDesktop.getSpeechStatus().then((status) => { if (active) useUiStore.getState().setSpeechStatus(status); }).catch(() => undefined);
    }).catch((error: unknown) => {
      // Settings can fail (strict-schema rejection, IPC error, …). Do not
      // swallow it silently: keep a usable built-in visual fallback.
      if (!active) return;
      setThemeCatalog(fallbackThemes);
      applyVisualSettings(
        { appearance: 'dark', themeId: 'midnight', interfaceFont: 'noto-sans', codeFont: 'jetbrains-mono', performanceMode: false, reduceMotion: false, holyShitMode: false, compactMode: false },
        fallbackThemes,
        // A corrupt settings file must not overwrite the last good theme
        // snapshot, or the next launch would boot into the wrong palette.
        { persistTheme: false },
      );
      console.error('[Fate UI] Failed to load initial settings.', error);
    });
    return () => { active = false; };
  }, [projectPath, projectTrusted]);

  useEffect(() => {
    const generation = selectGoalSession(projectPath, sessionId);
    if (!projectPath || !sessionId || !('piDesktop' in window) || typeof window.piDesktop.getGoalMax !== 'function') {
      hydrateGoal(generation, null);
      return;
    }
    let active = true;
    void window.piDesktop.getGoalMax().then((goal) => {
      if (active) hydrateGoal(generation, goal);
    }).catch(() => {
      if (active) hydrateGoal(generation, null);
    });
    return () => { active = false; };
  }, [hydrateGoal, projectPath, selectGoalSession, sessionId]);

  useEffect(() => {
    if (!('piDesktop' in window) || typeof window.piDesktop.onGoalMaxEvents !== 'function') return undefined;
    return window.piDesktop.onGoalMaxEvents((events) => applyGoalEvents(events));
  }, [applyGoalEvents]);

  useEffect(() => {
    const generation = selectTaskSession(projectPath, sessionId);
    if (!projectPath || !sessionId || !('piDesktop' in window) || typeof window.piDesktop.getTaskList !== 'function') {
      hydrateTask(generation, null);
      return;
    }
    let active = true;
    void window.piDesktop.getTaskList().then((list) => {
      if (active) hydrateTask(generation, list);
    }).catch(() => {
      if (active) hydrateTask(generation, null);
    });
    return () => { active = false; };
  }, [hydrateTask, projectPath, selectTaskSession, sessionId]);

  useEffect(() => {
    if (!('piDesktop' in window) || typeof window.piDesktop.onTaskEvents !== 'function') return undefined;
    return window.piDesktop.onTaskEvents((events) => applyTaskEvents(events));
  }, [applyTaskEvents]);

  useEffect(() => {
    if (!('piDesktop' in window) || typeof window.piDesktop.onSpeechDownload !== 'function') return undefined;
    return window.piDesktop.onSpeechDownload((progress) => {
      useUiStore.getState().setSpeechDownload(progress.state === 'downloading' || progress.state === 'verifying' ? progress : null);
    });
  }, []);

  useEffect(() => {
    if (!('piDesktop' in window) || typeof window.piDesktop.getAppInfo !== 'function') return;
    void window.piDesktop.getAppInfo()
      .then((info) => { document.documentElement.dataset.platform = info.platform; })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!('piDesktop' in window)) return;
    let cancelled = false;
    let hydrating = true;
    const bufferedEvents: PiEvent[] = [];
    const bufferedSizes: number[] = [];
    let bufferedBytes = 0;
    let bufferOverflowed = false;
    const unsubscribe = window.piDesktop.onEvents((events) => {
      if (!hydrating) {
        applyEvents(events);
        return;
      }
      for (const event of events) {
        if (bufferOverflowed) continue;
        const bytes = JSON.stringify(event).length;
        if (bytes > MAX_HYDRATION_BUFFER_BYTES) {
          bufferedEvents.length = 0;
          bufferedSizes.length = 0;
          bufferedBytes = 0;
          bufferOverflowed = true;
          continue;
        }
        bufferedEvents.push(event);
        bufferedSizes.push(bytes);
        bufferedBytes += bytes;
        while (
          bufferedEvents.length > 1
          && (bufferedEvents.length > MAX_HYDRATION_BUFFER_EVENTS || bufferedBytes > MAX_HYDRATION_BUFFER_BYTES)
        ) {
          bufferedEvents.shift();
          bufferedBytes -= bufferedSizes.shift() ?? 0;
          bufferOverflowed = true;
        }
      }
    });

    const recover = Promise.resolve(
      typeof window.piDesktop.consumeRecovery === 'function' ? window.piDesktop.consumeRecovery() : null,
    ).catch(() => null);
    void recover.then((notice) => {
      if (!cancelled && notice) {
        const bits = ['The last Fate UI process stopped without a clean shutdown.'];
        if (notice.streaming || notice.activeSessionRunning) bits.push('A response or tool was still running.');
        if (notice.queueSteering + notice.queueFollowUp > 0) bits.push('Queued prompts were not sent.');
        if (notice.lastToolName) bits.push(`Last running tool: ${notice.lastToolName}.`);
        bits.push('The session was restored. Check the last tool result before you continue.');
        setRecoveryBanner(bits.join(' '));
      }
      if (cancelled) return Promise.resolve(null);
      return window.piDesktop.getRuntimeState();
    }).then((runtime) => {
      if (cancelled || !runtime) return;
      if (bufferOverflowed) {
        // Do not install a snapshot paired with an incomplete event tail. A new
        // subscription and authoritative hydration replaces same-session data.
        setHydrationError('Live state changed too quickly during startup. Resynchronizing…');
        setHydrationAttempt((value) => value + 1);
        return;
      }
      hydrateRuntime(runtime);
      hydrating = false;
      if (bufferedEvents.length > 0) {
        const replay = reconcileHydrationEvents(runtime, bufferedEvents);
        if (replay.length > 0) applyEvents(replay);
        bufferedEvents.length = 0;
        bufferedSizes.length = 0;
        bufferedBytes = 0;
      }
      setHydrationError(null);
    }).catch((error: unknown) => {
      hydrating = false;
      if (bufferedEvents.length > 0) applyEvents(bufferedEvents);
      bufferedEvents.length = 0;
      bufferedSizes.length = 0;
      bufferedBytes = 0;
      if (!cancelled) setHydrationError(error instanceof Error ? error.message : 'Fate UI could not load its runtime state.');
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyEvents, hydrateRuntime, hydrationAttempt]);

  useEffect(() => {
    if (!('piDesktop' in window)) return;
    let active = true;
    const applyReplacement = (origin: RuntimeState, state: RuntimeState) => {
      if (!active) return;
      const current = useRuntimeStore.getState().runtime;
      const selectionMoved = current.sessionId !== origin.sessionId || current.project?.path !== origin.project?.path;
      const resultIsCurrent = current.sessionId === state.sessionId && current.project?.path === state.project?.path;
      if (!selectionMoved || resultIsCurrent) setRuntime(state);
    };
    const run = (command: AppCommand) => {
      const ui = useUiStore.getState();
      const runtime = useRuntimeStore.getState().runtime;
      const unavailable = (title: string, message: string) => ui.showToast({ kind: 'info', title, message });
      const failed = (title: string, error: unknown, fallback: string) => ui.showToast({
        kind: 'error', title, message: appCommandErrorMessage(error, fallback),
      });
      if (command === 'open-project') {
        void window.piDesktop.selectProject().then((state) => {
          if (!active) return;
          setRuntime(state);
          if (state.project) ui.setSidebarCollapsed(false);
        }).catch((error: unknown) => failed('Could not open project', error, 'The project could not be opened.'));
      }
      else if (command === 'new-session') {
        if (!runtime.project) {
          unavailable('New session unavailable', 'Open a project before creating a session.');
          return;
        }
        if (runtime.sessionOperation || sessionReplacementBusy.current) {
          unavailable('Session change in progress', 'Wait for the current session change to finish.');
          return;
        }
        sessionReplacementBusy.current = true;
        let pending: Promise<RuntimeState>;
        try {
          pending = window.piDesktop.newSession();
        } catch (error) {
          pending = Promise.reject(error);
        }
        void pending
          .then((state) => applyReplacement(runtime, state))
          .catch((error: unknown) => failed('Could not create session', error, 'The new session could not be created.'))
          .finally(() => { sessionReplacementBusy.current = false; });
      }
      else if (command === 'focus-composer') {
        const composer = document.querySelector<HTMLTextAreaElement>('#pi-composer');
        if (runtime.status === 'ready' && composer && !composer.disabled) composer.focus();
        else unavailable('Composer unavailable', 'Open and trust a project before focusing the composer.');
      }
      else if (command === 'focus-address') {
        if (runtime.project?.trusted && ui.browserOpen) {
          requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.browser-address input')?.select());
        } else {
          const composer = document.querySelector<HTMLTextAreaElement>('#pi-composer');
          if (runtime.status === 'ready' && composer && !composer.disabled) composer.focus();
          else unavailable('No input to focus', 'Open and trust a project before focusing the browser address or composer.');
        }
      }
      else if (command === 'toggle-browser') {
        if (!runtime.project?.trusted) {
          unavailable('Browser unavailable', 'Open and trust a project before opening the Browser workspace.');
          return;
        }
        const opening = !ui.browserOpen;
        if (opening) {
          void window.piDesktop.setBrowserMode('agent').then((state) => {
            useBrowserStore.getState().hydrate(state);
            ui.setBrowserOpen(true);
          }).catch((error: unknown) => {
            const message = appCommandErrorMessage(error, 'The Browser workspace could not change state.');
            useBrowserStore.getState().setError(message);
            failed('Browser command failed', error, message);
          });
        } else {
          ui.setBrowserOpen(false);
        }
      }
      else if (command === 'stop-generation') {
        if (!runtime.streaming) {
          unavailable('Nothing to stop', 'Pi is not currently generating a response.');
          return;
        }
        void window.piDesktop.abort().catch((error: unknown) => failed('Could not stop generation', error, 'The active response could not be stopped.'));
      }
      else if (command === 'toggle-sidebar') ui.toggleSidebar();
      else if (command === 'toggle-inspector') ui.toggleInspector();
      else if (command === 'open-settings') ui.setSettingsOpen(true);
      else if (command === 'open-terminal') {
        if (runtime.project?.trusted) ui.toggleTerminal();
        else unavailable('Terminal unavailable', 'Open and trust a project before opening the manual terminal.');
      }
      else if (command === 'open-palette') ui.setPaletteOpen(true);
      else if (command === 'export-session') {
        if (typeof window.piDesktop.exportSession !== 'function') {
          unavailable('Export unavailable', 'Restart Fate UI to enable session export.');
          return;
        }
        if (!runtime.sessionId) {
          unavailable('Nothing to export', 'Open a session before exporting it.');
          return;
        }
        void window.piDesktop.exportSession().then((result) => {
          if (result.saved) useUiStore.getState().showToast({ kind: 'success', title: 'Session exported', message: result.path ?? 'Saved locally.' });
        }).catch((error: unknown) => failed('Could not export session', error, 'The session could not be exported.'));
      }
    };
    const unsubscribe = typeof window.piDesktop.onAppCommand === 'function'
      ? window.piDesktop.onAppCommand(run)
      : () => undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const primary = event.metaKey || event.ctrlKey;
      let command: AppCommand | null = null;
      if (primary && event.key.toLocaleLowerCase() === 'k') command = 'open-palette';
      else if (primary && event.key === '`') command = 'open-terminal';
      else if (primary && event.key === ',') command = 'open-settings';
      else if (primary && event.key.toLocaleLowerCase() === 'b' && event.shiftKey) command = 'toggle-browser';
      else if (primary && event.key.toLocaleLowerCase() === 'b') command = 'toggle-sidebar';
      else if (primary && event.key.toLocaleLowerCase() === 'o') command = 'open-project';
      else if (primary && event.key.toLocaleLowerCase() === 'n') command = 'new-session';
      else if (
        event.key === 'Escape'
        && !useUiStore.getState().paletteOpen
        && !useUiStore.getState().settingsOpen
        && !document.querySelector('[role="dialog"], [role="listbox"], [data-radix-popper-content-wrapper], .music-dock[data-open="true"]')
      ) {
        const browser = useBrowserStore.getState().state;
        if (browser.mode === 'annotate' && typeof window.piDesktop.setBrowserMode === 'function') {
          event.preventDefault();
          void window.piDesktop.setBrowserMode('agent').then((state) => useBrowserStore.getState().hydrate(state)).catch(() => undefined);
          return;
        }
        if (useRuntimeStore.getState().runtime.streaming) command = 'stop-generation';
      }
      if (command) { event.preventDefault(); run(command); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      active = false;
      sessionReplacementBusy.current = false;
      unsubscribe();
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [setRuntime]);

  return (
    <>
      {hydrationError && <div className="hydration-error-banner" role="alert"><span>{hydrationError}</span><button type="button" onClick={() => setHydrationAttempt((value) => value + 1)}>Retry</button></div>}
      {recoveryBanner && <div className="hydration-error-banner recovery-banner" role="status"><span>{recoveryBanner}</span><button type="button" onClick={() => setRecoveryBanner(null)}>Dismiss</button></div>}
      <BrowserInitializer />
      <WorkspaceInitializer />
      <AppShell />
      <AppToast />
      {musicPlayerEnabled && <Suspense fallback={null}><MusicPlayerDock /></Suspense>}
      {(paletteOpen || paletteActivated) && <Suspense fallback={null}><CommandPalette /></Suspense>}
      {(settingsOpen || settingsActivated) && <Suspense fallback={null}><SettingsDialog themeCatalog={themeCatalog} /></Suspense>}
    </>
  );
}
