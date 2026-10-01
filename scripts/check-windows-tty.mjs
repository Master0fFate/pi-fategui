import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { createIsolatedEnvironment } from './run-v2-tests.mjs';
assert.equal(process.platform, 'win32', 'Native Windows ConPTY is required.');
const source = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(source, 'package.json'));
const isolated = await createIsolatedEnvironment();
const records = [];
try {
  const bundle = path.join(isolated.root, 'io');
  await build({ configFile: false, logLevel: 'silent', build: { lib: { entry: path.join(source, 'src/cli/providerLogin.ts'), formats: ['es'], fileName: () => 'input.mjs' },
    outDir: bundle, target: 'node22', minify: false, rollupOptions: { external: id => id.startsWith('node:') } } });
  const childFile = path.join(isolated.root, 'tty-child.mjs');
  const resultFile = path.join(isolated.root, 'tty-result.json');
  const expected = 'zażółć hidden';
  await fs.writeFile(childFile, `import {createProviderLoginIo} from ${JSON.stringify(pathToFileURL(path.join(bundle, 'input.mjs')).href)};
import {writeFileSync} from 'node:fs';
const io=createProviderLoginIo(), abort=new AbortController();
const before={raw:Boolean(process.stdin.isRaw),flowing:process.stdin.readableFlowing===true,data:process.stdin.listenerCount('data'),end:process.stdin.listenerCount('end')};
let canceled=false, correct=false;
try {const pending=io.readPrivate('Private synthetic fixture input only.',abort.signal); console.log('FATE_TTY_INPUT_READY'); const value=await pending; correct=value===${JSON.stringify(expected)};}
catch(error){canceled=error.message==='Provider login canceled.';}
const result={pid:process.pid,interactive:io.interactive,correct,canceled,rawRestored:Boolean(process.stdin.isRaw)===before.raw,flowRestored:(process.stdin.readableFlowing===true)===before.flowing,dataListenersRestored:process.stdin.listenerCount('data')===before.data,endListenersRestored:process.stdin.listenerCount('end')===before.end};
writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(result));console.log('FATE_TTY_DONE');
`);
  const pty = require('node-pty');
  for (const test of [{ name: 'unicode-and-backspace-hidden', input: 'zażółć hiddenX\b\r', canceled: false }, { name: 'ctrl-c-restores-terminal', input: '\x03', canceled: true }]) {
    await fs.rm(resultFile, { force: true });
    const child = pty.spawn(process.execPath, [childFile], { cwd: isolated.root, env: isolated.env, cols: 100, rows: 30 });
    let output = '', sent = false;
    const subscriptions = [];
    let result;
    try { result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Owned ConPTY fixture did not settle.')); }, 15_000);
      subscriptions.push(child.onData(bytes => {
        output += bytes;
        if (output.length > 32_768) { clearTimeout(timer); child.kill(); reject(new Error('Oversized ConPTY fixture output.')); }
        if (!sent && output.includes('FATE_TTY_INPUT_READY')) { sent = true; child.write(test.input); }
      }));
      subscriptions.push(child.onExit(exit => { clearTimeout(timer); resolve(exit); }));
    }); } finally {
      for (const subscription of subscriptions) subscription.dispose();
      // onExit reports the inner process, not disposal of the allocated ConPTY
      // handle/worker. Public kill releases that owned terminal's resources.
      child.kill();
    }
    assert.equal(result.exitCode, 0); assert(sent);
    const plainOutput = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '');
    assert(!plainOutput.includes(expected), 'Synthetic hidden input was echoed.');
    // ConPTY rewrites long stdout rows with VT cursor sequences. The private
    // result file preserves exact child observations without scraping a screen.
    const observation = JSON.parse(await fs.readFile(resultFile, 'utf8'));
    assert.equal(observation.pid, child.pid); assert.equal(observation.interactive, true);
    assert.equal(observation.canceled, test.canceled); assert.equal(observation.correct, !test.canceled);
    for (const property of ['rawRestored', 'flowRestored', 'dataListenersRestored', 'endListenersRestored']) assert.equal(observation[property], true, property);
    records.push({ name: test.name, pid: child.pid, exitCode: result.exitCode, outputBytes: Buffer.byteLength(output), hidden: true, observation });
  }
  console.log(JSON.stringify({ scope: 'actual native Windows ConPTY hidden input and Ctrl+C, no provider login', node: process.version, abi: process.versions.modules, records }, null, 2));
} finally { await isolated.cleanup(); }
