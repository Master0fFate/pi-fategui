import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
import type { TerminalEvent } from '../../shared/contracts/ipc';
import type { FilesystemService } from '../files/FilesystemService';
import type { AppLogService } from '../logging/AppLogService';
import type { PiRuntimeService } from '../pi/PiRuntimeService';
import type { SettingsService } from '../settings/SettingsService';

interface OwnedTerminal {
  ownerId: number;
  projectPath: string;
  process: pty.IPty;
  buffered: string;
  outstandingBytes: number;
  paused: boolean;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  dataSubscription?: pty.IDisposable;
  exitSubscription?: pty.IDisposable;
  closing: boolean;
}

export function resolveTerminalShell(configured: string | null | undefined, projectRoot: string): string {
  const requested = configured?.trim();
  const candidates: string[] = [];
  if (requested && path.isAbsolute(requested)) candidates.push(requested);
  else if (requested && /^[A-Za-z0-9._+-]+$/u.test(requested)) {
    if (process.platform === 'win32') {
      const locator = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');
      try { candidates.push(...execFileSync(locator, [requested], { cwd: homedir(), encoding: 'utf8', windowsHide: true }).split(/\r?\n/u)); } catch { /* Fall through. */ }
    } else {
      try { candidates.push(...execFileSync('/usr/bin/which', [requested], { cwd: homedir(), encoding: 'utf8' }).split(/\r?\n/u)); } catch { /* Fall through. */ }
    }
  }
  if (!requested) {
    if (process.platform === 'win32') candidates.push(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe');
    else candidates.push(process.env.SHELL || '/bin/bash', '/bin/bash', '/bin/zsh');
  }
  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate) || !existsSync(candidate)) continue;
    const canonical = realpathSync(candidate);
    const relative = path.relative(projectRoot, canonical);
    const insideProject = relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    if (!insideProject && statSync(canonical).isFile()) return canonical;
  }
  throw new Error('Configure an installed shell outside the active project directory.');
}

/** Start the same interactive PTY used by the app, exchange data, and exit. */
export async function smokeTerminalRuntime(projectRoot: string, timeoutMs = 15_000): Promise<string> {
  const cwd = path.resolve(projectRoot);
  const shell = resolveTerminalShell(undefined, cwd);
  const marker = `FATE_PTY_SMOKE_${randomUUID().replace(/-/gu, '')}`;
  const processHandle = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  await new Promise<void>((resolve, reject) => {
    let output = '';
    let settled = false;
    let dataSubscription: pty.IDisposable | undefined;
    let exitSubscription: pty.IDisposable | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      dataSubscription?.dispose();
      exitSubscription?.dispose();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      try { processHandle.kill(); } catch { /* The PTY may already be exiting. */ }
      finish(new Error(`Manual terminal PTY smoke timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    dataSubscription = processHandle.onData((data) => {
      output = `${output}${data}`.slice(-65_536);
    });
    exitSubscription = processHandle.onExit(({ exitCode }) => {
      if (exitCode !== 0) finish(new Error(`Manual terminal PTY smoke exited with code ${exitCode}.`));
      else if (!output.includes(marker)) finish(new Error('Manual terminal PTY smoke did not exchange data with the shell.'));
      else finish();
    });
    processHandle.write(process.platform === 'win32'
      ? `echo ${marker}\r\nexit\r\n`
      : `printf '${marker}\\n'\nexit\n`);
  });
  return shell;
}

const TERMINAL_CHUNK_CHARACTERS = 65_536;
const TERMINAL_HIGH_WATER_CHARACTERS = 512 * 1024;
const TERMINAL_LOW_WATER_CHARACTERS = 128 * 1024;
const TERMINAL_BUFFER_CHARACTERS = 1024 * 1024;
const TERMINAL_FLUSH_BURST = 4;

export class TerminalService {
  private readonly terminals = new Map<string, OwnedTerminal>();
  private sink: (ownerId: number, event: TerminalEvent) => void = () => undefined;

  constructor(
    private readonly files: FilesystemService,
    private readonly runtime: PiRuntimeService,
    private readonly settings: SettingsService,
    private readonly logs: AppLogService,
    private readonly shellResolver: (configured: string | null | undefined, projectRoot: string) => string = resolveTerminalShell,
  ) {}

  setEventSink(sink: (ownerId: number, event: TerminalEvent) => void): void {
    this.sink = sink;
  }

  create(ownerId: number, cols: number, rows: number): { id: string; shell: string; cwd: string } {
    const project = this.runtime.getState(false).project;
    if (!project?.trusted) throw new Error('Open and trust a project before starting a manual terminal.');
    const cwd = this.files.getRoot();
    const shell = this.resolveShell(cwd);
    const id = randomUUID();
    const processHandle = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    const owned: OwnedTerminal = { ownerId, projectPath: project.path, process: processHandle, buffered: '', outstandingBytes: 0, paused: false, flushTimer: undefined, closing: false };
    this.terminals.set(id, owned);
    owned.dataSubscription = processHandle.onData((data) => {
      if (owned.closing) return;
      owned.buffered += data;
      if (owned.buffered.length > TERMINAL_BUFFER_CHARACTERS) {
        const marker = '\r\n[terminal output truncated while the UI caught up]\r\n';
        owned.buffered = marker + owned.buffered.slice(-(TERMINAL_BUFFER_CHARACTERS - marker.length));
      }
      this.updateFlowControl(owned);
      if (owned.buffered.length >= TERMINAL_CHUNK_CHARACTERS) this.flush(id, owned);
      else this.scheduleFlush(id, owned);
    });
    owned.exitSubscription = processHandle.onExit(({ exitCode, signal }) => {
      if (owned.closing) return;
      this.flush(id, owned, true);
      this.terminals.delete(id);
      owned.closing = true;
      owned.dataSubscription?.dispose();
      owned.exitSubscription?.dispose();
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

  acknowledge(ownerId: number, id: string, characters: number): void {
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.ownerId !== ownerId || terminal.closing) return;
    terminal.outstandingBytes = Math.max(0, terminal.outstandingBytes - Math.max(0, characters));
    this.updateFlowControl(terminal);
    if (terminal.buffered.length > 0) this.flush(id, terminal);
  }

  close(ownerId: number, id: string): void {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    if (terminal.ownerId !== ownerId) throw new Error('Terminal session is unavailable.');
    if (terminal.closing) return;
    terminal.closing = true;
    this.terminals.delete(id);
    if (terminal.flushTimer) clearTimeout(terminal.flushTimer);
    terminal.flushTimer = undefined;
    terminal.buffered = '';
    terminal.dataSubscription?.dispose();
    terminal.exitSubscription?.dispose();
    terminal.process.kill();
  }

  disposeOwner(ownerId: number): void {
    for (const [id, terminal] of this.terminals) {
      if (terminal.ownerId === ownerId) this.close(ownerId, id);
    }
  }

  disposeProjectTerminals(): void {
    this.dispose();
  }

  dispose(): void {
    for (const [id, terminal] of this.terminals) this.close(terminal.ownerId, id);
  }

  private owned(ownerId: number, id: string): OwnedTerminal {
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.ownerId !== ownerId) throw new Error('Terminal session is unavailable.');
    const project = this.runtime.getState(false).project;
    if (!project?.trusted || project.path !== terminal.projectPath) {
      this.close(ownerId, id);
      throw new Error('Terminal session belongs to a different project.');
    }
    return terminal;
  }

  private flush(id: string, terminal: OwnedTerminal, drain = false): void {
    if (terminal.flushTimer) clearTimeout(terminal.flushTimer);
    terminal.flushTimer = undefined;
    let emitted = 0;
    while (
      terminal.buffered.length > 0
      && (drain || terminal.outstandingBytes < TERMINAL_HIGH_WATER_CHARACTERS)
      && (drain || emitted < TERMINAL_FLUSH_BURST)
    ) {
      const data = terminal.buffered.slice(0, TERMINAL_CHUNK_CHARACTERS);
      terminal.buffered = terminal.buffered.slice(data.length);
      terminal.outstandingBytes += data.length;
      emitted += 1;
      this.sink(terminal.ownerId, { type: 'data', id, data });
    }
    this.updateFlowControl(terminal);
    if (!drain && terminal.buffered.length > 0 && terminal.outstandingBytes < TERMINAL_HIGH_WATER_CHARACTERS) this.scheduleFlush(id, terminal);
  }

  private scheduleFlush(id: string, terminal: OwnedTerminal): void {
    if (terminal.flushTimer || terminal.closing) return;
    terminal.flushTimer = setTimeout(() => this.flush(id, terminal), 16);
  }

  private updateFlowControl(terminal: OwnedTerminal): void {
    const queued = terminal.buffered.length + terminal.outstandingBytes;
    if (!terminal.paused && queued >= TERMINAL_HIGH_WATER_CHARACTERS) {
      terminal.process.pause();
      terminal.paused = true;
    } else if (terminal.paused && queued <= TERMINAL_LOW_WATER_CHARACTERS) {
      terminal.process.resume();
      terminal.paused = false;
    }
  }

  private resolveShell(projectRoot: string): string {
    return this.shellResolver(this.settings.get().terminalShell, projectRoot);
  }
}
