import { createContext, useContext } from 'react';
import type { ConnectionProfile, DesktopConnectionApi, DesktopConnectionState } from '../../shared/contracts/connections';

/** The desktop's choice of execution host. One owner (the platform root) holds it. */
export interface ExecutionHost {
  readonly api: DesktopConnectionApi;
  /** Null until the saved selection is confirmed. Never treat null as local. */
  readonly state: DesktopConnectionState | null;
  readonly profiles: readonly ConnectionProfile[];
  readonly busy: boolean;
  readonly error: string | null;
  /** 'local' or the ID of a saved profile. */
  select(id: string): void;
  connect(): void;
  disconnect(): void;
  reloadProfiles(): Promise<void>;
}

export const ExecutionHostContext = createContext<ExecutionHost | null>(null);

/** Null in the browser client and in a desktop build without host connections. */
export function useExecutionHost(): ExecutionHost | null {
  return useContext(ExecutionHostContext);
}
