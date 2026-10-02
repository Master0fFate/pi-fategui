/** Admission memory for an explicitly reviewed UNKNOWN profile. This does not
 * authorize a tool, grant permission, resolve old outcomes or revive old IDs. */
export class RecoveredExecutionPolicy {
  private readonly fresh = new Map<string, { project: number; session: number }>();
  constructor(readonly requiresFreshIntent: boolean) {}

  allowsAutomaticContinuation(sessionId: string, generation: number, sessionGeneration = 0): boolean {
    const admitted = this.fresh.get(sessionId);
    return !this.requiresFreshIntent || admitted?.project === generation && admitted.session === sessionGeneration;
  }

  /** Call only after a new explicit user request passes the real admission gate.
   * Restored drafts, child notifications, timers and old task receipts never call it. */
  recordExplicitIntent(sessionId: string, generation: number, sessionGeneration = 0): void {
    if (!sessionId || !Number.isSafeInteger(generation) || generation < 0 || !Number.isSafeInteger(sessionGeneration) || sessionGeneration < 0) throw new Error('Invalid recovered execution identity.');
    if (!this.requiresFreshIntent) return;
    this.fresh.delete(sessionId);
    this.fresh.set(sessionId, { project: generation, session: sessionGeneration });
    // Eviction closes admission; it cannot grant it to another session.
    while (this.fresh.size > 1024) this.fresh.delete(this.fresh.keys().next().value!);
  }

  forget(sessionId: string): void { this.fresh.delete(sessionId); }
  clear(): void { this.fresh.clear(); }
}
