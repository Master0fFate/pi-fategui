import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { connectionPortSchema, sshConnectionProfileSchema, type SshConnectionProfile } from '../../shared/protocol/connectionProfiles';

export type SshTunnelFailure = 'ssh-unavailable' | 'host-verification-required' | 'authentication-failed'
  | 'port-collision' | 'connection-failed' | 'connection-canceled' | 'stop-pending';
const messages: Record<SshTunnelFailure, string> = {
  'ssh-unavailable': 'System OpenSSH is unavailable.',
  'host-verification-required': 'Verify this SSH host with your SSH tools before connecting.',
  'authentication-failed': 'The configured SSH key or agent could not authenticate.',
  'port-collision': 'The local tunnel port is in use. Select another port.',
  'connection-failed': 'The SSH tunnel could not connect.',
  'connection-canceled': 'The SSH connection was canceled.',
  'stop-pending': 'Tunnel stop is pending. Its process ownership remains held.',
};
export class SshTunnelError extends Error {
  constructor(readonly code: SshTunnelFailure) { super(messages[code]); this.name = 'SshTunnelError'; }
}
export interface SshTunnelOptions {
  /** Trusted main/test options only. No IPC method accepts these paths. */
  readonly executable?: string;
  readonly configFile?: string;
  readonly readyTimeoutMs?: number;
}
export interface TunnelEndpoint { readonly baseUrl: string; readonly forwardedHost: string; }
/** Preserve SSH account/config/agent access. Provider and askpass variables do not enter the child. */
export function buildSshEnvironment(inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'WINDIR',
    'COMSPEC', 'PATHEXT', 'HOMEDRIVE', 'HOMEPATH', 'SSH_AUTH_SOCK']);
  const environment: NodeJS.ProcessEnv = { LANG: 'C', LC_ALL: 'C' };
  for (const [key, value] of Object.entries(inherited)) {
    if (value === undefined || !allowed.has(key.toUpperCase())) continue;
    environment[key] = key.toUpperCase() === 'PATH' ? value.split(path.delimiter).filter((entry) => path.isAbsolute(entry)).join(path.delimiter) : value;
  }
  return environment;
}
const privatePath = (value: string): string => {
  if (!path.isAbsolute(value) || path.normalize(value) !== value || /[\u0000\r\n]/u.test(value)) throw new SshTunnelError('ssh-unavailable');
  return value;
};
export function buildSshArguments(input: unknown, localPort: number, configFile?: string): string[] {
  const profile = sshConnectionProfileSchema.parse(input), chosen = connectionPortSchema.parse(localPort);
  return [...(configFile === undefined ? [] : ['-F', privatePath(configFile)]), '-v', '-N', '-T', '-a', '-x',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1', '-o', 'ForwardAgent=no',
    '-o', 'PermitLocalCommand=no', '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no',
    '-o', 'ControlMaster=no', '-o', 'ControlPersist=no', '-o', 'ControlPath=none',
    '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'UpdateHostKeys=no',
    '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
    '-L', `127.0.0.1:${chosen}:127.0.0.1:${profile.remotePort}`, '--', profile.sshAlias];
}
export function classifySshFailure(privateStderr: string): SshTunnelError {
  if (/host key verification failed|remote host identification has changed|no .* host key is known/iu.test(privateStderr)) return new SshTunnelError('host-verification-required');
  if (/permission denied|authentication failed|no supported authentication methods/iu.test(privateStderr)) return new SshTunnelError('authentication-failed');
  if (/address already in use|cannot listen to port|could not request local forwarding/iu.test(privateStderr)) return new SshTunnelError('port-collision');
  return new SshTunnelError('connection-failed');
}
/** A preflight closes its socket before ssh binds. The later bind marker/failure is mandatory. */
export async function reserveTunnelPort(requested?: number): Promise<number> {
  if (requested !== undefined) connectionPortSchema.parse(requested);
  const server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => reject(new SshTunnelError(error.code === 'EADDRINUSE' ? 'port-collision' : 'connection-failed')));
    server.listen(requested ?? 0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new SshTunnelError('connection-failed'); }
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(new SshTunnelError('connection-failed')) : resolve()));
  return address.port;
}
function closedChild(child: ChildProcess): boolean { return child.exitCode !== null || child.signalCode !== null; }
function waitForChildClose(child: ChildProcess, milliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (closedChild(child)) { resolve(true); return; }
    const finish = () => { clearTimeout(timer); child.off('close', finish); resolve(closedChild(child)); };
    const timer = setTimeout(finish, milliseconds); child.once('close', finish);
  });
}
/** Only this captured child is signaled. A timeout never proves that the child stopped. */
export async function stopOwnedSshChild(child: ChildProcess, graceMs = 1000, forceMs = 1000): Promise<void> {
  if (closedChild(child)) return;
  try { child.kill('SIGTERM'); } catch { /* A failed signal is not a stopped process. */ }
  if (await waitForChildClose(child, graceMs)) return;
  try { child.kill('SIGKILL'); } catch { /* Retain ownership if exit remains unproved. */ }
  if (!await waitForChildClose(child, forceMs)) throw new SshTunnelError('stop-pending');
}
function checkAbort(signal: AbortSignal): void { if (signal.aborted) throw new SshTunnelError('connection-canceled'); }
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    checkAbort(signal);
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(new SshTunnelError('connection-canceled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, milliseconds);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
function probeLoopback(port: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    checkAbort(signal);
    const socket = new net.Socket();
    const done = (ready: boolean) => { signal.removeEventListener('abort', cancel); socket.destroy(); resolve(ready); };
    const cancel = () => { socket.destroy(); signal.removeEventListener('abort', cancel); reject(new SshTunnelError('connection-canceled')); };
    signal.addEventListener('abort', cancel, { once: true }); socket.setTimeout(100);
    socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.once('timeout', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

/** Owns a local tunnel only. It cannot install, execute a remote command, or stop the host. */
export class SshTunnel {
  private readonly profile: SshConnectionProfile;
  private readonly executable: string;
  private readonly configFile: string | undefined;
  private readonly timeout: number;
  private child: ChildProcess | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly aborter = new AbortController();
  private opening = false;
  private active = false;
  constructor(profile: unknown, options: SshTunnelOptions = {}, private readonly onLost: () => void = () => undefined) {
    this.profile = sshConnectionProfileSchema.parse(profile);
    const systemSsh = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe') : '/usr/bin/ssh';
    this.executable = privatePath(options.executable ?? systemSsh);
    this.configFile = options.configFile === undefined ? undefined : privatePath(options.configFile);
    this.timeout = options.readyTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 100 || this.timeout > 30_000) throw new SshTunnelError('connection-failed');
  }
  get ownedPid(): number | null { return this.child?.pid ?? null; }
  async open(cancellation: AbortSignal): Promise<TunnelEndpoint> {
    if (this.opening || this.child || this.aborter.signal.aborted) throw new SshTunnelError('connection-canceled');
    this.opening = true;
    const signal = AbortSignal.any([cancellation, this.aborter.signal]);
    const end = Date.now() + this.timeout;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        checkAbort(signal);
        const localPort = await reserveTunnelPort(this.profile.localPort); checkAbort(signal);
        try { await this.start(localPort, signal, end); return { baseUrl: `http://127.0.0.1:${localPort}`, forwardedHost: `127.0.0.1:${this.profile.remotePort}` }; }
        catch (error) {
          await this.stopChild();
          if (signal.aborted) throw new SshTunnelError('connection-canceled');
          if (error instanceof SshTunnelError && error.code === 'port-collision' && this.profile.localPort === undefined && attempt < 2 && Date.now() < end) continue;
          throw error;
        }
      }
      throw new SshTunnelError('port-collision');
    } finally { this.opening = false; }
  }
  private async start(localPort: number, signal: AbortSignal, end: number): Promise<void> {
    const child = spawn(this.executable, buildSshArguments(this.profile, localPort, this.configFile), {
      shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: buildSshEnvironment(),
    });
    this.child = child;
    let stderr = '', failure: SshTunnelError | null = null, bindingSeen = false;
    const bindMarker = `Local forwarding listening on 127.0.0.1 port ${localPort}.`;
    child.stderr?.on('data', (chunk: Buffer) => {
      // Keep a small private diagnostic window. Never publish stderr or key paths.
      stderr = (stderr + chunk.toString('utf8')).slice(-8192);
      if (stderr.includes(bindMarker)) bindingSeen = true;
      if (/host key verification failed|remote host identification has changed|permission denied|address already in use|cannot listen to port|could not request local forwarding/iu.test(stderr)) failure = classifySshFailure(stderr);
    });
    child.once('close', () => {
      if (this.child === child) this.child = null;
      if (this.active && !this.aborter.signal.aborted) { this.active = false; this.onLost(); }
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => { failure = new SshTunnelError('ssh-unavailable'); reject(failure); });
    });
    while (Date.now() < end) {
      checkAbort(signal);
      if (failure) throw failure;
      if (this.child !== child || closedChild(child)) throw classifySshFailure(stderr);
      // A race can bind a different local listener. TCP alone is not proof.
      if (bindingSeen && await probeLoopback(localPort, signal)) {
        checkAbort(signal);
        if (failure) throw failure;
        if (this.child !== child || closedChild(child)) throw classifySshFailure(stderr);
        this.active = true; return;
      }
      await delay(20, signal);
    }
    throw classifySshFailure(stderr);
  }
  private async stopChild(): Promise<void> {
    const child = this.child; this.active = false;
    if (!child) return;
    await stopOwnedSshChild(child);
    if (this.child === child && closedChild(child)) this.child = null;
  }
  close(): Promise<void> {
    this.aborter.abort();
    return this.closePromise ??= this.stopChild().finally(() => { this.closePromise = null; });
  }
}
