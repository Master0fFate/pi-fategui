import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { IPty } from 'node-pty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthenticatedServerContext, type RequestContext } from '../../src/core/dispatch/RequestContext';
import { CONTROL_LEASE_MS, WorkspaceControl } from '../../src/core/security/WorkspaceControl';
import { TerminalOwner, type HostTerminalEvent } from '../../src/core/terminal/TerminalOwner';
import type { WorkspaceRegistry } from '../../src/core/workspaces/WorkspaceRegistry';

const nodeExecutable = path.isAbsolute(process.execPath) ? process.execPath : (process.env.PATH ?? '').split(path.delimiter)
  .filter((directory) => path.isAbsolute(directory)).map((directory) => path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node'))
  .find((candidate) => existsSync(candidate));
if (!nodeExecutable) throw new Error('The fixture requires an absolute Node executable.');
const canonicalNodeExecutable = realpathSync(nodeExecutable);
type Exit = { exitCode: number; signal?: number };
type PtyModule = typeof import('node-pty');

/** kill is only a request. Tests must explicitly emit a separate native exit. */
class FakePty implements IPty {
  readonly pid = 1;
  readonly cols = 80;
  readonly rows = 24;
  readonly process = 'fixture';
  handleFlowControl = false;
  readonly write = vi.fn();
  readonly resize = vi.fn();
  readonly clear = vi.fn();
  readonly pause = vi.fn();
  readonly resume = vi.fn();
  readonly kill = vi.fn();
  readonly dataDisposed = vi.fn();
  readonly exitDisposed = vi.fn();
  private readonly dataListeners = new Set<(data: string) => unknown>();
  private readonly exitListeners = new Set<(event: Exit) => unknown>();
  private exited = false;
  readonly onData = vi.fn((listener: (data: string) => unknown) => {
    this.dataListeners.add(listener);
    return { dispose: () => { this.dataDisposed(); this.dataListeners.delete(listener); } };
  });
  readonly onExit = vi.fn((listener: (event: Exit) => unknown) => {
    this.exitListeners.add(listener);
    return { dispose: () => { this.exitDisposed(); this.exitListeners.delete(listener); } };
  });
  get dataObservers(): number { return this.dataListeners.size; }
  get exitObservers(): number { return this.exitListeners.size; }
  emitData(data: string): void { for (const listener of [...this.dataListeners]) listener(data); }
  emitExit(exitCode = 0, signal?: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.exitListeners]) listener({ exitCode, ...(signal === undefined ? {} : { signal }) });
  }
}

interface Client {
  readonly identity: RequestContext;
  readonly workspaceId: string;
  readonly controlGeneration: number;
  member: boolean;
  ticketLive: boolean;
  permission: 'edit' | 'read-only';
  root: string;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const clients: Client[] = [];
  const processes: FakePty[] = [];
  const creations: Promise<unknown>[] = [];
  const releaseLoads: Array<() => void> = [];
  const events: HostTerminalEvent[] = [];
  const member = (identity: RequestContext, workspaceId: string): boolean => clients.some((client) =>
    client.identity === identity && client.workspaceId === workspaceId && client.member && client.ticketLive);
  const control = new WorkspaceControl({ isMember: member, mayTakeOver: () => true });
  const resolve = vi.fn((identity: RequestContext, workspaceId: string, generation: number) => {
    const client = clients.find((entry) => entry.identity === identity);
    if (!client || !member(identity, workspaceId) || generation !== 1) throw new Error('Workspace membership required.');
    return { root: client.root };
  });
  const spawnProcess = (): FakePty => { const pty = new FakePty(); processes.push(pty); return pty; };
  const spawn = vi.fn(spawnProcess);
  const native: PtyModule = { spawn };
  const load = vi.fn((): Promise<PtyModule> => Promise.resolve(native));
  const send = vi.fn((_identity: RequestContext, event: HostTerminalEvent) => { events.push(event); });
  const owner = new TerminalOwner({ enabled: true, registry: { resolve } as unknown as WorkspaceRegistry, control,
    permission: (identity) => clients.find((client) => client.identity === identity)?.permission ?? 'read-only',
    resolveShell: () => canonicalNodeExecutable, loadPty: load, send });
  const addClient = (options: { previous?: Client; lifetime?: number; workspaceId?: string; claim?: boolean } = {}): Client => {
    const previous = options.previous;
    const identity = createAuthenticatedServerContext({ principalId: previous?.identity.principalId ?? randomUUID(),
      clientId: previous?.identity.clientId ?? randomUUID(), expiresAt: Date.now() + (options.lifetime ?? 60_000) }, null);
    const client: Client = { identity, workspaceId: previous?.workspaceId ?? options.workspaceId ?? randomUUID(),
      controlGeneration: previous?.controlGeneration ?? 1, member: true, ticketLive: true, permission: 'edit', root: process.cwd() };
    clients.push(client);
    if (!previous && options.claim !== false) control.claim(identity, client.workspaceId);
    return client;
  };
  const create = (client: Client) => {
    const promise = owner.create(client.identity, client.workspaceId, 1, client.controlGeneration, 80, 24);
    creations.push(promise);
    // Cleanup can reject an in-flight admission even if an earlier assertion failed.
    void promise.catch(() => undefined);
    return promise;
  };
  const blockLoad = () => {
    const blocked = deferred<PtyModule>();
    load.mockReturnValue(blocked.promise);
    releaseLoads.push(() => blocked.resolve(native));
    return blocked;
  };
  const result = { owner, addClient, create, processes, events, resolve, control, native, load, spawn, spawnProcess, send, blockLoad,
    async cleanup() {
      const settlement = owner.dispose();
      for (const release of releaseLoads) release();
      for (const pty of processes) pty.emitExit();
      await Promise.allSettled(creations);
      await settlement;
    } };
  cleanups.push(() => result.cleanup());
  return result;
}
const cleanups: Array<() => Promise<void>> = [];

// Assert retained ownership directly as well as through observable capacity/settlement.
function retained(owner: TerminalOwner) {
  return owner as unknown as {
    terminals: Map<string, { closed: boolean; buffered: string; outstanding: number; pending: Map<number, number>; timer: unknown }>;
    creating: Set<unknown>;
  };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); });
afterEach(async () => {
  try { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); }
  finally { vi.useRealTimers(); }
});

describe('terminal real-settlement lifecycle', () => {
  it('fences a channel and drops buffered output immediately but retains its owner/exit observer until native exit', async () => {
    const f = fixture();
    const client = f.addClient();
    const created = await f.create(client);
    const pty = f.processes[0]!;
    pty.emitData('x'.repeat(900_000));
    expect(pty.pause).toHaveBeenCalledOnce();
    const entry = retained(f.owner).terminals.get(created.id)!;
    expect(entry.buffered.length).toBeGreaterThan(0);
    expect(entry.pending.size).toBeGreaterThan(0);
    const delivered = f.events.length;
    const settlement = f.owner.dispose();
    const settled = vi.fn();
    void settlement.then(settled);
    expect(f.owner.dispose()).toBe(settlement);
    expect(retained(f.owner).terminals.get(created.id)).toBe(entry);
    expect(entry.closed).toBe(true);
    expect(entry.buffered).toBe('');
    expect(entry.outstanding).toBe(0);
    expect(entry.pending.size).toBe(0);
    expect(entry.timer).toBeUndefined();
    expect(pty.dataObservers).toBe(0);
    expect(pty.exitObservers).toBe(1);
    expect(pty.exitDisposed).not.toHaveBeenCalled();
    expect(pty.resume).toHaveBeenCalledOnce();
    expect(pty.kill).toHaveBeenCalledOnce();
    expect(() => f.owner.write(client.identity, created.id, 'late')).toThrow('unavailable');
    expect(() => f.owner.resize(client.identity, created.id, 90, 30)).toThrow('unavailable');
    expect(() => f.owner.acknowledge(client.identity, created.id, 1, 65_536)).toThrow('unavailable');
    await expect(f.create(client)).rejects.toThrow('disabled');
    pty.emitData('late output');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).not.toHaveBeenCalled();
    expect(f.events).toHaveLength(delivered);
    expect(pty.write).not.toHaveBeenCalled();
    expect(pty.resize).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    pty.emitExit(7);
    await settlement;
    expect(settled).toHaveBeenCalledOnce();
    expect(retained(f.owner).terminals.size).toBe(0);
    expect(pty.exitObservers).toBe(0);
    expect(pty.exitDisposed).toHaveBeenCalledOnce();
    expect(pty.kill).toHaveBeenCalledOnce();
    expect(f.events).toHaveLength(delivered);
  });

  it.each(['write', 'data'] as const)('fences %s if an authority callback synchronously closes the channel', async (operation) => {
    const f = fixture();
    const client = f.addClient();
    const created = await f.create(client);
    f.resolve.mockImplementationOnce(() => {
      f.owner.close(client.identity, created.id);
      return { root: client.root };
    });
    if (operation === 'write') expect(() => f.owner.write(client.identity, created.id, 'after close')).toThrow('unavailable');
    else f.processes[0]!.emitData('after close');
    expect(f.processes[0]!.write).not.toHaveBeenCalled();
    expect(f.processes[0]!.kill).toHaveBeenCalledOnce();
    expect(retained(f.owner).terminals.has(created.id)).toBe(true);
    expect(retained(f.owner).terminals.get(created.id)!.buffered).toBe('');
    expect(f.events).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a throwing kill is not settlement; repeated cleanup still waits for a later natural exit', async () => {
    const f = fixture();
    const client = f.addClient();
    const created = await f.create(client);
    const pty = f.processes[0]!;
    pty.kill.mockImplementation(() => { throw new Error('native kill failed'); });
    f.owner.close(client.identity, created.id);
    f.owner.close(client.identity, created.id);
    f.owner.disconnect(client.identity);
    f.owner.closeWorkspace(client.workspaceId);
    const settlement = f.owner.dispose();
    const settled = vi.fn();
    void settlement.then(settled);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.owner.dispose()).toBe(settlement);
    expect(pty.kill).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    expect(retained(f.owner).terminals.has(created.id)).toBe(true);
    expect(pty.exitObservers).toBe(1);
    expect(pty.exitDisposed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    pty.emitExit();
    await settlement;
    expect(settled).toHaveBeenCalledOnce();
    expect(pty.dataDisposed).toHaveBeenCalledOnce();
    expect(pty.exitDisposed).toHaveBeenCalledOnce();
    expect(retained(f.owner).terminals.size).toBe(0);
  });

  it('natural exit clears control resources and notifies once without issuing a kill', async () => {
    const f = fixture();
    const client = f.addClient();
    const created = await f.create(client);
    const pty = f.processes[0]!;
    pty.emitData('not yet flushed');
    expect(vi.getTimerCount()).toBe(2);
    pty.emitExit(0, 15);
    pty.emitExit(0, 15);
    expect(f.events).toEqual([{ type: 'exit', id: created.id, exitCode: 0, signal: 15 }]);
    expect(pty.kill).not.toHaveBeenCalled();
    expect(pty.dataObservers).toBe(0);
    expect(pty.exitObservers).toBe(0);
    expect(retained(f.owner).terminals.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const settlement = f.owner.dispose();
    expect(f.owner.dispose()).toBe(settlement);
    await settlement;
  });

  it('closing shells still consume the per-client limit, cannot transfer to reissued identities, and never replay input', async () => {
    const f = fixture();
    const client = f.addClient();
    const created = await Promise.all(Array.from({ length: 4 }, () => f.create(client)));
    const reissued = f.addClient({ previous: client });
    f.owner.write(client.identity, created[0]!.id, 'once');
    expect(() => f.owner.write(reissued.identity, created[0]!.id, 'replay')).toThrow('unavailable');
    for (const terminal of created) f.owner.close(client.identity, terminal.id);
    await expect(f.create(client)).rejects.toThrow('limit');
    await expect(f.create(reissued)).rejects.toThrow('limit');
    expect(retained(f.owner).terminals.size).toBe(4);
    expect(f.processes.every((pty) => pty.exitObservers === 1)).toBe(true);
    f.processes[0]!.emitExit();
    const replacement = await f.create(reissued);
    expect(replacement.id).not.toBe(created[0]!.id);
    expect(retained(f.owner).terminals.size).toBe(4);
    expect(f.processes[0]!.write).toHaveBeenCalledExactlyOnceWith('once');
    expect(f.processes[4]!.write).not.toHaveBeenCalled();
  });

  it.each(['control expiry', 'control release', 'permission', 'membership', 'ticket expiry', 'ticket revocation', 'root change'] as const)(
    'closes an idle raw-client terminal after %s, without input or output', async (loss) => {
      const f = fixture();
      const client = f.addClient({ lifetime: loss === 'ticket expiry' ? 1_000 : 60_000 });
      const created = await f.create(client);
      const pty = f.processes[0]!;
      if (loss === 'control release') f.control.release(client.identity, client.workspaceId, client.controlGeneration);
      if (loss === 'permission') client.permission = 'read-only';
      if (loss === 'membership') client.member = false;
      if (loss === 'ticket revocation') client.ticketLive = false;
      if (loss === 'root change') client.root = path.dirname(client.root);
      await vi.advanceTimersByTimeAsync(loss === 'control expiry' ? CONTROL_LEASE_MS : 1_000);
      expect(pty.write).not.toHaveBeenCalled();
      expect(pty.resize).not.toHaveBeenCalled();
      expect(f.events).toHaveLength(0);
      expect(pty.kill).toHaveBeenCalledOnce();
      expect(pty.exitObservers).toBe(1);
      expect(retained(f.owner).terminals.has(created.id)).toBe(true);
      expect(() => f.owner.write(client.identity, created.id, 'late')).toThrow('unavailable');
      expect(vi.getTimerCount()).toBe(0);
      const settlement = f.owner.dispose();
      const settled = vi.fn();
      void settlement.then(settled);
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      pty.emitExit();
      await settlement;
    });

  it('closes on host-authorized takeover without transferring the existing shell to the new controller', async () => {
    const f = fixture();
    const client = f.addClient();
    const created = await f.create(client);
    const controller = f.addClient({ workspaceId: client.workspaceId, claim: false });
    f.control.takeover(controller.identity, client.workspaceId);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.processes[0]!.kill).toHaveBeenCalledOnce();
    expect(retained(f.owner).terminals.has(created.id)).toBe(true);
    expect(() => f.owner.write(controller.identity, created.id, 'inherited input')).toThrow('unavailable');
    expect(f.processes[0]!.write).not.toHaveBeenCalled();
    expect(f.events).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses one lazy timer for all live terminals and none for an idle or closing-only owner', async () => {
    const f = fixture();
    const client = f.addClient();
    expect(vi.getTimerCount()).toBe(0);
    const created = await Promise.all(Array.from({ length: 4 }, () => f.create(client)));
    expect(vi.getTimerCount()).toBe(1);
    f.resolve.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.resolve).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(1);
    for (const pty of f.processes) pty.emitExit();
    expect(retained(f.owner).terminals.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const next = await f.create(client);
    expect(created.some((terminal) => terminal.id === next.id)).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    f.owner.close(client.identity, next.id);
    expect(retained(f.owner).terminals.size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    f.resolve.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.resolve).not.toHaveBeenCalled();
  });

  it('reserves the per-client bound before a blocked import and shares a single lazy load', async () => {
    const f = fixture();
    const client = f.addClient();
    const blocked = f.blockLoad();
    const pending = Array.from({ length: 4 }, () => f.create(client));
    await expect(f.create(client)).rejects.toThrow('limit');
    await expect(f.create(f.addClient({ previous: client }))).rejects.toThrow('limit');
    expect(retained(f.owner).creating.size).toBe(4);
    expect(retained(f.owner).terminals.size).toBe(0);
    expect(f.load).toHaveBeenCalledOnce();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    blocked.resolve(f.native);
    await Promise.all(pending);
    expect(f.spawn).toHaveBeenCalledTimes(4);
    expect(retained(f.owner).creating.size).toBe(0);
    expect(retained(f.owner).terminals.size).toBe(4);
    expect(f.load).toHaveBeenCalledOnce();
  });

  it('bounds the host at 32 pending/live/closing admissions and frees capacity only after exit', async () => {
    const f = fixture();
    const blocked = f.blockLoad();
    const clients = Array.from({ length: 8 }, () => f.addClient());
    const pending = clients.flatMap((client) => Array.from({ length: 4 }, () => f.create(client)));
    const ninth = f.addClient();
    await expect(f.create(ninth)).rejects.toThrow('limit');
    expect(retained(f.owner).creating.size).toBe(32);
    expect(f.load).toHaveBeenCalledOnce();
    expect(f.spawn).not.toHaveBeenCalled();
    blocked.resolve(f.native);
    await Promise.all(pending);
    expect(f.spawn).toHaveBeenCalledTimes(32);
    for (const client of clients) f.owner.closeWorkspace(client.workspaceId);
    expect(retained(f.owner).terminals.size).toBe(32);
    expect(vi.getTimerCount()).toBe(0);
    await expect(f.create(ninth)).rejects.toThrow('limit');
    f.processes[0]!.emitExit();
    await f.create(ninth);
    expect(retained(f.owner).terminals.size).toBe(32);
    expect(f.spawn).toHaveBeenCalledTimes(33);
    expect(f.load).toHaveBeenCalledOnce();
  });

  it.each(['resolve', 'reject'] as const)('stop during a native import waits for its %s and never spawns an orphan', async (outcome) => {
    const f = fixture();
    const client = f.addClient();
    const blocked = f.blockLoad();
    const creations = Promise.allSettled([f.create(client), f.create(client)]);
    await Promise.resolve();
    expect(f.load).toHaveBeenCalledOnce();
    const settlement = f.owner.dispose();
    const settled = vi.fn();
    void settlement.then(settled);
    expect(f.owner.dispose()).toBe(settlement);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(retained(f.owner).creating.size).toBe(2);
    if (outcome === 'resolve') blocked.resolve(f.native);
    else blocked.reject(new Error('native import failed'));
    const results = await creations;
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    for (const result of results) if (result.status === 'rejected') {
      expect(String(result.reason)).toContain(outcome === 'resolve' ? 'disabled' : 'native import failed');
    }
    await settlement;
    expect(settled).toHaveBeenCalledOnce();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(retained(f.owner).creating.size).toBe(0);
    expect(retained(f.owner).terminals.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start the lazy native import if stop happens before its first microtask', async () => {
    const f = fixture();
    const creation = f.create(f.addClient());
    const settlement = f.owner.dispose();
    await expect(creation).rejects.toThrow('disabled');
    await settlement;
    expect(f.load).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(retained(f.owner).creating.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['disconnect', 'workspace close'] as const)('fences pending creation on %s without needing I/O', async (reason) => {
    const f = fixture();
    const client = f.addClient();
    const blocked = f.blockLoad();
    const creation = f.create(client);
    await Promise.resolve();
    if (reason === 'disconnect') f.owner.disconnect(client.identity);
    else f.owner.closeWorkspace(client.workspaceId);
    blocked.resolve(f.native);
    await expect(creation).rejects.toThrow(reason === 'disconnect' ? 'Authenticated' : 'creation was closed');
    expect(f.spawn).not.toHaveBeenCalled();
    expect(retained(f.owner).creating.size).toBe(0);
    await f.owner.dispose();
  });

  it('retains a PTY if native spawn synchronously reenters stop before returning its handle', async () => {
    const f = fixture();
    const client = f.addClient();
    let settlement!: Promise<void>;
    f.spawn.mockImplementationOnce(() => {
      const pty = f.spawnProcess();
      settlement = f.owner.dispose();
      return pty;
    });
    await expect(f.create(client)).rejects.toThrow('disabled');
    expect(f.owner.dispose()).toBe(settlement);
    const settled = vi.fn();
    void settlement.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(retained(f.owner).creating.size).toBe(0);
    expect(retained(f.owner).terminals.size).toBe(1);
    expect(f.processes[0]!.kill).toHaveBeenCalledOnce();
    expect(f.processes[0]!.exitObservers).toBe(1);
    f.processes[0]!.emitExit();
    await settlement;
  });

  it('keeps exit observation after output setup or transport failure', async () => {
    const f = fixture();
    const client = f.addClient();
    f.spawn.mockImplementationOnce(() => {
      const pty = f.spawnProcess();
      pty.onData.mockImplementationOnce(() => { throw new Error('output setup failed'); });
      return pty;
    });
    await expect(f.create(client)).rejects.toThrow('output setup failed');
    await f.create(client);
    f.send.mockImplementation(() => { throw new Error('transport failed'); });
    f.processes[1]!.emitData('x'.repeat(65_536));
    const settlement = f.owner.dispose();
    const settled = vi.fn();
    void settlement.then(settled);
    expect(retained(f.owner).terminals.size).toBe(2);
    expect(f.processes.every((pty) => pty.exitObservers === 1)).toBe(true);
    f.processes[0]!.emitExit();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    f.processes[1]!.emitExit();
    await settlement;
    for (const pty of f.processes) expect(pty.kill).toHaveBeenCalledOnce();
    expect(retained(f.owner).terminals.size).toBe(0);
  });

  it('releases failed import reservations and permits a later load retry', async () => {
    const f = fixture();
    const client = f.addClient();
    f.load.mockImplementationOnce(() => { throw new Error('synchronous loader failure'); });
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => f.create(client)));
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected', 'rejected']);
    expect(retained(f.owner).creating.size).toBe(0);
    expect(f.spawn).not.toHaveBeenCalled();
    await f.create(client);
    expect(f.load).toHaveBeenCalledTimes(2);
    expect(f.spawn).toHaveBeenCalledOnce();
  });
});
