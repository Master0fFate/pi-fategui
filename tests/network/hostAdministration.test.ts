import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { EventEmitter } from 'node:events';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { initializeHostProfile, readHostProfile, writePrivateHostOutput } from '../../src/cli/profile';
import { createHostAdminClient, type HostAdminClient } from '../../src/cli/adminClient';
import { issueAccessKey, issueBootstrapCode } from '../../src/cli/hostCommands';
import { runProviderLogin, type ProviderLoginIo } from '../../src/cli/providerLogin';
import { runForegroundHost } from '../../src/cli/foreground';
import { OwnerLock, canonicalFuturePath } from '../../src/core/ownership/OwnerLock';
import { createFateCore } from '../../src/core/createFateCore';
import { MultiProjectPiRuntime } from '../../src/main/pi/MultiProjectPiRuntime';
import { startAuthenticatedNodeServerWithFactory } from '../../src/server/http/startAuthenticatedNodeServer';
import { readHostOwnerCredential, readClientCredentialReference } from '../../src/server/auth/AuthStore';
import { FakePiSdkAdapter } from '../v2/helpers/fakePi';
import { ModelsDevService } from '../../src/main/pi/modelsdev/ModelsDevService';
import type { SessionTitleGenerator } from '../../src/main/pi/PiSessionTitleGenerator';
import { privateTestRoot } from '../v2/helpers/isolatedEnvironment';
import { disposeProductionCliBuild, mustRetainCliFixture, recordCliResult, runNoninteractiveCli, runTerminalCli } from './helpers/productionCliProcess';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(async (root) => {
    if (mustRetainCliFixture(root)) { console.error(`CLI_EXIT_UNCONFIRMED: fixture retained at ${root}`); return; }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }));
});
afterAll(disposeProductionCliBuild);
async function freePort(): Promise<number> {
  const server = createNetServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', () => {
      const address = server.address(); if (!address || typeof address === 'string') { server.close(); reject(new Error('No fixture port')); return; }
      server.close(() => resolve(address.port));
    });
  });
}
async function profileFixture() {
  const root = await fs.mkdtemp(path.join(privateTestRoot(), 'host-admin-')); roots.push(root);
  const home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
  await fs.mkdir(home, { mode: 0o700 }); await fs.mkdir(workspace, { mode: 0o700 });
  const port = await freePort();
  const profile = await initializeHostProfile({ profileId: 'host', home, workspace, trustAccepted: true, port });
  return { root, home, workspace, port, profile };
}
async function liveFixture(fixtureOptions: { readonly titleGenerator?: SessionTitleGenerator } = {}) {
  const base = await profileFixture();
  const adapter = new FakePiSdkAdapter();
  const sdk = await adapter.createModelRuntime();
  const provider = sdk.getProvider('anthropic');
  if (!provider) throw new Error('Pinned SDK lacks fixture provider metadata');
  let configured = false;
  vi.spyOn(sdk, 'getProviders').mockReturnValue([provider]);
  vi.spyOn(sdk, 'hasConfiguredAuth').mockImplementation(() => configured);
  const refresh = await sdk.refresh({ allowNetwork: false });
  vi.spyOn(sdk, 'refresh').mockResolvedValue(refresh);
  const logs: string[] = [];
  const server = await startAuthenticatedNodeServerWithFactory(base.profile.input, (options) => createFateCore({ ...options, adapter,
    createRuntime: (dependencies) => new MultiProjectPiRuntime({ ...dependencies, createSessionTitleGenerator: () => fixtureOptions.titleGenerator ?? ({ generate: async () => null }) }) }),
  (entry) => { logs.push(entry); });
  const client = createHostAdminClient(base.profile.paths, base.port);
  const owner = await readHostOwnerCredential(base.profile.paths);
  return { ...base, server, client, owner, logs, adapter, sdk, configure: () => { configured = true; },
    cleanup: async () => { expect(await server.stop()).toEqual({ status: 'settled' }); await adapter.dispose(); } };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
// An admin poll includes a fresh native ACL read (measured 2.8s on Windows),
// before HTTP. Vitest's 1s default aborts that legitimate first poll. Keep the
// overall 45s behavior limit; only these real-IO polls get a finite 10s bound.
const adminPoll = { timeout: process.platform === 'win32' ? 10_000 : 1_000 };

describe('T45 host-only profile and administration', () => {
  it('init requires trust, writes a private descriptor outside data, and starts no engine or credentials', async () => {
    const fixture = await profileFixture();
    const file = path.join(path.dirname(fixture.profile.paths.dataRoot), 'server.json');
    expect(await fs.readFile(file, 'utf8')).toContain('"maxPermission": "read-only"');
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o077).toBe(0);
    await expect(fs.stat(fixture.profile.paths.dataRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(path.dirname(fixture.profile.paths.dataRoot), 'credentials'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(initializeHostProfile({ profileId: 'other', home: fixture.home, workspace: fixture.workspace, trustAccepted: false })).rejects.toThrow('trust');
    expect((await readHostProfile('host', fixture.home)).config.workspaces).toEqual([fixture.workspace]);
  });

  it('init refuses an existing descriptor and a competing live profile owner', async () => {
    const fixture = await profileFixture();
    await expect(initializeHostProfile({ profileId: 'host', home: fixture.home, workspace: fixture.workspace, trustAccepted: true })).rejects.toThrow();
    const lock = await OwnerLock.acquire(fixture.profile.paths.lockRoot, 'profile', await canonicalFuturePath(path.dirname(fixture.profile.paths.dataRoot)));
    try { await expect(initializeHostProfile({ profileId: 'host', home: fixture.home, workspace: fixture.workspace, trustAccepted: true })).rejects.toThrow('Owner already in use'); }
    finally { await lock.release(); }
  });

  it('descriptor read rejects extra fields, symlinks and non-private output parents', async () => {
    const fixture = await profileFixture();
    const file = path.join(path.dirname(fixture.profile.paths.dataRoot), 'server.json');
    const descriptor: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new Error('Invalid fixture');
    await fs.writeFile(file, JSON.stringify({ ...descriptor, providerKey: 'synthetic-secret' }));
    await expect(readHostProfile('host', fixture.home)).rejects.toThrow();
    await fs.unlink(file);
    const outside = path.join(fixture.root, 'outside');
    if (process.platform === 'win32') await fs.mkdir(outside);
    await fs.symlink(outside, file, process.platform === 'win32' ? 'junction' : 'file');
    await expect(readHostProfile('host', fixture.home)).rejects.toThrow();
    if (process.platform !== 'win32') {
      const publicParent = path.join(fixture.root, 'public'); await fs.mkdir(publicParent, { mode: 0o755 });
      await expect(writePrivateHostOutput(path.join(publicParent, 'secret'), 'synthetic')).rejects.toThrow();
      await expect(fs.stat(path.join(publicParent, 'secret'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

});

describe('T45 live host-only administration', () => {
  let prepared: Awaited<ReturnType<typeof liveFixture>> | undefined;
  let titleGenerator: SessionTitleGenerator;
  const currentFixture = () => { if (!prepared) throw new Error('Live fixture did not finish setup.'); return prepared; };
  // Measured Windows setup is 41.3s before behavior assertions. Keep the
  // 45s behavior deadline, with a separate finite setup budget and all real
  // ACL checks intact. No server or credential state is shared across tests.
  beforeEach(async () => {
    prepared = undefined;
    titleGenerator = { generate: async () => null };
    prepared = await liveFixture({ titleGenerator });
  }, 90_000);

  it('real admin HTTP refuses client key, browser cookie, Origin and malformed provider reflection before Pi access', async () => {
    const fixture = currentFixture();
    try {
      const login = vi.spyOn(fixture.sdk, 'login');
      const issued = await fixture.client.execute({ method: 'client.issue', input: { workspaceRoots: [fixture.workspace] } });
      if (issued.method !== 'client.issue') throw new Error('Fixture response mismatch');
      const url = `http://127.0.0.1:${fixture.port}/api/admin`;
      const body = JSON.stringify({ method: 'provider.start', input: { providerId: 'anthropic', method: 'api_key' } });
      for (const headers of [
        { Authorization: `Bearer ${issued.result.credential}` },
        { Authorization: `Bearer ${fixture.owner}`, Cookie: 'browser=synthetic' },
        { Authorization: `Bearer ${fixture.owner}`, Origin: `http://127.0.0.1:${fixture.port}` },
      ]) expect((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body })).status).toBe(headers.Origin || headers.Cookie ? 403 : 401);
      expect((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fixture.owner}` },
        body: JSON.stringify({ method: 'provider.start', input: { providerId: 'anthropic', method: 'api_key', role: 'owner' } }) })).status).toBe(400);
      expect(login).not.toHaveBeenCalled();
      for (const secret of [fixture.owner, issued.result.credential]) expect(fixture.logs.join('\n')).not.toContain(secret);
    } finally { await fixture.cleanup(); }
  });

  it('provider input and SDK errors stay private; ordinary admin response contains only provider state', async () => {
    const fixture = currentFixture();
    const secret = 'synthetic-provider-response-44119';
    try {
      vi.spyOn(fixture.sdk, 'login').mockImplementation(async (_id, _method, interaction) => {
        const value = await interaction.prompt({ type: 'secret', message: 'Enter fixture key' });
        expect(value).toBe(secret); throw new Error(`provider failed with ${value}`);
      });
      await fixture.client.execute({ method: 'provider.start', input: { providerId: 'anthropic', method: 'api_key' } });
      let promptId = '';
      await vi.waitFor(async () => { const state = await fixture.client.execute({ method: 'provider.state', input: {} });
        if (state.method !== 'provider.state') throw new Error('Fixture state mismatch'); promptId = state.result.prompt?.id ?? ''; expect(promptId).not.toBe('');
        expect(Object.keys(state.result)).not.toContain('messages'); expect(Object.keys(state.result)).not.toContain('project'); }, adminPoll);
      await fixture.server.core.runtime.openProject({ path: fixture.workspace, name: 'fixture', trusted: true });
      expect(fixture.server.core.runtime.getFocused()).not.toBe(fixture.server.core.runtime.hostProviderLoginService());
      await fixture.client.execute({ method: 'provider.respond', input: { promptId, value: secret } });
      await vi.waitFor(async () => {
        const state = await fixture.client.execute({ method: 'provider.state', input: {} });
        expect(state).toMatchObject({ result: { status: 'error' } }); expect(JSON.stringify(state)).not.toContain(secret);
      }, adminPoll);
      expect(fixture.logs.join('\n')).not.toContain(secret);
      await expect(fixture.client.execute({ method: 'provider.start', input: { providerId: 'missing-sdk-provider', method: 'oauth' } })).rejects.toThrow();
      expect(fixture.logs.join('\n')).not.toContain(fixture.owner);
    } finally { await fixture.cleanup(); }
  });

  it('cancel retains SDK ownership until settlement, then a later login keeps its own prompt', async () => {
    const fixture = currentFixture();
    const old = deferred(); let count = 0;
    try {
      vi.spyOn(fixture.sdk, 'login').mockImplementation(async (_id, _method, interaction) => {
        count += 1;
        if (count === 1) { await old.promise; interaction.notify({ type: 'progress', message: 'stale old progress' }); return { type: 'api_key', key: 'synthetic-old' }; }
        await interaction.prompt({ type: 'secret', message: 'New login prompt' }); fixture.configure(); return { type: 'api_key', key: 'synthetic-new' };
      });
      await fixture.client.execute({ method: 'provider.start', input: { providerId: 'anthropic', method: 'api_key' } });
      await fixture.client.execute({ method: 'provider.cancel', input: {} });
      await expect(fixture.client.execute({ method: 'provider.start', input: { providerId: 'anthropic', method: 'api_key' } })).rejects.toThrow();
      old.resolve();
      await vi.waitFor(() => expect(fixture.server.core.runtime.hostProviderLoginService().getState(false).providerLogin?.status).toBe('idle'));
      await vi.waitFor(async () => { await fixture.client.execute({ method: 'provider.start', input: { providerId: 'anthropic', method: 'api_key' } }); }, adminPoll);
      await vi.waitFor(async () => expect(await fixture.client.execute({ method: 'provider.state', input: {} })).toMatchObject({ result: { status: 'awaiting-input', prompt: { message: 'New login prompt' } } }), adminPoll);
      await fixture.client.execute({ method: 'provider.cancel', input: {} });
    } finally { old.resolve(); await fixture.cleanup(); }
  });

  it('an active unfocused workspace blocks shared provider start and respond', async () => {
    const fixture = currentFixture();
    try {
      const workspace = fixture.server.core.runtime.peekWorkspace(fixture.workspace);
      if (!workspace) throw new Error('Fixture workspace missing');
      const state = await workspace.newSession();
      if (!state.sessionId) throw new Error('Fixture session missing');
      const control = fixture.adapter.controls.get(state.sessionId);
      if (!control) throw new Error('Fixture control missing');
      control.barriers.hold('settle');
      expect((await workspace.prompt({ text: 'Hold one real Fate run at the fake-provider boundary.', behavior: 'prompt' })).accepted).toBe(true);
      await control.barriers.reached('settle');
      expect(fixture.server.core.runtime.getFocused()).not.toBe(workspace);
      expect(workspace.hasEvictionBlockingWork()).toBe(true);
      await expect(fixture.client.execute({ method: 'provider.start', input: { providerId: 'anthropic', method: 'api_key' } })).rejects.toThrow();
      await expect(fixture.client.execute({ method: 'provider.respond', input: { promptId: '21b03408-3e8b-4b74-89d0-000fe3349f49', value: 'synthetic' } })).rejects.toThrow();
      control.barriers.release('settle');
      await vi.waitFor(() => expect(workspace.hasEvictionBlockingWork()).toBe(false));
    } finally { await fixture.cleanup(); }
  });

  it('live admin is the sole profile writer and a missing live server never starts another core', async () => {
    const fixture = currentFixture();
    try {
      const before = fixture.adapter.invocations.filter((entry) => entry.kind === 'createRuntime').length;
      await fixture.client.execute({ method: 'auth.status', input: {} });
      await expect(initializeHostProfile({ profileId: 'host', home: fixture.home, workspace: fixture.workspace, trustAccepted: true })).rejects.toThrow('Owner already in use');
      await expect(createHostAdminClient(fixture.profile.paths, await freePort()).execute({ method: 'auth.status', input: {} })).rejects.toThrow('Start the host server');
      expect(fixture.adapter.invocations.filter((entry) => entry.kind === 'createRuntime').length).toBe(before);
    } finally { await fixture.cleanup(); }
  });

  it('rechecks host admission when another workspace starts during provider initialization', async () => {
    const fixture = currentFixture();
    const blocked = deferred(), refreshEntered = deferred(), loginEntered = deferred();
    let refresh: Promise<void> | null = null;
    let request: Promise<unknown> | null = null;
    try {
      const workspace = fixture.server.core.runtime.peekWorkspace(fixture.workspace);
      if (!workspace) throw new Error('Fixture workspace missing');
      const state = await workspace.newSession();
      if (!state.sessionId) throw new Error('Fixture session missing');
      const control = fixture.adapter.controls.get(state.sessionId);
      if (!control) throw new Error('Fixture control missing');
      const service = fixture.server.core.runtime.hostProviderLoginService();
      vi.spyOn(ModelsDevService.prototype, 'refreshManagedProviders').mockImplementation(async () => {
        refreshEntered.resolve(); await blocked.promise; return [];
      });
      const original = service.startProviderLogin.bind(service);
      vi.spyOn(service, 'startProviderLogin').mockImplementation((...args: Parameters<typeof service.startProviderLogin>) => {
        loginEntered.resolve(); return original(...args);
      });
      const login = vi.spyOn(fixture.sdk, 'login').mockResolvedValue({ type: 'api_key', key: 'synthetic' });
      refresh = service.refreshManagedModelsDevProviders();
      await refreshEntered.promise;
      request = fixture.client.execute({ method: 'provider.start', input: { providerId: 'anthropic', method: 'api_key' } })
        .then(() => ({ accepted: true }), () => ({ accepted: false }));
      await loginEntered.promise;
      control.barriers.hold('settle');
      expect((await workspace.prompt({ text: 'Begin during held provider initialization.', behavior: 'prompt' })).accepted).toBe(true);
      await control.barriers.reached('settle');
      expect(fixture.server.core.runtime.hasHostActiveWork()).toBe(true);
      blocked.resolve(); await refresh;
      expect(await request).toEqual({ accepted: false });
      expect(login).not.toHaveBeenCalled();
      control.barriers.release('settle');
    } finally { blocked.resolve(); await refresh; await request; await fixture.cleanup(); }
  });

  it('new execution stays blocked during a pending login and canceled SDK settlement', async () => {
    const fixture = currentFixture();
    const settle = deferred();
    try {
      const workspace = fixture.server.core.runtime.peekWorkspace(fixture.workspace);
      if (!workspace) throw new Error('Fixture workspace missing');
      await workspace.newSession();
      const service = fixture.server.core.runtime.hostProviderLoginService();
      const login = vi.spyOn(fixture.sdk, 'login').mockImplementation(async () => { await settle.promise; return { type: 'api_key', key: 'synthetic' }; });
      await fixture.client.execute({ method: 'provider.start', input: { providerId: 'anthropic', method: 'api_key' } });
      await vi.waitFor(() => expect(login).toHaveBeenCalledOnce());
      expect(service.hasProviderLoginOwnership()).toBe(true);
      const calls = fixture.adapter.invocations.filter((entry) => entry.kind === 'prompt').length;
      await expect(workspace.prompt({ text: 'Must remain blocked while provider login waits.', behavior: 'prompt' })).rejects.toMatchObject({ normalized: { code: 'RUN_ACTIVE' } });
      await expect(workspace.optimizePrompt('A helper model call must also remain blocked.')).rejects.toMatchObject({ normalized: { code: 'RUN_ACTIVE' } });
      await fixture.client.execute({ method: 'provider.cancel', input: {} });
      expect(service.getState(false).providerLogin?.status).toBe('idle');
      expect(service.hasProviderLoginOwnership()).toBe(true);
      await expect(workspace.prompt({ text: 'Cancel is not SDK settlement.', behavior: 'prompt' })).rejects.toMatchObject({ normalized: { code: 'RUN_ACTIVE' } });
      expect(fixture.adapter.invocations.filter((entry) => entry.kind === 'prompt').length).toBe(calls);
      settle.resolve(); await vi.waitFor(() => expect(service.hasProviderLoginOwnership()).toBe(false));
      expect((await workspace.prompt({ text: 'Run after actual provider settlement.', behavior: 'prompt' })).accepted).toBe(true);
    } finally { settle.resolve(); await fixture.cleanup(); }
  });

  it('a title model call that outlives its root run still blocks provider mutation', async () => {
    const titleEntered = deferred(), titleSettles = deferred();
    const fixture = currentFixture();
    vi.spyOn(titleGenerator, 'generate').mockImplementation(async () => {
      titleEntered.resolve(); await titleSettles.promise; return null;
    });
    try {
      const workspace = fixture.server.core.runtime.peekWorkspace(fixture.workspace);
      if (!workspace) throw new Error('Fixture workspace missing');
      const state = await workspace.newSession();
      if (!state.sessionId) throw new Error('Fixture session missing');
      const control = fixture.adapter.controls.get(state.sessionId);
      if (!control) throw new Error('Fixture control missing');
      control.barriers.hold('settle');
      const login = vi.spyOn(fixture.sdk, 'login').mockResolvedValue({ type: 'api_key', key: 'synthetic' });
      expect((await workspace.prompt({ text: 'Generate a fixture title.', behavior: 'prompt' })).accepted).toBe(true);
      await titleEntered.promise; await control.barriers.reached('settle');
      control.barriers.release('settle');
      await vi.waitFor(() => expect(workspace.getState(false).streaming).toBe(false));
      expect(fixture.server.core.runtime.hasHostActiveWork()).toBe(true);
      await expect(fixture.client.execute({ method: 'provider.start', input: { providerId: 'anthropic', method: 'api_key' } })).rejects.toThrow();
      expect(login).not.toHaveBeenCalled();
      titleSettles.resolve(); await vi.waitFor(() => expect(fixture.server.core.runtime.hasHostActiveWork()).toBe(false));
    } finally { titleSettles.resolve(); await fixture.cleanup(); }
  });

  it('a canceled optimizer keeps provider admission blocked until its real model promise settles', async () => {
    const fixture = currentFixture();
    const entered = deferred(), settles = deferred();
    let canceled = false;
    let optimization: Promise<unknown> | null = null;
    try {
      const workspace = fixture.server.core.runtime.peekWorkspace(fixture.workspace);
      if (!workspace) throw new Error('Fixture workspace missing');
      await workspace.newSession();
      vi.spyOn(fixture.sdk, 'completeSimple').mockImplementation(async (_model, _context, options) => {
        options?.signal?.addEventListener('abort', () => { canceled = true; }, { once: true });
        entered.resolve(); await settles.promise;
        return { role: 'assistant', api: 'anthropic-messages', provider: 'v2-fake', model: 'v2-deterministic',
          content: [{ type: 'text', text: 'Inspect the isolated fixture and describe the required result.' }], stopReason: 'stop', timestamp: 0,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      });
      const login = vi.spyOn(fixture.sdk, 'login').mockResolvedValue({ type: 'api_key', key: 'synthetic' });
      optimization = workspace.optimizePrompt('Rewrite this fixture request.').then(() => ({ completed: true }), () => ({ completed: false }));
      await entered.promise;
      await expect(fixture.client.execute({ method: 'provider.start', input: { providerId: 'anthropic', method: 'api_key' } })).rejects.toThrow();
      expect((await workspace.prompt({ text: 'Sending cancels the optimizer, not its delayed model settlement.', behavior: 'prompt' })).accepted).toBe(true);
      await vi.waitFor(() => expect(canceled).toBe(true));
      await vi.waitFor(() => expect(workspace.getState(false).streaming).toBe(false));
      expect(fixture.server.core.runtime.hasHostActiveWork()).toBe(true);
      await expect(fixture.client.execute({ method: 'provider.start', input: { providerId: 'anthropic', method: 'api_key' } })).rejects.toThrow();
      expect(login).not.toHaveBeenCalled();
      settles.resolve(); expect(await optimization).toEqual({ completed: false });
      await vi.waitFor(() => expect(fixture.server.core.runtime.hasHostActiveWork()).toBe(false));
    } finally { settles.resolve(); await optimization; await fixture.cleanup(); }
  });

  it('issued access keys remain client-only, and a failed private write revokes the new key', async () => {
    const fixture = currentFixture();
    try {
      const output = path.join(fixture.root, 'client.key'); await issueAccessKey(fixture.client, fixture.workspace, output);
      const credential = await readClientCredentialReference(output);
      expect(fixture.server.auth.authenticateClient(credential)?.kind).toBe('client');
      expect(() => fixture.server.auth.assertOwner(credential)).toThrow();
      const racingOutput = path.join(fixture.root, 'racing.key'); let racedKey = '';
      const client: HostAdminClient = { async execute(request) {
        const response = await fixture.client.execute(request);
        if (response.method === 'client.issue') { racedKey = response.result.credential; await fs.writeFile(racingOutput, 'existing', { flag: 'wx', mode: 0o600 }); }
        return response;
      } };
      await expect(issueAccessKey(client, fixture.workspace, racingOutput)).rejects.toThrow('revoked');
      expect(fixture.server.auth.authenticateClient(racedKey)).toBeNull();
      expect(await fs.readFile(racingOutput, 'utf8')).toBe('existing');
      expect(fixture.logs.join('\n')).not.toContain(credential);
    } finally { await fixture.cleanup(); }
  });

  it('bootstrap output is private or interactive only; revoked codes do not exchange', async () => {
    const fixture = currentFixture(); const output: string[] = [];
    try {
      const before = fixture.server.auth.safeStatus(fixture.owner).pendingCodeCount;
      await expect(issueBootstrapCode(fixture.client, undefined, false, (text) => { output.push(text); })).rejects.toThrow('private');
      expect(fixture.server.auth.safeStatus(fixture.owner).pendingCodeCount).toBe(before);
      const file = path.join(fixture.root, 'browser-code'); await issueBootstrapCode(fixture.client, file, false, (text) => { output.push(text); });
      const code = await fs.readFile(file, 'utf8'); expect(code).toMatch(/^fb1_/u); expect(output.join('\n')).not.toContain(code);
      await fixture.client.execute({ method: 'auth.bootstrap.revoke', input: { code } });
      await expect(fixture.server.auth.exchange(code, '127.0.0.1')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    } finally { await fixture.cleanup(); }
  });

  it('owner admin client refuses redirects and validates response shape without exposing keys', async () => {
    const fixture = currentFixture(); let redirected = 0;
    const fake = createHttpServer((request, response) => { if (request.url === '/api/admin') { response.writeHead(302, { Location: '/sink' }); response.end(); } else { redirected += 1; response.end(fixture.owner); } });
    const fakePort = await freePort(); await new Promise<void>((resolve) => fake.listen(fakePort, '127.0.0.1', resolve));
    try {
      await expect(createHostAdminClient(fixture.profile.paths, fakePort).execute({ method: 'auth.status', input: {} })).rejects.toThrow('Start the host server');
      expect(redirected).toBe(0);
    } finally { await new Promise<void>((resolve) => fake.close(() => resolve())); await fixture.cleanup(); }
  });

  it('interactive CLI uses existing SDK prompts, keeps replies hidden, and truthfully rejects unsupported/noninteractive login', async () => {
    const fixture = currentFixture(); const printed: string[] = [];
    try {
      const secret = 'synthetic-hidden-response';
      vi.spyOn(fixture.sdk, 'login').mockImplementation(async (_id, _method, interaction) => {
        expect(await interaction.prompt({ type: 'secret', message: 'Fixture response' })).toBe(secret); fixture.configure(); return { type: 'api_key', key: 'synthetic' };
      });
      const io: ProviderLoginIo = { interactive: true, write: (text) => { printed.push(text); }, readPrivate: async () => secret };
      await runProviderLogin(fixture.client, { providerId: 'anthropic', method: 'api_key' }, io, { pollMs: 1 });
      expect(printed.join('\n')).toContain('completed'); expect(printed.join('\n')).not.toContain(secret);
      await expect(runProviderLogin(fixture.client, { providerId: 'unsupported' }, io)).rejects.toThrow('unavailable');
      await expect(runProviderLogin(fixture.client, {}, { ...io, interactive: false })).rejects.toThrow('interactive');
    } finally { await fixture.cleanup(); }
  });

  it('actual compiled CLI under native PTY hides Unicode input and completes the existing SDK login lifecycle', async () => {
    const fixture = currentFixture();
    const secret = 'zażółć hidden-response';
    const started = performance.now(), sdkEvents: { event: string; elapsedMs: number }[] = [];
    const observe = (event: string) => { sdkEvents.push({ event, elapsedMs: Math.round(performance.now() - started) }); };
    try {
      const login = vi.spyOn(fixture.sdk, 'login').mockImplementation(async (_id, _method, interaction) => {
        observe('login-entered');
        const response = await interaction.prompt({ type: 'secret', message: 'Native private fixture response' });
        observe('prompt-response-received'); expect(response).toBe(secret);
        fixture.configure(); observe('sdk-configured'); return { type: 'api_key', key: 'synthetic-native' };
      });
      const result = await runTerminalCli(fixture.home, ['provider', 'login', '--profile', 'host', '--provider-id', 'anthropic', '--method', 'api_key'],
        { marker: 'Input is hidden.', value: secret + 'X\b\r' });
      expect(result.exitCode).toBe(0); expect(result.output).toContain('Provider login completed.');
      expect(login).toHaveBeenCalledOnce(); expect(fixture.logs.join('\n')).not.toContain(secret);
      expect(fixture.server.core.runtime.hostProviderLoginService().hasProviderLoginOwnership()).toBe(false);
      expect(fixture.adapter.invocations.filter(entry => entry.kind === 'providerBlocked')).toEqual([]);
      recordCliResult('native-unicode-hidden-sdk-completion', result, [secret, fixture.owner]);
    } finally {
      console.log(JSON.stringify({ nativeCliSdkTiming: sdkEvents, elapsedMs: Math.round(performance.now() - started), fixtureOnly: true }));
      await fixture.cleanup();
    }
  });

  it('actual native CLI Ctrl+C requests cancellation but retains SDK admission until late settlement', async () => {
    const fixture = currentFixture(), old = deferred();
    try {
      const login = vi.spyOn(fixture.sdk, 'login').mockImplementation(async (_id, _method, interaction) => {
        await interaction.prompt({ type: 'secret', message: 'Native cancel fixture response' }).catch(() => undefined);
        await old.promise;
        interaction.notify({ type: 'progress', message: 'old canceled fixture progress' });
        return { type: 'api_key', key: 'synthetic-canceled' };
      });
      const result = await runTerminalCli(fixture.home, ['provider', 'login', '--profile', 'host', '--provider-id', 'anthropic', '--method', 'api_key'],
        { marker: 'Input is hidden.', value: '\u0003' });
      expect(result.exitCode).toBe(1); expect(result.output).toContain('Provider login canceled.');
      const service = fixture.server.core.runtime.hostProviderLoginService();
      expect(login).toHaveBeenCalledOnce(); expect(service.hasProviderLoginOwnership()).toBe(true);
      await expect(fixture.client.execute({ method: 'provider.start', input: { providerId: 'anthropic', method: 'api_key' } })).rejects.toThrow();
      expect(login).toHaveBeenCalledOnce();
      old.resolve(); await vi.waitFor(() => expect(service.hasProviderLoginOwnership()).toBe(false));
      expect(service.getState(false).providerLogin?.status).toBe('idle');
      recordCliResult('native-cancel-and-held-sdk-settlement', result, [fixture.owner, 'synthetic-canceled']);
    } finally { old.resolve(); await fixture.cleanup(); }
  });

  it('actual native CLI provider error stays generic and never echoes the hidden response', async () => {
    const fixture = currentFixture(), secret = 'synthetic-native-provider-error';
    const service = fixture.server.core.runtime.hostProviderLoginService();
    const cancel = service.cancelProviderLogin.bind(service);
    let statusBeforeCancel: string | undefined;
    // Observe the real state before the CLI's existing cancellation cleanup.
    // Calling the actual method is essential: cancellation resets error to idle.
    const cancellation = vi.spyOn(service, 'cancelProviderLogin').mockImplementation(() => {
      statusBeforeCancel = service.getState(false).providerLogin?.status;
      return cancel();
    });
    try {
      const login = vi.spyOn(fixture.sdk, 'login').mockImplementation(async (_id, _method, interaction) => {
        const value = await interaction.prompt({ type: 'secret', message: 'Native provider error fixture' });
        expect(value).toBe(secret); throw new Error(`fixture error containing ${value}`);
      });
      const result = await runTerminalCli(fixture.home, ['provider', 'login', '--profile', 'host', '--provider-id', 'anthropic', '--method', 'api_key'],
        { marker: 'Input is hidden.', value: secret + '\r' });
      expect(result.exitCode).toBe(1); expect(result.output).toContain('Provider login failed.');
      expect(login).toHaveBeenCalledOnce(); expect(cancellation).toHaveBeenCalledOnce();
      expect(statusBeforeCancel).toBe('error');
      const state = await fixture.client.execute({ method: 'provider.state', input: {} });
      expect(state).toMatchObject({ result: { status: 'idle' } });
      expect(service.hasProviderLoginOwnership()).toBe(false);
      expect(JSON.stringify(state)).not.toContain(secret); expect(fixture.logs.join('\n')).not.toContain(secret);
      recordCliResult('native-provider-error-redaction', result, [secret, fixture.owner]);
    } finally { await fixture.cleanup(); }
  });

  it('actual native CLI refuses an unsupported SDK flow before login invocation', async () => {
    const fixture = currentFixture();
    try {
      const login = vi.spyOn(fixture.sdk, 'login');
      const result = await runTerminalCli(fixture.home, ['provider', 'login', '--profile', 'host', '--provider-id', 'unsupported-fixture']);
      expect(result.exitCode).toBe(1); expect(result.output).toContain('unavailable in this Pi SDK');
      expect(login).not.toHaveBeenCalled(); recordCliResult('native-unsupported-sdk-flow', result, [fixture.owner]);
    } finally { await fixture.cleanup(); }
  });

  it('actual noninteractive CLI refuses login before SDK invocation', async () => {
    const fixture = currentFixture();
    try {
      const login = vi.spyOn(fixture.sdk, 'login');
      const result = await runNoninteractiveCli(fixture.home, ['provider', 'login', '--profile', 'host', '--provider-id', 'anthropic', '--method', 'api_key']);
      expect(result.exitCode).toBe(1); expect(result.output).toContain('interactive host terminal');
      expect(login).not.toHaveBeenCalled(); recordCliResult('noninteractive-login-refusal', result, [fixture.owner]);
    } finally { await fixture.cleanup(); }
  });

  it('actual CLI issues a private client-only key through the sole live owner', async () => {
    const fixture = currentFixture();
    try {
      const before = fixture.adapter.invocations.filter(entry => entry.kind === 'createRuntime').length;
      const output = path.join(fixture.root, 'native client zażółć &.key');
      const result = await runNoninteractiveCli(fixture.home, ['access-key', 'create', '--profile', 'host', '--workspace', fixture.workspace, '--out-file', output]);
      expect(result.exitCode).toBe(0);
      const receipt: unknown = JSON.parse(result.output);
      if (!receipt || typeof receipt !== 'object' || !('clientId' in receipt) || typeof receipt.clientId !== 'string') throw new Error('Actual CLI receipt invalid');
      const credential = await readClientCredentialReference(output);
      expect(fixture.server.auth.authenticateClient(credential)?.kind).toBe('client');
      expect(() => fixture.server.auth.assertOwner(credential)).toThrow();
      expect(fixture.adapter.invocations.filter(entry => entry.kind === 'createRuntime').length).toBe(before);
      recordCliResult('actual-cli-private-client-key-issuance', result, [credential, fixture.owner]);
    } finally { await fixture.cleanup(); }
  });

  it('actual CLI revokes a private client key without starting a second writer', async () => {
    const fixture = currentFixture();
    try {
      const before = fixture.adapter.invocations.filter(entry => entry.kind === 'createRuntime').length;
      const output = path.join(fixture.root, 'revocation fixture.key');
      const issued = await issueAccessKey(fixture.client, fixture.workspace, output);
      const credential = await readClientCredentialReference(output);
      const result = await runNoninteractiveCli(fixture.home, ['access-key', 'revoke', '--profile', 'host', '--client-id', issued.clientId]);
      expect(result.exitCode).toBe(0); expect(result.output).toContain('Client access revoked.');
      expect(fixture.server.auth.authenticateClient(credential)).toBeNull();
      expect(fixture.adapter.invocations.filter(entry => entry.kind === 'createRuntime').length).toBe(before);
      recordCliResult('actual-cli-private-client-key-revocation', result, [credential, fixture.owner]);
    } finally { await fixture.cleanup(); }
  });

});

describe('T45 foreground ownership', () => {
  it('foreground host retains its process and signal ownership until an incomplete shutdown really settles', async () => {
    const signals = new EventEmitter(), actual = deferred(), stopped = deferred(); const printed: string[] = [];
    let finished = false;
    const result = runForegroundHost({ stop: async () => { stopped.resolve(); return { status: 'incomplete', reason: 'timeout' }; },
      core: { lifecycle: { settled: () => actual.promise } } }, signals, (text) => { printed.push(text); }).then(() => { finished = true; });
    signals.emit('SIGTERM'); await stopped.promise; await new Promise((resolve) => setImmediate(resolve));
    expect(finished).toBe(false); expect(signals.listenerCount('SIGTERM')).toBe(1); expect(printed.join('\n')).toContain('retains ownership');
    actual.resolve(); await result; expect(finished).toBe(true); expect(signals.listenerCount('SIGTERM')).toBe(0);
  });
});
