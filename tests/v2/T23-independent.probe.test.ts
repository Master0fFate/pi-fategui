import { describe, expect, it } from 'vitest';
import { ScopedDomainEvents } from '../../src/core/events/ScopedDomainEvents';
import { WorkspaceEventHub } from '../../src/core/events/WorkspaceEventHub';
import { WorkspaceSnapshotService } from '../../src/core/views/WorkspaceSnapshotService';
import type { SnapshotPage, SnapshotScope } from '../../src/shared/protocol/snapshots';
import type { EventCursor } from '../../src/shared/protocol/events';
import type { RuntimeState } from '../../src/shared/contracts/ipc';

const scope = { principalId: 'alice', clientId: 'tab', workspaceId: 'w1', workspaceGeneration: 2, serverEpoch: 'epoch', sessionId: 's1', projectPath: '/project' };
const empty = (): RuntimeState => ({ status: 'ready', project: { path: '/project', name: 'Project', trusted: true }, sessionId: 's1', sessionFile: null,
  streaming: true, model: null, models: [], thinkingLevel: 'high', permissionLevel: 'edit', messages: [], tools: [], sessions: [], error: null });

describe('T23 independent snapshot boundary probe', () => {
  it('does not discard a delta emitted by a reentrant view getter after its state copy', () => {
    const source = new ScopedDomainEvents();
    const hub = new WorkspaceEventHub(source, 'epoch');
    const live = empty();
    let emitted = false;
    const snapshots = new WorkspaceSnapshotService(() => undefined, () => {
      const alreadyCopied = { ...live, messages: [...live.messages] };
      if (!emitted) {
        emitted = true;
        live.messages.push({ id: 'm', role: 'assistant', text: 'during', timestamp: 1, timelinePosition: 1 });
        source.publish({ kind: 'pi', origin: { workspaceId: 'w1', workspaceGeneration: 2, sessionId: 's1' },
          event: { type: 'assistant.text', messageId: 'm', delta: 'during', timestamp: 1, cursor: 1 } });
      }
      return { state: alreadyCopied, goal: null, tasks: [] };
    });
    const { snapshot, subscription } = hub.subscribeAndSnapshot(scope, snapshots);
    const snapshotRows = snapshot.items.filter((item) => item.text === 'during');
    const replayRows = subscription.drain().filter((item) => item.event.kind === 'pi' && item.event.event.type === 'assistant.text' && item.event.event.delta === 'during');
    expect(snapshotRows.length + replayRows.length).toBe(1);
    subscription.close(); hub.dispose();
  });
  it('does not count an event both in the snapshot and in replay after high-water', () => {
    const source = new ScopedDomainEvents();
    const hub = new WorkspaceEventHub(source, 'epoch');
    const live = empty();
    let emitted = false;
    const snapshots = new WorkspaceSnapshotService(() => undefined, () => ({ state: live, goal: null, tasks: [] }), () => {
      if (!emitted) {
        emitted = true;
        live.messages.push({ id: 'm', role: 'assistant', text: 'during', timestamp: 1, timelinePosition: 1 });
        source.publish({ kind: 'pi', origin: { workspaceId: 'w1', workspaceGeneration: 2, sessionId: 's1' },
          event: { type: 'assistant.text', messageId: 'm', delta: 'during', timestamp: 1, cursor: 1 } });
      }
      return 100;
    });
    const { snapshot, subscription } = hub.subscribeAndSnapshot(scope, snapshots);
    const snapshotRows = snapshot.items.filter((item) => item.text === 'during');
    const replayRows = subscription.drain().filter((item) => item.event.kind === 'pi' && item.event.event.type === 'assistant.text' && item.event.event.delta === 'during');
    expect(snapshotRows.length + replayRows.length).toBe(1);
    subscription.close(); hub.dispose();
  });

  it('fails closed after bounded reentry rather than publishing a mixed view', () => {
    const source = new ScopedDomainEvents();
    const hub = new WorkspaceEventHub(source, 'epoch');
    let attempts = 0;
    const snapshots = new WorkspaceSnapshotService(() => undefined, () => {
      attempts++;
      source.publish({ kind: 'pi', origin: { workspaceId: 'w1', workspaceGeneration: 2, sessionId: 's1' },
        event: { type: 'assistant.text', messageId: 'm', delta: 'during', timestamp: attempts, cursor: attempts } });
      return { state: empty(), goal: null, tasks: [] };
    });
    expect(() => hub.subscribeAndSnapshot(scope, snapshots)).toThrow('RESYNC_REQUIRED');
    expect(attempts).toBe(3);
    expect(hub.subscriberCount).toBe(0);
    hub.dispose();
  });

  it('cancels a completed snapshot if a prior retry filled its subscriber buffer', () => {
    const source = new ScopedDomainEvents();
    const hub = new WorkspaceEventHub(source, 'epoch', { unsentCount: 1 });
    const live = empty();
    let emitted = false;
    class TrackedSnapshots extends WorkspaceSnapshotService {
      last: SnapshotPage | undefined;
      override capture(input: SnapshotScope, highWater?: () => EventCursor): SnapshotPage {
        this.last = super.capture(input, highWater);
        return this.last;
      }
    }
    const snapshots = new TrackedSnapshots(() => undefined, () => ({ state: live, goal: null, tasks: [] }), () => {
      if (!emitted) {
        emitted = true;
        for (let cursor = 1; cursor <= 2; cursor++) {
          live.messages.push({ id: `m${cursor}`, role: 'assistant', text: `during${cursor}`, timestamp: cursor, timelinePosition: cursor });
          source.publish({ kind: 'pi', origin: { workspaceId: 'w1', workspaceGeneration: 2, sessionId: 's1' },
            event: { type: 'assistant.text', messageId: `m${cursor}`, delta: `during${cursor}`, timestamp: cursor, cursor } });
        }
      }
      return 100;
    });
    expect(() => hub.subscribeAndSnapshot(scope, snapshots)).toThrow('RESYNC_REQUIRED');
    expect(snapshots.last).toBeDefined(); // The retry produced a valid page, but subscriber overflow invalidated it.
    expect(() => snapshots.page(scope, snapshots.last!.pageId)).toThrow('RESYNC_REQUIRED');
    expect(hub.subscriberCount).toBe(0);
    hub.dispose();
  });
});
