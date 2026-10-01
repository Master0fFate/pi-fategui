// TEST ONLY. This entry is never the packaged production server.
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createFateCore } from '../../src/core/createFateCore';
import { startAuthenticatedNodeServerWithFactory } from '../../src/server/http/startAuthenticatedNodeServer';
import { MultiProjectPiRuntime } from '../../src/main/pi/MultiProjectPiRuntime';
import { ownerCredentialPath } from '../../src/server/auth/AuthStore';
import { hostCheckoutLockRoot } from '../../src/core/ownership/CheckoutOwnership';
import { FakePiSdkAdapter } from '../v2/helpers/fakePi';
import { appendInvocationLedger, readInvocationLedger } from './fixture-ledger.mjs';

const [configFile, caseName, contender] = process.argv.slice(2);
if (!configFile || !['tunnel', 'crash', 'stall'].includes(caseName ?? '')) throw new Error('Explicit fixture case required');
const config = JSON.parse(await fs.readFile(configFile, 'utf8')) as { root: string; hostPort: number; localPort: number };
const directory = path.join(config.root, caseName!);
process.env.FATE_V2_TEST_ROOT = config.root;
process.env.HOME = path.join(directory, 'home');
process.env.USERPROFILE = process.env.HOME;
process.env.PI_OFFLINE = '1';
class RemotePiAdapter extends FakePiSdkAdapter {
  override async createRuntime(...args: Parameters<FakePiSdkAdapter['createRuntime']>) {
    const sdkRuntime = await super.createRuntime(...args);
    // The base deterministic adapter emits SDK messages without a provider.
    // Record those actual messages through the SDK's public session-manager
    // API so authenticated snapshot/history reads can reconstruct the result.
    sdkRuntime.session.subscribe(event => {
      if (event.type === 'message_end' && event.message.role === 'assistant') sdkRuntime.session.sessionManager.appendMessage(event.message);
    });
    return sdkRuntime;
  }
}
// A legitimate zero-invocation startup must have a real durable empty ledger.
// Do this before composition; append-open preserves evidence across restart.
const ledgerFile = path.join(directory, 'invocations.jsonl');
await appendInvocationLedger(ledgerFile, []);
const adapter = new RemotePiAdapter();
const workspace = path.join(directory, 'workspace');
const server = await startAuthenticatedNodeServerWithFactory({
  profile: { profileId: contender === 'checkout' ? 'competitor' : caseName, home: process.env.HOME },
  workspaces: [workspace], host: '127.0.0.1', port: contender ? config.hostPort + 1 : config.hostPort,
  browserOrigins: [`http://127.0.0.1:${config.localPort}`], flags: { terminal: false, browser: false }, maxPermission: 'edit',
}, options => createFateCore({ ...options, adapter, shutdownBudgetMs: 100,
  createRuntime: deps => new MultiProjectPiRuntime({ ...deps, createSessionTitleGenerator: () => ({ generate: async () => null }) }),
}));
if (contender) throw new Error('OWNERSHIP_FAILURE: competing host acquired ownership');
const runtime = server.core.runtime.peekWorkspace(workspace)!;
const handle = await server.core.workspaces!.registerHostPath(workspace);
const sessionId = runtime.getState(false).sessionId!;
const control = adapter.controls.get(sessionId)!;
control.text = `original ${caseName} fixture result`;
control.barriers.hold('settle');
if (caseName === 'stall') { control.refuseCancellation = true; control.barriers.hold('cancelFailure'); }
const before = await fs.readFile(path.join(workspace, 'sentinel.txt'), 'utf8');
adapter.plannedEdits.set(sessionId, { path: path.join(workspace, 'sentinel.txt'), before, after: `remote ${caseName} effect\n` });
const startIdentity = (await fs.readFile(`/proc/${process.pid}/stat`, 'utf8')).slice((await fs.readFile(`/proc/${process.pid}/stat`, 'utf8')).lastIndexOf(')') + 2).split(' ')[19];
const identity = { pid: process.pid, startIdentity, serverEpoch: server.serverEpoch, hostId: server.hostId };
async function save(name: string, value: unknown) {
  const target = path.join(directory, name); const file = await fs.open(`${target}.tmp`, 'w', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await fs.rename(`${target}.tmp`, target);
}
let persisted = 0;
let persistTail: Promise<void> = Promise.resolve();
function persistInvocations(): Promise<void> {
  const next = persistTail.then(persistBatch);
  persistTail = next;
  return next;
}
async function persistBatch() {
  const entries = adapter.invocations.slice(persisted);
  await appendInvocationLedger(ledgerFile, entries.map(entry => ({ ...identity, ...entry })));
  persisted += entries.length;
}
// Hold the real runtime result only in the crash case. Journal admission and
// SDK execution are unchanged; this deterministic test-only seam prevents the
// effect receipt/HTTP response from settling before the separate SIGKILL.
const originalPrompt = runtime.prompt.bind(runtime);
runtime.prompt = async (...args: Parameters<typeof runtime.prompt>) => {
  const result = await originalPrompt(...args);
  if (caseName === 'crash' && result.accepted) {
    while (!adapter.invocations.some(entry => entry.kind === 'toolResult' && entry.name === 'edit')) await new Promise(r => setTimeout(r, 10));
    await persistInvocations(); await server.core.recovery.flush();
    await save('before-response.json', { ...identity, sessionId, admittedEffect: true, responseReleased: false });
    await new Promise<void>(() => { /* Host-kill only: no response released. */ });
  }
  return result;
};
async function inspect() {
  await persistInvocations(); await server.core.recovery.flush();
  const ledger = await readInvocationLedger(ledgerFile);
  const locks = await fs.readdir(server.core.paths.lockRoot);
  const lockRecords = [];
  for (const namespace of [server.core.paths.lockRoot, hostCheckoutLockRoot()]) {
    for (const name of await fs.readdir(namespace).catch(() => [] as string[])) {
      if (!/^(?:profile|checkout)-[a-f0-9]{64}\.lock$/u.test(name)) continue;
      lockRecords.push({ directory: path.join(namespace, name), record: JSON.parse(await fs.readFile(path.join(namespace, name, 'owner.json'), 'utf8')) });
    }
  }
  return { ...identity, sessionId, workspaceId: handle.id, workspaceGeneration: handle.generation,
    selectionRevision: handle.admission.snapshot().selectionRevision, running: runtime.getState(false).activeSessionRunning,
    text: control.text, invocationCount: ledger.filter(entry => entry.kind === 'prompt').length, ledger,
    sentinelBase64: (await fs.readFile(path.join(workspace, 'sentinel.txt'))).toString('base64'),
    diff: execFileSync('git', ['-C', workspace, 'diff', '--no-ext-diff', '--', 'sentinel.txt'], { encoding: 'utf8' }),
    profileLocks: locks.filter(name => name.startsWith('profile-')), lockRecords, checkoutOwned: server.core.runtime.ownsCheckout(workspace),
    recovery: server.core.recovered, lifecycle: await server.core.recovery.repository.read(), snapshot: runtime.getState(true),
    journalRecords: await fs.readdir(path.join(server.core.paths.dataRoot, 'commands', 'v1')).then(async names => Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/u.test(name)).map(async name => JSON.parse(await fs.readFile(path.join(server.core.paths.dataRoot, 'commands', 'v1', name), 'utf8')))), () => []),
  };
}
await persistInvocations();
await save('ready.json', await inspect());
let lastDirective = '';
let busy = false;
setInterval(() => {
  if (busy) return; busy = true;
  void (async () => {
    const directive = await fs.readFile(path.join(directory, 'directive.json'), 'utf8').then(text => JSON.parse(text) as { id: string; action: string }, () => null);
    if (!directive || lastDirective === directive.id) return;
    lastDirective = directive.id;
    try {
      let result: unknown;
      if (directive.action === 'inspect') result = await inspect();
      else if (directive.action === 'bootstrap') {
        const owner = await fs.readFile(ownerCredentialPath(server.core.paths), 'utf8');
        result = await server.auth.createBootstrapCode(owner);
      } else if (directive.action === 'release') { control.barriers.releaseAll(); result = await inspect(); }
      else if (directive.action === 'stop') { result = { shutdown: await server.stop(), inspection: await inspect() }; }
      else if (directive.action === 'exit') { control.barriers.releaseAll(); await adapter.dispose(); await persistInvocations(); process.exit(0); }
      else throw new Error('Unknown fixture directive');
      await save('reply.json', { id: directive.id, ok: true, result });
    } catch (error) { await save('reply.json', { id: directive.id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
  })().catch(error => { process.stderr.write(`${String(error)}\n`); }).finally(() => { busy = false; });
}, 25);
