import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CommandJournal } from '../../../src/core/commands/CommandJournal';
import { Dispatcher, type HandlerMap } from '../../../src/core/dispatch/Dispatcher';
import { createLocalIpcContext } from '../../../src/core/dispatch/RequestContext';
import { createScopedFileHandlers } from '../../../src/core/handlers/fileHandlers';
import { createScopedRuntimeHandlers } from '../../../src/core/handlers/runtimeHandlers';
import { createScopedSessionHandlers } from '../../../src/core/handlers/sessionHandlers';
import { createMutationIdentity } from '../../../src/shared/protocol/requestIds';
import { FakePiSdkAdapter } from './fakePi';
import { assertPrivatePath, privateTestRoot } from './isolatedEnvironment';
import { startTestNodeServer } from './nodeServerFactory';

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for actual fake turn settlement.');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

/** One temporary host, one registered project. Runs in the isolated plain Node smoke child. */
export async function runHeadlessSmoke(): Promise<void> {
  const root = await mkdtemp(path.join(privateTestRoot(), 'headless-smoke-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const file = path.join(project, 'sentinel.txt');
  const initial = Buffer.from('before: headless smoke\n');
  const changed = Buffer.from('after: controlled fake edit\n');
  const config = { profile: { profileId: 'headless-smoke', home }, workspaces: [project], host: '127.0.0.1', port: 47819,
    flags: { browser: false, terminal: false }, maxPermission: 'edit' };
  let adapter: FakePiSdkAdapter | undefined;
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(project, { recursive: true, mode: 0o700 });
    await writeFile(file, initial);
    await assertPrivatePath(project);
    // Import and start the independently built production artifact in THIS Node child.
    // No fake selector exists on that entry; its profile lock must be released first.
    const production = await import(pathToFileURL(path.resolve('dist/server/main.js')).href);
    const actual = await production.startNodeServer(config);
    assert.equal(actual.readiness.listener, 'disabled');
    assert.equal(actual.readiness.provider, 'auth-required');
    assert.deepEqual(await actual.stop(), { status: 'settled' });
    adapter = new FakePiSdkAdapter();
    const server = await startTestNodeServer(config, adapter);
    const core = server.core;
    const lockRoot = core.paths.lockRoot;
    try {
      assert.equal(server.readiness.listener, 'disabled');
      const handle = await core.workspaces!.registerHostPath(project);
      const permission = await handle.runtime.setPermissionLevel('edit');
      assert.equal(permission.permissionLevel, 'edit');
      const sessionId = handle.runtime.getState(false).sessionId;
      assert.ok(sessionId);
      const control = adapter.controls.get(sessionId);
      assert.ok(control);
      const principalId = randomUUID();
      const identity = createLocalIpcContext({ principalId, clientId: randomUUID(), expiresAt: Date.now() + 120_000 });
      const epoch = randomUUID();
      const journal = new CommandJournal({ root: path.join(core.paths.dataRoot, 'commands', 'v1'), serverEpoch: epoch });
      const authority = () => ({ currentGeneration: handle.generation, controlGeneration: 1,
        permission: handle.runtime.getState(false).permissionLevel === 'edit', principalId });
      const runtime = createScopedRuntimeHandlers(handle, authority);
      const sessions = createScopedSessionHandlers(handle, authority);
      const files = createScopedFileHandlers(handle, authority);
      const selection = () => handle.admission.snapshot();
      const command = (context: { workspace: { generation: number; selectionRevision: number }; session: { sessionId: string }; controlGeneration: number }) => ({
        workspaceGeneration: context.workspace.generation, expectedSessionId: context.session.sessionId,
        selectionRevision: context.workspace.selectionRevision, controlGeneration: context.controlGeneration,
      });
      const handlers: HandlerMap = {
        'host.info': (_input, ctx) => ({ hostId: randomUUID(), protocol: 1, serverEpoch: epoch, serverTime: ctx.serverTime,
          appVersion: '1.1.0', capabilities: ['host.info'], networkDispatchEnabled: false }),
        'workspace.list': () => ({ workspaces: [{ workspaceId: handle.id, workspaceGeneration: handle.generation, label: 'project' }] }),
        'file.list': (input) => files.listResource(input),
        'file.previewText': (input) => files.previewTextResource(input),
        'runtime.prompt': async (input, ctx) => {
          const accepted = await runtime.prompt(command(ctx), input);
          return { ...accepted, sessionId, viewRevision: selection().selectionRevision };
        },
        'runtime.abort': async (input, ctx) => {
          const stopped = await runtime.abort(command(ctx), input);
          return { ...stopped, sessionId, viewRevision: selection().selectionRevision };
        },
        'session.select': async (input, ctx) => {
          await sessions.selectSession(command(ctx), input);
          return { sessionId: input.sessionId, selectionRevision: selection().selectionRevision, viewRevision: selection().selectionRevision };
        },
      };
      const dispatcher = new Dispatcher({ serverEpoch: epoch, handlers, commandJournal: journal, resolvers: {
        authenticate: (who) => who === identity,
        isMember: (who, workspaceId) => who === identity && workspaceId === handle.id,
        workspace: (who, workspaceId) => who === identity && workspaceId === handle.id ? {
          workspaceId: handle.id, generation: handle.generation, selectedSessionId: selection().selectedSessionId,
          selectionRevision: selection().selectionRevision, handle,
        } : null,
        hasCapability: () => true,
        hasControl: (who, _workspace, generation) => who === identity && generation === 1,
        hasPermission: (_who, _workspace, operation) => operation === 'read' || handle.runtime.getState(false).permissionLevel === 'edit',
        session: (_who, _workspace, id) => id === sessionId ? { sessionId, workspaceId: handle.id,
          workspaceGeneration: handle.generation, handle: handle.runtime } : null,
        resource: (_who, _workspace, id, kind) => ({ resourceId: id, kind, workspaceId: handle.id,
          workspaceGeneration: handle.generation, handle: files }),
      } });
      const scoped = { protocol: 1, workspaceId: handle.id, workspaceGeneration: handle.generation, serverEpoch: epoch };
      const dispatch = async (request: object) => dispatcher.dispatchJson(JSON.stringify(request), identity);
      const prompt = async (text: string) => {
        const envelope = { ...scoped, ...createMutationIdentity(epoch), method: 'runtime.prompt', expectedSessionId: sessionId,
          selectionRevision: selection().selectionRevision, controlGeneration: 1, input: { text } };
        const receipt = await dispatch(envelope);
        assert.equal(receipt.ok, true, JSON.stringify(receipt));
        if (!receipt.ok || receipt.method !== 'runtime.prompt') throw new Error('Prompt rejected');
        assert.equal(receipt.result.kind, 'prompt');
        assert.equal(receipt.result.durability, 'journaled');
        assert.equal(receipt.result.outcome, 'accepted');
        const status = await dispatch({ ...scoped, requestId: randomUUID(), issuedAt: Date.now(), method: 'command.status',
          input: { requestId: envelope.requestId } });
        assert.equal(status.ok, true, JSON.stringify(status));
        if (!status.ok || status.method !== 'command.status') throw new Error('Status rejected');
        assert.equal(status.result.state, 'settled');
        return receipt.result;
      };
      adapter.plannedEdits.set(sessionId, { path: file, before: initial.toString(), after: changed.toString() });
      control.barriers.hold('settle');
      const first = await prompt('Make one controlled fixture edit.');
      await control.barriers.reached('settle');
      assert.deepEqual(await readFile(file), changed);
      const listed = await dispatch({ ...scoped, requestId: randomUUID(), issuedAt: Date.now(), method: 'file.list',
        input: { directoryId: null, limit: 10 } });
      assert.equal(listed.ok, true);
      if (!listed.ok || listed.method !== 'file.list') throw new Error('Scoped file listing failed');
      const entry = listed.result.entries.find((item) => item.name === 'sentinel.txt');
      assert.ok(entry);
      const preview = await dispatch({ ...scoped, requestId: randomUUID(), issuedAt: Date.now(), method: 'file.previewText',
        input: { fileId: entry.resourceId, maxBytes: 1024 } });
      assert.equal(preview.ok, true);
      if (!preview.ok || preview.method !== 'file.previewText') throw new Error('Scoped file preview failed');
      assert.equal(preview.result.content, changed.toString());
      assert.equal(adapter.invocations.filter((item) => item.kind === 'toolResult' && item.name === 'edit').length, 1);
      control.barriers.release('settle');
      await waitFor(() => adapter!.invocations.filter((item) => item.kind === 'settled').length === 1
        && !handle.runtime.hasEvictionBlockingWork());
      assert.ok(first.runId);
      // A second turn stays live after its only client disconnects. No transport is opened.
      control.barriers.hold('settle');
      const client = core.createClient({ disposeSubscriptions: () => { /* the subscriber belongs to the client */ } });
      await prompt('Continue after the client disconnects.');
      await control.barriers.reached('settle');
      await core.disposeClient(client);
      assert.equal(core.runtime.ownsCheckout(project), true);
      assert.equal(adapter.invocations.filter((item) => item.kind === 'cancel').length, 0);
      control.barriers.release('settle');
      await waitFor(() => adapter!.invocations.filter((item) => item.kind === 'settled').length === 2
        && !handle.runtime.hasEvictionBlockingWork());
      assert.equal(handle.runtime.getState(false).streaming, false);
      assert.deepEqual(await readFile(file), changed);
      // A shutdown may probe the fake provider's blocked cancellation path;
      // execution itself must never call a real model provider.
      assert.deepEqual(adapter.invocations.filter((item) => item.kind === 'providerBlocked').map((item) => item.name), []);
      assert.deepEqual(await server.stop(), { status: 'settled' });
      assert.equal(core.runtime.ownsCheckout(project), false);
      assert.equal((await readdir(lockRoot)).some((name) => name.startsWith('profile-')), false);
      // A separate private profile exercises refusal, without recovering the clean case.
      const refusal = await startTestNodeServer({ ...config, profile: { ...config.profile, profileId: 'headless-refusal' } }, adapter, 60);
      const secondHandle = await refusal.core.workspaces!.registerHostPath(project);
      const secondSession = secondHandle.runtime.getState(false).sessionId;
      assert.ok(secondSession);
      const refused = adapter.controls.get(secondSession);
      assert.ok(refused);
      refused.barriers.hold('settle');
      refused.refuseCancellation = true;
      try {
        const accepted = await secondHandle.runtime.prompt({ text: 'Refuse shutdown', behavior: 'prompt' });
        assert.equal(accepted.accepted, true);
        await refused.barriers.reached('settle');
        const result = await refusal.stop();
        assert.equal(result.status, 'incomplete');
        assert.equal(refusal.core.runtime.ownsCheckout(project), true);
        assert.equal((await readdir(refusal.core.paths.lockRoot)).some((name) => name.startsWith('profile-')), true);
      } finally {
        refused.barriers.releaseAll();
        await refusal.core.dispose().catch(() => undefined);
      }
    } finally {
      if (!core.lifecycle.isStopping) assert.deepEqual(await server.stop(), { status: 'settled' });
    }
  } finally {
    await adapter?.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
