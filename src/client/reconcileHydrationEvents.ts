import type { PiEvent, RuntimeState } from '../shared/contracts/ipc';

export function reconcileHydrationEvents(runtime: RuntimeState, events: readonly PiEvent[]): PiEvent[] {
  return reconcileHydrationEventEntries(runtime, events).map(({ event }) => event);
}

/** Preserve source indexes so a network envelope can advance independently of a Pi gap. */
export function reconcileHydrationEventEntries(runtime: RuntimeState, events: readonly PiEvent[]): Array<{ index: number; event: PiEvent }> {
  const watermark = runtime.eventCursor;
  if (watermark === undefined) return events.map((event, index) => ({ event, index }));
  const messages = new Map(runtime.messages.map((message) => [message.id, message]));
  const tools = new Map((runtime.tools ?? []).map((tool) => [tool.id, tool]));
  const representedDeltaIndexes = new Set<number>();
  const completedMessageIds = new Set(events.flatMap((event) =>
    event.type === 'message.completed'
      && event.cursor !== undefined
      && event.cursor <= watermark
      && messages.has(event.messageId)
      ? [event.messageId]
      : [],
  ));

  for (const kind of ['assistant.text', 'assistant.reasoning'] as const) {
    const groups = new Map<string, Array<{ event: Extract<PiEvent, { type: typeof kind }>; index: number }>>();
    events.forEach((event, index) => {
      if (event.type !== kind || event.cursor === undefined || event.cursor > watermark) return;
      const group = groups.get(event.messageId) ?? [];
      group.push({ event, index });
      groups.set(event.messageId, group);
    });
    for (const [messageId, group] of groups) {
      if (completedMessageIds.has(messageId)) {
        for (const item of group) representedDeltaIndexes.add(item.index);
        continue;
      }
      const message = messages.get(messageId);
      const snapshot = kind === 'assistant.text' ? message?.text ?? '' : message?.reasoning ?? '';
      let combined = '';
      let representedCount = 0;
      group.forEach(({ event }, index) => {
        combined += event.delta;
        if (snapshot.endsWith(combined)) representedCount = index + 1;
      });
      for (let index = 0; index < representedCount; index += 1) representedDeltaIndexes.add(group[index]!.index);
    }
  }

  const keep = (event: PiEvent, index: number): boolean => {
    if (event.cursor === undefined || event.cursor > watermark) return true;
    if (representedDeltaIndexes.has(index)) return false;
    if (event.type === 'assistant.text' || event.type === 'assistant.reasoning') return true;
    if (event.type === 'message.started' || event.type === 'message.completed') return !messages.has(event.messageId);
    if (event.type === 'tool.started') return !tools.has(event.toolCallId);
    if (event.type === 'tool.updated') {
      const tool = tools.get(event.toolCallId);
      if (tool && tool.status !== 'running') return false;
      return !tool || (!tool.output.endsWith(event.output) && tool.output !== event.output);
    }
    if (event.type === 'tool.completed') return tools.get(event.toolCallId)?.status === 'running' || !tools.has(event.toolCallId);
    if (event.type === 'state.changed' || event.type === 'run.accepted' || event.type === 'run.started' || event.type === 'run.completed') return false;
    // Queue, compaction, and error events own renderer-only presentation state
    // that is not fully represented by RuntimeState.
    return true;
  };
  return events.flatMap((event, index) => {
    if (!keep(event, index)) return [];
    if (event.cursor === undefined || event.cursor > watermark) return [{ index, event }];
    // This pre-watermark event is not represented by the authoritative snapshot.
    // Replay the gap as uncursored; the store still rejects cursor regressions.
    const { cursor: _representedCursor, ...gap } = event;
    return [{ index, event: gap as PiEvent }];
  });
}
