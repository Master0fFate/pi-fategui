import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { awaitOwnedProcess } from './fixture-process.mjs';

export const activationPhrase = 'T50 external disposable fixture explicitly approved';
export const sshExecutable = () => process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe') : '/usr/bin/ssh';
export const sshKeygenExecutable = () => path.join(path.dirname(sshExecutable()), process.platform === 'win32' ? 'ssh-keygen.exe' : 'ssh-keygen');
export function validateFixture(value) {
  const fields = ['host', 'user', 'identityFile', 'knownHostsFile', 'reviewedBindingFile', 'remoteBindingFile', 'remoteNode', 'remoteController', 'remoteConfig'];
  for (const field of fields) if (typeof value[field] !== 'string' || !value[field] || /[\r\n\0]/u.test(value[field])) throw new Error(`REMOTE_FIXTURE_UNAVAILABLE: invalid ${field}`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value.host) || !/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/u.test(value.user)) throw new Error('Invalid SSH destination');
  for (const field of ['remoteNode', 'remoteController', 'remoteConfig', 'remoteBindingFile']) if (!value[field].startsWith('/')) throw new Error('Remote paths must be absolute Linux paths');
  for (const field of ['identityFile', 'knownHostsFile', 'reviewedBindingFile']) if (!path.isAbsolute(value[field])) throw new Error('Local credential references must be absolute');
  for (const field of ['sshPort', 'localPort', 'hostPort']) if (!Number.isSafeInteger(value[field]) || value[field] < 1 || value[field] > 65535) throw new Error(`Invalid ${field}`);
  if (value.disposable !== true || value.preinstalled !== true) throw new Error('REMOTE_FIXTURE_UNAVAILABLE: only explicit preinstalled disposable fixtures supported');
  return value;
}
export const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export function sshArgs(f, overrides = {}) {
  return ['-F', process.platform === 'win32' ? 'NUL' : '/dev/null', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'ForwardAgent=no', '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no', '-o', 'PreferredAuthentications=publickey', '-o', 'GSSAPIAuthentication=no', '-o', 'HostbasedAuthentication=no', '-o', 'GlobalKnownHostsFile=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
    '-o', 'UserKnownHostsFile="' + (overrides.knownHostsFile ?? f.knownHostsFile).replaceAll('\\', '/').replaceAll('"', '\\"') + '"', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'PermitLocalCommand=no', '-o', 'ControlMaster=no', '-o', 'ControlPersist=no', '-o', 'ControlPath=none', '-o', 'UpdateHostKeys=no',
    '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=2', '-o', 'ServerAliveCountMax=2',
    '-i', overrides.identityFile ?? f.identityFile, '-p', String(f.sshPort), '-T', `${f.user}@${f.host}`];
}
export class Evidence {
  constructor(root) { this.root = root; this.secrets = new Set(); this.sequence = 0; }
  redact(text) {
    text = String(text).replace(/(?:fo1|fc1|fb1|fs1|ft1|fx1)_[A-Za-z0-9_-]{43}/gu, '[REDACTED]');
    for (const secret of this.secrets) if (secret) text = text.replaceAll(secret, '[REDACTED]');
    return text;
  }
  async record(kind, value) {
    await fs.appendFile(path.join(this.root, 'evidence.jsonl'), this.redact(JSON.stringify({ at: new Date().toISOString(), kind, ...value })) + '\n', { mode: 0o600 });
  }
  launch(file, args, options = {}) {
    const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH']);
    const env = { LANG: 'C', LC_ALL: 'C' };
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && allowed.has(key.toUpperCase())) env[key] = value;
    const child = spawn(file, args, { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '', stderr = ''; const id = ++this.sequence; let captureError;
    const capture = (kind, data) => {
      const current = kind === 'stdout' ? stdout : stderr;
      if (current.length + data.length > 4 * 1024 * 1024) { captureError ??= new Error('PROCESS_CAPTURE_LIMIT: full logs retained; protocol capture exceeds 4 MiB'); return; }
      if (kind === 'stdout') stdout += data; else stderr += data;
    };
    // Incremental redaction with boundary carry, backpressure and live files.
    // Never buffer unlimited logs in memory or leak a token split across chunks.
    const streamLog = (stream, kind) => {
      let carry = ''; let tail = fs.writeFile(path.join(this.root, `${id}.${kind}.log`), '', { mode: 0o600 });
      void tail.catch(() => {}); stream.setEncoding('utf8');
      const flush = final => {
        const keep = Math.max(128, ...[...this.secrets].map(secret => secret.length));
        let cut = final ? carry.length : Math.max(0, carry.length - keep);
        if (!final) {
          let changed;
          do {
            changed = false;
            const spans = [...carry.matchAll(/(?:fo1|fc1|fb1|fs1|ft1|fx1)_[A-Za-z0-9_-]{43}/gu)].map(match => [match.index, match.index + match[0].length]);
            for (const secret of this.secrets) { let at = carry.indexOf(secret); while (secret && at >= 0) { spans.push([at, at + secret.length]); at = carry.indexOf(secret, at + 1); } }
            for (const [start, end] of spans) if (start < cut && end > cut) { cut = start; changed = true; }
          } while (changed);
        }
        const bytes = this.redact(carry.slice(0, cut)); carry = carry.slice(cut);
        tail = tail.then(() => fs.appendFile(path.join(this.root, `${id}.${kind}.log`), bytes)); void tail.catch(() => {});
        return tail;
      };
      stream.on('data', data => {
        stream.pause(); capture(kind, data); carry += data;
        void flush(false).then(() => stream.resume(), () => stream.resume());
      });
      return () => flush(true);
    };
    const finishOut = streamLog(child.stdout, 'stdout'); const finishErr = streamLog(child.stderr, 'stderr');
    let spawnError;
    const done = new Promise((resolve, reject) => {
      // Observe immediately, but settle after close/log persistence. An owned
      // launch may be awaiting readiness before it can await this promise.
      child.once('error', error => { spawnError = error; });
      child.once('close', async (code, signal) => {
        try {
          await Promise.all([finishOut(), finishErr()]);
          await this.record('process-exit', { id, file, args: args.map(a => this.redact(a)), pid: child.pid, code, signal,
            spawnError: spawnError ? { code: spawnError.code, message: this.redact(spawnError.message) } : null });
          if (spawnError || captureError) reject(spawnError ?? captureError);
          else resolve({ code, signal, stdout, stderr });
        } catch (e) { reject(e); }
      });
    });
    // Keep the ORIGINAL rejection for the caller; the observer only prevents
    // an unhandled rejection while startup/cleanup is still acquiring ownership.
    void done.catch(() => {});
    return { child, done, get stderr() { return stderr; }, get spawnError() { return spawnError; } };
  }
  async run(file, args, options) {
    const { deadlineMs, graceMs, forceMs, ...spawnOptions } = options ?? {};
    const p = this.launch(file, args, spawnOptions);
    const result = await awaitOwnedProcess(p, { ...(deadlineMs === undefined ? {} : { deadlineMs }), ...(graceMs === undefined ? {} : { graceMs }), ...(forceMs === undefined ? {} : { forceMs }),
      onUnsettled: retained => this.record('process-unsettled', retained) });
    if (result.timedOut) {
      await this.record('process-deadline-exceeded', { file, pid: p.child.pid, code: result.code, signal: result.signal, terminationAttempt: result.terminationAttempt });
      throw Object.assign(new Error('PROCESS_DEADLINE_EXCEEDED: bounded owned child terminated; see actual exit logs'), { code: 'PROCESS_DEADLINE_EXCEEDED', result });
    }
    return { pid: p.child.pid, ...result };
  }
}
export async function until(read, predicate, label, ms = 15000) {
  const deadline = Date.now() + ms;
  do { const value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 100)); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}
