import type { TerminalEvent } from '../shared/contracts/ipc';
import type { ManualTerminalApi } from '../shared/contracts/terminal';
import { terminalClientFrameSchema, terminalServerFrameSchema, type TerminalClientFrame,
  type TerminalCreated, type TerminalScope } from '../shared/protocol/terminal';

export interface ScopedTerminalApi extends Omit<ManualTerminalApi, 'createTerminal'> {
  createTerminal(scope: TerminalScope, cols: number, rows: number): Promise<TerminalCreated>;
  closeAll(): void;
}
interface OutputWindow {
  nextSequence: number;
  outstanding: number;
  readonly pending: Array<{ sequence: number; characters: number }>;
  timer: ReturnType<typeof setTimeout> | null;
}
const CREATE_TIMEOUT_MS = 5_000;
const CONSUMPTION_TIMEOUT_MS = 15_000;
const MAX_PENDING_ACKS = 512;
const MAX_OUTSTANDING_CHARACTERS = 576 * 1024;

/** No input queue, persistence or replay. The owning WebSocket is the lifetime.
 * Only one creation can be outstanding because terminal.created has no request ID. */
export class BrowserTerminalClient implements ScopedTerminalApi {
  private creating: { resolve: (value: TerminalCreated) => void; reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly terminals = new Map<string, OutputWindow>();
  private listener: ((event: TerminalEvent) => void) | null = null;

  constructor(private readonly send: (frame: TerminalClientFrame) => void,
    private readonly abortConnection: () => void) {}

  async createTerminal(scope: TerminalScope, cols: number, rows: number): Promise<TerminalCreated> {
    const frame = terminalClientFrameSchema.parse({ protocol: 1, type: 'terminal.create', ...scope, cols, rows });
    if (this.creating) throw new Error('A manual terminal is already starting. No second request was sent.');
    if (this.terminals.size >= 4) throw new Error('Close a manual terminal before opening another.');
    return new Promise<TerminalCreated>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.disconnect(new Error('Manual terminal creation timed out. Nothing will be replayed.'));
        // A late uncorrelated result cannot be assigned to a new creation. Host disconnect kills it.
        this.abortConnection();
      }, CREATE_TIMEOUT_MS);
      this.creating = { resolve, reject, timer };
      try { this.send(frame); }
      catch (error) {
        this.disconnect(error instanceof Error ? error : new Error('Manual terminal creation failed.'));
        this.abortConnection();
      }
    });
  }

  accept(value: unknown): void {
    const frame = terminalServerFrameSchema.parse(value);
    if (frame.type === 'terminal.created') {
      const waiting = this.creating;
      if (!waiting || this.terminals.has(frame.result.id)) throw new Error('Uncorrelated terminal creation.');
      this.creating = null; clearTimeout(waiting.timer);
      this.terminals.set(frame.result.id, { nextSequence: 1, outstanding: 0, pending: [], timer: null });
      waiting.resolve(frame.result);
      return;
    }
    const event = frame.event;
    const terminal = this.terminals.get(event.id);
    // Output already in transit after a local close is discarded, never ACKed or reused.
    if (!terminal) return;
    if (event.type === 'exit') { this.forget(event.id); this.listener?.(event); return; }
    if (event.sequence !== terminal.nextSequence || terminal.pending.length >= MAX_PENDING_ACKS
      || terminal.outstanding + event.data.length > MAX_OUTSTANDING_CHARACTERS) {
      throw new Error('Terminal output lost ordering or exceeded its consumption window.');
    }
    terminal.nextSequence++;
    terminal.pending.push({ sequence: event.sequence, characters: event.data.length });
    terminal.outstanding += event.data.length;
    this.armConsumptionTimeout(event.id, terminal);
    this.listener?.({ type: 'data', id: event.id, data: event.data });
  }

  async writeTerminal(id: string, data: string): Promise<void> {
    this.owned(id);
    this.send(terminalClientFrameSchema.parse({ protocol: 1, type: 'terminal.write', id, data }));
  }
  async resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
    this.owned(id);
    this.send(terminalClientFrameSchema.parse({ protocol: 1, type: 'terminal.resize', id, cols, rows }));
  }
  async acknowledgeTerminal(id: string, characters: number): Promise<void> {
    const terminal = this.owned(id);
    const first = terminal.pending[0];
    if (!first || first.characters !== characters) throw new Error('Terminal acknowledgment does not match the next output chunk.');
    this.send(terminalClientFrameSchema.parse({ protocol: 1, type: 'terminal.ack', id, sequence: first.sequence, characters }));
    terminal.pending.shift(); terminal.outstanding -= characters;
    if (terminal.timer) clearTimeout(terminal.timer);
    terminal.timer = null;
    if (terminal.pending.length) this.armConsumptionTimeout(id, terminal);
  }
  async closeTerminal(id: string): Promise<void> {
    if (!this.terminals.has(id)) return; // Cleanup after exit/disconnect never addresses an old ID on a new socket.
    this.forget(id);
    this.send(terminalClientFrameSchema.parse({ protocol: 1, type: 'terminal.close', id }));
  }
  onTerminalEvent(listener: (event: TerminalEvent) => void): () => void {
    if (this.listener) throw new Error('The manual terminal output already has a consumer.');
    this.listener = listener;
    return () => {
      if (this.listener !== listener) return;
      this.listener = null;
      this.closeAll(); // No detached browser shell or pending creation without its sole output consumer.
    };
  }
  closeAll(): void {
    if (this.creating) {
      this.disconnect(new Error('Manual terminal scope or control changed while starting.'));
      this.abortConnection();
      return;
    }
    for (const id of [...this.terminals.keys()]) this.end(id);
  }
  disconnect(error = new Error('Manual terminal connection closed. Input was not replayed.')): void {
    const waiting = this.creating; this.creating = null;
    if (waiting) { clearTimeout(waiting.timer); waiting.reject(error); }
    for (const id of [...this.terminals.keys()]) {
      this.forget(id);
      this.emitClosed(id);
    }
  }
  private owned(id: string): OutputWindow {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error('Manual terminal is closed or belongs to a former connection.');
    return terminal;
  }
  private forget(id: string): void {
    const terminal = this.terminals.get(id);
    if (terminal?.timer) clearTimeout(terminal.timer);
    this.terminals.delete(id);
  }
  private end(id: string): void {
    if (!this.terminals.has(id)) return;
    this.forget(id);
    try { this.send({ protocol: 1, type: 'terminal.close', id }); }
    catch { this.abortConnection(); } // Uncertain cleanup retires the connection; never queue a retry.
    this.emitClosed(id);
  }
  private emitClosed(id: string): void {
    // -1 denotes local channel closure, not a confirmed host process exit code.
    try { this.listener?.({ type: 'exit', id, exitCode: -1 }); }
    catch { /* A failed consumer must not interrupt timer and connection teardown. */ }
  }
  private armConsumptionTimeout(id: string, terminal: OutputWindow): void {
    if (!terminal.timer) terminal.timer = setTimeout(() => this.end(id), CONSUMPTION_TIMEOUT_MS);
  }
}
