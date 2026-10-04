import assert from 'node:assert/strict';
import { promises as fs, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer as createPortProbe, type Socket } from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import WebSocket from 'ws';
import { z } from 'zod';
import type { IPty, IDisposable } from 'node-pty';
import { createFateCore } from '../../../src/core/createFateCore';
import { OwnerLock, OwnershipConflict, canonicalFuturePath } from '../../../src/core/ownership/OwnerLock';
import { WorkspaceControl } from '../../../src/core/security/WorkspaceControl';
import { TerminalOwner, type HostTerminalEvent } from '../../../src/core/terminal/TerminalOwner';
import type { RequestContext } from '../../../src/core/dispatch/RequestContext';
import type { WorkspaceHandle } from '../../../src/core/workspaces/WorkspaceHandle';
import type { SnapshotScope } from '../../../src/shared/protocol/snapshots';
import { EVENT_FRAME_BYTES, EVENT_RING_BYTES, EVENT_RING_COUNT, EVENT_UNSENT_BYTES, EVENT_UNSENT_COUNT,
  eventCursorSchema, type EventCursor } from '../../../src/shared/protocol/events';
import { networkEventSchema } from '../../../src/shared/protocol/diagnostics';
import { MultiProjectPiRuntime } from '../../../src/main/pi/MultiProjectPiRuntime';
import { ClientTickets } from '../../../src/server/auth/ClientTickets';
import { ownerCredentialPath } from '../../../src/server/auth/AuthStore';
import { createHttpServer, type HttpService } from '../../../src/server/http/createHttpServer';
import { EventConnection } from '../../../src/server/ws/EventConnection';
import { RedactedLog } from '../../../src/server/logging/RedactedLog';
import { startNodeServerWithFactory, type NodeServer } from '../../../src/server/compose';
import { FakePiSdkAdapter } from './fakePi';
import { privateTestRoot, assertPrivatePath } from './isolatedEnvironment';
import type { NativePtyObservation, NativePtyPort } from './nativePtyPort';

const require = createRequire(import.meta.url);
function dependencyVersion(specifier: string): string {
  const value: unknown = require(specifier);
  return z.object({ version: z.string() }).passthrough().parse(value).version;
}
const SEED = 0x54353152;
const SOCKET_MS = 8_000;
const PTY_MS = 4_000;
const TICK_MS = 50;
const A_PER_TICK = 400;
const MAX_TICKS = 200; // Hard work cap, not a logical-clock substitute for elapsed time.
const PRIVATE_TEXT = 'T51_PRIVATE_TRANSCRIPT_NOT_A_NETWORK_DIAGNOSTIC';
const sleep = (ms: number) => delay(ms);
let aborted = false;
process.on('message', (value: unknown) => {
  if (typeof value === 'object' && value !== null && 'type' in value && value.type === 'abort-real-transport-load') aborted = true;
});
function checkAbort(): void { assert(!aborted, 'Parent requested owned fixture cancellation.'); }
async function until(label: string, check: () => boolean, milliseconds = 2_000): Promise<void> {
  const end = performance.now() + milliseconds;
  while (!check()) {
    checkAbort(); assert(performance.now() < end, `${label}: finite readiness deadline exceeded.`);
    await sleep(10);
  }
}
async function freePort(): Promise<number> {
  const server = createPortProbe();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('Missing probe address.')); return; }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, min: sorted[0] ?? null, p50: sorted[Math.floor(sorted.length * .5)] ?? null,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] ?? null, max: sorted.at(-1) ?? null };
}
function memory() {
  const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage();
  return { rss, heapUsed, external, arrayBuffers };
}
function assertNativeIdentities(observations: readonly NativePtyObservation[], count: number): void {
  assert.equal(observations.length, count);
  assert.equal(new Set(observations.map((entry) => entry.id)).size, count);
  for (const entry of observations) {
    assert(entry.driverPid !== null && Number.isSafeInteger(entry.driverPid) && entry.driverPid > 0);
    assert(entry.ptyPid !== null && Number.isSafeInteger(entry.ptyPid) && entry.ptyPid > 0);
    assert.notEqual(entry.driverPid, process.pid); assert.notEqual(entry.ptyPid, entry.driverPid);
  }
}
function assertVerifiedNativeTeardown(observations: readonly NativePtyObservation[], count: number): void {
  assertNativeIdentities(observations, count);
  for (const entry of observations) {
    assert.equal(entry.driverClosed, true); assert.equal(entry.driverExitCode, 0); assert.equal(entry.driverSignal, null);
    assert.equal(entry.driverForceKillRequested, false); assert.equal(entry.teardownConfirmed, true); assert.equal(entry.failure, null);
    assert(entry.nativeExitCode !== null && Number.isSafeInteger(entry.nativeExitCode), 'A wrapper exit or kill request is not native-exit evidence.');
  }
}
async function descriptors() {
  let osFileDescriptors: number | null = null;
  if (process.platform === 'linux') osFileDescriptors = (await fs.readdir('/proc/self/fd')).length;
  const activeResources: Record<string, number> = {};
  for (const name of process.getActiveResourcesInfo()) activeResources[name] = (activeResources[name] ?? 0) + 1;
  return { osFileDescriptors, osDescriptorMeasurement: process.platform === 'linux' ? '/proc/self/fd (includes scan fd)'
    : 'unavailable: Node has no portable OS descriptor/Windows handle count API', activeResources };
}
const readySchema = z.object({ protocol: z.literal(1), type: z.literal('ready'), clientId: z.string().uuid(),
  serverEpoch: z.string().uuid(), ticket: z.string().max(128) }).strict();
const subscribedSchema = z.object({ protocol: z.literal(1), type: z.literal('subscribed'), cursor: eventCursorSchema }).strict();
const dataSchema = z.object({ type: z.literal('data'), id: z.string().uuid(), sequence: z.number().int().positive(), data: z.string().max(65_536) }).strict();
const exitSchema = z.object({ type: z.literal('exit'), id: z.string().uuid(), exitCode: z.number(), signal: z.number().optional() }).strict();
const terminalCreatedSchema = z.object({ protocol: z.literal(1), type: z.literal('terminal.created'),
  result: z.object({ id: z.string().uuid(), cwd: z.string(), shell: z.string(), warning: z.string() }).strict() }).strict();
const terminalFrameSchema = z.discriminatedUnion('type', [
  z.object({ protocol: z.literal(1), type: z.literal('terminal.create') }).strict(),
  z.object({ protocol: z.literal(1), type: z.literal('terminal.write'), id: z.string().uuid(), data: z.string().max(16_384) }).strict(),
  z.object({ protocol: z.literal(1), type: z.literal('terminal.ack'), id: z.string().uuid(),
    sequence: z.number().int().positive(), characters: z.number().int().positive().max(65_536) }).strict(),
]);

type Credit = { id: string; sequence: number; characters: number };
class Peer {
  readonly ws: WebSocket;
  ready: z.infer<typeof readySchema> | undefined;
  cursor: EventCursor | undefined;
  requestedCursor: EventCursor | undefined;
  closed: { code: number; reason: string } | undefined;
  fault: Error | undefined;
  eventCount = 0;
  eventBytes = 0;
  onEvent: ((sequence: number) => void) | undefined;
  maxFrameBytes = 0;
  lastSequence = 0;
  terminalId: string | undefined;
  terminalCharacters = 0;
  terminalBytes = 0;
  terminalTail = '';
  terminalSequence = 0;
  credits: Credit[] = [];
  maxCredits = 0;
  autoAck = false;
  constructor(url: string, credential: string, readonly workspace: WorkspaceHandle) {
    this.ws = new WebSocket(`${url.replace('http:', 'ws:')}/api/events`, {
      headers: { Authorization: `Bearer ${credential}` }, perMessageDeflate: false, handshakeTimeout: 2_000,
    });
    this.ws.on('error', (error) => { this.fault = error; });
    this.ws.on('close', (code, bytes) => { this.closed = { code, reason: bytes.toString('utf8') }; });
    this.ws.on('message', (bytes, binary) => {
      try {
        assert(!binary, 'Binary server frame.');
        const text = bytes.toString('utf8');
        const size = Buffer.byteLength(text);
        this.maxFrameBytes = Math.max(this.maxFrameBytes, size);
        assert(size <= EVENT_FRAME_BYTES, 'Server frame exceeded the production byte cap.');
        assert(!text.includes(PRIVATE_TEXT), 'Transcript leaked into network diagnostics.');
        const value: unknown = JSON.parse(text);
        assert(typeof value === 'object' && value !== null && 'type' in value, 'Invalid server frame.');
        if (value.type === 'ready') this.ready = readySchema.parse(value);
        else if (value.type === 'subscribed') {
          this.cursor = subscribedSchema.parse(value).cursor;
          assert.equal(this.cursor.workspaceId, this.workspace.id);
          assert(this.requestedCursor);
          this.lastSequence = this.requestedCursor.sequence;
        } else if (value.type === 'event') {
          const envelope = z.object({ type: z.literal('event'), event: networkEventSchema }).strict().parse(value).event;
          assert.equal(envelope.origin.workspaceId, this.workspace.id, 'Cross-workspace event.');
          assert.equal(envelope.origin.workspaceGeneration, this.workspace.generation);
          assert.equal(envelope.serverEpoch, this.ready?.serverEpoch);
          assert.equal(envelope.streamId, this.cursor?.streamId);
          assert.equal(envelope.sequence, this.lastSequence + 1, 'Gap or duplicate on healthy socket.');
          this.lastSequence = envelope.sequence;
          this.eventCount++; this.eventBytes += size; this.onEvent?.(envelope.sequence);
        } else if (value.type === 'terminal.created') this.terminalId = terminalCreatedSchema.parse(value).result.id;
        else {
          const envelope = z.object({ protocol: z.literal(1), type: z.literal('terminal.event'),
            event: z.union([dataSchema, exitSchema]) }).strict().parse(value);
          const event = envelope.event;
          if (event.type === 'data') {
            assert.equal(event.sequence, this.terminalSequence + 1, 'Terminal output sequence gap.');
            this.terminalSequence = event.sequence;
            this.terminalCharacters += event.data.length; this.terminalBytes += Buffer.byteLength(event.data);
            this.terminalTail = (this.terminalTail + event.data).slice(-8192);
            this.credits.push({ id: event.id, sequence: event.sequence, characters: event.data.length });
            this.maxCredits = Math.max(this.maxCredits, this.credits.length);
            assert(this.credits.length <= 8192, 'Fixture ACK metadata capture exceeded its fixed cap.');
            if (this.autoAck) this.acknowledgeAll();
          }
        }
      } catch (error) { this.fault = error instanceof Error ? error : new Error('Frame observer failed.'); }
    });
  }
  check(): void { if (this.fault) throw this.fault; }
  send(value: object): void { this.check(); assert.equal(this.ws.readyState, WebSocket.OPEN); this.ws.send(JSON.stringify(value)); }
  async connect(): Promise<void> {
    await until('WebSocket upgrade', () => { this.check(); return this.ws.readyState === WebSocket.OPEN; });
    this.send({ protocol: 1, type: 'hello' });
    await until('authenticated first frame', () => { this.check(); return this.ready !== undefined; });
  }
  async subscribe(cursor: EventCursor): Promise<void> {
    this.requestedCursor = cursor;
    this.send({ protocol: 1, type: 'subscribe', workspaceId: this.workspace.id, workspaceGeneration: this.workspace.generation, cursor });
    await until('subscription or explicit refusal', () => { this.check(); return this.cursor !== undefined || this.closed !== undefined; });
  }
  acknowledgeAll(): void {
    for (const credit of this.credits.splice(0)) this.send({ protocol: 1, type: 'terminal.ack', ...credit });
  }
}

export async function runRealTransportLoad(mode: 'disabled' | 'load', hostNativeAddonResolutions: () => number,
  hostNativeMetadataResolutions: () => number): Promise<void> {
  const root = privateTestRoot();
  await assertPrivatePath(root);
  const marker = path.join(root, '.fate-retained-owned-work.json');
  const launched = performance.now();
  const metrics: Record<string, unknown> = { seed: SEED, environment: { node: process.version, platform: process.platform,
    arch: process.arch, osRelease: os.release(), cpu: os.cpus()[0]?.model ?? 'unknown', logicalCpus: os.cpus().length,
    totalMemory: os.totalmem(), nodeModuleAbi: process.versions.modules, uv: process.versions.uv,
    ws: dependencyVersion('ws/package.json'), typescript: dependencyVersion('typescript/package.json'),
    transport: 'numeric loopback TCP; ws compression disabled' },
    workload: { socketDurationMs: SOCKET_MS, nativeDurationMs: PTY_MS, tickMs: TICK_MS, maxTicks: MAX_TICKS,
      eventsPerTickA: A_PER_TICK, eventsPerTickB: 1, rawDeltaCharacters: 1024 },
    productionBudgets: { EVENT_FRAME_BYTES, EVENT_RING_BYTES, EVENT_RING_COUNT, EVENT_UNSENT_BYTES, EVENT_UNSENT_COUNT } };
  let base: NodeServer | undefined, http: HttpService | undefined, events: EventConnection | undefined, tickets: ClientTickets | undefined;
  let terminal: TerminalOwner | undefined, disabledTerminal: TerminalOwner | undefined;
  const handles: WorkspaceHandle[] = [];
  const peers: Peer[] = [];
  const identities = new Map<string, RequestContext>();
  const serverSockets = new Set<Socket>();
  const native: Array<{ process: IPty; exited: boolean; killRequested: boolean; subscriptions: IDisposable[] }> = [];
  let nativePort: NativePtyPort | undefined;
  let nativePortCreationAttempted = false;
  let nativePortJoinConfirmed = false;
  let nativeStartObservations: readonly NativePtyObservation[] | undefined;
  let nativeStartsTask: Promise<void> | undefined;
  let nativePortLoads = 0, hostPauseRequests = 0, hostResumeRequests = 0, hostKillRequests = 0;
  let sampleTimer: ReturnType<typeof setInterval> | undefined;
  let recoveryTask: Promise<void> | undefined;
  let stopping = false;
  let observerFailure: Error | undefined;
  const adapter = new FakePiSdkAdapter();
  let profileResource: string | undefined;
  let ok = false, cleanupConfirmed = false, failure: string | null = null;
  const initialMemory = memory();
  let peakMemory = { ...initialMemory };
  const peak = { retainedBytes: 0, retainedCount: 0, pendingBytes: 0, pendingCount: 0,
    socketBufferedBytes: 0, socketPendingFrames: 0, socketPendingJsonBytes: 0, tcpWritableBytes: 0, sockets: 0, subscriptions: 0,
    terminalBufferedCharacters: 0, terminalOutstandingCharacters: 0, terminalPendingChunks: 0 };
  const ownerState = (state: 'running' | 'settled' | 'uncertain') => writeFileSync(marker, JSON.stringify({
    fixture: 'T51-real-transport', mode, workerPid: process.pid, state,
    nativePids: native.map((item) => ({ pid: item.process.pid > 0 ? item.process.pid : null, exited: item.exited })),
    nativePortObservations: nativePort?.observations() ?? [],
    nativePortTeardownConfirmed: nativePortJoinConfirmed,
    nativeDriversLive: nativePort?.observations().filter((item) => !item.driverClosed).length ?? 0,
    nativeLive: native.filter((item) => !item.exited).length,
  }), { mode: 0o600 });
  const sample = () => {
    const current = memory();
    for (const key of ['rss', 'heapUsed', 'external', 'arrayBuffers'] as const) peakMemory[key] = Math.max(peakMemory[key], current[key]);
    if (base) {
      const usage = base.core.events.inspectBuffers();
      assert(usage.streamCount <= 2); assert(usage.subscriptionCount <= 8);
      peak.subscriptions = Math.max(peak.subscriptions, usage.subscriptionCount);
      for (const key of ['retainedBytes', 'retainedCount', 'pendingBytes', 'pendingCount'] as const) peak[key] = Math.max(peak[key], usage[key]);
      assert(usage.retainedBytes <= 2 * EVENT_RING_BYTES); assert(usage.retainedCount <= 2 * EVENT_RING_COUNT);
      assert(usage.pendingBytes <= 8 * EVENT_UNSENT_BYTES); assert(usage.pendingCount <= 8 * EVENT_UNSENT_COUNT);
      for (const subscriber of base.core.events['listeners']) {
        assert(subscriber.usage().bytes <= EVENT_UNSENT_BYTES); assert(subscriber.usage().count <= EVENT_UNSENT_COUNT);
      }
      for (const handle of handles) {
        const retained = base.core.events.retained(scope(handle));
        assert(retained.bytes <= EVENT_RING_BYTES); assert(retained.count <= EVENT_RING_COUNT);
      }
    }
    // Deliberate white-box observations, never alternate production queues.
    // ws exposes bufferedAmount publicly; wss ownership is private to EventConnection.
    for (const ws of events?.['wss'].clients ?? []) {
      peak.socketBufferedBytes = Math.max(peak.socketBufferedBytes, ws.bufferedAmount);
      // Includes ws framing bytes, unlike EventConnection's JSON-byte preflight.
      assert(ws.bufferedAmount <= EVENT_UNSENT_BYTES, 'Socket wire buffering exceeded the unchanged 8-MiB cap.');
    }
    peak.sockets = Math.max(peak.sockets, serverSockets.size);
    assert(serverSockets.size <= 8);
    for (const socket of serverSockets) peak.tcpWritableBytes = Math.max(peak.tcpWritableBytes, socket.writableLength);
    for (const item of terminal?.['terminals'].values() ?? []) {
      peak.terminalBufferedCharacters = Math.max(peak.terminalBufferedCharacters, item.buffered.length);
      peak.terminalOutstandingCharacters = Math.max(peak.terminalOutstandingCharacters, item.outstanding);
      peak.terminalPendingChunks = Math.max(peak.terminalPendingChunks, item.pending.size);
      assert(item.buffered.length <= 1_048_576, 'Terminal retained character cap.');
      // flush checks credit before sending one <=65,536-character chunk.
      assert(item.outstanding <= 512 * 1024 + 65_535, 'Terminal credit high water plus documented one-chunk overshoot.');
      assert.equal([...item.pending.values()].reduce((sum, value) => sum + value, 0), item.outstanding);
    }
  };
  const safeSample = () => { try { sample(); } catch (error) { observerFailure ??= error instanceof Error ? error : new Error('Sample failed.'); } };
  const sendObservers = new Map<WebSocket, { frames: number; bytes: number; peakFrames: number; peakBufferedBytes: number }>();
  const observeRealSends = () => {
    for (const ws of events!['wss'].clients) {
      if (sendObservers.has(ws)) continue;
      const pending = { frames: 0, bytes: 0, peakFrames: 0, peakBufferedBytes: 0 }; sendObservers.set(ws, pending);
      const send = ws.send.bind(ws);
      type Done = (error?: Error) => void;
      // Transparent measurement: the original send, callback, data and options
      // are preserved. Never invent bufferedAmount or defer the real callback.
      ws.send = (data: Parameters<WebSocket['send']>[0], options?: Parameters<WebSocket['send']>[1] | Done, callback?: Done) => {
        assert(typeof data === 'string', 'Fixture observes production JSON sends only.');
        const bytes = Buffer.byteLength(data), done = typeof options === 'function' ? options : callback;
        pending.frames++; pending.bytes += bytes;
        pending.peakFrames = Math.max(pending.peakFrames, pending.frames);
        peak.socketPendingFrames = Math.max(peak.socketPendingFrames, pending.frames);
        peak.socketPendingJsonBytes = Math.max(peak.socketPendingJsonBytes, pending.bytes);
        if (pending.frames > EVENT_UNSENT_COUNT || pending.bytes > EVENT_UNSENT_BYTES) observerFailure ??= new Error('Actual outstanding WebSocket sends exceeded unchanged count/byte bounds.');
        const observeBuffer = () => {
          pending.peakBufferedBytes = Math.max(pending.peakBufferedBytes, ws.bufferedAmount);
          peak.socketBufferedBytes = Math.max(peak.socketBufferedBytes, ws.bufferedAmount);
          if (ws.bufferedAmount > EVENT_UNSENT_BYTES) observerFailure ??= new Error('Actual WebSocket buffer exceeded the unchanged 8-MiB cap.');
        };
        const settled: Done = (error) => { pending.frames--; pending.bytes -= bytes; done?.(error); observeBuffer(); };
        if (options && typeof options !== 'function') send(data, options, settled);
        else send(data, settled);
        observeBuffer();
      };
    }
  };
  const check = () => { checkAbort(); if (observerFailure) throw observerFailure; for (const peer of peers) peer.check(); };
  const scope = (handle: WorkspaceHandle): SnapshotScope => ({ principalId: 'fixture', clientId: 'fixture',
    workspaceId: handle.id, workspaceGeneration: handle.generation, serverEpoch: base!.core.events.serverEpoch,
    sessionId: handle.runtime.getState(false).sessionId ?? 'no-session', projectPath: handle.root });
  let random = SEED;
  const generated: [number, number] = [0, 0];
  const sentB = new Map<number, number>();
  const healthyLatencies: number[] = [];
  const publish = (index: 0 | 1, count: number) => {
    const handle = handles[index]!;
    const origin = { workspaceId: handle.id, workspaceGeneration: handle.generation,
      sessionId: handle.runtime.getState(false).sessionId };
    for (let i = 0; i < count; i++) {
      random = (Math.imul(1664525, random) + 1013904223) >>> 0;
      const prefix = `${PRIVATE_TEXT}:${index}:${random}:`;
      if (index === 1) {
        assert(sentB.size < 32, 'Healthy receiver failed to make bounded progress.');
        sentB.set(base!.core.events.position(scope(handle)).sequence + 1, performance.now());
      }
      base!.core.runtime.scopedEvents.publish({ kind: 'pi', origin, event: { type: 'assistant.text',
        messageId: `fixture-${index}`, delta: prefix.padEnd(1024, 'x'), timestamp: Date.now(), cursor: ++generated[index] } });
    }
    sample();
  };
  const httpLatencies: number[] = [];
  const readInfo = async (url: string, credential: string) => {
    const start = performance.now();
    const value = await new Promise<unknown>((resolve, reject) => {
      const req = request(`${url}/api/info`, { method: 'GET', agent: false,
        headers: { Authorization: `Bearer ${credential}`, Connection: 'close' } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk; if (Buffer.byteLength(body) > 8192) req.destroy(new Error('Info result exceeded fixture bound.'));
        });
        res.once('error', reject);
        res.once('end', () => {
          try { assert.equal(res.statusCode, 200); resolve(JSON.parse(body) as unknown); } catch (error) { reject(error); }
        });
      });
      req.setTimeout(1_000, () => req.destroy(new Error('Healthy HTTP request exceeded one-second deadline.')));
      req.once('error', reject); req.end();
    });
    z.object({ protocol: z.literal(1), serverEpoch: z.string().uuid(), serverTime: z.number(), kind: z.literal('client'),
      capabilities: z.array(z.string()), workspaceCount: z.literal(1) }).strict().parse(value);
    const elapsed = performance.now() - start;
    assert(elapsed < 1_000, 'Healthy HTTP progress latency exceeded one second.');
    httpLatencies.push(elapsed);
  };
  try {
    metrics.descriptorsBefore = await descriptors();
    const workspaces = [path.join(root, 'workspace-a'), path.join(root, 'workspace-b')];
    for (const [index, directory] of workspaces.entries()) {
      await fs.mkdir(directory, { mode: 0o700 });
      await fs.writeFile(path.join(directory, 'sentinel.txt'), `T51 synthetic workspace ${index}\n`, { mode: 0o600 });
    }
    const port = await freePort(); // Config disallows port 0; bind races fail, never scan/retry indefinitely.
    base = await startNodeServerWithFactory({ profile: { profileId: 't51', home: process.env.HOME }, workspaces,
      host: '127.0.0.1', port, flags: { terminal: false, browser: false } },
    (options) => createFateCore({ ...options, adapter,
      createRuntime: (deps) => new MultiProjectPiRuntime({ ...deps, createSessionTitleGenerator: () => ({ generate: async () => null }) }) }),
    (identity, workspaceId) => {
      const handle = handles.find((item) => item.id === workspaceId);
      return Boolean(handle && tickets?.isMember(identity, handle.root));
    });
    tickets = new ClientTickets(base.auth);
    const registry = base.core.workspaces;
    assert(registry, 'No host workspace registry.');
    for (const workspace of workspaces) handles.push(await registry.registerHostPath(workspace));
    profileResource = await canonicalFuturePath(path.dirname(base.core.paths.dataRoot));
    await assert.rejects(OwnerLock.acquire(base.core.paths.lockRoot, 'profile', profileResource), OwnershipConflict);
    metrics.singleProfileOwnerRefused = true;
    const control = new WorkspaceControl({ isMember: (identity, id) => {
      const handle = handles.find((item) => item.id === id);
      return Boolean(handle && tickets?.isMember(identity, handle.root));
    } });
    const terminalSends = new Map<string, (value: unknown) => void>();
    const candidateShell = process.platform === 'win32'
      ? path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'cmd.exe') : '/bin/sh';
    const options = { registry, control, permission: () => 'edit' as const, resolveShell: () => nativePort?.shell ?? candidateShell,
      loadPty: async (): Promise<typeof import('node-pty')> => {
        nativePortLoads++;
        assert.equal(mode, 'load'); assert(nativePort, 'Owned native port must be explicitly prepared.');
        // This is a bounded IPC proxy, not an addon import in the guarded host.
        // Only the separately owned pure driver loads/spawns actual node-pty.
        const module = await nativePort.loadPty().catch((error: unknown) => {
          metrics.nativePortLoadFailure = error instanceof Error ? error.message.slice(0, 1000) : 'Unknown native port load failure';
          throw error;
        });
        return { ...module, spawn: (file, args, settings) => {
          assert(nativePort); assert.equal(file, nativePort.shell); assert(settings?.cwd === handles[0]!.root);
          const safeArgs = Array.isArray(args) && (args.length === 0 || process.platform === 'win32'
            && path.basename(file).toLowerCase() === 'cmd.exe' && args.length === 1 && args[0] === '/d');
          assert(safeArgs, 'Preserve only the installed-shell [] or canonical cmd /d contract.');
          let child: IPty;
          // Forward production arguments unchanged. The reviewed port discards
          // the host env and supplies its private driver/shell environment.
          try { child = module.spawn(file, args, settings); }
          catch (error) { metrics.nativePortSpawnFailure = error instanceof Error ? error.message.slice(0, 1000) : 'Unknown native port spawn failure'; throw error; }
          const entry = { process: child, exited: false, killRequested: false, subscriptions: [] as IDisposable[] };
          native.push(entry);
          const pause = child.pause.bind(child), resume = child.resume.bind(child), kill = child.kill.bind(child);
          // These count proxy requests. The driver's independent IPC flow control
          // can make additional native transitions, which this host cannot count.
          child.pause = () => { hostPauseRequests++; pause(); };
          child.resume = () => { hostResumeRequests++; resume(); };
          child.kill = (signal) => { hostKillRequests++; entry.killRequested = true; kill(signal); };
          entry.subscriptions.push(child.onExit(() => { entry.exited = true; ownerState('running'); }));
          ownerState('running');
          return child;
        } };
      },
      send: (identity: RequestContext, event: HostTerminalEvent) => {
        const send = terminalSends.get(identity.clientId); assert(send, 'Missing owned terminal recipient.');
        send({ protocol: 1, type: 'terminal.event', event }); safeSample();
      },
    };
    disabledTerminal = new TerminalOwner({ ...options, enabled: false });
    if (mode === 'load') terminal = new TerminalOwner({ ...options, enabled: true });
    events = new EventConnection({ auth: base.auth, tickets, events: base.core.events, serverEpoch: base.core.events.serverEpoch,
      resolveScope: (principal, workspaceId, generation, connectionId) => {
        const handle = handles.find((item) => item.id === workspaceId && item.generation === generation);
        if (!handle || !principal.workspaceRoots.includes(handle.root)) return null;
        return { ...scope(handle), principalId: principal.principalId, clientId: connectionId };
      },
      onDisconnect: (connectionId) => {
        const identity = identities.get(connectionId);
        if (identity) { terminal?.disconnect(identity); control.disconnect(identity); identities.delete(connectionId); }
        terminalSends.delete(connectionId);
      },
      ...(mode === 'disabled' ? {} : { onTerminalFrame: async (identity: RequestContext, input: unknown, send: (value: unknown) => void) => {
        const frame = terminalFrameSchema.parse(input);
        identities.set(identity.clientId, identity); terminalSends.set(identity.clientId, send);
        assert(terminal);
        if (frame.type === 'terminal.create') {
          const lease = control.claim(identity, handles[0]!.id);
          const created = await terminal.create(identity, handles[0]!.id, handles[0]!.generation, lease.generation, 120, 30);
          send({ protocol: 1, type: 'terminal.created', result: created });
        } else if (frame.type === 'terminal.write') terminal.write(identity, frame.id, frame.data);
        else terminal.acknowledge(identity, frame.id, frame.sequence, frame.characters);
        safeSample();
      } }),
    });
    const diagnostics: string[] = [];
    http = await createHttpServer({ auth: base.auth, host: '127.0.0.1', port, profileId: base.core.paths.profileId,
      serverEpoch: base.core.events.serverEpoch, ready: () => true, logger: new RedactedLog((entry) => {
        assert(!entry.includes(PRIVATE_TEXT)); assert(diagnostics.length < 128); diagnostics.push(entry);
      }), onUpgrade: (req, socket, head, config, cookieName) => events!.handleUpgrade(req, socket, head, config, cookieName) });
    http.server.on('connection', (socket) => { serverSockets.add(socket); socket.once('close', () => serverSockets.delete(socket)); });
    const url = `http://127.0.0.1:${port}`;
    const ownerCredential = await fs.readFile(ownerCredentialPath(base.core.paths), 'utf8');
    const keyA = await base.auth.issueClientCredential(ownerCredential, [handles[0]!.root]);
    const keyB = await base.auth.issueClientCredential(ownerCredential, [handles[1]!.root]);
    const connect = async (workspace: 0 | 1) => {
      assert(!stopping, 'Owned fixture teardown has begun.');
      const peer = new Peer(url, workspace === 0 ? keyA.credential : keyB.credential, handles[workspace]!);
      peers.push(peer); await peer.connect(); observeRealSends(); return peer;
    };
    const disabled = await connect(0);
    const principalA = base.auth.authenticateClient(keyA.credential); assert(principalA);
    const disabledIdentity = tickets.verify(disabled.ready!.ticket, principalA, base.core.events.serverEpoch, null);
    await assert.rejects(disabledTerminal.create(disabledIdentity, handles[0]!.id, handles[0]!.generation, 0, 80, 24), /disabled/u);
    assert.equal(nativePortLoads, 0); assert.equal(hostNativeAddonResolutions(), 0); assert.equal(hostNativeMetadataResolutions(), 0);
    metrics.setupElapsedMs = performance.now() - launched;
    if (mode === 'disabled') {
      disabled.send({ protocol: 1, type: 'terminal.create' });
      await until('disabled terminal frame refusal', () => disabled.closed !== undefined);
      assert.deepEqual(disabled.closed, { code: 1008, reason: 'Terminal disabled' });
      assert.equal(hostNativeAddonResolutions(), 0); assert.equal(hostNativeMetadataResolutions(), 0);
      assert.equal(nativePort, undefined);
      metrics.disabled = { nativePortLoads, hostNativeAddonResolutions: hostNativeAddonResolutions(),
        hostNativeMetadataResolutions: hostNativeMetadataResolutions(), closeCode: disabled.closed.code };
    } else {
      disabled.ws.close(); await until('preflight peer closed', () => disabled.closed !== undefined && events!['wss'].clients.size === 0);
      const wrongScope = await connect(0);
      wrongScope.send({ protocol: 1, type: 'subscribe', workspaceId: handles[1]!.id, workspaceGeneration: handles[1]!.generation });
      await until('foreign workspace refusal', () => wrongScope.closed !== undefined);
      assert.deepEqual(wrongScope.closed, { code: 1008, reason: 'Workspace unavailable' });
      await until('foreign peer removed', () => events!['wss'].clients.size === 0);
      metrics.crossWorkspaceRefused = true;
      const slow = await connect(0), healthy = await connect(1);
      const oldCursor = base.core.events.position(scope(handles[0]!));
      await slow.subscribe(oldCursor);
      await healthy.subscribe(base.core.events.position(scope(handles[1]!)));
      healthy.onEvent = (sequence) => {
        const started = sentB.get(sequence); assert(started !== undefined, 'Unexpected B sequence.');
        const elapsed = performance.now() - started;
        assert(elapsed <= 1_000, 'Unrelated workspace B event exceeded its one-second delivery budget.');
        healthyLatencies.push(elapsed); sentB.delete(sequence);
      };
      const slowServer = [...events['wss'].clients][0]; assert(slowServer);
      const slowSends = sendObservers.get(slowServer); assert(slowSends);
      slow.ws.pause(); // Actual TCP receive pause, not a fabricated bufferedAmount.
      sampleTimer = setInterval(safeSample, 25);
      const socketStart = performance.now();
      const tickTimes: number[] = [];
      let closeRequestedAt: number | undefined, resumedAt: number | undefined;
      let replayAttempts = 0, fresh: Peer | undefined;
      let recoveryStarted = false, recoveryFinished = false, recoveryElapsedMs = 0;
      let recoveryFailure: Error | undefined;
      const firstEventA = generated[0], firstEventB = generated[1];
      metrics.beforeLoadMemory = memory();
      for (let tick = 0; performance.now() - socketStart < SOCKET_MS; tick++) {
        check(); assert(tick < MAX_TICKS, 'Socket work cap exceeded.');
        const at = performance.now(); tickTimes.push(at - socketStart);
        publish(0, A_PER_TICK); publish(1, 1);
        if (tick % 10 === 0) await readInfo(url, keyB.credential);
        // Observe actual server refusal BEFORE resuming the stalled receiver.
        if (slowServer.readyState === WebSocket.CLOSING && resumedAt === undefined) {
          closeRequestedAt = performance.now() - socketStart;
          assert(slowSends.peakBufferedBytes > 0, 'No real slow-socket buffering was measured.');
          assert.equal(slowSends.peakFrames, EVENT_UNSENT_COUNT, 'Refusal must follow actual socket send-count pressure, not only a hub overflow.');
          resumedAt = performance.now(); slow.ws.resume();
        }
        if (slow.closed && !recoveryStarted && base.core.events.retained(scope(handles[0]!)).oldest > oldCursor.sequence + 1) {
          assert.deepEqual(slow.closed, { code: 1013, reason: 'RESYNC_REQUIRED' });
          recoveryStarted = true;
          const recoveryStart = performance.now();
          // Do not await here: the fixed-rate producer continues publishing A/B
          // while real reconnect/subscribe frames traverse loopback.
          recoveryTask = (async () => {
            const refused = await connect(0); replayAttempts++;
            await refused.subscribe(oldCursor);
            assert.deepEqual(refused.closed, { code: 1013, reason: 'RESYNC_REQUIRED' });
            fresh = await connect(0); replayAttempts++;
            // Explicit current-position recovery, not a claimed full UI snapshot.
            await fresh.subscribe(base!.core.events.position(scope(handles[0]!)));
            assert(fresh.cursor); assert(!fresh.closed);
            recoveryElapsedMs = performance.now() - recoveryStart;
            assert(recoveryElapsedMs <= 2_000, 'Two-attempt reconnect exceeded its real-time budget.');
          })().catch((error: unknown) => { recoveryFailure = error instanceof Error ? error : new Error('Recovery failed.'); })
            .finally(() => { recoveryFinished = true; });
        }
        if (recoveryFailure) throw recoveryFailure;
        await sleep(Math.max(0, TICK_MS - (performance.now() - at)));
        check();
        assert.equal(healthy.ws.readyState, WebSocket.OPEN, 'Workspace B stalled or was disconnected.');
      }
      const elapsedMs = performance.now() - socketStart;
      assert(elapsedMs >= SOCKET_MS && elapsedMs <= SOCKET_MS + 2_000, 'Real socket interval exceeded its fixed scheduling budget.');
      assert(tickTimes.length >= 100, 'Too little real producer activity; elapsed idle time is not sustained load.');
      for (let second = 0; second < 8; second++) assert(tickTimes.filter((value) => value >= second * 1000 && value < (second + 1) * 1000).length >= 8,
        'A sustained-load second lacked eight real producer ticks.');
      assert(closeRequestedAt !== undefined && resumedAt !== undefined, 'Slow socket was not refused under actual TCP pressure.');
      assert(slow.closed && performance.now() - resumedAt < SOCKET_MS + 2_000);
      await until('bounded reconnect completion', () => recoveryFinished, 2_000);
      if (recoveryFailure) throw recoveryFailure;
      assert.equal(replayAttempts, 2, 'Recovery must finish in exactly one refusal plus one explicit current-cursor attempt.');
      assert(fresh && fresh.eventCount > 0 && !fresh.closed, 'No post-recovery delivery under continuing load.');
      await until('all healthy B events delivered', () => { check(); return healthy.eventCount === generated[1]! - firstEventB; });
      assert.equal(base.core.runtime.scopedEvents.deliveryFailures, 0);
      metrics.sockets = { elapsedMs, ticks: tickTimes.length, producedA: generated[0]! - firstEventA, producedB: generated[1]! - firstEventB,
        deliveredB: healthy.eventCount, deliveredAfterRecoveryA: fresh.eventCount, closeRequestedAtMs: closeRequestedAt,
        closeCode: slow.closed.code, slowSocketPeakPendingFrames: slowSends.peakFrames, slowSocketPeakBufferedBytes: slowSends.peakBufferedBytes,
        replayAttempts, recoveryElapsedMs, httpLatencyMs: distribution(httpLatencies),
        tickSpacingMs: distribution(tickTimes.slice(1).map((time, index) => time - tickTimes[index]!)),
        healthyEventLatencyMs: distribution(healthyLatencies), maxFrameBytes: Math.max(...peers.map((peer) => peer.maxFrameBytes)),
        receivedDiagnosticBytes: peers.reduce((sum, peer) => sum + peer.eventBytes, 0) };
      metrics.descriptorsUnderLoad = await descriptors();
      // Native workload: one actual shell in the reviewed pure native-I/O
      // driver, reached through bounded IPC. The application's guard is intact.
      nativePortCreationAttempted = true;
      const { createNativePtyPort } = await import('./nativePtyPort');
      nativePort = await createNativePtyPort({ sourceRoot: process.cwd(), cwdRoots: handles.map((handle) => handle.root) });
      assert.equal(hostNativeAddonResolutions(), 0); assert.equal(hostNativeMetadataResolutions(), 0);
      const nativePeer = await connect(0);
      nativePeer.autoAck = true;
      const nativeCreateStarted = performance.now();
      nativePeer.send({ protocol: 1, type: 'terminal.create' });
      await until('owned terminal proxy created', () => {
        check(); assert(!nativePeer.closed, 'Native terminal creation refused; inspect native port observations/failure in the receipt.');
        return nativePeer.terminalId !== undefined;
      }, 4_000);
      assert.equal(nativePortLoads, 1); assert.equal(native.length, 1);
      let startsSettled = false, startsFailure: Error | undefined;
      nativeStartsTask = nativePort.waitForStarts().catch((error: unknown) => {
        startsFailure = error instanceof Error ? error : new Error('Owned native start failed.');
      }).finally(() => { startsSettled = true; });
      // Retain the original total 4s creation deadline, including actual native
      // readiness; do not pass on a synchronously allocated proxy with pid 0.
      await until('verified actual driver/native starts', () => {
        check(); if (startsFailure) throw startsFailure;
        return startsSettled;
      }, Math.max(0, 4_000 - (performance.now() - nativeCreateStarted)));
      await nativeStartsTask; if (startsFailure) throw startsFailure;
      assert(performance.now() - nativeCreateStarted <= 4_000, 'Actual native start exceeded the original creation budget.');
      nativeStartObservations = nativePort.observations();
      assertNativeIdentities(nativeStartObservations, 1);
      assert(nativeStartObservations.every((entry) => !entry.driverClosed && entry.nativeExitCode === null && entry.failure === null));
      metrics.nativePortStarts = nativeStartObservations;
      assert.equal(hostNativeAddonResolutions(), 0); assert.equal(hostNativeMetadataResolutions(), 0);
      const nativeEntry = native[0]!;
      assert.equal(nativeEntry.process.pid, nativeStartObservations[0]!.ptyPid);
      ownerState('running');
      nativeEntry.subscriptions.push(nativeEntry.process.onData(safeSample));
      const writeShell = (command: string) => nativePeer.send({ protocol: 1, type: 'terminal.write', id: nativePeer.terminalId!,
        data: command + (process.platform === 'win32' ? '\r' : '\n') });
      const emitMarker = (suffix: 'READY' | 'BURST_DONE' | 'FINAL') => writeShell(process.platform === 'win32'
        ? `echo T51_NATIVE^_${suffix}` : `printf '%s%s\\n' 'T51_NATIVE' '_${suffix}'`);
      const sawMarker = (suffix: 'READY' | 'BURST_DONE' | 'FINAL') => stripVTControlCharacters(nativePeer.terminalTail).includes(`T51_NATIVE_${suffix}`);
      // The contiguous marker does not occur in typed input, so terminal echo
      // cannot impersonate shell readiness (including ConPTY cursor sequences).
      emitMarker('READY');
      await until('shell ready output marker', () => { check(); return sawMarker('READY'); }, 3_000);
      nativePeer.autoAck = false;
      const burst = (count: number, line: string) => process.platform === 'win32'
        ? `for /L %i in (1,1,${count}) do @echo ${line}`
        : `i=0; while [ "$i" -lt ${count} ]; do printf '%s\\n' '${line}'; i=$((i+1)); done`;
      const burstStart = performance.now();
      writeShell(burst(1600, 'x'.repeat(1024)));
      await until('host pause request from withheld ACKs', () => { check(); return hostPauseRequests > 0; }, 3_000);
      const withheldAt = performance.now();
      await sleep(200); check(); sample();
      const bWhilePaused = healthy.eventCount;
      publish(1, 1); await readInfo(url, keyB.credential);
      await until('B progress while native output has withheld host credit', () => { check(); return healthy.eventCount === bWhilePaused + 1; }, 1_000);
      assert.equal(hostResumeRequests, 0);
      const firstCredit = nativePeer.credits[0]; assert(firstCredit);
      const identity = identities.get(nativePeer.ready!.clientId); assert(identity); assert(terminal);
      const state = terminal['terminals'].get(nativePeer.terminalId!); assert(state); assert(state.paused);
      const outstanding = state.outstanding;
      terminal.acknowledge(identity, nativePeer.terminalId!, firstCredit.sequence + 100_000, firstCredit.characters);
      terminal.acknowledge(identity, nativePeer.terminalId!, firstCredit.sequence, firstCredit.characters + 1);
      assert.equal(state.outstanding, outstanding, 'Invalid ACK granted output credit.');
      const foreign = tickets.verify(healthy.ready!.ticket, base.auth.authenticateClient(keyB.credential)!, base.core.events.serverEpoch, null);
      assert.throws(() => terminal!.write(foreign, nativePeer.terminalId!, 'never-written'), /unavailable/u);
      const withheldDurationMs = performance.now() - withheldAt;
      assert(withheldDurationMs >= 200);
      nativePeer.autoAck = true; nativePeer.acknowledgeAll();
      emitMarker('BURST_DONE');
      await until('real native output resumed after host credit and burst drained', () => { check(); return hostResumeRequests > 0 && sawMarker('BURST_DONE'); }, 4_000);
      const nativeStart = performance.now();
      const nativeTicks: number[] = [];
      const bBeforeNative = healthy.eventCount;
      for (let tick = 0; performance.now() - nativeStart < PTY_MS; tick++) {
        check(); assert(tick < 60, 'Native command cap exceeded.');
        const at = performance.now(); nativeTicks.push(at - nativeStart);
        writeShell(burst(32, 'y'.repeat(256))); publish(1, 1);
        if (tick % 10 === 0) await readInfo(url, keyB.credential);
        await sleep(Math.max(0, 100 - (performance.now() - at)));
      }
      const nativeElapsedMs = performance.now() - nativeStart;
      assert(nativeElapsedMs >= PTY_MS && nativeElapsedMs <= PTY_MS + 1_000);
      for (let second = 0; second < 4; second++) assert(nativeTicks.filter((value) => value >= second * 1000 && value < (second + 1) * 1000).length >= 5,
        'Native sustained interval lacked five actual writes per second.');
      emitMarker('FINAL');
      await until('native final output and zero ACK debt', () => {
        check(); return sawMarker('FINAL') && state.outstanding === 0 && state.buffered.length === 0;
      }, 2_000);
      await until('B delivery during native output', () => healthy.eventCount === bBeforeNative + nativeTicks.length);
      const oldId = nativePeer.terminalId!;
      nativePeer.ws.close();
      await until('native disconnect observed', () => nativePeer.closed !== undefined && nativeEntry.exited, 3_000);
      assert.equal(terminal['terminals'].size, 0); assert.equal(hostKillRequests, 1); assert.equal(tickets.isLive(identity), false);
      const exitObservations = nativePort.observations();
      assertNativeIdentities(exitObservations, 1);
      assert(exitObservations.every((entry) => entry.nativeExitCode !== null && entry.killRequested && entry.failure === null));
      assert.throws(() => terminal!.write(identity, oldId, 'never-replayed'), /unavailable/u);
      const nodePtyVersion = dependencyVersion('node-pty/package.json'); // Metadata only; never the native addon in this process.
      assert.equal(hostNativeAddonResolutions(), 0); assert.equal(hostNativeMetadataResolutions(), 1);
      metrics.nativePty = { shell: path.basename(nativePort.shell), nodePty: nodePtyVersion,
        nativePortLoads, hostNativeAddonResolutions: hostNativeAddonResolutions(), hostNativeMetadataResolutions: hostNativeMetadataResolutions(),
        actualNativeStarts: nativeStartObservations.length, transport: 'real native PTY -> bounded owned-driver IPC -> TerminalOwner -> WebSocket',
        elapsedMs: nativeElapsedMs, ticks: nativeTicks.length, initialBurstLines: 1600, initialBurstLineCharacters: 1024,
        steadyLinesPerTick: 32, steadyLineCharacters: 256, totalOutputCharacters: nativePeer.terminalCharacters,
        totalOutputUtf8Bytes: nativePeer.terminalBytes, hostPauseRequests, hostResumeRequests, hostKillRequestsBeforePortDispose: hostKillRequests,
        nativeTransitionCounts: 'not measured; driver IPC flow control also pauses/resumes native I/O', maxClientAckMetadata: nativePeer.maxCredits,
        withheldAckMs: withheldDurationMs, bDeliveredWhileHostCreditPaused: 1,
        initialBurstAndRecoveryMs: nativeStart - burstStart, bDeliveredDuringNative: healthy.eventCount - bBeforeNative,
        exitObserved: nativeEntry.exited, ownerEntriesAfterDisconnect: terminal['terminals'].size };
      metrics.afterDrainMemory = memory();
      metrics.combinedHealthyEventLatencyMs = distribution(healthyLatencies);
      metrics.combinedHttpLatencyMs = distribution(httpLatencies);
      assert.equal(sentB.size, 0);
    }
    assert.equal(adapter.invocations.filter((invocation) => ['prompt', 'tool', 'providerBlocked'].includes(invocation.kind)).length, 0);
    for (const [index, handle] of handles.entries()) assert.equal(await fs.readFile(path.join(handle.root, 'sentinel.txt'), 'utf8'), `T51 synthetic workspace ${index}\n`);
    metrics.diagnosticRecords = diagnostics.length;
    metrics.nativeLoadedWhileDisabled = 0;
    check(); ok = true;
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 2000) : 'Unknown fixture failure.';
  } finally {
    const teardownStarted = performance.now();
    stopping = true;
    if (sampleTimer) clearInterval(sampleTimer);
    const cleanupErrors: string[] = [];
    const cleanup = async (label: string, action: () => void | Promise<void>): Promise<boolean> => {
      try { await action(); return true; } catch { cleanupErrors.push(label); return false; }
    };
    // Start both closes: a missing native exit intentionally keeps the owner
    // promise pending, but must not prevent the driver's independent bounded
    // cleanup attempt. A timed-out owner remains unconfirmed; never release core.
    const terminalSettlement = terminal?.dispose() ?? Promise.resolve();
    const portSettlement = nativePort?.dispose();
    void portSettlement?.catch(() => undefined);
    await cleanup('terminal disposal', async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([terminalSettlement, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Native terminal owner settlement unconfirmed.')), 3_000);
      })]); } finally { if (timer) clearTimeout(timer); }
    });
    await cleanup('disabled terminal disposal', async () => { await disabledTerminal?.dispose(); });
    for (const entry of native) if (!entry.exited && !entry.killRequested) {
      await cleanup('partially-created native proxy', () => entry.process.kill());
    }
    if (nativePort) {
      const port = nativePort;
      await cleanup('owned native exit/ledger/driver join', async () => {
        const final = await portSettlement;
        assert(final, 'Native port settlement was not started.');
        assertVerifiedNativeTeardown(final, native.length);
        if (nativeStartObservations) assert.deepEqual(final.map((entry) => [entry.id, entry.driverPid, entry.ptyPid]),
          nativeStartObservations.map((entry) => [entry.id, entry.driverPid, entry.ptyPid]));
        nativePortJoinConfirmed = true;
      });
      metrics.nativePortFinalObservations = port.observations();
    } else if (nativePortCreationAttempted) cleanupErrors.push('native port creation did not return an owned cleanup handle');
    else {
      assert.equal(native.length, 0);
      nativePortJoinConfirmed = true; // No port was ever admitted.
      metrics.nativePortFinalObservations = [];
    }
    await cleanup('native start observation settled', async () => { await nativeStartsTask; });
    metrics.nativePortTeardownConfirmed = nativePortJoinConfirmed;
    metrics.nativeProxyRequestsAfterJoin = { hostPauseRequests, hostResumeRequests, hostKillRequests };
    metrics.hostNativeResolutions = { addon: hostNativeAddonResolutions(), metadata: hostNativeMetadataResolutions() };
    // A paused ws close handshake cannot settle until reads resume; teardown uses
    // terminate only AFTER the pressure/refusal assertions, never as their evidence.
    for (const peer of peers) { peer.ws.resume(); peer.ws.terminate(); }
    await cleanup('recovery task settled', async () => { await recoveryTask; });
    await cleanup('event transport close', () => events?.close());
    tickets?.close();
    await cleanup('HTTP listener stop', async () => { await http?.stop(); if (http) assert(!http.server.listening); });
    const cleanupStart = performance.now();
    while (performance.now() - cleanupStart < 3_000 && (native.some((entry) => !entry.exited)
      || serverSockets.size || peers.some((peer) => peer.ws.readyState !== WebSocket.CLOSED))) await sleep(10);
    if (native.some((entry) => !entry.exited)) cleanupErrors.push('native exit unconfirmed');
    if (serverSockets.size || peers.some((peer) => peer.ws.readyState !== WebSocket.CLOSED)) cleanupErrors.push('socket descriptors still owned');
    if ([...sendObservers.values()].some((pending) => pending.frames !== 0 || pending.bytes !== 0)) cleanupErrors.push('send callbacks not settled');
    for (const entry of native) for (const subscription of entry.subscriptions) {
      await cleanup('native observer disposal', () => subscription.dispose());
    }
    let coreStopped = false, coreReleaseAttempted = false;
    if (!nativePortJoinConfirmed || cleanupErrors.length) {
      if (base) cleanupErrors.push('profile owner intentionally retained with unsettled owned resources');
    } else await cleanup('core settlement', async () => {
      if (base) { coreReleaseAttempted = true; assert.equal((await base.stop()).status, 'settled'); coreStopped = true; }
    });
    if (!base && failure) cleanupErrors.push('host startup did not return an owned cleanup handle');
    await cleanup('fake SDK disposal', () => adapter.dispose());
    await cleanup('released profile re-acquisition', async () => {
      if (base && profileResource && !cleanupErrors.length) {
        const released = await OwnerLock.acquire(base.core.paths.lockRoot, 'profile', profileResource);
        await released.release();
      }
    });
    if (base && coreStopped) await cleanup('hub empty after shutdown', () => {
      assert.deepEqual(base!.core.events.inspectBuffers(), { streamCount: 0, subscriptionCount: 0, retainedCount: 0,
        retainedBytes: 0, pendingCount: 0, pendingBytes: 0 });
    });
    metrics.peakBuffers = peak;
    metrics.memory = { initial: initialMemory, peak: peakMemory, afterStop: coreStopped ? memory() : null, afterTeardownAttempt: memory(),
      unit: 'bytes; application host process only, excluding native driver/shell/ConPTY; no forced GC or process-memory pass threshold' };
    metrics.descriptorsAfter = await descriptors();
    metrics.cleanup = { coreStopped, coreReleaseAttempted, nativePortJoinConfirmed, serverSockets: serverSockets.size,
      clientSockets: peers.filter((peer) => peer.ws.readyState !== WebSocket.CLOSED).length,
      liveNativeProcesses: native.filter((entry) => !entry.exited).length,
      liveNativeDrivers: nativePort?.observations().filter((entry) => !entry.driverClosed).length ?? 0, errors: cleanupErrors };
    metrics.cleanupElapsedMs = performance.now() - teardownStarted;
    metrics.totalElapsedMs = performance.now() - launched;
    cleanupConfirmed = cleanupErrors.length === 0;
    if (!cleanupConfirmed) { ok = false; failure ??= `Unconfirmed owned cleanup: ${cleanupErrors.join(', ')}`; }
    ownerState(cleanupConfirmed ? 'settled' : 'uncertain');
    if (process.send) await new Promise<void>((resolve) => process.send!({ type: 'real-transport-load-result', mode, ok, cleanupConfirmed, failure, metrics }, () => resolve()));
    if (process.connected) process.disconnect();
    process.exitCode = ok ? 0 : 1;
  }
}
