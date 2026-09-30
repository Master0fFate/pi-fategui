import type { GoalMaxEvent } from '../../shared/contracts/goalmaxxing';
import type { PiEvent } from '../../shared/contracts/ipc';
import type { TaskEvent } from '../../shared/contracts/tasks';

export interface EventOrigin {
  readonly workspaceId: string;
  readonly workspaceGeneration: number;
  readonly sessionId: string | null;
}
export type ScopedDomainEvent =
  | { readonly kind: 'pi'; readonly origin: EventOrigin; readonly event: PiEvent }
  | { readonly kind: 'goal'; readonly origin: EventOrigin; readonly event: GoalMaxEvent }
  | { readonly kind: 'task'; readonly origin: EventOrigin; readonly event: TaskEvent };

/** Producer-side delivery; there is no focus lookup or cross-origin delta merge. */
export class ScopedDomainEvents {
  private readonly listeners = new Set<(event: ScopedDomainEvent) => void>();
  private failures = 0;

  get deliveryFailures(): number { return this.failures; }

  subscribe(listener: (event: ScopedDomainEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  publish(event: ScopedDomainEvent): void {
    // The legacy batcher mutates merged text deltas. Copy just those small
    // containers, not potentially large state/history snapshots.
    const stable = event.kind === 'pi' && (event.event.type === 'assistant.text' || event.event.type === 'assistant.reasoning')
      ? { ...event, event: { ...event.event } }
      : event.kind === 'pi' && event.event.type === 'subagent.event'
        ? { ...event, event: { ...event.event, event: { ...event.event.event } } }
        : event;
    for (const listener of this.listeners) {
      try { listener(stable); } catch { this.failures += 1; }
    }
  }
}
