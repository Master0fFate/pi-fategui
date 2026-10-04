import { z } from 'zod';
import { eventCursorSchema, type EventCursor } from '../shared/protocol/events';
import { NetworkEventReplayGate, networkEventSchema, type NetworkEvent } from '../shared/protocol/diagnostics';
import { BrowserTerminalClient } from './BrowserTerminalClient';
import type { TerminalClientFrame } from '../shared/protocol/terminal';

const readySchema = z.object({ protocol: z.literal(1), type: z.literal('ready'), clientId: z.string().uuid(),
  serverEpoch: z.string().uuid(), ticket: z.string().regex(/^ft1_[A-Za-z0-9_-]{43}$/u) }).strict();
const subscribedSchema = z.object({ protocol: z.literal(1), type: z.literal('subscribed'), cursor: eventCursorSchema }).strict();
export interface EventConnectionInfo { readonly clientId: string; readonly serverEpoch: string; readonly ticket: string }
type SubscriptionRequest = { workspaceId: string; workspaceGeneration: number; cursor?: EventCursor };
type SubscriptionWaiter = { request: SubscriptionRequest; resolve: (cursor: EventCursor) => void; reject: (error: Error) => void };

/** Browser transport only; native bearer handshake uses a main-process adapter later.
 * Codes and persistent credentials are never placed in the URL or browser storage. */
export class EventTransport {
  private socket: WebSocket | null = null;
  private info: EventConnectionInfo | null = null;
  private gate: NetworkEventReplayGate | null = null;
  private cancelAuthentication: (() => void) | null = null;
  readonly terminal = new BrowserTerminalClient((frame) => this.sendTerminal(frame), () => this.abortConnection());
  private sendTerminal(frame: TerminalClientFrame): void {
    const socket = this.socket;
    if (!socket || !this.info || socket.readyState !== WebSocket.OPEN) throw new Error('The manual terminal connection is unavailable.');
    const text = JSON.stringify(frame);
    // A browser WebSocket has an internal send buffer. Refuse rather than accumulating keystrokes.
    if (socket.bufferedAmount + new TextEncoder().encode(text).byteLength > 256 * 1024) {
      this.abortConnection();
      throw new Error('Terminal connection is congested. Input was not queued or replayed.');
    }
    try { socket.send(text); }
    catch {
      this.abortConnection();
      throw new Error('Terminal send failed. Input was not replayed.');
    }
  }
  private abortConnection(): void {
    const authenticated = this.info !== null;
    this.close();
    if (authenticated) this.onDisconnect();
  }
  // No request ID exists on subscribed ACKs: never put two subscriptions on the wire.
  private subscription: (SubscriptionWaiter & { timer: ReturnType<typeof setTimeout> }) | null = null;
  private queued: SubscriptionWaiter | null = null;
  private rejectSubscriptions(error: Error): void {
    const waiting = this.subscription;
    const queued = this.queued;
    this.subscription = null; this.queued = null;
    if (waiting) { clearTimeout(waiting.timer); waiting.reject(error); }
    queued?.reject(error);
  }
  private sendSubscription(waiting: SubscriptionWaiter): void {
    const timer = setTimeout(() => {
      if (this.subscription?.timer !== timer) return;
      this.rejectSubscriptions(new Error('Event subscription timed out.'));
      this.abortConnection();
    }, 5_000);
    this.subscription = { ...waiting, timer };
    try { this.socket!.send(JSON.stringify({ protocol: 1, type: 'subscribe', ...waiting.request })); }
    catch (error) {
      this.rejectSubscriptions(error instanceof Error ? error : new Error('Event subscription failed.'));
      this.abortConnection(); // A failed send cannot leave an ambiguous wire request reusable.
    }
  }
  constructor(private readonly url: string, private readonly csrf: () => string,
    private readonly onEvent: (event: NetworkEvent) => void,
    private readonly socketFactory: (url: string) => WebSocket = (target) => new WebSocket(target),
    private readonly onDisconnect: () => void = () => undefined) {
    if (!/^ws:\/\/(?:127\.0\.0\.1|localhost):[1-9][0-9]{0,4}\/api\/events$/u.test(url)) throw new Error('Only the authenticated loopback event endpoint is supported.');
  }
  get connection(): EventConnectionInfo | null { return this.info; }
  connect(): Promise<EventConnectionInfo> {
    if (this.socket) throw new Error('The event transport is already connected.');
    const socket = this.socketFactory(this.url);
    this.socket = socket;
    return new Promise<EventConnectionInfo>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; this.close(); reject(new Error('Event authentication timed out.')); } }, 5_000);
      this.cancelAuthentication = () => {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(new Error('Event connection closed before authentication.')); }
      };
      socket.onopen = () => {
        if (this.socket !== socket) return;
        try { socket.send(JSON.stringify({ protocol: 1, type: 'hello', csrf: this.csrf() })); }
        catch { this.abortConnection(); }
      };
      socket.onmessage = (message) => {
        if (this.socket !== socket) return;
        if (typeof message.data !== 'string' || new TextEncoder().encode(message.data).byteLength > 1024 * 1024) {
          this.abortConnection(); return;
        }
        let value: unknown;
        try { value = JSON.parse(message.data) as unknown; } catch { this.abortConnection(); return; }
        if (!this.info) {
          const parsed = readySchema.safeParse(value);
          if (!parsed.success) { this.abortConnection(); return; }
          this.info = parsed.data;
          this.cancelAuthentication = null;
          settled = true; clearTimeout(timer); resolve(parsed.data);
          return;
        }
        if (typeof value === 'object' && value !== null && 'type' in value
          && typeof value.type === 'string' && value.type.startsWith('terminal.')) {
          try { this.terminal.accept(value); } catch { this.abortConnection(); }
          return;
        }
        const subscribed = subscribedSchema.safeParse(value);
        if (subscribed.success) {
          const waiting = this.subscription;
          const request = waiting?.request;
          const cursor = subscribed.data.cursor;
          if (!request || cursor.serverEpoch !== this.info.serverEpoch || cursor.workspaceId !== request.workspaceId
            || cursor.workspaceGeneration !== request.workspaceGeneration
            || request.cursor && (request.cursor.streamId !== cursor.streamId || cursor.sequence < request.cursor.sequence)
            || !waiting) { this.abortConnection(); return; }
          // The ACK is the ordered boundary: all earlier frames belong to the old gate.
          this.gate = new NetworkEventReplayGate({ ...cursor, sequence: request.cursor?.sequence ?? 0 });
          this.subscription = null;
          clearTimeout(waiting.timer);
          waiting.resolve(cursor);
          const queued = this.queued;
          this.queued = null;
          if (queued) this.sendSubscription(queued);
          return;
        }
        const frame = z.object({ type: z.literal('event'), event: networkEventSchema }).strict().safeParse(value);
        if (!frame.success || frame.data.event.serverEpoch !== this.info.serverEpoch || !this.gate) { this.abortConnection(); return; }
        try { const event = this.gate.accept(frame.data.event); if (event) this.onEvent(event); }
        catch { this.abortConnection(); }
      };
      socket.onerror = () => {
        if (this.socket === socket) this.abortConnection();
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Event connection failed.')); }
      };
      socket.onclose = () => {
        clearTimeout(timer);
        if (this.socket === socket) {
          const authenticated = this.info !== null;
          this.info = null; this.socket = null; this.gate = null;
          this.cancelAuthentication = null;
          this.rejectSubscriptions(new Error('Event subscription closed before confirmation.'));
          this.terminal.disconnect();
          if (authenticated) this.onDisconnect();
        }
        if (!settled) { settled = true; reject(new Error('Event connection closed before authentication.')); }
      };
    });
  }
  subscribe(workspaceId: string, workspaceGeneration: number, cursor?: EventCursor): Promise<EventCursor> {
    if (!this.socket || !this.info || this.socket.readyState !== WebSocket.OPEN) throw new Error('The event connection is not authenticated.');
    const parsed = cursor ? eventCursorSchema.parse(cursor) : undefined;
    const request = { workspaceId, workspaceGeneration, ...(parsed ? { cursor: parsed } : {}) };
    return new Promise<EventCursor>((resolve, reject) => {
      const waiting = { request, resolve, reject };
      if (this.subscription) {
        // Bound refresh bursts to one latest unsent request. Keep the in-flight ACK
        // correlated with its original cursor and retain the authorized event gate.
        this.queued?.reject(new Error('Event subscription superseded.'));
        this.queued = waiting;
      } else this.sendSubscription(waiting);
    });
  }
  close(): void {
    this.rejectSubscriptions(new Error('Event subscription closed before confirmation.'));
    const socket = this.socket;
    this.socket = null; this.info = null; this.gate = null;
    const cancelAuthentication = this.cancelAuthentication;
    this.cancelAuthentication = null;
    cancelAuthentication?.();
    try { this.terminal.disconnect(); }
    finally { socket?.close(); }
  }
}
