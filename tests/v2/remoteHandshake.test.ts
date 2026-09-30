import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RemoteHandshake } from '../../src/main/connections/RemoteHandshake';
import { methodCatalog } from '../../src/shared/protocol/methods';
import path from 'node:path';
import { requestEnvelopeSchema, responseEnvelopeSchema } from '../../src/shared/protocol/envelopes';
import { RemoteCoreClient } from '../../src/main/connections/RemoteCoreClient';
import type { NativeEvents } from '../../src/main/connections/NativeEventTransport';

const pin = { hostId: randomUUID(), workspaceId: randomUUID(), workspaceGeneration: 2 };
function fixture() {
  const epoch = randomUUID();
  const info = { hostId: pin.hostId, hostName: 'Fixture host', protocol: 1, serverEpoch: epoch, serverTime: Date.now(),
    appVersion: '1.1.0', networkDispatchEnabled: true, capabilities: ['host.info', 'workspace.list', 'workspace.snapshot'],
    readiness: { ready: true, profileLock: 'held', workspaceRegistry: 'ready', permissionStore: 'healthy', commandJournal: 'healthy',
      authentication: 'ready', requiredServices: 'ready', provider: 'auth-required' } };
  const workspace = { workspaceId: pin.workspaceId, workspaceGeneration: 2, label: 'Pinned workspace' };
  return { epoch, info, workspace, endpoint: { info: async () => info, workspaces: async () => ({ workspaces: [workspace] }) } };
}

describe('SSH authenticated readiness unit seams; not remote acceptance', () => {
  it('accepts healthy pinned host/epoch/workspace and exposes provider setup separately', async () => {
    const f = fixture(), handshake = new RemoteHandshake();
    const result = await handshake.verify(pin, f.epoch, f.endpoint, () => true);
    expect(result.workspace).toEqual(f.workspace); expect(result.info.readiness?.provider).toBe('auth-required');
  });
  it('retains M4 host.info schema compatibility but SSH refuses absent readiness', async () => {
    const f = fixture(); const { readiness: _readiness, ...legacy } = f.info;
    expect(methodCatalog['host.info'].wireResultSchema.safeParse(legacy).success).toBe(true);
    await expect(new RemoteHandshake().verify(pin, f.epoch, { ...f.endpoint, info: async () => legacy }, () => true)).rejects.toMatchObject({ code: 'profile-unhealthy' });
  });
  it.each(['identity', 'epoch', 'protocol', 'profile', 'workspace'] as const)('rejects %s mismatch before snapshot/control', async (kind) => {
    const f = fixture();
    const info = kind === 'identity' ? { ...f.info, hostId: randomUUID() } : kind === 'epoch' ? { ...f.info, serverEpoch: randomUUID() }
      : kind === 'protocol' ? { ...f.info, protocol: 2 } : kind === 'profile' ? { ...f.info, readiness: { ...f.info.readiness, commandJournal: 'unhealthy' } } : f.info;
    const workspace = kind === 'workspace' ? { ...f.workspace, workspaceGeneration: 3 } : f.workspace;
    await expect(new RemoteHandshake().verify(pin, f.epoch, { info: async () => info, workspaces: async () => ({ workspaces: [workspace] }) }, () => true)).rejects.toThrow();
  });
  it('does not accept the late reply after cancellation', async () => {
    const f = fixture(), handshake = new RemoteHandshake(); let finish!: (value: unknown) => void;
    const pending = handshake.verify(pin, f.epoch, { ...f.endpoint, info: () => new Promise((resolve) => { finish = resolve; }) }, () => true);
    handshake.close(); finish(f.info); await expect(pending).rejects.toMatchObject({ code: 'connection-canceled' });
  });
  it('does not accept the old reply after a newer handshake', async () => {
    const f = fixture(), handshake = new RemoteHandshake(); let finish!: (value: unknown) => void;
    const pending = handshake.verify(pin, f.epoch, { ...f.endpoint, info: () => new Promise((resolve) => { finish = resolve; }) }, () => true);
    await handshake.verify(pin, f.epoch, f.endpoint, () => true); finish(f.info);
    await expect(pending).rejects.toMatchObject({ code: 'connection-canceled' });
  });
  it('refuses a renderer document that changed during workspace discovery', async () => {
    const f = fixture(); let live = true;
    await expect(new RemoteHandshake().verify(pin, f.epoch, { ...f.endpoint, workspaces: async () => { live = false; return { workspaces: [f.workspace] }; } }, () => live))
      .rejects.toMatchObject({ code: 'connection-canceled' });
  });
  it('binds the SSH workspace before snapshot and sends main-owned remote Host on HTTP', async () => {
    const f = fixture(), headerValues: Array<string | null> = [];
    const connection = { clientId: randomUUID(), serverEpoch: f.epoch, ticket: `ft1_${'a'.repeat(43)}` };
    const events: NativeEvents = { connection, connect: async () => connection, subscribe: async (_id, _generation, cursor) => cursor, close: () => undefined };
    const send: typeof fetch = async (_input, init) => {
      headerValues.push(new Headers(init?.headers).get('Host'));
      const request = requestEnvelopeSchema.parse(JSON.parse(String(init?.body)) as unknown);
      const result = request.method === 'host.info' ? f.info : { workspaces: [f.workspace] };
      return new Response(JSON.stringify(responseEnvelopeSchema.parse({ protocol: 1, ok: true, requestId: request.requestId,
        serverEpoch: f.epoch, scope: null, method: request.method, result })), { status: 200 });
    };
    const client = new RemoteCoreClient({ id: randomUUID(), approved: true, label: 'Fixture host', hostId: pin.hostId,
      baseUrl: 'http://127.0.0.1:49331', credentialRef: path.join(process.env.FATE_V2_TEST_ROOT!, 'client-key') }, `fc1_${'b'.repeat(43)}`, 7,
    () => undefined, [], { send, makeEvents: () => events, outcomeStorage: true, saveOutcomes: async () => undefined,
      forwardedHost: '127.0.0.1:49332', handshake: pin });
    try {
      await client.connect(() => true); expect(client.state.scope).toMatchObject({ workspaceId: pin.workspaceId, workspaceGeneration: 2, serverEpoch: f.epoch });
      expect(client.state.providerStatus).toBe('auth-required'); expect(headerValues).toEqual(['127.0.0.1:49332', '127.0.0.1:49332']);
      await expect(client.readSnapshot({ ...f.workspace, workspaceGeneration: 3 })).rejects.toMatchObject({ code: 'workspace-mismatch' });
    } finally { client.close(); }
  });
});

it.each(['host.info', 'workspace.list'] as const)('refuses a late %s handshake result after event loss', async (stage) => {
  const f = fixture(); let lost: (() => void) | undefined;
  let connection: NativeEvents['connection'] = { clientId: randomUUID(), serverEpoch: f.epoch, ticket: `ft1_${'a'.repeat(43)}` };
  const events: NativeEvents = { get connection() { return connection; }, connect: async () => connection!,
    subscribe: async (_id, _generation, cursor) => cursor, close: () => { connection = null; } };
  const send: typeof fetch = async (_input, init) => {
    const request = requestEnvelopeSchema.parse(JSON.parse(String(init?.body)) as unknown);
    if (request.method === stage) { connection = null; lost!(); }
    return new Response(JSON.stringify(responseEnvelopeSchema.parse({ protocol: 1, ok: true, requestId: request.requestId,
      serverEpoch: f.epoch, scope: null, method: request.method, result: request.method === 'host.info' ? f.info : { workspaces: [f.workspace] } })), { status: 200 });
  };
  const client = new RemoteCoreClient({ id: randomUUID(), approved: true, label: 'Fixture host', hostId: pin.hostId,
    baseUrl: 'http://127.0.0.1:49331', credentialRef: path.join(process.env.FATE_V2_TEST_ROOT!, 'client-key') }, `fc1_${'b'.repeat(43)}`, 7,
    () => undefined, [], { send, makeEvents: (_onEvent, onLost) => { lost = onLost; return events; }, handshake: pin });
  try {
    await client.connect(() => true);
    expect(client.state.status).not.toBe('observing'); expect(client.state.message).not.toBe('ready'); expect(client.state.scope).toBeNull();
  } finally { client.close(); }
});
