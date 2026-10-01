/** Self-contained read-only verifier, also serialized into the trusted SSH
 * preflight command BEFORE loading any preinstalled fixture controller/host. */
export async function verifyReviewedBinding(manifest, expectedDigest, bindingFile) {
  const { promises: fs } = await import('node:fs');
  const path = (await import('node:path')).default;
  const { createHash } = await import('node:crypto');
  const assert = (await import('node:assert/strict')).default;
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(manifest.version, 1); assert(typeof manifest.reviewId === 'string' && manifest.reviewId.length > 0);
  assert(/^[a-f0-9]{40}$/u.test(manifest.sourceBase)); assert(/^[a-f0-9]{64}$/u.test(expectedDigest));
  assert(path.isAbsolute(bindingFile)); assert.equal(hash(await fs.readFile(bindingFile)), expectedDigest, 'Reviewed binding manifest drift');
  const roles = ['node', 'config', 'controller', 'controllerHelper', 'processHelper', 'bindingHelper', 'host', 'productionProbe', 'productionSums'];
  assert(Array.isArray(manifest.files)); const byRole = new Map();
  for (const entry of manifest.files) {
    assert(roles.includes(entry.role) && !byRole.has(entry.role)); assert(path.isAbsolute(entry.path)); assert(/^[a-f0-9]{64}$/u.test(entry.sha256));
    const stat = await fs.lstat(entry.path); assert(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(hash(await fs.readFile(entry.path)), entry.sha256, `Reviewed artifact mismatch: ${entry.role}`); byRole.set(entry.role, entry.path);
  }
  assert.deepEqual([...byRole.keys()].sort(), [...roles].sort(), 'Missing independently reviewed artifact hashes');
  const c = JSON.parse(await fs.readFile(byRole.get('config'), 'utf8'));
  assert.equal(c.node, byRole.get('node')); assert.equal(c.hostEntry, byRole.get('host')); assert.equal(c.productionEntry, byRole.get('productionProbe'));
  assert.equal(path.join(c.productionRoot, 'SHA256SUMS'), byRole.get('productionSums')); assert.equal(c.reviewedBindingFile, bindingFile);
  const controllerRoot = path.dirname(byRole.get('controller'));
  for (const [role, name] of [['controllerHelper', 'fixture-lib.mjs'], ['processHelper', 'fixture-process.mjs'], ['bindingHelper', 'fixture-binding.mjs']]) assert.equal(byRole.get(role), path.join(controllerRoot, name));
  const deps = manifest.dependencies; assert(deps && Array.isArray(deps.files) && deps.files.length > 0 && Array.isArray(deps.links));
  assert.equal(deps.root, path.join(path.dirname(c.hostEntry), 'node_modules'));
  assert.equal(await fs.realpath(deps.root), deps.root);
  const expectedFiles = new Map(); const expectedLinks = new Map();
  const safe = relative => typeof relative === 'string' && relative.length > 0 && !relative.includes('\\') && !path.posix.isAbsolute(relative) && relative.split('/').every(part => part && part !== '.' && part !== '..');
  for (const entry of deps.files) { assert(safe(entry.path) && !expectedFiles.has(entry.path) && /^[a-f0-9]{64}$/u.test(entry.sha256)); expectedFiles.set(entry.path, entry.sha256); }
  for (const entry of deps.links) { assert(safe(entry.path) && !expectedLinks.has(entry.path) && typeof entry.target === 'string'); expectedLinks.set(entry.path, entry.target); }
  const observedFiles = []; const observedLinks = []; let count = 0;
  const walk = async (directory, prefix = '') => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      assert(++count < 1000000, 'Dependency inventory limit'); const relative = path.posix.join(prefix, entry.name); const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file, relative);
      else if (entry.isSymbolicLink()) {
        observedLinks.push(relative); assert.equal(await fs.readlink(file), expectedLinks.get(relative));
        const real = await fs.realpath(file); assert(real.startsWith(deps.root + path.sep), 'Dependency link escapes reviewed tree');
      } else { assert(entry.isFile()); observedFiles.push(relative); assert.equal(hash(await fs.readFile(file)), expectedFiles.get(relative), `Reviewed dependency mismatch: ${relative}`); }
    }
  };
  await walk(deps.root);
  assert.deepEqual(observedFiles.sort(), [...expectedFiles.keys()].sort(), 'Incomplete reviewed dependency inventory');
  assert.deepEqual(observedLinks.sort(), [...expectedLinks.keys()].sort());
  const { createRequire } = await import('node:module');
  const resolve = createRequire(c.hostEntry);
  for (const pkg of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', 'ws', 'node-pty']) assert(observedFiles.some(file => file.endsWith(`${pkg}/package.json`)), `Missing reviewed ${pkg} dependency`);
  for (const specifier of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', '@modelcontextprotocol/sdk/client/index.js', 'ws', 'node-pty']) {
    const resolved = await fs.realpath(resolve.resolve(specifier));
    assert(resolved.startsWith(deps.root + path.sep), `Dependency resolution escaped reviewed tree: ${specifier}`);
  }
  return { reviewId: manifest.reviewId, sourceBase: manifest.sourceBase, bindingDigest: expectedDigest, artifactFiles: roles.length, dependencyFiles: observedFiles.length };
}
