import { WebSocket } from 'ws';
import { z } from 'zod';
import { eventCursorSchema, type EventCursor } from '../../shared/protocol/events';
import { forwardedHostSchema } from '../../shared/protocol/connectionProfiles';
import { NetworkEventReplayGate, networkEventSchema, type NetworkEvent } from '../../shared/protocol/diagnostics';
import type { EventConnectionInfo } from '../../client/EventTransport';

const readySchema = z.object({ protocol: z.literal(1), type: z.literal('ready'), clientId: z.string().uuid(),
  serverEpoch: z.string().uuid(), ticket: z.string().regex(/^ft1_[A-Za-z0-9_-]{43}$/u) }).strict();
const subscribedSchema = z.object({ protocol: z.literal(1), type: z.literal('subscribed'), cursor: eventCursorSchema }).strict();
const frameSchema = z.object({ type: z.literal('event'), event: networkEventSchema }).strict();
export class NativeProtocolMismatch extends Error {
  constructor() { super('Remote event protocol is incompatible.'); this.name = 'NativeProtocolMismatch'; }
}
export interface NativeEvents {
  readonly connection: EventConnectionInfo | null;
  connect(): Promise<EventConnectionInfo>;
  subscribe(workspaceId: string, workspaceGeneration: number, cursor: EventCursor): Promise<EventCursor>;
  close(): void;
}

/** Native-only authentication. Bearer is an upgrade HEADER, never URL, hello, or preload data. */
export class NativeEventTransport implements NativeEvents {
  private socket: WebSocket | null = null;
  private info: EventConnectionInfo | null = null;
  private gate: NetworkEventReplayGate | null = null;
  private waiting: { resolve(cursor: EventCursor): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>;
    cursor: EventCursor } | null = null;
  constructor(private readonly origin: string, private readonly credential: string,
    private readonly onEvent: (event: NetworkEvent) => void, private readonly onDisconnect: () => void,
    private readonly forwardedHost?: string) {
    if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(origin) || Number(new URL(origin).port) > 65535
      || !/^fc1_[A-Za-z0-9_-]{43}$/u.test(credential)) throw new Error('Invalid native connection.');
    if (forwardedHost !== undefined) forwardedHostSchema.parse(forwardedHost);
  }
  get connection(): EventConnectionInfo | null { return this.info; }
  private refuseWaiting(): void {
    const waiting = this.waiting; this.waiting = null;
    if (waiting) { clearTimeout(waiting.timer); waiting.reject(new Error('Remote subscription unavailable.')); }
  }
  connect(): Promise<EventConnectionInfo> {
    if (this.socket) throw new Error('Remote event connection already active.');
    const socket = new WebSocket(`${this.origin.replace(/^http:/u, 'ws:')}/api/events`, {
      headers: { Authorization: `Bearer ${this.credential}`, ...(this.forwardedHost === undefined ? {} : { Host: this.forwardedHost }) }, handshakeTimeout: 5000,
      maxPayload: 1024 * 1024, perMessageDeflate: false, followRedirects: false,
    });
    this.socket = socket;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; this.close(); reject(new Error('Remote authentication unavailable.')); } }, 5000);
      const invalid = () => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new NativeProtocolMismatch()); }
        socket.close();
      };
      socket.on('open', () => { if (this.socket === socket) socket.send(JSON.stringify({ protocol: 1, type: 'hello' })); });
      socket.on('message', (data, binary) => {
        if (this.socket !== socket) return;
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (binary || bytes.byteLength > 1024 * 1024) { invalid(); return; }
        let value: unknown;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
        catch { invalid(); return; }
        if (!this.info) {
          const parsed = readySchema.safeParse(value);
          if (!parsed.success) { invalid(); return; }
          this.info = { clientId: parsed.data.clientId, serverEpoch: parsed.data.serverEpoch, ticket: parsed.data.ticket };
          settled = true; clearTimeout(timer); resolve(this.info); return;
        }
        const subscribed = subscribedSchema.safeParse(value);
        if (subscribed.success) {
          const waiting = this.waiting, cursor = subscribed.data.cursor;
          if (!waiting || cursor.serverEpoch !== this.info.serverEpoch || cursor.workspaceId !== waiting.cursor.workspaceId
            || cursor.workspaceGeneration !== waiting.cursor.workspaceGeneration || cursor.streamId !== waiting.cursor.streamId
            || cursor.sequence < waiting.cursor.sequence) { socket.close(); return; }
          this.gate = new NetworkEventReplayGate(waiting.cursor);
          this.waiting = null; clearTimeout(waiting.timer); waiting.resolve(cursor); return;
        }
        const frame = frameSchema.safeParse(value);
        if (!frame.success || !this.gate || frame.data.event.serverEpoch !== this.info.serverEpoch) { socket.close(); return; }
        try { const event = this.gate.accept(frame.data.event); if (event) this.onEvent(event); }
        catch { socket.close(); }
      });
      socket.on('error', () => { socket.close(); });
      socket.on('close', () => {
        clearTimeout(timer);
        if (this.socket === socket) {
          const authenticated = this.info !== null;
          this.socket = null; this.info = null; this.gate = null; this.refuseWaiting();
          if (authenticated) this.onDisconnect();
        }
        if (!settled) { settled = true; reject(new Error('Remote authentication unavailable.')); }
      });
    });
  }
  subscribe(workspaceId: string, workspaceGeneration: number, input: EventCursor): Promise<EventCursor> {
    if (!this.socket || !this.info || this.socket.readyState !== WebSocket.OPEN) throw new Error('Remote event connection unavailable.');
    const cursor = eventCursorSchema.parse(input);
    if (cursor.workspaceId !== workspaceId || cursor.workspaceGeneration !== workspaceGeneration
      || cursor.serverEpoch !== this.info.serverEpoch) throw new Error('Remote scope changed.');
    this.refuseWaiting(); this.gate = null;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.refuseWaiting(); this.socket?.close(); }, 5000);
      this.waiting = { resolve, reject, timer, cursor };
      try { this.socket!.send(JSON.stringify({ protocol: 1, type: 'subscribe', workspaceId, workspaceGeneration, cursor })); }
      catch { this.refuseWaiting(); }
    });
  }
  close(): void {
    this.refuseWaiting();
    const socket = this.socket; this.socket = null; this.info = null; this.gate = null;
    socket?.close();
  }
}
