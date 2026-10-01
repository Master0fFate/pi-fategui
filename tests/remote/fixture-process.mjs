const timeout = (promise, ms) => new Promise(resolve => {
  const timer = setTimeout(() => resolve({ pending: true }), ms);
  promise.then(value => { clearTimeout(timer); resolve({ value }); }, error => { clearTimeout(timer); resolve({ error }); });
});
function result(outcome) { if ('error' in outcome) throw outcome.error; return outcome.value; }
/** Captured child only; never PID inference or treating a signal as exit proof. */
export async function awaitOwnedProcess(owned, { deadlineMs = 30000, graceMs = 1000, forceMs = 2000, onUnsettled = async () => {} } = {}) {
  for (const ms of [deadlineMs, graceMs, forceMs]) if (!Number.isSafeInteger(ms) || ms < 1) throw new Error('Invalid process deadline');
  let outcome = await timeout(owned.done, deadlineMs);
  if (!outcome.pending) return { ...result(outcome), timedOut: false };
  const signal = name => { try { owned.child.kill(name); } catch { /* Await actual completion, not signal success. */ } };
  signal('SIGTERM'); outcome = await timeout(owned.done, graceMs);
  if (!outcome.pending) return { ...result(outcome), timedOut: true, terminationAttempt: 'SIGTERM' };
  signal('SIGKILL'); outcome = await timeout(owned.done, forceMs);
  if (!outcome.pending) return { ...result(outcome), timedOut: true, terminationAttempt: 'SIGKILL' };
  const retained = { pid: owned.child.pid, ownershipRetained: true, completionUnsettled: true };
  let logFailure;
  try { await onUnsettled(retained); } catch (error) { logFailure = error; }
  throw Object.assign(new Error('PROCESS_UNSETTLED: actual exit/log settlement unproved; ownership retained', { cause: logFailure }), { code: 'PROCESS_UNSETTLED', retained });
}
