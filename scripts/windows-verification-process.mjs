import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const maxReceiptBytes = 8192;

export function validateWindowsLaunch({ args, cwd = process.cwd(), env = process.env, stdio = 'inherit',
  startupTimeoutMs = 30_000, settlementTimeoutMs = 5_000, descendantGraceMs = 500, timeoutMs = 0 }) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw new TypeError('Verification args must be NUL-free strings.');
  if (typeof cwd !== 'string' || cwd.includes('\0') || !path.isAbsolute(cwd)) throw new TypeError('Verification cwd must be absolute.');
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new TypeError('Verification env must be an object.');
  const names = new Set(), cleanEnv = Object.create(null);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!key || /[=\0]/u.test(key) || typeof value !== 'string' || value.includes('\0') || names.has(key.toUpperCase())) throw new TypeError('Verification env contains an invalid or case-duplicate entry.');
    names.add(key.toUpperCase()); cleanEnv[key] = value;
  }
  const modes = typeof stdio === 'string' ? [stdio, stdio, stdio] : stdio;
  if (!Array.isArray(modes) || modes.length !== 3 || modes.some((mode) => !['inherit', 'ignore', 'pipe'].includes(mode))) {
    throw new TypeError('Windows verification supports exactly three standard streams (inherit, ignore, or pipe); Node IPC and extra handles are not supported.');
  }
  for (const [name, value, minimum, maximum] of [
    ['startupTimeoutMs', startupTimeoutMs, 1, 120_000], ['settlementTimeoutMs', settlementTimeoutMs, 1, 30_000],
    ['descendantGraceMs', descendantGraceMs, 0, 30_000], ['timeoutMs', timeoutMs, 0, 2_147_483_647],
  ]) if (!Number.isInteger(value) || value < minimum || value > maximum) throw new RangeError(`Invalid ${name}.`);
  return { args, cwd, env: cleanEnv, stdio: modes, startupTimeoutMs, settlementTimeoutMs, descendantGraceMs, timeoutMs };
}

export function parseWindowsReceipt(line) {
  if (Buffer.byteLength(line) > maxReceiptBytes) throw new Error('Oversized Windows supervision receipt.');
  let match = /^started ([1-9][0-9]*)$/u.exec(line);
  if (match) {
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid > 0xffff_ffff) throw new Error('Invalid Windows child identity.');
    return { kind: 'started', pid };
  }
  match = /^(not-started) (-|[A-Za-z0-9+/]+={0,2})$/u.exec(line);
  if (match) return { kind: 'finished', started: false, ownership: 'settled', code: null, failure: decodeFailure(match[2]) ?? 'Windows verification child was not started.' };
  match = /^finished ([1-9][0-9]*) (-|[0-9]+) (settled|unconfirmed) (resumed|suspended) (-|[A-Za-z0-9+/]+={0,2})$/u.exec(line);
  if (!match) throw new Error('Invalid Windows supervision receipt.');
  const pid = Number(match[1]), code = match[2] === '-' ? null : Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid > 0xffff_ffff || code !== null && (!Number.isSafeInteger(code) || code > 0xffff_ffff)) throw new Error('Invalid Windows supervision result.');
  if (match[3] === 'settled' && code === null) throw new Error('Settled Windows job is missing the root exit code.');
  return { kind: 'finished', pid, code, ownership: match[3], started: true, resumed: match[4] === 'resumed', failure: decodeFailure(match[5]) };
}

function decodeFailure(value) {
  if (value === '-') return undefined;
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error('Invalid Windows supervision error encoding.');
  return decoded.toString('utf8');
}

/** The callback receives child identity and the three standard streams, not a
 * ChildProcess: only the supervisor possesses process/job handles. AbortSignal
 * is the sole cancellation interface. Payload output is never a control receipt. */
export async function runWindowsVerificationProcess(options, signal) {
  if (signal?.aborted) return { code: null, signal: null, cancelled: signal.reason, ownership: 'settled', started: false };
  const settings = validateWindowsLaunch(options);
  const pipeName = `fate-verification-${randomBytes(24).toString('hex')}`;
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
  const nonce = randomBytes(32).toString('hex');
  const request = JSON.stringify({ version: 1, executable: process.execPath, args: settings.args, cwd: settings.cwd,
    env: settings.env, descendantGraceMs: settings.descendantGraceMs, settlementTimeoutMs: settings.settlementTimeoutMs });
  if (Buffer.byteLength(request) > 1_048_576) throw new RangeError('Oversized Windows verification launch request.');
  const systemRoot = Object.entries(settings.env).find(([name]) => name.toUpperCase() === 'SYSTEMROOT')?.[1];
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error('Windows verification needs an absolute SYSTEMROOT for the OS PowerShell executable.');
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let supervisor, control, receipt, pid, closed = false, callbackFailed = false, protocolFailure;
  let closedResult, controlEnded = false, finalized = false, supervisorError = '';
  let requestedCancellation = null, timedOut = false, authenticated = false;
  let startupTimer, deadlineTimer, stopTimer, closeTimer, receiptTimer, exitTimer;
  const sockets = new Set();
  let complete;
  const completed = new Promise((resolve) => { complete = resolve; });
  const tryComplete = () => {
    if (closedResult && (protocolFailure || receipt && controlEnded)) complete(closedResult);
  };
  const killSupervisor = () => {
    // ChildProcess retains the handle of this newly spawned supervisor. Never
    // reopen a PID, enumerate processes, call taskkill, or retry by numeric ID.
    if (supervisor && !closed && supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL');
    closeTimer ??= setTimeout(() => complete({ supervisorUnconfirmed: true }), 2_000);
  };
  const stop = (reason) => {
    if (finalized) return;
    requestedCancellation ??= reason ?? 'SIGTERM';
    if (authenticated && control && !control.destroyed) control.write('cancel\n');
    stopTimer ??= setTimeout(killSupervisor, settings.settlementTimeoutMs + 2_000);
  };
  const onAbort = () => stop(signal.reason);
  const failProtocol = (message) => {
    if (finalized) return;
    protocolFailure ??= message; stop('supervision-failure'); tryComplete();
  };
  const server = createServer((socket) => {
    if (authenticated || sockets.size >= 8) { socket.destroy(); return; }
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => { if (socket === control) failProtocol('Windows supervision channel failed.'); });
    let buffer = '', accepted = false;
    socket.setTimeout(5_000, () => { if (!accepted) socket.destroy(); });
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > maxReceiptBytes) { socket.destroy(); if (accepted) failProtocol('Oversized Windows supervision receipt.'); return; }
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/u, ''); buffer = buffer.slice(end + 1);
        if (!accepted) {
          if (authenticated || line !== nonce) { socket.destroy(); return; }
          accepted = true; authenticated = true; control = socket;
          socket.setTimeout(0);
          for (const other of sockets) if (other !== socket) other.destroy();
          server.close();
          socket.write(request + '\n');
          if (requestedCancellation !== null || signal?.aborted) socket.write('cancel\n');
          continue;
        }
        try {
          const next = parseWindowsReceipt(line);
          if (receipt || next.kind === 'started' && pid !== undefined || next.kind === 'finished' && next.pid !== undefined && pid !== undefined && next.pid !== pid || next.started === false && pid !== undefined || next.resumed && pid === undefined) throw new Error('Out-of-order Windows supervision receipt.');
          if (next.kind === 'started') {
            clearTimeout(startupTimer);
            pid = next.pid;
            try { options.onStarted?.(Object.freeze({ pid, stdin: supervisor.stdin, stdout: supervisor.stdout, stderr: supervisor.stderr })); }
            catch { callbackFailed = true; stop('start-reporting-failure'); }
            // The native child is still suspended. Its output cannot race ahead
            // of these listeners or Node's post-exit automatic stream drain.
            if (requestedCancellation === null && !signal?.aborted) socket.write('resume\n');
            else socket.write('cancel\n');
          } else {
            clearTimeout(startupTimer); receipt = next; pid ??= next.pid;
            receiptTimer = setTimeout(() => { failProtocol('Windows supervisor did not close after its receipt.'); killSupervisor(); }, settings.settlementTimeoutMs + 2_000);
          }
        } catch (error) { failProtocol(error.message); }
      }
    });
    socket.on('end', () => {
      if (finalized) return;
      if (accepted && (!receipt || buffer.length)) failProtocol('Windows supervision channel ended without a complete settlement receipt.');
      else if (accepted) { controlEnded = true; tryComplete(); }
    });
    socket.on('close', () => { if (accepted && !controlEnded) failProtocol('Windows supervision channel closed without clean settlement EOF.'); });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipePath, resolve); });
    if (signal?.aborted) return { code: null, signal: null, cancelled: signal.reason, ownership: 'settled', started: false };
    signal?.addEventListener('abort', onAbort, { once: true });
    supervisor = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(directory, 'windows-verification-job.ps1'), '-PipeName', pipeName, '-Nonce', nonce],
      { cwd: settings.cwd, env: settings.env, stdio: settings.stdio, shell: false, windowsHide: true });
    supervisor.once('error', (error) => { protocolFailure ??= error.message; complete({ supervisorUnconfirmed: true }); });
    // 'exit' can precede 'close' indefinitely if a descendant retains a standard
    // stream. Bound that wait even on ordinary completion, with no cancellation.
    supervisor.once('exit', () => {
      exitTimer = setTimeout(() => { protocolFailure ??= 'Windows supervisor exited but inherited streams did not close.'; complete({ supervisorUnconfirmed: true }); }, settings.settlementTimeoutMs);
    });
    supervisor.once('close', (code, exitSignal) => {
      closed = true; closedResult = { supervisorCode: code, supervisorSignal: exitSignal };
      if (code !== 0 || exitSignal !== null) protocolFailure ??= 'Windows supervisor exited unsuccessfully.';
      tryComplete();
    });
    startupTimer = setTimeout(() => { timedOut = true; failProtocol('Windows supervisor startup timed out.'); killSupervisor(); }, settings.startupTimeoutMs);
    if (settings.timeoutMs) deadlineTimer = setTimeout(() => { timedOut = true; stop('timeout'); }, settings.timeoutMs);
    if (signal?.aborted) onAbort();
    const end = await completed;
    const confirmed = receipt && !protocolFailure && !end.supervisorUnconfirmed && end.supervisorCode === 0 && end.supervisorSignal === null;
    // Do not put stderr into flowing mode before onStarted: the root may write
    // before the independent control receipt arrives. Preserve those bytes for
    // the caller. Only consume still-unread startup diagnostics on failure.
    if (!confirmed && pid === undefined) supervisorError = supervisor.stderr?.read()?.toString().slice(0, 8192) ?? '';
    return { code: receipt?.code ?? null, signal: null, ...(pid === undefined ? {} : { pid }),
      started: receipt?.started ?? pid !== undefined, cancelled: requestedCancellation, ownership: confirmed ? receipt.ownership : 'unconfirmed',
      ...(timedOut ? { timedOut: true } : {}), ...(!receipt ? { launchUnconfirmed: true } : {}),
      ...(callbackFailed ? { failure: 'Owned process start reporting failed.' } : receipt?.failure ? { failure: receipt.failure } : {}),
      ...(!confirmed ? { terminationError: protocolFailure ?? 'Windows supervisor exit and job settlement were not both confirmed.', ...(supervisorError ? { supervisorError } : {}) } : {}) };
  } finally {
    finalized = true;
    clearTimeout(startupTimer); clearTimeout(deadlineTimer); clearTimeout(stopTimer); clearTimeout(closeTimer); clearTimeout(receiptTimer); clearTimeout(exitTimer);
    signal?.removeEventListener('abort', onAbort);
    for (const socket of sockets) socket.destroy();
    server.close();
    if (supervisor && !closed) {
      // EOF requests job termination even if the JS owner cannot wait further.
      // A missing close/receipt remains unconfirmed and its fixture is retained.
      supervisor.unref(); supervisor.stdout?.destroy(); supervisor.stderr?.destroy(); supervisor.stdin?.destroy();
    }
  }
}
