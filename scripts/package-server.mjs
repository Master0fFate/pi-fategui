import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { smokePackage } from './smoke-server-package.mjs';
import { createWebLicenseCapture, writeWebNotices } from './server-web-notices.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const isWithin = (parent, target) => target === parent || target.startsWith(parent + path.sep);
const desktopPackages = /^(?:electron(?:-builder|-updater)?|transcribe-cpp|uiohook-napi|koffi)(?:@|\/|$)/u;
const rootPackages = ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@modelcontextprotocol/sdk', 'ws'];
const packageVersion = reference => reference.split('(')[0];

/** Build tool only. It reads the installed YAML parser; no parser is added to the server solely for staging. */
export async function createRuntimeProjection(source = root, terminal = false) {
  const sdkRoot = await fs.realpath(path.join(source, 'node_modules/@earendil-works/pi-coding-agent'));
  const yaml = createRequire(path.join(sdkRoot, 'package.json'))('yaml');
  const lockBytes = await fs.readFile(path.join(source, 'pnpm-lock.yaml'));
  const workspaceBytes = await fs.readFile(path.join(source, 'pnpm-workspace.yaml'));
  const lock = yaml.parse(lockBytes.toString('utf8'));
  const workspace = yaml.parse(workspaceBytes.toString('utf8'));
  const selected = new Set();
  const resolveSnapshot = (name, reference) => {
    const candidates = [name + '@' + reference, reference.startsWith('npm:') ? reference.slice(4) : reference];
    const key = candidates.find(candidate => Object.hasOwn(lock.snapshots, candidate));
    assert(key, `Runtime lock has no required snapshot: ${name}`);
    return key;
  };
  const visit = key => {
    if (selected.has(key)) return;
    assert(!desktopPackages.test(key), `Desktop dependency in server closure: ${key}`);
    selected.add(key);
    const value = lock.snapshots[key];
    for (const [name, reference] of Object.entries({ ...value.dependencies, ...value.optionalDependencies })) {
      visit(resolveSnapshot(name, reference));
    }
  };
  const dependencies = {};
  for (const name of [...rootPackages, ...(terminal ? ['node-pty'] : [])]) {
    const entry = lock.importers['.'].dependencies[name];
    assert(entry, `Missing required root dependency: ${name}`);
    dependencies[name] = { specifier: packageVersion(entry.version), version: entry.version };
    visit(resolveSnapshot(name, entry.version));
  }
  const packageKeys = new Set([...selected].map(packageVersion));
  const packageNames = new Set([...packageKeys].map(key => key.slice(0, key.lastIndexOf('@'))));
  const patchPaths = Object.fromEntries(Object.entries(workspace.patchedDependencies).filter(([key]) => packageKeys.has(key)));
  const projectedLock = { lockfileVersion: lock.lockfileVersion, settings: lock.settings, overrides: lock.overrides,
    patchedDependencies: Object.fromEntries(Object.entries(lock.patchedDependencies).filter(([key]) => packageKeys.has(key))),
    importers: { '.': { dependencies } },
    packages: Object.fromEntries([...packageKeys].sort().map(key => {
      assert(lock.packages[key], `Runtime lock has no integrity metadata: ${key}`);
      return [key, lock.packages[key]];
    })), snapshots: Object.fromEntries([...selected].sort().map(key => [key, lock.snapshots[key]])) };
  const projectedWorkspace = { ...workspace,
    allowBuilds: Object.fromEntries(Object.entries(workspace.allowBuilds ?? {}).filter(([name]) => packageNames.has(name))),
    patchedDependencies: patchPaths };
  return { yaml, lock: projectedLock, workspace: projectedWorkspace, patchPaths,
    direct: Object.fromEntries(Object.entries(dependencies).map(([name, value]) => [name, value.specifier])),
    sourceHashes: { lock: hash(lockBytes), workspace: hash(workspaceBytes) } };
}

/** Audit literal external imports emitted by Vite. All runtime externals need a locked root. */
export async function auditProductionImports(code, roots) {
  assert(!/FATE_FAKE_PROVIDER|--fake-provider|FakePiSdkAdapter|headlessSmokeRunner|V2_PROVIDER_BLOCKED/u.test(code),
    'A production server entry contains test-only activation.');
  const found = new Set();
  // Use the existing build-time lexer. Text inside strings/comments cannot be an import.
  const vitestRoot = await fs.realpath(path.join(root, 'node_modules/vitest'));
  const mocker = createRequire(path.join(vitestRoot, 'package.json')).resolve('@vitest/mocker/package.json');
  const lexer = createRequire(mocker)('es-module-lexer'); await lexer.init;
  const [imports] = lexer.parse(code);
  for (const imported of imports) {
    if (imported.d === -2) continue; // import.meta
    assert(imported.n, 'Nonliteral production import requires explicit closure review.');
    const specifier = imported.n;
    if (specifier.startsWith('node:') || specifier.startsWith('.') || specifier.startsWith('/')) continue;
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    assert(!desktopPackages.test(name), 'Production entry imports a desktop package.');
    assert(Object.hasOwn(roots, name) || name === 'node-pty', `Unrecorded production runtime external: ${name}`);
    found.add(name);
  }
  return [...found].sort();
}

async function run(command, args, cwd, log, extraEnv = {}) {
  let stdout = '', stderr = '';
  const exit = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...extraEnv }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  await fs.writeFile(log, JSON.stringify({ command, args, cwd, ...exit }) + '\n' + stdout + stderr);
  assert.equal(exit.code, 0, `Command failed. Evidence: ${log}`);
  return stdout.trim();
}

async function walk(directory, prefix = '') {
  const result = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) result.push({ type: 'link', relative, absolute, target: await fs.readlink(absolute) });
    else if (entry.isDirectory()) result.push(...await walk(absolute, relative));
    else { assert(entry.isFile(), `Special file in server artifact: ${relative}`); result.push({ type: 'file', relative, absolute }); }
  }
  return result;
}

async function inspectRuntime(stage, projection) {
  const entries = await walk(path.join(stage, 'node_modules'));
  const closureKeys = new Set(Object.keys(projection.lock.packages));
  const installed = [];
  const notices = ['# Server runtime dependency notices\n', 'Exact published packages and current existing patches are retained.\n'];
  for (const entry of entries) {
    if (entry.type === 'link') {
      const target = await fs.realpath(entry.absolute);
      assert(isWithin(stage, target), `Dependency link escapes the independent artifact: ${entry.relative}`);
      continue;
    }
    if (!entry.relative.endsWith('/package.json') || entry.relative.includes('/node_modules/') && entry.relative.includes('/test/')) continue;
    const manifest = JSON.parse(await fs.readFile(entry.absolute, 'utf8'));
    if (!manifest.name || !manifest.version) continue; // Nested ESM/CJS mode metadata is package data.
    const key = `${manifest.name}@${manifest.version}`;
    if (!closureKeys.has(key)) {
      // Published nested fixtures/data are retained as SDK data, not installed roots.
      if (!/\.pnpm\/[^/]+\/node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/u.test(entry.relative)) continue;
      throw new Error(`Installed dependency is outside the frozen runtime closure: ${key}`);
    }
    assert(!desktopPackages.test(manifest.name), 'Desktop dependency installed in server artifact.');
    const packageRoot = path.dirname(entry.absolute);
    const licenseFiles = (await fs.readdir(packageRoot)).filter(name => /^(?:licen[sc]e|copying|notice)(?:\.|$)/iu.test(name)).sort();
    assert(manifest.license, `Missing license declaration: ${key}`);
    const licenses = [];
    for (const name of licenseFiles) {
      const target = path.join(packageRoot, name);
      const metadata = await fs.lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      const text = await fs.readFile(target, 'utf8');
      licenses.push({ file: path.relative(stage, target), sha256: hash(text) });
      notices.push(`\n## ${key}: ${manifest.license}\n\n### ${name}\n\n${text}\n`);
    }
    if (!licenses.length) notices.push(`\n## ${key}: ${manifest.license}\n\nNo separate license file in the published package. The package declaration is retained.\n`);
    installed.push({ name: manifest.name, version: manifest.version, license: manifest.license,
      directory: path.relative(stage, packageRoot), integrity: projection.lock.packages[key].resolution.integrity,
      manifestSha256: hash(await fs.readFile(entry.absolute)), licenses });
  }
  installed.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  const installedKeys = new Set(installed.map(value => value.name + '@' + value.version));
  for (const [name, version] of Object.entries(projection.direct)) assert(installedKeys.has(`${name}@${version}`), `Root package unavailable: ${name}`);
  const absent = Object.entries(projection.lock.packages).filter(([key]) => !installedKeys.has(key))
    .map(([key, value]) => ({ package: key, os: value.os ?? null, cpu: value.cpu ?? null,
      optional: Object.entries(projection.lock.snapshots).filter(([snapshot]) => packageVersion(snapshot) === key)
        .every(([, snapshot]) => snapshot.optional === true) }));
  assert(absent.every(value => value.optional), 'A required locked package is missing from the target installation.');
  await fs.writeFile(path.join(stage, 'THIRD_PARTY_NOTICES.md'), notices.join(''));
  return { installed, absentOptionalTargets: absent };
}

async function checksums(stage) {
  const entries = await walk(stage);
  const links = entries.filter(value => value.type === 'link').map(({ relative, target }) => ({ path: relative, target }));
  for (const entry of entries.filter(value => value.type === 'link')) assert(isWithin(stage, await fs.realpath(entry.absolute)), 'Artifact link escapes its root.');
  await fs.writeFile(path.join(stage, 'LINKS.json'), JSON.stringify(links, null, 2) + '\n');
  const files = (await walk(stage)).filter(value => value.type === 'file' && value.relative !== 'SHA256SUMS');
  const lines = [];
  for (const file of files) lines.push(`${hash(await fs.readFile(file.absolute))}  ${file.relative}`);
  await fs.writeFile(path.join(stage, 'SHA256SUMS'), lines.join('\n') + '\n');
}

function parseOptions(args) {
  const result = { terminal: false, web: true, offline: false, output: path.join(root, 'build/server-package/artifacts'), store: null, inspect: false, audit: null };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    assert(!seen.has(flag), 'Duplicate package option.'); seen.add(flag);
    if (flag === '--with-terminal') result.terminal = true;
    else if (flag === '--offline') result.offline = true;
    else if (flag === '--without-web') result.web = false;
    else if (flag === '--inspect-lock') result.inspect = true;
    else if (['--output', '--store-dir', '--audit-entry'].includes(flag)) {
      const value = args[++index]; assert(value && !value.startsWith('--'), 'A package option requires a path.');
      if (flag === '--output') result.output = path.resolve(value);
      if (flag === '--store-dir') result.store = path.resolve(value);
      if (flag === '--audit-entry') result.audit = path.resolve(value);
    } else throw new Error('Unknown server package option.');
  }
  return result;
}

export async function packageServer(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  const projection = await createRuntimeProjection(root, options.terminal);
  if (options.audit) { console.log(JSON.stringify({ imports: await auditProductionImports(await fs.readFile(options.audit, 'utf8'), projection.direct) })); return; }
  if (options.inspect) {
    console.log(JSON.stringify({ roots: projection.direct, snapshotCount: Object.keys(projection.lock.snapshots).length,
      patches: projection.patchPaths, packageKeys: Object.keys(projection.lock.packages), devDependencies: false,
      sourceHashes: projection.sourceHashes })); return;
  }
  assert.equal(process.platform, 'linux', 'Only the tested Linux x64 package target is enabled.');
  assert.equal(process.arch, 'x64', 'Only the tested Linux x64 package target is enabled.');
  assert(!isWithin(options.output, root) && !isWithin(path.join(root, 'node_modules'), options.output), 'Unsafe package output root.');
  await fs.mkdir(options.output, { recursive: true });
  const sourceManifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const stage = await fs.mkdtemp(path.join(options.output, `fate-server-${sourceManifest.version}-linux-x64-`));
  const evidenceRoot = stage + '-evidence'; await fs.mkdir(evidenceRoot);
  const declaredPnpm = sourceManifest.packageManager;
  const actualPnpm = await run('pnpm', ['--version'], root, path.join(evidenceRoot, 'pnpm-version.log'));
  const { build } = await import('vite');
  const webCapture = options.web ? createWebLicenseCapture() : null;
  for (const name of ['cli', 'server', ...(options.web ? ['web'] : [])]) {
    await build({ configFile: path.join(root, `vite.${name}.config.ts`),
      ...(name === 'web' ? { plugins: [webCapture.plugin()],
        worker: { plugins: () => [webCapture.plugin('worker')] } } : {}) });
  }
  const imports = {};
  for (const name of ['cli', 'server']) {
    imports[name] = {};
    for (const entry of await walk(path.join(root, `dist/${name}`))) {
      assert.equal(entry.type, 'file', 'Compiled output must not contain links.');
      if (/\.(?:mjs|js)$/u.test(entry.relative)) {
        const bytes = await fs.readFile(entry.absolute);
        imports[name][entry.relative] = { externals: await auditProductionImports(bytes.toString('utf8'), projection.direct), sha256: hash(bytes) };
      }
    }
    await fs.mkdir(path.join(stage, 'dist'), { recursive: true });
    await fs.cp(path.join(root, `dist/${name}`), path.join(stage, `dist/${name}`), { recursive: true });
  }
  let webLicenses = null;
  if (options.web) {
    await fs.cp(path.join(root, 'dist/web'), path.join(stage, 'dist/web'), { recursive: true });
    // Strict notice closure must pass before dependency installation or an accepted archive.
    webLicenses = await writeWebNotices({ sourceRoot: root, webRoot: path.join(stage, 'dist/web'),
      stageRoot: stage, capture: webCapture });
  }
  const minimal = { name: 'fate-server', version: sourceManifest.version, private: true, type: 'module',
    description: 'Independent Fate server for plain Node; Pi remains the execution engine.', license: sourceManifest.license,
    engines: sourceManifest.engines, packageManager: declaredPnpm, bin: { 'fate-server': 'bin/fate-server' }, dependencies: projection.direct };
  await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify(minimal, null, 2) + '\n');
  await fs.writeFile(path.join(stage, 'pnpm-lock.yaml'), projection.yaml.stringify(projection.lock));
  await fs.writeFile(path.join(stage, 'pnpm-workspace.yaml'), projection.yaml.stringify(projection.workspace));
  const patches = [];
  for (const [name, relative] of Object.entries(projection.patchPaths)) {
    assert(relative.startsWith('patches/') && !relative.includes('..'), 'Unsafe existing patch path.');
    const bytes = await fs.readFile(path.join(root, relative));
    await fs.mkdir(path.dirname(path.join(stage, relative)), { recursive: true });
    await fs.writeFile(path.join(stage, relative), bytes);
    patches.push({ name, file: relative, sha256: hash(bytes), unchanged: true });
  }
  const installArgs = ['install', '--prod', options.offline ? '--offline' : '--prefer-offline', '--frozen-lockfile', '--ignore-scripts', '--package-import-method', 'copy'];
  if (options.store) installArgs.push('--store-dir', options.store);
  await run('pnpm', installArgs, stage, path.join(evidenceRoot, 'install.log'));
  if (options.terminal) await run('pnpm', ['rebuild', 'node-pty'], stage, path.join(evidenceRoot, 'native-rebuild.log'), { npm_config_build_from_source: 'true' });
  // Generated manager metadata/wrappers can name build paths; runtime resolution needs only internal links/packages.
  await fs.rm(path.join(stage, 'node_modules/.modules.yaml'), { force: true });
  await fs.rm(path.join(stage, 'node_modules/.bin'), { recursive: true, force: true });
  const runtime = await inspectRuntime(stage, projection);
  for (const entry of patches) {
    assert.equal(hash(await fs.readFile(path.join(root, entry.file))), entry.sha256, 'An original SDK patch changed during packaging.');
    assert.equal(hash(await fs.readFile(path.join(stage, entry.file))), entry.sha256, 'A staged SDK patch changed during packaging.');
  }
  const dependencyMap = { schema: 1, roots: projection.direct, sourceHashes: projection.sourceHashes,
    lockedRuntimeSnapshots: Object.keys(projection.lock.snapshots).length, patches, ...runtime, imports, web: webLicenses };
  await fs.writeFile(path.join(stage, 'server-dependency-map.json'), JSON.stringify(dependencyMap, null, 2) + '\n');
  await fs.mkdir(path.join(root, 'plans/reports'), { recursive: true });
  await fs.writeFile(path.join(root, 'plans/reports/server-dependency-map.json'), JSON.stringify(dependencyMap, null, 2) + '\n');
  await fs.copyFile(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
  await fs.copyFile(path.join(root, 'NOTICE'), path.join(stage, 'NOTICE'));
  await fs.copyFile(path.join(root, 'build/server-package/README.md'), path.join(stage, 'README.md'));
  await fs.mkdir(path.join(stage, 'checks')); await fs.mkdir(path.join(stage, 'bin'));
  await fs.copyFile(path.join(root, 'scripts/smoke-server-package.mjs'), path.join(stage, 'checks/smoke.mjs'));
  await fs.writeFile(path.join(stage, 'bin/fate-server'), `#!/bin/sh
set -eu
command -v node >/dev/null 2>&1 || { echo 'Install Node 22.19 or later for the separate fate-server companion.' >&2; exit 1; }
self=$(readlink -f -- "$0") || { echo 'The fate-server launcher path is unavailable.' >&2; exit 1; }
exec node "$(dirname -- "$self")/../dist/cli/main.js" "$@"
`, { mode: 0o755 });
  const publicManifest = { schema: 1, app: 'Fate server', version: sourceManifest.version, protocol: 1,
    node: sourceManifest.engines.node, artifactTarget: { os: 'linux', arch: 'x64' },
    nativeTerminal: options.terminal, web: options.web, webNoticeClosure: webLicenses?.noticeClosureComplete ?? null, testedTargets: [] };
  await fs.writeFile(path.join(stage, 'server-manifest.json'), JSON.stringify(publicManifest, null, 2) + '\n');
  await checksums(stage);
  const smoke = await smokePackage(stage, { terminal: options.terminal });
  await fs.writeFile(path.join(evidenceRoot, 'production-smoke.json'), JSON.stringify(smoke, null, 2) + '\n');
  publicManifest.testedTargets = [{ os: 'linux', arch: 'x64', node: process.version, abi: process.versions.modules,
    productionSmoke: true, nativeTerminal: options.terminal ? smoke.native : null }];
  await fs.writeFile(path.join(stage, 'server-manifest.json'), JSON.stringify(publicManifest, null, 2) + '\n');
  await checksums(stage);
  const archive = stage + '.tar.gz';
  await run('tar', ['-czf', archive, '-C', path.dirname(stage), path.basename(stage)], root, path.join(evidenceRoot, 'archive.log'));
  const archiveHash = hash(await fs.readFile(archive));
  await fs.writeFile(archive + '.sha256', `${archiveHash}  ${path.basename(archive)}\n`);
  const record = { stage, archive, archiveSha256: archiveHash, evidenceRoot, node: process.version, declaredPnpm, actualPnpm,
    packageManagerVersionMatches: declaredPnpm === `pnpm@${actualPnpm}`, terminal: options.terminal, productionSmoke: smoke,
    status: 'Linux package verified; task acceptance and Windows gates remain separate' };
  await fs.writeFile(path.join(evidenceRoot, 'result.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify(record));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await packageServer(); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Server packaging failed.'); process.exitCode = 1; }
}
