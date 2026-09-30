/**
 * T50 acceptance contract. The production `test:remote` runner performs a real
 * OpenSSH preflight and fails before workflow activation when its prerequisites
 * are unavailable. These assertions must be implemented and executed on the
 * supported fixture after T48/T49 acceptance. They are not skipped passing tests.
 */
export const requiredRemoteCases = Object.freeze([
  'packaged Node server and separate test-only Pi adapter composition',
  'remote sentinel effect and Git diff; unchanged client-side sentinel',
  'active run survives tunnel kill with same server PID',
  'reconnect reports the actual result and original invocation count',
  'host kill after admitted effect before response reports unknown without replay',
  'wrong SSH key refuses authentication',
  'changed SSH host key refuses connection',
  'local port collision refuses forwarding',
  'protocol mismatch prevents commands',
  'stalled stop retains profile and checkout ownership until settlement',
]);
