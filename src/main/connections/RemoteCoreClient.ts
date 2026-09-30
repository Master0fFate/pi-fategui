import { HttpCommandTransport, UnconfirmedCommand } from '../../client/HttpCommandTransport';
import type { EventConnectionInfo } from '../../client/EventTransport';
import { methodCatalog, publicWorkspaceSchema, type MethodName, type WireResultOf, type Capability, type MutationMethodName } from '../../shared/protocol/methods';
import { hostMethodCatalog, type HostReadMethod, operationMethodSchema } from '../../shared/protocol/hostOperations';
import { textUploadDisplaySchema } from '../../shared/protocol/attachments';
import { permissionReceiptSchema } from '../../shared/protocol/commandOutcomes';
import { requestEnvelopeSchema, type ProtocolResponse, type WireRequest, type MutationRequest, type RequestOf, utf8Bytes } from '../../shared/protocol/envelopes';
import { createMutationIdentity, createServerEpoch } from '../../shared/protocol/requestIds';
import { SNAPSHOT_PAGE_BYTES, SNAPSHOT_TOTAL_BYTES, type SnapshotHeader, type SnapshotPage } from '../../shared/protocol/snapshots';
import { type NetworkEvent } from '../../shared/protocol/diagnostics';
import { desktopConnectionStateSchema, remoteScopeSchema, type DesktopConnectionState, type RemoteScope,
  type RemoteSnapshot, type RemoteMutation, type pendingRemoteOutcomeSchema } from '../../shared/contracts/connections';
import type { MonitorReadInput } from '../../shared/contracts/monitorDashboard';
import { z } from 'zod';
import type { ApprovedConnectionProfile } from './ConnectionProfileStore';
import { NativeEventTransport, NativeProtocolMismatch, type NativeEvents } from './NativeEventTransport';
import { forwardedHostSchema, remoteHandshakePinSchema, type RemoteHandshakePin } from '../../shared/protocol/connectionProfiles';
import { RemoteHandshake, RemoteHandshakeError } from './RemoteHandshake';
import { createNativeForwardedFetch } from './NativeForwardedHttp';

type Workspace = WireResultOf<'workspace.list'>['workspaces'][number];
export type PendingRemoteOutcome = z.infer<typeof pendingRemoteOutcomeSchema>;
export interface RemoteClientOptions {
  readonly send?: typeof fetch;
  readonly makeEvents?: (onEvent: (event: NetworkEvent) => void, onDisconnect: () => void) => NativeEvents;
  readonly outcomeStorage?: boolean;
  readonly saveOutcomes?: (outcomes: readonly PendingRemoteOutcome[]) => Promise<void>;
  /** Trusted main-owned SSH endpoint/pin only. Never accepted over the renderer bridge. */
  readonly forwardedHost?: string;
  readonly handshake?: RemoteHandshakePin;
}
const unavailable = () => new Error('Remote connection or scope is unavailable. Refresh the selected host.');
const safeResult = <M extends MethodName>(response: ProtocolResponse, method: M): WireResultOf<M> => {
  if (!response.ok || response.method !== method) throw new Error(response.ok ? 'Unexpected remote result.' : response.error.code);
  // The transport already parsed the method-correlated response union. Parse once more at the named boundary.
  return methodCatalog[method].wireResultSchema.parse(response.result) as WireResultOf<M>;
};

/** Main-only network owner. It has NO port to a local runtime, shell, project opener, or file service. */
export class RemoteCoreClient {
  private readonly events: NativeEvents;
  private readonly commands: HttpCommandTransport;
  private readonly aborter = new AbortController();
  private epoch: string | null = null;
  private connected = false;
  private closed = false;
  private status: DesktopConnectionState['status'] = 'disconnected';
  private message: DesktopConnectionState['message'] = 'selected';
  private capabilities: Capability[] = [];
  private registered: readonly Workspace[] = [];
  private selected: Workspace | null = null;
  private header: SnapshotHeader | null = null;
  private streamId: string | null = null;
  private snapshotFlight: Promise<RemoteSnapshot> | null = null;
  private workspaceRevision = 0;
  private observedControlGeneration = 0;
  private controlRequest = 0;
  private revision = 0;
  private lease: WireResultOf<'control.claim'> | null = null;
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;
  private hostTime = 0;
  private syncedAt = 0;
  private confirmedAt: number | null = null;
  private hostName: string | null = null;
  private takeoverAllowed = false;
  private providerStatus: 'auth-required' | 'unverified' | null = null;
  private readonly handshake = new RemoteHandshake();
  private confirmedStatus: DesktopConnectionState['lastConfirmedStatus'] = 'unknown';
  private storageHealthy: boolean;
  private readonly privateValues: string[];
  private readonly approvals = new Map<string, { scope: RemoteScope; control: number; challenge: WireResultOf<'permission.issue'> }>();
  constructor(readonly profile: ApprovedConnectionProfile, private readonly credential: string, readonly generation: number,
    private readonly notify: () => void, private readonly outcomes: PendingRemoteOutcome[], private readonly options: RemoteClientOptions = {}) {
    this.storageHealthy = options.outcomeStorage !== false && typeof options.saveOutcomes === 'function';
    if (options.forwardedHost !== undefined) forwardedHostSchema.parse(options.forwardedHost);
    if (options.handshake !== undefined) remoteHandshakePinSchema.parse(options.handshake);
    this.privateValues = [credential, profile.credentialRef, profile.baseUrl];
    this.events = options.makeEvents?.((event) => this.invalidate(event), () => this.lost())
      ?? new NativeEventTransport(profile.baseUrl, credential, (event) => this.invalidate(event), () => this.lost(), options.forwardedHost);
    const send = options.send ?? (options.forwardedHost === undefined ? ((input, init) => globalThis.fetch(input, init))
      : createNativeForwardedFetch(profile.baseUrl, options.forwardedHost));
    this.commands = new HttpCommandTransport(profile.baseUrl, () => ({ Authorization: `Bearer ${this.credential}`,
      ...(options.forwardedHost === undefined ? {} : { Host: options.forwardedHost }) }),
      () => this.events.connection?.ticket ?? null, async (input, init) => {
        const response = await send(input, { ...init, credentials: 'omit', redirect: 'error', cache: 'no-store',
          signal: AbortSignal.any([this.aborter.signal, AbortSignal.timeout(10_000)]) });
        if (response.status === 401 || response.status === 403) throw new Error('Remote authentication unavailable.');
        return response;
      });
  }
  get scope(): RemoteScope | null {
    return this.epoch && this.selected ? { generation: this.generation, profileId: this.profile.id, hostId: this.profile.hostId, serverEpoch: this.epoch,
      workspaceId: this.selected.workspaceId, workspaceGeneration: this.selected.workspaceGeneration,
      sessionId: this.header?.sessionId ?? null, selectionRevision: this.header?.selectionRevision ?? null } : null;
  }
  get control(): number | null {
    return this.connected && this.lease?.expiresAt !== null && this.lease?.expiresAt !== undefined
      && this.lease.expiresAt > this.hostTime + performance.now() - this.syncedAt ? this.lease.generation : null;
  }
  get state(): DesktopConnectionState {
    return desktopConnectionStateSchema.parse({ kind: 'remote', generation: this.generation,
      profile: { id: this.profile.id, label: this.profile.label, hostId: this.profile.hostId }, serverEpoch: this.epoch,
      hostName: this.hostName, serverTime: this.epoch && this.hostName !== null ? this.mutationTime() : null, takeoverAllowed: this.takeoverAllowed,
      providerStatus: this.providerStatus,
      scope: this.scope, status: this.connected && this.header ? this.control === null ? 'observing' : 'controlling' : this.status,
      capabilities: this.capabilities, controlGeneration: this.control, permissionLevel: this.header?.controls.permissionLevel ?? null,
      lastConfirmedAt: this.confirmedAt, lastConfirmedStatus: this.confirmedStatus, pending: this.outcomes,
      outcomeStorage: this.storageHealthy ? 'ready' : 'blocked', message: this.message });
  }
  private changed(status: DesktopConnectionState['status'], message: DesktopConnectionState['message']): void {
    this.status = status; this.message = message; this.notify();
  }
  private clearLease(): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = null; this.lease = null; this.approvals.clear();
  }
  private armLeaseExpiry(lease: WireResultOf<'control.claim'>): void {
    const expiresAt = lease.expiresAt;
    if (expiresAt === null) return;
    const expire = () => {
      if (this.lease !== lease || this.closed) return;
      const remaining = expiresAt - (this.hostTime + performance.now() - this.syncedAt);
      if (remaining > 0) {
        this.leaseTimer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
        this.leaseTimer.unref?.(); return;
      }
      // A late renewal ACK cannot reinstall authority after the captured lease expired.
      this.controlRequest++; this.clearLease(); this.notify();
    };
    this.leaseTimer = setTimeout(expire, Math.min(Math.max(0,
      expiresAt - (this.hostTime + performance.now() - this.syncedAt)), 2_147_483_647));
    this.leaseTimer.unref?.();
  }
  private checkLive(): void { if (this.closed || !this.connected || !this.events.connection || !this.epoch) throw unavailable(); }
  private identity() { return { protocol: 1 as const, requestId: createServerEpoch(), serverEpoch: this.epoch!, issuedAt: Date.now() }; }
  private async command(request: WireRequest): Promise<ProtocolResponse> {
    this.checkLive();
    return this.commands.command(request);
  }
  async connect(isCurrent: () => boolean): Promise<void> {
    if (this.closed || this.connected) throw unavailable();
    this.changed('authenticating', 'connecting');
    let connection: EventConnectionInfo;
    try {
      connection = await this.events.connect();
      if (!isCurrent() || this.closed || this.events.connection?.ticket !== connection.ticket
        || this.events.connection.serverEpoch !== connection.serverEpoch) { this.close(); return; }
      this.privateValues.push(connection.ticket);
      this.epoch = connection.serverEpoch; this.connected = true;
      const handshakeLive = () => isCurrent() && !this.closed && this.connected
        && this.events.connection?.ticket === connection.ticket && this.events.connection.serverEpoch === connection.serverEpoch;
      let info: WireResultOf<'host.info'>;
      if (this.options.handshake) {
        const verified = await this.handshake.verify(this.options.handshake, connection.serverEpoch, {
          info: async () => this.publicResult(await this.command({ ...this.identity(), method: 'host.info', input: {} }), 'host.info'),
          workspaces: async () => this.publicResult(await this.command({ ...this.identity(), method: 'workspace.list', input: {} }), 'workspace.list'),
        }, handshakeLive);
        if (!handshakeLive()) { this.close(); return; }
        info = verified.info; this.registered = verified.workspaces; this.selected = verified.workspace;
      } else {
        const response = await this.command({ ...this.identity(), method: 'host.info', input: {} });
        if (!handshakeLive()) { this.close(); return; }
        info = this.publicResult(response, 'host.info');
      }
      if (info.hostId !== this.profile.hostId || info.serverEpoch !== this.epoch || !info.networkDispatchEnabled) {
        this.close(); this.changed('incompatible', 'identity-mismatch'); return;
      }
      this.capabilities = info.capabilities; this.hostName = info.hostName ?? this.profile.label;
      this.takeoverAllowed = info.takeoverAllowed === true;
      this.providerStatus = info.readiness?.provider ?? null;
      this.hostTime = info.serverTime; this.syncedAt = performance.now();
      this.changed('observing', this.providerStatus === 'auth-required' ? 'provider-auth-required' : 'ready');
    } catch (error) {
      if (!isCurrent() || this.closed) return;
      if (error instanceof RemoteHandshakeError) {
        this.close(); this.changed(error.code === 'identity-mismatch' || error.code === 'protocol-incompatible' ? 'incompatible' : 'error',
          error.code === 'protocol-incompatible' ? 'protocol-incompatible' : error.code === 'connection-canceled' ? 'connection-failed' : error.code);
        return;
      }
      const incompatible = error instanceof NativeProtocolMismatch || error instanceof z.ZodError || error instanceof SyntaxError
        || error instanceof Error && ['Stale command response.', 'PROTOCOL_MISMATCH', 'UNSUPPORTED_CAPABILITY'].includes(error.message);
      this.close(); this.changed(incompatible ? 'incompatible' : 'error', incompatible ? 'protocol-incompatible' : 'connection-failed');
    }
  }
  private publicResult<M extends MethodName>(response: ProtocolResponse, method: M): WireResultOf<M> {
    const result = safeResult(response, method);
    // A host must not echo this client's own bearer/reference/endpoint/ticket into its public display DTO.
    const serialized = JSON.stringify(result, (_key, value: unknown) => typeof value === 'string'
      ? this.privateValues.reduce((text, secret) => text.replaceAll(secret, '[private]'), value) : value);
    return methodCatalog[method].wireResultSchema.parse(JSON.parse(serialized) as unknown) as WireResultOf<M>;
  }
  private requireCapability(method: MethodName): void {
    this.checkLive();
    if (!this.capabilities.includes(methodCatalog[method].capability)) throw new Error('UNSUPPORTED_CAPABILITY');
  }
  async listWorkspaces(): Promise<readonly Workspace[]> {
    this.requireCapability('workspace.list');
    const result = this.publicResult(await this.command({ ...this.identity(), method: 'workspace.list', input: {} }), 'workspace.list');
    this.checkLive();
    const pin = this.options.handshake;
    if (pin && !result.workspaces.some((item) => item.workspaceId === pin.workspaceId && item.workspaceGeneration === pin.workspaceGeneration)) {
      this.close(); this.changed('error', 'workspace-mismatch'); throw new RemoteHandshakeError('workspace-mismatch');
    }
    this.registered = result.workspaces; return result.workspaces;
  }
  private checkScope(input: RemoteScope, requireHeader = true): { scope: RemoteScope; header: SnapshotHeader | null; revision: number } {
    this.checkLive();
    const scope = remoteScopeSchema.parse(input), current = this.scope;
    if (!current || JSON.stringify(current) !== JSON.stringify(scope)
      || requireHeader && (!this.header?.sessionId || this.header.selectionRevision === undefined)) throw unavailable();
    return { scope, header: this.header, revision: this.revision };
  }
  private checkResponse(response: ProtocolResponse, scope: RemoteScope, revision: number): void {
    this.checkLive();
    if (revision !== this.revision || response.serverEpoch !== scope.serverEpoch || !response.scope
      || response.scope.workspaceId !== scope.workspaceId || response.scope.workspaceGeneration !== scope.workspaceGeneration) throw unavailable();
    this.checkScope(scope, false);
  }
  private async page(scope: RemoteScope, pageId?: string): Promise<SnapshotPage> {
    const request = pageId === undefined ? { ...this.identity(), method: 'workspace.snapshot' as const,
      workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration, input: {} }
      : { ...this.identity(), method: 'workspace.snapshotPage' as const, workspaceId: scope.workspaceId,
        workspaceGeneration: scope.workspaceGeneration, input: { pageId } };
    const response = await this.command(request);
    this.checkResponse(response, scope, this.revision);
    return this.publicResult(response, request.method);
  }
  readSnapshot(workspace: Workspace): Promise<RemoteSnapshot> {
    const flight = this.assembleSnapshot(workspace); this.snapshotFlight = flight;
    return flight.finally(() => { if (this.snapshotFlight === flight) this.snapshotFlight = null; });
  }
  private async assembleSnapshot(workspace: Workspace): Promise<RemoteSnapshot> {
    this.requireCapability('workspace.snapshot');
    const selected = publicWorkspaceSchema.parse(workspace);
    const pin = this.options.handshake;
    if (pin && (selected.workspaceId !== pin.workspaceId || selected.workspaceGeneration !== pin.workspaceGeneration)) throw new RemoteHandshakeError('workspace-mismatch');
    if (!this.registered.some((item) => item.workspaceId === selected.workspaceId
      && item.workspaceGeneration === selected.workspaceGeneration && item.label === selected.label)) throw unavailable();
    if (this.selected?.workspaceId !== selected.workspaceId || this.selected.workspaceGeneration !== selected.workspaceGeneration) {
      this.clearLease(); this.streamId = null; this.observedControlGeneration = 0;
      this.workspaceRevision++; this.controlRequest++;
    }
    this.selected = selected; this.header = null;
    const revision = ++this.revision, scope = this.scope!;
    this.changed('synchronizing', 'refresh-required');
    const first = await this.page(scope), header = first.header;
    if (!header || first.index !== 0 || header.serverEpoch !== scope.serverEpoch || header.workspaceId !== scope.workspaceId
      || header.workspaceGeneration !== scope.workspaceGeneration || header.expiresAt <= this.mutationTime() || !header.eventStream
      || header.eventStream.serverEpoch !== scope.serverEpoch || header.eventStream.workspaceId !== scope.workspaceId
      || header.eventStream.workspaceGeneration !== scope.workspaceGeneration) throw unavailable();
    const items: RemoteSnapshot['items'] = [];
    let page = first, bytes = 0;
    for (let index = 0; index < header.pageIds.length; index++) {
      this.checkLive();
      if (revision !== this.revision || page.index !== index || page.snapshotId !== header.snapshotId
        || page.pageId !== header.pageIds[index] || index > 0 && page.header !== undefined
        || page.nextPageId !== (header.pageIds[index + 1] ?? null) || header.expiresAt <= this.mutationTime()) throw unavailable();
      const size = utf8Bytes(JSON.stringify(page)); bytes += size;
      if (size > SNAPSHOT_PAGE_BYTES || bytes > SNAPSHOT_TOTAL_BYTES) throw unavailable();
      items.push(...page.items);
      if (page.nextPageId) page = await this.page(scope, page.nextPageId);
    }
    if ('controlGeneration' in header.controls && typeof header.controls.controlGeneration === 'number') {
      this.observedControlGeneration = Math.max(this.observedControlGeneration, header.controls.controlGeneration);
    }
    if (this.lease && this.lease.generation < this.observedControlGeneration) this.clearLease();
    this.header = header; this.streamId = header.eventStream.streamId;
    try {
      await this.events.subscribe(scope.workspaceId, scope.workspaceGeneration, header.eventStream);
      this.checkLive();
      if (revision !== this.revision || this.header !== header) throw unavailable();
      this.confirmedAt = header.capturedAt; this.confirmedStatus = header.controls.streaming || header.controls.activeSessionRunning
        || header.controls.runningSessionCount > 0 ? 'running' : 'idle';
      this.changed(this.control === null ? 'observing' : 'controlling', 'ready');
      return { scope: this.scope!, header, items };
    } catch { if (this.header === header) this.header = null; throw unavailable(); }
  }
  async read<M extends 'workspace.monitor' | 'goal.get' | 'task.list' | 'git.status' | 'git.history' | 'file.list' | 'file.previewText' | 'command.status' | HostReadMethod>(
    scope: RemoteScope, method: M, input: unknown): Promise<WireResultOf<M>> {
    this.requireCapability(method);
    const sessionRead = ['workspace.monitor', 'goal.get', 'task.list', 'git.status', 'git.history'].includes(method)
      || Object.hasOwn(hostMethodCatalog, method);
    const captured = this.checkScope(scope, sessionRead);
    if (method !== 'command.status' && !captured.header) throw unavailable();
    const request = requestEnvelopeSchema.parse({ ...this.identity(), method, workspaceId: scope.workspaceId,
      workspaceGeneration: scope.workspaceGeneration,
      ...(sessionRead && captured.header?.sessionId && captured.header.selectionRevision !== undefined ? {
        expectedSessionId: captured.header.sessionId, selectionRevision: captured.header.selectionRevision } : {}),
      input: methodCatalog[method].inputSchema.parse(input) });
    const response = await this.command(request);
    this.checkResponse(response, captured.scope, captured.revision);
    const result = this.publicResult(response, method);
    if (typeof result === 'object' && result !== null && 'sessionId' in result
      && (result.sessionId !== captured.header?.sessionId || 'selectionRevision' in result
        && result.selectionRevision !== captured.header?.selectionRevision)) throw unavailable();
    return result;
  }
  async uploadText(scope: RemoteScope, value: z.infer<typeof textUploadDisplaySchema>): Promise<WireResultOf<'text.upload'>> {
    const input = textUploadDisplaySchema.parse(value);
    return this.read(scope, 'text.upload', { name: input.name, contentType: 'text/plain', encoding: 'base64',
      data: Buffer.from(input.text, 'utf8').toString('base64') });
  }
  async monitor(scope: RemoteScope, input: MonitorReadInput) {
    return { scope, dashboard: await this.read(scope, 'workspace.monitor', input) };
  }
  async leaseAction(scope: RemoteScope, method: 'control.claim' | 'control.renew' | 'control.takeover',
    isCurrent: () => boolean = () => true): Promise<WireResultOf<'control.claim'>> {
    if (!isCurrent()) throw unavailable();
    this.requireCapability(method);
    const captured = this.checkScope(scope, false);
    if (!captured.header) throw unavailable();
    const generation = this.control, workspaceRevision = this.workspaceRevision, operation = ++this.controlRequest;
    if (method === 'control.renew' && generation === null || method === 'control.takeover' && !this.takeoverAllowed) throw unavailable();
    const request = requestEnvelopeSchema.parse({ ...this.identity(), method, workspaceId: scope.workspaceId,
      workspaceGeneration: scope.workspaceGeneration, input: method === 'control.renew' ? { generation } : {} });
    const response = await this.command(request);
    // A control event can precede its own HTTP ACK. Same-workspace refresh is not a
    // new claim; wait for its authoritative binding, then reject changed scope/ABA.
    if (!this.header && this.snapshotFlight) await this.snapshotFlight;
    if (!isCurrent() || operation !== this.controlRequest || workspaceRevision !== this.workspaceRevision) throw unavailable();
    this.checkResponse(response, scope, this.revision);
    const lease = safeResult(response, method);
    if (lease.generation < this.observedControlGeneration || method === 'control.renew' && lease.generation !== generation
      || lease.expiresAt === null || lease.expiresAt <= this.mutationTime()) throw unavailable();
    this.observedControlGeneration = Math.max(this.observedControlGeneration, lease.generation);
    this.clearLease(); this.lease = lease; this.armLeaseExpiry(lease);
    this.notify(); return lease;
  }
  claim(scope: RemoteScope, isCurrent: () => boolean = () => true) { return this.leaseAction(scope, 'control.claim', isCurrent); }
  async release(scope: RemoteScope): Promise<void> {
    const captured = this.checkScope(scope, false), generation = this.control;
    this.controlRequest++; this.clearLease(); this.notify();
    if (generation === null) return;
    const response = await this.command({ ...this.identity(), method: 'control.release', workspaceId: scope.workspaceId,
      workspaceGeneration: scope.workspaceGeneration, input: { generation } });
    this.checkResponse(response, scope, captured.revision); safeResult(response, 'control.release');
  }
  private requireOutcomeStorage(scope: RemoteScope): void {
    if (!this.storageHealthy) throw new Error('STORAGE_UNAVAILABLE');
    if (this.outcomes.some((item) => item.scope.profileId === scope.profileId && item.scope.hostId === scope.hostId && item.scope.workspaceId === scope.workspaceId
      && item.scope.workspaceGeneration === scope.workspaceGeneration && ['sending', 'outcome_unknown'].includes(item.status))) {
      throw new Error('Review the original uncertain command before starting another effect.');
    }
  }
  async issuePermission(scope: RemoteScope, level: WireResultOf<'permission.issue'>['newLevel'],
    isCurrent: () => boolean = () => true): Promise<WireResultOf<'permission.issue'>> {
    if (!isCurrent()) throw unavailable();
    this.requireOutcomeStorage(scope); this.requireCapability('permission.issue');
    const captured = this.checkScope(scope), header = captured.header!, control = this.control;
    if (control === null || this.approvals.size >= 16) throw unavailable();
    const response = await this.command({ ...this.identity(), method: 'permission.issue', workspaceId: scope.workspaceId,
      workspaceGeneration: scope.workspaceGeneration, selectionRevision: header.selectionRevision!, controlGeneration: control,
      input: { sessionId: header.sessionId!, action: 'runtime.setPermission', oldLevel: header.controls.permissionLevel, newLevel: level } });
    this.checkResponse(response, scope, captured.revision);
    const challenge = safeResult(response, 'permission.issue');
    if (!isCurrent() || this.control !== control || challenge.expiresAt <= this.mutationTime() || challenge.sessionId !== header.sessionId
      || challenge.oldLevel !== header.controls.permissionLevel || challenge.newLevel !== level) throw unavailable();
    this.approvals.set(challenge.challengeId, { scope, control, challenge }); return challenge;
  }
  async confirmPermission(scope: RemoteScope, challengeId: string, isCurrent: () => boolean): Promise<RemoteMutation> {
    this.requireOutcomeStorage(scope); this.requireCapability('permission.confirm');
    const captured = this.checkScope(scope), header = captured.header!, control = this.control;
    const approval = this.approvals.get(challengeId);
    if (!approval || JSON.stringify(approval.scope) !== JSON.stringify(scope) || approval.control !== control
      || approval.challenge.sessionId !== header.sessionId || approval.challenge.oldLevel !== header.controls.permissionLevel
      || approval.challenge.expiresAt <= this.hostTime + performance.now() - this.syncedAt) throw unavailable();
    const request = requestEnvelopeSchema.parse({ protocol: 1, ...createMutationIdentity(this.epoch!, this.mutationTime()),
      method: 'permission.confirm', workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration,
      selectionRevision: header.selectionRevision!, controlGeneration: control,
      input: { sessionId: header.sessionId!, action: 'runtime.setPermission', challengeId,
        oldLevel: approval.challenge.oldLevel, newLevel: approval.challenge.newLevel } });
    if (request.method !== 'permission.confirm') throw unavailable();
    this.approvals.delete(challengeId);
    return this.effect(scope, request, captured, () => isCurrent()
      && approval.challenge.expiresAt > this.hostTime + performance.now() - this.syncedAt);
  }
  private mutationTime(): number { return Math.max(0, Math.floor(this.hostTime + performance.now() - this.syncedAt)); }
  async mutate(scope: RemoteScope, method: MutationMethodName, input: unknown,
    isCurrent: () => boolean = () => true): Promise<RemoteMutation> {
    this.requireOutcomeStorage(scope); this.requireCapability(method);
    const captured = this.checkScope(scope), header = captured.header!, control = this.control;
    if (control === null || methodCatalog[method].permission === 'prompt' && header.controls.permissionLevel === 'read-only') throw unavailable();
    const request = requestEnvelopeSchema.parse({ protocol: 1, ...createMutationIdentity(this.epoch!, this.mutationTime()), method,
      workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration,
      expectedSessionId: header.sessionId!, selectionRevision: header.selectionRevision!, controlGeneration: control,
      input: methodCatalog[method].inputSchema.parse(input) });
    if (request.method !== 'runtime.prompt' && request.method !== 'runtime.abort' && request.method !== 'session.select'
      && !operationMethodSchema.safeParse(request.method).success) throw unavailable();
    if (!('expectedSessionId' in request) || !('controlGeneration' in request)) throw unavailable();
    return this.effect(scope, request, captured, isCurrent);
  }
  private async effect(scope: RemoteScope, request: MutationRequest | RequestOf<'permission.confirm'>,
    captured: { header: SnapshotHeader | null; revision: number }, isCurrent: () => boolean): Promise<RemoteMutation> {
    const header = captured.header!, method = request.method;
    if (this.outcomes.length >= 128) {
      const settled = this.outcomes.findIndex((item) => item.status === 'confirmed' || item.status === 'not-started');
      if (settled < 0) throw new Error('Pending command limit reached.');
      this.outcomes.splice(settled, 1);
    }
    const pending: PendingRemoteOutcome = { scope, requestId: request.requestId, method, sessionId: header.sessionId!,
      selectionRevision: header.selectionRevision!, status: 'sending',
      ...(request.method === 'session.select' ? { targetSessionId: request.input.sessionId } : {}),
      ...(request.method === 'permission.confirm' ? { permission: { oldLevel: request.input.oldLevel,
        newLevel: request.input.newLevel, challengeId: request.input.challengeId,
        controlGeneration: request.controlGeneration, observed: null } } : {}) };
    this.outcomes.push(pending); this.notify();
    try {
      // Original ID is safely recorded BEFORE the first network byte. Reopening main only reviews it.
      await this.options.saveOutcomes?.(this.outcomes);
      if (!isCurrent() || this.closed || !this.storageHealthy || captured.revision !== this.revision || this.control !== request.controlGeneration) {
        pending.status = 'not-started'; await this.options.saveOutcomes?.(this.outcomes);
        this.notify(); return { requestId: request.requestId, status: 'not-started', response: null };
      }
    } catch {
      this.storageHealthy = false; pending.status = 'not-started'; this.notify();
      return { requestId: request.requestId, status: 'not-started', response: null };
    }
    let response: ProtocolResponse | null = null;
    let status: RemoteMutation['status'] = 'outcome_unknown';
    try {
      response = request.method === 'permission.confirm' ? await this.commands.command(request)
        : await this.commands.commandWithStatus(request);
      this.checkResponse(response, scope, captured.revision);
      if (!response.ok) status = response.execution === 'not-started' ? 'not-started' : 'outcome_unknown';
      else if (request.method === 'permission.confirm') {
        const confirmation = safeResult(response, 'permission.confirm');
        if (confirmation.sessionId !== header.sessionId || confirmation.level !== request.input.newLevel) throw unavailable();
        status = 'confirmed';
      } else {
        const receipt = safeResult(response, request.method);
        if (receipt.requestId !== request.requestId || receipt.durability !== 'journaled'
          || request.method !== 'session.create' && receipt.sessionId !== (request.method === 'session.select' ? request.input.sessionId : header.sessionId)
          || 'operation' in receipt && receipt.operation !== request.method) throw unavailable();
        status = 'confirmed';
      }
    } catch (error) { if (error instanceof UnconfirmedCommand) response = error.status; }
    pending.status = status;
    try { await this.options.saveOutcomes?.(this.outcomes); }
    catch { this.storageHealthy = false; pending.status = 'outcome_unknown'; status = 'outcome_unknown'; }
    this.header = null; this.revision++; this.changed(this.connected ? 'observing' : 'disconnected', 'refresh-required');
    return { requestId: request.requestId, status, response };
  }
  async review(scope: RemoteScope, requestId: string): Promise<WireResultOf<'command.status'>> {
    const pending = this.outcomes.find((item) => item.requestId === requestId && item.scope.profileId === scope.profileId && item.scope.hostId === scope.hostId
      && item.scope.workspaceId === scope.workspaceId && item.scope.workspaceGeneration === scope.workspaceGeneration);
    if (!pending) throw new Error('Only an original command for this host and workspace can be reviewed.');
    const result = await this.read(scope, 'command.status', { requestId });
    const receipt = result.receipt;
    let confirmed = false;
    if (receipt) {
      const method = receipt.kind === 'operation' ? receipt.operation : receipt.kind === 'prompt' ? 'runtime.prompt'
        : receipt.kind === 'abort' ? 'runtime.abort' : receipt.kind === 'permission' ? 'permission.confirm' : 'session.select';
      if (receipt.requestId !== pending.requestId || method !== pending.method || receipt.durability !== 'journaled') throw unavailable();
      if (pending.method === 'permission.confirm') {
        const permission = permissionReceiptSchema.parse(receipt), original = pending.permission;
        if (permission.workspaceId !== pending.scope.workspaceId || permission.workspaceGeneration !== pending.scope.workspaceGeneration
          || permission.sessionId !== pending.sessionId || permission.selectionRevision !== pending.selectionRevision
          || original && (permission.oldLevel !== original.oldLevel || permission.newLevel !== original.newLevel
            || original.challengeId !== undefined && permission.challengeId !== original.challengeId
            || original.controlGeneration !== undefined && permission.controlGeneration !== original.controlGeneration)) throw unavailable();
        // Old records lack the complete admission tuple. Preserve uncertainty, even on a matching level.
        confirmed = original?.challengeId !== undefined && original.controlGeneration !== undefined;
      } else if (pending.method === 'session.select') {
        if (pending.targetSessionId !== undefined && receipt.sessionId !== pending.targetSessionId) throw unavailable();
        confirmed = pending.targetSessionId !== undefined;
      } else {
        if (pending.method !== 'session.create' && receipt.sessionId !== pending.sessionId) throw unavailable();
        confirmed = true;
      }
    }
    if (pending.method === 'permission.confirm' && pending.permission && this.header) {
      pending.permission.observed = { sessionId: this.header.sessionId, selectionRevision: this.header.selectionRevision ?? null,
        level: this.header.controls.permissionLevel, capturedAt: this.header.capturedAt };
    }
    const completePermission = pending.permission?.challengeId !== undefined && pending.permission.controlGeneration !== undefined;
    // The authenticated, scope-fenced status lookup names the saved ORIGINAL ID.
    // The current host journals pre-admission grant rejection; legacy incomplete metadata cannot rely on it.
    const rejected = result.state === 'rejected' && result.rejectionCode !== null
      && (pending.method !== 'permission.confirm' || completePermission);
    pending.status = confirmed ? 'confirmed' : rejected ? 'not-started' : 'outcome_unknown';
    try { await this.options.saveOutcomes?.(this.outcomes); }
    catch { this.storageHealthy = false; pending.status = 'outcome_unknown'; this.notify(); throw new Error('STORAGE_UNAVAILABLE'); }
    this.notify();
    // A receipt that cannot be correlated to legacy metadata must not clear the renderer's original-ID review either.
    return receipt && !confirmed || pending.method === 'permission.confirm' && !confirmed && !rejected
      ? { state: 'outcome_unknown', receipt: null, rejectionCode: null } : result;
  }
  private invalidate(event: NetworkEvent): void {
    if (this.closed || !this.connected || !this.selected || event.serverEpoch !== this.epoch
      || event.origin.workspaceId !== this.selected.workspaceId || event.origin.workspaceGeneration !== this.selected.workspaceGeneration
      || event.streamId !== this.streamId) return;
    if (event.category === 'control') {
      const generation = event.controlGeneration;
      if (generation === undefined) { this.lost(); return; }
      if (generation < this.observedControlGeneration) return;
      this.observedControlGeneration = generation;
      // The event is not proof that this ticket owns the new lease. A matching own
      // renewal/event must not erase it; a newer generation revokes only an older lease.
      if (this.lease && generation > this.lease.generation) this.clearLease();
      this.notify(); return; // No domain/snapshot transition; pending own ACK remains scoped.
    }
    this.header = null; this.revision++; this.changed('observing', 'refresh-required');
  }
  private lost(): void {
    if (this.closed) return;
    this.connected = false; this.header = null; this.streamId = null; this.controlRequest++; this.clearLease(); this.revision++;
    for (const item of this.outcomes) if (item.scope.generation === this.generation && item.status === 'sending') item.status = 'outcome_unknown';
    this.changed('disconnected', 'disconnected');
  }
  close(): void {
    this.closed = true; this.connected = false; this.handshake.close(); this.aborter.abort(); this.events.close();
    this.header = null; this.streamId = null; this.controlRequest++; this.clearLease(); this.revision++;
    for (const item of this.outcomes) if (item.scope.generation === this.generation && item.status === 'sending') item.status = 'outcome_unknown';
    this.status = 'disconnected'; this.message = 'disconnected';
  }
}
