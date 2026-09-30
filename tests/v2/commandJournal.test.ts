import { createHash, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { build } from 'vite';
import { CommandJournal } from '../../src/core/commands/CommandJournal';
import { Dispatcher, type DispatchResolvers, type HandlerMap } from '../../src/core/dispatch/Dispatcher';
import { createLocalIpcContext } from '../../src/core/dispatch/RequestContext';
import { SessionQueueRepository } from '../../src/main/pi/SessionQueueRepository';
import { requestEnvelopeSchema, type MutationRequest } from '../../src/shared/protocol/envelopes';
import { createMutationIdentity } from '../../src/shared/protocol/requestIds';
import { ProtocolFault } from '../../src/shared/protocol/errors';

const epoch = '10000000-0000-4000-8000-000000000001';
const nextEpoch = '10000000-0000-4000-8000-000000000002';
const workspaceId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000003';
const runId = '40000000-0000-4000-8000-000000000004';
const principalId = '50000000-0000-4000-8000-000000000005';
const clientId = '60000000-0000-4000-8000-000000000006';
const start = 1_800_000_000_000;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-journal-test-')); roots.push(home);
  const root = path.join(home, 'profile', 'commands');
  let now = start;
  const journal = (serverEpoch = epoch, limits: { maxRecords?: number; maxBytes?: number } = {}) =>
    new CommandJournal({ root, serverEpoch, now: () => now, ...limits });
  const request = (text = 'Synthetic prompt only.', issuedAt = start): MutationRequest => requestEnvelopeSchema.parse({ protocol: 1,
    ...createMutationIdentity(epoch, issuedAt), method: 'runtime.prompt', workspaceId, workspaceGeneration: 3,
    expectedSessionId: sessionId, selectionRevision: 8, controlGeneration: 5, input: { text },
  }) as MutationRequest;
  const receipt = (id: string) => ({ kind: 'prompt' as const, requestId: id, durability: 'journaled' as const,
    outcome: 'accepted' as const, runId, sessionId, viewRevision: 9 });
  return { home, root, journal, request, receipt, setTime: (value: number) => { now = value; } };
}

describe('T25 durable command admission', () => {
  it('serializes two concurrent identical IDs and persists one compact receipt, without a prompt body', async () => {
    const f = await fixture(); const command = f.request('private-prompt-sentinel');
    let unblock: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const effect = vi.fn(async () => { await gate; return f.receipt(command.requestId); });
    const owner = f.journal();
    const first = owner.execute(command, principalId, effect);
    const second = owner.execute(command, principalId, effect);
    await expect(owner.execute({ ...command, input: { text: 'changed while pending' } } as MutationRequest, principalId, effect))
      .rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    unblock();
    expect(await Promise.all([first, second])).toEqual([f.receipt(command.requestId), f.receipt(command.requestId)]);
    expect(effect).toHaveBeenCalledOnce();
    const files = await fs.readdir(f.root);
    const recordName = `${createHash('sha256').update(command.requestId).digest('hex')}.json`;
    expect(files).toContain(recordName);
    expect(files.filter((name) => !name.startsWith('clock-'))).toEqual([recordName]);
    const bytes = await fs.readFile(path.join(f.root, recordName), 'utf8');
    expect(bytes).not.toContain('private-prompt-sentinel');
    expect(bytes).not.toContain('text');
    expect(await f.journal(nextEpoch).status(command.requestId, workspaceId, principalId)).toEqual({ state: 'settled', receipt: f.receipt(command.requestId), rejectionCode: null });
  });

  it('keeps status, abort and another workspace live while serializing distinct same-workspace effects', async () => {
    const f = await fixture(); const owner = f.journal();
    const first = f.request('first'); const second = f.request('second');
    const other = { ...f.request('other workspace'), workspaceId: clientId } as MutationRequest;
    const abort = requestEnvelopeSchema.parse({ protocol: 1, ...createMutationIdentity(epoch, start),
      method: 'runtime.abort', workspaceId, workspaceGeneration: 3, expectedSessionId: sessionId,
      selectionRevision: 8, controlGeneration: 5, input: {} }) as MutationRequest;
    let unblock: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const firstEffect = vi.fn(async () => { entered(); await gate; return f.receipt(first.requestId); });
    const secondEffect = vi.fn(async () => f.receipt(second.requestId));
    const pending = owner.execute(first, principalId, firstEffect);
    await started;
    const waiting = owner.execute(second, principalId, secondEffect);
    expect(await owner.status(first.requestId, workspaceId, principalId)).toMatchObject({ state: 'admitted' });
    expect(secondEffect).not.toHaveBeenCalled();
    const abortReceipt = { kind: 'abort' as const, requestId: abort.requestId, durability: 'journaled' as const,
      outcome: 'abort-reported' as const, sessionId, viewRevision: 9 };
    expect(await owner.execute(abort, principalId, async () => abortReceipt)).toEqual(abortReceipt);
    expect(await owner.execute(other, principalId, async () => f.receipt(other.requestId))).toEqual(f.receipt(other.requestId));
    expect(secondEffect).not.toHaveBeenCalled();
    unblock();
    await pending; await waiting;
    expect(firstEffect).toHaveBeenCalledOnce(); expect(secondEffect).toHaveBeenCalledOnce();
  });

  it('rejects changed input/scope/principal under the same ID and never repeats an effect', async () => {
    const f = await fixture(); const command = f.request(); const owner = f.journal();
    const effect = vi.fn(async () => f.receipt(command.requestId));
    await owner.execute(command, principalId, effect);
    const changed = { ...command, input: { text: 'Different text.' } } as MutationRequest;
    await expect(owner.execute(changed, principalId, effect)).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await expect(owner.execute(command, clientId, effect)).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    expect(effect).toHaveBeenCalledOnce();
  });

  it('records a revoked pre-entry control check as a stable rejection, never an unknown effect', async () => {
    const f = await fixture(); const command = f.request(); const owner = f.journal();
    const effect = vi.fn(async () => f.receipt(command.requestId));
    await expect(owner.execute(command, principalId, effect, () => undefined,
      () => { throw new ProtocolFault('CONTROL_REQUIRED'); })).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
    expect(await owner.status(command.requestId, workspaceId, principalId)).toEqual({ state: 'rejected', receipt: null, rejectionCode: 'CONTROL_REQUIRED' });
    await expect(f.journal().execute(command, principalId, effect)).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
    expect(effect).not.toHaveBeenCalled();
  });

  it('fails closed on a syntactically valid but cross-linked receipt record', async () => {
    const f = await fixture(); const command = f.request(); const owner = f.journal();
    await owner.execute(command, principalId, async () => f.receipt(command.requestId));
    const target = path.join(f.root, `${createHash('sha256').update(command.requestId).digest('hex')}.json`);
    const record = JSON.parse(await fs.readFile(target, 'utf8')) as { receipt: { requestId: string } };
    record.receipt.requestId = createMutationIdentity(epoch, start).requestId;
    await fs.writeFile(target, JSON.stringify(record));
    await expect(owner.status(command.requestId, workspaceId, principalId)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    const effect = vi.fn(async () => f.receipt(command.requestId));
    await expect(owner.execute(command, principalId, effect)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(effect).not.toHaveBeenCalled();
  });

  it('CMD-02 kills a real Node owner after the durable effect marker but before its receipt', async () => {
    const f = await fixture();
    const command = f.request('synthetic crash-only prompt');
    const bundleRoot = path.join(f.home, 'child-bundle');
    // Bundle the production TS module, not a reimplementation. This private bundle has
    // no Electron, provider, network listener, credential store, or real project path.
    await build({ configFile: false, envFile: false, publicDir: false, logLevel: 'silent',
      build: { outDir: bundleRoot, emptyOutDir: false, copyPublicDir: false, minify: false,
        // Do not leave a bare package import that Node cannot resolve from the private temp root.
        rollupOptions: { external: (id: string) => id.startsWith('node:') },
        lib: { entry: path.resolve('src/core/commands/CommandJournal.ts'), formats: ['es'], fileName: () => 'journal.mjs' } } });
    expect(await fs.readdir(bundleRoot)).toContain('journal.mjs');
    const marker = path.join(f.home, 'effect-marker.txt');
    const childScript = path.join(bundleRoot, 'crash-owner.mjs');
    await fs.writeFile(childScript, `
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CommandJournal } from './journal.mjs';
const [root, epoch, principal, marker, requestJson, now] = process.argv.slice(2);
const journal = new CommandJournal({ root, serverEpoch: epoch, now: () => Number(now) });
process.on('disconnect', () => {});
void journal.execute(JSON.parse(requestJson), principal, async () => {
  const file = await fs.open(marker, 'wx', 0o600);
  try { await file.writeFile('effect once'); await file.sync(); } finally { await file.close(); }
  if (process.platform !== 'win32') {
    const directory = await fs.open(path.dirname(marker), 'r');
    try {
      await directory.sync();
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error;
    } finally { await directory.close(); }
  }
  process.send?.({ stage: 'effect-durable' });
  setInterval(() => {}, 1_000); // Keep the real process alive until its parent kills it.
  return new Promise(() => {}); // No receipt is returned or persisted.
}).catch((error) => {
  process.stderr.write(String(error?.stack ?? error).slice(0, 2_048));
  process.send?.({ stage: 'journal-error', code: typeof error?.code === 'string' ? error.code : 'CHILD_ERROR' });
  process.exitCode = 2;
});
`, 'utf8');
    const child = fork(childScript, [f.root, epoch, principalId, marker, JSON.stringify(command), String(start)], {
      execPath: process.execPath, execArgv: [], cwd: f.home, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
        HOME: f.home, USERPROFILE: f.home, APPDATA: f.home, LOCALAPPDATA: f.home,
        TMP: f.home, TEMP: f.home, TMPDIR: f.home, PI_OFFLINE: '1', NODE_ENV: 'test' },
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 2_048) stderr += chunk.toString('utf8').slice(0, 2_048 - stderr.length);
    });
    const detail = () => stderr.replaceAll(f.home, '<private-temp>').replaceAll(bundleRoot, '<private-bundle>').slice(0, 2_048);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error(`Child did not reach durable effect marker: ${detail()}`)); }, 10_000);
        const onMessage = (message: unknown) => {
          if (typeof message !== 'object' || message === null || !('stage' in message)) return;
          if (message.stage === 'effect-durable') { cleanup(); resolve(); }
          if (message.stage === 'journal-error') { cleanup(); reject(new Error(`Child journal failed (${String('code' in message ? message.code : 'unknown')}): ${detail()}`)); }
        };
        const onExit = () => { cleanup(); reject(new Error(`Child exited before durable effect marker (exit ${child.exitCode}, signal ${child.signalCode}): ${detail()}`)); };
        const onError = (error: Error) => { cleanup(); reject(new Error(`Child spawn failed: ${error.message}; ${detail()}`)); };
        const cleanup = () => { clearTimeout(timer); child.off('message', onMessage); child.off('close', onExit); child.off('error', onError); };
        child.on('message', onMessage); child.once('close', onExit); child.once('error', onError);
      });
      const stopped = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Child did not terminate')); }, 10_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      child.kill('SIGKILL');
      await stopped;
      expect(await fs.readFile(marker, 'utf8')).toBe('effect once');
      const restarted = f.journal();
      expect(await restarted.status(command.requestId, workspaceId, principalId)).toEqual({ state: 'outcome_unknown', receipt: null, rejectionCode: null });
      const replay = vi.fn(async () => f.receipt(command.requestId));
      await expect(restarted.execute(command, principalId, replay)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
      expect(replay).not.toHaveBeenCalled();
      expect(await fs.readFile(marker, 'utf8')).toBe('effect once');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { child.off('exit', onExit); resolve(); }, 3_000);
          const onExit = () => { clearTimeout(timer); resolve(); };
          child.once('exit', onExit);
          child.kill('SIGKILL');
        });
      }
    }
  }, 30_000); // Real Windows Node boot, private bundle, IPC and forced termination need a bounded window.

  it('models process loss after reservation, after effect and before response with no replay', async () => {
    const f = await fixture(); const before = f.request();
    const owner = f.journal();
    const never = vi.fn(async () => f.receipt(before.requestId));
    await expect(owner.execute(before, principalId, async () => { throw new Error('crash after reservation'); })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    const restarted = f.journal(nextEpoch);
    expect(await restarted.status(before.requestId, workspaceId, principalId)).toEqual({ state: 'outcome_unknown', receipt: null, rejectionCode: null });
    await expect(f.journal().execute(before, principalId, never)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(never).not.toHaveBeenCalled();
    const after = f.request('second synthetic prompt');
    const marker = path.join(f.home, 'effect-count.txt');
    await expect(owner.execute(after, principalId, async () => {
      await fs.writeFile(marker, 'one effect');
      // Fake process dies after the external effect, before it returns its receipt.
      throw new Error('synthetic crash after effect');
    })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(await fs.readFile(marker, 'utf8')).toBe('one effect');
    expect(await restarted.status(after.requestId, workspaceId, principalId)).toEqual({ state: 'outcome_unknown', receipt: null, rejectionCode: null });
    await expect(owner.execute(after, principalId, never)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(never).not.toHaveBeenCalled();
    const settled = f.request('third synthetic prompt');
    const confirmation = await owner.execute(settled, principalId, async () => f.receipt(settled.requestId));
    expect(await f.journal(nextEpoch).status(settled.requestId, workspaceId, principalId)).toEqual({ state: 'settled', receipt: confirmation, rejectionCode: null });
  });

  it('keeps an admitted record unknown if saving the receipt fails after the effect', async () => {
    const f = await fixture(); const command = f.request();
    const marker = path.join(f.home, 'effect-marker'); const owner = f.journal();
    await expect(owner.execute(command, principalId, async () => {
      await fs.writeFile(marker, 'effect ran once');
      await fs.rename(f.root, `${f.root}-offline`);
      await fs.writeFile(f.root, 'disk failure fixture');
      return f.receipt(command.requestId);
    })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    await fs.rm(f.root);
    await fs.rename(`${f.root}-offline`, f.root);
    expect(await fs.readFile(marker, 'utf8')).toBe('effect ran once');
    expect(await f.journal(nextEpoch).status(command.requestId, workspaceId, principalId)).toEqual({ state: 'outcome_unknown', receipt: null, rejectionCode: null });
    const effect = vi.fn(async () => f.receipt(command.requestId));
    await expect(owner.execute(command, principalId, effect)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(effect).not.toHaveBeenCalled();
  });

  it('rejects expired, future and old-epoch IDs even after settled pruning; status still reads old epochs', async () => {
    const f = await fixture(); const command = f.request(); const owner = f.journal();
    await owner.execute(command, principalId, async () => f.receipt(command.requestId));
    const future = f.request('clock skew', start + 5 * 60 * 1000 + 1);
    const futureEffect = vi.fn(async () => f.receipt(future.requestId));
    await expect(owner.execute(future, principalId, futureEffect)).rejects.toMatchObject({ code: 'CLOCK_SKEW' });
    expect(futureEffect).not.toHaveBeenCalled();
    f.setTime(start + 8 * 24 * 60 * 60 * 1000);
    const fresh = f.request('fresh', start + 8 * 24 * 60 * 60 * 1000);
    const effect = vi.fn(async () => f.receipt(fresh.requestId));
    await expect(owner.execute(command, principalId, effect)).rejects.toMatchObject({ code: 'CLOCK_SKEW' });
    expect(await f.journal(nextEpoch).status(command.requestId, workspaceId, principalId)).toMatchObject({ state: 'settled' });
    await owner.execute(fresh, principalId, effect); // prunes expired settled records
    expect(await owner.status(command.requestId, workspaceId, principalId)).toEqual({ state: 'absent', receipt: null, rejectionCode: null });
    await expect(owner.execute(command, principalId, effect)).rejects.toMatchObject({ code: 'CLOCK_SKEW' });
    f.setTime(start); // Restore wall clock into the original ID's 24-hour admission window.
    await expect(f.journal().execute(command, principalId, effect)).rejects.toMatchObject({ code: 'CLOCK_SKEW' });
    await expect(f.journal(nextEpoch).execute(command, principalId, effect)).rejects.toMatchObject({ code: 'SERVER_RESTARTED' });
    expect(effect).toHaveBeenCalledOnce();
  });

  it('serializes settlement files with new reservations while independent effects overlap', async () => {
    const f = await fixture(); const owner = f.journal();
    const one = f.request('one'); const two = { ...f.request('two'), workspaceId: clientId } as MutationRequest;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let arrivals = 0;
    let both: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => { both = resolve; });
    const effect = (id: string) => async () => { if (++arrivals === 2) both(); await gate; return f.receipt(id); };
    const a = owner.execute(one, principalId, effect(one.requestId));
    const b = owner.execute(two, principalId, effect(two.requestId));
    await entered;
    release();
    const three = f.request('three');
    const c = owner.execute(three, principalId, async () => f.receipt(three.requestId));
    expect(await Promise.all([a, b, c])).toHaveLength(3);
  });

  it('ignores bounded orphan temp files during admission and quarantines them only under exclusive ownership', async () => {
    const f = await fixture(); const owner = f.journal(); const first = f.request();
    await owner.execute(first, principalId, async () => f.receipt(first.requestId));
    const name = `${createHash('sha256').update(first.requestId).digest('hex')}.json.${randomUUID()}.tmp`;
    await fs.writeFile(path.join(f.root, name), '{incomplete crash tail');
    const next = f.request('next');
    await owner.execute(next, principalId, async () => f.receipt(next.requestId));
    const quarantine = path.join(f.home, 'quarantine');
    await expect(owner.quarantineOrphanTemps(() => false, quarantine)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(await owner.quarantineOrphanTemps(() => true, quarantine)).toBe(1);
    expect((await fs.readdir(quarantine))[0]).toContain(name);
    expect(await owner.status(first.requestId, workspaceId, principalId)).toMatchObject({ state: 'settled' });
  });

  it('fails closed on quota or disk failure without touching an independent saved draft', async () => {
    const f = await fixture();
    const drafts = new SessionQueueRepository(path.join(f.home, 'drafts'));
    const draft = [{ id: runId, behavior: 'followUp' as const, text: 'draft untouched', createdAt: start }];
    await drafts.save(f.home, sessionId, draft);
    const first = f.request(); const limited = f.journal(epoch, { maxRecords: 1 });
    await limited.execute(first, principalId, async () => f.receipt(first.requestId));
    const second = f.request(); const effect = vi.fn(async () => f.receipt(second.requestId));
    await expect(limited.execute(second, principalId, effect)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(effect).not.toHaveBeenCalled();
    expect(await drafts.load(f.home, sessionId)).toEqual(draft);
    const blockedRoot = path.join(f.home, 'blocked-file');
    await fs.writeFile(blockedRoot, 'not a directory');
    const unavailable = new CommandJournal({ root: blockedRoot, serverEpoch: epoch, now: () => start });
    await expect(unavailable.execute(f.request(), principalId, effect)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(effect).not.toHaveBeenCalled();
    expect(await limited.status(first.requestId, workspaceId, principalId)).toMatchObject({ state: 'settled' });
  });

  it('persists revoked control at the final dispatcher entry as rejection, not unknown', async () => {
    const f = await fixture(); const command = f.request(); let checks = 0;
    const handlers = {
      'host.info': () => ({ hostId: principalId, protocol: 1 as const, serverEpoch: epoch, serverTime: start, appVersion: '2', capabilities: [], networkDispatchEnabled: false as const }),
      'workspace.list': () => ({ workspaces: [] }),
      'file.list': () => ({ directoryId: null, entries: [], truncated: false }),
      'file.previewText': () => ({ fileId: runId, content: '', truncated: false }),
      'runtime.prompt': vi.fn(() => ({ accepted: true, runId, sessionId, viewRevision: 9 })),
      'runtime.abort': () => ({ aborted: false, sessionId, viewRevision: 9 }),
      'session.select': () => ({ sessionId, selectionRevision: 9, viewRevision: 9 }),
    } satisfies HandlerMap;
    const resolvers: DispatchResolvers = { authenticate: () => true, isMember: () => true,
      workspace: () => ({ workspaceId, generation: 3, selectedSessionId: sessionId, selectionRevision: 8, handle: {} }),
      hasCapability: () => true, hasControl: () => ++checks === 1, hasPermission: () => true,
      session: () => ({ sessionId, workspaceId, workspaceGeneration: 3, handle: {} }), resource: () => null };
    const dispatcher = new Dispatcher({ serverEpoch: epoch, handlers, resolvers, commandJournal: f.journal(), now: () => start });
    const identity = createLocalIpcContext({ clientId, principalId, expiresAt: start + 100_000 });
    const dispatch = () => dispatcher.dispatchJson(JSON.stringify(command), identity);
    expect(await dispatch()).toMatchObject({ ok: false, error: { code: 'CONTROL_REQUIRED' }, execution: 'not-started', operationId: null });
    expect(await f.journal().status(command.requestId, workspaceId, principalId)).toEqual({ state: 'rejected', receipt: null, rejectionCode: 'CONTROL_REQUIRED' });
    expect(await dispatch()).toMatchObject({ ok: false, error: { code: 'CONTROL_REQUIRED' }, execution: 'not-started', operationId: null });
    expect(handlers['runtime.prompt']).not.toHaveBeenCalled();
  });

  it('rechecks membership after a joined duplicate waits for the original effect', async () => {
    const f = await fixture(); const command = f.request();
    const state = { member: true };
    let entered: () => void = () => undefined; let finish: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const handlers = {
      'host.info': () => ({ hostId: principalId, protocol: 1 as const, serverEpoch: epoch, serverTime: start, appVersion: '2', capabilities: [], networkDispatchEnabled: false as const }),
      'workspace.list': () => ({ workspaces: [] }),
      'file.list': () => ({ directoryId: null, entries: [], truncated: false }),
      'file.previewText': () => ({ fileId: runId, content: '', truncated: false }),
      'runtime.prompt': vi.fn(async () => { entered(); await gate; return { accepted: true, runId, sessionId, viewRevision: 9 }; }),
      'runtime.abort': () => ({ aborted: false, sessionId, viewRevision: 9 }),
      'session.select': () => ({ sessionId, selectionRevision: 9, viewRevision: 9 }),
    } satisfies HandlerMap;
    const resolvers: DispatchResolvers = { authenticate: () => true, isMember: () => state.member,
      workspace: () => ({ workspaceId, generation: 3, selectedSessionId: sessionId, selectionRevision: 8, handle: {} }),
      hasCapability: () => true, hasControl: () => true, hasPermission: () => true,
      session: () => ({ sessionId, workspaceId, workspaceGeneration: 3, handle: {} }), resource: () => null };
    const dispatcher = new Dispatcher({ serverEpoch: epoch, handlers, resolvers, commandJournal: f.journal(), now: () => start });
    const identity = createLocalIpcContext({ clientId, principalId, expiresAt: start + 100_000 });
    const first = dispatcher.dispatchJson(JSON.stringify(command), identity);
    await started;
    const duplicate = dispatcher.dispatchJson(JSON.stringify(command), identity);
    state.member = false;
    finish();
    const originalResult = await first;
    const joinedResult = await duplicate;
    for (const result of [originalResult, joinedResult]) {
      expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' }, execution: 'unknown', operationId: command.requestId });
      expect(JSON.stringify(result)).not.toContain(runId);
    }
    expect(handlers['runtime.prompt']).toHaveBeenCalledOnce();
    state.member = true;
    const savedDuplicate = dispatcher.dispatchJson(JSON.stringify(command), identity);
    state.member = false; // Revoked during the awaited durable read of an already-settled ID.
    const savedResult = await savedDuplicate;
    expect(savedResult).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' }, execution: 'unknown', operationId: command.requestId });
    expect(JSON.stringify(savedResult)).not.toContain(runId);
    state.member = true;
    const status = { protocol: 1, requestId: runId, serverEpoch: epoch, issuedAt: start, method: 'command.status',
      workspaceId, workspaceGeneration: 3, input: { requestId: command.requestId } };
    expect(await dispatcher.dispatchJson(JSON.stringify(status), identity)).toMatchObject({ ok: true, result: {
      state: 'settled', receipt: f.receipt(command.requestId), rejectionCode: null,
    } });
  });

  it('leaves an explicit abort attempt available when storage fails before any effect', async () => {
    const f = await fixture();
    await fs.mkdir(path.dirname(f.root), { recursive: true });
    await fs.writeFile(f.root, 'unavailable directory');
    const abort = requestEnvelopeSchema.parse({ protocol: 1, ...createMutationIdentity(epoch, start),
      method: 'runtime.abort', workspaceId, workspaceGeneration: 3, expectedSessionId: sessionId,
      selectionRevision: 8, controlGeneration: 5, input: {} });
    const handlers = {
      'host.info': () => ({ hostId: principalId, protocol: 1 as const, serverEpoch: epoch, serverTime: start, appVersion: '2', capabilities: [], networkDispatchEnabled: false as const }),
      'workspace.list': () => ({ workspaces: [] }),
      'file.list': () => ({ directoryId: null, entries: [], truncated: false }),
      'file.previewText': () => ({ fileId: runId, content: '', truncated: false }),
      'runtime.prompt': () => ({ accepted: false, runId, sessionId, viewRevision: 9 }),
      'runtime.abort': vi.fn(() => ({ aborted: true, sessionId, viewRevision: 9 })),
      'session.select': () => ({ sessionId, selectionRevision: 9, viewRevision: 9 }),
    } satisfies HandlerMap;
    const resolvers: DispatchResolvers = { authenticate: () => true, isMember: () => true,
      workspace: () => ({ workspaceId, generation: 3, selectedSessionId: sessionId, selectionRevision: 8, handle: {} }),
      hasCapability: () => true, hasControl: () => true, hasPermission: () => true,
      session: () => ({ sessionId, workspaceId, workspaceGeneration: 3, handle: {} }), resource: () => null };
    const dispatcher = new Dispatcher({ serverEpoch: epoch, handlers, resolvers, commandJournal: f.journal(), now: () => start });
    const identity = createLocalIpcContext({ clientId, principalId, expiresAt: start + 100_000 });
    expect(await dispatcher.dispatchJson(JSON.stringify(abort), identity)).toMatchObject({ ok: true, result: { durability: 'not-journaled', outcome: 'abort-reported' } });
    expect(handlers['runtime.abort']).toHaveBeenCalledOnce();
  });

  it('returns the settled receipt through Dispatcher even after selection/revision change, with current membership checks', async () => {
    const f = await fixture(); const command = f.request(); const state = { member: true, sessionId, revision: 8 };
    const handlers = {
      'host.info': () => ({ hostId: principalId, protocol: 1 as const, serverEpoch: epoch, serverTime: start, appVersion: '2', capabilities: [], networkDispatchEnabled: false as const }),
      'workspace.list': () => ({ workspaces: [] }),
      'file.list': () => ({ directoryId: null, entries: [], truncated: false }),
      'file.previewText': () => ({ fileId: runId, content: '', truncated: false }),
      'runtime.prompt': vi.fn(() => ({ accepted: true, runId, sessionId, viewRevision: 9 })),
      'runtime.abort': () => ({ aborted: false, sessionId, viewRevision: 9 }),
      'session.select': () => ({ sessionId, selectionRevision: 9, viewRevision: 9 }),
    } satisfies HandlerMap;
    const resolvers: DispatchResolvers = { authenticate: () => true, isMember: () => state.member,
      workspace: () => ({ workspaceId, generation: 3, selectedSessionId: state.sessionId, selectionRevision: state.revision, handle: {} }),
      hasCapability: () => true, hasControl: () => true, hasPermission: () => true,
      session: () => ({ sessionId, workspaceId, workspaceGeneration: 3, handle: {} }), resource: () => null };
    const dispatcher = new Dispatcher({ serverEpoch: epoch, handlers, resolvers, commandJournal: f.journal(), now: () => start });
    const identity = createLocalIpcContext({ clientId, principalId, expiresAt: start + 100_000 });
    const dispatch = (input: unknown) => dispatcher.dispatchJson(JSON.stringify(input), identity);
    const first = await dispatch(command);
    expect(first).toMatchObject({ ok: true, result: f.receipt(command.requestId) });
    state.revision = 9;
    expect(await dispatch(command)).toEqual(first);
    expect(handlers['runtime.prompt']).toHaveBeenCalledOnce();
    const status = { protocol: 1, requestId: runId, serverEpoch: epoch, issuedAt: start, method: 'command.status',
      workspaceId, workspaceGeneration: 3, input: { requestId: command.requestId } };
    expect(await dispatch(status)).toMatchObject({ ok: true, result: { state: 'settled', receipt: f.receipt(command.requestId) } });
    state.member = false;
    expect(await dispatch(command)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await dispatch(status)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
});
