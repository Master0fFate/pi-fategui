import { test, type ElectronApplication } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const QUIT_BUDGET_MS = 20_000;
const SETTLE_BUDGET_MS = 10_000;

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const failure = error as { message?: string; stdout?: string; stderr?: string };
    return `${command} failed: ${failure.message ?? String(error)}\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`;
  }
}

/** The application process and its descendants, by executable only (no arguments). */
function processTree(pid: number): string {
  if (process.platform === 'win32') return '';
  const rows = run('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,etime=,comm=']).split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), rest: match[4]! }));
  const family = new Set([pid]);
  for (let grown = true; grown;) {
    grown = false;
    for (const row of rows) {
      if (!family.has(row.pid) && (family.has(row.ppid) || row.pgid === pid)) { family.add(row.pid); grown = true; }
    }
  }
  return rows.filter((row) => family.has(row.pid)).map((row) => `${row.pid} ${row.ppid} ${row.pgid} ${row.rest}`).join('\n');
}

/** Collect the application's own output so a refusal to quit can be explained. */
export function captureOutput(application: ElectronApplication): () => string {
  let output = '';
  const append = (chunk: Buffer | string): void => { output = `${output}${chunk.toString()}`.slice(-200_000); };
  try {
    application.process().stdout?.on('data', append);
    application.process().stderr?.on('data', append);
  } catch { /* The application already exited; the test reports that itself. */ }
  return () => output;
}

/**
 * Close the application. An application that does not quit must not hold the
 * test until its time limit and leave nothing to read: record what its threads
 * are doing, stop it, and fail with that evidence attached.
 */
export async function closeOrExplain(application: ElectronApplication | undefined, output: () => string = () => ''): Promise<void> {
  if (!application) return;
  let child: ReturnType<ElectronApplication['process']>;
  // An application that already exited has no process to read. Never replace the test's own error.
  try { child = application.process(); } catch { return; }
  const closed = application.close().then(() => true, () => true);
  const within = (budget: number): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), budget); });
    return Promise.race([closed, expired]).finally(() => clearTimeout(timer));
  };
  if (await within(QUIT_BUDGET_MS)) return;

  const evidence = [`The application (pid ${child.pid}) did not quit within ${QUIT_BUDGET_MS} ms.`, '', '--- processes (pid ppid pgid stat etime executable) ---'];
  if (child.pid) {
    evidence.push(processTree(child.pid));
    if (process.platform === 'darwin') {
      // The stack of every thread. A hosted runner can need administrator rights to read it.
      // `sample` writes a file. Administrator rights are tried without ever asking for a password.
      const file = test.info().outputPath('application-sample.txt');
      const sampleArguments = [String(child.pid), '3', '-mayDie', '-file', file];
      let report = run('sample', sampleArguments);
      if (!existsSync(file)) report = `${report}\n--- with sudo ---\n${run('sudo', ['-n', 'sample', ...sampleArguments])}`;
      evidence.push('', '--- sample ---', report, existsSync(file) ? readFileSync(file, 'utf8') : '(no sample was written)');
    }
  }
  evidence.push('', '--- application output ---', output());
  await test.info().attach('application-did-not-quit.txt', { body: evidence.join('\n'), contentType: 'text/plain' });
  // Also in the run output: a retry that passes uploads no attachments.
  console.log(evidence.join('\n'));
  child.kill('SIGKILL');
  await within(SETTLE_BUDGET_MS);
  throw new Error(`The application did not quit within ${QUIT_BUDGET_MS} ms. Evidence: application-did-not-quit.txt.`);
}
