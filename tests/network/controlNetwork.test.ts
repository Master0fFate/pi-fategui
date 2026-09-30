import { createServer as createNetServer } from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFateCore } from '../../src/core/createFateCore';
import { ownerCredentialPath } from '../../src/server/auth/AuthStore';
import { startAuthenticatedNodeServerWithFactory } from '../../src/server/http/startAuthenticatedNodeServer';
import { MultiProjectPiRuntime } from '../../src/main/pi/MultiProjectPiRuntime';
import { createMutationIdentity } from '../../src/shared/protocol/requestIds';
import { responseEnvelopeSchema } from '../../src/shared/protocol/envelopes';
import { FakePiSdkAdapter, type NamedBarriers } from '../v2/helpers/fakePi';
import { privateTestRoot } from '../v2/helpers/isolatedEnvironment';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }))); });
async function freePort(): Promise<number> {
  const probe = createNetServer();
  return new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    if (!address || typeof address === 'string') { probe.close(); reject(new Error('No test port')); return; }
    probe.close(() => resolve(address.port));
  }).once('error', reject));
}
function message(socket: WebSocket): Promise<{ type: string; ticket: string; clientId: string; serverEpoch: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Event first frame timed out.')), 3_000);
    socket.once('message', (bytes) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(bytes.toString('utf8')) as { type: string; ticket: string; clientId: string; serverEpoch: string }); }
      catch (error) { reject(error); }
    });
  });
}
async function connected(url: string, cookie: string, csrf: string) {
  const socket = new WebSocket(`${url.replace('http:', 'ws:')}/api/events`, { headers: { Cookie: cookie, Origin: url }, perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const ready = message(socket);
  socket.send(JSON.stringify({ protocol: 1, type: 'hello', csrf }));
  const frame = await ready;
  if (frame.type !== 'ready') throw new Error('Ticket was not issued.');
  return { socket, ...frame };
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(privateTestRoot(), 'network-control-')); roots.push(root);
  const home = path.join(root, 'home'); const workspace = path.join(root, 'workspace');
  await fs.mkdir(home); await fs.mkdir(workspace);
  const port = await freePort();
  const adapter = new FakePiSdkAdapter();
  const server = await startAuthenticatedNodeServerWithFactory({ profile: { profileId: 'control', home }, workspaces: [workspace],
    host: '127.0.0.1', port, flags: { terminal: false, browser: false }, maxPermission: 'edit' },
  (options) => createFateCore({ ...options, adapter,
    createRuntime: (deps) => new MultiProjectPiRuntime({ ...deps,
      createSessionTitleGenerator: () => ({ generate: async () => null }) }) }));
  const url = `http://127.0.0.1:${port}`;
  const owner = await fs.readFile(ownerCredentialPath(server.core.paths), 'utf8');
  const bootstrap = await server.auth.createBootstrapCode(owner);
  const login = await fetch(`${url}/api/auth/exchange`, { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: bootstrap.code }) });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  const response = await login.json() as { session: { csrfToken: string } };
  if (!cookie || login.status !== 200) throw new Error('Browser test authentication failed.');
  const csrf = response.session.csrfToken;
  return { server, adapter, workspace, url, cookie, csrf,
    command: async (ticket: string, body: unknown) => {
      const result = await fetch(`${url}/api/command`, { method: 'POST', headers: { Cookie: cookie, Origin: url,
        'Content-Type': 'application/json', 'X-Fate-Csrf': csrf, 'X-Fate-Client-Ticket': ticket }, body: JSON.stringify(body) });
      expect(result.status).toBe(200);
      return responseEnvelopeSchema.parse(await result.json() as unknown);
    } };
}

describe('T36 control through the authenticated command route', () => {
  it('uses distinct server-created socket tickets and fences observer writes, takeover, release, and disconnect', async () => {
    const f = await fixture();
    let first: Awaited<ReturnType<typeof connected>> | null = null;
    let second: Awaited<ReturnType<typeof connected>> | null = null;
    let turnBarriers: NamedBarriers | undefined;
    let releaseCheckpoint: () => void = () => undefined;
    try {
      first = await connected(f.url, f.cookie, f.csrf);
      second = await connected(f.url, f.cookie, f.csrf);
      expect(first.clientId).not.toBe(second.clientId);
      const list = await f.command(first.ticket, { protocol: 1, method: 'workspace.list', input: {},
        requestId: crypto.randomUUID(), issuedAt: Date.now(), serverEpoch: first.serverEpoch });
      expect(list.ok).toBe(true);
      if (!list.ok || list.method !== 'workspace.list') throw new Error('Expected authenticated workspace metadata.');
      const workspaceScope = list.result.workspaces[0];
      if (!workspaceScope) throw new Error('No registered workspace.');
      expect(workspaceScope.label).toBe('Workspace 1');
      expect(JSON.stringify(list)).not.toContain(f.workspace);
      const scoped = (method: string, input: object = {}) => ({ protocol: 1, method, input,
        workspaceId: workspaceScope.workspaceId, workspaceGeneration: workspaceScope.workspaceGeneration,
        requestId: crypto.randomUUID(), issuedAt: Date.now(), serverEpoch: first!.serverEpoch });
      const claim = await f.command(first.ticket, scoped('control.claim'));
      expect(claim).toMatchObject({ ok: true, result: { generation: 1 } });
      expect(await f.command(second.ticket, scoped('control.claim'))).toMatchObject({ ok: false, error: { code: 'CONTROL_REQUIRED' } });
      expect(await f.command(second.ticket, scoped('control.takeover'))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
      expect(await f.command(second.ticket, scoped('control.renew', { generation: 1 }))).toMatchObject({ ok: false, error: { code: 'CONTROL_REQUIRED' } });
      const sessionId = f.server.core.runtime.peekWorkspace(f.workspace)?.getState(false).sessionId;
      if (!sessionId) throw new Error('No bound runtime session.');
      const selectionRevision = (await f.server.core.workspaces!.registerHostPath(f.workspace)).admission.snapshot().selectionRevision;
      const mutation = { ...scoped('runtime.prompt', { text: 'A ticket-bound test turn.' }),
        ...createMutationIdentity(first.serverEpoch), expectedSessionId: sessionId, selectionRevision, controlGeneration: 1 };
      const observer = { ...mutation, ...createMutationIdentity(first.serverEpoch) };
      expect(await f.command(second.ticket, observer)).toMatchObject({ ok: false, error: { code: 'CONTROL_REQUIRED' }, execution: 'not-started' });
      turnBarriers = f.adapter.controls.get(sessionId)?.barriers;
      if (!turnBarriers) throw new Error('No deterministic runtime barriers for the captured session.');
      turnBarriers.hold('emit');
      const checkpointGate = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
      const append = f.server.core.recovery.repository.append.bind(f.server.core.recovery.repository);
      const checkpoint = vi.spyOn(f.server.core.recovery.repository, 'append').mockImplementation(async (...args) => {
        await checkpointGate; return append(...args);
      });
      const pending = f.command(first.ticket, mutation);
      await Promise.race([
        turnBarriers.reached('emit'), // The real run.started observer has scheduled its checkpoint.
        pending.then((response) => { throw new Error(`Prompt returned before its deterministic admission barrier: ${JSON.stringify(response)}`); }),
      ]);
      expect(checkpoint).toHaveBeenCalled();
      expect(f.server.core.recovery.admissionsAllowed).toBe(false);
      const accepted = await pending;
      expect(accepted).toMatchObject({ ok: true, requestId: mutation.requestId,
        scope: { workspaceId: workspaceScope.workspaceId, workspaceGeneration: workspaceScope.workspaceGeneration },
        result: { requestId: mutation.requestId, sessionId, kind: 'prompt', durability: 'journaled', outcome: 'accepted' } });
      expect(await f.command(first.ticket, mutation)).toEqual(accepted);
      expect(await f.command(first.ticket, scoped('command.status', { requestId: mutation.requestId })))
        .toMatchObject({ ok: true, result: { state: 'settled', receipt: { requestId: mutation.requestId, sessionId, outcome: 'accepted' } } });
      // Pending lifecycle persistence still fences a NEW effect, not the admitted turn's delivery.
      expect(await f.command(first.ticket, { ...mutation, ...createMutationIdentity(first.serverEpoch) }))
        .toMatchObject({ ok: false, execution: 'not-started', operationId: null });
      expect(f.adapter.invocations.filter((entry) => entry.kind === 'prompt')).toHaveLength(1);
      releaseCheckpoint(); await f.server.core.recovery.flush(); checkpoint.mockRestore();
      turnBarriers.release('emit');
      await vi.waitFor(() => expect(f.adapter.invocations.some((entry) => entry.kind === 'settled' && entry.sessionId === sessionId)).toBe(true));
      await f.server.core.recovery.flush();
      const runtime = f.server.core.runtime.peekWorkspace(f.workspace)!;
      await vi.waitFor(() => expect(runtime.getState(false).activeSessionRunning).toBe(false));
      expect(await f.command(first.ticket, scoped('control.renew', { generation: 1 }))).toMatchObject({ ok: true, result: { generation: 1 } });
      await runtime.setPermissionLevel('read-only');
      const grantTransaction = vi.spyOn(runtime, 'setPermissionLevel');
      const approval = { sessionId, action: 'runtime.setPermission', oldLevel: 'read-only', newLevel: 'edit' };
      const approvalScope = { workspaceId: workspaceScope.workspaceId,
        workspaceGeneration: workspaceScope.workspaceGeneration, selectionRevision, controlGeneration: 1 };
      const issued = await f.command(first.ticket, { ...scoped('permission.issue', approval), ...approvalScope });
      expect(issued).toMatchObject({ ok: true, result: { oldLevel: 'read-only', newLevel: 'edit', sessionId } });
      if (!issued.ok || issued.method !== 'permission.issue') throw new Error('Permission nonce was not issued.');
      const challengeId = issued.result.challengeId;
      const confirm = { ...scoped('permission.confirm', { ...approval, challengeId }), ...approvalScope,
        ...createMutationIdentity(first.serverEpoch) };
      expect(await f.command(first.ticket, confirm)).toMatchObject({ ok: true, requestId: confirm.requestId,
        result: { applied: true, sessionId, level: 'edit' } });
      expect(await f.command(first.ticket, scoped('command.status', { requestId: confirm.requestId })))
        .toMatchObject({ ok: true, result: { state: 'settled', receipt: { kind: 'permission', requestId: confirm.requestId,
          durability: 'journaled', outcome: 'applied', sessionId, challengeId, ...approvalScope, oldLevel: 'read-only', newLevel: 'edit' } } });
      expect(await f.server.core.sessionPermissions.get(f.workspace, sessionId)).toBe('edit');
      expect(grantTransaction).toHaveBeenCalledTimes(1);
      expect(await f.command(first.ticket, { ...confirm, ...createMutationIdentity(first.serverEpoch) }))
        .toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
      expect(await f.command(first.ticket, { ...scoped('permission.issue', { ...approval, oldLevel: 'edit', newLevel: 'full-access' }), ...approvalScope }))
        .toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
      expect(runtime.getState(false).permissionLevel).toBe('edit');
      expect(await f.command(first.ticket, { ...scoped('control.release', { generation: 1 }), ownerId: first.clientId }))
        .toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
      expect(await f.command(first.ticket, { ...scoped('control.renew', { generation: 1 }), maxPermission: 'full-access' }))
        .toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
      const closed = new Promise<void>((resolve) => { first!.socket.once('close', () => resolve()); });
      first.socket.close(); await closed;
      // The server callback revokes exactly the ticket-backed client's lease. It does not abort a run.
      await vi.waitFor(async () => expect(await f.command(second!.ticket, scoped('control.claim')))
        .toMatchObject({ ok: true, result: { generation: 3 } }));
      expect(await f.command(second.ticket, scoped('control.release', { generation: 3 })))
        .toMatchObject({ ok: true, result: { generation: 4, expiresAt: null } });
    } finally {
      releaseCheckpoint(); turnBarriers?.releaseAll();
      first?.socket.terminate(); second?.socket.terminate();
      expect((await f.server.stop()).status).toBe('settled'); await f.adapter.dispose();
    }
  });
});
