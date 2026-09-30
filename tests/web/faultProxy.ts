import { Agent, createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

export type JsonRecord = Record<string, unknown>;
export interface CommandCapture {
  method: string; request: JsonRecord; headers: IncomingHttpHeaders;
  response?: JsonRecord; status?: number; dropped?: boolean;
}
export interface FrameCapture { socketId: number; direction: 'client' | 'server'; value: JsonRecord; dropped: boolean }
interface HeldResponse { capture: CommandCapture; release(): void }

/** Test-only wire fault injector. It forwards to the actual guarded listener:
 * no synthesized auth, command, status, snapshot or event responses exist here. */
export class FaultProxy {
  private targetPort = 0;
  private nextSocketId = 0;
  private dropResponseMethod: string | null = null;
  private holdResponseMethod: string | null = null;
  private held: HeldResponse | null = null;
  private heldWaiter: ((capture: CommandCapture) => void) | null = null;
  private dropEvent = false;
  private eventOutage = false;
  private readonly sockets = new Set<Duplex>();
  private readonly pairs = new Set<{ client: WebSocket; upstream: WebSocket }>();
  private readonly upgrades = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  // Bound forwarding sockets below the production eight-connection cap. No
  // idle upstream keepalive can consume slots needed by genuine event sockets.
  private readonly agent = new Agent({ keepAlive: false, maxSockets: 4 });
  readonly commands: CommandCapture[] = [];
  readonly frames: FrameCapture[] = [];
  readonly paths: string[] = [];
  readonly server = createServer(async (request, response) => {
    this.paths.push(request.url ?? '');
    if (!this.targetPort) { response.writeHead(503); response.end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const value of request) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += bytes.length;
      if (size > 1024 * 1024 + 1) { response.writeHead(413); response.end(); return; }
      chunks.push(bytes);
    }
    const body = Buffer.concat(chunks);
    let capture: CommandCapture | undefined;
    if (request.url === '/api/command') {
      try {
        const decoded = JSON.parse(body.toString('utf8')) as JsonRecord;
        capture = { method: String(decoded.method), request: decoded, headers: { ...request.headers } };
        this.commands.push(capture);
      } catch { /* Malformed input is forwarded; only the production server rejects it. */ }
    }
    const headers: IncomingHttpHeaders = { ...request.headers, host: `127.0.0.1:${this.targetPort}` };
    delete headers.connection;
    const upstream = httpRequest({ hostname: '127.0.0.1', port: this.targetPort, path: request.url,
      method: request.method, headers, agent: this.agent }, (incoming) => {
      const parts: Buffer[] = [];
      incoming.on('data', (bytes: Buffer) => parts.push(bytes));
      incoming.on('end', () => {
        const bytes = Buffer.concat(parts);
        if (capture) {
          capture.status = incoming.statusCode ?? 0;
          try { capture.response = JSON.parse(bytes.toString('utf8')) as JsonRecord; } catch { /* Non-JSON errors remain observable. */ }
        }
        const deliver = () => {
          if (response.destroyed) return;
          const outgoing = { ...incoming.headers };
          delete outgoing.connection; delete outgoing['transfer-encoding'];
          response.writeHead(incoming.statusCode ?? 502, outgoing);
          response.end(bytes);
        };
        if (capture && capture.method === this.dropResponseMethod) {
          this.dropResponseMethod = null; capture.dropped = true;
          // Send genuine response headers and only part of its actual body.
          // Closing before headers lets Chromium transparently retransmit a
          // reused-socket POST; that tests TCP retry, not a lost application ACK.
          // A declared full length with a truncated JSON body cannot yield a
          // receipt, and the real client must reconcile only the original ID.
          const outgoing = { ...incoming.headers, 'content-length': String(bytes.length) };
          delete outgoing.connection; delete outgoing['transfer-encoding'];
          response.writeHead(incoming.statusCode ?? 502, outgoing);
          response.flushHeaders();
          response.write(bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))), () => response.destroy());
          return;
        }
        if (capture && capture.method === this.holdResponseMethod) {
          this.holdResponseMethod = null;
          this.held = { capture, release: deliver };
          this.heldWaiter?.(capture); this.heldWaiter = null;
          return;
        }
        deliver();
      });
      incoming.on('error', () => response.destroy());
    });
    upstream.on('error', () => response.destroy());
    upstream.end(body);
  });
  private constructor() {
    this.server.on('connection', (socket) => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
    this.server.on('upgrade', (request, socket, head) => {
      this.paths.push(request.url ?? '');
      if (this.eventOutage || !this.targetPort) { socket.destroy(); return; }
      // The actual server must accept Host/Origin/cookie BEFORE this proxy
      // acknowledges a browser upgrade. Hostile handshakes cannot get a fake 101.
      const headers: Record<string, string> = { Host: `127.0.0.1:${this.targetPort}` };
      for (const key of ['origin', 'cookie', 'authorization']) {
        const value = request.headers[key];
        if (typeof value === 'string') headers[key] = value;
      }
      const upstream = new WebSocket(`ws://127.0.0.1:${this.targetPort}${request.url ?? ''}`, { headers, perMessageDeflate: false });
      let upgraded = false;
      upstream.once('error', () => { if (!upgraded) socket.destroy(); });
      socket.once('close', () => { if (!upgraded) upstream.terminate(); });
      upstream.once('open', () => {
        if (socket.destroyed) { upstream.terminate(); return; }
        upgraded = true;
        this.upgrades.handleUpgrade(request, socket, head, (client) => {
          const id = ++this.nextSocketId;
          const pair = { client, upstream };
          this.pairs.add(pair);
          const forward = (source: WebSocket, destination: WebSocket, direction: 'client' | 'server') => {
            source.on('message', (payload, binary) => {
              const bytes = Array.isArray(payload) ? Buffer.concat(payload)
                : Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
              let value: JsonRecord | undefined;
              try { value = JSON.parse(bytes.toString('utf8')) as JsonRecord; } catch { /* Forward malformed frames too. */ }
              const dropped = direction === 'server' && value?.type === 'event' && this.dropEvent;
              if (dropped) this.dropEvent = false;
              if (value) this.frames.push({ socketId: id, direction, value, dropped });
              if (!dropped && destination.readyState === WebSocket.OPEN) destination.send(bytes, { binary, compress: false });
            });
            source.on('error', () => destination.terminate());
            source.on('close', (code, reason) => {
              this.pairs.delete(pair);
              if (destination.readyState === WebSocket.OPEN) {
                if (code === 1006 || code === 1005) destination.terminate();
                else destination.close(code, reason);
              } else if (destination.readyState !== WebSocket.CLOSED) destination.terminate();
            });
          };
          forward(client, upstream, 'client'); forward(upstream, client, 'server');
        });
      });
    });
  }
  static async start(): Promise<FaultProxy> {
    const proxy = new FaultProxy();
    await new Promise<void>((resolve, reject) => { proxy.server.once('error', reject); proxy.server.listen(0, '127.0.0.1', resolve); });
    return proxy;
  }
  get port(): number {
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Fault proxy is not listening.');
    return address.port;
  }
  get origin(): string { return `http://127.0.0.1:${this.port}`; }
  target(port: number): void { this.targetPort = port; }
  dropNextResponse(method: string): void {
    if (this.dropResponseMethod) throw new Error('A response drop is already armed.');
    this.dropResponseMethod = method;
  }
  holdNextResponse(method: string): Promise<CommandCapture> {
    if (this.holdResponseMethod || this.held) throw new Error('A response barrier is already held.');
    this.holdResponseMethod = method;
    return new Promise((resolve) => { this.heldWaiter = resolve; });
  }
  releaseResponse(): void {
    if (!this.held) throw new Error('No actual server response has reached the barrier.');
    const response = this.held; this.held = null; response.release();
  }
  dropNextEvent(): void { if (this.dropEvent) throw new Error('An event drop is already armed.'); this.dropEvent = true; }
  pauseEvents(): void { this.eventOutage = true; this.disconnectEvents(); }
  resumeEvents(): void { this.eventOutage = false; }
  disconnectEvents(): void { for (const pair of [...this.pairs]) { pair.client.terminate(); pair.upstream.terminate(); } }
  async close(): Promise<void> {
    this.disconnectEvents();
    this.held?.release(); this.held = null;
    for (const socket of this.sockets) socket.destroy();
    this.upgrades.close(); this.agent.destroy();
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }
}
