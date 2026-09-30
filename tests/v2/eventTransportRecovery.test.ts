import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventTransport } from '../../src/client/EventTransport';

const epoch = '10000000-0000-4000-8000-000000000001';
const workspaceId = '20000000-0000-4000-8000-000000000002';
const streamId = '70000000-0000-4000-8000-000000000007';
const cursor = { serverEpoch: epoch, workspaceId, workspaceGeneration: 3, streamId, sequence: 2 };
const event = (sequence: number) => ({ type: 'event', event: { version: 1, serverEpoch: epoch, streamId, sequence,
  origin: { workspaceId, workspaceGeneration: 3, sessionId: null }, category: 'pi', eventType: 'assistant.text' } });

class Socket {
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  send(value: string): void { this.sent.push(value); }
  receive(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
  close(): void { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

async function connectedTransport() {
  vi.stubGlobal('WebSocket', { OPEN: 1 });
  const socket = new Socket();
  const seen: number[] = [];
  const disconnected = vi.fn();
  const transport = new EventTransport('ws://127.0.0.1:49301/api/events', () => `fx1_${'x'.repeat(43)}`,
    (value) => seen.push(value.sequence), () => socket as unknown as WebSocket, disconnected);
  const connection = transport.connect();
  socket.onopen?.();
  socket.receive({ protocol: 1, type: 'ready', clientId: '80000000-0000-4000-8000-000000000008', serverEpoch: epoch,
    ticket: `ft1_${'a'.repeat(43)}` });
  await connection;
  return { transport, socket, seen, disconnected };
}

describe('authenticated event replay barrier', () => {
  it('retains the authorized gate for an in-flight control event until the refresh ACK', async () => {
    const { transport, socket, seen, disconnected } = await connectedTransport();
    const initial = transport.subscribe(workspaceId, 3, cursor);
    socket.receive({ protocol: 1, type: 'subscribed', cursor });
    await initial;
    const refreshCursor = { ...cursor, sequence: 3 };
    let confirmed = false;
    const refresh = transport.subscribe(workspaceId, 3, refreshCursor).then(() => { confirmed = true; });
    // control.claim can publish before a concurrent snapshot's subscribe ACK.
    socket.receive({ type: 'event', event: { ...event(3).event, category: 'control', eventType: 'control.changed', controlGeneration: 2 } });
    expect(seen).toEqual([3]);
    expect(confirmed).toBe(false);
    expect(disconnected).not.toHaveBeenCalled();
    socket.receive({ protocol: 1, type: 'subscribed', cursor: { ...cursor, sequence: 4 } });
    await refresh;
    socket.receive(event(4));
    expect(seen).toEqual([3, 4]);
    expect(socket.readyState).toBe(1);
    transport.close();
  });

  it('serializes overlapping refreshes and bounds pending work to the latest unsent cursor', async () => {
    const { transport, socket, seen, disconnected } = await connectedTransport();
    const first = transport.subscribe(workspaceId, 3, cursor);
    const replaced = transport.subscribe(workspaceId, 3, { ...cursor, sequence: 6 });
    const rejected = expect(replaced).rejects.toThrow('superseded');
    let latestConfirmed = false;
    const latestCursor = { ...cursor, sequence: 8 };
    const latest = transport.subscribe(workspaceId, 3, latestCursor).then((ack) => { latestConfirmed = true; return ack; });
    await rejected;
    expect(socket.sent.map((frame) => JSON.parse(frame).type)).toEqual(['hello', 'subscribe']);
    // This is the ACK for sequence 2, NOT confirmation of the queued sequence 8.
    socket.receive({ protocol: 1, type: 'subscribed', cursor: { ...cursor, sequence: 3 } });
    expect(await first).toEqual({ ...cursor, sequence: 3 });
    expect(latestConfirmed).toBe(false);
    expect(socket.sent.map((frame) => JSON.parse(frame).type)).toEqual(['hello', 'subscribe', 'subscribe']);
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ cursor: latestCursor });
    socket.receive(event(3)); socket.receive(event(4)); // Old replay remains authorized while the latest ACK is pending.
    expect(seen).toEqual([3, 4]);
    expect(disconnected).not.toHaveBeenCalled();
    socket.receive({ protocol: 1, type: 'subscribed', cursor: latestCursor });
    expect(await latest).toEqual(latestCursor);
    socket.receive(event(9));
    expect(seen).toEqual([3, 4, 9]);
    expect(socket.readyState).toBe(1);
    transport.close();
  });

  it('does not accept a stale ACK below the newer serialized cursor', async () => {
    const { transport, socket, disconnected } = await connectedTransport();
    const first = transport.subscribe(workspaceId, 3, cursor);
    const latest = transport.subscribe(workspaceId, 3, { ...cursor, sequence: 8 });
    const rejected = expect(latest).rejects.toThrow('closed before confirmation');
    socket.receive({ protocol: 1, type: 'subscribed', cursor: { ...cursor, sequence: 3 } });
    await first;
    socket.receive({ protocol: 1, type: 'subscribed', cursor: { ...cursor, sequence: 3 } });
    await rejected;
    expect(disconnected).toHaveBeenCalledOnce();
    expect(transport.connection).toBeNull();
  });

  it.each([
    ['epoch', { serverEpoch: '10000000-0000-4000-8000-000000000009' }],
    ['stream', { streamId: '70000000-0000-4000-8000-000000000009' }],
    ['scope', { origin: { workspaceId: '20000000-0000-4000-8000-000000000009', workspaceGeneration: 3, sessionId: null } }],
    ['generation', { origin: { workspaceId, workspaceGeneration: 4, sessionId: null } }],
    ['gap', { sequence: 4 }],
    ['schema', { unexpected: true }],
  ])('still rejects an invalid %s event against the retained gate during refresh', async (_name, change) => {
    const { transport, socket, seen, disconnected } = await connectedTransport();
    const initial = transport.subscribe(workspaceId, 3, cursor);
    socket.receive({ protocol: 1, type: 'subscribed', cursor });
    await initial;
    const refresh = transport.subscribe(workspaceId, 3, cursor);
    const rejected = expect(refresh).rejects.toThrow('closed before confirmation');
    socket.receive({ type: 'event', event: { ...event(3).event, ...change } });
    await rejected;
    expect(seen).toEqual([]);
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it('requires the first ACK before accepting any event', async () => {
    const { transport, socket, seen, disconnected } = await connectedTransport();
    const initial = transport.subscribe(workspaceId, 3, cursor);
    const rejected = expect(initial).rejects.toThrow('closed before confirmation');
    socket.receive(event(3));
    await rejected;
    expect(seen).toEqual([]);
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it('bounds an unacknowledged wire request and rejects its queued successor on timeout', async () => {
    vi.useFakeTimers();
    const { transport, socket, disconnected } = await connectedTransport();
    const first = transport.subscribe(workspaceId, 3, cursor);
    const latest = transport.subscribe(workspaceId, 3, { ...cursor, sequence: 8 });
    const firstRejected = expect(first).rejects.toThrow('timed out');
    const latestRejected = expect(latest).rejects.toThrow('timed out');
    vi.advanceTimersByTime(5_000);
    await Promise.all([firstRejected, latestRejected]);
    expect(socket.sent.map((frame) => JSON.parse(frame).type)).toEqual(['hello', 'subscribe']);
    expect(disconnected).toHaveBeenCalledOnce();
    expect(transport.connection).toBeNull();
  });

  it('waits for a matching subscription ACK, rejects a replay gap, and ignores late frames from the old socket', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1 });
    const sockets: Socket[] = [];
    const seen: number[] = [];
    const disconnected = vi.fn();
    const transport = new EventTransport('ws://127.0.0.1:49301/api/events', () => `fx1_${'x'.repeat(43)}`,
      (value) => seen.push(value.sequence), () => {
        const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket;
      }, disconnected);
    const firstConnection = transport.connect();
    const first = sockets[0]!;
    first.onopen?.();
    first.receive({ protocol: 1, type: 'ready', clientId: '80000000-0000-4000-8000-000000000008', serverEpoch: epoch,
      ticket: `ft1_${'a'.repeat(43)}` });
    await firstConnection;
    let confirmed = false;
    const subscription = transport.subscribe(workspaceId, 3, cursor).then(() => { confirmed = true; });
    expect(confirmed).toBe(false);
    expect(JSON.parse(first.sent.at(-1)!)).toMatchObject({ type: 'subscribe', cursor });
    first.receive({ protocol: 1, type: 'subscribed', cursor: { ...cursor, sequence: 4 } });
    await subscription;
    first.receive(event(3)); first.receive(event(4));
    expect(seen).toEqual([3, 4]);
    first.receive(event(6)); // Never fill an absent sequence with guessed state.
    expect(disconnected).toHaveBeenCalledOnce();
    expect(transport.connection).toBeNull();
    const secondConnection = transport.connect();
    const second = sockets[1]!;
    second.onopen?.();
    second.receive({ protocol: 1, type: 'ready', clientId: '90000000-0000-4000-8000-000000000009', serverEpoch: epoch,
      ticket: `ft1_${'b'.repeat(43)}` });
    expect((await secondConnection).ticket).toBe(`ft1_${'b'.repeat(43)}`);
    first.receive(event(5));
    expect(seen).toEqual([3, 4]);
    transport.close();
  });
});
