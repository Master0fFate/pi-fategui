import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import type { TerminalEvent } from '../../shared/contracts/ipc';
import type { FilesystemService } from '../files/FilesystemService';
import type { AppLogService } from '../logging/AppLogService';
import type { PiRuntimeService } from '../pi/PiRuntimeService';
import type { SettingsService } from '../settings/SettingsService';

interface OwnedTerminal {
  ownerId: number;
  process: pty.IPty;
  buffered: string;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
}

export class TerminalService {
  private readonly terminals = new Map<string, OwnedTerminal>();
  private sink: (ownerId: number, event: TerminalEvent) => void = () => undefined;

  constructor(
    private readonly files: FilesystemService,
    private readonly runtime: PiRuntimeService,
    private readonly settings: SettingsService,
    private readonly logs: AppLogService,
  ) {}

  setEventSink(sink: (ownerId: number, event: TerminalEvent) => void): void {
    this.sink = sink;
  }

  create(ownerId: number, cols: number, rows: number): { id: string; shell: string; cwd: string } {
    const project = this.runtime.getState(false).project;
    if (!project?.trusted) throw new Error('Open and trust a project before starting a manual terminal.');
    const cwd = this.files.getRoot();
    const shell = this.resolveShell();
    const id = randomUUID();
    const processHandle = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    const owned: OwnedTerminal = { ownerId, process: processHandle, buffered: '', flushTimer: undefined };
    this.terminals.set(id, owned);
    processHandle.onData((data) => {
      owned.buffered += data;
      if (owned.buffered.length >= 65_536) this.flush(id, owned);
      else if (!owned.flushTimer) owned.flushTimer = setTimeout(() => this.flush(id, owned), 16);
    });
    processHandle.onExit(({ exitCode, signal }) => {
      this.flush(id, owned);
      this.terminals.delete(id);
      this.sink(ownerId, { type: 'exit', id, exitCode, ...(signal === undefined ? {} : { signal }) });
      this.logs.write('info', 'terminal', `Manual terminal exited with code ${exitCode}.`);
    });
    this.logs.write('info', 'terminal', `Manual terminal started with ${shell}.`);
    return { id, shell, cwd };
  }

  write(ownerId: number, id: string, data: string): void {
    this.owned(ownerId, id).process.write(data);
  }

  resize(ownerId: number, id: string, cols: number, rows: number): void {
    this.owned(ownerId, id).process.resize(cols, rows);
  }

  close(ownerId: number, id: string): void {
    const terminal = this.owned(ownerId, id);
    this.terminals.delete(id);
    if (terminal.flushTimer) clearTimeout(terminal.flushTimer);
    terminal.process.kill();
  }

  disposeOwner(ownerId: number): void {
    for (const [id, terminal] of this.terminals) {
      if (terminal.ownerId === ownerId) this.close(ownerId, id);
    }
  }

  dispose(): void {
    for (const [id, terminal] of this.terminals) this.close(terminal.ownerId, id);
  }

  private owned(ownerId: number, id: string): OwnedTerminal {
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.ownerId !== ownerId) throw new Error('Terminal session is unavailable.');
    return terminal;
  }

  private flush(id: string, terminal: OwnedTerminal): void {
    if (terminal.flushTimer) clearTimeout(terminal.flushTimer);
    terminal.flushTimer = undefined;
    while (terminal.buffered.length > 0) {
      const data = terminal.buffered.slice(0, 65_536);
      terminal.buffered = terminal.buffered.slice(data.length);
      this.sink(terminal.ownerId, { type: 'data', id, data });
    }
  }

  private resolveShell(): string {
    const configured = this.settings.get().terminalShell?.trim();
    if (configured) return configured;
    if (process.platform === 'win32') return process.env.ComSpec || 'powershell.exe';
    return process.env.SHELL || '/bin/bash';
  }
}
