import { describe, expect, it } from 'vitest';
import { ScopedDomainEvents } from '../../src/core/events/ScopedDomainEvents';
import { WorkspaceEventHub } from '../../src/core/events/WorkspaceEventHub';
import { WorkspaceSnapshotService } from '../../src/core/views/WorkspaceSnapshotService';
import { EventReplayGate, EVENT_RING_BYTES } from '../../src/shared/protocol/events';
import { PiEventBatcher } from '../../src/main/pi/PiEventBatcher';
import type { RuntimeState } from '../../src/shared/contracts/ipc';

const scope = { principalId: 'alice', clientId: 'tab', workspaceId: 'w1', workspaceGeneration: 2, serverEpoch: 'epoch', sessionId: 's1', projectPath: '/project' };
const state = (): RuntimeState => ({ status: 'ready', project: { path: '/project', name: 'Project', trusted: true }, sessionId: 's1', sessionFile: null,
  streaming: true, model: null, models: [], thinkingLevel: 'high', permissionLevel: 'edit', messages: [], tools: [], sessions: [], error: null });
const pi = (workspaceId: string, cursor: number, text = 'x', sessionId: string | null = 's1') => ({ kind: 'pi' as const,
  origin: { workspaceId, workspaceGeneration: 2, sessionId },
  event: { type: 'assistant.text' as const, messageId: 'm', delta: text, timestamp: cursor, cursor } });
const setup = (limits?: { ringCount?: number; ringBytes?: number; unsentCount?: number; unsentBytes?: number }) => {
  const source = new ScopedDomainEvents();
  const hub = new WorkspaceEventHub(source, 'epoch', limits);
  return { source, hub };
};

describe('ordered workspace event replay', () => {
  it('registers before flush, captures high-water with immutable pages, and delivers during/after deltas once', () => {
    const { source, hub } = setup();
    const live = state();
    let afterCopy: (() => void) | undefined;
    let emitted = false;
    const snapshots = new WorkspaceSnapshotService(() => { if (live.messages.length === 0) { source.publish(pi('w1', 4, 'before')); live.messages.push({ id: 'm', role: 'assistant', text: 'before', timestamp: 4, timelinePosition: 1 }); } },
      () => { afterCopy = () => { live.messages[0]!.text += 'during'; source.publish(pi('w1', 7, 'during')); }; return { state: live, goal: null, tasks: [] }; },
      () => { if (!emitted) { emitted = true; afterCopy?.(); } return 100; });
    source.publish(pi('w1', 1, 'old'));
    const joined = hub.subscribeAndSnapshot(scope, snapshots);
    expect(joined.snapshot.header?.eventStream).toMatchObject({ sequence: 3, streamId: expect.any(String) });
    expect(joined.snapshot.items[0]?.text).toBe('beforeduring');
    source.publish(pi('w1', 8, 'after'));
    expect(joined.subscription.drain().map((event) => event.sequence)).toEqual([4]);
    expect(joined.subscription.drain()).toEqual([]);
    live.messages[0]!.text = 'changed after capture';
    expect(snapshots.page(scope, joined.snapshot.pageId)).toEqual(joined.snapshot);
    joined.subscription.close(); hub.dispose();
  });

  it('replays a cursor once without invoking command/runtime mutations and ignores Pi cursor jumps', () => {
    const { source, hub } = setup();
    source.publish(pi('w1', 1));
    const cursor = hub.position(scope);
    source.publish(pi('w1', 9, 'merged')); // The Pi batcher can advance its own cursor more than one.
    const replay = hub.subscribe(scope, cursor);
    const [merged] = replay.drain();
    expect(merged).toMatchObject({ sequence: 2, event: { event: { cursor: 9, delta: 'merged' } } });
    const gate = new EventReplayGate(cursor);
    expect(gate.accept(merged!)).toEqual(merged);
    expect(gate.accept(merged!)).toBeNull(); // An uncertain delivery may repeat an envelope.
    expect(replay.drain()).toEqual([]);
    source.publish(pi('w1', 10));
    const [next] = replay.drain();
    expect(gate.accept(next!)).toEqual(next);
    expect(() => gate.accept({ ...next!, sequence: 5 })).toThrow('RESYNC_REQUIRED');
    expect(() => gate.accept({ ...next!, serverEpoch: 'foreign' })).toThrow('RESYNC_REQUIRED');
    expect(() => gate.accept({ ...next!, event: { ...next!.event, origin: { ...next!.event.origin, sessionId: 'foreign' } } })).toThrow();
    replay.close(); hub.dispose();
  });

  it('keeps background workspace and session origins separate, with independent stream sequences', () => {
    const { source, hub } = setup();
    source.publish(pi('w2', 1, 'background', 'other'));
    source.publish(pi('w1', 2, 'foreground'));
    expect(hub.subscribe(scope).drain()).toMatchObject([{ sequence: 1, origin: { workspaceId: 'w1', sessionId: 's1' } }]);
    expect(hub.subscribe({ ...scope, workspaceId: 'w2', sessionId: 'other' }).drain()).toMatchObject([
      { sequence: 1, origin: { workspaceId: 'w2', sessionId: 'other' } },
    ]);
    hub.dispose();
  });

  it('requires resync for stale/foreign/expired cursors, and resets on replacement or restart', () => {
    const { source, hub } = setup({ ringCount: 2 });
    source.publish(pi('w1', 1)); const old = hub.position(scope);
    source.publish(pi('w1', 2)); source.publish(pi('w1', 3)); source.publish(pi('w1', 4));
    expect(() => hub.subscribe(scope, old)).toThrow('RESYNC_REQUIRED');
    expect(() => hub.subscribe(scope, { ...hub.position(scope), serverEpoch: 'old' })).toThrow('RESYNC_REQUIRED');
    const current = hub.position(scope);
    expect(() => new WorkspaceEventHub(source, 'different').subscribe(scope, current)).toThrow('RESYNC_REQUIRED');
    source.publish({ ...pi('w1', 5), origin: { ...pi('w1', 5).origin, workspaceGeneration: 3 } });
    expect(() => hub.subscribe(scope, current)).toThrow('RESYNC_REQUIRED');
    expect(hub.position({ ...scope, workspaceGeneration: 3 }).sequence).toBe(1);
    hub.dispose();
  });

  it('assigns one network sequence to a real merged Pi batch while preserving its last Pi cursor', () => {
    const { source, hub } = setup();
    const batcher = new PiEventBatcher((events) => events.forEach((event) => source.publish({ kind: 'pi', origin: pi('w1', 1).origin, event })));
    batcher.enqueue(pi('w1', 1, 'a').event);
    batcher.enqueue(pi('w1', 2, 'b').event);
    batcher.flush();
    const [merged] = hub.subscribe(scope).drain();
    expect(merged).toMatchObject({ sequence: 1, event: { event: { delta: 'ab', cursor: 2 } } });
    expect(new EventReplayGate({ ...hub.position(scope), sequence: 0 }).accept(merged!)).toEqual(merged);
    batcher.dispose(); hub.dispose();
  });

  it('bounds ring and unsent bytes/count; aborts overflowing capture and frees slow subscribers', () => {
    const { source, hub } = setup({ ringCount: 2, ringBytes: 900, unsentCount: 1, unsentBytes: 900 });
    const slow = hub.subscribe(scope);
    source.publish(pi('w1', 1)); source.publish(pi('w1', 2));
    expect(() => slow.drain()).toThrow('RESYNC_REQUIRED');
    expect(hub.subscriberCount).toBe(0);
    const snapshot = new WorkspaceSnapshotService(() => { source.publish(pi('w1', 3)); source.publish(pi('w1', 4)); },
      () => ({ state: state(), goal: null, tasks: [] }));
    expect(() => hub.subscribeAndSnapshot(scope, snapshot)).toThrow('RESYNC_REQUIRED');
    expect(hub.subscriberCount).toBe(0);
    const unavailable = new WorkspaceSnapshotService(() => undefined,
      () => ({ state: state(), goal: null, tasks: [], tasksReady: false }));
    expect(() => hub.subscribeAndSnapshot(scope, unavailable)).toThrow('SNAPSHOT_NOT_READY');
    expect(hub.subscriberCount).toBe(0);
    expect(hub.retained(scope).count).toBeLessThanOrEqual(2);
    expect(hub.retained(scope).bytes).toBeLessThanOrEqual(900);
    const during = new WorkspaceSnapshotService(() => undefined, () => ({ state: state(), goal: null, tasks: [] }),
      () => { source.publish(pi('w1', 5)); source.publish(pi('w1', 6)); return 100; });
    expect(() => hub.subscribeAndSnapshot(scope, during)).toThrow('RESYNC_REQUIRED');
    expect(hub.subscriberCount).toBe(0);
    hub.dispose();
  });

  it('prunes whole UTF-8 envelopes by bytes and invalidates oversized frames without silent loss', () => {
    const { source, hub } = setup({ ringBytes: 600, unsentBytes: 600 });
    source.publish(pi('w1', 1, '😀'.repeat(30)));
    const first = hub.position(scope);
    source.publish(pi('w1', 2, '😀'.repeat(30)));
    expect(hub.retained(scope).bytes).toBeLessThanOrEqual(600);
    expect(hub.retained(scope).count).toBe(1);
    expect(() => hub.subscribe(scope, { ...first, sequence: 0 })).toThrow('RESYNC_REQUIRED');
    const subscription = hub.subscribe(scope, first);
    source.publish(pi('w1', 3, '😀'.repeat(1000)));
    expect(() => subscription.drain()).toThrow('RESYNC_REQUIRED');
    expect(hub.position(scope).streamId).not.toBe(first.streamId);
    expect(hub.retained(scope).bytes).toBeLessThanOrEqual(EVENT_RING_BYTES);
    hub.dispose();
  });
});
