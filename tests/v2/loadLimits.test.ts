import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { ScopedDomainEvents } from '../../src/core/events/ScopedDomainEvents';
import { WorkspaceEventHub } from '../../src/core/events/WorkspaceEventHub';
import { WorkspaceSnapshotService } from '../../src/core/views/WorkspaceSnapshotService';
import { EVENT_RING_BYTES, EVENT_RING_COUNT, EVENT_UNSENT_BYTES, EVENT_UNSENT_COUNT } from '../../src/shared/protocol/events';
import { SNAPSHOT_PAGE_BYTES, SNAPSHOT_TOTAL_BYTES } from '../../src/shared/protocol/snapshots';
import { buildMonitorDashboard } from '../../src/main/pi/monitor/MonitorDashboard';
import type { RuntimeState } from '../../src/shared/contracts/ipc';
import { agentRunSchema } from '../../src/shared/contracts/agents';

const SEED = 0x46415445;
const scope = (index: number) => ({ principalId: `principal-${index}`, clientId: `client-${index}`, workspaceId: `workspace-${index}`,
  workspaceGeneration: 1, serverEpoch: 'load-fixture', sessionId: `session-${index}`, projectPath: `/synthetic/project-${index}` });
function generator() {
  let value = SEED;
  return () => { value = (Math.imul(1664525, value) + 1013904223) >>> 0; return value; };
}
function event(index: number, cursor: number, delta: string) {
  return { kind: 'pi' as const, origin: { workspaceId: scope(index).workspaceId, workspaceGeneration: 1, sessionId: scope(index).sessionId },
    event: { type: 'assistant.text' as const, messageId: 'synthetic-message', delta, timestamp: cursor, cursor } };
}
function runtime(index: number): RuntimeState {
  return { status: 'ready', project: { path: scope(index).projectPath, name: 'Synthetic', trusted: true }, sessionId: scope(index).sessionId,
    sessionFile: null, streaming: false, model: null, models: [], thinkingLevel: 'high', permissionLevel: 'edit', messages: [], tools: [], sessions: [], error: null };
}
function summary(value: object) { console.info(`FATE_TRANSPORT_PROFILE ${JSON.stringify({ seed: SEED, ...value })}`); }

describe('measured transport memory bounds', () => {
  it('isolates a stalled subscriber under a seeded multi-workspace event flood and measures actual retained buffers', () => {
    const source = new ScopedDomainEvents();
    const limits = { ringCount: 128, ringBytes: 128 * 1024, unsentCount: 32, unsentBytes: 32 * 1024 };
    const hub = new WorkspaceEventHub(source, 'load-fixture', limits);
    const stalled = hub.subscribe(scope(0));
    const healthy = hub.subscribe(scope(1));
    const cursor = hub.position(scope(0));
    const random = generator();
    let healthyDelivered = 0, maxRingBytes = 0, maxPendingBytes = 0, maxRingCount = 0, maxPendingCount = 0;
    const start = performance.now();
    try {
      for (let index = 0; index < 12_000; index++) {
        const workspace = index % 8;
        source.publish(event(workspace, index + 1, `fixture-${random()}:` + '🙂'.repeat(16 + random() % 256)));
        if (workspace === 1) healthyDelivered += healthy.drain().length;
        const usage = hub.inspectBuffers();
        maxRingBytes = Math.max(maxRingBytes, usage.retainedBytes);
        maxPendingBytes = Math.max(maxPendingBytes, usage.pendingBytes);
        maxRingCount = Math.max(maxRingCount, usage.retainedCount);
        maxPendingCount = Math.max(maxPendingCount, usage.pendingCount);
        expect(usage.streamCount).toBeLessThanOrEqual(8);
        expect(usage.retainedBytes).toBeLessThanOrEqual(8 * limits.ringBytes);
        expect(usage.retainedCount).toBeLessThanOrEqual(8 * limits.ringCount);
        expect(usage.pendingBytes).toBeLessThanOrEqual(8 * limits.unsentBytes);
        expect(usage.pendingCount).toBeLessThanOrEqual(8 * limits.unsentCount);
      }
      expect(healthyDelivered).toBe(1_500);
      expect(() => stalled.drain()).toThrow('RESYNC_REQUIRED');
      expect(() => hub.subscribe(scope(0), cursor)).toThrow('RESYNC_REQUIRED');
      const rejoined = hub.subscribe(scope(0), hub.position(scope(0)));
      source.publish(event(0, 12_001, 'after-explicit-current-position'));
      expect(rejoined.drain()).toHaveLength(1);
      rejoined.close();
      expect(source.deliveryFailures).toBe(0);
      summary({ case: 'events', eventCount: 12_001, workspaceCount: 8, healthyDelivered, maxRingBytes, maxPendingBytes, maxRingCount, maxPendingCount,
        elapsedMs: performance.now() - start, configured: limits, production: { EVENT_RING_BYTES, EVENT_RING_COUNT, EVENT_UNSENT_BYTES, EVENT_UNSENT_COUNT } });
    } finally { hub.dispose(); }
    expect(hub.inspectBuffers()).toMatchObject({ streamCount: 0, subscriptionCount: 0, retainedBytes: 0, pendingBytes: 0 });
  });

  it('caps real immutable snapshot copies across repeated clients and expires retained pages', () => {
    let current = 0, now = 1_000;
    const live = runtime(0);
    live.messages = Array.from({ length: 350 }, (_, index) => ({ id: `message-${index}`, role: 'assistant', text: '界🙂'.repeat(1_000), timestamp: index, timelinePosition: index }));
    const snapshots = new WorkspaceSnapshotService(() => undefined, () => ({ state: { ...live, ...runtime(current), messages: live.messages }, goal: null, tasks: [] }), () => now);
    let peakBytes = 0, peakPages = 0;
    const start = performance.now();
    for (let index = 0; index < 24; index++) {
      current = index % 8;
      const owner = scope(current);
      const first = snapshots.capture(owner);
      const pages = [first, ...first.header!.pageIds.slice(1).map((id) => snapshots.page(owner, id))];
      expect(pages.every((page) => Buffer.byteLength(JSON.stringify(page)) <= SNAPSHOT_PAGE_BYTES)).toBe(true);
      expect(pages.reduce((sum, page) => sum + Buffer.byteLength(JSON.stringify(page)), 0)).toBeLessThanOrEqual(SNAPSHOT_TOTAL_BYTES);
      expect(first.header?.omissions.clippedItems).toBe(350);
      const usage = snapshots.inspectBuffers();
      peakBytes = Math.max(peakBytes, usage.bytes); peakPages = Math.max(peakPages, usage.pageCount);
      expect(usage.transactionCount).toBeLessThanOrEqual(16);
      expect(usage.pageCount).toBeLessThanOrEqual(16 * 32);
      expect(usage.bytes).toBeLessThanOrEqual(16 * SNAPSHOT_TOTAL_BYTES);
    }
    now += 60_001;
    expect(snapshots.inspectBuffers()).toEqual({ transactionCount: 0, pageCount: 0, bytes: 0 });
    summary({ case: 'snapshots', captures: 24, clients: 8, messageCount: 350, inputCharactersPerMessage: live.messages[0]!.text.length,
      peakBytes, peakPages, elapsedMs: performance.now() - start });
  });

  it('keeps 15-second many-client monitor heartbeats compact and preserves partial/unknown sources', () => {
    const runs = Array.from({ length: 1_000 }, (_, index) => ({ id: `run-${index}`, status: index % 5 ? 'succeeded' : 'running',
      startedAt: 10_000, finishedAt: index % 5 ? 15_000 : null, scheduledFor: 0, error: null, resultSummary: 'Synthetic summary' }));
    const fullRuns = runs.map((run) => agentRunSchema.parse({ ...run, schemaVersion: 1, projectPath: '/synthetic/project-0',
      agentId: '00000000-0000-4000-8000-000000000001', taskTemplateId: '00000000-0000-4000-8000-000000000002',
      routineId: null, agentRevision: 1, taskTemplateRevision: 1, routineRevision: null, sessionId: null, inputs: {}, permission: 'edit', approvals: [],
    }));
    const input = { projectPath: '/synthetic/project-0', sessionId: 'session-0', runs: fullRuns, teams: [], tasks: null, goal: null,
      runsAvailable: true, sessionAvailable: true, runsPartial: true, runsCheckedAt: 15_000, now: 20_000 };
    const first = buildMonitorDashboard(input, { section: 'runs', limit: 100 });
    expect(first.items).toHaveLength(100);
    expect(first.sources.runs).toBe('partial');
    let maxHeartbeatBytes = 0;
    const start = performance.now();
    for (let tick = 1; tick <= 6; tick++) for (let client = 0; client < 8; client++) {
      const heartbeat = buildMonitorDashboard({ ...input, now: 20_000 + tick * 15_000 }, { section: 'runs', limit: 100, sinceRevision: first.revision });
      expect(heartbeat.unchanged).toBe(true); expect(heartbeat.items).toEqual([]);
      maxHeartbeatBytes = Math.max(maxHeartbeatBytes, Buffer.byteLength(JSON.stringify(heartbeat)));
    }
    expect(maxHeartbeatBytes).toBeLessThan(2_048);
    const missing = buildMonitorDashboard({ ...input, runs: null, runsAvailable: false, sessionAvailable: false });
    expect(missing.overall).toBe('unknown'); expect(missing.sources.runs).toBe('unknown');
    summary({ case: 'monitor', runCount: 1_000, clients: 8, intervalMs: 15_000, polls: 48, maxHeartbeatBytes, elapsedMs: performance.now() - start });
  });
});
