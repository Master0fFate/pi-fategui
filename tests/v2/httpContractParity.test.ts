import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAuthenticatedServerContext } from '../../src/core/dispatch/RequestContext';
import type { FateCore } from '../../src/core/FateCore';
import type { WorkspaceHandle } from '../../src/core/workspaces/WorkspaceHandle';
import type { CommandJournal } from '../../src/core/commands/CommandJournal';
import type { ClientTickets } from '../../src/server/auth/ClientTickets';
import { createNetworkDispatcher } from '../../src/server/http/NetworkDispatcher';
import { createMutationIdentity } from '../../src/shared/protocol/requestIds';
import { responseEnvelopeSchema } from '../../src/shared/protocol/envelopes';

const epoch = '10000000-0000-4000-8000-000000000001';
const workspaceId = '20000000-0000-4000-8000-000000000002';
const principalId = '30000000-0000-4000-8000-000000000003';
const clientId = '40000000-0000-4000-8000-000000000004';
const sessionId = '50000000-0000-4000-8000-000000000005';
const root = path.resolve('host-registered-fixture');
const now = 1_800_000_000_000;
const createContext = createAuthenticatedServerContext({ principalId, clientId, expiresAt: now + 60_000 }, null);
const request = (method: string, input: object, scoped = false) => ({ protocol: 1, requestId: '60000000-0000-4000-8000-000000000006', serverEpoch: epoch,
  issuedAt: now, method, input, ...(scoped ? { workspaceId, workspaceGeneration: 3 } : {}) });

function fixture() {
  let allowed = true;
  let generation = 3;
  let resolveRead: (() => void) | null = null;
  const pendingRead = new Promise<void>((resolve) => { resolveRead = resolve; });
  const identity = createContext;
  const files = {
    getRoot: () => root,
    assertBoundRootIdentity: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ path: '', entries: [{ path: 'note.txt', name: 'note.txt', kind: 'file' }], truncated: false })),
    read: vi.fn(async () => { await pendingRead; return { state: 'text', content: 'private fixture text' }; }),
  };
  const handle = { root, id: workspaceId, generation: 3, files, runtime: {},
    admission: { snapshot: () => ({ selectedSessionId: sessionId, selectionRevision: 0 }) } } as unknown as WorkspaceHandle;
  const core = {
    workspaces: { resolve: (_identity: unknown, id: string, expected: number) => {
      if (!allowed || id !== workspaceId || expected !== generation || generation !== handle.generation) throw new Error('No current membership');
      return handle;
    } },
    runtime: { workspaceOrigin: (target: string) => target === root ? { workspaceId, workspaceGeneration: generation } : null,
      peekWorkspace: (target: string) => target === root ? handle.runtime : null },
    sessionPermissions: { assertHealthy: () => undefined },
  } as unknown as FateCore;
  const tickets = {
    isLive: (context: unknown) => context === identity && allowed,
    isMember: (context: unknown, target: string) => context === identity && target === root && allowed,
    verify: (ticket: string) => { if (ticket !== 'server-issued-ticket' || !allowed) throw new Error('Invalid ticket'); return identity; },
  } as unknown as ClientTickets;
  const journal = { status: vi.fn(async () => ({ state: 'not-found' })),
    execute: vi.fn(async (_request: unknown, _principal: string, _effect: unknown, recheck: () => void) => {
      recheck();
      throw new Error('An observer must not reach the journal effect.');
    }),
  } as unknown as CommandJournal;
  const service = createNetworkDispatcher({ core, tickets, journal, serverEpoch: epoch, registeredRoots: [root],
    hostId: principalId, appVersion: '1.1.0', now: () => now });
  const dispatch = (value: unknown) => service.dispatcher.dispatchJson(JSON.stringify(value), identity);
  return { service, files, journal, dispatch, releaseRead: () => resolveRead?.(), revoke: () => { allowed = false; },
    changeGeneration: () => { generation = 4; } };
}

describe('HTTP read contract through the shared dispatcher', () => {
  it('uses the same bounded protocol DTOs for host, workspace, and file reads; never emits host paths', async () => {
    const f = fixture();
    const host = await f.dispatch(request('host.info', {}));
    const workspaces = await f.dispatch(request('workspace.list', {}));
    const list = await f.dispatch(request('file.list', { directoryId: null, limit: 10 }, true));
    expect(host).toMatchObject({ ok: true, result: { networkDispatchEnabled: true } });
    expect(workspaces).toMatchObject({ ok: true, result: { workspaces: [{ workspaceId, workspaceGeneration: 3 }] } });
    expect(list).toMatchObject({ ok: true, result: { directoryId: null, entries: [{ name: 'note.txt', kind: 'file' }] } });
    if (!list.ok || list.method !== 'file.list') throw new Error('Expected file.list result');
    const preview = f.dispatch(request('file.previewText', { fileId: list.result.entries[0]!.resourceId, maxBytes: 100 }, true));
    f.releaseRead();
    expect(await preview).toMatchObject({ ok: true, result: { content: 'private fixture text' } });
    for (const result of [host, workspaces, list, await preview]) {
      expect(responseEnvelopeSchema.safeParse(result).success).toBe(true);
      expect(JSON.stringify(result)).not.toContain(root);
    }
  });

  it('rejects caller identity, raw paths, guessed resource IDs and observer mutations before effects', async () => {
    const f = fixture();
    expect(await f.dispatch({ ...request('file.list', { directoryId: null, limit: 10 }, true), path: root })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(await f.dispatch({ ...request('host.info', {}), clientId })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(await f.dispatch(request('file.previewText', { fileId: sessionId, maxBytes: 100 }, true))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const mutation = { ...request('runtime.prompt', { text: 'Do not run.' }, true), ...createMutationIdentity(epoch, now),
      expectedSessionId: sessionId, selectionRevision: 0, controlGeneration: 1 };
    expect(await f.dispatch(mutation)).toMatchObject({ ok: false, error: { code: 'CONTROL_REQUIRED' }, execution: 'not-started' });
    expect(f.files.read).not.toHaveBeenCalled();
    expect(f.journal.status).not.toHaveBeenCalled();
  });

  it('withholds an in-flight read on ticket revocation or replacement workspace generation', async () => {
    for (const change of ['revoke', 'changeGeneration'] as const) {
      const f = fixture();
      const list = await f.dispatch(request('file.list', { directoryId: null, limit: 1 }, true));
      if (!list.ok || list.method !== 'file.list') throw new Error('Expected list');
      const pending = f.dispatch(request('file.previewText', { fileId: list.result.entries[0]!.resourceId, maxBytes: 100 }, true));
      // The first bound-root check yields, then the read waits on the test barrier.
      await vi.waitFor(() => expect(f.files.read).toHaveBeenCalledOnce());
      f[change]();
      f.releaseRead();
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('private fixture text');
    }
  });

  it('rejects invalid and oversized domain output rather than leaking raw handler data', async () => {
    const f = fixture();
    f.files.list.mockResolvedValueOnce({ path: '', entries: [{ path: 'secret', name: 'bad/name', kind: 'file' }], truncated: false });
    const filtered = await f.dispatch(request('file.list', { directoryId: null, limit: 1 }, true));
    expect(filtered).toMatchObject({ ok: true, result: { entries: [] } });
    f.files.list.mockResolvedValueOnce({ path: '', entries: Array.from({ length: 2000 }, (_, i) => ({ path: String(i), name: String(i), kind: 'file' })), truncated: true });
    const bounded = await f.dispatch(request('file.list', { directoryId: null, limit: 2 }, true));
    expect(bounded).toMatchObject({ ok: true, result: { truncated: true } });
    if (bounded.ok && bounded.method === 'file.list') expect(bounded.result.entries).toHaveLength(2);
  });

  it('rejects an invalid domain result with a bounded error, not raw host data', async () => {
    const f = fixture();
    const invalid = createNetworkDispatcher({ core: {
      workspaces: { resolve: () => { throw new Error('closed'); } }, runtime: { workspaceOrigin: () => null },
      sessionPermissions: { assertHealthy: () => undefined },
    } as unknown as FateCore, tickets: {
      isLive: (context: unknown) => context === createContext,
      isMember: () => false,
    } as unknown as ClientTickets, journal: f.journal,
      serverEpoch: epoch, registeredRoots: [root], hostId: 'not-a-uuid-private-host-path', appVersion: '1.1.0', now: () => now });
    const result = await invalid.dispatcher.dispatchJson(JSON.stringify(request('host.info', {})), createContext);
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' }, execution: 'not-started' });
    expect(JSON.stringify(result)).not.toContain('private-host-path');
  });

  it('accepts a verified ticket at the route boundary, but cannot mint identity from JSON', async () => {
    const f = fixture();
    const principal = { kind: 'client', principalId, clientId, workspaceRoots: [root], expiresAt: now + 60_000 } as const;
    expect(await f.service.onCommand(JSON.stringify(request('host.info', {})), principal, 'server-issued-ticket', null)).toMatchObject({ ok: true });
  });
});
