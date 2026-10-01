/**
 * T50 review checklist, NOT executable acceptance or a count of passing tests.
 * Implementations: workflow.mjs (real SSH/HTTP cases), host.ts (separate typed
 * test-only Fate/Pi composition), production-proof.mjs (packaged boundary/idle),
 * controller.mjs (independent actual-PID host supervision and durable evidence).
 * remoteWorkspace.test.mjs executes the runner; absent fixture fails, not skips.
 * Static helper tests never stand in for these still-unexecuted remote cases.
 */
export const requiredRemoteCases = Object.freeze([
  'packaged Node server and separate test-only Pi adapter composition',
  'remote sentinel effect and Git diff; unchanged client-side sentinel',
  'active run survives tunnel kill with same server PID',
  'reconnect reports the actual result and original invocation count',
  'separate host kill after admitted effect before response; explicit verified fixture-lock quarantine; interrupted/unknown and cumulative count one without replay',
  'unknown SSH host pin refuses connection',
  'wrong SSH key refuses authentication',
  'changed SSH host key refuses connection',
  'local port collision refuses forwarding',
  'protocol mismatch prevents commands',
  'stalled stop retains profile and checkout ownership until settlement',
]);
