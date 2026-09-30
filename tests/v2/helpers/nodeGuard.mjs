import { registerHooks, syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';

if (!process.env.FATE_V2_TEST_ROOT) throw new Error('v2 tests require scripts/run-v2-tests.mjs');
const blocked = () => { throw new Error('V2_OUTBOUND_BLOCKED: use the deterministic PiSdkAdapter fake'); };
// Defense in depth, not a hostile-code sandbox. Install before Vitest or Pi.
http.request = blocked;
http.get = blocked;
https.request = blocked;
https.get = blocked;
net.connect = blocked;
net.createConnection = blocked;
net.Socket.prototype.connect = blocked;
tls.connect = blocked;
dgram.createSocket = blocked;
globalThis.fetch = async () => blocked();
syncBuiltinESMExports();
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron' || specifier.startsWith('electron/')) {
      throw new Error('V2_ELECTRON_BLOCKED: Node tests must not import Electron');
    }
    return nextResolve(specifier, context);
  },
});
