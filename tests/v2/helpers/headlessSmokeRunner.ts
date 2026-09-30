import net from 'node:net';
import { runHeadlessSmoke } from './headlessSmokeHarness';

net.Server.prototype.listen = function () { throw new Error('HEADLESS_SMOKE_LISTENER_FORBIDDEN'); };
await runHeadlessSmoke();
console.log('HEADLESS_SMOKE_OK');
