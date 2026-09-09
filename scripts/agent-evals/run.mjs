import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cases } from './cases.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const reporter = fileURLToPath(new URL('./reporter.mjs', import.meta.url));

function runSuite(target, workspace, timeout) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    delete environment.NODE_OPTIONS;
    const child = spawn(process.execPath, ['--test', `--test-reporter=${pathToFileURL(reporter).href}`, target], {
      cwd: workspace, env: environment, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let diagnostics = '';
    let terminationReason = null;
    const stop = (reason) => {
      if (terminationReason) return;
      terminationReason = reason;
      if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 2_000 }, () => { if (child.exitCode === null) child.kill('SIGKILL'); });
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const timer = setTimeout(() => stop('timeout'), timeout);
    child.stdout.on('data', (chunk) => { output += chunk.toString(); if (Buffer.byteLength(output) > 1_000_000) { output = output.slice(-64_000); stop('output-limit'); } });
    child.stderr.on('data', (chunk) => { diagnostics += chunk.toString(); if (Buffer.byteLength(diagnostics) > 1_000_000) { diagnostics = diagnostics.slice(-64_000); stop('output-limit'); } });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ output, diagnostics, exitCode: code ?? 1, terminationReason }); });
  });
}
async function readJson(file) {
  if ((await fs.stat(file)).size > 1_000_000) throw new Error('Evaluation metadata exceeds 1 MB.');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
function finiteNonnegative(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite nonnegative number.`);
  return value;
}

export async function evaluate({ caseId, workspace, metricsFile, baselineFile, timeout = 10_000 }) {
  const definition = Object.hasOwn(cases, caseId) ? cases[caseId] : null;
  if (!definition) throw new Error(`Unknown case. Choose ${Object.keys(cases).join(', ')}.`);
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 60_000) throw new Error('Grader timeout must be an integer from 100 to 60000 ms.');
  const solution = path.resolve(workspace, 'solution.mjs');
  if (!(await fs.stat(solution)).isFile()) throw new Error('Workspace must contain solution.mjs.');
  const candidateHash = hash(await fs.readFile(solution));
  const evaluatorHash = hash(await fs.readFile(fileURLToPath(import.meta.url)));
  const suiteHash = hash(definition.tests + await fs.readFile(reporter, 'utf8'));
  const checkNames = [...definition.tests.matchAll(/test\('([^']+)'/gu)].map((match) => match[1]);
  let reported = null;
  if (metricsFile) {
    const metrics = await readJson(metricsFile);
    if (typeof metrics.model !== 'string' || !metrics.model.trim() || typeof metrics.source !== 'string' || !metrics.source.trim()) throw new Error('Metrics require model and source.');
    reported = {
      model: metrics.model.slice(0, 500), source: metrics.source.slice(0, 1_000),
      taskWallTimeMs: finiteNonnegative(metrics.taskWallTimeMs, 'taskWallTimeMs'),
      costUsd: finiteNonnegative(metrics.costUsd, 'costUsd'),
    };
  }
  const baseline = baselineFile ? await readJson(baselineFile) : null;
  if (baselineFile && (!baseline || baseline.version !== 1 || baseline.caseId !== caseId || baseline.caseVersion !== definition.version || baseline.suiteHash !== suiteHash || baseline.evaluatorHash !== evaluatorHash
    || typeof baseline.success !== 'boolean' || !Number.isSafeInteger(baseline.checksPassed) || baseline.checksPassed < 0 || baseline.checksPassed > definition.checks
    || baseline.checksExpected !== definition.checks || baseline.checksFailed !== definition.checks - baseline.checksPassed
    || !Number.isSafeInteger(baseline.checksObserved) || baseline.checksObserved < 0
    || typeof baseline.candidateUnchanged !== 'boolean'
    || baseline.success !== (baseline.candidateUnchanged && baseline.checksPassed === definition.checks && baseline.checksObserved === definition.checks && baseline.exitCode === 0 && baseline.terminationReason === null)
    || !/^[a-f0-9]{64}$/u.test(baseline.candidateHash ?? '') || !Number.isFinite(baseline.gradingWallTimeMs) || baseline.gradingWallTimeMs < 0)) throw new Error('Baseline belongs to a different case/suite or is malformed.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-agent-eval-'));
  const started = performance.now();
  try {
    const suite = `import test from 'node:test';\nimport assert from 'node:assert/strict';\n${definition.tests.replaceAll('__SOLUTION__', pathToFileURL(solution).href)}\n`;
    const target = path.join(directory, 'acceptance.test.mjs');
    await fs.writeFile(target, suite);
    const { output, diagnostics, exitCode, terminationReason } = await runSuite(target, path.resolve(workspace), timeout);
    const events = output.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    const checksPassed = checkNames.filter((name) => events.filter((event) => event.name === name && event.type === 'test:pass').length === 1 && !events.some((event) => event.name === name && event.type === 'test:fail')).length;
    const checksFailed = definition.checks - checksPassed;
    const candidateUnchanged = candidateHash === hash(await fs.readFile(solution));
    const success = candidateUnchanged && exitCode === 0 && terminationReason === null && checksPassed === definition.checks && events.length === definition.checks;
    return {
      version: 1, caseId, caseVersion: definition.version, timestamp: new Date().toISOString(), candidateHash, suiteHash, evaluatorHash, candidateUnchanged, nodeVersion: process.version,
      baselineHash: baseline ? hash(JSON.stringify(baseline)) : null,
      success, checksPassed, checksFailed, checksExpected: definition.checks, checksObserved: events.length,
      gradingWallTimeMs: performance.now() - started, reported, exitCode, terminationReason, timedOut: terminationReason === 'timeout',
      regression: baseline ? baseline.success && !success : null,
      output: `${output}\n${diagnostics}`.slice(-64_000),
      limitations: ['Offline component task, not a live Fate UI/provider run.', 'Task time and provider cost are externally reported, not measured by this grader.', 'Candidate code runs with the invoking account privileges; this is not a sandbox or adversarially tamper-proof grader. Source hashes cover the submitted module, not arbitrary imported dependencies.'],
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!['--case', '--workspace', '--out', '--metrics', '--baseline'].includes(args[index]) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Use prepare|grade --case ID --workspace PATH [--out JSON] [--metrics JSON] [--baseline JSON].');
    options[args[index].slice(2)] = args[index + 1];
  }
  const definition = cases[options.case];
  if (!definition || !options.workspace) throw new Error(`Specify --workspace and --case (${Object.keys(cases).join(', ')}).`);
  if (action === 'prepare') {
    const workspace = path.resolve(options.workspace);
    await fs.mkdir(workspace, { recursive: false });
    await fs.writeFile(path.join(workspace, 'TASK.md'), definition.brief, { flag: 'wx' });
    await fs.writeFile(path.join(workspace, 'solution.mjs'), definition.seed, { flag: 'wx' });
    console.log(`Prepared ${options.case} in ${workspace}. No agent was run.`);
  } else if (action === 'grade') {
    if (!options.out) throw new Error('grade requires --out to retain its evidence.');
    const result = await evaluate({ caseId: options.case, workspace: options.workspace, metricsFile: options.metrics, baselineFile: options.baseline });
    await fs.writeFile(path.resolve(options.out), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    console.log(`${result.success ? 'PASS' : 'FAIL'} ${options.case}: ${result.checksPassed}/${result.checksExpected} checks. Results: ${options.out}`);
    process.exitCode = result.success ? 0 : 1;
  } else throw new Error('Choose prepare or grade.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
