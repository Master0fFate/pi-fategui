import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { AppCommand } from '../../shared/contracts/ipc';
import { CommandPalette } from '../features/commands/CommandPalette';
import { SettingsDialog } from '../features/settings/SettingsDialog';
import { useRuntimeStore } from '../stores/runtimeStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useUiStore } from '../stores/uiStore';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: 1 } } });
import { AppShell } from './AppShell';

export function App() {
  const setRuntime = useRuntimeStore((state) => state.setRuntime);
  const applyEvents = useRuntimeStore((state) => state.applyEvents);
  const projectPath = useRuntimeStore((state) => state.runtime.project?.path ?? null);
  const initializeWorkspace = useWorkspaceStore((state) => state.initialize);

  useEffect(() => {
    void initializeWorkspace(projectPath);
  }, [initializeWorkspace, projectPath]);

  useEffect(() => {
    if (!('piDesktop' in window) || typeof window.piDesktop.getSettings !== 'function') return;
    void window.piDesktop.getSettings().then((settings) => {
      document.documentElement.dataset.reduceMotion = String(settings.reduceMotion);
      document.documentElement.dataset.appearance = settings.appearance;
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!('piDesktop' in window)) return;
    let cancelled = false;
    let hydrating = true;
    const bufferedEvents: Parameters<typeof applyEvents>[0] = [];
    const unsubscribe = window.piDesktop.onEvents((events) => {
      if (hydrating) bufferedEvents.push(...events);
      else applyEvents(events);
    });

    void window.piDesktop.getRuntimeState().then((runtime) => {
      if (cancelled) return;
      setRuntime(runtime);
      hydrating = false;
      if (bufferedEvents.length > 0) applyEvents(bufferedEvents);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyEvents, setRuntime]);

  useEffect(() => {
    if (!('piDesktop' in window)) return;
    const run = (command: AppCommand) => {
      const ui = useUiStore.getState();
      const runtime = useRuntimeStore.getState().runtime;
      if (command === 'open-project') void window.piDesktop.selectProject().then(setRuntime);
      else if (command === 'new-session' && runtime.project && !runtime.streaming) void window.piDesktop.newSession().then(setRuntime);
      else if (command === 'focus-composer') document.querySelector<HTMLTextAreaElement>('#pi-composer')?.focus();
      else if (command === 'stop-generation' && runtime.streaming) void window.piDesktop.abort();
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
      const primary = event.metaKey || event.ctrlKey;
      let command: AppCommand | null = null;
      if (primary && event.key.toLocaleLowerCase() === 'k') command = 'open-palette';
      else if (primary && event.key === '`') command = 'open-terminal';
      else if (primary && event.key === ',') command = 'open-settings';
      else if (primary && event.key.toLocaleLowerCase() === 'b' && event.shiftKey) command = 'toggle-inspector';
      else if (primary && event.key.toLocaleLowerCase() === 'b') command = 'toggle-sidebar';
      else if (primary && event.key.toLocaleLowerCase() === 'o') command = 'open-project';
      else if (primary && event.key.toLocaleLowerCase() === 'n') command = 'new-session';
      else if (event.key === 'Escape' && !useUiStore.getState().paletteOpen && !useUiStore.getState().settingsOpen) command = 'stop-generation';
      if (command) { event.preventDefault(); run(command); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { unsubscribe(); window.removeEventListener('keydown', onKeyDown); };
  }, [setRuntime]);

  return (
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>
        <AppShell />
        <CommandPalette />
        <SettingsDialog />
      </Tooltip.Provider>
    </QueryClientProvider>
  );
}
