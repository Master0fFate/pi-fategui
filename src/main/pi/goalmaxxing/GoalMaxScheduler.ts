export interface GoalMaxScheduleRequest {
  goalId: string;
  expectedRevision: number;
  reason: string;
}

type PendingSchedule = {
  request: GoalMaxScheduleRequest;
  run: (request: GoalMaxScheduleRequest) => Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
};

/** Coalesces lifecycle triggers and grants at most one continuation lease per goal. */
export class GoalMaxScheduler {
  private readonly pending = new Map<string, PendingSchedule>();
  private readonly leases = new Set<string>();

  schedule(request: GoalMaxScheduleRequest, run: (request: GoalMaxScheduleRequest) => Promise<void>): boolean {
    const existing = this.pending.get(request.goalId);
    if (existing && existing.request.expectedRevision >= request.expectedRevision) return false;
    if (existing?.timer) clearTimeout(existing.timer);
    const pending: PendingSchedule = { request, run, timer: null };
    this.pending.set(request.goalId, pending);
    if (!this.leases.has(request.goalId)) this.arm(request.goalId, pending);
    return true;
  }

  cancel(goalId: string): void {
    const pending = this.pending.get(goalId);
    if (pending?.timer) clearTimeout(pending.timer);
    this.pending.delete(goalId);
  }

  dispose(): void {
    for (const pending of this.pending.values()) if (pending.timer) clearTimeout(pending.timer);
    this.pending.clear();
    this.leases.clear();
  }

  private arm(goalId: string, pending: PendingSchedule): void {
    const timer = setTimeout(() => {
      const current = this.pending.get(goalId);
      if (!current || current !== pending || current.timer !== timer) return;
      current.timer = null;
      void this.drain(goalId, current);
    }, 0);
    timer.unref?.();
    pending.timer = timer;
  }

  private async drain(goalId: string, pending: PendingSchedule): Promise<void> {
    if (this.leases.has(goalId) || this.pending.get(goalId) !== pending) return;
    this.pending.delete(goalId);
    this.leases.add(goalId);
    try {
      await pending.run(pending.request);
    } catch {
      // The coordinator persists actionable failures. Scheduler callbacks must
      // never surface as unhandled process rejections.
    } finally {
      this.leases.delete(goalId);
      const next = this.pending.get(goalId);
      if (next && !next.timer) this.arm(goalId, next);
    }
  }
}
