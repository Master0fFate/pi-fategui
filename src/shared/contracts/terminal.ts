import type { PiDesktopApi } from './ipc';

/** Presentation-only terminal port. Native IPC and the opt-in browser transport
 * implement the same ordered data/consumption contract, not a generic RPC tunnel. */
export type ManualTerminalApi = Pick<PiDesktopApi,
  | 'createTerminal' | 'writeTerminal' | 'acknowledgeTerminal'
  | 'resizeTerminal' | 'closeTerminal' | 'onTerminalEvent'>;

export const MANUAL_TERMINAL_WARNING = 'This manual terminal runs an unsandboxed shell on the execution host, with that host account’s authority. Agent Edit permission does not limit shell commands.';
