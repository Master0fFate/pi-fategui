import type { PermissionLevel } from '../../../shared/contracts/ipc';
import type { AgentTeamLimits } from '../../../shared/contracts/multiAgent';

export interface TurnLease {
  nodeId: string;
  writer: boolean;
  release(): void;
}

export class AgentTeamScheduler {
  private readonly active = new Map<string, boolean>();
  private writerNodeId: string | null = null;

  constructor(readonly limits: AgentTeamLimits) {}

  get activeTurns(): number { return this.active.size; }
  get writer(): string | null { return this.writerNodeId; }

  acquire(nodeId: string, permissionLevel: PermissionLevel): TurnLease {
    if (this.active.has(nodeId)) throw new Error(`Agent ${nodeId} already has an active turn.`);
    if (this.active.size >= this.limits.maxActiveTurns) {
      throw new Error(`Agent team capacity is full (${this.limits.maxActiveTurns} active non-root turns). Wait for an agent to settle and retry.`);
    }
    const writer = permissionLevel !== 'read-only';
    if (writer && this.writerNodeId) {
      throw new Error(`Agent team writer lease is held by ${this.writerNodeId}. Wait for that turn to settle before starting another writer.`);
    }
    this.active.set(nodeId, writer);
    if (writer) this.writerNodeId = nodeId;
    let released = false;
    return {
      nodeId,
      writer,
      release: () => {
        if (released) return;
        released = true;
        this.active.delete(nodeId);
        if (this.writerNodeId === nodeId) this.writerNodeId = null;
      },
    };
  }

  restoreInterrupted(): void {
    this.active.clear();
    this.writerNodeId = null;
  }
}
