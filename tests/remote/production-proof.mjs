// Separate packaged-production boundary/idle probe. NO test Pi adapter import.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls';
const c = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const root = await fs.realpath(c.productionRoot);
const inside = file => file === root || file.startsWith(root + path.sep);
const checksumBytes = await fs.readFile(path.join(root, 'SHA256SUMS'));
const lines = checksumBytes.toString('utf8').trim().split('\n');
const recorded = new Set(); const files = new Set(); const links = new Set();
async function walk(directory, prefix = '') {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
    else if (entry.isSymbolicLink()) links.add(relative);
    else { assert(entry.isFile()); if (relative !== 'SHA256SUMS') files.add(relative); }
  }
}
await walk(root);
for (const line of lines) {
  const match = /^([a-f0-9]{64})  (.+)$/u.exec(line); assert(match);
  const file = path.resolve(root, match[2]); assert(inside(file)); assert(!recorded.has(match[2])); recorded.add(match[2]);
  assert((await fs.lstat(file)).isFile() && !(await fs.lstat(file)).isSymbolicLink());
  assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'), match[1]);
  assert(!/(?:tests\/remote|fakePi|host\.ts)/u.test(match[2]), 'Test composition leaked into package');
}
assert.deepEqual([...recorded].sort(), [...files].sort(), 'Package checksum set must be complete');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'LINKS.json'), 'utf8'));
assert.deepEqual(manifest.map(link => link.path).sort(), [...links].sort());
for (const link of manifest) {
  const target = path.resolve(root, link.path); assert(inside(target));
  assert.equal(await fs.readlink(target), link.target); assert(inside(await fs.realpath(target)));
}
const deny = () => { throw new Error('T50_PRODUCTION_OUTBOUND_FORBIDDEN'); };
http.request = deny; http.get = deny; https.request = deny; https.get = deny; net.connect = deny; net.createConnection = deny;
net.Socket.prototype.connect = deny; tls.connect = deny; globalThis.fetch = async () => deny(); syncBuiltinESMExports();
registerHooks({ resolve(specifier, context, next) {
  if (/^(?:electron(?:-builder|-updater)?|transcribe-cpp|uiohook-napi)(?:\/|$)/u.test(specifier)) throw new Error('T50_DESKTOP_IMPORT_FORBIDDEN');
  const result = next(specifier, context);
  if (result.url.startsWith('file:')) assert(inside(fileURLToPath(result.url)), 'Production import escaped independent package');
  return result;
} });
const home = path.join(c.root, 'production-home'); const workspace = path.join(c.root, 'production-workspace');
await fs.mkdir(home, { mode: 0o700 }); await fs.mkdir(workspace, { mode: 0o700 });
const sentinel = Buffer.from('production idle sentinel\n'); await fs.writeFile(path.join(workspace, 'sentinel.txt'), sentinel);
process.env.HOME = home; process.env.USERPROFILE = home; process.env.PI_OFFLINE = '1';
const entry = path.join(root, 'dist/server/main.js');
const { startNodeServer } = await import(pathToFileURL(entry).href);
const host = await startNodeServer({ profile: { profileId: 't50-idle', home }, workspaces: [workspace], host: '127.0.0.1',
  port: c.hostPort, flags: { terminal: false, browser: false }, maxPermission: 'read-only' });
assert.equal(host.readiness.listener, 'disabled');
assert.equal(host.core.runtime.peekWorkspace(workspace), null);
await new Promise(r => setTimeout(r, 250));
assert.equal(host.core.runtime.peekWorkspace(workspace), null);
assert.equal(host.readiness.provider, 'auth-required');
assert.deepEqual(await fs.readFile(path.join(workspace, 'sentinel.txt')), sentinel);
assert.equal((await host.stop()).status, 'settled');
const stat = await fs.readFile(`/proc/${process.pid}/stat`, 'utf8');
const startIdentity = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
process.stdout.write(JSON.stringify({ kind: 'packaged-production-idle', pid: process.pid, startIdentity, node: process.version, entry,
  checksumFiles: lines.length, sha256sumsDigest: createHash('sha256').update(checksumBytes).digest('hex'),
  entryDigest: createHash('sha256').update(await fs.readFile(entry)).digest('hex'),
  listener: 'disabled', runtimeOpened: false, outboundForbidden: true, boundary: 'package-only',
  beforeBase64: sentinel.toString('base64'), afterBase64: (await fs.readFile(path.join(workspace, 'sentinel.txt'))).toString('base64') }) + '\n');
