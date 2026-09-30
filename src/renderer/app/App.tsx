import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getFateApi, getFateApiOptional, getDesktopApi, getDesktopApiOptional, getWebApiOptional, hasCapability } from '../platform/api';
import type { NetworkWorkspaceApi } from '../stores/runtimeStore';
import { useRuntimeStore as useWebWorkspaceStore } from '../stores/runtimeStore';
import { unavailableExplanation } from '../platform/capabilityPolicy';
import { defaultSpeechSettings, type AppCommand, type PiEvent, type RuntimeState } from '../../shared/contracts/ipc';
import { AppToast } from '../components/AppToast';
import { applyNonThemeVisualSettings, applyVisualSettings } from '../appearance';
import { setSkinDefinitions } from '../skin';
import { builtInSkins } from '../../shared/skins';
import { resolveSkinAppearance } from '../../shared/skinAppearance';
import { useRuntimeStore } from '../stores/runtimeStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useUiStore } from '../stores/uiStore';
import { useGoalMaxStore } from '../stores/goalMaxStore';
import { useTaskStore } from '../stores/taskStore';
import { useBrowserStore } from '../stores/browserStore';
import { fallbackThemes } from '../theme';
import { attachBrowserAnnotationToSession } from '../features/chat/Composer';
import { openBrowserLink } from '../features/browser/browserLink';
import { RuntimeEventBuffer, streamPresentationDelay } from '../lib/RuntimeEventBuffer';
import { canStopSession } from '../../shared/sessionStop';
import { reconcileHydrationEvents } from '../../client/reconcileHydrationEvents';
export { reconcileHydrationEvents } from '../../client/reconcileHydrationEvents';

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

const MusicPlayerDock = lazy(() => import('../features/music/MusicPlayerDock').then((module) => ({ default: module.MusicPlayerDock })));
const CommandPalette = lazy(() => import('../features/commands/CommandPalette').then((module) => ({ default: module.CommandPalette })));
import { useLearningStore } from '../features/learning/learningStore';
const LearningPanel = lazy(() => import('../features/learning/LearningPanel').then((module) => ({ default: module.LearningPanel })));
const SettingsDialog = lazy(() => import('../features/settings/SettingsDialog').then((module) => ({ default: module.SettingsDialog })));
import { AppShell } from './AppShell';

function BrowserInitializer() {
  const projectPath = useRuntimeStore((state) => state.runtime.project?.path ?? null);
  const projectTrusted = useRuntimeStore((state) => state.runtime.project?.trusted ?? false);
  const browserSessionId = useRuntimeStore((state) => state.runtime.sessionId);
  const browserOpen = useUiStore((state) => state.browserOpen);
  const hydrate = useBrowserStore((state) => state.hydrate);
  const applyEvents = useBrowserStore((state) => state.applyEvents);
  const setAnnotations = useBrowserStore((state) => state.setAnnotations);
  const reset = useBrowserStore((state) => state.reset);
  const setBrowserOpen = useUiStore((state) => state.setBrowserOpen);
  const previousBrowserScope = useRef<string | null>(null);

  useEffect(() => {
    if (!hasCapability('nativeBrowser') || typeof getDesktopApiOptional()?.onBrowserEvents !== 'function') return undefined;
    return getDesktopApi().onBrowserEvents((events) => {
      const current = useRuntimeStore.getState().runtime;
      const selectedEvents = events.filter((event) => !event.sessionId || !event.projectPath
        || event.projectPath === current.project?.path && event.sessionId === current.sessionId);
      if (selectedEvents.length) applyEvents(selectedEvents);
      for (const event of events) {
        if (event.type === 'annotation-created') {
          attachBrowserAnnotationToSession(event.projectPath, event.sessionId, event.annotation.id);
        }
      }
    });
  }, [applyEvents]);

  useEffect(() => {
    if (!hasCapability('nativeBrowser') || typeof getDesktopApiOptional()?.onBrowserLinkOpen !== 'function') return undefined;
    return getDesktopApi().onBrowserLinkOpen((url) => { void openBrowserLink(url); });
  }, []);

  useEffect(() => {
    const desktop = getDesktopApiOptional();
    // Closing the browser must not detach notes already attached to this
    // conversation. A different project/session still clears the old notes.
    const scope = projectPath && projectTrusted && browserSessionId ? `${projectPath}\0${browserSessionId}` : null;
    const retained = scope && scope === previousBrowserScope.current ? useBrowserStore.getState().annotations : [];
    previousBrowserScope.current = scope;
    reset();
    if (retained.length) setAnnotations(retained);
    if (!projectPath || !projectTrusted || !browserSessionId || !browserOpen || !hasCapability('nativeBrowser') || typeof desktop?.initializeBrowser !== 'function') {
      if (!projectPath || !projectTrusted) setBrowserOpen(false);
      return undefined;
    }
    let active = true;
    const stillSelected = () => {
      const current = useRuntimeStore.getState().runtime;
      return active && current.project?.path === projectPath && current.project.trusted && current.sessionId === browserSessionId;
    };
    void desktop.initializeBrowser().then(async (state) => {
      if (!stillSelected()) return;
      hydrate(state, projectPath);
      if (typeof desktop.listBrowserAnnotations === 'function') {
        const annotations = await desktop.listBrowserAnnotations();
        if (stillSelected()) setAnnotations(annotations);
      }
    }).catch((error: unknown) => {
      if (stillSelected()) useBrowserStore.getState().setError(error instanceof Error ? error.message : 'The built-in browser could not start.');
    });
    return () => { active = false; };
  }, [browserOpen, browserSessionId, hydrate, projectPath, projectTrusted, reset, setAnnotations, setBrowserOpen]);

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
      const api = getFateApiOptional();
      if (projectPath && workspace.projectPath === projectPath && !workspace.git && typeof api?.getGitStatus === 'function') return workspace.refreshGit();
      return undefined;
    });
  }, [initializeWorkspace, projectPath, surface]);

  return null;
}

function NetworkInitializer({ web }: { web: NetworkWorkspaceApi }) {
  const selected = useWebWorkspaceStore((state) => state.selected);
  const snapshot = useWebWorkspaceStore((state) => state.snapshot);
  const phase = useWebWorkspaceStore((state) => state.phase);
  const refresh = useWebWorkspaceStore((state) => state.refresh);
  const initialize = useWebWorkspaceStore((state) => state.initialize);
  const disconnect = useWebWorkspaceStore((state) => state.disconnect);
  const invalidate = useWebWorkspaceStore((state) => state.invalidate);
  const reset = useWebWorkspaceStore((state) => state.reset);
  // Select the DTO source before paint; never flash a previous desktop conversation.
  useLayoutEffect(() => {
    void initialize(web);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = web.onInvalidate(() => {
      if (!web.isConnected) { if (timer) clearTimeout(timer); timer = undefined; disconnect(); return; }
      // Events are invalidation metadata, not PiEvents. Disable current reads immediately.
      invalidate();
      if (!timer) timer = setTimeout(() => { timer = undefined; void refresh(web); }, 250);
    });
    return () => { unsubscribe(); if (timer) clearTimeout(timer); reset(); };
  }, [web, initialize, refresh, disconnect, invalidate, reset]);
  useEffect(() => { if (selected && web.isConnected) void refresh(web); }, [web, selected, refresh]);
  useEffect(() => {
    if (!snapshot || phase !== 'observing' || !web.isConnected) return;
    const state = useRuntimeStore.getState();
    state.recoverPendingReview(web);
    void state.loadNetworkViews(web, 'session');
    void state.loadNetworkViews(web, 'queue');
    void useGoalMaxStore.getState().loadNetwork(web);
    void useTaskStore.getState().loadNetwork(web);
  }, [web, snapshot, phase]);
  return null;
}

export function App() {
  const web = getWebApiOptional();
  return <>{web ? <NetworkInitializer web={web} /> : <DesktopInitializer />}<AppShell /><AppToast /></>;
}

function DesktopInitializer() {
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
  const learningOpen = useLearningStore((state) => state.open);
  const browserOpen = useUiStore((state) => state.browserOpen);
  const goalEditorOpen = useUiStore((state) => state.goalEditorOpen);
  const [portalDialogOpen, setPortalDialogOpen] = useState(false);
  const [paletteActivated, setPaletteActivated] = useState(false);
  const [settingsActivated, setSettingsActivated] = useState(false);
  const [themeCatalog, setThemeCatalog] = useState(() => fallbackThemes);
  const [hydrationAttempt, setHydrationAttempt] = useState(0);
  const [hydrationError, setHydrationError] = useState<string | null>(null);
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
    const desktop = getDesktopApiOptional();
    if (!hasCapability('nativeBrowser') || !browserOpen || !projectPath || !projectTrusted || typeof desktop?.setBrowserOverlayBlocked !== 'function') return undefined;
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
    if (!getFateApiOptional() || typeof getDesktopApiOptional()?.getSettings !== 'function') return undefined;
    let active = true;
    const skinPromise = typeof getDesktopApiOptional()?.getSkins === 'function'
      ? getDesktopApi().getSkins().then((catalog) => catalog.skins).catch(() => builtInSkins)
      : Promise.resolve(builtInSkins);
    const settingsPromise = Promise.all([getDesktopApi().getSettings(), skinPromise]).then(([settings, skins]) => {
      if (active) setSkinDefinitions(skins);
      return resolveSkinAppearance(settings, skins);
    });
    const themesPromise = typeof getDesktopApiOptional()?.getThemes === 'function'
      ? getDesktopApi().getThemes().catch(() => fallbackThemes)
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
      if (hasCapability('microphone')) void getDesktopApi().getSpeechStatus().then((status) => { if (active) useUiStore.getState().setSpeechStatus(status); }).catch(() => undefined);
    }).catch((error: unknown) => {
      // Settings can fail (strict-schema rejection, IPC error, …). Do not
      // swallow it silently: keep a usable built-in visual fallback.
      if (!active) return;
      setThemeCatalog(fallbackThemes);
      applyVisualSettings(
        { appearance: 'dark', skinId: 'default', themeId: 'midnight', interfaceFont: 'noto-sans', codeFont: 'jetbrains-mono', performanceMode: false, reduceMotion: false, holyShitMode: false, compactMode: false },
        fallbackThemes,
        // A corrupt settings file must not overwrite the last good theme
        // snapshot, or the next launch would boot into the wrong palette.
        { persistSkin: false, persistTheme: false },
      );
      console.error('[Fate UI] Failed to load initial settings.', error);
    });
    return () => { active = false; };
  }, [projectPath, projectTrusted]);

  useEffect(() => {
    const generation = selectGoalSession(projectPath, sessionId);
    if (!projectPath || !sessionId || !getFateApiOptional() || typeof getFateApi().getGoalMax !== 'function') {
      hydrateGoal(generation, null);
      return;
    }
    let active = true;
    void getFateApi().getGoalMax().then((goal) => {
      if (active) hydrateGoal(generation, goal);
    }).catch(() => {
      if (active) hydrateGoal(generation, null);
    });
    return () => { active = false; };
  }, [hydrateGoal, projectPath, selectGoalSession, sessionId]);

  useEffect(() => {
    if (!getFateApiOptional() || typeof getFateApi().onGoalMaxEvents !== 'function') return undefined;
    return getFateApi().onGoalMaxEvents((events) => applyGoalEvents(events));
  }, [applyGoalEvents]);

  useEffect(() => {
    const generation = selectTaskSession(projectPath, sessionId);
    if (!projectPath || !sessionId || !getFateApiOptional() || typeof getFateApi().getTaskList !== 'function') {
      hydrateTask(generation, null);
      return;
    }
    let active = true;
    void getFateApi().getTaskList().then((list) => {
      if (active) hydrateTask(generation, list);
    }).catch(() => {
      if (active) hydrateTask(generation, null);
    });
    return () => { active = false; };
  }, [hydrateTask, projectPath, selectTaskSession, sessionId]);

  useEffect(() => {
    if (!getFateApiOptional() || typeof getFateApi().onTaskEvents !== 'function') return undefined;
    return getFateApi().onTaskEvents((events) => applyTaskEvents(events));
  }, [applyTaskEvents]);

  useEffect(() => {
    if (!hasCapability('microphone') || typeof getDesktopApiOptional()?.onSpeechDownload !== 'function') return undefined;
    return getDesktopApi().onSpeechDownload((progress) => {
      useUiStore.getState().setSpeechDownload(progress.state === 'downloading' || progress.state === 'verifying' ? progress : null);
    });
  }, []);

  useEffect(() => {
    if (!getFateApiOptional() || typeof getDesktopApiOptional()?.getAppInfo !== 'function') return;
    void getDesktopApi().getAppInfo()
      .then((info) => { document.documentElement.dataset.platform = info.platform; })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!getFateApiOptional()) return;
    let cancelled = false;
    let hydrating = true;
    const bufferedEvents: PiEvent[] = [];
    const bufferedSizes: number[] = [];
    let bufferedBytes = 0;
    let bufferOverflowed = false;
    const presentation = new RuntimeEventBuffer(applyEvents, streamPresentationDelay, (id) => Boolean(useRuntimeStore.getState().toolsById[id]));
    const unsubscribePresentation = useRuntimeStore.subscribe((next, previous) => {
      if (next.runtime.sessionId !== previous.runtime.sessionId || next.runtime.project?.path !== previous.runtime.project?.path) {
        presentation.clear();
        // Clear browser data in the same state transition, before React can
        // paint the new conversation with the previous one's tab or annotation.
        useBrowserStore.getState().reset();
      }
    });
    const unsubscribe = getFateApi().onEvents((events) => {
      if (cancelled) return;
      if (!hydrating) {
        presentation.enqueue(events);
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

    void getFateApi().getRuntimeState().then((runtime) => {
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
      if (cancelled) return;
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
      unsubscribePresentation();
      presentation.clear();
      bufferedEvents.length = 0;
      bufferedSizes.length = 0;
    };
  }, [applyEvents, hydrateRuntime, hydrationAttempt]);

  useEffect(() => {
    if (!getFateApiOptional()) return;
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
        if (!getDesktopApiOptional()) { unavailable('Project picker unavailable', 'Select a registered workspace on this host.'); return; }
        void getDesktopApi().selectProject().then((state) => {
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
          pending = getFateApi().newSession();
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
        if (!hasCapability('nativeBrowser')) { unavailable('Browser unavailable', unavailableExplanation.nativeBrowser); return; }
        if (!runtime.project?.trusted) {
          unavailable('Browser unavailable', 'Open and trust a project before opening the Browser workspace.');
          return;
        }
        const opening = !ui.browserOpen;
        if (opening) {
          void getDesktopApi().setBrowserMode('agent').then((state) => {
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
        if (!canStopSession(runtime)) {
          unavailable('Nothing to stop', 'Pi is not currently generating a response.');
          return;
        }
        void getFateApi().abort().catch((error: unknown) => failed('Could not stop generation', error, 'The active response could not be stopped.'));
      }
      else if (command === 'toggle-sidebar') ui.toggleSidebar();
      else if (command === 'toggle-inspector') ui.toggleInspector();
      else if (command === 'open-settings') ui.setSettingsOpen(true);
      else if (command === 'open-terminal') {
        if (!hasCapability('manualTerminal')) { unavailable('Terminal unavailable', unavailableExplanation.manualTerminal); return; }
        if (runtime.project?.trusted) ui.toggleTerminal();
        else unavailable('Terminal unavailable', 'Open and trust a project before opening the manual terminal.');
      }
      else if (command === 'open-palette') ui.setPaletteOpen(true);
      else if (command === 'export-session') {
        if (typeof getDesktopApiOptional()?.exportSession !== 'function') {
          unavailable('Export unavailable', 'Restart Fate UI to enable session export.');
          return;
        }
        if (!runtime.sessionId) {
          unavailable('Nothing to export', 'Open a session before exporting it.');
          return;
        }
        void getDesktopApi().exportSession().then((result) => {
          if (result.saved) useUiStore.getState().showToast({ kind: 'success', title: 'Session exported', message: result.path ?? 'Saved locally.' });
        }).catch((error: unknown) => failed('Could not export session', error, 'The session could not be exported.'));
      }
    };
    const unsubscribe = typeof getDesktopApiOptional()?.onAppCommand === 'function'
      ? getDesktopApi().onAppCommand(run)
      : () => undefined;
    let armedStop: { sessionId: string; at: number } | null = null;
    let stopHintTimer: number | null = null;
    const clearStopHint = () => {
      armedStop = null;
      if (stopHintTimer) window.clearTimeout(stopHintTimer);
      stopHintTimer = null;
      if (useUiStore.getState().toast?.title === 'Press Esc again to stop') useUiStore.getState().dismissToast();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') clearStopHint();
      if (event.defaultPrevented) { clearStopHint(); return; }
      if (event.repeat) return;
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
        if (hasCapability('nativeBrowser') && browser.mode === 'annotate' && typeof getDesktopApiOptional()?.setBrowserMode === 'function') {
          clearStopHint();
          event.preventDefault();
          void getDesktopApi().setBrowserMode('agent').then((state) => useBrowserStore.getState().hydrate(state)).catch(() => undefined);
          return;
        }
        const current = useRuntimeStore.getState().runtime;
        if (canStopSession(current) && current.sessionId && !primary && !event.altKey && !event.shiftKey) {
          event.preventDefault();
          const now = Date.now();
          if (armedStop?.sessionId === current.sessionId && now >= armedStop.at && now - armedStop.at <= 3_000) {
            clearStopHint();
            command = 'stop-generation';
          } else {
            clearStopHint();
            armedStop = { sessionId: current.sessionId, at: now };
            useUiStore.getState().showToast({ kind: 'info', title: 'Press Esc again to stop', message: 'Within 3 seconds.' });
            stopHintTimer = window.setTimeout(() => {
              if (armedStop?.at === now) clearStopHint();
            }, 3_000);
          }
        } else {
          clearStopHint();
        }
      } else if (event.key === 'Escape') {
        clearStopHint();
      }
      if (command) { event.preventDefault(); run(command); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      active = false;
      sessionReplacementBusy.current = false;
      unsubscribe();
      window.removeEventListener('keydown', onKeyDown);
      clearStopHint();
    };
  }, [setRuntime]);

  return (
    <>
      {hydrationError && <div className="hydration-error-banner" role="alert"><span>{hydrationError}</span><button type="button" onClick={() => setHydrationAttempt((value) => value + 1)}>Retry</button></div>}
      <BrowserInitializer />
      <WorkspaceInitializer />
      {musicPlayerEnabled && hasCapability('ambientAudio') && getDesktopApiOptional() && <Suspense fallback={null}><MusicPlayerDock /></Suspense>}
      {(paletteOpen || paletteActivated) && <Suspense fallback={null}><CommandPalette /></Suspense>}
      {(settingsOpen || settingsActivated) && <Suspense fallback={null}><SettingsDialog themeCatalog={themeCatalog} /></Suspense>}
      {learningOpen && <Suspense fallback={null}><LearningPanel /></Suspense>}
    </>
  );
}
