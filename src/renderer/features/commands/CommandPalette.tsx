import * as Dialog from '@radix-ui/react-dialog';
import { Bot, Brain, FolderOpen, PanelLeft, PanelRight, Search, Settings, Square, TerminalSquare, X, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { RuntimeState } from '../../../shared/contracts/ipc';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';

interface Command { id: string; label: string; hint?: string; icon: LucideIcon; disabled?: boolean; run: () => void }

export function CommandPalette() {
  const open = useUiStore((state) => state.paletteOpen);
  const setOpen = useUiStore((state) => state.setPaletteOpen);
  const actions = useUiStore(useShallow((ui) => ({
    toggleSidebar: ui.toggleSidebar,
    toggleInspector: ui.toggleInspector,
    toggleTerminal: ui.toggleTerminal,
    setSettingsOpen: ui.setSettingsOpen,
    setSidebarCollapsed: ui.setSidebarCollapsed,
  })));
  const runtime = useRuntimeStore(useShallow((state) => ({
    project: state.runtime.project,
    streaming: state.runtime.streaming,
    sessionOperation: state.runtime.sessionOperation,
    models: state.runtime.models,
  })));
  const setRuntime = useRuntimeStore((state) => state.setRuntime);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const operationBusy = useRef(false);

  const commands = useMemo<Command[]>(() => {
    const invoke = (operation: () => Promise<RuntimeState>, revealSessions = false) => {
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
          if (revealSessions && state.project) actions.setSidebarCollapsed(false);
        }
      }).catch(() => undefined).finally(() => { operationBusy.current = false; });
    };
    const base: Command[] = [
      { id: 'open-project', label: 'Open project', hint: 'Ctrl/⌘ O', icon: FolderOpen, run: () => { if ('piDesktop' in window) invoke(() => window.piDesktop.selectProject(), true); } },
      { id: 'new-session', label: 'New session', hint: 'Ctrl/⌘ N', icon: Bot, disabled: !runtime.project || runtime.sessionOperation === true, run: () => { if ('piDesktop' in window) invoke(() => window.piDesktop.newSession()); } },
      { id: 'focus-composer', label: 'Focus composer', icon: Search, run: () => document.querySelector<HTMLTextAreaElement>('#pi-composer')?.focus() },
      { id: 'stop', label: 'Stop generation', hint: 'Esc', icon: Square, disabled: !runtime.streaming, run: () => { if ('piDesktop' in window) void window.piDesktop.abort(); } },
      { id: 'sidebar', label: 'Toggle sidebar', hint: 'Ctrl/⌘ B', icon: PanelLeft, run: actions.toggleSidebar },
      { id: 'inspector', label: 'Toggle inspector', icon: PanelRight, run: actions.toggleInspector },
      { id: 'terminal', label: 'Toggle manual terminal', hint: 'Ctrl/⌘ `', icon: TerminalSquare, disabled: !runtime.project?.trusted, run: actions.toggleTerminal },
      { id: 'settings', label: 'Open settings', hint: 'Ctrl/⌘ ,', icon: Settings, run: () => actions.setSettingsOpen(true) },
    ];
    for (const model of runtime.models) base.push({
      id: `model:${model.provider}/${model.id}`, label: `Use model: ${model.name}`, icon: Bot,
      run: () => { if ('piDesktop' in window) invoke(() => window.piDesktop.setModel(model.provider, model.id)); },
    });
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) base.push({
      id: `thinking:${level}`, label: `Thinking level: ${level}`, icon: Brain,
      disabled: runtime.streaming, run: () => { if ('piDesktop' in window) invoke(() => window.piDesktop.setThinkingLevel(level)); },
    });
    return base;
  }, [actions, runtime, setRuntime]);

  const filtered = useMemo(
    () => commands.filter((command) => command.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())),
    [commands, query],
  );
  const activeIndex = filtered.length === 0 ? 0 : Math.min(selectedIndex, filtered.length - 1);
  const activeCommand = filtered[activeIndex];

  useEffect(() => {
    if (!open || filtered.length === 0) return;
    document.getElementById(`palette-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, filtered.length, open]);

  const runCommand = (command: Command | undefined) => {
    if (!command || command.disabled) return;
    command.run();
    setQuery('');
    setSelectedIndex(0);
    setOpen(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => {
      setOpen(next);
      if (!next) { setQuery(''); setSelectedIndex(0); }
    }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="command-palette" aria-describedby="command-description">
          <Dialog.Title className="visually-hidden">Command palette</Dialog.Title>
          <Dialog.Description id="command-description" className="visually-hidden">Search and run Fate UI commands</Dialog.Description>
          <div className="palette-search">
            <Search size={16} />
            <input
              autoFocus
              value={query}
              className="icon-label"
              aria-label="Search commands"
              aria-controls="command-palette-results"
              aria-activedescendant={activeCommand ? `palette-option-${activeIndex}` : undefined}
              placeholder="Type a command…"
              onChange={(event) => { setQuery(event.target.value); setSelectedIndex(0); }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  if (filtered.length > 0) {
                    const offset = event.key === 'ArrowDown' ? 1 : -1;
                    setSelectedIndex((activeIndex + offset + filtered.length) % filtered.length);
                  }
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  runCommand(activeCommand);
                }
              }}
            />
            <Dialog.Close aria-label="Close command palette"><X size={15} /></Dialog.Close>
          </div>
          <div id="command-palette-results" className="palette-list" role="listbox" aria-label="Commands">
            {filtered.map((command, index) => {
              const Icon = command.icon;
              return (
                <button
                  id={`palette-option-${index}`}
                  key={command.id}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  data-active={index === activeIndex}
                  disabled={command.disabled}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => runCommand(command)}
                >
                  <Icon size={15} /><span className="icon-label">{command.label}</span>{command.hint && <kbd className="icon-label">{command.hint}</kbd>}
                </button>
              );
            })}
            {filtered.length === 0 && <p>No commands match “{query.trim()}”</p>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
