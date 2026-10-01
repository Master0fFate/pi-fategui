// Separate trusted native-I/O driver. Never imports Fate/Pi/provider code.
// The actual production CLI imports the unchanged loopback-only guard itself.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const source = path.resolve(import.meta.dirname, '../../..');
const root = process.env.FATE_V2_TEST_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error('Private test root required.');
let inputBytes = '';
process.stdin.setEncoding('utf8');
for await (const bytes of process.stdin) {
  inputBytes += bytes;
  if (Buffer.byteLength(inputBytes) > 64 * 1024) throw new Error('Oversized private driver request.');
}
const request = JSON.parse(inputBytes);
const built = path.join(source, 'tests/network/.built') + path.sep;
if (typeof request.entry !== 'string' || !path.resolve(request.entry).startsWith(built)
  || path.basename(request.entry) !== 'main.js' || !Array.isArray(request.argv)
  || !request.argv.every(value => typeof value === 'string' && !/[\0\r\n]/u.test(value))
  || typeof request.ownershipId !== 'string'
  || typeof request.entrySha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(request.entrySha256)) throw new Error('Invalid owned CLI request.');
const real = await fs.realpath(request.entry);
if (!real.startsWith(built)) throw new Error('CLI entry escapes owned build.');
if (request.input !== undefined && (typeof request.input?.marker !== 'string' || typeof request.input?.value !== 'string')) throw new Error('Invalid private input.');
const marker = path.join(root, '.fate-retained-owned-work.json');
const guardRoot = path.join(root, '.fate-owned-cli-guard');
const pending = JSON.parse(await fs.readFile(marker, 'utf8'));
const owner = JSON.parse(await fs.readFile(path.join(guardRoot, 'owner.json'), 'utf8'));
const state = JSON.parse(await fs.readFile(path.join(guardRoot, 'state.json'), 'utf8'));
const canonicalRoot = await fs.realpath(root), home = await fs.realpath(process.env.HOME ?? '');
const relativeHome = path.relative(canonicalRoot, home);
if (!relativeHome || relativeHome === '..' || relativeHome.startsWith('..' + path.sep) || path.isAbsolute(relativeHome)
  || [pending, owner, state].some(value => value.id !== request.ownershipId || value.entry !== request.entry
    || value.entrySha256 !== request.entrySha256 || value.home !== home || value.status !== 'pending-cli')
  || pending.wrapperPid !== process.pid || state.wrapperPid !== process.pid
  || pending.actualCliPid !== null || state.actualCliPid !== null) throw new Error('Owned CLI marker is invalid.');
// Verify the actual owned entry bytes immediately before creating a PTY.
// This is fixture provenance, not an OS sandbox against another local writer.
const entrySha256 = createHash('sha256').update(await fs.readFile(real)).digest('hex');
if (entrySha256 !== request.entrySha256) throw new Error('Owned CLI entry bytes changed.');
const require = createRequire(path.join(source, 'package.json'));
const pty = require('node-pty');
const guard = pathToFileURL(path.join(source, 'tests/network/loopbackGuard.mjs')).href;
const started = performance.now();
const elapsed = () => Math.round(performance.now() - started);
const timing = { firstOutputMs: null, promptMs: null, inputMs: null, exitMs: null };
const child = pty.spawn(process.execPath, ['--import', guard, request.entry, ...request.argv], {
  cwd: source, env: process.env, cols: 120, rows: 30,
});
let output = '', sent = false, failure = null, teardownConfirmed = true, inputTimer;
const subscriptions = [];
function stopOwned() {
  try { child.kill(); }
  catch { failure ??= 'Owned native CLI control failed.'; teardownConfirmed = false; }
}
// The pending marker already exists. A failed PID update must not destroy it
// or interrupt observation of the actual child just spawned.
async function publishPid() {
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
    failure ??= 'Owned native CLI PID is invalid.'; teardownConfirmed = false; return;
  }
  const value = { ...pending, actualCliPid: child.pid };
  for (const file of [marker, path.join(guardRoot, 'state.json')]) {
    const temporary = file + '.' + request.ownershipId + '.driver.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, file);
    } catch { failure ??= 'Owned native CLI PID ledger update failed.'; teardownConfirmed = false; }
    finally { try { await fs.rm(temporary, { force: true }); } catch { teardownConfirmed = false; } }
  }
}
let deadline, retained;
let result;
try {
  const observed = new Promise(resolve => {
    // Measured Windows prompt 25.321s, SDK authorization 28.693s, followed by
    // another real ACL/HTTP state read. 35s stays inside the existing 45s test.
    deadline = setTimeout(() => { failure ??= 'Actual CLI exceeded 35-second bound.'; stopOwned(); }, 35_000);
    retained = setTimeout(() => {
      stopOwned();
      resolve({ pid: child.pid, exitCode: null, signal: null, incomplete: true });
    }, 40_000);
    subscriptions.push(child.onData(bytes => {
      timing.firstOutputMs ??= elapsed(); output += bytes;
      if (Buffer.byteLength(output) > 512 * 1024) { failure ??= 'Actual CLI output exceeded bounded capture.'; stopOwned(); }
      if (request.input && !sent && output.includes(request.input.marker)) {
        sent = true; timing.promptMs = elapsed();
        inputTimer = setTimeout(() => {
          timing.inputMs = elapsed();
          try { child.write(request.input.value); }
          catch { failure ??= 'Owned hidden-input write failed.'; stopOwned(); }
        }, 25);
      }
    }));
    subscriptions.push(child.onExit(exit => {
      timing.exitMs = elapsed();
      if (request.input && !sent) failure ??= 'Actual hidden-input prompt absent.';
      resolve({ pid: child.pid, exitCode: exit.exitCode, signal: exit.signal ?? null, incomplete: false });
    }));
  });
  // Install exit/data observers BEFORE asynchronous PID publication.
  await publishPid();
  result = await observed;
} finally {
  clearTimeout(deadline); clearTimeout(retained); clearTimeout(inputTimer);
  for (const subscription of subscriptions) {
    try { subscription.dispose(); } catch { failure ??= 'Owned native subscription disposal failed.'; teardownConfirmed = false; }
  }
  // Windows ConPTY retains its local control resources after onExit. Public
  // kill disposes them; Unix onExit has reaped the child already (no PID kill).
  if (process.platform === 'win32' || !result || result.incomplete) stopOwned();
}
if (result.incomplete) teardownConfirmed = false;
process.stdout.write(JSON.stringify({ ...result, output, sent, timing, failure, teardownConfirmed,
  ownershipId: request.ownershipId, entrySha256 }));
process.exitCode = result.incomplete || failure || !teardownConfirmed ? 1 : 0;
