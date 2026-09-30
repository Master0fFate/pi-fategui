import { z } from 'zod';
import { methodCatalog, type WireResultOf } from '../../shared/protocol/methods';
import { uuidSchema } from '../../shared/protocol/requestIds';
import { remoteHandshakePinSchema, type RemoteHandshakePin } from '../../shared/protocol/connectionProfiles';

export type RemoteHandshakeFailure = 'identity-mismatch' | 'protocol-incompatible' | 'profile-unhealthy'
  | 'workspace-mismatch' | 'connection-canceled';
export class RemoteHandshakeError extends Error {
  constructor(readonly code: RemoteHandshakeFailure) { super('Remote readiness was not verified.'); this.name = 'RemoteHandshakeError'; }
}
export interface RemoteHandshakeEndpoint {
  info(): Promise<unknown>;
  workspaces(): Promise<unknown>;
}
export interface VerifiedRemoteHandshake {
  readonly info: WireResultOf<'host.info'>;
  readonly workspaces: WireResultOf<'workspace.list'>['workspaces'];
  readonly workspace: WireResultOf<'workspace.list'>['workspaces'][number];
}

/** Authenticated main-only verification. No snapshots or command authority before the pin passes. */
export class RemoteHandshake {
  private revision = 0;
  private closed = false;
  async verify(input: RemoteHandshakePin, eventEpoch: string, endpoint: RemoteHandshakeEndpoint,
    isCurrent: () => boolean): Promise<VerifiedRemoteHandshake> {
    const pin = remoteHandshakePinSchema.parse(input), epoch = uuidSchema.parse(eventEpoch), revision = ++this.revision;
    const live = () => {
      if (this.closed || this.revision !== revision || !isCurrent()) throw new RemoteHandshakeError('connection-canceled');
    };
    live();
    let info: WireResultOf<'host.info'>;
    try { const value = await endpoint.info(); live(); info = methodCatalog['host.info'].wireResultSchema.parse(value); }
    catch (error) { live(); if (error instanceof z.ZodError) throw new RemoteHandshakeError('protocol-incompatible'); throw error; }
    if (info.hostId !== pin.hostId || info.serverEpoch !== epoch) throw new RemoteHandshakeError('identity-mismatch');
    const health = info.readiness;
    if (!info.networkDispatchEnabled || !health || !health.ready || health.profileLock !== 'held'
      || health.workspaceRegistry !== 'ready' || health.permissionStore !== 'healthy' || health.commandJournal !== 'healthy'
      || health.authentication !== 'ready' || health.requiredServices !== 'ready') throw new RemoteHandshakeError('profile-unhealthy');
    let workspaces: WireResultOf<'workspace.list'>['workspaces'];
    try { const value = await endpoint.workspaces(); live(); workspaces = methodCatalog['workspace.list'].wireResultSchema.parse(value).workspaces; }
    catch (error) { live(); if (error instanceof z.ZodError) throw new RemoteHandshakeError('protocol-incompatible'); throw error; }
    const workspace = workspaces.find((item) => item.workspaceId === pin.workspaceId && item.workspaceGeneration === pin.workspaceGeneration);
    if (!workspace) throw new RemoteHandshakeError('workspace-mismatch');
    live(); return { info, workspaces, workspace };
  }
  close(): void { this.closed = true; this.revision++; }
}
