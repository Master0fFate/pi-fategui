import type { PermissionLevel } from '../shared/contracts/ipc';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'authenticating' | 'synchronizing' | 'observing' | 'controlling' | 'reconnecting' | 'incompatible' | 'error';
export interface ConnectionView {
  readonly status: ConnectionStatus;
  readonly generation: number;
  readonly hostId: string | null;
  readonly hostName: string | null;
  readonly workspaceName: string | null;
  readonly serverEpoch: string | null;
  readonly control: 'observing' | 'controlling' | null;
  readonly permissionLevel: PermissionLevel | null;
  readonly lastConfirmedAt: number | null;
  readonly lastConfirmedStatus: 'running' | 'stopped' | 'unknown';
  readonly message: string | null;
}

/** The last known run status is evidence, not a claim that a disconnected run stopped. */
export class ConnectionState {
  private value: ConnectionView = { status: 'disconnected', generation: 0, hostId: null, hostName: null,
    workspaceName: null, serverEpoch: null, control: null, permissionLevel: null,
    lastConfirmedAt: null, lastConfirmedStatus: 'unknown', message: null };
  get current(): ConnectionView { return this.value; }
  begin(hostId: string, hostName: string, workspaceName: string, retry: boolean): number {
    this.value = { ...this.value, generation: this.value.generation + 1, status: retry ? 'reconnecting' : 'connecting',
      hostId, hostName, workspaceName, serverEpoch: null, control: null, permissionLevel: null, message: null };
    return this.value.generation;
  }
  change(generation: number, status: ConnectionStatus, fields: Partial<Omit<ConnectionView, 'generation' | 'status'>> = {}): void {
    if (generation !== this.value.generation) return;
    this.value = { ...this.value, ...fields, status };
  }
  confirmed(generation: number, serverEpoch: string, control: 'observing' | 'controlling', permissionLevel: PermissionLevel,
    running: boolean, at: number): void {
    this.change(generation, control, { serverEpoch, control, permissionLevel, lastConfirmedAt: at,
      lastConfirmedStatus: running ? 'running' : 'stopped', message: null });
  }
  replaceView(): void {
    this.disconnect();
    this.value = { ...this.value, hostId: null, hostName: null, workspaceName: null, serverEpoch: null,
      lastConfirmedAt: null, lastConfirmedStatus: 'unknown', message: null };
  }
  disconnect(message: string | null = null): void {
    this.value = { ...this.value, generation: this.value.generation + 1, status: 'disconnected',
      control: null, permissionLevel: null, message };
  }
}
