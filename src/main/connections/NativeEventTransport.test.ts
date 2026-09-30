import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockWs = vi.hoisted(() => {
  const created: Socket[] = [];
  class Socket {
    static readonly OPEN = 1;
    readonly sent: string[] = [];
    readyState = 1;
    private readonly handlers = new Map<string, Array<(...arguments_: unknown[]) => void>>();
    constructor(readonly url: string, readonly options: Readonly<Record<string, unknown>>) { created.push(this); }
    on(event: string, handler: (...arguments_: unknown[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]); return this;
    }
    send(value: string) { this.sent.push(value); }
    emit(event: string, ...arguments_: unknown[]) { for (const handler of this.handlers.get(event) ?? []) handler(...arguments_); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
  }
  return { Socket, created };
});
vi.mock('ws', () => ({ WebSocket: mockWs.Socket }));
import { NativeEventTransport, NativeProtocolMismatch } from './NativeEventTransport';

const credential = `fc1_${'n'.repeat(43)}`, ticket = `ft1_${'q'.repeat(43)}`;
const epoch = randomUUID(), workspaceId = randomUUID(), streamId = randomUUID();
const cursor = { serverEpoch: epoch, workspaceId, workspaceGeneration: 3, streamId, sequence: 0 };
const frame = (sequence: number, eventType: string) => ({ type: 'event', event: { version: 1, serverEpoch: epoch, streamId, sequence,
  origin: { workspaceId, workspaceGeneration: 3, sessionId: eventType === 'control.changed' ? null : randomUUID() },
  category: eventType === 'control.changed' ? 'control' : 'pi', eventType,
  ...(eventType === 'control.changed' ? { controlGeneration: 3 } : {}) } });
const message = (socket: InstanceType<typeof mockWs.Socket>, value: unknown) => socket.emit('message', Buffer.from(JSON.stringify(value)), false);
beforeEach(() => { mockWs.created.splice(0); });

describe('main native WebSocket header ownership without network access', () => {
  it('uses bearer only in the upgrade header, never URL/hello/subscription or public connection DTOs', async () => {
    const transport = new NativeEventTransport('http://127.0.0.1:49331', credential, vi.fn(), vi.fn());
    const pending = transport.connect(), socket = mockWs.created[0]!;
    expect(socket.url).toBe('ws://127.0.0.1:49331/api/events');
    expect(socket.options).toMatchObject({ headers: { Authorization: `Bearer ${credential}` }, handshakeTimeout: 5000,
      maxPayload: 1024 * 1024, perMessageDeflate: false, followRedirects: false });
    expect(socket.options).not.toHaveProperty('headers.Cookie'); expect(socket.options).not.toHaveProperty('headers.Origin');
    socket.emit('open'); expect(JSON.parse(socket.sent[0]!)).toEqual({ protocol: 1, type: 'hello' });
    message(socket, { protocol: 1, type: 'ready', clientId: randomUUID(), serverEpoch: epoch, ticket }); await pending;
    const subscription = transport.subscribe(workspaceId, 3, cursor);
    expect(JSON.parse(socket.sent[1]!)).toEqual({ protocol: 1, type: 'subscribe', workspaceId, workspaceGeneration: 3, cursor });
    message(socket, { protocol: 1, type: 'subscribed', cursor }); await subscription;
    const wire = JSON.stringify({ url: socket.url, outbound: socket.sent });
    expect(wire).not.toContain(credential); expect(wire).not.toContain(ticket); transport.close();
  });
  it('delivers explicit control metadata after ordinary events, ignores duplicates, and fences a sequence gap', async () => {
    const onEvent = vi.fn(), disconnected = vi.fn();
    const transport = new NativeEventTransport('http://127.0.0.1:49331', credential, onEvent, disconnected);
    const pending = transport.connect(), socket = mockWs.created[0]!;
    message(socket, { protocol: 1, type: 'ready', clientId: randomUUID(), serverEpoch: epoch, ticket }); await pending;
    const subscription = transport.subscribe(workspaceId, 3, cursor); message(socket, { protocol: 1, type: 'subscribed', cursor }); await subscription;
    message(socket, frame(1, 'task.updated')); message(socket, frame(2, 'control.changed')); message(socket, frame(2, 'control.changed'));
    expect(onEvent).toHaveBeenCalledTimes(2); expect(onEvent.mock.calls[1]?.[0]).toMatchObject({ eventType: 'control.changed', sequence: 2 });
    message(socket, frame(4, 'task.updated')); expect(disconnected).toHaveBeenCalledOnce(); expect(transport.connection).toBeNull(); transport.close();
  });
  it('classifies malformed/version-mismatched ready frames as incompatible, without exposing the frame', async () => {
    const transport = new NativeEventTransport('http://127.0.0.1:49331', credential, vi.fn(), vi.fn());
    const pending = transport.connect(), refused = expect(pending).rejects.toBeInstanceOf(NativeProtocolMismatch);
    message(mockWs.created[0]!, { protocol: 2, type: 'ready', credential, ticket });
    await refused; expect(transport.connection).toBeNull(); transport.close();
  });
  it('refuses owner credentials or nonnumeric/redirect endpoints before creating any socket', () => {
    expect(() => new NativeEventTransport('http://127.0.0.1:49331', `fo1_${'o'.repeat(43)}`, vi.fn(), vi.fn())).toThrow();
    expect(() => new NativeEventTransport('http://localhost:49331', credential, vi.fn(), vi.fn())).toThrow();
    expect(() => new NativeEventTransport('http://127.0.0.1:49331/redirect', credential, vi.fn(), vi.fn())).toThrow();
    expect(mockWs.created).toEqual([]);
  });
});
