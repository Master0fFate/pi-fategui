import type { PiEvent } from '../../shared/contracts/ipc';

export const MAX_BUFFERED_STREAM_EVENTS = 256;
export const MAX_BUFFERED_STREAM_CHARACTERS = 512_000;

export function streamPresentationDelay(root: HTMLElement = document.documentElement): number {
  if (root.dataset.holyShitMode === 'true') return 200;
  return root.dataset.performanceMode === 'true' || root.dataset.reduceMotion === 'true' ? 64 : 0;
}

function streamCharacters(event: PiEvent): number | null {
  if (event.type === 'assistant.text' || event.type === 'assistant.reasoning') return event.delta.length;
  if (event.type === 'tool.updated' && !event.provenance && !event.subagentRunIds) return event.output.length;
  if (event.type === 'subagent.event') {
    const child = event.event;
    if (child.type === 'assistant.text' || child.type === 'assistant.reasoning') return child.delta.length;
  }
  return null;
}

/** Only provisional presentation waits; lifecycle and control events drain it in order. */
export class RuntimeEventBuffer {
  private pending: Array<PiEvent | null> = [];
  private readonly pendingTools = new Map<string, number>();
  private characters = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly apply: (events: PiEvent[]) => void,
    private readonly delay = streamPresentationDelay,
    private readonly isKnownTool: (id: string) => boolean = () => false,
  ) {}

  enqueue(events: PiEvent[]): void {
    if (!events.length) return;
    const delay = this.delay();
    if (delay === 0 || events.some((event) => streamCharacters(event) === null)) {
      this.flush(events);
      return;
    }
    for (const event of events) {
      const last = this.pending.at(-1);
      if (last && (last.cursor !== undefined || event.cursor !== undefined)
        && (last.cursor === undefined || event.cursor === undefined || event.cursor <= last.cursor)) this.flush();
      const size = streamCharacters(event)!;
      if (event.type === 'tool.updated' && this.isKnownTool(event.toolCallId)) {
        const index = this.pendingTools.get(event.toolCallId);
        const previous = index === undefined ? null : this.pending[index];
        if (previous?.type === 'tool.updated'
          && ((previous.cursor === undefined && event.cursor === undefined)
            || (previous.cursor !== undefined && event.cursor !== undefined && event.cursor > previous.cursor))) {
          // Output is a replacement snapshot. Keep its newest position so cursors stay ordered.
          this.pending[index!] = null;
          this.characters -= previous.output.length;
        }
      }
      if (this.pending.length >= MAX_BUFFERED_STREAM_EVENTS || this.characters + size > MAX_BUFFERED_STREAM_CHARACTERS) this.flush();
      if (size >= MAX_BUFFERED_STREAM_CHARACTERS) {
        this.flush([event]);
        continue;
      }
      if (event.type === 'tool.updated' && this.isKnownTool(event.toolCallId)) this.pendingTools.set(event.toolCallId, this.pending.length);
      this.pending.push(event);
      this.characters += size;
    }
    if (this.pending.length) this.timer ??= setTimeout(() => this.flush(), delay);
  }

  clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
    this.pendingTools.clear();
    this.characters = 0;
  }

  private flush(tail: PiEvent[] = []): void {
    const events = this.pending.length ? this.pending.filter((event): event is PiEvent => event !== null).concat(tail) : tail;
    this.clear();
    if (events.length) this.apply(events);
  }
}
