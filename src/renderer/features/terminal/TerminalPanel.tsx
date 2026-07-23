import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { TerminalSquare, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useUiStore } from '../../stores/uiStore';

export function TerminalPanel() {
  const host = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState('Manual terminal');
  const [error, setError] = useState<string | null>(null);
  const setOpen = useUiStore((state) => state.setTerminalOpen);

  useEffect(() => {
    if (!host.current || !('piDesktop' in window)) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'Cascadia Mono, Consolas, ui-monospace, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5_000,
      theme: { background: '#090c13', foreground: '#cdd2df', cursor: '#8b7dff', selectionBackground: '#514a8666' },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    fit.fit();
    let terminalId: string | null = null;
    let disposed = false;
    const unsubscribe = window.piDesktop.onTerminalEvent((event) => {
      if (event.id !== terminalId) return;
      if (event.type === 'data') terminal.write(event.data);
      else terminal.writeln(`\r\n[manual terminal exited: ${event.exitCode}]`);
    });
    const input = terminal.onData((data) => {
      if (terminalId) void window.piDesktop.writeTerminal(terminalId, data);
    });
    const resize = new ResizeObserver(() => {
      fit.fit();
      if (terminalId) void window.piDesktop.resizeTerminal(terminalId, terminal.cols, terminal.rows);
    });
    resize.observe(host.current);

    void window.piDesktop.createTerminal(terminal.cols, terminal.rows).then((created) => {
      if (disposed) {
        void window.piDesktop.closeTerminal(created.id);
        return;
      }
      terminalId = created.id;
      setTitle(`Manual terminal · ${created.shell}`);
      terminal.focus();
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'The terminal could not start.');
    });

    return () => {
      disposed = true;
      resize.disconnect();
      input.dispose();
      unsubscribe();
      terminal.dispose();
      if (terminalId) void window.piDesktop.closeTerminal(terminalId).catch(() => undefined);
    };
  }, []);

  return (
    <section className="terminal-panel" aria-label="Manual integrated terminal">
      <header><span><TerminalSquare size={14} />{title}</span><em>Separate from Pi tools</em><button type="button" aria-label="Close terminal" onClick={() => setOpen(false)}><X size={14} /></button></header>
      {error ? <div className="terminal-error" role="alert">{error}</div> : <div ref={host} className="terminal-host" />}
    </section>
  );
}
