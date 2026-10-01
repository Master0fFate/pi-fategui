import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { quote, sshArgs, until, sshExecutable, sshKeygenExecutable } from './fixture-lib.mjs';
import { withFixtureCleanup } from './fixture-cleanup.mjs';
import { assertPrivateFixtureStorage, restrictGeneratedFixtureFile } from './fixture-private-storage.mjs';
import { assertOriginalBrowserSession } from './fixture-session.mjs';
import { verifyReviewedBinding } from './fixture-binding.mjs';
import { awaitOwnedProcess } from './fixture-process.mjs';

/** Evidence assertions only; this helper never executes a fixture or transport. */
export function assertRemoteSentinelEffect(name, before, observed) {
  assert(['tunnel', 'crash', 'stall'].includes(name), 'Unknown remote fixture case');
  assert.equal(before.sentinelBase64, Buffer.from('remote preimage\n').toString('base64'), 'Require exact original remote bytes');
  assert.equal(before.diff, '', 'Remote fixture must start clean');
  assert.match(before.head, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u, 'Require the actual original Git HEAD');
  assert.equal(observed.head, before.head, 'Remote effect must preserve the original Git HEAD');
  assert.equal(observed.sentinelBase64, Buffer.from(`remote ${name} effect\n`).toString('base64'), 'Require exact expected remote effect bytes');
  assert(observed.diff.includes('diff --git a/sentinel.txt b/sentinel.txt\n')
    && observed.diff.includes('-remote preimage\n') && observed.diff.includes(`+remote ${name} effect\n`), 'Require real sentinel preimage/effect Git diff');
}

export async function executeRemoteWorkflow(f, evidence) {
  assert(f.reviewedBinding?.manifest && f.reviewedBinding?.digest, 'Missing independently reviewed fixture hash binding');
  const manifest = f.reviewedBinding.manifest;
  for (const [role, expectedPath] of [['node', f.remoteNode], ['config', f.remoteConfig], ['controller', f.remoteController]]) assert.equal(manifest.files?.find(entry => entry.role === role)?.path, expectedPath);
  const verifyRemote = async () => {
    // Trusted inline READ-ONLY Node code, not the unverified controller/harness.
    // Compare externally reviewed expected bytes before any fixture host starts.
    const code = `const fs=await import('node:fs/promises');const crypto=await import('node:crypto');const bytes=await fs.readFile(process.argv[1]);if(crypto.createHash('sha256').update(bytes).digest('hex')!==process.argv[2])throw Error('Reviewed manifest mismatch');const verify=(${verifyReviewedBinding.toString()});console.log(JSON.stringify(await verify(JSON.parse(bytes.toString('utf8')),process.argv[2],process.argv[1])));`;
    const args = [f.remoteNode, '--input-type=module', '-e', code, f.remoteBindingFile, f.reviewedBinding.digest];
    const result = await evidence.run(sshExecutable(), [...sshArgs(f), args.map(quote).join(' ')]);
    assert.equal(result.code, 0, 'Reviewed package/harness/controller/helper/dependency binding failed BEFORE controller/host execution');
    const proof = JSON.parse(result.stdout); assert.equal(proof.bindingDigest, f.reviewedBinding.digest);
    await evidence.record('reviewed-binding-verified', proof);
  };
  const control = async (action, name = 'tunnel') => {
    await verifyRemote();
    const result = await evidence.run(sshExecutable(), [...sshArgs(f), [f.remoteNode, f.remoteController, f.remoteConfig, action, name, f.reviewedBinding.digest].map(quote).join(' ')]);
    assert.equal(result.code, 0, `Control ${action} failed; see complete process logs`);
    const value = JSON.parse(result.stdout); await evidence.record('control', { action, name, result: value }); return value;
  };
  const preflight = await control('preflight');
  assert.equal(preflight.hostPort, f.hostPort); assert.equal(preflight.localPort, f.localPort);
  assert.equal(preflight.platform, 'linux'); assert.equal(preflight.arch, 'x64'); assert.notEqual(preflight.uid, 0);
  const production = await control('production'); assert.equal(production.code, 0, 'Packaged production boundary/idle proof failed');
  const productionProof = JSON.parse(production.stdout);
  assert.equal(productionProof.kind, 'packaged-production-idle'); assert.equal(productionProof.runtimeOpened, false);
  await evidence.record('production-proof', productionProof);
  const forwardingArgs = (overrides = {}, options = ['-v', '-N', '-L', `127.0.0.1:${f.localPort}:127.0.0.1:${f.hostPort}`]) => {
    const base = sshArgs(f, overrides); return [...base.slice(0, -1), ...options, base.at(-1)];
  };
  const forward = overrides => evidence.launch(sshExecutable(), forwardingArgs(overrides));
  const stopTunnel = async p => {
    if (p.child.exitCode === null && p.child.signalCode === null) { try { p.child.kill('SIGTERM'); } catch { /* Actual completion still required. */ } }
    await awaitOwnedProcess(p, { deadlineMs: 1000, graceMs: 1000, forceMs: 2000,
      onUnsettled: retained => evidence.record('tunnel-stop-pending', retained) });
  };
  const url = `http://127.0.0.1:${f.localPort}`;
  const anonymous = () => fetch(`${url}/api/info`, { signal: AbortSignal.timeout(1000) }).then(r => r.status, () => null);
  const openTunnel = async acquire => {
    const p = forward();
    // Register ownership BEFORE readiness/OS identity probes can throw. The
    // encompassing case cleanup always attempts remote cleanup independently.
    acquire(p);
    await until(async () => {
      if (p.spawnError) throw p.spawnError;
      assert.equal(p.child.exitCode, null, 'SSH forward exited before readiness');
      assert.equal(p.child.signalCode, null, 'SSH forward was signaled before readiness');
      if (!p.stderr.includes(`Local forwarding listening on 127.0.0.1 port ${f.localPort}`)) return null;
      return anonymous();
    }, status => status === 401, 'real owned SSH listener and authenticated remote HTTP forward');
    let startIdentity;
    if (process.platform === 'linux') {
      const stat = await fs.readFile(`/proc/${p.child.pid}/stat`, 'utf8'); startIdentity = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    } else if (process.platform === 'win32') {
      const identity = await evidence.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${p.child.pid}).StartTime.ToUniversalTime().ToString('o')`]);
      assert.equal(identity.code, 0); startIdentity = identity.stdout.trim(); assert(startIdentity);
    } else throw new Error('T50 fixture client start identity supported on Windows/Linux only');
    await evidence.record('tunnel-open', { pid: p.child.pid, startIdentity }); return p;
  };
  const clientFile = path.join(evidence.root, 'client-project', 'sentinel.txt'); await fs.mkdir(path.dirname(clientFile), { mode: 0o700 });
  const clientBefore = Buffer.from('client sentinel must never change\n'); await fs.writeFile(clientFile, clientBefore, { mode: 0o600 });
  const assertClient = async () => {
    const after = await fs.readFile(clientFile); assert.deepEqual(after, clientBefore);
    await evidence.record('client-bytes', { path: clientFile, beforeBase64: clientBefore.toString('base64'), afterBase64: after.toString('base64') });
  };
  async function login(name, originalAuth) {
    let auth = originalAuth;
    if (!auth) {
      const { code } = await control('bootstrap', name); evidence.secrets.add(code);
      const response = await fetch(`${url}/api/auth/exchange`, { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }), signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 200);
      const cookie = response.headers.get('set-cookie')?.split(';')[0]; assert(cookie); evidence.secrets.add(cookie);
      const body = await response.json(); evidence.secrets.add(body.session.csrfToken);
      auth = { cookie, csrf: body.session.csrfToken, principalId: body.session.sessionId };
    } else {
      // Durable browser session survives both loss and restart: do not rebootstrap.
      const response = await fetch(`${url}/api/auth/session`, { headers: { Cookie: auth.cookie, Origin: url }, signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 200);
      assertOriginalBrowserSession(auth, (await response.json()).session);
    }
    const { cookie, csrf } = auth;
    const socket = new WebSocket(`${url.replace('http:', 'ws:')}/api/events`, { headers: { Cookie: cookie, Origin: url }, perMessageDeflate: false, handshakeTimeout: 3000 });
    socket.on('error', () => { /* Awaited startup failure/closed socket is still a failed case. */ });
    try {
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      const ready = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WS ticket timeout')), 3000);
        socket.once('message', b => { clearTimeout(timeout); try { resolve(JSON.parse(b.toString())); } catch (error) { reject(error); } });
      });
      socket.send(JSON.stringify({ protocol: 1, type: 'hello', csrf })); const ticket = await ready; assert.equal(ticket.type, 'ready'); evidence.secrets.add(ticket.ticket);
      const send = async request => {
        const result = await fetch(`${url}/api/command`, { method: 'POST', headers: { Cookie: cookie, Origin: url,
          'Content-Type': 'application/json', 'X-Fate-Csrf': csrf, 'X-Fate-Client-Ticket': ticket.ticket }, body: JSON.stringify(request), signal: AbortSignal.timeout(20000) });
        const value = await result.json(); await evidence.record('http-command', { status: result.status, request, response: value }); return value;
      };
      const base = (method, input = {}) => ({ protocol: 1, method, input, requestId: randomUUID(), issuedAt: Date.now(), serverEpoch: ticket.serverEpoch });
      const list = await send(base('workspace.list')); assert.equal(list.ok, true); const scope = list.result.workspaces[0]; assert(scope);
      const scoped = (method, input = {}) => ({ ...base(method, input), workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration });
      return { socket, send, scoped, ticket, scope, auth };
    } catch (error) {
      try { socket.terminate(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Socket login failed and disposal remained uncertain'); }
      throw error;
    }
  }
  async function assertDistinctPrincipalDenied(name, original, requestId) {
    const other = await login(name); // Intentionally separate principal, NOT reconnect.
    try {
      assert.notEqual(other.auth.principalId, original.auth.principalId);
      const denied = await other.send(other.scoped('command.status', { requestId }));
      assert.equal(denied.ok, false); assert.equal(denied.error.code, 'FORBIDDEN');
      await evidence.record('distinct-principal-status-refused', { originalPrincipal: original.auth.principalId, otherPrincipal: other.auth.principalId, requestId, denied });
    } finally { other.socket.terminate(); }
  }
  function mutation(c, inspection) {
    const issuedAt = Date.now();
    // The production mutation ID format binds epoch, clock, and nonce.
    return { ...c.scoped('runtime.prompt', { text: 'Apply the explicit remote fixture sentinel edit.' }),
      requestId: `${c.ticket.serverEpoch}.${issuedAt}.${randomUUID()}`, issuedAt,
      expectedSessionId: inspection.sessionId, selectionRevision: inspection.selectionRevision, controlGeneration: 1 };
  }
  // Never parallelize crash and transport-loss scenarios or share their count.
  for (const name of ['tunnel', 'crash', 'stall']) {
    let host; let tunnel; let c; let hostStartAttempted = false;
    await withFixtureCleanup(async () => {
      const before = await control('prepare', name); assert.equal(before.diff, '');
      // Control startup can time out AFTER the independent host has spawned.
      // Mark the attempt before awaiting it, not only after readiness returns.
      hostStartAttempted = true;
      host = await control('start', name); assert.equal(host.invocationCount, 0);
      tunnel = await openTunnel(p => { tunnel = p; });
      c = await login(name);
      const claim = await c.send(c.scoped('control.claim')); assert.equal(claim.ok, true); assert.equal(claim.result.generation, 1);
      const request = mutation(c, host); await evidence.record('original-request', { name, request });
      let responseSettled = false;
      const pending = c.send(request).then(value => ({ value }), error => ({ error: String(error) })).finally(() => { responseSettled = true; });
      if (name === 'crash') {
        const barrier = await until(() => control('barrier', name), v => v?.admittedEffect === true, 'admitted effect before HTTP response');
        assert.equal(barrier.responseReleased, false); assert.equal(barrier.pid, host.pid);
        assert.equal(responseSettled, false, 'Original HTTP response must still be unresolved at the effect barrier');
        const effect = await control('inspect', name); assert.equal(effect.invocationCount, 1); assert(effect.diff.includes('+remote crash effect'));
        assertRemoteSentinelEffect(name, before, effect);
        assert(effect.journalRecords.some(record => record.requestId === request.requestId && record.state === 'admitted'), 'Kill barrier requires the ORIGINAL admitted journal record, not just file bytes');
        await evidence.record('crash-effect-before-kill', { before, effect, requestId: request.requestId, barrier });
        assert.equal(responseSettled, false, 'Original response must remain unresolved immediately before host kill');
        await control('kill', name); const lost = await pending; assert(lost.error, 'Host crash must not deliver an HTTP success');
        c.socket.terminate(); const oldHost = host;
        const quarantine = await control('recover-crash-locks', name);
        await evidence.record('explicit-crash-lock-quarantine', quarantine);
        host = await control('start', name);
        assert.notEqual(host.pid, oldHost.pid); assert.notEqual(host.startIdentity, oldHost.startIdentity);
        c = await login(name, c.auth);
        const status = await c.send(c.scoped('command.status', { requestId: request.requestId }));
        assert.equal(status.ok, true); assert.equal(status.result.state, 'outcome_unknown'); assert.equal(status.result.receipt, null);
        await assertDistinctPrincipalDenied(name, c, request.requestId);
        assert.equal(host.invocationCount, 1); assert.equal(host.running, false);
        assert(host.recovery.records.some(record => ['interrupted', 'unknown'].includes(record.status)
          && record.record.reference.sessionId === oldHost.sessionId && record.record.reference.workspaceId === oldHost.workspaceId), 'Restart must preserve a truthful cold lifecycle record for the original session/workspace');
        // Status only; never resubmit the old prompt (nor a fresh request ID).
        const final = await control('inspect', name); assert.equal(final.invocationCount, 1);
        assertRemoteSentinelEffect(name, before, final);
        assert.equal(final.sentinelBase64, effect.sentinelBase64); assert.equal(final.diff, effect.diff);
        await evidence.record('restart-no-replay', { original: oldHost, restarted: final, originalRequestId: request.requestId, status });
      } else {
        const accepted = await pending; assert(accepted.value?.ok, 'Original prompt must be admitted');
        const active = await until(() => control('inspect', name), v => v.running && v.invocationCount === 1 && v.diff.includes(`+remote ${name} effect`), 'active real sentinel effect');
        assertRemoteSentinelEffect(name, before, active);
        assert.notEqual(active.sentinelBase64, before.sentinelBase64);
        await evidence.record('remote-effect', { before, active, receipt: accepted.value, requestId: request.requestId });
        if (name === 'tunnel') {
          c.socket.terminate(); await stopTunnel(tunnel); tunnel = null;
          const disconnected = await control('inspect', name); assert.equal(disconnected.running, true);
          assert.equal(disconnected.pid, host.pid); assert.equal(disconnected.startIdentity, host.startIdentity); assert.equal(disconnected.invocationCount, 1);
          assertRemoteSentinelEffect(name, before, disconnected);
          await control('release', name);
          const finished = await until(() => control('inspect', name), v => !v.running && v.ledger.some(e => e.kind === 'settled'), 'original run settles with tunnel absent');
          assert.equal(finished.pid, host.pid); assert.equal(finished.startIdentity, host.startIdentity); assert.equal(finished.invocationCount, 1);
          assertRemoteSentinelEffect(name, before, finished);
          tunnel = await openTunnel(p => { tunnel = p; }); c = await login(name, c.auth);
          const status = await c.send(c.scoped('command.status', { requestId: request.requestId })); assert.equal(status.ok, true);
          assert.equal(status.result.state, 'settled'); assert.deepEqual(status.result.receipt, accepted.value.result);
          await assertDistinctPrincipalDenied(name, c, request.requestId);
          const snapshot = await c.send(c.scoped('workspace.snapshot')); assert.equal(snapshot.ok, true);
          const result = await control('inspect', name); assert.equal(result.pid, host.pid); assert.equal(result.startIdentity, host.startIdentity); assert.equal(result.invocationCount, 1);
          assertRemoteSentinelEffect(name, before, result);
          assert(JSON.stringify(snapshot.result).includes('original tunnel fixture result'), 'Authenticated reconnect snapshot must contain the actual SDK result');
          assert(JSON.stringify(result.snapshot).includes('original tunnel fixture result'), 'Host and network results must agree');
          await evidence.record('tunnel-reconnect-original-result', { disconnected, finished, result, status, snapshot });
          // Strict failures use real OpenSSH; no server key or authorized_keys is changed.
          const unknownHosts = path.join(evidence.root, 'unknown_known_hosts');
          await fs.writeFile(unknownHosts, '', { mode: 0o600, flag: 'wx' });
          await assertPrivateFixtureStorage(unknownHosts);
          const unknown = await evidence.run(sshExecutable(), forwardingArgs({ knownHostsFile: unknownHosts }, ['-N']));
          assert.notEqual(unknown.code, 0); assert(/No .* host key is known|Host key verification failed/iu.test(unknown.stderr));
          const key = path.join(evidence.root, 'wrong-key');
          assert.equal((await evidence.run(sshKeygenExecutable(), ['-q', '-t', 'ed25519', '-N', '', '-f', key])).code, 0);
          await assertPrivateFixtureStorage(key);
          await restrictGeneratedFixtureFile(`${key}.pub`);
          const wrong = await evidence.run(sshExecutable(), forwardingArgs({ identityFile: key }));
          assert.notEqual(wrong.code, 0); assert(/Permission denied/u.test(wrong.stderr));
          const pub = (await fs.readFile(`${key}.pub`, 'utf8')).trim().split(' ').slice(0, 2).join(' ');
          const changedHosts = path.join(evidence.root, 'changed_known_hosts');
          await fs.writeFile(changedHosts, `${f.sshPort === 22 ? f.host : `[${f.host}]:${f.sshPort}`} ${pub}\n`, { mode: 0o600 });
          await assertPrivateFixtureStorage(changedHosts);
          const changed = await evidence.run(sshExecutable(), forwardingArgs({ knownHostsFile: changedHosts }, ['-N']));
          assert.notEqual(changed.code, 0); assert(/HOST IDENTIFICATION HAS CHANGED|Host key verification failed/u.test(changed.stderr));
          const collision = await evidence.run(sshExecutable(), forwardingArgs());
          assert.notEqual(collision.code, 0); assert(/Address already in use|cannot listen|Could not request local forwarding/u.test(collision.stderr));
          const incompatible = await c.send({ ...c.scoped('runtime.prompt', { text: 'MUST NOT EXECUTE' }), protocol: 999 });
          assert.equal(incompatible.ok, false); assert.equal(incompatible.error.code, 'PROTOCOL_MISMATCH');
          const unauth = await fetch(`${url}/api/command`, { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(3000) });
          assert.equal(unauth.status, 401);
          assert.equal((await control('inspect', name)).invocationCount, 1);
          await evidence.record('strict-negative-cases', { unknownKeyExit: unknown.code, wrongKeyExit: wrong.code, changedKeyExit: changed.code, collisionExit: collision.code, incompatible, unauthorizedStatus: unauth.status });
        } else {
          const stopped = await control('stop', name); assert.equal(stopped.shutdown.status, 'incomplete');
          assert(stopped.inspection.profileLocks.length > 0); assert.equal(stopped.inspection.checkoutOwned, true);
          for (const lock of ['profile', 'checkout']) {
            const competing = await control(`contend-${lock}`, name); assert.notEqual(competing.code, 0);
            assert.equal(competing.signal, null, 'Timed out contender is not lock refusal evidence');
            assert(/Owner already in use/iu.test(competing.stderr), 'Require actual OwnerLock conflict, not incidental startup failure');
            assert(competing.stderr.includes(`${lock}-`), 'Wrong resource conflict cannot prove retained ownership');
          }
          await control('release', name);
          const settled = await until(() => control('inspect', name), v => !v.running && v.ledger.some(e => e.kind === 'settled'), 'stalled provider eventual settlement');
          assert.equal(settled.invocationCount, 1);
          assertRemoteSentinelEffect(name, before, settled);
          await evidence.record('stalled-stop-ownership', { stopped, settled });
        }
      }
      await assertClient();
    }, [
      { name: 'socket-stop', run: async () => { c?.socket.terminate(); } },
      { name: 'tunnel-stop', run: async () => { if (tunnel) await stopTunnel(tunnel); } },
      { name: 'host-logs-before-stop', run: async () => { if (hostStartAttempted) await control('logs', name); } },
      { name: 'owned-host-stop', run: async () => { if (hostStartAttempted) await control('kill', name); } },
      { name: 'host-logs-after-stop', run: async () => { if (hostStartAttempted) await control('logs', name); } },
    ], async (step, error) => evidence.record('cleanup-failed', { name, step, error: String(error), acceptance: false }));
    // Cleanup failure throws before this record and prevents runner exit 0.
    await evidence.record('case-complete', { name, cleanup: 'verified' });
  }
  await evidence.record('workflow-assertions-complete', { acceptance: 'not asserted; final storage validation still required' });
}
