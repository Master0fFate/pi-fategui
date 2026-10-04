import { getTerminalApiOptional, getWebApiOptional, hasCapability } from '../../platform/api';
import { MANUAL_TERMINAL_WARNING, type ManualTerminalApi } from '../../../shared/contracts/terminal';
import { unavailableExplanation } from '../../platform/capabilityPolicy';
import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { TerminalSquare, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { writeClipboardText } from '../../lib/clipboard';
import { useUiStore } from '../../stores/uiStore';

export function TerminalPanel() {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [start, setStart] = useState<{ api: ManualTerminalApi; scope: string } | null>(null);
  const setOpen = useUiStore((state) => state.setTerminalOpen);
  const api = getTerminalApiOptional();
  const web = getWebApiOptional();
  const scope = web ? `${web.serverEpoch}:${web.workspace?.workspaceId}:${web.workspace?.workspaceGeneration}:${web.control}` : 'local-desktop';
  const approved = Boolean(api && start && start.api === api && start.scope === scope);
  const canStart = Boolean(api && (!web || web.isConnected && web.workspace && web.control !== null));
  const executionHost = web ? `${web.hostName ?? 'Fate host'} · ${web.origin} · ${web.workspace?.label ?? 'No workspace selected'}` : 'This computer';

  useEffect(() => {
    if (!host.current || !approved || !api) return;
    const terminalTheme = () => {
      const style = getComputedStyle(document.documentElement);
      return {
        background: style.getPropertyValue('--theme-canvas').trim(),
        foreground: style.getPropertyValue('--theme-text').trim(),
        cursor: style.getPropertyValue('--theme-accent').trim(),
        selectionBackground: style.getPropertyValue('--theme-accent-soft').trim(),
      };
    };
    const terminalFont = () => getComputedStyle(document.documentElement).getPropertyValue('--font-code').trim()
      || '"JetBrains Mono Variable", "Noto Sans Mono Variable", ui-monospace, Consolas, monospace';
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: terminalFont(),
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5_000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    fit.fit();
    terminal.attachCustomKeyEventHandler((event) => {
      const copyShortcut = event.key.toLowerCase() === 'c'
        && ((event.ctrlKey && event.shiftKey && !event.altKey) || (event.metaKey && !event.ctrlKey && !event.altKey));
      if (event.type !== 'keydown' || !copyShortcut) return true;
      const selection = terminal.getSelection();
      if (!selection) return true;
      event.preventDefault();
      event.stopPropagation();
      void writeClipboardText(selection).catch(() => {
        useUiStore.getState().showToast({ kind: 'error', title: 'Copy failed', message: 'The system clipboard is unavailable.' });
      });
      return false;
    });
    let terminalId: string | null = null;
    let disposed = false;
    let resizeFrame: number | null = null;
    let lastSentColumns = terminal.cols;
    let lastSentRows = terminal.rows;
    const fail = (reason: unknown) => {
      if (disposed) return;
      setError(reason instanceof Error ? reason.message : 'The terminal connection failed. Input was not replayed.');
      terminal.options.disableStdin = true;
      const id = terminalId; terminalId = null;
      if (id) void api.closeTerminal(id).catch(() => undefined);
    };
    const fitAndSync = () => {
      resizeFrame = null;
      if (disposed) return;
      fit.fit();
      if (!terminalId || (terminal.cols === lastSentColumns && terminal.rows === lastSentRows)) return;
      lastSentColumns = terminal.cols;
      lastSentRows = terminal.rows;
      void api.resizeTerminal(terminalId, terminal.cols, terminal.rows).catch(fail);
    };
    const scheduleFit = () => {
      if (resizeFrame !== null) return;
      resizeFrame = requestAnimationFrame(fitAndSync);
    };
    const unsubscribe = api.onTerminalEvent((event) => {
      if (disposed || event.id !== terminalId) return;
      if (event.type === 'data') {
        terminal.write(event.data, () => {
          if (!disposed && terminalId === event.id) void api.acknowledgeTerminal(event.id, event.data.length).catch(fail);
        });
      } else {
        terminalId = null;
        terminal.options.disableStdin = true;
        if (event.exitCode === -1) setError('Manual terminal connection closed. Input was not replayed. Reopen the panel to start a new shell.');
        else terminal.writeln(`\r\n[manual terminal exited: ${event.exitCode}]`);
      }
    });
    const input = terminal.onData((data) => {
      if (terminalId) void api.writeTerminal(terminalId, data).catch(fail);
    });
    const resize = new ResizeObserver(scheduleFit);
    resize.observe(host.current);
    const syncTheme = () => { terminal.options.theme = terminalTheme(); };
    const syncFont = () => {
      terminal.options.fontFamily = terminalFont();
      scheduleFit();
    };
    window.addEventListener('fate-theme-change', syncTheme);
    window.addEventListener('fate-font-change', syncFont);

    void api.createTerminal(terminal.cols, terminal.rows).then((created) => {
      if (disposed) {
        void api.closeTerminal(created.id).catch(() => undefined);
        return;
      }
      terminalId = created.id;
      // The container or selected font may have changed while the PTY was being
      // created. Re-fit once and synchronize only if its requested size is stale.
      scheduleFit();
      terminal.focus();
    }).catch(fail);

    return () => {
      disposed = true;
      resize.disconnect();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      window.removeEventListener('fate-theme-change', syncTheme);
      window.removeEventListener('fate-font-change', syncFont);
      input.dispose();
      unsubscribe();
      terminal.dispose();
      if (terminalId) void api.closeTerminal(terminalId).catch(() => undefined);
    };
  }, [api, approved, start]);

  return (
    <section className="terminal-panel" aria-label="Manual integrated terminal">
      <header><span><TerminalSquare size={14} /><span className="icon-label">Terminal</span></span><em title={executionHost}>Unsandboxed · {web?.hostName ?? 'This computer'}</em><button type="button" aria-label="Close terminal" onClick={() => setOpen(false)}><X size={14} /></button></header>
      {!hasCapability('manualTerminal') || !api ? <div className="terminal-error">{unavailableExplanation.manualTerminal}</div>
        : !approved ? <div className="terminal-error">
          <strong>Manual shell · {executionHost}</strong>
          <p>{MANUAL_TERMINAL_WARNING}</p>
          {web && !canStart && <p>Claim control of a connected workspace before starting.</p>}
          <button type="button" onClick={() => setOpen(false)}>Cancel</button>
          <button type="button" disabled={!canStart} onClick={() => { setError(null); setStart({ api, scope }); }}>Start manual shell</button>
        </div> : <>{error && <div className="terminal-error" role="alert">{error}</div>}<div ref={host} className="terminal-host" /></>}
    </section>
  );
}
