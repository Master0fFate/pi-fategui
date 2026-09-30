import { desktopConnectionStateSchema, connectionGenerationSchema, connectionSelectSchema,
  type ConnectionSelection, type DesktopConnectionState, type RemoteMutation, type RemoteScope } from '../../shared/contracts/connections';
import { ConnectionProfileStore, isSshConnectionProfile } from './ConnectionProfileStore';
import type { MutationMethodName } from '../../shared/protocol/methods';
import { RemoteCoreClient, type PendingRemoteOutcome, type RemoteClientOptions } from './RemoteCoreClient';
import { SshTunnel, SshTunnelError, type SshTunnelOptions } from './SshTunnel';

/** Native client UI only; remote workspace operations cannot enter any legacy service. */
export function isClientNativeChannel(channel: string): boolean {
  return channel === 'system:get-info' || channel === 'clipboard:write-text'
    || channel === 'settings:get' || channel === 'settings:set'
    || /^(?:window|updates|speech|music|skins):/u.test(channel);
}
const unavailable = () => new Error('Select the local desktop explicitly before using a local workspace operation.');

/** Process-wide sole selected command target. A failed remote connection stays REMOTE. */
export class DesktopConnectionRouter {
  private selection: ConnectionSelection = { kind: 'local' };
  private generation = 0;
  private client: RemoteCoreClient | null = null;
  private localOperations = 0;
  private readonly outcomes: PendingRemoteOutcome[] = [];
  private readonly listeners = new Set<(state: DesktopConnectionState) => void>();
  private connecting = false;
  private connectionError = false;
  private disconnectedState: DesktopConnectionState | null = null;
  private selecting = false;
  private tunnel: SshTunnel | null = null;
  private tunnelStop: Promise<void> | null = null;
  private attempt: AbortController | null = null;
  private connectionMessage: DesktopConnectionState['message'] = 'connection-failed';
  constructor(private readonly profiles: ConnectionProfileStore, private readonly options: RemoteClientOptions = {},
    private readonly target: { readonly initialSelection?: ConnectionSelection; readonly initialOutcomes?: readonly PendingRemoteOutcome[];
      readonly persistSelection?: (selection: ConnectionSelection) => Promise<void>;
      /** Main-owned fixture/system configuration. Never accepted from renderer input. */
      readonly tunnelOptions?: SshTunnelOptions } = {}) {
    this.outcomes.push(...target.initialOutcomes ?? []);
    this.selection = target.initialSelection ?? { kind: 'local' };
    const initial = this.selection;
    if (initial.kind === 'remote' && !profiles.list().some((profile) => profile.id === initial.profileId)) {
      this.connectionError = true; // A removed/unreadable saved remote profile must NOT select local.
    }
  }
  get isLocal(): boolean { return this.selection.kind === 'local'; }
  get state(): DesktopConnectionState {
    if (this.client) return this.client.state;
    if (this.disconnectedState) return desktopConnectionStateSchema.parse({ ...this.disconnectedState, pending: this.outcomes });
    const selection = this.selection;
    const profile = selection.kind === 'remote' ? this.profiles.list().find((item) => item.id === selection.profileId) ?? null : null;
    return desktopConnectionStateSchema.parse({ kind: this.selection.kind, generation: this.generation, profile,
      scope: null, serverEpoch: null, status: this.connecting ? this.connectionMessage === 'ssh-connecting' ? 'connecting' : 'authenticating' : this.connectionError ? 'error' : 'disconnected',
      capabilities: [], controlGeneration: null, permissionLevel: null, lastConfirmedStatus: 'unknown', lastConfirmedAt: null,
      pending: this.outcomes, outcomeStorage: this.options.outcomeStorage === false || !this.options.saveOutcomes ? 'blocked' : 'ready', message: this.isLocal ? 'local' : this.connectionError ? this.connectionMessage : this.connecting ? this.connectionMessage : 'selected' });
  }
  listProfiles() { return this.profiles.list(); }
  subscribe(listener: (state: DesktopConnectionState) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private notify(): void { for (const listener of this.listeners) listener(this.state); }
  assertLocal(): void { if (!this.isLocal || this.selecting) throw unavailable(); }
  /** Pin a whole legacy async/queue turn. Selecting remote while one is pending is refused,
   * so a paused local handler cannot later execute under a remote workspace label. */
  async local<T>(operation: () => T | Promise<T>): Promise<T> {
    this.assertLocal(); this.localOperations++;
    try { return await operation(); } finally { this.localOperations--; }
  }
  routeLegacy<T>(channel: string, operation: () => T | Promise<T>): T | Promise<T> {
    if (isClientNativeChannel(channel)) return operation();
    return this.local(operation);
  }
  async select(input: unknown): Promise<DesktopConnectionState> {
    const selection = connectionSelectSchema.parse(input);
    if (this.localOperations !== 0 || this.selecting) throw new Error('Wait for pending local operations before changing hosts.');
    if (selection.kind === 'remote') this.profiles.resolve(selection.profileId);
    this.selecting = true;
    try {
      this.attempt?.abort(); this.attempt = null;
      // An unfinished SSH stop cannot commit a replacement target on disk.
      if (this.tunnel) { this.client?.close(); this.client = null; await this.stopTunnel(); }
      await this.target.persistSelection?.(selection);
      this.client?.close(); this.client = null;
      await this.stopTunnel();
      this.generation++; this.selection = selection; this.connecting = false; this.connectionError = false; this.disconnectedState = null;
      this.notify(); return this.state;
    } catch (error) {
      if (error instanceof SshTunnelError) {
        this.connectionError = true; this.connectionMessage = 'ssh-stop-pending';
        if (this.disconnectedState) { this.disconnectedState.status = 'error'; this.disconnectedState.message = 'ssh-stop-pending'; }
        this.notify();
      }
      throw error;
    } finally { this.selecting = false; }
  }
  private checkGeneration(input: unknown): number {
    const { generation } = connectionGenerationSchema.parse(input);
    if (this.selecting || generation !== this.generation || this.selection.kind !== 'remote') throw new Error('Desktop connection selection changed.');
    return generation;
  }
  async connect(input: unknown, trusted: () => boolean): Promise<DesktopConnectionState> {
    this.checkGeneration(input);
    if (!trusted()) throw new Error('The initiating renderer document is unavailable.');
    if (this.connecting) throw new Error('A connection is already pending.');
    const selection = this.selection;
    if (selection.kind !== 'remote') throw unavailable();
    this.client?.close(); this.client = null; this.disconnectedState = null;
    this.attempt?.abort();
    const aborter = new AbortController(); this.attempt = aborter;
    const generation = ++this.generation;
    this.connectionMessage = 'connecting';
    this.connecting = true; this.connectionError = false; this.notify();
    const live = () => trusted() && !aborter.signal.aborted && !this.selecting && this.generation === generation && this.selection.kind === 'remote'
      && this.selection.profileId === selection.profileId;
    try {
      await this.stopTunnel();
      if (!live()) return this.state;
      const profile = this.profiles.resolve(selection.profileId);
      this.connectionMessage = isSshConnectionProfile(profile) ? 'ssh-connecting' : 'connecting'; this.notify();
      const credential = await this.profiles.credential(selection.profileId);
      if (!live()) return this.state;
      let endpointProfile, clientOptions = this.options;
      if (isSshConnectionProfile(profile)) {
        const tunnel = new SshTunnel(profile, this.target.tunnelOptions, () => this.tunnelLost(tunnel));
        this.tunnel = tunnel;
        const endpoint = await tunnel.open(aborter.signal);
        if (!live()) { await this.stopTunnel(); return this.state; }
        endpointProfile = { id: profile.id, label: profile.label, hostId: profile.hostId, approved: true as const,
          baseUrl: endpoint.baseUrl, credentialRef: profile.credentialRef };
        clientOptions = { ...this.options, forwardedHost: endpoint.forwardedHost,
          handshake: { hostId: profile.hostId, workspaceId: profile.workspaceId, workspaceGeneration: profile.workspaceGeneration } };
        this.connectionMessage = 'connecting'; this.notify();
      } else endpointProfile = profile;
      const client = new RemoteCoreClient(endpointProfile, credential, generation,
        () => { if (this.client === client) this.notify(); }, this.outcomes, clientOptions);
      this.client = client;
      await client.connect(live);
      if (!live()) { client.close(); if (this.client === client) this.client = null; await this.stopTunnel(); }
      else if (['error', 'incompatible', 'disconnected'].includes(client.state.status)) await this.stopTunnel();
    } catch (error) {
      try { await this.stopTunnel(); }
      catch { if (live()) { this.client?.close(); this.client = null; this.connectionError = true; this.connectionMessage = 'ssh-stop-pending'; } }
      if (live()) {
        this.connectionError = true;
        if (this.connectionMessage !== 'ssh-stop-pending') this.connectionMessage = error instanceof SshTunnelError
          ? error.code === 'host-verification-required' ? 'ssh-host-verification-required'
            : error.code === 'authentication-failed' ? 'ssh-authentication-failed'
              : error.code === 'port-collision' ? 'ssh-port-collision' : error.code === 'ssh-unavailable' ? 'ssh-unavailable' : 'connection-failed'
          : 'connection-failed';
      }
    } finally { if (this.generation === generation) { this.connecting = false; this.notify(); } }
    return this.state;
  }
  disconnect(input: unknown): DesktopConnectionState {
    this.checkGeneration(input);
    const previous = this.state;
    this.attempt?.abort(); this.attempt = null;
    this.client?.close(); this.client = null; this.generation++;
    // Keep the last confirmed remote state and original command IDs. No local selection or open occurs.
    this.connecting = false; this.connectionError = false;
    this.disconnectedState = { ...previous, generation: this.generation, scope: null, status: 'disconnected',
      controlGeneration: null, permissionLevel: null, message: this.tunnel ? 'ssh-stop-pending' : 'disconnected' };
    const generation = this.generation;
    void this.stopTunnel().then(() => {
      if (this.generation === generation && this.disconnectedState) { this.disconnectedState.message = 'disconnected'; this.notify(); }
    }, () => {
      if (this.generation === generation && this.disconnectedState) { this.disconnectedState.status = 'error'; this.disconnectedState.message = 'ssh-stop-pending'; this.notify(); }
    });
    this.notify(); return this.state;
  }
  private remote(generation: number): RemoteCoreClient {
    this.checkGeneration({ generation });
    if (!this.client) throw new Error('Connect the selected remote profile first.');
    return this.client;
  }
  async read<T>(generation: number, trusted: () => boolean, operation: (client: RemoteCoreClient) => Promise<T>): Promise<T> {
    if (!trusted()) throw new Error('The initiating renderer document is unavailable.');
    const client = this.remote(generation), result = await operation(client);
    if (!trusted() || this.client !== client || this.generation !== generation || this.isLocal) throw new Error('Desktop connection selection changed.');
    return result;
  }
  async mutate(scope: RemoteScope, trusted: () => boolean, method: MutationMethodName, input: unknown): Promise<RemoteMutation> {
    if (!trusted()) throw new Error('The initiating renderer document is unavailable.');
    const client = this.remote(scope.generation), result = await client.mutate(scope, method, input,
      () => trusted() && this.client === client && this.generation === scope.generation && !this.isLocal);
    // Once admitted/sent, a late result must retain its ORIGINAL ID even after host switch or navigation.
    return (!trusted() || this.client !== client || this.generation !== scope.generation || this.isLocal)
      && result.status !== 'not-started' ? { ...result, status: 'outcome_unknown' } : result;
  }
  async confirmPermission(scope: RemoteScope, trusted: () => boolean, challengeId: string): Promise<RemoteMutation> {
    if (!trusted()) throw new Error('The initiating renderer document is unavailable.');
    const client = this.remote(scope.generation), result = await client.confirmPermission(scope, challengeId,
      () => trusted() && this.client === client && this.generation === scope.generation && !this.isLocal);
    return (!trusted() || this.client !== client || this.generation !== scope.generation || this.isLocal)
      && result.status !== 'not-started' ? { ...result, status: 'outcome_unknown' } : result;
  }
  private stopTunnel(): Promise<void> {
    if (this.tunnelStop) return this.tunnelStop;
    const tunnel = this.tunnel;
    if (!tunnel) return Promise.resolve();
    return this.tunnelStop = tunnel.close().then(() => { if (this.tunnel === tunnel) this.tunnel = null; })
      .finally(() => { this.tunnelStop = null; });
  }
  private tunnelLost(tunnel: SshTunnel): void {
    if (this.tunnel !== tunnel) return;
    this.tunnel = null;
    const previous = this.state;
    this.attempt?.abort(); this.attempt = null; this.client?.close(); this.client = null; this.generation++;
    this.connecting = false; this.connectionError = false;
    this.disconnectedState = { ...previous, generation: this.generation, scope: null, status: 'disconnected',
      controlGeneration: null, permissionLevel: null, message: 'disconnected' };
    this.notify();
  }
  close(): Promise<void> {
    this.attempt?.abort(); this.attempt = null; this.generation++;
    this.client?.close(); this.client = null; this.listeners.clear();
    return this.stopTunnel();
  }
}
