import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { Evidence } from './fixture-lib.mjs';
import { appendInvocationLedger, readInvocationLedger } from './fixture-ledger.mjs';
import { withFixtureCleanup } from './fixture-cleanup.mjs';
import { assertPrivateFixtureStorage } from './fixture-private-storage.mjs';

// Actual local filesystem/process/helper checks only. No SDK/provider/SSH host
// or substituted remote transport is executed by these infrastructure tests.
test('actual empty invocation baseline then append/restart preserves cumulative count exactly one', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't50-ledger-'));
  try {
    const ledger = path.join(root, 'invocations.jsonl');
    await appendInvocationLedger(ledger, []);
    assert.equal((await fs.stat(ledger)).size, 0); assert.deepEqual(await readInvocationLedger(ledger), []);
    await appendInvocationLedger(ledger, [{ kind: 'prompt', pid: 111, startIdentity: 'synthetic-process-one' }]);
    const beforeRestart = await fs.readFile(ledger);
    await appendInvocationLedger(ledger, []); // Same initializer used by a restarted host.
    assert.deepEqual(await fs.readFile(ledger), beforeRestart);
    await appendInvocationLedger(ledger, [{ kind: 'createRuntime', pid: 222, startIdentity: 'synthetic-process-two' }]);
    const rows = await readInvocationLedger(ledger); assert.equal(rows.length, 2);
    assert.equal(rows.filter(row => row.kind === 'prompt').length, 1); assert.equal(rows[0].pid, 111);
    await appendInvocationLedger(ledger, []); assert.equal((await readInvocationLedger(ledger)).length, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('startup/readiness failure still executes every owned-resource cleanup step', async () => {
  const attempted = [];
  await assert.rejects(withFixtureCleanup(async () => { throw new Error('Readiness failed after owned startup'); },
    ['socket', 'tunnel', 'logs-before', 'remote-owner', 'logs-after'].map(name => ({ name, run: async () => { attempted.push(name); } }))), /Readiness failed/u);
  assert.deepEqual(attempted, ['socket', 'tunnel', 'logs-before', 'remote-owner', 'logs-after']);
});
test('tunnel/log cleanup failures cannot prevent remote cleanup or return false success', async () => {
  const attempted = []; const recorded = []; let completed = false;
  await assert.rejects(async () => {
    await withFixtureCleanup(async () => 'assertions passed', [
      { name: 'tunnel', run: async () => { attempted.push('tunnel'); throw new Error('stop pending'); } },
      { name: 'logs-before', run: async () => { attempted.push('logs-before'); throw new Error('log unavailable'); } },
      { name: 'remote-owner', run: async () => { attempted.push('remote-owner'); } },
      { name: 'logs-after', run: async () => { attempted.push('logs-after'); } },
    ], async name => { recorded.push(name); });
    completed = true;
  }, /Cleanup tunnel failed/u);
  assert.equal(completed, false); assert.deepEqual(attempted, ['tunnel', 'logs-before', 'remote-owner', 'logs-after']);
  assert.deepEqual(recorded, ['tunnel', 'logs-before']);
});
test('cleanup failure logging failure also fails while later cleanup is attempted', async () => {
  let finalAttempt = false;
  await assert.rejects(withFixtureCleanup(async () => {}, [
    { name: 'uncertain', run: async () => { throw new Error('unsettled'); } },
    { name: 'final', run: async () => { finalAttempt = true; } },
  ], async () => { throw new Error('evidence unavailable'); }), /evidence unavailable/u);
  assert.equal(finalAttempt, true);
});
test('spawn failure is immediately observed, durably logged, and still rejected when awaited later', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't50-spawn-'));
  try {
    const evidence = new Evidence(root);
    const owned = evidence.launch(path.join(root, 'does-not-exist.exe'), []);
    await new Promise(resolve => setTimeout(resolve, 100)); // Delayed readiness caller, not an unhandled rejection.
    await assert.rejects(owned.done, { code: 'ENOENT' });
    const record = JSON.parse((await fs.readFile(path.join(root, 'evidence.jsonl'), 'utf8')).trim());
    assert.equal(record.spawnError.code, 'ENOENT'); assert.notEqual(record.code, 0);
    assert.equal(await fs.readFile(path.join(root, '1.stdout.log'), 'utf8'), '');
    assert.equal(await fs.readFile(path.join(root, '1.stderr.log'), 'utf8'), '');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('successful cleanup returns the original helper result only after all steps settle', async () => {
  const attempts = [];
  const result = await withFixtureCleanup(async () => 42, [{ name: 'settled', run: async () => { attempts.push('settled'); } }]);
  assert.equal(result, 42); assert.deepEqual(attempts, ['settled']);
});
test('actual root/file ACL decisions match independent read-only NTFS inspection (mode bits cannot pass broad ACL)', async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't50-acl-'));
  try {
    const file = path.join(root, 'synthetic-only.txt'); await fs.writeFile(file, 'not a credential', { mode: 0o600 });
    for (const [target, options] of [[root, { directory: true, tree: true }], [file, {}]]) {
      if (process.platform !== 'win32') { await assertPrivateFixtureStorage(target, options); continue; }
      // Independent OS query: no ACL is provisioned/repaired, no private key
      // bytes are read, and an unsafe inherited TEMP ACL must be REJECTED.
      const probe = "$ErrorActionPreference='Stop';$a=Get-Acl -LiteralPath $env:T50_ACL_TARGET;$u=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;[PSCustomObject]@{current=$u;owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;allows=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object {$_.AccessControlType -eq 'Allow'}|ForEach-Object {$_.IdentityReference.Value})}|ConvertTo-Json -Compress";
      const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const { stdout } = await promisify(execFile)(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', probe], {
        timeout: 10000, maxBuffer: 4096, windowsHide: true, env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', T50_ACL_TARGET: target },
      });
      const acl = JSON.parse(stdout); assert.equal(typeof acl.current, 'string'); assert(Array.isArray(acl.allows));
      const allowed = new Set([acl.current, 'S-1-5-18', 'S-1-5-32-544']);
      const unsafe = !allowed.has(acl.owner) || acl.allows.some(sid => !allowed.has(sid));
      if (unsafe) {
        const expectedExit = !allowed.has(acl.owner) ? 3 : 4;
        await assert.rejects(assertPrivateFixtureStorage(target, options), error => { assert.equal(error.cause?.code, expectedExit); assert.equal(error.cause?.stdout, ''); assert.equal(error.cause?.stderr, ''); return true; });
        context.diagnostic(`Independent Get-Acl exit 0; validator correctly REFUSED unsafe inherited ${options.directory ? 'directory' : 'file'} ACL (actual exit ${expectedExit}, stdout/stderr empty). No private-storage acceptance claimed.`);
      } else {
        await assertPrivateFixtureStorage(target, options);
        context.diagnostic('Independent Get-Acl exit 0; validator exit 0 for independently observed restricted ACL.');
      }
    }
    await assert.rejects(assertPrivateFixtureStorage(root), /not a regular/u);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
