import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createIsolatedEnvironment } from './run-v2-tests.mjs';

// Argument/installed-shim proof only. This does not replace product E2E,
// native primary-instance/picker proof, or a production server-package gate.
assert.equal(process.platform, 'win32', 'This check requires native Windows.');
const source = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(source, 'package.json'));
const isolated = await createIsolatedEnvironment();
const installed = path.join(isolated.root, 'installed Fate with spaces');
const capture = path.join(isolated.root, 'capture.json');
const records = [];
const psLiteral = value => "'" + value.replaceAll("'", "''") + "'";
// cmd's fixed /c command then reaches a native executable. Double terminal
// backslashes before its closing quote, as required by Windows argv rules.
const nativeQuote = value => '"' + value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1') + '"';
const run = (exe, args, env, verbatim = false, cwd = installed) => new Promise((resolve, reject) => {
  const child = spawn(exe, args, { cwd, env, shell: false, windowsVerbatimArguments: verbatim, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const timer = setTimeout(() => { child.kill(); reject(new Error('Owned launcher probe did not settle.')); }, 30_000);
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
});
const launch = async (shell, args, env) => {
  const launcher = path.join(installed, 'fate.cmd');
  // Windows PowerShell 5 invokes .cmd through cmd.exe. For a token without
  // spaces it drops its own single-quote grouping before cmd parses pipes,
  // ampersands and carets. Explicit native double quotes must cross that
  // boundary. This is caller transport syntax, not a wrapper repair or proof
  // that arbitrary cmd environment expansion can be undone by a launcher.
  const psBatchArgument = value => psLiteral(!/\s/u.test(value) && /[&|<>^]/u.test(value) ? nativeQuote(value) : value);
  return shell === 'cmd'
    ? run('cmd.exe', ['/d', '/s', '/c', '"' + [launcher, ...args].map(nativeQuote).join(' ') + '"'], env, true)
    : run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '& ' + psLiteral(launcher) + ' ' + args.map(psBatchArgument).join(' ')], env);
};
try {
  const electron = require('electron');
  const binaryHash = createHash('sha256').update(await fs.readFile(electron)).digest('hex');
  await fs.cp(path.dirname(electron), installed, { recursive: true });
  await fs.rename(path.join(installed, 'electron.exe'), path.join(installed, 'fate-ui.exe'));
  await fs.mkdir(path.join(installed, 'resources/cli'), { recursive: true });
  await fs.copyFile(path.join(source, 'build/cli/fate.cmd'), path.join(installed, 'fate.cmd'));
  await fs.copyFile(path.join(source, 'build/cli/fate-launch.ps1'), path.join(installed, 'resources/cli/fate-launch.ps1'));
  await fs.mkdir(path.join(installed, 'resources/app'), { recursive: true });
  await fs.writeFile(path.join(installed, 'resources/app/package.json'), JSON.stringify({ main: 'main.cjs' }));
  await fs.writeFile(path.join(installed, 'resources/app/main.cjs'), `const {app}=require('electron'); app.setPath('userData',process.env.FATE_LAUNCH_USER_DATA); app.disableHardwareAcceleration(); require('node:fs').writeFileSync(process.env.FATE_LAUNCH_CAPTURE,JSON.stringify({pid:process.pid,argv:process.argv})); app.quit();`);
  const env = { ...isolated.env, FATE_LAUNCH_CAPTURE: capture, FATE_LAUNCH_USER_DATA: path.join(isolated.root, 'electron-data') };
  const literal = path.join(installed, 'zażółć ^ % & (literal) $x ; ! path');
  for (const shell of ['cmd', 'powershell']) {
    for (const test of [
      { args: [literal, '--new-instance'], expected: ['--project=' + literal, '--new-instance'] },
      { args: ['--', 'serve'], expected: ['--project=' + path.join(installed, 'serve')] },
      { args: ['--project', literal], expected: ['--project=' + literal] },
      { args: ['--project=' + literal], expected: ['--project=' + literal] },
      { args: [path.join(installed, 'tail with spaces') + '\\'], expected: ['--project=' + path.join(installed, 'tail with spaces') + '\\'] },
      { args: [path.join(installed, 'tail with spaces') + '\\', '--new-instance'], expected: ['--project=' + path.join(installed, 'tail with spaces') + '\\', '--new-instance'] },
      { args: ['unicode\u00a0name'], expected: ['--project=' + path.join(installed, 'unicode\u00a0name')] },
      { args: ['connect', 'fixture'], expected: ['--connection-profile=fixture'] },
      { args: ['plain&literal'], expected: ['--project=' + path.join(installed, 'plain&literal')] },
      { args: ['--unknown'] }, { args: ['--new-instance', '--new-instance'] },
      { args: ['--project'] }, { args: ['connect', '--evil'] },
      { args: ['-LaunchArgs', 'unexpected'] },
      { args: ['bad|path'] },
      { args: ['serve', '--profile', 'fixture'], diagnostic: /separate fate-server Node package/u },
    ]) {
      await fs.rm(capture, { force: true });
      const result = await launch(shell, test.args, env);
      let observed = null;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { observed = JSON.parse(await fs.readFile(capture, 'utf8')); break; } catch { /* bounded wait for own capture app */ }
        if (result.code !== 0) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      records.push({ shell, args: test.args, transport: shell === 'powershell' ? 'explicit cmd quoting for non-space metacharacter tokens' : 'native cmd quoting', result, observed });
      if (test.expected) { assert.equal(result.code, 0, result.stderr); assert(observed, 'Desktop capture absent.'); assert.deepEqual(observed.argv.slice(1), test.expected); }
      else { assert.equal(result.code, 1); assert.equal(observed, null, 'Rejected arguments started Electron.'); if (test.diagnostic) assert.match(result.stderr, test.diagnostic); }
    }
  }
  // Real package-manager shim creation, in private prefixes only. Query the
  // actual compiled CLI; never infer a package root from the shim location.
  const pkg = path.join(isolated.root, 'companion package');
  await fs.mkdir(path.join(pkg, 'dist'), { recursive: true });
  await fs.cp(path.join(source, 'dist/cli'), path.join(pkg, 'dist/cli'), { recursive: true });
  await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'fate-server', version: '0.0.0', private: true, type: 'module', bin: { 'fate-server': 'dist/cli/main.js' } }));
  const layouts = [
    { name: 'npm', bin: path.join(isolated.root, 'npm global'), command: ['npm', 'install', '--global', '--prefix', path.join(isolated.root, 'npm global'), '--ignore-scripts', '--offline', '--no-audit', '--no-fund', pkg] },
    { name: 'pnpm', bin: path.join(isolated.root, 'pnpm bin'), command: ['pnpm', 'add', '--global', '--global-dir', path.join(isolated.root, 'pnpm global'), '--global-bin-dir', path.join(isolated.root, 'pnpm bin'), '--offline', '--ignore-scripts', pkg] },
  ];
  for (const layout of layouts) {
    await fs.mkdir(layout.bin, { recursive: true });
    const layoutEnv = { ...env, PATH: layout.bin + path.delimiter + env.PATH };
    const installedShim = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '& ' + layout.command.map(psLiteral).join(' ')], layoutEnv, false, isolated.root);
    records.push({ layout: layout.name, install: installedShim }); assert.equal(installedShim.code, 0, installedShim.stderr);
    await fs.access(path.join(layout.bin, 'fate-server.cmd'));
    const delegatedEnv = { ...env, PATH: layout.bin + path.delimiter + env.PATH };
    const query = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '& ' + psLiteral(path.join(layout.bin, 'fate-server.cmd')) + ' --launcher-entry'], delegatedEnv);
    assert.equal(query.code, 0, query.stderr); const metadata = JSON.parse(query.stdout); assert.equal(metadata.version, 1); assert(path.isAbsolute(metadata.entry)); await fs.access(metadata.entry);
    for (const shell of ['cmd', 'powershell']) {
      await fs.rm(capture, { force: true });
      const result = await launch(shell, ['serve', '--profile', 'fixture'], delegatedEnv);
      // This minimal protocol fixture has no SDK runtime dependencies/profile.
      // Its real compiled CLI must be reached, then safely refuse startup.
      records.push({ layout: layout.name, shell, metadata, result });
      assert.equal(result.code, 1); assert.match(result.stderr, /Fate server command failed/u); await assert.rejects(fs.access(capture));
    }
    const noNode = { ...delegatedEnv, PATH: [layout.bin, path.join(env.SYSTEMROOT ?? env.SystemRoot, 'System32'), path.join(env.SYSTEMROOT ?? env.SystemRoot, 'System32/WindowsPowerShell/v1.0')].join(path.delimiter) };
    const missing = await launch('cmd', ['serve', '--profile', 'fixture'], noNode);
    records.push({ layout: layout.name, missingNode: missing }); assert.equal(missing.code, 1); assert.match(missing.stderr, /separate fate-server Node package/u);
  }
  console.log(JSON.stringify({ scope: 'Windows argv and installed companion protocol, not product/package acceptance', node: process.version, binaryHash, records }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ records }, null, 2)); throw error;
} finally { await isolated.cleanup(); }
