import net from 'node:net';
import { runHeadlessSmoke } from './headlessSmokeHarness';

net.Server.prototype.listen = function () { throw new Error('HEADLESS_SMOKE_LISTENER_FORBIDDEN'); };
// Reuse the already-built artifacts, never a profile, across both backends.
for (const backend of ['legacy-json', 'native-durable'] as const) {
  await runHeadlessSmoke(backend);
  console.log(`HEADLESS_SMOKE_BACKEND_OK ${backend}`);
}
console.log('HEADLESS_SMOKE_OK');
