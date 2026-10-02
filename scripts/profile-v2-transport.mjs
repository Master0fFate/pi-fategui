import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write('Usage: node scripts/profile-v2-transport.mjs [--runs 1..5]\nRuns isolated synthetic event/snapshot/monitor fixtures; prints measured JSON. No providers, native desktop, SSH or package builds.\n');
} else {
  const runs = args.length === 0 ? 3 : args.length === 2 && args[0] === '--runs' && /^[1-5]$/u.test(args[1]) ? Number(args[1]) : null;
  if (runs === null) throw new Error('Expected --runs followed by an integer from 1 through 5.');
  const observations = [];
  const receipts = [];
  for (let run = 1; run <= runs; run++) {
    const command = [path.join(root, 'scripts/run-v2-tests.mjs'), 'tests/v2/loadLimits.test.ts', '--maxWorkers', '1'];
    const startedAt = new Date().toISOString();
    const child = spawn(process.execPath, command, { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    process.stderr.write(`Transport fixture ${run}/${runs}, owned PID ${child.pid ?? 'not-started'}\n`);
    let stdout = '', stderr = '', overflow = false;
    const capture = (which, chunk) => {
      if (overflow) return;
      const text = chunk.toString('utf8');
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + Buffer.byteLength(text) > 4 * 1024 * 1024) {
        overflow = true; child.kill('SIGTERM'); return;
      }
      if (which === 'stdout') stdout += text; else stderr += text;
    };
    child.stdout.on('data', (chunk) => capture('stdout', chunk));
    child.stderr.on('data', (chunk) => capture('stderr', chunk));
    const forward = (signal) => child.kill(signal);
    const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    let result;
    try { result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }); }
    finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
    receipts.push({ run, command: [process.execPath, ...command], startedAt, finishedAt: new Date().toISOString(), pid: child.pid, ...result });
    if (overflow || result.code !== 0 || result.signal !== null) {
      process.stderr.write(stdout + stderr);
      process.stdout.write(JSON.stringify({ status: 'failed', receipts, completedObservations: observations, overflow }, null, 2) + '\n');
      process.exitCode = 1;
      break;
    }
    const found = [...stdout.matchAll(/^FATE_TRANSPORT_PROFILE (\{[^\n]*\})$/gmu)].map((match) => JSON.parse(match[1]));
    if (found.length !== 3 || found.map((item) => item.case).sort().join(',') !== 'events,monitor,snapshots'
      || found.some((item) => item.seed !== 0x46415445 || !Number.isFinite(item.elapsedMs) || item.elapsedMs < 0)) {
      throw new Error('The fixture did not return all three validated measurement records.');
    }
    observations.push(...found.map((item) => ({ run, ...item })));
  }
  if (!process.exitCode) {
    const ranges = Object.fromEntries(['events', 'snapshots', 'monitor'].map((name) => {
      const samples = observations.filter((item) => item.case === name).map((item) => item.elapsedMs).sort((a, b) => a - b);
      return [name, { samples: samples.length, minimumMs: samples[0], medianMs: samples[Math.floor(samples.length / 2)], maximumMs: samples.at(-1) }];
    }));
    process.stdout.write(JSON.stringify({ status: 'passed', fixtureVersion: 1, seed: 0x46415445,
      environment: { node: process.version, platform: process.platform, architecture: process.arch, cpus: os.cpus().length,
        cpuModel: os.cpus()[0]?.model ?? 'unknown', memoryBytes: os.totalmem() }, receipts, observations, ranges,
      limitations: ['Synthetic in-process transport buffers, not native desktop or real SSH acceptance.',
        'Event stress uses stricter explicit limits; production limits are reported separately.',
        'Monitor projection measures 15-second logical poll times without sleeping and does not invoke a provider.',
        'Timing samples are descriptive on this machine and are not a cross-product performance comparison.'] }, null, 2) + '\n');
  }
}
