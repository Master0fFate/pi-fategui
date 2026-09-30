import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { WorkspaceEventHub, EventSubscription } from '../../core/events/WorkspaceEventHub';
import { eventCursorSchema } from '../../shared/protocol/events';
import type { SnapshotScope } from '../../shared/protocol/snapshots';
import { ProtocolFault } from '../../shared/protocol/errors';
import { projectNetworkEvent } from '../../shared/protocol/diagnostics';
import type { AuthService } from '../auth/AuthService';
import { ClientTickets } from '../auth/ClientTickets';
import type { RequestContext } from '../../core/dispatch/RequestContext';
import { authenticate, type AuthenticatedPrincipal } from '../http/createHttpServer';
import { apiPath, guardRequest, oneHeader, type HttpGuardConfig } from '../http/requestGuards';

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_BUFFERED_BYTES = 8 * MAX_FRAME_BYTES;
const MAX_QUEUED_FRAMES = 2_000;
const firstFrame = z.object({ protocol: z.literal(1), type: z.literal('hello'), csrf: z.string().max(128).optional() }).strict();
const subscribeFrame = z.object({ protocol: z.literal(1), type: z.literal('subscribe'), workspaceId: z.string().uuid(),
  workspaceGeneration: z.number().int().nonnegative(), cursor: eventCursorSchema.optional() }).strict();
const unsubscribeFrame = z.object({ protocol: z.literal(1), type: z.literal('unsubscribe') }).strict();
const clientFrame = z.union([subscribeFrame, unsubscribeFrame]);

export interface EventConnectionOptions {
  readonly auth: AuthService;
  readonly tickets: ClientTickets;
  readonly events: WorkspaceEventHub;
  readonly serverEpoch: string;
  /** Host-resolved scope; must check the live workspace root against current credential membership. */
  readonly resolveScope: (principal: AuthenticatedPrincipal, workspaceId: string, generation: number,
    connectionId: string) => SnapshotScope | null;
  readonly onDisconnect?: (connectionId: string) => void;
  /** Optional host-owned manual terminal adapter; never enabled by a client frame. */
  readonly onTerminalFrame?: (identity: RequestContext, frame: unknown, send: (value: unknown) => void) => void | Promise<void>;
}

/** WebSocket framing is owned by pinned ws; no unvalidated event broadcast exists. */
export class EventConnection {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false, clientTracking: true });
  private readonly disconnectRevocations: () => void;
  private readonly connections = new Map<string, { ws: WebSocket; principal: AuthenticatedPrincipal; dispose(): void }>();
  constructor(private readonly options: EventConnectionOptions) {
    this.disconnectRevocations = options.auth.subscribeRevocations((event) => {
      for (const connection of [...this.connections.values()]) {
        if (event.kind === 'all' || (event.kind === 'client'
          ? connection.principal.kind === 'client' && connection.principal.principalId === event.clientId
          : connection.principal.kind === 'browser' && connection.principal.principalId === event.sessionId)) {
          connection.dispose();
          connection.ws.close(1008, 'Authorization revoked');
        }
      }
    });
  }
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, config: HttpGuardConfig, cookieName: string): void {
    try {
      if (request.method !== 'GET' || apiPath(request) !== '/api/events') throw new ProtocolFault('INVALID_REQUEST');
      const cookiePresented = oneHeader(request, 'cookie') !== null;
      const origin = guardRequest(request, config, { browserMutation: cookiePresented });
      const { principal, sessionToken } = authenticate(request, this.options.auth, cookieName);
      if (principal.kind === 'browser' && (!origin || !sessionToken)) throw new ProtocolFault('FORBIDDEN');
      if (this.connections.size >= 8) throw new ProtocolFault('BUSY');
      this.wss.handleUpgrade(request, socket, head, (ws) => { this.attach(ws, request, principal, sessionToken, origin, cookieName); });
    } catch {
      socket.destroy();
    }
  }
  private attach(ws: WebSocket, request: IncomingMessage, principal: AuthenticatedPrincipal,
    sessionToken: string | null, origin: string | null, cookieName: string): void {
    const connectionId = randomUUID();
    let ready = false;
    let terminalIdentity: RequestContext | null = null;
    let pendingFrames = 0;
    let subscription: EventSubscription | null = null;
    const queue = (value: unknown): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const text = JSON.stringify(value);
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > MAX_FRAME_BYTES || pendingFrames >= MAX_QUEUED_FRAMES || ws.bufferedAmount + bytes > MAX_BUFFERED_BYTES) {
        ws.close(1013, 'RESYNC_REQUIRED'); return;
      }
      pendingFrames++;
      ws.send(text, { compress: false }, (error) => { pendingFrames--;
        if (error) ws.terminate(); });
    };
    const dispose = () => {
      if (!this.connections.has(connectionId)) return;
      this.connections.delete(connectionId);
      subscription?.close(); subscription = null;
      this.options.tickets.revokeConnection(connectionId);
      this.options.onDisconnect?.(connectionId);
    };
    const live = (): boolean => {
      try {
        const current = authenticate(request, this.options.auth, cookieName);
        return current.principal.principalId === principal.principalId && current.principal.kind === principal.kind;
      } catch { return false; }
    };
    this.connections.set(connectionId, { ws, principal, dispose });
    const timer = setInterval(() => {
      if (!ready) return;
      if (!live()) { ws.close(1008, 'Authorization expired'); return; }
      try { for (const event of subscription?.drain() ?? []) queue({ type: 'event', event: projectNetworkEvent(event) }); }
      catch { ws.close(1013, 'RESYNC_REQUIRED'); }
    }, 50);
    timer.unref?.();
    const firstFrameTimer = setTimeout(() => { if (!ready) ws.close(1008, 'Authentication required'); }, 5_000);
    firstFrameTimer.unref?.();
    ws.on('message', (payload, isBinary) => {
      const bytes = Array.isArray(payload) ? Buffer.concat(payload)
        : Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
      if (isBinary || bytes.byteLength > MAX_FRAME_BYTES || !live()) { ws.close(1008, 'Invalid frame'); return; }
      let decoded: unknown;
      try { decoded = JSON.parse(bytes.toString('utf8')) as unknown; }
      catch { ws.close(1008, 'Invalid frame'); return; }
      if (!ready) {
        const parsed = firstFrame.safeParse(decoded);
        if (!parsed.success || sessionToken && !parsed.data.csrf || !sessionToken && parsed.data.csrf) {
          ws.close(1008, 'Invalid first frame'); return;
        }
        try {
          if (sessionToken) this.options.auth.assertBrowserCsrf(sessionToken, parsed.data.csrf ?? '');
          const ticket = this.options.tickets.issue(principal, connectionId, this.options.serverEpoch, origin);
          terminalIdentity = this.options.tickets.verify(ticket, principal, this.options.serverEpoch, origin);
          ready = true; clearTimeout(firstFrameTimer);
          queue({ protocol: 1, type: 'ready', clientId: connectionId, serverEpoch: this.options.serverEpoch, ticket });
        } catch { ws.close(1008, 'Authorization refused'); }
        return;
      }
      // A manual shell has a separate host capability. Frames never fall through
      // to workspace event subscriptions or interpret a user-supplied owner ID.
      if (typeof decoded === 'object' && decoded !== null && 'type' in decoded
        && typeof decoded.type === 'string' && decoded.type.startsWith('terminal.')) {
        if (!this.options.onTerminalFrame || !terminalIdentity) { ws.close(1008, 'Terminal disabled'); return; }
        try {
          void Promise.resolve(this.options.onTerminalFrame(terminalIdentity, decoded, queue))
            .catch(() => { ws.close(1008, 'Terminal refused'); });
        } catch { ws.close(1008, 'Terminal refused'); }
        return;
      }
      const parsed = clientFrame.safeParse(decoded);
      if (!parsed.success) { ws.close(1008, 'Invalid frame'); return; }
      if (parsed.data.type === 'unsubscribe') { subscription?.close(); subscription = null; return; }
      const scope = this.options.resolveScope(principal, parsed.data.workspaceId, parsed.data.workspaceGeneration, connectionId);
      if (!scope || scope.serverEpoch !== this.options.serverEpoch || scope.principalId !== principal.principalId
        || scope.clientId !== connectionId || !scope.projectPath || !principal.workspaceRoots.includes(scope.projectPath)) {
        ws.close(1008, 'Workspace unavailable'); return;
      }
      subscription?.close(); subscription = null;
      try {
        subscription = this.options.events.subscribe(scope, parsed.data.cursor);
        queue({ protocol: 1, type: 'subscribed', cursor: this.options.events.position(scope) });
        for (const event of subscription.drain()) queue({ type: 'event', event: projectNetworkEvent(event) });
      } catch { ws.close(1013, 'RESYNC_REQUIRED'); }
    });
    ws.on('error', () => { ws.terminate(); });
    ws.on('close', () => { clearTimeout(firstFrameTimer); clearInterval(timer); dispose(); });
  }
  close(): void {
    this.disconnectRevocations();
    for (const connection of [...this.connections.values()]) {
      connection.dispose();
      connection.ws.terminate();
    }
    this.wss.close();
  }
}
