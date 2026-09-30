import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createIsolatedEnvironment } from './run-v2-tests.mjs';

/** A real OpenSSH preflight. Failure is a failed gate, never a mocked acceptance. */
export async function preflightOpenSsh(env, root) {
  const fixture = path.join(root, 'openssh');
  await fs.mkdir(fixture, { mode: 0o700 });
  const run = (file, args) => new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: fixture, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (bytes) => { output = (output + bytes).slice(-8192); });
    child.stderr.on('data', (bytes) => { output = (output + bytes).slice(-8192); });
    child.once('error', reject); child.once('close', (code) => resolve({ code, output }));
  });
  const version = await run('ssh', ['-V']);
  if (version.code !== 0) throw new Error('REMOTE_FIXTURE_UNAVAILABLE: system OpenSSH client missing.');
  const key = await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', 'host-key']);
  if (key.code !== 0) throw new Error('REMOTE_FIXTURE_UNAVAILABLE: test-only host key creation failed.');
  await fs.writeFile(path.join(fixture, 'sshd_config'), [
    'ListenAddress 127.0.0.1', 'Port 49281', 'HostKey ./host-key', 'PidFile ./daemon.pid',
    'AuthorizedKeysFile ./authorized_keys', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'PermitRootLogin prohibit-password', 'UsePAM no', 'AllowTcpForwarding local', 'GatewayPorts no',
    'PermitTTY no', 'X11Forwarding no', 'AllowAgentForwarding no',
  ].join('\n') + '\n', { mode: 0o600 });
  // Validate actual daemon prerequisites before any host workspace or provider exists.
  const daemon = await run('/usr/sbin/sshd', ['-t', '-f', './sshd_config']);
  const evidence = { node: process.version, platform: process.platform, arch: process.arch,
    sshVersion: version.output.trim(), command: '/usr/sbin/sshd -t -f ./sshd_config',
    exitCode: daemon.code, diagnostic: daemon.output.trim(), requiredWorkflowExecuted: false };
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  if (daemon.code !== 0) throw new Error('REMOTE_FIXTURE_UNAVAILABLE: real OpenSSH daemon preflight failed.');
  return evidence;
}

const isolated = await createIsolatedEnvironment();
try {
  await preflightOpenSsh(isolated.env, isolated.root);
  // Do not activate T50 workflow behind unresolved package/native/service acceptance.
  throw new Error('REMOTE_ACCEPTANCE_PENDING: T48 Windows and T49 non-root user-service gates require review before T50 activation.');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'REMOTE_FIXTURE_UNAVAILABLE'}\n`);
  process.exitCode = 1;
} finally { await isolated.cleanup(); }
