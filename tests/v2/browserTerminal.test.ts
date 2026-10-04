import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventTransport } from '../../src/client/EventTransport';
import { WebFateApi } from '../../src/client/WebFateApi';
import { terminalClientFrameSchema, terminalServerFrameSchema } from '../../src/shared/protocol/terminal';
import type { TerminalEvent } from '../../src/shared/contracts/ipc';
import type { SnapshotHeader } from '../../src/shared/protocol/snapshots';
import { requestEnvelopeSchema } from '../../src/shared/protocol/envelopes';
import { getDesktopApiOptional, getFateApi, getTerminalApiOptional, hasCapability,
  installWebFateApi, resetFateApi } from '../../src/renderer/platform/api';

const epoch = '10000000-0000-4000-8000-000000000001';
const workspaceId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000003';
const snapshotId = '40000000-0000-4000-8000-000000000004';
const pageId = '50000000-0000-4000-8000-000000000005';
const terminalId = '60000000-0000-4000-8000-000000000006';
const streamId = '70000000-0000-4000-8000-000000000007';
const clientId = '80000000-0000-4000-8000-000000000008';
const otherTerminalId = '90000000-0000-4000-8000-000000000009';
const origin = 'http://127.0.0.1:49301';
const csrfToken = `fx1_${'x'.repeat(43)}`;
const scope = { workspaceId, workspaceGeneration: 3, controlGeneration: 2 };
const selected = { workspaceId, workspaceGeneration: 3, label: 'Host project' };
const cursor = { serverEpoch: epoch, workspaceId, workspaceGeneration: 3, streamId, sequence: 2 };
const result = { id: terminalId, shell: '/bin/sh', cwd: '/host/project', warning: 'Unsandboxed manual shell.' };
const created = (id = terminalId) => ({ protocol: 1, type: 'terminal.created', result: { ...result, id } });
const output = (sequence: number, data: string, id = terminalId) => ({ protocol: 1, type: 'terminal.event', event: { type: 'data', id, sequence, data } });
const ready = { protocol: 1, type: 'ready', clientId, serverEpoch: epoch, ticket: `ft1_${'a'.repeat(43)}` };
const cleanup: Array<() => void> = [];

/** Runtime stand-in installed as the browser global; no cast to a partial WebSocket. */
class Socket {
  static readonly OPEN = 1;
  static readonly instances: Socket[] = [];
  static autoSubscribe = false;
  readyState = 1;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: string[] = [];
  constructor(readonly url: string) {
    Socket.instances.push(this);
    Promise.resolve().then(() => this.onopen?.());
  }
  send(text: string): void {
    if (this.readyState !== 1) throw new Error('Socket closed');
    this.sent.push(text);
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || !('type' in value)) return;
    if (value.type === 'hello') Promise.resolve().then(() => this.receive(ready));
    if (value.type === 'subscribe' && Socket.autoSubscribe && 'cursor' in value) {
      Promise.resolve().then(() => this.receive({ protocol: 1, type: 'subscribed', cursor: value.cursor }));
    }
  }
  receive(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
  close(): void { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
  frames() {
    return this.sent.flatMap((text) => {
      const parsed = terminalClientFrameSchema.safeParse(JSON.parse(text));
      return parsed.success ? [parsed.data] : [];
    });
  }
}
function installSockets(): void {
  Socket.instances.length = 0; Socket.autoSubscribe = false;
  vi.stubGlobal('WebSocket', Socket);
}
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  resetFateApi(); vi.unstubAllGlobals(); vi.useRealTimers();
});
async function transportFixture() {
  installSockets();
  const network = vi.fn(); const disconnected = vi.fn();
  const transport = new EventTransport('ws://127.0.0.1:49301/api/events', () => csrfToken, network, undefined, disconnected);
  cleanup.push(() => transport.close());
  await transport.connect();
  const socket = Socket.instances[0]!;
  const events: TerminalEvent[] = [];
  const unsubscribe = transport.terminal.onTerminalEvent((event) => events.push(event));
  return { transport, socket, events, network, disconnected, unsubscribe };
}
async function create(f: Awaited<ReturnType<typeof transportFixture>>) {
  const pending = f.transport.terminal.createTerminal(scope, 80, 24);
  f.socket.receive(created());
  expect(await pending).toEqual(result);
}

describe('bounded browser terminal wire path', () => {
  it('correlates one creation, separates terminal frames from replay events, and ACKs UTF-16 chunks in order', async () => {
    const f = await transportFixture();
    const subscribed = f.transport.subscribe(workspaceId, 3, cursor);
    f.socket.receive({ protocol: 1, type: 'subscribed', cursor }); await subscribed;
    const first = f.transport.terminal.createTerminal(scope, 80, 24);
    await expect(f.transport.terminal.createTerminal(scope, 80, 24)).rejects.toThrow('already starting');
    expect(f.socket.frames()).toEqual([{ protocol: 1, type: 'terminal.create', ...scope, cols: 80, rows: 24 }]);
    f.socket.receive(created()); await first;
    f.socket.receive(output(1, '😀'));
    f.socket.receive(output(2, 'next'));
    expect(f.events).toEqual([{ type: 'data', id: terminalId, data: '😀' }, { type: 'data', id: terminalId, data: 'next' }]);
    await expect(f.transport.terminal.acknowledgeTerminal(terminalId, 4)).rejects.toThrow('next output chunk');
    await f.transport.terminal.acknowledgeTerminal(terminalId, 2);
    await expect(f.transport.terminal.acknowledgeTerminal(terminalId, 2)).rejects.toThrow('next output chunk');
    await f.transport.terminal.acknowledgeTerminal(terminalId, 4);
    await expect(f.transport.terminal.acknowledgeTerminal(terminalId, 4)).rejects.toThrow('next output chunk');
    expect(f.socket.frames().filter((frame) => frame.type === 'terminal.ack')).toEqual([
      { protocol: 1, type: 'terminal.ack', id: terminalId, sequence: 1, characters: 2 },
      { protocol: 1, type: 'terminal.ack', id: terminalId, sequence: 2, characters: 4 },
    ]);
    f.socket.receive({ type: 'event', event: { version: 1, serverEpoch: epoch, streamId, sequence: 3,
      origin: { workspaceId, workspaceGeneration: 3, sessionId: null }, category: 'pi', eventType: 'assistant.text' } });
    expect(f.disconnected).not.toHaveBeenCalled();
    expect(f.network).toHaveBeenCalledOnce();
  });

  it('cleans authentication timers before a replacement socket, even if the old close arrives late', async () => {
    vi.useFakeTimers(); installSockets();
    const transport = new EventTransport('ws://127.0.0.1:49301/api/events', () => csrfToken, () => undefined);
    cleanup.push(() => transport.close());
    const first = transport.connect();
    const old = Socket.instances[0]!;
    old.close = () => { old.readyState = 3; }; // Browser close events are asynchronous.
    const rejected = expect(first).rejects.toThrow('closed before authentication');
    transport.close(); await rejected;
    await transport.connect();
    old.onclose?.();
    vi.advanceTimersByTime(5_000);
    expect(transport.connection?.serverEpoch).toBe(epoch);
    expect(Socket.instances.at(-1)!.readyState).toBe(1);
  });

  it('caps live terminals at four independently of the single in-flight creation bound', async () => {
    const f = await transportFixture();
    for (const id of [terminalId, otherTerminalId, snapshotId, pageId]) {
      const pending = f.transport.terminal.createTerminal(scope, 80, 24); f.socket.receive(created(id)); await pending;
    }
    await expect(f.transport.terminal.createTerminal(scope, 80, 24)).rejects.toThrow('Close a manual terminal');
    expect(f.socket.frames()).toHaveLength(4);
    f.transport.terminal.closeAll();
    expect(f.socket.frames().filter((frame) => frame.type === 'terminal.close')).toHaveLength(4);
  });

  it('writes and resizes once, discards trailing closed output, and never sends a foreign ID', async () => {
    const f = await transportFixture(); await create(f);
    await f.transport.terminal.writeTerminal(terminalId, 'echo manual\r');
    await f.transport.terminal.resizeTerminal(terminalId, 100, 1);
    await expect(f.transport.terminal.writeTerminal(otherTerminalId, 'wrong')).rejects.toThrow('former connection');
    f.socket.receive(output(1, 'foreign', otherTerminalId));
    expect(f.events).toEqual([]);
    await f.transport.terminal.closeTerminal(terminalId);
    f.socket.receive(output(1, 'late'));
    await f.transport.terminal.closeTerminal(terminalId);
    expect(f.events).toEqual([]);
    expect(f.socket.frames().map((frame) => frame.type)).toEqual(['terminal.create', 'terminal.write', 'terminal.resize', 'terminal.close']);
    expect(f.socket.readyState).toBe(1);
  });

  it.each([
    { name: 'gap', frame: () => output(2, 'gap') },
    { name: 'oversized output', frame: () => output(1, 'x'.repeat(65_537)) },
    { name: 'extra fields', frame: () => ({ ...output(1, 'ok'), owner: clientId }) },
    { name: 'uncorrelated creation', frame: () => created(otherTerminalId) },
  ])('retires the socket on $name instead of guessing', async ({ frame }) => {
    const f = await transportFixture(); await create(f);
    f.socket.receive(frame());
    expect(f.transport.connection).toBeNull();
    expect(f.disconnected).toHaveBeenCalledOnce();
    expect(f.events).toEqual([{ type: 'exit', id: terminalId, exitCode: -1 }]);
    await expect(f.transport.terminal.writeTerminal(terminalId, 'no')).rejects.toThrow('former connection');
  });

  it('rejects duplicate sequence and bounds both output bytes and small-chunk metadata', async () => {
    const f = await transportFixture(); await create(f);
    f.socket.receive(output(1, 'once'));
    f.socket.receive(output(1, 'duplicate'));
    expect(f.events.filter((event) => event.type === 'data')).toHaveLength(1);
    expect(f.socket.readyState).toBe(3);
    await f.transport.connect();
    const next = Socket.instances.at(-1)!;
    const pending = f.transport.terminal.createTerminal(scope, 80, 24); next.receive(created()); await pending;
    for (let sequence = 1; sequence <= 513; sequence++) next.receive(output(sequence, 'x'));
    expect(next.readyState).toBe(3);
    await f.transport.connect();
    const third = Socket.instances.at(-1)!;
    const again = f.transport.terminal.createTerminal(scope, 80, 24); third.receive(created()); await again;
    for (let sequence = 1; sequence <= 10; sequence++) third.receive(output(sequence, 'x'.repeat(65_536)));
    expect(third.readyState).toBe(3);
  });

  it('rejects invalid dimensions/paste without sending and closes on socket congestion without buffering input', async () => {
    const f = await transportFixture();
    await expect(f.transport.terminal.createTerminal(scope, 401, 24)).rejects.toThrow();
    expect(f.socket.frames()).toEqual([]);
    await create(f);
    await expect(f.transport.terminal.writeTerminal(terminalId, 'x'.repeat(16_385))).rejects.toThrow();
    f.socket.bufferedAmount = 256 * 1024;
    await expect(f.transport.terminal.writeTerminal(terminalId, 'not queued')).rejects.toThrow('congested');
    expect(f.socket.frames().filter((frame) => frame.type === 'terminal.write')).toEqual([]);
    expect(f.transport.connection).toBeNull();
  });

  it('times out creation, fences late replies, and never recreates or replays input on reconnect', async () => {
    vi.useFakeTimers();
    const f = await transportFixture();
    const pending = f.transport.terminal.createTerminal(scope, 80, 24);
    const rejected = expect(pending).rejects.toThrow('timed out');
    vi.advanceTimersByTime(5_000); await rejected;
    expect(f.disconnected).toHaveBeenCalledOnce();
    await f.transport.connect();
    const next = Socket.instances.at(-1)!;
    f.socket.receive(created());
    expect(next.frames()).toEqual([]);
    await expect(f.transport.terminal.writeTerminal(terminalId, 'never')).rejects.toThrow('former connection');
    const fresh = f.transport.terminal.createTerminal(scope, 80, 24); next.receive(created(otherTerminalId)); await fresh;
    await f.transport.terminal.writeTerminal(otherTerminalId, 'once');
    next.close();
    await f.transport.connect();
    expect(Socket.instances.at(-1)!.frames()).toEqual([]);
    await expect(f.transport.terminal.writeTerminal(otherTerminalId, 'old')).rejects.toThrow('former connection');
  });

  it('closes a stalled consumer after a bounded ACK wait and cancels pending creation on scope loss', async () => {
    vi.useFakeTimers();
    const f = await transportFixture(); await create(f);
    f.socket.receive(output(1, 'unconsumed'));
    vi.advanceTimersByTime(15_000);
    expect(f.socket.frames().at(-1)).toEqual({ protocol: 1, type: 'terminal.close', id: terminalId });
    expect(f.events.at(-1)).toEqual({ type: 'exit', id: terminalId, exitCode: -1 });
    expect(f.socket.readyState).toBe(1);
    const pending = f.transport.terminal.createTerminal(scope, 80, 24);
    const rejected = expect(pending).rejects.toThrow('scope or control changed');
    f.transport.terminal.closeAll(); await rejected;
    expect(f.socket.readyState).toBe(3);
    vi.advanceTimersByTime(30_000);
    expect(f.disconnected).toHaveBeenCalledOnce();
  });

  it('retires a pending shell when its sole consumer detaches', async () => {
    const f = await transportFixture();
    const pending = f.transport.terminal.createTerminal(scope, 80, 24);
    const rejected = expect(pending).rejects.toThrow('scope or control changed');
    f.unsubscribe(); await rejected;
    expect(f.socket.readyState).toBe(3);
    expect(f.disconnected).toHaveBeenCalledOnce();
  });

  it('delivers a host exit once and clears ACK timers without closing the event connection', async () => {
    vi.useFakeTimers();
    const f = await transportFixture(); await create(f);
    f.socket.receive(output(1, 'last'));
    f.socket.receive({ protocol: 1, type: 'terminal.event', event: { type: 'exit', id: terminalId, exitCode: 7, signal: 2 } });
    expect(f.events.at(-1)).toEqual({ type: 'exit', id: terminalId, exitCode: 7, signal: 2 });
    await expect(f.transport.terminal.acknowledgeTerminal(terminalId, 4)).rejects.toThrow('former connection');
    vi.advanceTimersByTime(15_000);
    expect(f.socket.frames().map((frame) => frame.type)).toEqual(['terminal.create']);
    expect(f.socket.readyState).toBe(1);
  });

  it('accepts only bounded shared schemas and an exclusive output consumer', async () => {
    const f = await transportFixture();
    expect(() => f.transport.terminal.onTerminalEvent(() => undefined)).toThrow('already has a consumer');
    expect(terminalClientFrameSchema.safeParse({ protocol: 1, type: 'terminal.create', ...scope, cols: 400, rows: 1 }).success).toBe(true);
    expect(terminalClientFrameSchema.safeParse({ protocol: 1, type: 'terminal.create', ...scope, controlGeneration: 0, cols: 80, rows: 24 }).success).toBe(false);
    expect(terminalServerFrameSchema.safeParse({ protocol: 1, type: 'terminal.created', result: { ...result, warning: '' } }).success).toBe(false);
  });
});

async function webFixture(options: { advertised?: boolean; permission?: 'read-only' | 'edit'; implemented?: boolean } = {}) {
  installSockets(); Socket.autoSubscribe = true;
  const header: SnapshotHeader = { version: 1, snapshotId, capturedAt: Date.now(), expiresAt: Date.now() + 60_000,
    workspaceId, workspaceGeneration: 3, serverEpoch: epoch, sessionId, eventCursor: 2, selectionRevision: 4,
    eventStream: cursor, pageIds: [pageId], controls: { status: 'ready', streaming: false, activeSessionRunning: false,
      runningSessionCount: 0, permissionLevel: options.permission ?? 'edit', thinkingLevel: 'medium', model: null, pendingModel: null,
      pendingThinkingLevel: null, sessionOperation: false, queue: { steering: 0, followUp: 0, pending: 0, held: 0, recovered: 0 } },
    goal: null, taskRevision: null, tasks: [], agents: [], omissions: { history: true, media: true, clippedItems: 0,
      agentRows: false, taskRows: false, goalText: false, taskText: false, agentText: false, queueContents: true }, warnings: [] };
  const send: typeof fetch = vi.fn(async (input, init) => {
    if (String(input).endsWith('/api/info')) return new Response(JSON.stringify({ protocol: 1, serverEpoch: epoch,
      serverTime: Date.now(), kind: 'browser', capabilities: ['host.info'], workspaceCount: 1 }));
    const request = requestEnvelopeSchema.parse(JSON.parse(String(init?.body)));
    const result = request.method === 'host.info' ? { hostId: otherTerminalId, protocol: 1, serverEpoch: epoch,
      serverTime: Date.now(), appVersion: '1.1.0', hostName: 'Test host', capabilities: ['host.info', 'workspace.list', 'workspace.snapshot', 'workspace.control',
        ...(options.advertised === false ? [] : ['terminal.manual'])], networkDispatchEnabled: true }
      : request.method === 'workspace.snapshot' ? { version: 1, snapshotId, pageId, index: 0, header, nextPageId: null, items: [] }
        : request.method === 'workspace.list' ? { workspaces: [selected] }
          : request.method === 'control.claim' || request.method === 'control.renew' ? { generation: 2, expiresAt: Date.now() + 15_000 }
            : request.method === 'control.release' ? { generation: 3, expiresAt: null } : null;
    return new Response(JSON.stringify({ protocol: 1, ok: true, requestId: request.requestId, serverEpoch: epoch, method: request.method, result,
      scope: request.method === 'host.info' || request.method === 'workspace.list' ? null : { workspaceId, workspaceGeneration: 3 } }));
  });
  const web = new WebFateApi(origin, { sessionId, csrfToken, expiresAt: Date.now() + 60_000 }, { send,
    ...(options.implemented === false ? { makeEvents: () => ({ connection: ready, connect: async () => ready,
      subscribe: async () => cursor, close: () => undefined }) } : {}) });
  cleanup.push(() => web.close());
  await web.connect();
  await web.readSnapshot(selected);
  return { web, socket: Socket.instances[0], header };
}

describe('browser facade terminal authority and capability', () => {
  it.each([
    { options: { advertised: false }, supported: false },
    { options: { implemented: false }, supported: false },
    { options: {}, supported: true },
  ])('requires host advertisement and implemented transport: $supported', async ({ options, supported }) => {
    const f = await webFixture(options);
    installWebFateApi(f.web);
    expect(f.web.supports('terminal.manual')).toBe(supported);
    expect(hasCapability('manualTerminal')).toBe(supported);
    expect(getFateApi().capabilities?.manualTerminal).toBe(supported);
    expect(Boolean(getTerminalApiOptional())).toBe(supported);
    expect(getDesktopApiOptional()).toBeUndefined();
    if (!supported && f.web.terminal) await expect(f.web.terminal.createTerminal(80, 24)).rejects.toThrow('control');
    f.web.close();
    expect(hasCapability('manualTerminal')).toBe(false);
    expect(getFateApi().capabilities?.manualTerminal).toBe(false);
  });

  it('blocks observers and read-only sessions before shell creation', async () => {
    const f = await webFixture({ permission: 'read-only' });
    await expect(f.web.terminal!.createTerminal(80, 24)).rejects.toThrow('control');
    await f.web.claimControl(selected);
    await expect(f.web.terminal!.createTerminal(80, 24)).rejects.toThrow('non-read-only');
    expect(f.socket!.frames()).toEqual([]);
  });

  it('binds the host-issued scope and closes before releasing control; later input is not sent', async () => {
    const f = await webFixture(); await f.web.claimControl(selected);
    const pending = f.web.terminal!.createTerminal(80, 24); f.socket!.receive(created()); await pending;
    expect(f.socket!.frames()[0]).toEqual({ protocol: 1, type: 'terminal.create', ...scope, cols: 80, rows: 24 });
    await f.web.releaseControl(selected);
    expect(f.socket!.frames().at(-1)).toEqual({ protocol: 1, type: 'terminal.close', id: terminalId });
    await expect(f.web.terminal!.writeTerminal(terminalId, 'no')).rejects.toThrow('control');
  });

  it('closes on control takeover and workspace changes, without input replay or inherited consent', async () => {
    const f = await webFixture(); await f.web.claimControl(selected);
    const pending = f.web.terminal!.createTerminal(80, 24); f.socket!.receive(created()); await pending;
    f.socket!.receive({ type: 'event', event: { version: 1, serverEpoch: epoch, streamId, sequence: 3,
      origin: { workspaceId, workspaceGeneration: 3, sessionId: null }, category: 'control', eventType: 'control.changed', controlGeneration: 3 } });
    expect(f.web.control).toBeNull();
    expect(f.socket!.frames().at(-1)?.type).toBe('terminal.close');
    await expect(f.web.terminal!.writeTerminal(terminalId, 'old')).rejects.toThrow('control');
    // A second facade proves a workspace switch closes an otherwise live shell too.
    const second = await webFixture(); await second.web.claimControl(selected);
    const shell = second.web.terminal!.createTerminal(80, 24); second.socket!.receive(created()); await shell;
    await expect(second.web.readSnapshot({ ...selected, workspaceId: otherTerminalId })).rejects.toThrow();
    expect(second.socket!.frames().at(-1)?.type).toBe('terminal.close');
  });

  it('closes when a refreshed permission becomes read-only and rejects new creation', async () => {
    const f = await webFixture(); await f.web.claimControl(selected);
    const pending = f.web.terminal!.createTerminal(80, 24); f.socket!.receive(created()); await pending;
    f.header.controls.permissionLevel = 'read-only';
    await f.web.readSnapshot(selected);
    expect(f.socket!.frames().at(-1)?.type).toBe('terminal.close');
    await expect(f.web.terminal!.createTerminal(80, 24)).rejects.toThrow('non-read-only');
  });

  it('closes a quiet terminal at lease expiry, honors renewal, and cancels pending creation on disconnect', async () => {
    vi.useFakeTimers();
    const f = await webFixture(); await f.web.claimControl(selected);
    const pending = f.web.terminal!.createTerminal(80, 24); f.socket!.receive(created()); await pending;
    vi.advanceTimersByTime(10_000);
    await f.web.renewControl(selected);
    vi.advanceTimersByTime(5_000);
    expect(f.socket!.frames().at(-1)?.type).toBe('terminal.create');
    vi.advanceTimersByTime(10_000);
    expect(f.socket!.frames().at(-1)?.type).toBe('terminal.close');
    await f.web.claimControl(selected);
    const starting = f.web.terminal!.createTerminal(80, 24);
    const rejected = expect(starting).rejects.toThrow('connection closed');
    f.socket!.close(); await rejected;
    expect(f.web.control).toBeNull();
    expect(f.web.supports('terminal.manual')).toBe(false);
    f.web.close();
    vi.advanceTimersByTime(30_000);
    expect(Socket.instances).toHaveLength(1);
  });
});
