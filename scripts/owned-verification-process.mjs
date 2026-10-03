import { spawn } from 'node:child_process';
import { runWindowsVerificationProcess } from './windows-verification-process.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const groupExists = (pid) => {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};

/** Own one gate's process group. This is cooperative test cleanup, not a sandbox;
 * a program deliberately escaping its group/job requires separate containment. */
export async function runOwnedVerificationProcess(options, signal) {
  if (process.platform === 'win32') return runWindowsVerificationProcess(options, signal);
  const { args, cwd, env, onStarted, stdio = 'inherit' } = options;
  if (signal?.aborted) return { code: null, signal: null, cancelled: signal.reason, ownership: 'settled', started: false };
  const child = spawn(process.execPath, args, { cwd, env, shell: false, stdio, windowsHide: true, detached: process.platform !== 'win32' });
  let settled = false, termination, requestedCancellation = null;
  let terminationError, cancellationTimer, callbackFailed = false;
  let cancelTimeout;
  const cancellationExpired = new Promise((resolve) => { cancelTimeout = resolve; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', (error) => { settled = true; reject(error); });
    child.once('close', (code, exitSignal) => { settled = true; resolve({ code, signal: exitSignal }); });
  });
  const terminate = () => {
    requestedCancellation ??= signal?.reason ?? 'SIGTERM';
    if (termination) return;
    cancellationTimer = setTimeout(() => cancelTimeout({ code: null, signal: null, timedOut: true }), 10_000);
    // Never signal a numeric PID after this owned child has already settled.
    if (settled || !child.pid || child.exitCode !== null || child.signalCode !== null) {
      termination = Promise.resolve(false); return;
    }
      // Kill the owned group while the owned leader is still live. A wrapper-only
      // signal is insufficient: a test runner can leave its fork workers alive.
      try { process.kill(-child.pid, 'SIGKILL'); termination = Promise.resolve(true); }
      catch (error) {
        terminationError = error.code === 'ESRCH' ? undefined : 'The owned process-group stop was not confirmed.';
        termination = Promise.resolve(error.code === 'ESRCH');
      }
  };
  signal?.addEventListener('abort', terminate, { once: true });
  try {
    try { onStarted?.(child); } catch { callbackFailed = true; terminate(); }
    if (signal?.aborted) terminate();
    const result = await Promise.race([closed, cancellationExpired]);
    if (result.timedOut) {
      // An unconfirmed child is evidence to retain, not permission to keep the
      // verifier alive forever or clean its private root. Never signal it again.
      child.unref(); child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy();
      return { ...result, pid: child.pid, started: true, cancelled: requestedCancellation,
        ownership: 'unconfirmed', terminationError: 'The owned process did not reach observed close after cancellation.' };
    }
    let ownership = 'settled';
    if (requestedCancellation) {
      const terminated = await termination;
      if (!terminated) ownership = 'unconfirmed';
    }
    if (process.platform !== 'win32' && child.pid) {
        try {
          // Observation only after leader close. Never issue a later group kill
          // against a possibly reused identity. Reaping may be briefly delayed.
          for (let attempt = 0; attempt < 20 && groupExists(child.pid); attempt++) await delay(25);
          if (groupExists(child.pid)) ownership = 'unconfirmed';
        } catch { ownership = 'unconfirmed'; }
    }
    return { ...result, pid: child.pid, started: true, cancelled: requestedCancellation, ownership,
      ...(terminationError ? { terminationError } : {}),
      ...(callbackFailed ? { failure: 'Owned process start reporting failed.' } : {}) };
  } finally { clearTimeout(cancellationTimer); signal?.removeEventListener('abort', terminate); }
}
