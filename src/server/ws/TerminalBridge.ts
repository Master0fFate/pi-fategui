import type { RequestContext } from '../../core/dispatch/RequestContext';
import type { WorkspaceRegistry } from '../../core/workspaces/WorkspaceRegistry';
import type { WorkspaceControl } from '../../core/security/WorkspaceControl';
import { TerminalOwner } from '../../core/terminal/TerminalOwner';
import type { PermissionLevel } from '../../shared/contracts/ipc';
import { terminalClientFrameSchema } from '../../shared/protocol/terminal';

/** A terminal is a manual, unsandboxed host shell. This bridge is created only
 * for an explicitly enabled host profile; a frame never enables the feature. */
export function createTerminalBridge(options: {
  registry: WorkspaceRegistry;
  control: WorkspaceControl;
  permission: (identity: RequestContext, workspaceId: string) => PermissionLevel;
  resolveShell: (root: string) => string;
  /** Trusted in-process composition port; never read from config or a client frame. */
  loadPty?: () => Promise<typeof import('node-pty')>;
}) {
  const sends = new Map<string, { identity: RequestContext; send: (value: unknown) => void }>();
  const terminal = new TerminalOwner({ enabled: true, registry: options.registry, control: options.control,
    permission: options.permission, resolveShell: options.resolveShell,
    loadPty: options.loadPty ?? (() => import('node-pty')),
    send: (identity, event) => {
      const target = sends.get(identity.clientId);
      if (!target || target.identity !== identity) throw new Error('Terminal recipient disconnected.');
      target.send({ protocol: 1, type: 'terminal.event', event });
    } });
  return {
    async onFrame(identity: RequestContext, frame: unknown, send: (value: unknown) => void): Promise<void> {
      const parsed = terminalClientFrameSchema.parse(frame);
      const existing = sends.get(identity.clientId);
      if (existing && existing.identity !== identity) throw new Error('Terminal owner identity changed.');
      sends.set(identity.clientId, { identity, send });
      switch (parsed.type) {
        case 'terminal.create': {
          const result = await terminal.create(identity, parsed.workspaceId, parsed.workspaceGeneration,
            parsed.controlGeneration, parsed.cols, parsed.rows);
          send({ protocol: 1, type: 'terminal.created', result });
          return;
        }
        case 'terminal.write': terminal.write(identity, parsed.id, parsed.data); return;
        case 'terminal.resize': terminal.resize(identity, parsed.id, parsed.cols, parsed.rows); return;
        case 'terminal.ack': terminal.acknowledge(identity, parsed.id, parsed.sequence, parsed.characters); return;
        case 'terminal.close': terminal.close(identity, parsed.id); return;
      }
    },
    onDisconnect(connectionId: string): void {
      const entry = sends.get(connectionId);
      if (entry) { sends.delete(connectionId); terminal.disconnect(entry.identity); }
    },
    close(): Promise<void> { sends.clear(); return terminal.dispose(); },
  };
}
