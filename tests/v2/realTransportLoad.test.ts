import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { privateTestRoot, isWithin } from './helpers/isolatedEnvironment';

const receiptSchema = z.object({
  type: z.literal('real-transport-load-result'), mode: z.enum(['disabled', 'load']),
  ok: z.boolean(), cleanupConfirmed: z.boolean(), failure: z.string().nullable(),
  metrics: z.record(z.string(), z.unknown()),
}).strict();

// This child has its own loopback-only guard, private HOME and bounded lifetime.
// Neither the v2 worker's all-network deny policy nor its environment is changed.
async function runFixture(mode: 'disabled' | 'load') {
  const privateRoot = privateTestRoot();
  if (!isWithin(privateRoot, os.tmpdir())) throw new Error('Temporary directory is not isolated.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'fate-v2-real-load-'));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && /^(SYSTEMROOT|WINDIR|PATH|PATHEXT|LANG|LC_ALL|CI|NO_COLOR|FORCE_COLOR)$/iu.test(key)) env[key] = value;
  }
  const locations = { HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata',
    XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state',
    XDG_RUNTIME_DIR: 'runtime', PI_CODING_AGENT_DIR: 'pi/agent', FATE_GUI_DATA_DIR: 'fate', TMP: 'tmp', TEMP: 'tmp', TMPDIR: 'tmp' };
  for (const [key, relative] of Object.entries(locations)) {
    env[key] = path.join(root, relative);
    await mkdir(env[key]!, { recursive: true, mode: 0o700 });
  }
  Object.assign(env, { FATE_V2_TEST_ROOT: root, PI_OFFLINE: '1', NODE_ENV: 'test', TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-gitconfig'), GIT_TERMINAL_PROMPT: '0' });
  const marker = path.join(root, '.fate-retained-owned-work.json');
  await writeFile(marker, JSON.stringify({ fixture: 'T51-real-transport', state: 'pending', mode }), { mode: 0o600 });
  const workerStarted = performance.now();
  const child = spawn(process.execPath, [path.resolve('tests/v2/helpers/realTransportLoadBootstrap.mjs'), mode], {
    cwd: process.cwd(), env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let receipt: z.infer<typeof receiptSchema> | undefined;
  let output = '', errors = '', harnessFailure: string | undefined;
  let forced: ReturnType<typeof setTimeout> | undefined;
  const abort = (reason: string) => {
    if (harnessFailure) return;
    harnessFailure = reason;
    if (child.connected) child.send({ type: 'abort-real-transport-load' });
    // Only this owned worker PID. Unconfirmed PTY ownership remains in the
    // private marker; never taskkill a tree or delete an uncertain fixture.
    forced = setTimeout(() => { child.kill(); }, 5_000);
  };
  const deadline = setTimeout(() => abort('Fixture exceeded its 65-second setup/load/cleanup budget.'), 65_000);
  child.stdout?.on('data', (bytes: Buffer) => {
    if (Buffer.byteLength(output) + bytes.length > 64 * 1024) abort('Bounded stdout capture exceeded.');
    else output += bytes.toString('utf8');
  });
  child.stderr?.on('data', (bytes: Buffer) => {
    if (Buffer.byteLength(errors) + bytes.length > 64 * 1024) abort('Bounded stderr capture exceeded.');
    else errors += bytes.toString('utf8');
  });
  child.on('message', (value: unknown) => {
    const parsed = receiptSchema.safeParse(value);
    if (!parsed.success || receipt) { abort('Invalid or duplicate fixture receipt.'); return; }
    receipt = parsed.data;
  });
  let code: number | null = null;
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve); // Also waits for the owned stdout/stderr descriptors.
    });
    await writeFile(path.join(root, 'worker-output.log'), output + errors, { mode: 0o600 });
    expect(harnessFailure).toBeUndefined();
    expect(receipt, `No receipt (exit ${code}); ${errors.slice(-2000)}`).toBeDefined();
    expect(receipt!.mode).toBe(mode);
    console.info(`FATE_REAL_TRANSPORT_PROFILE ${JSON.stringify({ ...receipt, workerProcessElapsedMs: performance.now() - workerStarted })}`);
    expect(receipt!.cleanupConfirmed, receipt!.failure ?? 'Unconfirmed cleanup').toBe(true);
    expect(receipt!.ok, receipt!.failure ?? errors.slice(-2000)).toBe(true);
    expect(code).toBe(0);
    // Native I/O now has a separate owned driver. Require actual positive
    // native/driver PIDs, a verified native exit and a clean driver join, not a
    // host proxy allocation, kill request or generic wrapper close.
    const nativeProof = z.object({
      nativePortTeardownConfirmed: z.literal(true),
      hostNativeResolutions: z.object({ addon: z.literal(0), metadata: z.number().int().nonnegative() }).strict(),
      nativePortFinalObservations: z.array(z.object({
        driverPid: z.number().int().positive(), ptyPid: z.number().int().positive(), nativeExitCode: z.number().int(),
        driverClosed: z.literal(true), driverExitCode: z.literal(0), driverSignal: z.null(),
        driverForceKillRequested: z.literal(false), teardownConfirmed: z.literal(true), failure: z.null(),
      }).passthrough()),
    }).passthrough().parse(receipt!.metrics);
    expect(nativeProof.nativePortFinalObservations).toHaveLength(mode === 'load' ? 1 : 0);
    expect(nativeProof.hostNativeResolutions.metadata).toBe(mode === 'load' ? 1 : 0);
    // Require the worker's actual clean-ownership receipt, not only a happy exit.
    const ledger = z.object({ state: z.literal('settled'), nativeLive: z.literal(0), nativeDriversLive: z.literal(0),
      nativePortTeardownConfirmed: z.literal(true) }).passthrough().parse(JSON.parse(await readFile(marker, 'utf8')) as unknown);
    expect(ledger.nativeLive).toBe(0);
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  } finally {
    clearTimeout(deadline); if (forced) clearTimeout(forced);
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({ type: 'abort-real-transport-load' });
      // A startup error cannot authorize deleting a still-running child's root.
    }
    if (code !== 0 || !receipt?.ok || !receipt.cleanupConfirmed) {
      console.error(`T51 fixture retained for review: ${root}`);
    }
  }
}

describe('T51 sustained real loopback/native PTY load (no provider)', () => {
  it('refuses a disabled manual terminal over a real socket without resolving node-pty', async () => {
    await runFixture('disabled');
  }, 75_000);

  it('bounds real slow-consumer sockets for 8s and a native shell for 4s, with scoped progress and owned teardown', async () => {
    await runFixture('load');
  }, 75_000);
});
