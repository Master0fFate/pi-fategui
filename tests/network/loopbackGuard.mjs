import { registerHooks, syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';

if (!process.env.FATE_V2_TEST_ROOT) throw new Error('Network fixtures require a private isolated test root.');
const deny = () => { throw new Error('NETWORK_TEST_OUTBOUND_BLOCKED: only numeric 127.0.0.1 fixture requests are allowed'); };
const hostFrom = (args) => {
  // Node's createConnection forwards its normalized [options, callback] as
  // one array argument. Inspect that destination too; do not grant it a bypass.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === 'object' && first !== null) {
    if (first instanceof URL) return first.hostname;
    return first.host ?? first.hostname ?? null;
  }
  if (typeof first === 'string') {
    try { const url = new URL(first); return url.protocol === 'http:' ? url.hostname : null; }
    catch { return null; } // Socket paths and malformed URLs are not destinations.
  }
  return typeof args[1] === 'string' ? args[1] : null;
};
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  if (hostFrom(args) !== '127.0.0.1') return deny();
  return originalConnect.apply(this, args);
};
const originalRequest = http.request;
http.request = function (...args) {
  if (hostFrom(args) !== '127.0.0.1') return deny();
  return originalRequest.apply(this, args);
};
const originalGet = http.get;
http.get = function (...args) {
  if (hostFrom(args) !== '127.0.0.1') return deny();
  return originalGet.apply(this, args);
};
https.request = deny; https.get = deny;
tls.connect = deny; dgram.createSocket = deny;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return deny();
  return originalFetch(input, init);
};
syncBuiltinESMExports();
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'electron' || specifier.startsWith('electron/')) throw new Error('NETWORK_TEST_ELECTRON_BLOCKED');
  return nextResolve(specifier, context);
} });
