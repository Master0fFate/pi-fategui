import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServerProfile } from '../../src/core/storage/ServerProfile';
import { OwnerLock, canonicalFuturePath } from '../../src/core/ownership/OwnerLock';
import { ProtocolFault } from '../../src/shared/protocol/errors';
import { AuthService } from '../../src/server/auth/AuthService';
import { ownerCredentialPath, readClientCredentialReference, readHostOwnerCredential,
  writeClientCredentialReference } from '../../src/server/auth/AuthStore';
import { executeAdminMethod } from '../../src/server/admin/adminMethods';
import { privateTestRoot } from './helpers/isolatedEnvironment';
import { startTestNodeServer } from './helpers/nodeServerFactory';
import { FakePiSdkAdapter } from './helpers/fakePi';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })));
});
async function fixture() {
  const root = await mkdtemp(path.join(privateTestRoot(), 'authentication-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  await mkdir(home, { mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  const paths = await createServerProfile({ home, profileId: 'auth' });
  const lock = await OwnerLock.acquire(paths.lockRoot, 'profile', await canonicalFuturePath(path.dirname(paths.dataRoot)));
  await mkdir(path.dirname(paths.dataRoot), { recursive: true, mode: 0o700 });
  let now = 100_000;
  const open = () => AuthService.open(paths, [workspace], { now: () => now });
  return { root, home, workspace, paths, lock, open, setTime: (value: number) => { now = value; }, getTime: () => now };
}
async function withFixture(run: (context: Awaited<ReturnType<typeof fixture>>) => Promise<void>): Promise<void> {
  const context = await fixture();
  try { await run(context); } finally { await context.lock.release(); }
}
async function ownerOf(context: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  return readFile(ownerCredentialPath(context.paths), 'utf8');
}
function codeOf(error: unknown): string | undefined {
  return error instanceof ProtocolFault ? error.code : undefined;
}

describe('host-only authentication', () => {
  it('initializes auth only under the running Node host lock and blocks corrupt-auth restart', async () => {
    const root = await mkdtemp(path.join(privateTestRoot(), 'auth-host-'));
    roots.push(root);
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    await mkdir(home, { mode: 0o700 });
    await mkdir(workspace, { mode: 0o700 });
    const config = { profile: { profileId: 'host', home }, workspaces: [workspace], host: '127.0.0.1', port: 47819,
      flags: { terminal: false, browser: false }, maxPermission: 'edit' };
    const adapter = new FakePiSdkAdapter();
    try {
      const server = await startTestNodeServer(config, adapter);
      const ownerPath = ownerCredentialPath(server.core.paths);
      try {
        expect(server.readiness.authentication).toBe('ready');
        expect(server.readiness.listener).toBe('disabled');
        const owner = await readHostOwnerCredential(server.core.paths);
        expect(server.auth.safeStatus(owner)).toEqual({ clientCount: 0, liveSessionCount: 0, pendingCodeCount: 0 });
        expect(JSON.stringify(server.readiness)).not.toContain(owner);
      } finally { expect(await server.stop()).toEqual({ status: 'settled' }); }
      await writeFile(path.join(path.dirname(ownerPath), 'auth.json'), '{corrupt');
      await expect(startTestNodeServer(config, adapter)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    } finally { await adapter.dispose(); }
  });

  it('creates a private regular host owner key once, without creating the provider root or copying credentials', async () => {
    await withFixture(async (context) => {
      await context.open();
      const owner = await ownerOf(context);
      expect(owner).toMatch(/^fo1_[A-Za-z0-9_-]{43}$/u);
      const file = await stat(ownerCredentialPath(context.paths));
      expect(file.isFile()).toBe(true);
      if (process.platform !== 'win32') expect(file.mode & 0o077).toBe(0);
      await expect(stat(context.paths.dataRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      await context.open();
      expect(await readHostOwnerCredential(context.paths)).toBe(owner);
      expect(await ownerOf(context)).toBe(owner);
      expect((await readdir(path.dirname(ownerCredentialPath(context.paths)))).sort()).toEqual(['auth.json', 'owner.key']);
    });
  });

  it('consumes a 256-bit code exactly once under concurrent exchanges, and restores same-tab CSRF without control', async () => {
    await withFixture(async (context) => {
      const service = await context.open();
      const owner = await ownerOf(context);
      const { code } = await service.createBootstrapCode(owner);
      const [first, second] = await Promise.allSettled([
        service.exchange(code, '127.0.0.1'), service.exchange(code, '127.0.0.1'),
      ]);
      const successes = [first, second].filter((entry) => entry.status === 'fulfilled');
      const failures = [first, second].filter((entry) => entry.status === 'rejected');
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      if (first.status === 'rejected') expect(codeOf(first.reason)).toBe('UNAUTHENTICATED');
      if (second.status === 'rejected') expect(codeOf(second.reason)).toBe('UNAUTHENTICATED');
      const issued = first.status === 'fulfilled' ? first.value : second.status === 'fulfilled' ? second.value : null;
      expect(issued).not.toBeNull();
      if (!issued) return;
      expect(service.authenticateBrowser(issued.sessionToken)).toMatchObject({ kind: 'browser', workspaceRoots: [context.workspace] });
      expect(service.sessionInfo(issued.sessionToken)).toEqual(issued.session);
      expect(service.assertBrowserCsrf(issued.sessionToken, issued.session.csrfToken).kind).toBe('browser');
      expect(() => service.assertBrowserCsrf(issued.sessionToken, 'wrong')).toThrow(ProtocolFault);
      // State contains digests, never raw code, cookie, or derived CSRF secret.
      const stored = await readFile(path.join(path.dirname(ownerCredentialPath(context.paths)), 'auth.json'), 'utf8');
      for (const secret of [code, issued.sessionToken, issued.session.csrfToken]) expect(stored).not.toContain(secret);
      expect((await context.open()).sessionInfo(issued.sessionToken)).toEqual(issued.session);
    });
  });

  it('expires codes/sessions, persists five failed exchanges per minute, and refuses backward clock movement', async () => {
    await withFixture(async (context) => {
      const service = await context.open();
      const owner = await ownerOf(context);
      const expired = await service.createBootstrapCode(owner);
      context.setTime(expired.expiresAt);
      await expect(service.exchange(expired.code, '127.0.0.1')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      // The failure above counts. Four more failures exhaust the one-minute window.
      for (let index = 0; index < 4; index++) {
        await expect(service.exchange('invalid', '127.0.0.1')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      }
      const valid = await service.createBootstrapCode(owner);
      await expect(service.exchange(valid.code, '127.0.0.1')).rejects.toMatchObject({ code: 'BUSY' });
      const restarted = await context.open();
      await expect(restarted.exchange(valid.code, '127.0.0.1')).rejects.toMatchObject({ code: 'BUSY' });
      context.setTime(context.getTime() + 60_001);
      const session = await restarted.exchange(valid.code, '127.0.0.1');
      context.setTime(session.session.expiresAt);
      expect(restarted.authenticateBrowser(session.sessionToken)).toBeNull();
      context.setTime(session.session.expiresAt - 1);
      expect(() => restarted.safeStatus(owner)).toThrowError(ProtocolFault);
      try { restarted.safeStatus(owner); } catch (error) { expect(codeOf(error)).toBe('CLOCK_SKEW'); }
    });
  });

  it('keeps owner, client and browser credential kinds separate; rejects cookie and role claims for admin', async () => {
    await withFixture(async (context) => {
      const service = await context.open();
      const owner = await ownerOf(context);
      const issued = await service.issueClientCredential(owner, [context.workspace]);
      const bearer = service.authenticateClient(issued.credential);
      expect(bearer).toMatchObject({ kind: 'client', clientId: issued.clientId, workspaceRoots: [context.workspace] });
      const approvedReference = path.join(context.root, 'client-key.ref');
      await writeClientCredentialReference(approvedReference, issued.credential);
      expect(await readClientCredentialReference(approvedReference)).toBe(issued.credential);
      if (process.platform !== 'win32') expect((await stat(approvedReference)).mode & 0o077).toBe(0);
      await expect(writeClientCredentialReference(approvedReference, owner)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(service.authenticateClient(owner)).toBeNull();
      expect(service.authenticateBrowser(issued.credential)).toBeNull();
      expect(() => service.assertOwner(issued.credential)).toThrowError(ProtocolFault);
      const admin = (secret: string, origin: string | null = null, cookiePresented = false) => executeAdminMethod(service,
        { ownerCredential: secret, origin, cookiePresented }, { method: 'auth.status', input: {} });
      await expect(admin(issued.credential)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      const browser = await service.exchange((await service.createBootstrapCode(owner)).code, '127.0.0.1');
      await expect(admin(browser.sessionToken, null, true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(admin(owner, 'http://127.0.0.1:4000')).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(admin(owner, null, true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(executeAdminMethod(service, { ownerCredential: owner, origin: null, cookiePresented: false },
        { method: 'client.issue', input: { workspaceRoots: [context.workspace], role: 'owner' } }))
        .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      await expect(service.issueClientCredential(owner, [context.home])).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    });
  });

  it('revokes clients and browser sessions and notifies connections without secrets; owner rotation revokes all', async () => {
    await withFixture(async (context) => {
      const service = await context.open();
      let owner = await ownerOf(context);
      const events: unknown[] = [];
      service.subscribeRevocations((event) => { events.push(event); });
      const client = await service.issueClientCredential(owner, [context.workspace]);
      const browser = await service.exchange((await service.createBootstrapCode(owner)).code, '127.0.0.1');
      expect(await service.revokeClientCredential(owner, client.clientId)).toEqual({ revoked: true });
      expect(service.authenticateClient(client.credential)).toBeNull();
      await service.logout(browser.sessionToken, browser.session.csrfToken);
      expect(service.authenticateBrowser(browser.sessionToken)).toBeNull();
      expect(events).toEqual([{ kind: 'client', clientId: client.clientId }, { kind: 'session', sessionId: browser.session.sessionId }]);
      const remaining = await service.issueClientCredential(owner, [context.workspace]);
      const other = await service.exchange((await service.createBootstrapCode(owner)).code, '127.0.0.1');
      const rotating = service.rotateOwnerCredential(owner);
      // Already-admitted work must recheck owner inside the serial write lane.
      const staleIssue = service.issueClientCredential(owner, [context.workspace]);
      const changed = await rotating;
      await expect(staleIssue).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(events.at(-1)).toEqual({ kind: 'all' });
      expect(service.authenticateClient(remaining.credential)).toBeNull();
      expect(service.authenticateBrowser(other.sessionToken)).toBeNull();
      expect(() => service.assertOwner(owner)).toThrowError(ProtocolFault);
      owner = changed.ownerCredential;
      expect(await ownerOf(context)).toBe(owner);
      expect((await context.open()).safeStatus(owner)).toEqual({ clientCount: 0, liveSessionCount: 0, pendingCodeCount: 0 });
    });
  });

  it('caps 32 live browser sessions and never consumes a code when the cap refuses admission', async () => {
    await withFixture(async (context) => {
      const service = await context.open();
      const owner = await ownerOf(context);
      const sessions = [];
      for (let index = 0; index < 32; index++) {
        sessions.push(await service.exchange((await service.createBootstrapCode(owner)).code, '127.0.0.1'));
      }
      const pending = await service.createBootstrapCode(owner);
      await expect(service.exchange(pending.code, '127.0.0.1')).rejects.toMatchObject({ code: 'BUSY' });
      const first = sessions[0];
      if (!first) throw new Error('Expected the first browser session.');
      await service.logout(first.sessionToken, first.session.csrfToken);
      expect((await service.exchange(pending.code, '127.0.0.1')).session.sessionId).toMatch(/^[0-9a-f-]{36}$/u);
    });
  });

  it('fails closed on a malformed store, private-file violation, symlink, or incomplete owner initialization', async () => {
    await withFixture(async (context) => {
      await context.open();
      const ownerPath = ownerCredentialPath(context.paths);
      const statePath = path.join(path.dirname(ownerPath), 'auth.json');
      const original = await readFile(statePath, 'utf8');
      await writeFile(statePath, '{invalid');
      await expect(context.open()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
      await writeFile(statePath, original);
      const secret = await readFile(ownerPath);
      await rm(ownerPath);
      const outside = path.join(context.root, 'decoy');
      if (process.platform === 'win32') await mkdir(outside);
      else await writeFile(outside, secret);
      await symlink(outside, ownerPath, process.platform === 'win32' ? 'junction' : 'file');
      await expect(context.open()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
      await rm(ownerPath);
      await expect(context.open()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
      if (process.platform !== 'win32') {
        await writeFile(ownerPath, secret, { mode: 0o644 });
        await chmod(ownerPath, 0o644);
        await expect(context.open()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
      }
    });
  });

  it('does not echo a supplied secret sentinel in logs, revocation events, faults, or public status', async () => {
    await withFixture(async (context) => {
      const sentinel = 'DO_NOT_ECHO_SECRET_SENTINEL_009';
      const messages: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { messages.push(parts.join(' ')); });
      vi.spyOn(console, 'warn').mockImplementation((...parts: unknown[]) => { messages.push(parts.join(' ')); });
      vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { messages.push(parts.join(' ')); });
      const service = await context.open();
      const events: unknown[] = [];
      service.subscribeRevocations((event) => { events.push(event); });
      const owner = await ownerOf(context);
      const faults: string[] = [];
      for (const bad of [() => service.exchange(sentinel, '127.0.0.1'), () => executeAdminMethod(service,
        { ownerCredential: sentinel, origin: null, cookiePresented: false }, { method: 'auth.status', input: {} }),
      ]) {
        try { await bad(); } catch (error) { faults.push(String(error)); }
      }
      const result = await executeAdminMethod(service, { ownerCredential: owner, origin: null, cookiePresented: false },
        { method: 'auth.status', input: {} });
      const output = JSON.stringify({ messages, events, faults, result });
      expect(output).not.toContain(sentinel);
      expect(result).toEqual({ method: 'auth.status', result: { clientCount: 0, liveSessionCount: 0, pendingCodeCount: 0 } });
    });
  });
});
