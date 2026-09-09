import type { PermissionLevel } from '../../../shared/contracts/ipc';
import type { AgentTeamLimits } from '../../../shared/contracts/multiAgent';

export interface TurnLease {
  nodeId: string;
  writer: boolean;
  release(): void;
}

export class AgentTeamScheduler {
  private readonly active = new Map<string, { writer: boolean; workspaceKey: string }>();
  private readonly writerNodeIdsByWorkspace = new Map<string, string>();

  constructor(readonly limits: AgentTeamLimits) {}

  get activeTurns(): number { return this.active.size; }
  /** Legacy single-writer projection for UI state; actual exclusivity is per checkout. */
  get writer(): string | null { return this.writerNodeIdsByWorkspace.values().next().value ?? null; }

  acquire(nodeId: string, permissionLevel: PermissionLevel, workspaceKey = 'legacy'): TurnLease {
    if (this.active.has(nodeId)) throw new Error(`Agent ${nodeId} already has an active turn.`);
    if (this.active.size >= this.limits.maxActiveTurns) {
      throw new Error(`Agent team capacity is full (${this.limits.maxActiveTurns} active non-root turns). Wait for an agent to settle and retry.`);
    }
    const writer = permissionLevel !== 'read-only';
    const existingWriter = this.writerNodeIdsByWorkspace.get(workspaceKey);
    if (writer && existingWriter) {
      throw new Error(`Agent team writer lease for checkout ${workspaceKey} is held by ${existingWriter}. Wait for that turn to settle before starting another writer.`);
    }
    this.active.set(nodeId, { writer, workspaceKey });
    if (writer) this.writerNodeIdsByWorkspace.set(workspaceKey, nodeId);
    let released = false;
    return {
      nodeId,
      writer,
      release: () => {
        if (released) return;
        released = true;
        this.active.delete(nodeId);
        if (this.writerNodeIdsByWorkspace.get(workspaceKey) === nodeId) this.writerNodeIdsByWorkspace.delete(workspaceKey);
      },
    };
  }

  restoreInterrupted(): void {
    this.active.clear();
    this.writerNodeIdsByWorkspace.clear();
  }
}
