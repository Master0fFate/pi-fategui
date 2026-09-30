import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exchangeBrowserCode, recoverBrowserSession, WebFateApi, type WebEventClient } from '../../src/client/WebFateApi';
import { getDesktopApiOptional, getFateApi, getWebApiOptional, installWebFateApi, resetFateApi } from '../../src/renderer/platform/api';
import type { NetworkEvent } from '../../src/shared/protocol/diagnostics';
import type { SnapshotHeader, SnapshotPage } from '../../src/shared/protocol/snapshots';
import { requestEnvelopeSchema, type RequestOf } from '../../src/shared/protocol/envelopes';
import { permissionReceiptSchema } from '../../src/shared/protocol/commandOutcomes';

const origin = 'http://127.0.0.1:49301';
const epoch = '10000000-0000-4000-8000-000000000001';
const workspaceId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000003';
const snapshotId = '40000000-0000-4000-8000-000000000004';
const page0 = '50000000-0000-4000-8000-000000000005';
const page1 = '60000000-0000-4000-8000-000000000006';
const csrfToken = `fx1_${'x'.repeat(43)}`;
const browserSession = { sessionId, expiresAt: Date.now() + 60_000, csrfToken };
const selected = { workspaceId, workspaceGeneration: 3, label: 'Registered workspace' };
const streamId = '70000000-0000-4000-8000-000000000007';
const header: SnapshotHeader = { version: 1, snapshotId, capturedAt: Date.now(), expiresAt: Date.now() + 60_000,
  workspaceId, workspaceGeneration: 3, serverEpoch: epoch, sessionId, eventCursor: 3, selectionRevision: 4,
  eventStream: { serverEpoch: epoch, streamId, workspaceId, workspaceGeneration: 3, sequence: 2 },
  pageIds: [page0, page1], controls: { status: 'ready', streaming: true, activeSessionRunning: true,
    runningSessionCount: 1, permissionLevel: 'read-only', thinkingLevel: 'medium', model: null, pendingModel: null,
    pendingThinkingLevel: null, sessionOperation: false, queue: { steering: 0, followUp: 0, pending: 0, held: 0, recovered: 0 } },
  goal: null, taskRevision: null, tasks: [], agents: [], omissions: { history: true, media: true, clippedItems: 1,
    agentRows: false, taskRows: false, goalText: false, taskText: false, agentText: false, queueContents: true }, warnings: [] };
const first: SnapshotPage = { version: 1, snapshotId, pageId: page0, index: 0, header, nextPageId: page1,
  items: [{ kind: 'message', id: 'bounded-1', role: 'assistant', text: 'Safe excerpt', timestamp: 1, clipped: true, mediaOmitted: true }] };
const second: SnapshotPage = { version: 1, snapshotId, pageId: page1, index: 1, nextPageId: null,
  items: [{ kind: 'tool', id: 'bounded-2', name: 'read', status: 'completed', text: 'Safe result', timestamp: 2, clipped: false, mediaOmitted: false }] };
const monitor = { revision: '4:r1', sessionId, selectionRevision: 4, checkedAt: Date.now(), overall: 'unknown',
  sources: { runs: 'partial', teams: 'ready', tasks: 'unknown', activity: 'unknown' },
  sourceCheckedAt: { runs: Date.now(), teams: Date.now(), tasks: null, activity: null },
  counts: { active: 1, attention: 1, runs: 26, teams: 0, tasks: 0, activity: 0 }, section: 'runs',
  total: 26, offset: 25, limit: 25, unchanged: false,
  items: [{ id: '0000000000000000000000000000001a', source: 'runs', state: 'attention', title: 'Release check', updatedAt: Date.now() }] } as const;

function mockClient(overrides: { secondPage?: SnapshotPage } = {}) {
  const order: string[] = [];
  const subscriptions: unknown[][] = [];
  let onNetworkEvent: ((event: NetworkEvent) => void) | null = null;
  const events: WebEventClient = {
    get connection() { return { clientId: '80000000-0000-4000-8000-000000000008', serverEpoch: epoch, ticket: `ft1_${'t'.repeat(43)}` }; },
    connect: async () => { order.push('socket'); return events.connection!; },
    subscribe: async (...args) => { subscriptions.push(args); return args[2] ?? header.eventStream!; }, close: () => { order.push('close'); },
  };
  const makeEvents = (onEvent: (event: NetworkEvent) => void): WebEventClient => { onNetworkEvent = onEvent; return events; };
  const requests: Array<{ url: string; init?: RequestInit; body?: Record<string, unknown> }> = [];
  const send: typeof fetch = vi.fn(async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ url, ...(init ? { init } : {}), ...(body ? { body } : {}) });
    order.push(url.endsWith('/api/auth/session') ? 'session' : String(body?.method ?? 'other'));
    if (url.endsWith('/api/auth/session')) return new Response(JSON.stringify({ session: browserSession }), { status: 200 });
    if (url.endsWith('/api/auth/exchange')) return new Response(JSON.stringify({ session: browserSession }), { status: 200 });
    if (url.endsWith('/api/info')) { order[order.length - 1] = 'info'; return new Response(JSON.stringify({ protocol: 1, serverEpoch: epoch,
      serverTime: Date.now(), kind: 'browser', capabilities: ['host.info', 'workspace.list'], workspaceCount: 1 }), { status: 200 }); }
    if (!body) throw new Error('Expected a command body.');
    const scope = body.method === 'host.info' || body.method === 'workspace.list' ? null : { workspaceId, workspaceGeneration: 3 };
    const result = body.method === 'host.info'
      ? { hostId: '90000000-0000-4000-8000-000000000009', protocol: 1, serverEpoch: epoch,
        serverTime: Date.now(), appVersion: '1.1.0', capabilities: ['host.info', 'workspace.list', 'workspace.snapshot', 'workspace.monitor', 'file.read', 'workspace.control', 'runtime.prompt'], networkDispatchEnabled: true }
      : body.method === 'workspace.list' ? { workspaces: [selected] }
        : body.method === 'workspace.snapshot' ? first
          : body.method === 'workspace.snapshotPage' ? overrides.secondPage ?? second
            : body.method === 'workspace.monitor' ? monitor
              : body.method === 'file.list' ? { directoryId: body.input && (body.input as { directoryId: string | null }).directoryId,
                entries: [{ resourceId: '90000000-0000-4000-8000-000000000009', name: 'notes.txt', kind: 'file' }], truncated: false }
                : body.method === 'file.previewText' ? { fileId: (body.input as { fileId: string }).fileId, content: 'Scoped text', truncated: false }
                  : body.method === 'control.claim' ? { generation: 2, expiresAt: Date.now() + 30_000 }
                    : body.method === 'command.status' ? { state: 'outcome_unknown', receipt: null, rejectionCode: null }
                    : body.method === 'runtime.setModel' ? { requestId: body.requestId, durability: 'journaled', kind: 'operation',
                      operation: 'runtime.setModel', outcome: 'applied', sessionId, viewRevision: 5 }
                    : body.method === 'runtime.prompt' ? { requestId: body.requestId, durability: 'journaled', kind: 'prompt',
                      outcome: 'accepted', runId: 'a0000000-0000-4000-8000-00000000000a', sessionId, viewRevision: 5 } : null;
    return new Response(JSON.stringify({ protocol: 1, ok: true, requestId: body.requestId, serverEpoch: epoch,
      scope, method: body.method, result }), { status: 200 });
  });
  return { send, makeEvents, requests, order, subscriptions, emit: (event: NetworkEvent) => { onNetworkEvent?.(event); } };
}

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } });
});
afterEach(() => { resetFateApi(); vi.unstubAllGlobals(); });

describe('T39 safe browser adapter', () => {
  it('recovers the cookie session before the event socket; exchange sends the code only in POST body', async () => {
    const f = mockClient();
    const recovered = await recoverBrowserSession(origin, f.send);
    expect(recovered).toEqual(browserSession);
    const web = new WebFateApi(origin, recovered!, { send: f.send, makeEvents: f.makeEvents });
    await web.connect();
    expect(f.order.slice(0, 3)).toEqual(['session', 'info', 'socket']);
    const listed = await web.listWorkspaces();
    expect(listed).toEqual([selected]);
    expect(f.requests.filter((request) => request.url.endsWith('/api/command')).every((request) => {
      const headers = new Headers(request.init?.headers);
      return request.init?.credentials === 'include' && headers.get('X-Fate-Csrf') === csrfToken
        && headers.get('X-Fate-Client-Ticket') === `ft1_${'t'.repeat(43)}`;
    })).toBe(true);
    await exchangeBrowserCode(origin, `fb1_${'c'.repeat(43)}`, f.send);
    expect(f.requests.at(-1)?.url).toBe(`${origin}/api/auth/exchange`);
    expect(f.requests.at(-1)?.body).toEqual({ code: `fb1_${'c'.repeat(43)}` });
    expect(f.requests.every((request) => !request.url.includes('fb1_') && !request.url.includes('fx1_'))).toBe(true);
    web.close();
  });

  it('keeps the newer snapshot header when an older overlapping replay barrier settles', async () => {
    const f = mockClient();
    const acknowledgements: Array<() => void> = [];
    const makeEvents: typeof f.makeEvents = (onEvent) => {
      const events = f.makeEvents(onEvent);
      events.subscribe = (_workspaceId, _generation, after) => new Promise((resolve) => {
        acknowledgements.push(() => resolve(after!));
      });
      return events;
    };
    const web = new WebFateApi(origin, browserSession, { send: f.send, makeEvents });
    await web.connect();
    const older = web.readSnapshot(selected);
    const invalidated = expect(older).rejects.toThrow('Snapshot invalidated during replay');
    await vi.waitFor(() => expect(acknowledgements).toHaveLength(1));
    const newer = web.readSnapshot(selected);
    await vi.waitFor(() => expect(acknowledgements).toHaveLength(2));
    // ACKs still arrive in wire order, but the older read has lost view ownership.
    acknowledgements[0]!();
    await invalidated;
    acknowledgements[1]!();
    expect((await newer).header.selectionRevision).toBe(4);
    expect((await web.readMonitor(selected, { section: 'runs', offset: 25, limit: 25 })).dashboard.total).toBe(26);
    expect(web.isConnected).toBe(true);
    web.close();
  });

  it('treats an expired session as login required and rejects incompatible protocol before a socket opens', async () => {
    const expired = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }), { status: 401 }));
    expect(await recoverBrowserSession(origin, expired)).toBeNull();
    const f = mockClient();
    const mismatched = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith('/api/auth/session')) return new Response(JSON.stringify({ session: browserSession }), { status: 200 });
      return new Response(JSON.stringify({ protocol: 2, serverEpoch: epoch, serverTime: Date.now(),
        kind: 'browser', capabilities: [], workspaceCount: 0 }), { status: 200 });
    });
    const web = new WebFateApi(origin, browserSession, { send: mismatched, makeEvents: f.makeEvents });
    await expect(web.connect()).rejects.toThrow();
    expect(f.order).not.toContain('socket');
  });

  it('does not confirm logout when server revocation fails and the cookie session still recovers', async () => {
    const f = mockClient();
    const send: typeof fetch = async (input, init) => String(input).endsWith('/api/auth/logout')
      ? new Response(JSON.stringify({ error: { code: 'STORAGE_UNAVAILABLE' } }), { status: 503 })
      : f.send(input, init);
    const web = new WebFateApi(origin, browserSession, { send, makeEvents: f.makeEvents });
    await web.connect();
    await expect(web.logout()).rejects.toThrow(/revoke/i);
    expect(await recoverBrowserSession(origin, f.send)).toEqual(browserSession);
  });

  it('requires scoped control and a host selection revision for a prompt and refreshes after its receipt', async () => {
    const f = mockClient();
    const web = new WebFateApi(origin, browserSession, { send: f.send, makeEvents: f.makeEvents });
    await web.connect();
    await web.readSnapshot(selected);
    await expect(web.sendPrompt(selected, 'Please inspect this project')).rejects.toThrow(/control/i);
    const claim = await web.claimControl(selected);
    expect(claim.generation).toBe(2);
    const receipt = await web.sendPrompt(selected, 'Please inspect this project');
    expect(receipt).toMatchObject({ kind: 'prompt', outcome: 'accepted', sessionId });
    const request = f.requests.at(-1)?.body;
    expect(request).toMatchObject({ method: 'runtime.prompt', expectedSessionId: sessionId, selectionRevision: 4,
      controlGeneration: 2, workspaceId, workspaceGeneration: 3, input: { text: 'Please inspect this project' } });
    expect(String(request?.requestId)).toMatch(new RegExp(`^${epoch}\\.`));
    web.close();
  });

  it('sends text context only as opaque attachment IDs and validated relative paths, not browser filenames or local absolute paths', async () => {
    const f = mockClient();
    const web = new WebFateApi(origin, browserSession, { send: f.send, makeEvents: f.makeEvents });
    await web.connect(); await web.readSnapshot(selected); await web.claimControl(selected);
    Object.assign(web, { capabilities: new Set(['runtime.prompt', 'text.context', 'workspace.control']) });
    const id = `ta1_${'a'.repeat(43)}`;
    await web.sendPrompt(selected, 'Inspect', { attachments: [id], projectFiles: ['docs/notes.txt'] });
    expect(f.requests.at(-1)?.body).toMatchObject({ method: 'runtime.prompt', input: { text: 'Inspect', attachments: [id], projectFiles: ['docs/notes.txt'] } });
    web.clearPendingPromptReview();
    const before = f.requests.length;
    await expect(web.sendPrompt(selected, 'Read', { projectFiles: ['/private/secret'] })).rejects.toThrow();
    await expect(web.sendPrompt(selected, 'Read', { projectFiles: ['C:\\private\\secret'] })).rejects.toThrow();
    expect(f.requests).toHaveLength(before);
    web.close();
  });
  it('uses original-ID pending review for nonprompt mutations, refuses stale scope/control, and never replays a dropped model receipt', async () => {
    const f = mockClient();
    let effects = 0;
    let originalId = '';
    const send: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/api/command') && String(init?.body).includes('runtime.setModel')) {
        effects++; originalId = (JSON.parse(String(init?.body)) as { requestId: string }).requestId;
        throw new Error('Fake lost acknowledgment');
      }
      return f.send(input, init);
    };
    const web = new WebFateApi(origin, browserSession, { send, makeEvents: f.makeEvents });
    await web.connect(); await web.readSnapshot(selected);
    Object.assign(web, { capabilities: new Set(['runtime.configure', 'workspace.control', 'workspace.list']) });
    await expect(web.setModel(selected, 'fake', 'model')).rejects.toThrow(/control/i);
    expect(effects).toBe(0);
    await web.claimControl(selected);
    await expect(web.setModel(selected, 'fake', 'model')).rejects.toMatchObject({ requestId: expect.stringMatching(new RegExp(`^${epoch}\\.`)) });
    expect(effects).toBe(1);
    expect(web.pendingPromptReview(selected, sessionId)).toMatchObject({ kind: 'match', value: { requestId: originalId } });
    await expect(web.setModel(selected, 'fake', 'other')).rejects.toThrow(/Review the previous command/i);
    await web.reviewPromptStatus(selected, originalId);
    expect(effects).toBe(1);
    expect(f.requests.filter((request) => request.body?.method === 'command.status').every((request) =>
      (request.body?.input as { requestId: string }).requestId === originalId)).toBe(true);
    web.close();
  });

  it('preserves unknown create/select method+original ID across a changed selected session, with status read independent of the new selection', async () => {
    const f = mockClient();
    const web = new WebFateApi(origin, browserSession, { send: f.send, makeEvents: f.makeEvents });
    await web.connect(); await web.readSnapshot(selected); await web.claimControl(selected);
    const originalId = `${epoch}.1000.90000000-0000-4000-8000-000000000009`;
    web.rememberPendingPromptReview(selected, sessionId, originalId, 'session.create');
    Object.assign(web, { capabilities: new Set(['workspace.control', 'workspace.list', 'session.select']), selectedSnapshot: { ...header, sessionId: 'a0000000-0000-4000-8000-00000000000a', selectionRevision: 5 } });
    expect(web.pendingCommandReview(selected)).toMatchObject({ kind: 'blocked', reason: 'mismatch',
      value: { method: 'session.create', requestId: originalId, sessionId } });
    expect(await web.reviewCommandStatus(selected, originalId)).toMatchObject({ state: 'outcome_unknown' });
    expect(f.requests.at(-1)?.body).toMatchObject({ method: 'command.status', input: { requestId: originalId } });
    expect(f.requests.at(-1)?.body).not.toHaveProperty('expectedSessionId');
    await expect(web.createSession(selected)).rejects.toThrow(/previous command/i);
    web.close();
    const reloaded = new WebFateApi(origin, browserSession, { send: f.send, makeEvents: f.makeEvents });
    expect(reloaded.pendingPromptReview(selected, sessionId)).toMatchObject({ kind: 'match', value: { method: 'session.create', requestId: originalId } });
    reloaded.close();
  });
  it('keeps the original permission-confirm ID/method/scope through a lost ACK and reload, resolving only a correlated durable receipt without replay', async () => {
    const f = mockClient();
    const confirmations: Array<RequestOf<'permission.confirm'>> = [];
    let settled = false;
    let wrongScope = false;
    const send: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/api/command') && init?.body) {
        const request = requestEnvelopeSchema.parse(JSON.parse(String(init.body)) as unknown);
        if (request.method === 'permission.confirm') {
          confirmations.push(request);
          throw new Error('Synthetic lost permission ACK after application');
        }
      }
      const response = await f.send(input, init);
      const value = await response.json() as Record<string, unknown>;
      if (value.method === 'command.status' && settled) {
        const original = confirmations[0]!;
        value.result = { state: 'settled', rejectionCode: null, receipt: permissionReceiptSchema.parse({
          kind: 'permission', durability: 'journaled', outcome: 'applied', requestId: original.requestId,
          challengeId: original.input.challengeId, workspaceId, workspaceGeneration: wrongScope ? 4 : 3,
          sessionId, selectionRevision: original.selectionRevision, controlGeneration: original.controlGeneration,
          oldLevel: original.input.oldLevel, newLevel: original.input.newLevel,
        }) };
      }
      return new Response(JSON.stringify(value), { status: response.status });
    };
    const web = new WebFateApi(origin, browserSession, { send, makeEvents: f.makeEvents });
    await web.connect(); await web.readSnapshot(selected); await web.claimControl(selected);
    Object.assign(web, { capabilities: new Set(['permission.approve', 'workspace.control', 'workspace.list']) });
    const confirmation = { sessionId, challengeId: 'b0000000-0000-4000-8000-00000000000b',
      action: 'runtime.setPermission' as const, oldLevel: 'read-only' as const, newLevel: 'edit' as const };
    await expect(web.respondPermissionApproval(selected, confirmation)).rejects.toMatchObject({ requestId: expect.stringMatching(new RegExp(`^${epoch}\\.`)) });
    const original = confirmations[0]!;
    expect(web.pendingPromptReview(selected, sessionId)).toMatchObject({ kind: 'match', value: {
      method: 'permission.confirm', requestId: original.requestId, sessionId, workspaceGeneration: 3, serverEpoch: epoch,
    } });
    await expect(web.respondPermissionApproval(selected, confirmation)).rejects.toThrow(/previous command/i);
    web.close();
    const reloaded = new WebFateApi(origin, browserSession, { send, makeEvents: f.makeEvents });
    await reloaded.connect(); await reloaded.readSnapshot(selected);
    // Neither a later displayed permission level nor a new selected session proves this original effect.
    Object.assign(reloaded, { selectedSnapshot: { ...header, sessionId: 'a0000000-0000-4000-8000-00000000000a',
      selectionRevision: 5, controls: { ...header.controls, permissionLevel: 'edit' } } });
    expect(await reloaded.reviewCommandStatus(selected, original.requestId)).toMatchObject({ state: 'outcome_unknown', receipt: null });
    expect(() => reloaded.clearPendingPromptReview()).toThrow(/correlated settled or rejected/i);
    settled = true; wrongScope = true;
    await expect(reloaded.reviewCommandStatus(selected, original.requestId)).rejects.toThrow(/receipt scope/i);
    expect(() => reloaded.clearPendingPromptReview()).toThrow(/correlated settled or rejected/i);
    wrongScope = false;
    expect(await reloaded.reviewCommandStatus(selected, original.requestId)).toMatchObject({ state: 'settled', receipt: {
      kind: 'permission', requestId: original.requestId, workspaceGeneration: 3, sessionId,
    } });
    reloaded.clearPendingPromptReview();
    expect(reloaded.pendingPromptReview(selected, sessionId)).toEqual({ kind: 'none' });
    expect(confirmations).toHaveLength(1);
    const statusRequests = f.requests.filter((entry) => entry.body?.method === 'command.status');
    expect(statusRequests).toHaveLength(3);
    for (const entry of statusRequests) {
      expect(entry.body).toMatchObject({ input: { requestId: original.requestId } });
      expect(entry.body).not.toHaveProperty('expectedSessionId');
    }
    expect(f.requests.some((entry) => entry.body?.method === 'permission.issue')).toBe(false);
    reloaded.close();
  });
  it('checks transaction TTL against calibrated host time during assembly, not a skewed browser clock', async () => {
    const f = mockClient();
    const web = new WebFateApi(origin, browserSession, { send: f.send, makeEvents: f.makeEvents });
    await web.connect();
    const now = Date.now();
    const localClock = vi.spyOn(Date, 'now').mockReturnValue(now + 86_400_000);
    try {
      const view = await web.readSnapshot(selected);
      expect(view.header.snapshotId).toBe(snapshotId);
      expect(web.estimatedHostTime).toBeLessThan(now + 60_000);
      expect(web.lastConfirmedAt).not.toBeNull();
    } finally { localClock.mockRestore(); web.close(); }
  });

  it('records the original ID before POST completion so an in-flight reload cannot erase review', async () => {
    const f = mockClient();
    let finish!: (response: Response) => void;
    let originalId = '';
    const send: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/api/command') && String(init?.body).includes('runtime.prompt')) {
        originalId = (JSON.parse(String(init?.body)) as { requestId: string }).requestId;
        return new Promise<Response>((resolve) => { finish = resolve; });
      }
      return f.send(input, init);
    };
    const web = new WebFateApi(origin, browserSession, { send, makeEvents: f.makeEvents });
    await web.connect(); await web.readSnapshot(selected); await web.claimControl(selected);
    const pending = web.sendPrompt(selected, 'One effect only');
    await vi.waitFor(() => expect(originalId).not.toBe(''));
    const recovered = new WebFateApi(origin, browserSession, { send, makeEvents: f.makeEvents });
    expect(recovered.pendingPromptReview(selected, sessionId)).toMatchObject({ kind: 'match', value: { requestId: originalId } });
    await expect(web.sendPrompt(selected, 'One effect only')).rejects.toThrow(/previous prompt/i);
    finish(new Response(JSON.stringify({ protocol: 1, ok: true, requestId: originalId, serverEpoch: epoch,
      scope: { workspaceId, workspaceGeneration: 3 }, method: 'runtime.prompt',
      result: { requestId: originalId, durability: 'journaled', kind: 'prompt', outcome: 'accepted',
        runId: 'a0000000-0000-4000-8000-00000000000a', sessionId, viewRevision: 5 } })));
    expect((await pending).requestId).toBe(originalId);
    web.clearPendingPromptReview(); recovered.close(); web.close();
  });

  it('reviews the original prompt ID as a scoped read, never a second mutation', async () => {
     const f = mockClient();
     const web = new WebFateApi(origin, browserSession, { send: f.send, makeEvents: f.makeEvents });
     await web.connect(); await web.readSnapshot(selected); await web.claimControl(selected);
     const receipt = await web.sendPrompt(selected, 'Inspect this work');
     const status = await web.reviewPromptStatus(selected, receipt.requestId);
     expect(status.state).toBe('outcome_unknown');
     expect(f.requests.at(-1)?.body).toMatchObject({ method: 'command.status', workspaceId, workspaceGeneration: 3,
       input: { requestId: receipt.requestId } });
     expect(f.requests.filter((item) => item.body?.method === 'runtime.prompt')).toHaveLength(1);
     web.close();
   });

  it('persists only original request identity and fails closed for corrupt or mismatched recovery scope', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => { values.delete(key); } });
    const f = mockClient();
    const web = new WebFateApi(origin, browserSession, { send: f.send, makeEvents: f.makeEvents });
    const requestId = `${epoch}.1000.90000000-0000-4000-8000-000000000009`;
    web.assertPendingReviewStorageAvailable();
    web.rememberPendingPromptReview(selected, sessionId, requestId);
    const [key, raw] = [...values.entries()][0]!;
    expect(key).not.toContain(csrfToken);
    expect(raw).not.toContain('Inspect this work');
    expect(JSON.parse(raw)).toEqual({ version: 1, origin, authSessionId: sessionId, method: 'runtime.prompt', workspaceId,
      workspaceGeneration: 3, sessionId, serverEpoch: epoch, requestId });
    const afterReload = new WebFateApi(origin, browserSession, { send: f.send, makeEvents: f.makeEvents });
    expect(afterReload.pendingPromptReview(selected, sessionId)).toMatchObject({ kind: 'match', value: { requestId } });
    expect(afterReload.pendingPromptReview({ ...selected, workspaceGeneration: 4 }, sessionId)).toMatchObject({ kind: 'blocked', reason: 'mismatch',
      value: { requestId, workspaceGeneration: 3, method: 'runtime.prompt' } });
    afterReload.close();
    values.set(key, '{broken');
    expect(web.pendingPromptReview(selected, sessionId)).toEqual({ kind: 'blocked', reason: 'corrupt' });
    values.set(key, raw);
    expect(() => web.clearPendingPromptReview()).toThrow(/correlated settled or rejected/i);
    expect(web.pendingPromptReview(selected, sessionId)).toMatchObject({ kind: 'match', value: { requestId } });
    web.close();
  });

  it('uses consistent host-clock snapshot/lease fixtures and clears control only on an actual generation transition', async () => {
    const f = mockClient();
    const withClock = (hostTime: number, expiresAt: number): typeof fetch => async (input, init) => {
      const response = await f.send(input, init);
      const value = await response.json() as Record<string, unknown>;
      if (String(input).endsWith('/api/info')) value.serverTime = hostTime;
      if (value.method === 'host.info') (value.result as Record<string, unknown>).serverTime = hostTime;
      if (value.method === 'workspace.snapshot') (value.result as Record<string, unknown>).header = { ...header,
        capturedAt: hostTime, expiresAt: hostTime + 60_000 };
      if (value.method === 'control.claim') (value.result as Record<string, unknown>).expiresAt = expiresAt;
      return new Response(JSON.stringify(value), { status: response.status });
    };
    const behindHost = Date.now() - 120_000;
    const expired = new WebFateApi(origin, browserSession, { send: withClock(behindHost, behindHost - 30_000), makeEvents: f.makeEvents });
    await expired.connect(); await expired.readSnapshot(selected); await expired.claimControl(selected);
    expect(expired.control).toBeNull(); expired.close();
    const aheadHost = Date.now() + 120_000;
    const active = new WebFateApi(origin, browserSession, { send: withClock(aheadHost, aheadHost + 30_000), makeEvents: f.makeEvents });
    await active.connect(); await active.readSnapshot(selected); await active.claimControl(selected);
    expect(active.control).toBe(2);
    f.emit({ version: 1, serverEpoch: epoch, streamId, sequence: 3,
      origin: { workspaceId, workspaceGeneration: 3, sessionId }, category: 'goal', eventType: 'goal.changed' });
    expect(active.control).toBe(2); // Content changed; host lease did not.
    f.emit({ version: 1, serverEpoch: epoch, streamId, sequence: 4,
      origin: { workspaceId, workspaceGeneration: 3, sessionId }, category: 'control', eventType: 'control.changed', controlGeneration: 3 });
    expect(active.control).toBeNull(); active.close();
  });
  it('accepts its own earlier control event before ACK but refuses an ACK older than an already-observed takeover', async () => {
    for (const observed of [2, 3]) {
      const f = mockClient();
      const send: typeof fetch = async (input, init) => {
        const response = await f.send(input, init);
        const value = await response.json() as Record<string, unknown>;
        if (value.method === 'control.claim') f.emit({ version: 1, serverEpoch: epoch, streamId, sequence: 3,
          origin: { workspaceId, workspaceGeneration: 3, sessionId }, category: 'control', eventType: 'control.changed', controlGeneration: observed });
        return new Response(JSON.stringify(value), { status: response.status });
      };
      const web = new WebFateApi(origin, browserSession, { send, makeEvents: f.makeEvents });
      await web.connect(); await web.readSnapshot(selected);
      if (observed === 2) { await web.claimControl(selected); expect(web.control).toBe(2); }
      else { await expect(web.claimControl(selected)).rejects.toThrow(/Control scope changed/i); expect(web.control).toBeNull(); }
      web.close();
    }
  });

   it('reads immutable bounded pages with explicit omissions and rejects a stale page before displaying anything', async () => {
    const f = mockClient();
    const web = new WebFateApi(origin, browserSession, { send: f.send, makeEvents: f.makeEvents });
    await web.connect();
    const view = await web.readSnapshot(selected);
    expect(view.header.omissions).toMatchObject({ history: true, media: true, clippedItems: 1, queueContents: true });
    expect(view.items.map((item) => item.text)).toEqual(['Safe excerpt', 'Safe result']);
    expect(f.subscriptions).toHaveLength(1);
    expect(f.subscriptions[0]).toEqual([workspaceId, 3, header.eventStream]);
    const stale = mockClient({ secondPage: { ...second, snapshotId: epoch } });
    const other = new WebFateApi(origin, browserSession, { send: stale.send, makeEvents: stale.makeEvents });
    await other.connect();
    await expect(other.readSnapshot(selected)).rejects.toThrow(/snapshot|page/i);
    other.close(); web.close();
  });

  it('keeps Monitor scope client-bound, partial/unknown distinct, and does not reconstruct a detail ref', async () => {
    const f = mockClient();
    const web = new WebFateApi(origin, browserSession, { send: f.send, makeEvents: f.makeEvents });
    await web.connect();
    await web.readSnapshot(selected);
    const panelScope = { ...selected, sessionId, selectionRevision: 4 };
    const view = await web.readMonitor(panelScope, { section: 'runs', offset: 25, limit: 25 });
    expect(view.scope).toEqual(selected);
    expect(view.dashboard).toEqual(monitor);
    expect(view.dashboard.sources.runs).toBe('partial');
    expect(view.dashboard.sources.tasks).toBe('unknown');
    expect(view.dashboard.items[0]).not.toHaveProperty('ref');
    expect(f.requests.at(-1)?.body).toMatchObject({ method: 'workspace.monitor', workspaceId, workspaceGeneration: 3,
      expectedSessionId: sessionId, selectionRevision: 4, input: { section: 'runs', offset: 25, limit: 25 } });
    expect(f.requests.at(-1)?.body).not.toHaveProperty('projectPath');
    expect(await web.previewText(selected, '90000000-0000-4000-8000-000000000009')).toEqual({
      fileId: '90000000-0000-4000-8000-000000000009', content: 'Scoped text', truncated: false,
    });
    expect(f.requests.at(-1)?.body).toMatchObject({ method: 'file.previewText', workspaceId,
      input: { fileId: '90000000-0000-4000-8000-000000000009', maxBytes: 32_768 } });
    web.close();
  });

  it('reads only named scoped file resources and discards a response invalidated by network metadata', async () => {
    const f = mockClient();
    let finish: ((response: Response) => void) | undefined;
    let pendingId: string | undefined;
    const send: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/api/command') && String(init?.body).includes('file.previewText')) {
        pendingId = (JSON.parse(String(init?.body)) as { requestId: string }).requestId;
        return new Promise<Response>((resolve) => { finish = resolve; });
      }
      return f.send(input, init);
    };
    const web = new WebFateApi(origin, browserSession, { send, makeEvents: f.makeEvents });
    await web.connect(); await web.readSnapshot(selected);
    expect(await web.listFiles(selected, null)).toEqual({ directoryId: null, entries: [{
      resourceId: '90000000-0000-4000-8000-000000000009', name: 'notes.txt', kind: 'file',
    }], truncated: false });
    const pending = web.previewText(selected, '90000000-0000-4000-8000-000000000009');
    await vi.waitFor(() => expect(finish).toBeDefined());
    f.emit({ version: 1, serverEpoch: epoch, streamId, sequence: 3,
      origin: { workspaceId, workspaceGeneration: 3, sessionId }, category: 'pi', eventType: 'assistant.text' });
    const request = f.requests.find((entry) => entry.body?.method === 'file.list')?.body;
    expect(request).toMatchObject({ workspaceId, workspaceGeneration: 3, input: { directoryId: null, limit: 200 } });
    expect(request).not.toHaveProperty('projectPath');
    finish!(new Response(JSON.stringify({ protocol: 1, ok: true, requestId: pendingId, serverEpoch: epoch,
      scope: { workspaceId, workspaceGeneration: 3 }, method: 'file.previewText',
      result: { fileId: '90000000-0000-4000-8000-000000000009', content: 'Stale content', truncated: false } })));
    await expect(pending).rejects.toThrow(/scope changed/i);
    web.close();
  });

  it('recovers from a dropped socket with a new ticket and a fresh snapshot/replay barrier, never an automatic prompt', async () => {
    const f = mockClient();
    const laterEpoch = 'a0000000-0000-4000-8000-00000000000a';
    const laterStream = 'b0000000-0000-4000-8000-00000000000b';
    let hostEpoch = epoch;
    let connection: WebEventClient['connection'] = null;
    let drop: (() => void) | undefined;
    let socketCount = 0;
    const subscriptions: Array<{ epoch: string; cursor: SnapshotHeader['eventStream'] }> = [];
    let releaseMonitor!: () => void;
    const monitorGate = new Promise<void>((resolve) => { releaseMonitor = resolve; });
    const makeEvents = (_onEvent: (event: NetworkEvent) => void, _csrf: () => string, onDisconnect: () => void): WebEventClient => {
      drop = () => { connection = null; onDisconnect(); };
      return {
        get connection() { return connection; },
        connect: async () => { socketCount++; connection = { clientId: '80000000-0000-4000-8000-000000000008',
          serverEpoch: hostEpoch, ticket: `ft1_${String(socketCount).repeat(43)}` }; return connection; },
        subscribe: async (_id, _generation, cursor) => {
          subscriptions.push({ epoch: hostEpoch, cursor });
          return cursor!;
        },
        close: () => { connection = null; },
      };
    };
    const send: typeof fetch = async (input, init) => {
      const response = await f.send(input, init);
      if (String(init?.body).includes('workspace.monitor')) await monitorGate;
      const value = await response.json() as Record<string, unknown>;
      if (String(input).endsWith('/api/info')) value.serverEpoch = hostEpoch;
      else if (String(input).endsWith('/api/command')) {
        value.serverEpoch = hostEpoch;
        if (value.method === 'host.info') (value.result as Record<string, unknown>).serverEpoch = hostEpoch;
        if (value.method === 'workspace.snapshot') {
          const page = value.result as SnapshotPage;
          value.result = { ...page, header: { ...page.header, serverEpoch: hostEpoch,
            eventStream: { ...page.header!.eventStream!, serverEpoch: hostEpoch, streamId: hostEpoch === epoch ? streamId : laterStream } } };
        }
      }
      return new Response(JSON.stringify(value), { status: response.status });
    };
    const web = new WebFateApi(origin, browserSession, { send, makeEvents });
    await web.connect();
    await web.readSnapshot(selected);
    await web.claimControl(selected);
    const oldMonitor = web.readMonitor(selected, { section: 'runs', offset: 25, limit: 25 });
    await vi.waitFor(() => expect(f.requests.some((request) => request.body?.method === 'workspace.monitor')).toBe(true));
    drop!();
    expect(web.isConnected).toBe(false);
    expect(web.control).toBeNull();
    releaseMonitor();
    await expect(oldMonitor).rejects.toThrow(/session changed|scope changed/i);
    await expect(web.sendPrompt(selected, 'Never replay me')).rejects.toThrow(/current selected session|control/i);
    await vi.waitFor(() => expect(socketCount).toBe(2), { timeout: 3_000 });
    await vi.waitFor(() => expect(web.isConnected).toBe(true));
    await expect(web.claimControl(selected)).rejects.toThrow(/Refresh/i);
    await web.readSnapshot(selected);
    drop!();
    hostEpoch = laterEpoch;
    await vi.waitFor(() => expect(socketCount).toBe(3), { timeout: 3_000 });
    await vi.waitFor(() => expect(web.isConnected).toBe(true));
    expect(web.control).toBeNull();
    await expect(web.claimControl(selected)).rejects.toThrow(/Refresh/i);
    const fresh = await web.readSnapshot(selected);
    expect(fresh.header.serverEpoch).toBe(laterEpoch);
    expect(subscriptions.map((item) => item.cursor?.serverEpoch)).toEqual([epoch, epoch, laterEpoch]);
    expect(subscriptions[2]?.cursor?.streamId).toBe(laterStream);
    expect(f.requests.filter((item) => item.body?.method === 'runtime.prompt')).toHaveLength(0);
    expect(f.requests.filter((item) => item.body?.method === 'command.status')).toHaveLength(0);
    expect(f.requests.filter((item) => item.body?.method === 'host.info').map((item) => new Headers(item.init?.headers).get('X-Fate-Client-Ticket')))
      .toEqual([`ft1_${'1'.repeat(43)}`, `ft1_${'2'.repeat(43)}`, `ft1_${'3'.repeat(43)}`]);
    web.close();
  });

  it('ends an exhausted reconnect burst visibly and cancels pending retries on close', async () => {
    const f = mockClient();
    let connected = false;
    let disconnect: (() => void) | undefined;
    let attempts = 0;
    const makeEvents = (_event: (event: NetworkEvent) => void, _csrf: () => string, onDisconnect: () => void): WebEventClient => {
      disconnect = () => { connected = false; onDisconnect(); };
      return { get connection() { return connected ? { clientId: sessionId, serverEpoch: epoch, ticket: `ft1_${'t'.repeat(43)}` } : null; },
        connect: async () => { attempts++; if (attempts > 1) throw new Error('Socket unavailable.'); connected = true;
          return { clientId: sessionId, serverEpoch: epoch, ticket: `ft1_${'t'.repeat(43)}` }; },
        subscribe: async (_id, _generation, cursor) => cursor!, close: () => { connected = false; } };
    };
    const web = new WebFateApi(origin, browserSession, { send: f.send, makeEvents });
    await web.connect(); await web.readSnapshot(selected);
    disconnect!();
    await vi.waitFor(() => expect(web.reconnectError).toMatch(/three attempts/), { timeout: 5_000 });
    expect(attempts).toBe(4); // Initial connection plus exactly three recovery attempts.
    expect(web.isConnected).toBe(false);
    await expect(web.claimControl(selected)).rejects.toThrow(/unavailable/i);
    web.close();
  });

  it('fails closed for unsupported FateApi operations; metadata only invalidates and never becomes PiEvent', async () => {
    const f = mockClient();
    const web = new WebFateApi(origin, browserSession, { send: f.send, makeEvents: f.makeEvents });
    await web.connect();
    const uninstall = installWebFateApi(web);
    expect(getDesktopApiOptional()).toBeUndefined();
    expect(getWebApiOptional()).toBe(web);
    await expect(getFateApi().prompt({ text: 'Do not run', behavior: 'prompt', images: [] })).rejects.toThrow(/not supported/i);
    await expect(getFateApi().getRuntimeState()).rejects.toThrow(/not supported/i);
    expect(() => getFateApi().onEvents(() => { throw new Error('PiEvent callback must never run'); })).toThrow(/not supported/i);
    expect(f.requests.map((request) => request.body?.method).filter(Boolean)).not.toContain('runtime.prompt');
    const invalidated = vi.fn();
    web.onInvalidate(invalidated);
    await web.readSnapshot(selected);
    f.emit({ version: 1, serverEpoch: epoch, streamId, sequence: 3,
      origin: { workspaceId, workspaceGeneration: 3, sessionId }, category: 'pi', eventType: 'assistant.text' });
    expect(invalidated).toHaveBeenCalledOnce();
    uninstall(); web.close();
  });
});
