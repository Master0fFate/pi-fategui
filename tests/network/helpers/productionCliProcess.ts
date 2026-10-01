import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { constants as osConstants } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const sourceRoot = path.resolve(import.meta.dirname, '../../..');
const guard = pathToFileURL(path.join(sourceRoot, 'tests/network/loopbackGuard.mjs')).href;
let ownedBuild: string | undefined;
let entryPromise: Promise<{ entry: string; sha256: string }> | undefined;
const retainedHomes = new Set<string>();
export const mustRetainCliFixture = (root: string): boolean => [...retainedHomes].some(home => home === root || home.startsWith(root + path.sep));

/** Real production CLI configuration, not an injected CLI replacement. */
export async function productionCliEntry(): Promise<{ entry: string; sha256: string }> {
  entryPromise ??= (async () => {
    if (!process.env.FATE_V2_TEST_ROOT) throw new Error('Private network environment required.');
    const builds = path.join(sourceRoot, 'tests/network/.built');
    await fs.mkdir(builds, { recursive: true });
    ownedBuild = await fs.mkdtemp(path.join(builds, 'actual-cli-'));
    const { build } = await import('vite');
    await build({ configFile: path.join(sourceRoot, 'vite.cli.config.ts'), configLoader: 'runner', logLevel: 'error',
      build: { outDir: ownedBuild, emptyOutDir: false } });
    const entry = path.join(ownedBuild, 'main.js');
    return { entry, sha256: createHash('sha256').update(await fs.readFile(entry)).digest('hex') };
  })();
  return entryPromise;
}
export async function disposeProductionCliBuild(): Promise<void> {
  if (ownedBuild && retainedHomes.size === 0) await fs.rm(ownedBuild, { recursive: true, force: true, maxRetries: 3 });
  ownedBuild = undefined; entryPromise = undefined;
}
export interface CliProcessResult {
  readonly pid: number;
  readonly exitCode: number;
  readonly signal: string | number | null;
  readonly output: string;
  readonly entrySha256: string;
  readonly nativeTerminal: boolean;
}
const fixtureEnvironment = (home: string): NodeJS.ProcessEnv => ({ ...process.env, HOME: home, USERPROFILE: home });
export async function assertPrivateCliHome(home: string): Promise<string> {
  const root = process.env.FATE_V2_TEST_ROOT;
  if (!root || !path.isAbsolute(root) || !path.isAbsolute(home)) throw new Error('Explicit private CLI home required.');
  const canonicalRoot = await fs.realpath(root), canonicalHome = await fs.realpath(home);
  const relative = path.relative(canonicalRoot, canonicalHome);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('CLI home escapes the private fixture.');
  return canonicalHome;
}
export interface CliFixtureOwnership {
  readonly id: string;
  readonly marker: string;
  readonly guardRoot: string;
  update(fields: { wrapperPid?: number | null; actualCliPid?: number | null }): Promise<void>;
  verifyNative(receipt: NativeReceipt, wrapperPid: number | undefined): Promise<void>;
  release(): Promise<void>;
}
/** Publish before any spawn. An unknown exit never depends on a late marker write. */
export async function acquireCliFixtureOwnership(home: string, compiled: { entry: string; sha256: string }): Promise<CliFixtureOwnership> {
  home = await assertPrivateCliHome(home);
  const marker = path.join(process.env.FATE_V2_TEST_ROOT!, '.fate-retained-owned-work.json');
  const id = randomUUID();
  const initial = { id, status: 'pending-cli', home, entry: compiled.entry, entrySha256: compiled.sha256,
    wrapperPid: null, actualCliPid: null };
  // A separate prepublished guard survives loss/corruption of the mutable
  // marker. The runner also retains on a failed/unconfirmed suite outcome.
  const guardRoot = path.join(process.env.FATE_V2_TEST_ROOT!, '.fate-owned-cli-guard');
  await fs.mkdir(guardRoot, { mode: 0o700 });
  try {
    await fs.writeFile(path.join(guardRoot, 'owner.json'), JSON.stringify(initial), { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(guardRoot, 'state.json'), JSON.stringify(initial), { flag: 'wx', mode: 0o600 });
    await fs.writeFile(marker, JSON.stringify(initial), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    // No spawn can occur before acquisition returns; remove only this new guard.
    await fs.rm(guardRoot, { recursive: true, force: true, maxRetries: 3 }); throw error;
  }
  const identity = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object'
    && 'id' in value && value.id === id && 'home' in value && value.home === home
    && 'entry' in value && value.entry === compiled.entry && 'entrySha256' in value && value.entrySha256 === compiled.sha256
    && 'status' in value && value.status === 'pending-cli');
  const current = async () => {
    const owner: unknown = JSON.parse(await fs.readFile(path.join(guardRoot, 'owner.json'), 'utf8'));
    const value: unknown = JSON.parse(await fs.readFile(marker, 'utf8'));
    const state: unknown = JSON.parse(await fs.readFile(path.join(guardRoot, 'state.json'), 'utf8'));
    if (!identity(owner) || !identity(value) || !identity(state)
      || value.wrapperPid !== state.wrapperPid || value.actualCliPid !== state.actualCliPid) throw new Error('Owned CLI identity changed; fixture must remain.');
    return value;
  };
  const atomic = async (file: string, value: unknown) => {
    const temporary = file + '.' + id + '.tmp';
    try { await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
  };
  return { id, marker, guardRoot,
    async update(fields) {
      if (Object.entries(fields).some(([key, value]) => !['wrapperPid', 'actualCliPid'].includes(key)
        || !(value === null || typeof value === 'number' && Number.isSafeInteger(value) && value > 0))) throw new Error('Invalid owned CLI PID update.');
      const value = { ...await current(), ...fields };
      await atomic(marker, value); await atomic(path.join(guardRoot, 'state.json'), value);
    },
    async verifyNative(receipt, wrapperPid) {
      const value = await current();
      if (receipt.ownershipId !== id || receipt.entrySha256 !== compiled.sha256 || wrapperPid === undefined
        || value.wrapperPid !== wrapperPid || value.actualCliPid !== receipt.pid) throw new Error('Actual CLI receipt does not match published ownership.');
    },
    async release() {
      await current(); await fs.unlink(marker);
      await fs.unlink(path.join(guardRoot, 'state.json')); await fs.unlink(path.join(guardRoot, 'owner.json'));
      await fs.rmdir(guardRoot); // Unknown extra contents are not force-deleted.
    },
  };
}
const retainFixture = (home: string) => { retainedHomes.add(home); };
async function observeCli(value: unknown): Promise<void> {
  const root = process.env.FATE_V2_TEST_ROOT;
  if (!root) throw new Error('Private CLI observation root required.');
  const record = JSON.stringify(value);
  console.log(record);
  // Raw output belongs to synthetic PRIVATE evidence, not an operator log.
  // The owning runner emits these receipts after Vitest can hide passing output.
  await fs.appendFile(path.join(root, 'actual-cli-observations.jsonl'), record + '\n', { mode: 0o600 });
}
export interface NativeReceipt {
  pid: number; exitCode: number | null; signal: string | number | null; output: string;
  incomplete: boolean; teardownConfirmed: boolean; failure: string | null;
  ownershipId: string; entrySha256: string;
}
const signalNumbers = new Set<number>(Object.values(osConstants.signals));
const validSignal = (value: unknown) => value === null || value === 0
  || typeof value === 'string' && Object.hasOwn(osConstants.signals, value)
  || typeof value === 'number' && Number.isSafeInteger(value) && signalNumbers.has(value);
export const isSignaledCliReceipt = (value: Pick<NativeReceipt, 'signal'>): boolean => value.signal !== null && value.signal !== 0;
export function parseNativeCliReceipt(stdout: string): NativeReceipt {
  const value: unknown = JSON.parse(stdout);
  if (!value || typeof value !== 'object' || !('pid' in value) || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid < 1
    || !('output' in value) || typeof value.output !== 'string' || Buffer.byteLength(value.output) > 512 * 1024
    || !('exitCode' in value) || !(value.exitCode === null || typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode) && value.exitCode >= 0)
    || !('incomplete' in value) || typeof value.incomplete !== 'boolean'
    || !('teardownConfirmed' in value) || typeof value.teardownConfirmed !== 'boolean'
    || !('failure' in value) || !(value.failure === null || typeof value.failure === 'string')
    || !('signal' in value) || !validSignal(value.signal)
    || !('ownershipId' in value) || typeof value.ownershipId !== 'string' || !/^[0-9a-f-]{36}$/u.test(value.ownershipId)
    || !('entrySha256' in value) || typeof value.entrySha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.entrySha256)) throw new Error('Invalid native CLI observation.');
  return value as NativeReceipt;
}
function stopOwned(child: ReturnType<typeof spawn>): void { try { child.kill(); } catch { /* No exit claim: pending marker already retains the fixture. */ } }

/** Credential-free driver owns ConPTY pipes; the actual CLI keeps the unchanged network guard. */
export async function runTerminalCli(home: string, argv: readonly string[], input?: { marker: string; value: string }): Promise<CliProcessResult> {
  const compiled = await productionCliEntry();
  const ownership = await acquireCliFixtureOwnership(home, compiled);
  let driver: ReturnType<typeof spawn> | undefined, released = false;
  try {
    driver = spawn(process.execPath, [path.join(sourceRoot, 'tests/network/helpers/nativeCliPtyDriver.mjs')], {
      cwd: sourceRoot, env: fixtureEnvironment(home), shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const child = driver;
    let stdout = '', stderr = '', outputFailure: Error | undefined;
    child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8');
    const append = (kind: 'stdout' | 'stderr', bytes: string) => {
      if (kind === 'stdout') stdout += bytes; else stderr += bytes;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 2 * 1024 * 1024) { outputFailure ??= new Error('Native driver output exceeds the bound.'); stopOwned(child); }
    };
    child.stdout!.on('data', (bytes: string) => append('stdout', bytes)); child.stderr!.on('data', (bytes: string) => append('stderr', bytes));
    child.stdin!.on('error', () => { outputFailure ??= new Error('Owned driver input failed.'); stopOwned(child); });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const retained = setTimeout(() => { stopOwned(child); reject(new Error(`Native driver PID ${child.pid} exit unconfirmed; fixture retained.`)); }, 43_000);
      child.once('error', error => { clearTimeout(retained); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(retained); resolve({ code, signal }); });
    });
    void closed.catch(() => undefined);
    await ownership.update({ wrapperPid: child.pid ?? null });
    child.stdin!.end(JSON.stringify({ entry: compiled.entry, entrySha256: compiled.sha256, argv, input, ownershipId: ownership.id })); // private stdin, never secret argv
    const outer = await closed;
    const receipt = parseNativeCliReceipt(stdout);
    await observeCli({ nativeCliObservation: receipt, driverPid: child.pid, driverExitCode: outer.code, driverSignal: outer.signal, entrySha256: compiled.sha256 });
    await ownership.verifyNative(receipt, child.pid);
    if (receipt.incomplete || receipt.exitCode === null || !receipt.teardownConfirmed) throw new Error('Actual native CLI exit/teardown unconfirmed; fixture retained.');
    await ownership.release(); released = true; // validated actual exit identity AND wrapper close/teardown
    if (isSignaledCliReceipt(receipt)) throw new Error('Actual native CLI terminated by signal, not a normal exit.');
    if (outer.code !== 0 || outer.signal !== null || receipt.failure || outputFailure) throw new Error(`Actual native CLI failed its bounded driver check: ${receipt.failure ?? outputFailure?.message ?? 'driver failure'}`);
    return { pid: receipt.pid, exitCode: receipt.exitCode, signal: receipt.signal, output: receipt.output, entrySha256: compiled.sha256, nativeTerminal: true };
  } catch (error) {
    // Explicit release is proof; ENOENT is not. The independent guard and
    // failed-suite runner policy retain even when the mutable marker is lost.
    if (!released) retainFixture(home);
    if (driver && driver.exitCode === null && driver.signalCode === null) stopOwned(driver);
    throw error;
  }
}

export async function runNoninteractiveCli(home: string, argv: readonly string[]): Promise<CliProcessResult> {
  const compiled = await productionCliEntry();
  const ownership = await acquireCliFixtureOwnership(home, compiled);
  let child: ReturnType<typeof spawn> | undefined, released = false;
  try {
    child = spawn(process.execPath, ['--import', guard, compiled.entry, ...argv], {
      cwd: sourceRoot, env: fixtureEnvironment(home), shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const actual = child;
    let output = '', failure: Error | undefined;
    const append = (bytes: string) => { output += bytes; if (Buffer.byteLength(output) > 512 * 1024) { failure ??= new Error('Oversized CLI output.'); stopOwned(actual); } };
    actual.stdout!.setEncoding('utf8'); actual.stderr!.setEncoding('utf8');
    actual.stdout!.on('data', append); actual.stderr!.on('data', append);
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const deadline = setTimeout(() => { failure ??= new Error('Owned CLI exceeded its 30-second bound.'); stopOwned(actual); }, 30_000);
      const retained = setTimeout(() => { stopOwned(actual); reject(new Error(`CLI PID ${actual.pid} exit unconfirmed; fixture retained.`)); }, 35_000);
      actual.once('error', error => { clearTimeout(deadline); clearTimeout(retained); reject(error); });
      actual.once('close', (code, signal) => { clearTimeout(deadline); clearTimeout(retained); resolve({ code, signal }); });
    });
    void closed.catch(() => undefined);
    await ownership.update({ actualCliPid: actual.pid ?? null });
    const { code, signal } = await closed;
    await observeCli({ cliProcessObservation: { pid: actual.pid, code, signal, output, entrySha256: compiled.sha256 }, failure: failure?.message ?? null });
    if (actual.pid === undefined || code === null && signal === null) throw new Error('Actual CLI exit unconfirmed; fixture retained.');
    await ownership.release(); released = true;
    if (failure) throw failure;
    if (code === null || signal !== null) throw new Error('Actual CLI terminated by signal, not a normal exit.');
    return { pid: actual.pid, exitCode: code, signal, output, entrySha256: compiled.sha256, nativeTerminal: false };
  } catch (error) {
    if (!released) retainFixture(home);
    if (child && child.exitCode === null && child.signalCode === null) stopOwned(child);
    throw error;
  }
}
export function plainTerminalOutput(output: string): string {
  return output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, '');
}
export function recordCliResult(name: string, result: CliProcessResult, secrets: readonly string[]): void {
  if (secrets.some(secret => secret && plainTerminalOutput(result.output).includes(secret))) throw new Error('Synthetic private input escaped into terminal output.');
  console.log(JSON.stringify({ nativeCliCase: name, ...result, outputBytes: Buffer.byteLength(result.output), fixtureOnly: true,
    scope: 'Real CLI/HTTP/ACL/terminal; deterministic test-only SDK login, no provider network or SSH acceptance.' }));
}
