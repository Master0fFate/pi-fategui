import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Evidence, quote, sshArgs, validateFixture, until } from './fixture-lib.mjs';
import { main } from '../../scripts/test-remote.mjs';
const fixture = () => ({ host: 'fixture.invalid', user: 'disposable', sshPort: 2222, localPort: 48281, hostPort: 48282,
  identityFile: path.resolve('private-key'), knownHostsFile: path.resolve('known_hosts'), reviewedBindingFile: path.resolve('reviewed.json'), remoteBindingFile: '/tmp/t50/reviewed.json', remoteNode: '/opt/node/bin/node',
  remoteController: '/tmp/t50/controller.mjs', remoteConfig: '/tmp/t50/config.json', disposable: true, preinstalled: true });
test('validates external-only fixture and rejects command injection, relative credentials, missing approval flags', () => {
  assert.equal(validateFixture(fixture()).host, 'fixture.invalid');
  for (const bad of [{ host: 'a; touch /tmp/evil' }, { user: 'user\nroot' }, { remoteNode: 'node' }, { identityFile: 'relative' },
    { user: '-oProxyCommand' }, { sshPort: 0 }, { localPort: 65536 }, { disposable: false }, { preinstalled: false }]) assert.throws(() => validateFixture({ ...fixture(), ...bad }));
  assert.equal(quote("a'b c"), "'a'\\''b c'");
});
test('real SSH arguments never disable key/auth/forwarding checks or discover operator agent/config', () => {
  const args = sshArgs(fixture());
  for (const required of ['StrictHostKeyChecking=yes', 'BatchMode=yes', 'IdentitiesOnly=yes', 'IdentityAgent=none',
    'ForwardAgent=no', 'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no', 'ExitOnForwardFailure=yes']) assert(args.includes(required));
  assert(!args.some(arg => arg.includes('accept-new') || arg.includes('StrictHostKeyChecking=no')));
  assert(sshArgs({ ...fixture(), knownHostsFile: path.resolve('fixture with spaces', 'known_hosts') }).some(arg => arg.startsWith('UserKnownHostsFile="') && arg.endsWith('"')));
});
test('no implicit fixture or activation (no SSH spawn)', async () => {
  assert.equal(await main([]), 1);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't50-pure-'));
  try {
    const config = path.join(root, 'fixture.json'); await fs.writeFile(config, JSON.stringify(fixture()));
    assert.equal(await main(['--fixture', config, '--evidence', path.join(root, 'must-not-exist')]), 1);
    await assert.rejects(fs.stat(path.join(root, 'must-not-exist')), { code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('complete redacted logs and actual process exit code are retained', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't50-log-'));
  try {
    const evidence = new Evidence(root); evidence.secrets.add('csrf-private-value');
    const output = await evidence.run(process.execPath, ['-e', "process.stdout.write('x'.repeat(12000)+'csrf-private-value'); process.stderr.write('fb1_'+'a'.repeat(43)); process.exitCode=23"]);
    assert.equal(output.code, 23);
    const stdout = await fs.readFile(path.join(root, '1.stdout.log'), 'utf8'); assert(stdout.startsWith('x'.repeat(12000))); assert(stdout.endsWith('[REDACTED]'));
    assert.equal(await fs.readFile(path.join(root, '1.stderr.log'), 'utf8'), '[REDACTED]');
    const exit = JSON.parse((await fs.readFile(path.join(root, 'evidence.jsonl'), 'utf8')).trim()); assert.equal(exit.code, 23); assert(exit.pid > 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('deadline failures are failures, not absent-host passing cases', async () => {
  await assert.rejects(until(async () => null, v => v !== null, 'unavailable fixture', 1), /Timed out: unavailable fixture/u);
});
