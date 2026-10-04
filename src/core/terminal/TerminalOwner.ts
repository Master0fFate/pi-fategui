import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import type { IPty, IDisposable } from 'node-pty';
import { isAdapterCreatedContext, type RequestContext } from '../dispatch/RequestContext';
import type { WorkspaceRegistry } from '../workspaces/WorkspaceRegistry';
import type { WorkspaceControl } from '../security/WorkspaceControl';
import { terminalCreateInputSchema, terminalWriteInputSchema, terminalResizeInputSchema } from '../../shared/contracts/ipc';

export type HostTerminalEvent =
  | { readonly type: 'data'; readonly id: string; readonly sequence: number; readonly data: string }
  | { readonly type: 'exit'; readonly id: string; readonly exitCode: number; readonly signal?: number };

interface PendingCreate {
  readonly identity: RequestContext;
  readonly workspaceId: string;
  closed: boolean;
}

interface Terminal {
  readonly identity: RequestContext;
  readonly workspaceId: string;
  readonly workspaceGeneration: number;
  readonly controlGeneration: number;
  readonly root: string;
  readonly process: IPty;
  readonly pending: Map<number, number>;
  nextSequence: number;
  outstanding: number;
  buffered: string;
  paused: boolean;
  closed: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  data?: IDisposable;
  exit?: IDisposable;
}

/** Host-side manual shell. This is unsandboxed OS-user authority, NOT agent edit permission.
 * The network adapter must forward only live, adapter-created ticket contexts and must
 * call disconnect on socket/ticket loss. No input is journaled or replayed.
 */
export class TerminalOwner {
  private readonly terminals = new Map<string, Terminal>();
  private readonly creating = new Set<PendingCreate>();
  private loading: Promise<typeof import('node-pty')> | null = null;
  private readonly disconnected = new WeakSet<RequestContext>();
  /**
   * Sessions that ended by a real exit, by the client that owned them. The last frames of that
   * client (the acknowledgement of the final output, a key, a close) can cross the exit event
   * on the wire. They name a real session of that client, so they are dropped, not refused:
   * a refusal ends the connection and takes the client's control with it.
   */
  private readonly exited = new WeakMap<RequestContext, string[]>();
  private stopped = false;
  private disposal: Promise<void> | null = null;
  private resolveDisposal: (() => void) | null = null;
  private authorityTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: {
    /** Explicit host-local switch; false when omitted. Never read it from a request. */
    readonly enabled?: boolean;
    readonly registry: WorkspaceRegistry;
    readonly control: WorkspaceControl;
    /** Current effective client permission, not the host maximum. */
    readonly permission: (identity: RequestContext, workspaceId: string) => 'read-only' | 'edit' | 'full-access';
    readonly resolveShell: (root: string) => string;
    /** Host adapter injects a literal lazy import; the portable core never loads native PTY code. */
    readonly loadPty: () => Promise<typeof import('node-pty')>;
    readonly send: (identity: RequestContext, event: HostTerminalEvent) => void;
  }) {}

  private assertEnabled(): void {
    if (!this.options.enabled || this.stopped) throw new Error('Host manual terminal capability is disabled.');
  }

  private authority(identity: RequestContext, workspaceId: string, workspaceGeneration: number, controlGeneration: number): string {
    this.assertEnabled();
    if (!isAdapterCreatedContext(identity) || identity.adapter !== 'authenticated-server'
      || identity.expiresAt <= Date.now() || this.disconnected.has(identity)) {
      throw new Error('Authenticated network client required.');
    }
    const handle = this.options.registry.resolve(identity, workspaceId, workspaceGeneration);
    if (!this.options.control.hasControl(identity, workspaceId, controlGeneration)) throw new Error('Current workspace control required.');
    const permission = this.options.permission(identity, workspaceId);
    if (permission !== 'edit' && permission !== 'full-access') throw new Error('Read-only clients cannot use a manual shell.');
    return handle.root;
  }

  private owned(identity: RequestContext, id: string, requireControl: boolean): Terminal {
    const terminal = this.terminals.get(id);
    if (!terminal || (requireControl && terminal.closed) || !isAdapterCreatedContext(identity) || identity.adapter !== 'authenticated-server'
      || terminal.identity.clientId !== identity.clientId || terminal.identity.principalId !== identity.principalId
      || terminal.identity !== identity) throw new Error('Terminal session is unavailable.');
    if (requireControl) {
      try {
        if (this.authority(identity, terminal.workspaceId, terminal.workspaceGeneration, terminal.controlGeneration) !== terminal.root) {
          throw new Error('Workspace root changed.');
        }
        if (terminal.closed) throw new Error('Terminal session is unavailable.');
      } catch (error) { this.destroy(id, terminal); throw error; }
    }
    return terminal;
  }

  /** PTY is imported only after host enablement, current membership/control and permission. */
  async create(identity: RequestContext, workspaceId: string, workspaceGeneration: number, controlGeneration: number,
    cols: number, rows: number): Promise<{ id: string; shell: string; cwd: string; warning: string }> {
    terminalCreateInputSchema.parse({ cols, rows });
    const root = this.authority(identity, workspaceId, workspaceGeneration, controlGeneration);
    // Reserve before any await: imports and closing PTYs consume the same bounded capacity.
    // Reissued contexts for the same client cannot evade its limit or inherit its shells.
    if (this.terminals.size + this.creating.size >= 32
      || [...this.terminals.values(), ...this.creating].filter((entry) => entry.identity.clientId === identity.clientId
        && entry.identity.principalId === identity.principalId).length >= 4) {
      throw new Error('Host manual terminal limit reached.');
    }
    const admission: PendingCreate = { identity, workspaceId, closed: false };
    this.creating.add(admission);
    try {
      const shell = this.options.resolveShell(root);
      // A host-injected resolver still cannot start a workspace-local executable.
      const canonical = realpathSync(shell);
      const relative = path.relative(root, canonical);
      if (!path.isAbsolute(shell) || !statSync(canonical).isFile()
        || relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
        throw new Error('Configure an installed shell outside the active project directory.');
      }
      const pty = await (this.loading ??= Promise.resolve().then(() => {
        this.assertEnabled();
        return this.options.loadPty();
      }).catch((error: unknown) => { this.loading = null; throw error; }));
      // A ticket, workspace, or control can change during the native-module load.
      if (this.authority(identity, workspaceId, workspaceGeneration, controlGeneration) !== root) throw new Error('Workspace root changed.');
      if (admission.closed || this.stopped) throw new Error('Terminal creation was closed.');
      // Do not run Windows registry AutoRun commands when opening a host shell.
      // Other explicitly configured shells retain their own argument contract.
      const shellArgs = process.platform === 'win32' && path.basename(canonical).toLowerCase() === 'cmd.exe' ? ['/d'] : [];
      const id = randomUUID();
      const processHandle = pty.spawn(canonical, shellArgs, { name: 'xterm-256color', cols, rows, cwd: root,
        env: { ...process.env, TERM: 'xterm-256color' } });
      const terminal: Terminal = { identity, workspaceId, workspaceGeneration, controlGeneration, root, process: processHandle,
        pending: new Map(), nextSequence: 1, outstanding: 0, buffered: '', paused: false, closed: false, timer: undefined };
      this.terminals.set(id, terminal);
      try {
        // Install exit observation first, before output callbacks or any close request can kill.
        const exit = processHandle.onExit(({ exitCode, signal }) => {
          if (this.terminals.get(id) !== terminal) return;
          const notify = !terminal.closed;
          this.terminals.delete(id); // Only an actual native exit releases the owner/slot.
          // Only a session that was still open: one that the host closed (a disconnect, lost
          // control) keeps refusing every later frame, so nothing is replayed into it.
          if (notify) this.rememberExit(identity, id);
          this.closeChannel(terminal);
          this.releaseListener(terminal.exit);
          delete terminal.exit;
          this.scheduleAuthorityCheck();
          this.settleDisposal();
          if (notify) {
            try { this.options.send(identity, { type: 'exit', id, exitCode, ...(signal === undefined ? {} : { signal }) }); }
            catch { /* A disconnected recipient cannot retain an exited process. */ }
          }
        });
        if (this.terminals.get(id) === terminal) terminal.exit = exit;
        else this.releaseListener(exit);
        if (!terminal.closed) {
          const data = processHandle.onData((data) => {
            if (terminal.closed) return;
            try {
              if (this.authority(identity, workspaceId, workspaceGeneration, controlGeneration) !== root) throw new Error('Workspace root changed.');
            } catch { this.destroy(id, terminal); return; }
            if (terminal.closed) return;
            terminal.buffered += data;
            if (terminal.buffered.length > 1_048_576) {
              const marker = '\r\n[terminal output truncated while the UI caught up]\r\n';
              terminal.buffered = marker + terminal.buffered.slice(-(1_048_576 - marker.length));
            }
            this.flow(terminal);
            if (terminal.buffered.length >= 65_536) this.flush(id, terminal);
            else this.schedule(id, terminal);
          });
          if (terminal.closed) this.releaseListener(data);
          else terminal.data = data;
        }
        // Injected native hooks can synchronously reenter host shutdown during spawn/setup.
        if (this.authority(identity, workspaceId, workspaceGeneration, controlGeneration) !== root) throw new Error('Workspace root changed.');
        if (admission.closed || terminal.closed || this.stopped) throw new Error('Terminal creation was closed.');
        this.scheduleAuthorityCheck();
        return { id, shell: canonical, cwd: root,
          warning: 'Manual terminal runs an unsandboxed shell on the execution host. Agent edit permission does not limit shell commands.' };
      } catch (error) { this.destroy(id, terminal); throw error; }
    } finally {
      this.creating.delete(admission);
      this.settleDisposal();
    }
  }

  private rememberExit(identity: RequestContext, id: string): void {
    const ids = this.exited.get(identity) ?? [];
    ids.push(id);
    if (ids.length > 32) ids.shift();
    this.exited.set(identity, ids);
  }
  private hasExited(identity: RequestContext, id: string): boolean {
    return this.exited.get(identity)?.includes(id) === true;
  }

  write(identity: RequestContext, id: string, data: string): void {
    terminalWriteInputSchema.parse({ id, data });
    if (this.hasExited(identity, id)) return;
    this.owned(identity, id, true).process.write(data);
  }
  resize(identity: RequestContext, id: string, cols: number, rows: number): void {
    terminalResizeInputSchema.parse({ id, cols, rows });
    if (this.hasExited(identity, id)) return;
    this.owned(identity, id, true).process.resize(cols, rows);
  }
  /** Exact, ordered sequence+length ACK. An old/duplicate/oversized ACK has no effect. */
  acknowledge(identity: RequestContext, id: string, sequence: number, characters: number): void {
    if (this.hasExited(identity, id)) return;
    const terminal = this.owned(identity, id, true);
    const first = terminal.pending.keys().next().value;
    if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(characters) || first !== sequence
      || terminal.pending.get(sequence) !== characters) return;
    terminal.pending.delete(sequence);
    terminal.outstanding -= characters;
    this.flow(terminal);
    this.flush(id, terminal);
  }
  close(identity: RequestContext, id: string): void {
    if (this.hasExited(identity, id)) return;
    const terminal = this.owned(identity, id, false);
    this.destroy(id, terminal);
  }
  /** Immediate close; no grace or input replay on a replacement connection. */
  disconnect(identity: RequestContext): void {
    if (!isAdapterCreatedContext(identity) || identity.adapter !== 'authenticated-server') return;
    this.disconnected.add(identity);
    for (const [id, terminal] of this.terminals) {
      if (terminal.identity === identity) this.destroy(id, terminal);
    }
  }
  /** Host lifecycle hook for workspace unregistration, control transfer, or revocation.
   * Closing does not transfer the shell to the new controller. */
  closeWorkspace(workspaceId: string): void {
    for (const admission of this.creating) if (admission.workspaceId === workspaceId) admission.closed = true;
    for (const [id, terminal] of this.terminals) {
      if (terminal.workspaceId === workspaceId) this.destroy(id, terminal);
    }
  }
  /** Fence immediately; settle only after every admitted create and native exit.
   * A failed kill or a host wait timeout must never release ownership early. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.stopped = true;
    this.disposal = new Promise<void>((resolve) => { this.resolveDisposal = resolve; });
    this.scheduleAuthorityCheck();
    for (const [id, terminal] of this.terminals) this.destroy(id, terminal);
    this.settleDisposal();
    return this.disposal;
  }
  private settleDisposal(): void {
    if (!this.stopped || this.creating.size || this.terminals.size) return;
    this.loading = null;
    const resolve = this.resolveDisposal;
    this.resolveDisposal = null;
    resolve?.();
  }
  private releaseListener(listener: IDisposable | undefined): void {
    try { listener?.dispose(); } catch { /* Closed channels stay fenced even if native listener removal fails. */ }
  }
  private closeChannel(terminal: Terminal): void {
    terminal.closed = true;
    if (terminal.timer) clearTimeout(terminal.timer);
    terminal.timer = undefined;
    terminal.buffered = '';
    terminal.pending.clear();
    terminal.outstanding = 0;
    const data = terminal.data;
    delete terminal.data;
    this.releaseListener(data);
  }
  /** Request closure once, but keep the process and exit observer until native onExit. */
  private destroy(id: string, terminal: Terminal): void {
    if (terminal.closed) return;
    this.closeChannel(terminal);
    this.scheduleAuthorityCheck();
    // Drain a flow-paused native stream without forwarding output, so it can report exit.
    if (terminal.paused) {
      terminal.paused = false;
      try { terminal.process.resume(); } catch { /* Resume is not exit proof either. */ }
    }
    if (this.terminals.get(id) !== terminal) return;
    try { terminal.process.kill(); } catch { /* Retain ownership and exit observation until real settlement. */ }
  }
  /** One lazy host timer covers at most 32 live PTYs; idle/closing-only owners do not poll. */
  private scheduleAuthorityCheck(): void {
    if (this.stopped || ![...this.terminals.values()].some((terminal) => !terminal.closed)) {
      if (this.authorityTimer) clearTimeout(this.authorityTimer);
      this.authorityTimer = undefined;
      return;
    }
    if (this.authorityTimer) return;
    this.authorityTimer = setTimeout(() => {
      this.authorityTimer = undefined;
      for (const [id, terminal] of this.terminals) {
        if (terminal.closed) continue;
        try {
          if (this.authority(terminal.identity, terminal.workspaceId, terminal.workspaceGeneration, terminal.controlGeneration) !== terminal.root) {
            throw new Error('Workspace root changed.');
          }
        } catch { this.destroy(id, terminal); }
      }
      this.scheduleAuthorityCheck();
    }, 1_000);
    this.authorityTimer.unref();
  }
  private flow(terminal: Terminal): void {
    const queued = terminal.buffered.length + terminal.outstanding;
    if (!terminal.paused && queued >= 512 * 1024) { terminal.process.pause(); terminal.paused = true; }
    else if (terminal.paused && queued <= 128 * 1024) { terminal.process.resume(); terminal.paused = false; }
  }
  private flush(id: string, terminal: Terminal): void {
    if (terminal.timer) clearTimeout(terminal.timer);
    terminal.timer = undefined;
    let emitted = 0;
    while (!terminal.closed && terminal.buffered.length > 0 && terminal.outstanding < 512 * 1024 && emitted++ < 4) {
      const data = terminal.buffered.slice(0, 65_536);
      terminal.buffered = terminal.buffered.slice(data.length);
      const sequence = terminal.nextSequence++;
      terminal.pending.set(sequence, data.length);
      terminal.outstanding += data.length;
      try { this.options.send(terminal.identity, { type: 'data', id, sequence, data }); }
      catch { this.destroy(id, terminal); return; }
    }
    if (!terminal.closed) {
      this.flow(terminal);
      if (terminal.buffered.length && terminal.outstanding < 512 * 1024) this.schedule(id, terminal);
    }
  }
  private schedule(id: string, terminal: Terminal): void {
    if (!terminal.timer && !terminal.closed) terminal.timer = setTimeout(() => this.flush(id, terminal), 16);
  }
}
