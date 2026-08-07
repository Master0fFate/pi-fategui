import * as Dialog from '@radix-ui/react-dialog';
import {
  Bot,
  Brain,
  FileCode2,
  FolderOpen,
  Globe2,
  Library,
  PanelLeft,
  PanelRight,
  Search,
  Settings,
  Square,
  TerminalSquare,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { RuntimeState } from '../../../shared/contracts/ipc';
import { openResource, useResourceSearch, type ResourceSearchItem } from '../resources/resourceSearch';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  disabled?: boolean;
  disabledReason?: string;
  run: () => void;
}

type PaletteEntry =
  | { id: string; kind: 'command'; command: Command }
  | { id: string; kind: 'resource'; resource: ResourceSearchItem };

export function CommandPalette() {
  const open = useUiStore((state) => state.paletteOpen);
  const setOpen = useUiStore((state) => state.setPaletteOpen);
  const actions = useUiStore(useShallow((ui) => ({
    toggleSidebar: ui.toggleSidebar,
    toggleInspector: ui.toggleInspector,
    toggleTerminal: ui.toggleTerminal,
    setSettingsOpen: ui.setSettingsOpen,
    setSidebarCollapsed: ui.setSidebarCollapsed,
    setSidebarTab: ui.setSidebarTab,
    showToast: ui.showToast,
  })));
  const runtime = useRuntimeStore(useShallow((state) => ({
    status: state.runtime.status,
    project: state.runtime.project,
    sessionId: state.runtime.sessionId,
    streaming: state.runtime.streaming,
    sessionOperation: state.runtime.sessionOperation,
    model: state.runtime.model,
    pendingModel: state.runtime.pendingModel,
    models: state.runtime.models,
  })));
  const setRuntime = useRuntimeStore((state) => state.setRuntime);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const operationBusy = useRef(false);
  const resources = useResourceSearch(query, open);

  const commands = useMemo<Command[]>(() => {
    const invoke = (label: string, operation: () => Promise<RuntimeState>, revealSessions = false) => {
      if (operationBusy.current) return;
      operationBusy.current = true;
      const origin = useRuntimeStore.getState().runtime;
      let pending: Promise<RuntimeState>;
      try {
        pending = operation();
      } catch (error) {
        pending = Promise.reject(error);
      }
      void pending.then((state) => {
        const current = useRuntimeStore.getState().runtime;
        const selectionMoved = current.sessionId !== origin.sessionId || current.project?.path !== origin.project?.path;
        const resultIsCurrent = current.sessionId === state.sessionId && current.project?.path === state.project?.path;
        if (!selectionMoved || resultIsCurrent) {
          setRuntime(state);
          if (revealSessions && state.project) {
            actions.setSidebarCollapsed(false);
            actions.setSidebarTab('sessions');
          }
        }
      }).catch((error: unknown) => {
        actions.showToast({ kind: 'error', title: `${label} failed`, message: commandErrorMessage(error) });
      }).finally(() => { operationBusy.current = false; });
    };
    const connected = runtime.status === 'ready';
    const effectiveModel = runtime.pendingModel ?? runtime.model;
    const newSessionReason = !runtime.project
      ? 'Open a project before creating a session.'
      : runtime.sessionOperation
        ? 'Wait for the current session change to finish.'
        : undefined;
    const focusReason = connected ? undefined : 'Open and trust a project before focusing the composer.';
    const modelReason = !connected || !runtime.sessionId ? 'Start a session before changing its model.' : undefined;
    const thinkingReason = modelReason ?? (!effectiveModel?.reasoning ? 'The model selected for the next message does not support reasoning.' : undefined);
    const terminalReason = runtime.project?.trusted ? undefined : 'Open and trust a project before opening the terminal.';
    const base: Command[] = [
      { id: 'open-project', label: 'Open project', hint: 'Ctrl/⌘ O', icon: FolderOpen, run: () => { if ('piDesktop' in window) invoke('Open project', () => window.piDesktop.selectProject(), true); } },
      { id: 'new-session', label: 'New session', hint: 'Ctrl/⌘ N', icon: Bot, disabled: Boolean(newSessionReason), ...(newSessionReason ? { disabledReason: newSessionReason } : {}), run: () => { if ('piDesktop' in window) invoke('New session', () => window.piDesktop.newSession(), true); } },
      { id: 'resources', label: 'Open resources', icon: Library, run: () => { actions.setSidebarCollapsed(false); actions.setSidebarTab('resources'); } },
      { id: 'automations', label: 'Open automations', icon: Workflow, run: () => { actions.setSidebarCollapsed(false); actions.setSidebarTab('automations'); } },
      { id: 'focus-composer', label: 'Focus composer', icon: Search, disabled: Boolean(focusReason), ...(focusReason ? { disabledReason: focusReason } : {}), run: () => document.querySelector<HTMLTextAreaElement>('#pi-composer')?.focus() },
      { id: 'stop', label: 'Stop generation', hint: 'Esc', icon: Square, disabled: !runtime.streaming, ...(!runtime.streaming ? { disabledReason: 'Nothing is currently generating.' } : {}), run: () => { if ('piDesktop' in window) void window.piDesktop.abort().catch((error: unknown) => actions.showToast({ kind: 'error', title: 'Stop generation failed', message: commandErrorMessage(error) })); } },
      { id: 'sidebar', label: 'Toggle sidebar', hint: 'Ctrl/⌘ B', icon: PanelLeft, run: actions.toggleSidebar },
      { id: 'inspector', label: 'Toggle inspector', icon: PanelRight, run: actions.toggleInspector },
      { id: 'terminal', label: 'Toggle manual terminal', hint: 'Ctrl/⌘ `', icon: TerminalSquare, disabled: Boolean(terminalReason), ...(terminalReason ? { disabledReason: terminalReason } : {}), run: actions.toggleTerminal },
      { id: 'settings', label: 'Open settings', hint: 'Ctrl/⌘ ,', icon: Settings, run: () => actions.setSettingsOpen(true) },
    ];
    for (const model of runtime.models) base.push({
      id: `model:${model.provider}/${model.id}`,
      label: `Use model: ${model.name}`,
      icon: Bot,
      disabled: Boolean(modelReason),
      ...(modelReason ? { disabledReason: modelReason } : {}),
      run: () => { if ('piDesktop' in window) invoke('Model change', () => window.piDesktop.setModel(model.provider, model.id)); },
    });
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) base.push({
      id: `thinking:${level}`,
      label: `Thinking level: ${level}`,
      icon: Brain,
      disabled: Boolean(thinkingReason),
      ...(thinkingReason ? { disabledReason: thinkingReason } : {}),
      run: () => { if ('piDesktop' in window) invoke('Thinking level change', () => window.piDesktop.setThinkingLevel(level)); },
    });
    return base;
  }, [actions, runtime, setRuntime]);

  const filteredCommands = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return commands
      .filter((command) => !needle || command.label.toLocaleLowerCase().includes(needle))
      .slice(0, needle ? 40 : 12);
  }, [commands, query]);
  const entries = useMemo<PaletteEntry[]>(() => [
    ...filteredCommands.map((command) => ({ id: `command:${command.id}`, kind: 'command' as const, command })),
    ...resources.items.map((resource) => ({ id: resource.id, kind: 'resource' as const, resource })),
  ], [filteredCommands, resources.items]);
  const activeIndex = entries.length === 0 ? 0 : Math.min(selectedIndex, entries.length - 1);
  const activeEntry = entries[activeIndex];

  useEffect(() => {
    if (!open || entries.length === 0) return;
    document.getElementById(`palette-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, entries.length, open]);

  const runEntry = (entry: PaletteEntry | undefined) => {
    if (!entry || (entry.kind === 'command' && entry.command.disabled)) return;
    if (entry.kind === 'command') entry.command.run();
    else void openResource(entry.resource);
    setQuery('');
    setSelectedIndex(0);
    setOpen(false);
  };

  const renderEntry = (entry: PaletteEntry, index: number) => {
    const command = entry.kind === 'command' ? entry.command : null;
    const resource = entry.kind === 'resource' ? entry.resource : null;
    const Icon = command?.icon ?? resourceIcon(resource!);
    const disabled = command?.disabled === true;
    return (
      <button
        id={`palette-option-${index}`}
        key={entry.id}
        type="button"
        role="option"
        aria-selected={index === activeIndex}
        data-active={index === activeIndex}
        data-kind={entry.kind}
        disabled={disabled}
        title={command?.disabledReason}
        aria-label={command?.label}
        aria-description={command?.disabledReason}
        onMouseEnter={() => setSelectedIndex(index)}
        onClick={() => runEntry(entry)}
      >
        <Icon size={15} />
        {command ? (
          <span className="icon-label">{command.label}</span>
        ) : (
          <span className="palette-item-copy"><strong>{resource!.title}</strong><small>{resource!.subtitle}</small></span>
        )}
        {command?.hint && <kbd className="icon-label">{command.hint}</kbd>}
        {resource && <em>{resourceKind(resource)}</em>}
      </button>
    );
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => {
      setOpen(next);
      if (!next) { setQuery(''); setSelectedIndex(0); }
    }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="command-palette" aria-describedby="command-description">
          <Dialog.Title className="visually-hidden">Command center</Dialog.Title>
          <Dialog.Description id="command-description" className="visually-hidden">Search commands and resources across Fate UI</Dialog.Description>
          <div className="palette-search">
            <Search size={16} />
            <input
              autoFocus
              value={query}
              className="icon-label"
              aria-label="Search commands and resources"
              aria-controls="command-palette-results"
              aria-activedescendant={activeEntry ? `palette-option-${activeIndex}` : undefined}
              placeholder="Search commands and resources…"
              onChange={(event) => { setQuery(event.target.value); setSelectedIndex(0); }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  if (entries.length > 0) {
                    const offset = event.key === 'ArrowDown' ? 1 : -1;
                    setSelectedIndex((activeIndex + offset + entries.length) % entries.length);
                  }
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  runEntry(activeEntry);
                }
              }}
            />
            <Dialog.Close aria-label="Close command center"><X size={15} /></Dialog.Close>
          </div>
          <div id="command-palette-results" className="palette-list" role="listbox" aria-label="Commands and resources">
            {filteredCommands.length > 0 && <div className="palette-group-label">Commands</div>}
            {filteredCommands.map((command, index) => renderEntry({ id: `command:${command.id}`, kind: 'command', command }, index))}
            {resources.items.length > 0 && <div className="palette-group-label">Resources</div>}
            {resources.items.map((resource, index) => renderEntry({ id: resource.id, kind: 'resource', resource }, filteredCommands.length + index))}
            {resources.searching && <div className="palette-searching"><span className="preview-spinner" /> Searching project files…</div>}
            {entries.length === 0 && !resources.searching && <p>No commands or resources match “{query.trim()}”</p>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function resourceIcon(resource: ResourceSearchItem): LucideIcon {
  if (resource.kind === 'file') return FileCode2;
  if (resource.kind === 'browser-tab') return Globe2;
  if (resource.kind === 'pi') return Library;
  if (resource.kind === 'automation') return Workflow;
  if (resource.kind === 'session') return Bot;
  if (resource.surface === 'files') return FileCode2;
  if (resource.surface === 'browser') return Globe2;
  if (resource.surface === 'terminal') return TerminalSquare;
  if (resource.surface === 'automations') return Workflow;
  return Library;
}

function commandErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'The command could not be completed.';
  try {
    const parsed = JSON.parse(error.message) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message : error.message;
  } catch {
    return error.message;
  }
}

function resourceKind(resource: ResourceSearchItem): string {
  if (resource.kind === 'browser-tab') return 'tab';
  if (resource.kind === 'pi') return resource.source === 'skill' ? 'skill' : 'Pi';
  if (resource.kind === 'automation') return 'automation';
  if (resource.kind === 'session') return 'session';
  if (resource.kind === 'file') return 'file';
  return 'resource';
}
