import type { PiEvent } from '../../shared/contracts/ipc';

export interface PiEventBatcherOptions {
  intervalMs?: number;
  maxBatchSize?: number;
  maxBatchBytes?: number;
  maxDeltaLength?: number;
}

/** Batches high-frequency stream deltas while keeping both memory and IPC payloads bounded. */
export class PiEventBatcher {
  private readonly intervalMs: number;
  private readonly maxBatchSize: number;
  private readonly maxBatchBytes: number;
  private readonly maxDeltaLength: number;
  private pending: PiEvent[] = [];
  private pendingBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly emit: (events: PiEvent[]) => void, options: PiEventBatcherOptions = {}) {
    this.intervalMs = Math.max(1, options.intervalMs ?? 32);
    this.maxBatchSize = Math.min(100, Math.max(1, options.maxBatchSize ?? 100));
    this.maxBatchBytes = Math.max(64_000, options.maxBatchBytes ?? 256_000);
    this.maxDeltaLength = Math.max(256, options.maxDeltaLength ?? 32_000);
  }

  enqueue(event: PiEvent): void {
    if (this.disposed) return;
    if (this.mergeDelta(event)) {
      if (this.pendingBytes >= this.maxBatchBytes) this.flush();
      else this.schedule();
      return;
    }

    const eventBytes = this.measure(event);
    if (this.pending.length > 0 && this.pendingBytes + eventBytes > this.maxBatchBytes) this.flush();
    this.pending.push(event);
    this.pendingBytes += eventBytes;
    if (this.pending.length >= this.maxBatchSize || this.pendingBytes >= this.maxBatchBytes) this.flush();
    else this.schedule();
  }

  enqueueMany(events: readonly PiEvent[]): void {
    for (const event of events) this.enqueue(event);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    while (this.pending.length > 0) {
      const batch: PiEvent[] = [];
      let batchBytes = 0;
      while (this.pending.length > 0 && batch.length < this.maxBatchSize) {
        const next = this.pending[0]!;
        const nextBytes = this.measure(next);
        if (batch.length > 0 && batchBytes + nextBytes > this.maxBatchBytes) break;
        batch.push(this.pending.shift()!);
        batchBytes += nextBytes;
        this.pendingBytes -= nextBytes;
      }
      this.emit(batch);
    }
    this.pendingBytes = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.flush();
    this.disposed = true;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.intervalMs);
  }

  private mergeDelta(event: PiEvent): boolean {
    if (event.type !== 'assistant.text' && event.type !== 'assistant.reasoning') return false;
    const previous = this.pending.at(-1);
    if (!previous || previous.type !== event.type || previous.messageId !== event.messageId) return false;
    if (previous.delta.length + event.delta.length > this.maxDeltaLength) return false;
    const before = this.measure(previous);
    previous.delta += event.delta;
    previous.timestamp = event.timestamp;
    this.pendingBytes += this.measure(previous) - before;
    return true;
  }

  private measure(event: PiEvent): number {
    return Buffer.byteLength(JSON.stringify(event), 'utf8');
  }
}
