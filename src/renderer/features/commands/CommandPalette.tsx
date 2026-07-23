import * as Dialog from '@radix-ui/react-dialog';
import { Bot, Brain, FolderOpen, PanelLeft, PanelRight, Search, Settings, Square, TerminalSquare, X, type LucideIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';

interface Command { id: string; label: string; hint?: string; icon: LucideIcon; disabled?: boolean; run: () => void }

export function CommandPalette() {
  const open = useUiStore((state) => state.paletteOpen);
  const setOpen = useUiStore((state) => state.setPaletteOpen);
  const ui = useUiStore();
  const runtime = useRuntimeStore((state) => state.runtime);
  const setRuntime = useRuntimeStore((state) => state.setRuntime);
  const [query, setQuery] = useState('');

  const commands = useMemo<Command[]>(() => {
    const invoke = (operation: Promise<typeof runtime>) => { void operation.then(setRuntime).catch(() => undefined); };
    const base: Command[] = [
      { id: 'open-project', label: 'Open project', hint: 'Ctrl/⌘ O', icon: FolderOpen, run: () => { if ('piDesktop' in window) invoke(window.piDesktop.selectProject()); } },
      { id: 'new-session', label: 'New session', hint: 'Ctrl/⌘ N', icon: Bot, disabled: !runtime.project || runtime.streaming, run: () => { if ('piDesktop' in window) invoke(window.piDesktop.newSession()); } },
      { id: 'focus-composer', label: 'Focus composer', icon: Search, run: () => document.querySelector<HTMLTextAreaElement>('#pi-composer')?.focus() },
      { id: 'stop', label: 'Stop generation', hint: 'Esc', icon: Square, disabled: !runtime.streaming, run: () => { if ('piDesktop' in window) void window.piDesktop.abort(); } },
      { id: 'sidebar', label: 'Toggle sidebar', hint: 'Ctrl/⌘ B', icon: PanelLeft, run: ui.toggleSidebar },
      { id: 'inspector', label: 'Toggle inspector', icon: PanelRight, run: ui.toggleInspector },
      { id: 'terminal', label: 'Toggle manual terminal', hint: 'Ctrl/⌘ `', icon: TerminalSquare, disabled: !runtime.project?.trusted, run: ui.toggleTerminal },
      { id: 'settings', label: 'Open settings', hint: 'Ctrl/⌘ ,', icon: Settings, run: () => ui.setSettingsOpen(true) },
    ];
    for (const model of runtime.models) base.push({
      id: `model:${model.provider}/${model.id}`, label: `Use model: ${model.name}`, icon: Bot,
      disabled: runtime.streaming, run: () => { if ('piDesktop' in window) invoke(window.piDesktop.setModel(model.provider, model.id)); },
    });
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) base.push({
      id: `thinking:${level}`, label: `Thinking level: ${level}`, icon: Brain,
      disabled: runtime.streaming, run: () => { if ('piDesktop' in window) invoke(window.piDesktop.setThinkingLevel(level)); },
    });
    return base;
  }, [runtime, setRuntime, ui]);

  const filtered = commands.filter((command) => command.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(''); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="command-palette" aria-describedby="command-description">
          <Dialog.Title className="visually-hidden">Command palette</Dialog.Title>
          <Dialog.Description id="command-description" className="visually-hidden">Search and run Pi Desktop commands</Dialog.Description>
          <div className="palette-search"><Search size={16} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Type a command…" aria-label="Search commands" /><Dialog.Close aria-label="Close command palette"><X size={15} /></Dialog.Close></div>
          <div className="palette-list" role="listbox" aria-label="Commands">
            {filtered.map((command) => { const Icon = command.icon; return <button key={command.id} type="button" role="option" disabled={command.disabled} onClick={() => { command.run(); setOpen(false); }}><Icon size={15} /><span>{command.label}</span>{command.hint && <kbd>{command.hint}</kbd>}</button>; })}
            {filtered.length === 0 && <p>No matching commands</p>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
