import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createFateCore } from '../../src/core/createFateCore';
import { OwnerLock, OwnershipConflict, canonicalFuturePath } from '../../src/core/ownership/OwnerLock';
import { hostCheckoutLockRoot } from '../../src/core/ownership/CheckoutOwnership';
import { CommandJournal } from '../../src/core/commands/CommandJournal';
import { ownerCredentialPath } from '../../src/server/auth/AuthStore';
import { startAuthenticatedNodeServerWithFactory } from '../../src/server/http/startAuthenticatedNodeServer';
import { MultiProjectPiRuntime } from '../../src/main/pi/MultiProjectPiRuntime';
import { createMutationIdentity } from '../../src/shared/protocol/requestIds';
import { responseEnvelopeSchema } from '../../src/shared/protocol/envelopes';
import { FakePiSdkAdapter } from '../v2/helpers/fakePi';
import { privateTestRoot } from '../v2/helpers/isolatedEnvironment';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 3 })));
});
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Missing private port.');
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
const readySchema = z.object({ type: z.literal('ready'), ticket: z.string(), clientId: z.string().uuid(), serverEpoch: z.string().uuid() }).passthrough();

for (const backend of ['legacy-json', 'native-durable'] as const) {
  describe(`[${backend}] real HTTP grant and journal shutdown ownership`, () => {
    for (const held of ['permission-intent', 'journal-receipt'] as const) {
      it(`keeps both owners until the admitted ${held} and complete HTTP handler settle`, async () => {
        const root = await fs.mkdtemp(path.join(privateTestRoot(), 'request-drain-'));
        const home = path.join(root, 'home'), requestedWorkspace = path.join(root, 'project');
        await fs.mkdir(home, { mode: 0o700 }); await fs.mkdir(requestedWorkspace, { mode: 0o700 });
        const workspace = await fs.realpath(requestedWorkspace);
        const adapter = new FakePiSdkAdapter();
        const server = await startAuthenticatedNodeServerWithFactory({ statePersistence: backend,
          profile: { profileId: 'drain', home }, workspaces: [workspace], host: '127.0.0.1', port: await freePort(),
          flags: { terminal: false, browser: false }, maxPermission: 'edit' },
        (options) => createFateCore({ ...options, adapter, createRuntime: (deps) => new MultiProjectPiRuntime({ ...deps,
          createSessionTitleGenerator: () => ({ generate: async () => null }) }) }));
        let socket: WebSocket | undefined;
        const reached = barrier(), resume = barrier();
        let blockTaken = false, lateWrites = 0, releasedOwner = false, receiptCommitted = false;
        let requestFinished: Promise<unknown> | undefined;
        const profileResource = await canonicalFuturePath(path.dirname(server.core.paths.dataRoot));
        const originalOpen = fs.open.bind(fs), originalRename = fs.rename.bind(fs), originalRelease = OwnerLock.prototype.release;
        const normalize = (name: string) => process.platform === 'win32' ? name.toLowerCase() : name;
        try {
          const owner = await fs.readFile(ownerCredentialPath(server.core.paths), 'utf8');
          const credential = await server.auth.issueClientCredential(owner, [workspace]);
          const url = `http://127.0.0.1:${server.http.port}`;
          socket = new WebSocket(`${url.replace('http:', 'ws:')}/api/events`, { headers: { Authorization: `Bearer ${credential.credential}` }, perMessageDeflate: false });
          const ws = socket;
          await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
          const first = new Promise<z.infer<typeof readySchema>>((resolve, reject) => {
            ws.once('message', (bytes) => { try { resolve(readySchema.parse(JSON.parse(bytes.toString('utf8')))); } catch (error) { reject(error); } });
          });
          ws.send(JSON.stringify({ protocol: 1, type: 'hello' }));
          const ready = await first;
          const handle = await server.core.workspaces!.registerHostPath(workspace);
          const sessionId = handle.runtime.getState(false).sessionId;
          if (!sessionId) throw new Error('Missing actual selected session.');
          const scope = { protocol: 1, workspaceId: handle.id, workspaceGeneration: handle.generation,
            serverEpoch: ready.serverEpoch, issuedAt: Date.now() };
          const send = async (value: unknown) => {
            const result = await fetch(`${url}/api/command`, { method: 'POST', headers: {
              Authorization: `Bearer ${credential.credential}`, 'Content-Type': 'application/json', 'X-Fate-Client-Ticket': ready.ticket,
            }, body: JSON.stringify(value) });
            expect(result.status).toBe(200);
            return responseEnvelopeSchema.parse(await result.json());
          };
          const claim = await send({ ...scope, method: 'control.claim', requestId: randomUUID(), input: {} });
          if (!claim.ok || claim.method !== 'control.claim') throw new Error('No real control grant.');
          const target = { sessionId, action: 'runtime.setPermission', oldLevel: 'edit', newLevel: 'read-only' };
          const scoped = { ...scope, selectionRevision: handle.admission.snapshot().selectionRevision, controlGeneration: claim.result.generation };
          const challenge = await send({ ...scoped, method: 'permission.issue', requestId: randomUUID(), input: target });
          if (!challenge.ok || challenge.method !== 'permission.issue') throw new Error('No real permission challenge.');
          const confirm = { ...scoped, ...createMutationIdentity(ready.serverEpoch), method: 'permission.confirm',
            input: { ...target, challengeId: challenge.result.challengeId } };
          const journalRoot = path.join(server.core.paths.dataRoot, 'commands', 'v1');
          const journalFile = path.join(journalRoot, `${createHash('sha256').update(confirm.requestId).digest('hex')}.json`);
          const intentFile = path.join(server.core.paths.dataRoot, 'session-permissions.intent.json');
          vi.spyOn(OwnerLock.prototype, 'release').mockImplementation(async function (this: OwnerLock) {
            if (blockTaken && [profileResource, workspace].some((value) => normalize(value) === normalize(this.record.resource))) {
              expect(receiptCommitted).toBe(true);
              releasedOwner = true;
            }
            await originalRelease.call(this);
          });
          vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
            if (args[0] === intentFile && args[1] === 'wx') {
              if (releasedOwner) lateWrites++;
              if (held === 'permission-intent' && !blockTaken) { blockTaken = true; reached.release(); await resume.promise; }
            }
            return originalOpen(...args);
          });
          vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
            if (to === journalFile) {
              const record: unknown = JSON.parse(await fs.readFile(from, 'utf8'));
              if (record && typeof record === 'object' && 'state' in record && record.state === 'settled') {
                if (held === 'journal-receipt' && !blockTaken) { blockTaken = true; reached.release(); await resume.promise; }
                if (releasedOwner) lateWrites++;
                await originalRename(from, to); receiptCommitted = true; return;
              }
            }
            if ((to === journalFile || to === path.join(server.core.paths.dataRoot, 'session-permissions.json')) && releasedOwner) lateWrites++;
            return originalRename(from, to);
          });
          // A destroyed socket may lose the response, but may not detach the admitted write.
          requestFinished = send(confirm).catch(() => null);
          let deadline: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([reached.promise, requestFinished.then(() => {
              if (!blockTaken) throw new Error('Confirmation ended before the required real persistence barrier.');
            }), new Promise<never>((_resolve, reject) => {
              deadline = setTimeout(() => reject(new Error('Real persistence barrier was not reached.')), 5_000);
            })]);
          } finally { if (deadline) clearTimeout(deadline); }
          let finished = false;
          const stopping = server.stop().then((result) => { finished = true; return result; });
          expect(server.core.lifecycle.isStopping).toBe(true);
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          expect(finished).toBe(false);
          await expect(OwnerLock.acquire(server.core.paths.lockRoot, 'profile', profileResource)).rejects.toBeInstanceOf(OwnershipConflict);
          await expect(OwnerLock.acquire(hostCheckoutLockRoot(), 'checkout', workspace)).rejects.toBeInstanceOf(OwnershipConflict);
          resume.release();
          const result = await stopping;
          if (result.status !== 'settled') await server.settled();
          await requestFinished;
          expect(receiptCommitted).toBe(true);
          expect(releasedOwner).toBe(true);
          expect(lateWrites).toBe(0);
          const record: unknown = JSON.parse(await fs.readFile(journalFile, 'utf8'));
          expect(record).toMatchObject({ requestId: confirm.requestId, state: 'settled', receipt: {
            kind: 'permission', requestId: confirm.requestId, newLevel: 'read-only', outcome: 'applied', durability: 'journaled',
          } });
          const journal = new CommandJournal({ root: journalRoot, serverEpoch: ready.serverEpoch });
          expect(await journal.status(confirm.requestId, handle.id, credential.clientId)).toMatchObject({ state: 'settled' });
          vi.restoreAllMocks();
          const replacement = await OwnerLock.acquire(server.core.paths.lockRoot, 'profile', profileResource);
          await replacement.release();
        } finally {
          resume.release(); await requestFinished; socket?.terminate();
          const result = await server.stop();
          if (result.status !== 'settled') await server.settled();
          await adapter.dispose();
          roots.push(root); // Only roots with actually settled owners may be deleted.
        }
      }, 90_000);
    }
  });
}
