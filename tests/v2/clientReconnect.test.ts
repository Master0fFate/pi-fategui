import { describe, expect, it, vi } from 'vitest';
import { WorkspaceClient, type WorkspaceTransport, type OpenResult, type SelectedView } from '../../src/client/WorkspaceClient';
import { reconcileHydrationEvents } from '../../src/client/reconcileHydrationEvents';
import type { RuntimeState } from '../../src/shared/contracts/ipc';
import type { EventEnvelope, EventCursor } from '../../src/shared/protocol/events';
import type { SnapshotPage } from '../../src/shared/protocol/snapshots';

const id = '00000000-0000-4000-8000-000000000001';
const stream = '00000000-0000-4000-8000-000000000002';
const snapshotId = '00000000-0000-4000-8000-000000000003';
const pageId = '00000000-0000-4000-8000-000000000004';
const selection = (hostId = 'A', sessionId = 's1', viewGeneration = 1, profileId = 'default'): SelectedView => ({ hostId, profileId, hostName: hostId, workspaceId: 'w1', workspaceName: 'Workspace', workspaceGeneration: 1, sessionId, viewGeneration });
const cursor = (serverEpoch = 'epoch', sequence = 0): EventCursor => ({ serverEpoch, workspaceId: 'w1', workspaceGeneration: 1, streamId: stream, sequence });
const event = (sequence: number, sessionId = 's1', serverEpoch = 'epoch', piCursor = sequence): EventEnvelope => ({
  version: 1, serverEpoch, streamId: stream, sequence, origin: { workspaceId: 'w1', workspaceGeneration: 1, sessionId },
  event: { kind: 'pi', origin: { workspaceId: 'w1', workspaceGeneration: 1, sessionId }, event: { type: 'assistant.text', messageId: 'm', delta: String(sequence), timestamp: 1, cursor: piCursor } },
});
const page = (serverEpoch = 'epoch', sequence = 0): SnapshotPage => ({ version: 1, snapshotId, pageId, index: 0, items: [], nextPageId: null, header: {
  version: 1, snapshotId, capturedAt: 10, expiresAt: 1000, workspaceId: 'w1', workspaceGeneration: 1, serverEpoch,
  sessionId: 's1', eventCursor: 0, eventStream: cursor(serverEpoch, sequence), pageIds: [pageId],
  controls: { status: 'ready', streaming: true, activeSessionRunning: true, runningSessionCount: 1, permissionLevel: 'edit', thinkingLevel: 'medium', model: null, pendingModel: null, pendingThinkingLevel: null, sessionOperation: false, queue: { steering: 0, followUp: 0, pending: 0, held: 0, recovered: 0 } },
  goal: null, taskRevision: null, tasks: [], agents: [], omissions: { history: false, media: false, clippedItems: 0, agentRows: false, taskRows: false, goalText: false, taskText: false, agentText: false, queueContents: false }, warnings: [],
} });
type WithoutClose<T> = T extends OpenResult ? Omit<T, 'close'> : never;
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  let events: (item: EventEnvelope) => void = () => undefined;
  let lost: () => void = () => undefined;
  let epoch = 'epoch';
  let control: 'controlling' | 'observing' = 'controlling';
  const requests: Array<EventCursor | undefined> = [];
  let openResult: (after?: EventCursor) => WithoutClose<OpenResult> = () => ({ kind: 'snapshot', identity: { serverId: 'A', serverEpoch: epoch, workspaceId: 'w1', workspaceGeneration: 1, sessionId: 's1' }, pages: [page(epoch)] });
  const transport: WorkspaceTransport = {
    handshake: async (selected) => ({ serverId: selected.hostId, serverEpoch: epoch, workspaceId: selected.workspaceId, workspaceGeneration: selected.workspaceGeneration, sessionId: selected.sessionId, control, permissionLevel: 'edit' }),
    open: async (_handshake, after, onEvent, onDisconnect) => { requests.push(after); events = onEvent; lost = onDisconnect; return { ...openResult(after), close: () => undefined }; },
  };
  const received: number[] = []; const background: string[] = []; const snapshots: SnapshotPage[][] = [];
  const client = new WorkspaceClient(transport, { snapshot: (pages) => { snapshots.push([...pages]); }, event: (item) => { received.push(item.sequence); }, background: (item) => { background.push(item.origin.sessionId ?? ''); } }, { retryLimit: 2, autoReconnect: false, wait: async () => undefined });
  return { client, transport, requests, received, background, snapshots, send: (item: EventEnvelope) => events(item), callback: () => events, lose: () => lost(), setEpoch: (value: string) => { epoch = value; }, setControl: (value: typeof control) => { control = value; }, setOpen: (fn: typeof openResult) => { openResult = fn; } };
}

describe('client connection and replay', () => {
  it('starts with a failing-closed view, blocks observer/disconnected mutations and retains scoped drafts', async () => {
    const f = fixture(); f.client.select(selection()); f.client.setDraft('unsent');
    const send = vi.fn(async () => ({ identity: { serverId: 'A', serverEpoch: 'epoch', workspaceId: 'w1', workspaceGeneration: 1, sessionId: 's1' }, value: 'sent' }));
    await expect(f.client.mutate('r1', 'unsent', send)).rejects.toThrow('CONNECTION_UNAVAILABLE');
    await f.client.connect();
    expect(f.client.state.status).toBe('controlling');
    expect(await f.client.mutate('r1', 'unsent', send)).toBe('sent');
    f.client.disconnect();
    expect(f.client.state.status).toBe('disconnected');
    expect(f.client.state.lastConfirmedStatus).toBe('running');
    await expect(f.client.mutate('r2', 'unsent', send)).rejects.toThrow('CONNECTION_UNAVAILABLE');
    f.client.select(selection('B'));
    expect(f.client.state.lastConfirmedStatus).toBe('unknown');
    expect(f.client.draft(selection())).toBe('unsent');
    expect(f.client.draft(selection('B'))).toBe('');
    expect(send).toHaveBeenCalledTimes(1);
    f.client.select(selection('A', 's1', 2));
    f.setControl('observing'); f.setEpoch('observer'); await f.client.connect();
    expect(f.client.state.status).toBe('observing');
    await expect(f.client.mutate('r5', 'text', send)).rejects.toThrow('CONNECTION_UNAVAILABLE');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('fences delayed A read, stale subscription and lost mutation response after switch B', async () => {
    const f = fixture(); f.client.select(selection()); await f.client.connect();
    const lateRead = deferred<string>(); const applied: string[] = [];
    const read = f.client.read(async () => ({ identity: { serverId: 'A', serverEpoch: 'epoch', workspaceId: 'w1', workspaceGeneration: 1, sessionId: 's1' }, value: await lateRead.promise }), (value) => applied.push(value));
    const lateSend = deferred<string>(); const sending = f.client.mutate('r3', 'prompt', async () => ({ identity: { serverId: 'A', serverEpoch: 'epoch', workspaceId: 'w1', workspaceGeneration: 1, sessionId: 's1' }, value: await lateSend.promise }));
    const staleEvent = f.callback();
    f.client.select(selection('B'));
    f.setOpen(() => ({ kind: 'snapshot', identity: { serverId: 'B', serverEpoch: 'epoch', workspaceId: 'w1', workspaceGeneration: 1, sessionId: 's1' }, pages: [page()] }));
    await f.client.connect();
    staleEvent(event(1)); lateRead.resolve('A'); lateSend.resolve('accepted');
    expect(await read).toBe(false); expect(applied).toEqual([]);
    await expect(sending).rejects.toThrow('OUTCOME_UNKNOWN');
    expect(f.client.outcomes(selection())).toMatchObject([{ requestId: 'r3', status: 'outcome_unknown' }]);
    expect(f.received).toEqual([]);
    expect(f.client.state.hostId).toBe('B');
  });

  it('does not admit a mutation from a replay callback before the full barrier settles', async () => {
    const f = fixture();
    const sends = vi.fn(async () => ({ identity: { serverId: 'A', serverEpoch: 'epoch', workspaceId: 'w1', workspaceGeneration: 1, sessionId: 's1' }, value: 'sent' }));
    let during: Promise<unknown> | undefined;
    let delivered = 0;
    const statuses: string[] = [];
    const client = new WorkspaceClient(f.transport, {
      snapshot: () => undefined, event: () => { if (++delivered === 2) { statuses.push(client.state.status); during = client.mutate('early', 'text', sends); void during.catch(() => undefined); } },
    }, { autoReconnect: false });
    client.select(selection()); await client.connect(); client.disconnect();
    // Reconnect with the same stream; the sink tries to mutate during replay.
    f.setOpen((after) => ({ kind: 'replay', identity: { serverId: 'A', serverEpoch: 'epoch', workspaceId: 'w1', workspaceGeneration: 1, sessionId: 's1' },
      after: after!, events: [event(1), event(2)] }));
    await client.connect();
    expect(statuses).toEqual(['synchronizing']);
    await expect(during).rejects.toThrow('CONNECTION_UNAVAILABLE');
    expect(sends).not.toHaveBeenCalled();
  });

  it('acknowledges live reentrant events through sequence 2 before reconnect replay', async () => {
    const f = fixture();
    const received: number[] = [];
    const client = new WorkspaceClient(f.transport, { snapshot: () => undefined,
      event: (item) => {
        received.push(item.sequence);
        if (item.sequence === 1) f.send(event(2));
      } }, { autoReconnect: false });
    client.select(selection()); await client.connect();
    f.send(event(1));
    expect(received).toEqual([1, 2]);
    client.disconnect();
    f.setOpen((after) => ({ kind: 'replay', identity: { serverId: 'A', serverEpoch: 'epoch', workspaceId: 'w1', workspaceGeneration: 1, sessionId: 's1' },
      after: after!, events: [event(1), event(2)].filter((item) => item.sequence > (after?.sequence ?? 0)) }));
    await client.connect();
    expect(f.requests.at(-1)).toEqual(cursor('epoch', 2));
    expect(received).toEqual([1, 2]);
    expect(client.state.status).toBe('controlling');
  });

  it('drains an event published reentrantly while the snapshot buffer is applied', async () => {
    const f = fixture(); const original = f.transport.open;
    f.transport.open = async (...args) => { const opened = await original(...args); args[2](event(1)); return opened; };
    const received: number[] = [];
    const client = new WorkspaceClient(f.transport, { snapshot: () => undefined,
      event: (item) => { received.push(item.sequence); if (item.sequence === 1) f.send(event(2)); } }, { autoReconnect: false });
    client.select(selection()); await client.connect();
    expect(received).toEqual([1, 2]); expect(client.state.status).toBe('controlling');
  });

  it('fences an old credential profile even when it returns to the same host and session', async () => {
    const f = fixture(); f.client.select(selection()); await f.client.connect();
    const stale = f.callback(); const oldGeneration = f.client.state.generation;
    f.client.select(selection('A', 's1', 1, 'new-profile'));
    expect(f.client.state.generation).toBeGreaterThan(oldGeneration);
    await f.client.connect(); stale(event(1));
    expect(f.received).toEqual([]);
    expect(f.client.state.status).toBe('controlling');
  });

  it('never retries an uncertain prompt; repeated reconnect uses confirmed replay and deduplicates envelopes', async () => {
    const f = fixture(); f.client.select(selection()); await f.client.connect();
    const send = vi.fn(async () => { throw new Error('response lost'); });
    await expect(f.client.mutate('r4', 'prompt text', send)).rejects.toThrow('OUTCOME_UNKNOWN');
    f.send(event(1, 's1', 'epoch', 9));
    f.lose();
    f.setOpen((after) => ({ kind: 'replay', identity: { serverId: 'A', serverEpoch: 'epoch', workspaceId: 'w1', workspaceGeneration: 1, sessionId: 's1' }, after: after!, events: [event(1, 's1', 'epoch', 9), event(2, 's1', 'epoch', 12)] }));
    await f.client.connect(); expect(f.received).toEqual([1, 2]);
    f.lose(); await f.client.connect(); expect(f.received).toEqual([1, 2]);
    expect(f.requests.map((item) => item?.sequence)).toEqual([undefined, 1, 2]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.client.outcomes(selection())[0]?.status).toBe('outcome_unknown');
  });

  it('falls back to a fresh snapshot only after replay expiry and resets high old sequence on epoch restart', async () => {
    const f = fixture(); f.client.select(selection()); await f.client.connect(); f.send(event(1)); f.lose();
    const original = f.transport.open;
    let refused = false;
    f.transport.open = async (...args) => { if (args[1] && !refused) { refused = true; throw new Error('RESYNC_REQUIRED'); } return original(...args); };
    f.setOpen(() => ({ kind: 'snapshot', identity: { serverId: 'A', serverEpoch: 'epoch', workspaceId: 'w1', workspaceGeneration: 1, sessionId: 's1' }, pages: [page('epoch', 50)] }));
    await f.client.connect(); expect(f.requests).toEqual([undefined, undefined]); expect(f.snapshots).toHaveLength(2);
    f.send(event(51)); f.lose(); f.setEpoch('restart');
    f.setOpen(() => ({ kind: 'snapshot', identity: { serverId: 'A', serverEpoch: 'restart', workspaceId: 'w1', workspaceGeneration: 1, sessionId: 's1' }, pages: [page('restart')] }));
    await f.client.connect(); f.send(event(1, 's1', 'restart'));
    expect(f.received).toEqual([1, 51, 1]);
    expect(f.requests.at(-1)).toBeUndefined();
  });

  it('refuses malformed snapshot and event gaps without silently applying a partial view', async () => {
    const f = fixture(); f.client.select(selection());
    f.setOpen(() => ({ kind: 'snapshot', identity: { serverId: 'A', serverEpoch: 'epoch', workspaceId: 'w1', workspaceGeneration: 1, sessionId: 's1' }, pages: [{ ...page(), nextPageId: id }] }));
    await f.client.connect();
    expect(f.client.state.status).toBe('error'); expect(f.snapshots).toHaveLength(0);
    f.setOpen(() => ({ kind: 'snapshot', identity: { serverId: 'A', serverEpoch: 'epoch', workspaceId: 'w1', workspaceGeneration: 1, sessionId: 's1' }, pages: [page()] }));
    await f.client.connect(); f.send(event(2));
    expect(f.client.state.status).toBe('disconnected'); expect(f.received).toEqual([]);
  });

  it('cancels scheduled reconnect after host replacement and refuses a forged scoped response', async () => {
    const f = fixture();
    const delay = deferred<void>(); const waits: AbortSignal[] = [];
    const client = new WorkspaceClient(f.transport, { snapshot: () => undefined, event: () => undefined },
      { retryLimit: 2, wait: (_ms, signal) => { waits.push(signal); return delay.promise; } });
    client.select(selection()); await client.connect();
    expect(await client.read(async () => ({ identity: { serverId: 'B', serverEpoch: 'epoch', workspaceId: 'w1', workspaceGeneration: 1, sessionId: 's1' }, value: 'forged' }),
      () => { throw new Error('must not apply'); })).toBe(false);
    f.lose(); expect(client.state.status).toBe('disconnected'); expect(waits).toHaveLength(1);
    client.select(selection('B')); expect(waits[0]?.aborted).toBe(true);
    delay.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(client.state.status).toBe('disconnected'); expect(client.state.hostId).toBeNull();
  });

  it('reconciles buffered Pi hydration only with a complete local state, outside network dedup', async () => {
    const f = fixture(); const original = f.transport.open;
    f.transport.open = async (...args) => {
      const opened = await original(...args);
      args[2](event(1, 's1', 'epoch', 4));
      args[2]({ ...event(2, 's1', 'epoch', 9), event: { kind: 'pi', origin: event(2).origin,
        event: { type: 'message.completed', messageId: 'm', role: 'assistant', text: 'rewritten', timestamp: 2, cursor: 9 } } });
      return opened;
    };
    const runtime: RuntimeState = { status: 'ready', project: null, sessionId: 's1', sessionFile: null, streaming: true,
      model: null, models: [], thinkingLevel: 'medium', eventCursor: 12, error: null,
      messages: [{ id: 'm', role: 'assistant', text: 'rewritten', timestamp: 1 }] };
    const received: EventEnvelope[] = [];
    const client = new WorkspaceClient(f.transport, { snapshot: () => runtime, event: (item) => received.push(item) },
      { autoReconnect: false });
    client.select(selection()); await client.connect();
    expect(received).toEqual([]); expect(client.state.status).toBe('controlling');
    f.send(event(3, 's1', 'epoch', 13));
    expect(received.map((item) => item.sequence)).toEqual([3]);
  });

  it('automatically retries a lost subscription with cancellable backoff, not a mutation', async () => {
    const f = fixture(); const delays: number[] = [];
    const client = new WorkspaceClient(f.transport, { snapshot: () => undefined, event: () => undefined },
      { retryLimit: 2, wait: async (ms, signal) => { delays.push(ms); expect(signal.aborted).toBe(false); } });
    client.select(selection()); await client.connect(); f.lose();
    await vi.waitFor(() => expect(client.state.status).toBe('controlling'));
    expect(delays).toEqual([250]);
    expect(f.requests).toHaveLength(2);
    client.disconnect();
  });

  it('resets the bounded retry budget after each confirmed reconnect, not once per client lifetime', async () => {
    const f = fixture(); const delays: number[] = [];
    const client = new WorkspaceClient(f.transport, { snapshot: () => undefined, event: () => undefined },
      { retryLimit: 2, wait: async (ms, signal) => { delays.push(ms); expect(signal.aborted).toBe(false); } });
    client.select(selection()); await client.connect();
    for (let cycle = 1; cycle <= 4; cycle++) {
      f.lose();
      await vi.waitFor(() => expect(f.requests).toHaveLength(cycle + 1));
      expect(client.state.status).toBe('controlling');
    }
    expect(delays).toEqual([250, 250, 250, 250]);
    client.disconnect();
  });

  it('keeps the existing Pi hydration rule separate from envelope sequence: completed rewrite, gaps and cursor jumps', () => {
    const runtime: RuntimeState = { status: 'ready', project: null, sessionId: 's1', sessionFile: null, streaming: false,
      model: null, models: [], thinkingLevel: 'medium', eventCursor: 12, error: null,
      messages: [{ id: 'm', role: 'assistant', text: 'rewritten', timestamp: 1 }], tools: [] };
    expect(reconcileHydrationEvents(runtime, [
      { type: 'assistant.text', messageId: 'm', delta: 'draft', timestamp: 1, cursor: 4 },
      { type: 'message.completed', messageId: 'm', role: 'assistant', text: 'rewritten', timestamp: 2, cursor: 9 },
    ])).toEqual([]);
    expect(reconcileHydrationEvents(runtime, [
      { type: 'assistant.reasoning', messageId: 'm', delta: 'missing reasoning', timestamp: 1, cursor: 10 },
      { type: 'assistant.text', messageId: 'm', delta: 'new', timestamp: 2, cursor: 13 },
    ])).toEqual([
      { type: 'assistant.reasoning', messageId: 'm', delta: 'missing reasoning', timestamp: 1 },
      { type: 'assistant.text', messageId: 'm', delta: 'new', timestamp: 2, cursor: 13 },
    ]);
  });

  it('advances network sequence for unselected session without painting its transcript; switch invalidates old view callbacks', async () => {
    const f = fixture(); f.client.select(selection()); await f.client.connect();
    f.send(event(1, 'other')); f.send(event(2, 's1'));
    expect(f.background).toEqual(['other']); expect(f.received).toEqual([2]);
    const old = f.callback(); f.client.select(selection('A', 'other', 2)); old(event(3));
    expect(f.received).toEqual([2]);
    await f.client.connect(); expect(f.requests.at(-1)).toBeUndefined();
  });
});
