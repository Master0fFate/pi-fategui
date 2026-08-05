import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { AppCommand, PiEvent, RuntimeState } from '../../shared/contracts/ipc';
import { AppToast } from '../components/AppToast';
import { applyVisualSettings } from '../appearance';
import { useRuntimeStore } from '../stores/runtimeStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useUiStore } from '../stores/uiStore';
import { useGoalMaxStore } from '../stores/goalMaxStore';
import { fallbackThemes } from '../theme';

const MAX_HYDRATION_BUFFER_EVENTS = 1_000;
const MAX_HYDRATION_BUFFER_BYTES = 32 * 1024 * 1024;

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
  const projectPath = useRuntimeStore((state) => state.runtime.project?.path ?? null);
  const projectTrusted = useRuntimeStore((state) => state.runtime.project?.trusted ?? false);
  const sessionId = useRuntimeStore((state) => state.runtime.sessionId);
  const musicPlayerEnabled = useUiStore((state) => state.musicPlayerEnabled);
  const paletteOpen = useUiStore((state) => state.paletteOpen);
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const [paletteActivated, setPaletteActivated] = useState(false);
  const [settingsActivated, setSettingsActivated] = useState(false);
  const [themeCatalog, setThemeCatalog] = useState(() => fallbackThemes);
  const [hydrationAttempt, setHydrationAttempt] = useState(0);
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  const sessionReplacementBusy = useRef(false);

  useEffect(() => { if (paletteOpen) setPaletteActivated(true); }, [paletteOpen]);
  useEffect(() => { if (settingsOpen) setSettingsActivated(true); }, [settingsOpen]);

  useEffect(() => {
    const jump = useUiStore.getState().flightDeckJump;
    if (jump && (jump.projectPath !== projectPath || jump.sessionId !== sessionId)) {
      useUiStore.getState().clearFlightDeckJump(jump.nonce);
    }
  }, [projectPath, sessionId]);

  useEffect(() => {
    if (!('piDesktop' in window) || typeof window.piDesktop.getSettings !== 'function') return undefined;
    let active = true;
    const themesPromise = typeof window.piDesktop.getThemes === 'function'
      ? window.piDesktop.getThemes().catch(() => fallbackThemes)
      : Promise.resolve(fallbackThemes);
    void Promise.all([window.piDesktop.getSettings(), themesPromise]).then(([settings, themes]) => {
      if (!active) return;
      setThemeCatalog(themes);
      applyVisualSettings(settings, themes);
      useUiStore.getState().setMusicPlayerEnabled(settings.musicPlayerEnabled);
      useUiStore.getState().setSendMessageWithModifier(settings.sendMessageWithModifier);
      useUiStore.getState().setSpeech(settings.speech ?? { enabled: true, modelId: 'mini', language: 'auto', inputDeviceId: null });
    }).catch(() => undefined);
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

    void window.piDesktop.getRuntimeState().then((runtime) => {
      if (cancelled) return;
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
      if (command === 'open-project') {
        void window.piDesktop.selectProject().then((state) => {
          if (!active) return;
          setRuntime(state);
          if (state.project) ui.setSidebarCollapsed(false);
        });
      }
      else if (command === 'new-session' && runtime.project && !runtime.sessionOperation && !sessionReplacementBusy.current) {
        sessionReplacementBusy.current = true;
        let pending: Promise<RuntimeState>;
        try {
          pending = window.piDesktop.newSession();
        } catch (error) {
          pending = Promise.reject(error);
        }
        void pending.then((state) => applyReplacement(runtime, state)).catch(() => undefined).finally(() => { sessionReplacementBusy.current = false; });
      }
      else if (command === 'focus-composer') document.querySelector<HTMLTextAreaElement>('#pi-composer')?.focus();
      else if (command === 'stop-generation' && runtime.streaming && !ui.settingsOpen && !ui.paletteOpen) void window.piDesktop.abort();
      else if (command === 'toggle-sidebar') ui.toggleSidebar();
      else if (command === 'toggle-inspector') ui.toggleInspector();
      else if (command === 'open-settings') ui.setSettingsOpen(true);
      else if (command === 'open-terminal') ui.toggleTerminal();
      else if (command === 'open-palette') ui.setPaletteOpen(true);
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
      else if (primary && event.key.toLocaleLowerCase() === 'b' && event.shiftKey) command = 'toggle-inspector';
      else if (primary && event.key.toLocaleLowerCase() === 'b') command = 'toggle-sidebar';
      else if (primary && event.key.toLocaleLowerCase() === 'o') command = 'open-project';
      else if (primary && event.key.toLocaleLowerCase() === 'n') command = 'new-session';
      else if (
        event.key === 'Escape'
        && !useUiStore.getState().paletteOpen
        && !useUiStore.getState().settingsOpen
        && !document.querySelector('[role="dialog"], [role="listbox"], [data-radix-popper-content-wrapper], .music-dock[data-open="true"]')
      ) command = 'stop-generation';
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
      <WorkspaceInitializer />
      <AppShell />
      <AppToast />
      {musicPlayerEnabled && <Suspense fallback={null}><MusicPlayerDock /></Suspense>}
      {(paletteOpen || paletteActivated) && <Suspense fallback={null}><CommandPalette /></Suspense>}
      {(settingsOpen || settingsActivated) && <Suspense fallback={null}><SettingsDialog themeCatalog={themeCatalog} /></Suspense>}
    </>
  );
}
