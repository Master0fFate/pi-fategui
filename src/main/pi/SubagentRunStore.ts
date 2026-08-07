import type { SubagentRun } from '../../shared/contracts/ipc';
import { boundSubagentRun, boundSubagentRuns } from '../../shared/subagents';
import { abortError } from './SubagentSessionFactory';
import { scheduleLongTimeout, type CancelableTimer } from './SubagentTimer';

function imageCharacters(run: SubagentRun | undefined): number {
  if (!run) return 0;
  return [...run.messages, ...run.tools]
    .reduce((total, item) => total + (item.images?.reduce((sum, image) => sum + image.data.length, 0) ?? 0), 0);
}

export class SubagentRunStore {
  private readonly runsByParent = new Map<string, Map<string, SubagentRun>>();
  private readonly changeListeners = new Map<string, Set<() => void>>();

  constructor(private readonly isTerminal: (run: SubagentRun) => boolean) {}

  parentIds(): string[] {
    return [...this.runsByParent.keys()];
  }

  getRuns(parentSessionId: string): SubagentRun[] {
    return boundSubagentRuns([...(this.runsByParent.get(parentSessionId)?.values() ?? [])]
      .sort((left, right) => left.createdAt - right.createdAt));
  }

  get(parentSessionId: string, runId: string): SubagentRun | undefined {
    return this.runsByParent.get(parentSessionId)?.get(runId);
  }

  runsForIds(parentSessionId: string, runIds: readonly string[]): SubagentRun[] {
    return runIds.map((runId) => {
      const run = this.get(parentSessionId, runId);
      if (!run) throw new Error(`Unknown child run ${runId} for this parent session.`);
      return boundSubagentRun(run);
    });
  }

  requireIds(parentSessionId: string, runIds: string[] | undefined): string[] {
    if (!runIds?.length) throw new Error('Provide at least one child run ID.');
    const ids = [...new Set(runIds)];
    this.runsForIds(parentSessionId, ids);
    return ids;
  }

  update(parentSessionId: string, runId: string, patch: Partial<SubagentRun>): SubagentRun {
    const existing = this.get(parentSessionId, runId);
    if (!existing) throw new Error(`Unknown subagent run: ${runId}`);
    this.store(boundSubagentRun({ ...existing, ...patch }));
    return this.get(parentSessionId, runId)!;
  }

  store(run: SubagentRun): void {
    let runs = this.runsByParent.get(run.parentSessionId);
    if (!runs) {
      runs = new Map();
      this.runsByParent.set(run.parentSessionId, runs);
    }
    const bounded = boundSubagentRun(run);
    const previousImageCharacters = imageCharacters(runs.get(run.id));
    runs.set(run.id, bounded);
    if (imageCharacters(bounded) !== previousImageCharacters) {
      for (const candidate of boundSubagentRuns([...runs.values()])) runs.set(candidate.id, candidate);
    }
    this.notify(run.parentSessionId);
  }

  replaceParent(parentSessionId: string, runs: readonly SubagentRun[]): void {
    if (runs.length) this.runsByParent.set(parentSessionId, new Map(boundSubagentRuns(runs).map((run) => [run.id, run])));
    else this.runsByParent.delete(parentSessionId);
    this.notify(parentSessionId);
  }

  async waitForRuns(
    parentSessionId: string,
    runIds: string[],
    until: 'any' | 'all' | 'activity',
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const baseline = new Map(this.runsForIds(parentSessionId, runIds).map((run) => [run.id, run.updatedAt]));
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const runs = this.runsForIds(parentSessionId, runIds);
      const complete = runs.map(this.isTerminal);
      if (complete.every(Boolean)) return;
      if (until === 'any' && complete.some(Boolean)) return;
      if (until === 'activity' && runs.some((run) => run.updatedAt > (baseline.get(run.id) ?? -Infinity))) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await this.nextChange(parentSessionId, remaining, signal);
    }
  }

  releaseParent(parentSessionId: string): void {
    this.runsByParent.delete(parentSessionId);
    this.changeListeners.delete(parentSessionId);
  }

  reset(): void {
    this.runsByParent.clear();
    this.changeListeners.clear();
  }

  private nextChange(parentSessionId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      let listeners = this.changeListeners.get(parentSessionId);
      if (!listeners) {
        listeners = new Set();
        this.changeListeners.set(parentSessionId, listeners);
      }
      let timer: CancelableTimer;
      const finish = () => {
        timer.cancel();
        signal?.removeEventListener('abort', abort);
        listeners!.delete(finish);
        resolve();
      };
      const abort = () => {
        timer.cancel();
        listeners!.delete(finish);
        reject(abortError());
      };
      timer = scheduleLongTimeout(finish, timeoutMs);
      listeners.add(finish);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private notify(parentSessionId: string): void {
    const listeners = this.changeListeners.get(parentSessionId);
    if (!listeners?.size) return;
    this.changeListeners.delete(parentSessionId);
    for (const listener of [...listeners]) listener();
  }
}
