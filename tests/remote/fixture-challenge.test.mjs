import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { Evidence, until } from './fixture-lib.mjs';
import { assertOriginalBrowserSession } from './fixture-session.mjs';
import { verifyReviewedBinding } from './fixture-binding.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('original synthetic principal/CSRF survive reconnect helper; distinct principal and changed CSRF refuse substitution', () => {
  const original = { cookie: 'synthetic cookie', csrf: 'fx1_' + 'x'.repeat(43), principalId: 'original-synthetic-principal' };
  assert.equal(assertOriginalBrowserSession(original, { sessionId: original.principalId, csrfToken: original.csrf }), original);
  assert.throws(() => assertOriginalBrowserSession(original, { sessionId: 'different', csrfToken: original.csrf }), /refuse rebootstrap/u);
  assert.throws(() => assertOriginalBrowserSession(original, { sessionId: original.principalId, csrfToken: 'different' }), /refuse rebootstrap/u);
});
test('all six actual credential prefixes redact stdout/stderr/nested records, including split fx1 chunks and live logs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't50-redact-'));
  try {
    const evidence = new Evidence(root); const tokens = ['fo1', 'fc1', 'fb1', 'fs1', 'ft1', 'fx1'].map(prefix => prefix + '_' + 'a'.repeat(43));
    const script = `const t=${JSON.stringify(tokens)};process.stdout.write('L'.repeat(4000)+t.join('|'));process.stderr.write(t.join('|'));const f=t[5];process.stdout.write(f.slice(0,22));setTimeout(()=>{process.stdout.write(f.slice(22));process.stdout.write('R'.repeat(4000));console.log('DONE');},30);setTimeout(()=>{},1000);`;
    const p = evidence.launch(process.execPath, ['-e', script]);
    await until(() => fs.readFile(path.join(root, '1.stdout.log'), 'utf8'), bytes => bytes.length > 0 && p.child.exitCode === null, 'live streamed log before actual child exit', 3000);
    await p.done;
    await evidence.record('nested', { credentials: { tokens, csrf: tokens[5] } });
    for (const file of ['1.stdout.log', '1.stderr.log', 'evidence.jsonl']) {
      const bytes = await fs.readFile(path.join(root, file), 'utf8'); for (const token of tokens) assert(!bytes.includes(token), `${file} leaked a credential`);
    }
    const stdout = await fs.readFile(path.join(root, '1.stdout.log'), 'utf8'); assert(stdout.includes('L'.repeat(4000))); assert(stdout.includes('R'.repeat(4000))); assert(stdout.includes('DONE'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('tiny real Node ignore-SIGTERM child has bounded deadline and actual exit, never success/forever await', async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't50-deadline-'));
  try {
    const evidence = new Evidence(root); const started = Date.now();
    await assert.rejects(evidence.run(process.execPath, ['-e', "process.on('SIGTERM',()=>{});console.log('ready; SIGTERM handler installed');setInterval(()=>{},1000)"],
      { deadlineMs: 600, graceMs: 300, forceMs: 1000 }), error => {
      assert.equal(error.code, 'PROCESS_DEADLINE_EXCEEDED'); assert.equal(error.result.timedOut, true);
      assert(error.result.stdout.includes('SIGTERM handler installed'), 'actual child must initialize its signal handler before deadline');
      assert(error.result.code !== null || error.result.signal !== null, 'require actual child exit proof');
      context.diagnostic(`Actual ${process.platform} Node exit code=${error.result.code}, signal=${error.result.signal}, termination attempt=${error.result.terminationAttempt}; Windows TERM is OS-forced, not Linux SIGKILL escalation proof.`);
      return true;
    });
    assert(Date.now() - started < 5000);
    const records = (await fs.readFile(path.join(root, 'evidence.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert(records.some(record => record.kind === 'process-exit')); assert(records.some(record => record.kind === 'process-deadline-exceeded'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
async function syntheticReviewedArtifacts(root) {
  // Actual local DATA files only, not a fake SDK/SSH transport or host execution.
  const roleNames = { node: 'node-data', config: 'config.json', controller: 'controller.mjs', controllerHelper: 'fixture-lib.mjs', processHelper: 'fixture-process.mjs', bindingHelper: 'fixture-binding.mjs', host: 'host.mjs', productionProbe: 'production-proof.mjs', productionSums: 'package/SHA256SUMS' };
  const deps = path.join(root, 'node_modules'); const bindingFile = path.join(root, 'reviewed.json');
  const c = { node: path.join(root, roleNames.node), hostEntry: path.join(root, roleNames.host), productionEntry: path.join(root, roleNames.productionProbe), productionRoot: path.join(root, 'package'), reviewedBindingFile: bindingFile };
  const files = [];
  for (const [role, relative] of Object.entries(roleNames)) {
    const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true });
    const bytes = role === 'config' ? JSON.stringify(c) : role === 'productionSums' ? `${hash('reviewed package payload')}  payload.txt\n` : `synthetic reviewed ${role}\n`; await fs.writeFile(file, bytes); files.push({ role, path: file, sha256: hash(bytes) });
  }
  await fs.writeFile(path.join(root, 'package', 'payload.txt'), 'reviewed package payload');
  const dependencyFiles = [];
  for (const pkg of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', '@modelcontextprotocol/sdk', 'ws', 'node-pty']) {
    const dataFiles = { 'package.json': JSON.stringify({ name: pkg, main: 'index.js' }), 'index.js': '// synthetic DATA only, never executed' };
    if (pkg === '@modelcontextprotocol/sdk') dataFiles['client/index.js'] = '// synthetic DATA only, never executed';
    for (const [name, bytes] of Object.entries(dataFiles)) {
      const relative = `${pkg}/${name}`; const file = path.join(deps, ...relative.split('/')); await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, bytes); dependencyFiles.push({ path: relative, sha256: hash(bytes) });
    }
  }
  const manifest = { version: 1, reviewId: 'synthetic-data-test-not-acceptance', sourceBase: 'a'.repeat(40), files, dependencies: { root: deps, files: dependencyFiles, links: [] } };
  const bytes = JSON.stringify(manifest); await fs.writeFile(bindingFile, bytes);
  return { manifest, digest: hash(bytes), bindingFile };
}
test('reviewed expected artifact/dependency bytes reject missing bindings, stale self-consistent sums, changed SDK and extra dependency', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't50-binding-'));
  try {
    const b = await syntheticReviewedArtifacts(root); await verifyReviewedBinding(b.manifest, b.digest, b.bindingFile);
    await assert.rejects(verifyReviewedBinding({}, b.digest, b.bindingFile));
    const sums = b.manifest.files.find(entry => entry.role === 'productionSums').path;
    const before = await fs.readFile(sums);
    const payload = path.join(root, 'package', 'payload.txt'); await fs.writeFile(payload, 'stale different package payload');
    const staleSums = `${hash(await fs.readFile(payload))}  payload.txt\n`; await fs.writeFile(sums, staleSums);
    assert.equal((await fs.readFile(sums, 'utf8')).split('  ')[0], hash(await fs.readFile(payload)), 'changed package is genuinely self-consistent but NOT the reviewed candidate');
    await assert.rejects(verifyReviewedBinding(b.manifest, b.digest, b.bindingFile), /Reviewed artifact mismatch: productionSums/u); await fs.writeFile(sums, before);
    const sdk = path.join(b.manifest.dependencies.root, '@earendil-works', 'pi-coding-agent', 'package.json');
    const originalSdk = await fs.readFile(sdk);
    await fs.writeFile(sdk, 'changed SDK DATA'); await assert.rejects(verifyReviewedBinding(b.manifest, b.digest, b.bindingFile), /Reviewed dependency mismatch/u); await fs.writeFile(sdk, originalSdk);
    await fs.writeFile(path.join(b.manifest.dependencies.root, 'unreviewed-extra.js'), 'extra');
    await assert.rejects(verifyReviewedBinding(b.manifest, b.digest, b.bindingFile), /Reviewed dependency mismatch/u);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
