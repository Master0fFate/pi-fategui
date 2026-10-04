import { ChildProcess, type ForkOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativePtyPort, nativePtyEnvironment, parseNativePtyReply, type NativePtyPort } from './helpers/nativePtyPort';
import { privateTestRoot } from './helpers/isolatedEnvironment';

const f = vi.hoisted(() => ({ fork: vi.fn<(file: string, args: readonly string[], options: ForkOptions) => ChildProcess>() }));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), fork: f.fork }));
vi.mock('../../src/core/storage/WindowsPrivateAcl', () => ({ assertPrivateWindowsAcls: async () => undefined }));

const ports: NativePtyPort[] = [], roots: string[] = [];
const drivers: Array<{ child: ChildProcess; close: (code: number | null, signal?: NodeJS.Signals | null) => void }> = [];
const ledgerSchema = z.object({ id: z.string().uuid(), driverPid: z.number(), root: z.string(), home: z.string() }).passthrough();
function driver() {
  const child = new ChildProcess();
  let connected = true, closed = false;
  const frames: unknown[] = [];
  const send = vi.fn((value: string, callback?: (error: Error | null) => void) => {
    frames.push(JSON.parse(value)); callback?.(null); return true;
  });
  Object.defineProperties(child, { pid: { value: 42_420 }, connected: { get: () => connected },
    send: { value: send }, disconnect: { value: () => { connected = false; } } });
  child.kill = vi.fn(() => true); child.unref = vi.fn();
  const close = (code: number | null, signal: NodeJS.Signals | null = null) => {
    if (closed) return; closed = true; connected = false;
    child.emit('close', code, signal);
  };
  drivers.push({ child, close }); f.fork.mockReturnValueOnce(child);
  return { child, frames, send, close };
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(privateTestRoot(), 'native-pty-port-unit-')); roots.push(root);
  const cwd = path.join(root, 'workspace'); await fs.mkdir(cwd, { mode: 0o700 });
  const port = await createNativePtyPort({ sourceRoot: process.cwd(), cwdRoots: [cwd] }); ports.push(port);
  return { port, cwd, pty: await port.loadPty() };
}
async function record() {
  const file = f.fork.mock.calls.at(-1)?.[2].env?.FATE_NATIVE_PTY_RECORD;
  if (!file) throw new Error('No owned fake driver record.');
  return { file, value: ledgerSchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))) };
}
async function started(child: ChildProcess) {
  const { file, value } = await record();
  await fs.writeFile(file, JSON.stringify({ ...value, status: 'running', ptyPid: 51_230 }));
  child.emit('message', JSON.stringify({ type: 'started', id: value.id, driverPid: value.driverPid, ptyPid: 51_230 }));
  return { file, value };
}
async function exited(child: ChildProcess, change: Record<string, unknown> = {}) {
  const { file, value } = await record();
  const receipt = { type: 'exit', id: value.id, driverPid: value.driverPid, ptyPid: 51_230,
    exitCode: 0, signal: null, killRequested: true, killCalls: 1, teardownConfirmed: true };
  await fs.writeFile(file, JSON.stringify({ ...value, status: 'exited', ptyPid: receipt.ptyPid,
    exitCode: 0, signal: null, killRequested: true, killCalls: 1, teardownConfirmed: true, ...change }));
  child.emit('message', JSON.stringify(receipt));
}
beforeEach(() => { vi.clearAllMocks(); });
afterEach(async () => {
  // These ChildProcess objects NEVER spawn. Cleanup of their intentionally
  // corrupted ledgers is permitted only in this unit fault-injection suite.
  for (const item of drivers.splice(0)) item.close(null, 'SIGKILL');
  for (const port of ports.splice(0)) { await port.dispose().catch(() => undefined); await fs.rm(port.root, { recursive: true, force: true }); }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs(); vi.useRealTimers();
});

describe('owned native PTY port (unit ownership/protocol tests, not native evidence)', () => {
  it('does not inherit secrets, guard flags, user PATH or shell startup hooks', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'SYNTHETIC_DO_NOT_INHERIT'); vi.stubEnv('NODE_OPTIONS', '--import private-hook');
    vi.stubEnv('BASH_ENV', 'private-rc'); vi.stubEnv('ENV', 'private-rc'); vi.stubEnv('SSH_AUTH_SOCK', 'private-agent');
    const env = nativePtyEnvironment('/private', '/private/home', process.execPath);
    expect(env).not.toHaveProperty('OPENAI_API_KEY'); expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env).not.toHaveProperty('BASH_ENV'); expect(env).not.toHaveProperty('ENV'); expect(env).not.toHaveProperty('SSH_AUTH_SOCK');
    expect(env.HOME).toBe('/private/home');
    const item = await fixture(); const d = driver();
    item.pty.spawn(item.port.shell, [], { cwd: item.cwd, cols: 80, rows: 24, env: { OPENAI_API_KEY: 'SYNTHETIC_DO_NOT_INHERIT' } });
    const [entry, args, options] = f.fork.mock.calls[0]!;
    expect(entry).toBe(path.join(process.cwd(), 'tests/v2/helpers/nativePtyDriver.mjs'));
    expect(args).toEqual([]); expect(options.execArgv).toEqual([]); expect(options.serialization).toBe('json');
    expect(options.cwd).toBe(item.port.root); expect(options.env?.HOME).toBe(path.join(item.port.root, 'home'));
    expect(options.env).not.toHaveProperty('OPENAI_API_KEY'); expect(options.env).not.toHaveProperty('NODE_OPTIONS');
    expect(await fs.readFile(path.join(item.port.root, '.fate-retained-owned-work.json'), 'utf8')).toContain('pending-native-pty');
    expect(d.frames).toEqual([{ type: 'start', cols: 80, rows: 24 }]);
    await started(d.child); await item.port.waitForStarts();
    const disposed = item.port.dispose(); await exited(d.child); d.close(0);
    expect((await disposed)[0]).toMatchObject({ ptyPid: 51_230, driverPid: 42_420, nativeExitCode: 0,
      killRequested: true, driverClosed: true, teardownConfirmed: true, driverForceKillRequested: false });
    await expect(fs.stat(item.port.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform !== 'win32')('accepts Windows case aliases of the same canonical system shell and private cwd', async () => {
    const item = await fixture(), d = driver();
    item.pty.spawn(item.port.shell.toUpperCase(), ['/d'], { cwd: item.cwd.toUpperCase(), cols: 80, rows: 24 });
    await started(d.child); await item.port.waitForStarts();
    const disposal = item.port.dispose(); await exited(d.child); d.close(0);
    expect((await disposal)[0]?.teardownConfirmed).toBe(true);
  });

  it('rejects arbitrary programs/argv/cwd and malformed sizes before forking', async () => {
    const item = await fixture();
    expect(() => item.pty.spawn(process.execPath, [], { cwd: item.cwd, cols: 80, rows: 24 })).toThrow('arbitrary');
    expect(() => item.pty.spawn(item.port.shell, ['-c', 'not allowed'], { cwd: item.cwd, cols: 80, rows: 24 })).toThrow('arbitrary');
    for (const args of [['/D'], ['/q'], ['/d', '/q'], '/d']) {
      expect(() => item.pty.spawn(item.port.shell, args, { cwd: item.cwd, cols: 80, rows: 24 })).toThrow('arbitrary');
    }
    expect(() => item.pty.spawn(item.port.shell, [], { cwd: process.cwd(), cols: 80, rows: 24 })).toThrow('arbitrary');
    expect(() => item.pty.spawn(item.port.shell, [], { cwd: item.cwd, cols: 401, rows: 24 })).toThrow();
    expect(f.fork).not.toHaveBeenCalled(); await item.port.dispose();
  });

  it('accepts exactly the production /d argument only for the fixed Windows cmd shell', async () => {
    const item = await fixture();
    if (process.platform !== 'win32') {
      expect(() => item.pty.spawn(item.port.shell, ['/d'], { cwd: item.cwd, cols: 80, rows: 24 })).toThrow('arbitrary');
      expect(f.fork).not.toHaveBeenCalled(); await item.port.dispose(); return;
    }
    const d = driver();
    item.pty.spawn(item.port.shell, ['/d'], { cwd: item.cwd, cols: 80, rows: 24, env: { NODE_OPTIONS: 'DO_NOT_INHERIT' } });
    expect(f.fork.mock.calls[0]?.[1]).toEqual([]); // Never forward caller argv to the driver.
    expect(f.fork.mock.calls[0]?.[2].env).not.toHaveProperty('NODE_OPTIONS');
    await started(d.child); await item.port.waitForStarts();
    const disposed = item.port.dispose(); await exited(d.child); d.close(0); await disposed;
  });

  it('maps real-port operations and acknowledges ordered delivery to TerminalOwner, not browser consumption', async () => {
    const item = await fixture(), d = driver();
    const terminal = item.pty.spawn(item.port.shell, [], { cwd: item.cwd, cols: 80, rows: 24 });
    const { value } = await started(d.child); await item.port.waitForStarts();
    const seen: string[] = []; terminal.onData(data => seen.push(data));
    const onExit = vi.fn(); terminal.onExit(onExit);
    d.child.emit('message', JSON.stringify({ type: 'data', id: value.id, sequence: 1, data: '😀' }));
    expect(seen).toEqual(['😀']); expect(d.frames.at(-1)).toEqual({ type: 'consume', sequence: 1, characters: 2 });
    terminal.write('echo fixture\r'); terminal.resize(90, 20); terminal.pause(); terminal.resume(); terminal.clear();
    expect(d.frames.slice(-5)).toEqual([{ type: 'write', data: 'echo fixture\r' }, { type: 'resize', cols: 90, rows: 20 },
      { type: 'pause' }, { type: 'resume' }, { type: 'clear' }]);
    expect(() => terminal.write('x'.repeat(16_385))).toThrow('bounded');
    expect(() => terminal.kill('SIGKILL')).toThrow('caller-selected');
    const disposal = item.port.dispose(); expect(onExit).not.toHaveBeenCalled();
    await exited(d.child); expect(onExit).toHaveBeenCalledExactlyOnceWith({ exitCode: 0 });
    d.close(0); await disposal;
  });

  it('accepts an ordered start frame when a short-lived native shell has already published its final ledger', async () => {
    const item = await fixture(), d = driver();
    item.pty.spawn(item.port.shell, [], { cwd: item.cwd, cols: 80, rows: 24 });
    const { file, value } = await record();
    await fs.writeFile(file, JSON.stringify({ ...value, status: 'exited', ptyPid: 51_230, exitCode: 0, signal: null,
      killRequested: true, killCalls: 1, teardownConfirmed: true }));
    d.child.emit('message', JSON.stringify({ type: 'started', id: value.id, driverPid: value.driverPid, ptyPid: 51_230 }));
    await item.port.waitForStarts(); await exited(d.child); d.close(0);
    expect((await item.port.dispose())[0]?.teardownConfirmed).toBe(true);
  });

  it('refuses excess pending IPC writes instead of growing an application queue or retrying', async () => {
    const item = await fixture(), d = driver();
    const terminal = item.pty.spawn(item.port.shell, [], { cwd: item.cwd, cols: 80, rows: 24 });
    await started(d.child); await item.port.waitForStarts();
    d.send.mockImplementation(() => true); // IPC write callbacks deliberately never complete.
    for (let index = 0; index < 32; index++) terminal.write('x');
    expect(() => terminal.write('not queued')).toThrow('IPC');
    await exited(d.child); d.close(0);
    await expect(item.port.dispose()).rejects.toThrow('retain');
    expect(f.fork).toHaveBeenCalledOnce();
  });

  it('emits no native exit on wrapper close without a real receipt and retains the marker', async () => {
    const item = await fixture(), d = driver();
    const terminal = item.pty.spawn(item.port.shell, [], { cwd: item.cwd, cols: 80, rows: 24 });
    const onExit = vi.fn(); terminal.onExit(onExit);
    await started(d.child); d.close(0);
    await expect(item.port.dispose()).rejects.toThrow('retain');
    expect(onExit).not.toHaveBeenCalled();
    expect(item.port.observations()[0]).toMatchObject({ driverClosed: true, teardownConfirmed: false });
    expect((await fs.stat(path.join(item.port.root, '.fate-retained-owned-work.json'))).isFile()).toBe(true);
  });

  it.each([
    { field: 'owner identity', change: { id: '10000000-0000-4000-8000-000000000001' } },
    { field: 'parent identity', change: { parentPid: process.pid + 1 } },
    { field: 'driver identity', change: { driverPid: 99_999 } },
    { field: 'native PID', change: { ptyPid: 99_999 } },
    { field: 'status', change: { status: 'running' } },
    { field: 'exit code', change: { exitCode: 7 } },
    { field: 'signal', change: { signal: 2 } },
    { field: 'kill request', change: { killRequested: false } },
    { field: 'kill calls', change: { killCalls: 0 } },
    { field: 'teardown', change: { teardownConfirmed: false } },
  ])('emits no native exit when final ledger $field mismatches its receipt', async ({ change }) => {
    const item = await fixture(), d = driver();
    const terminal = item.pty.spawn(item.port.shell, [], { cwd: item.cwd, cols: 80, rows: 24 });
    const onExit = vi.fn(); terminal.onExit(onExit);
    await started(d.child); await exited(d.child, change);
    expect(onExit).not.toHaveBeenCalled(); // Validation must precede notification, not just wrapper-close cleanup.
    d.close(0);
    await expect(item.port.dispose()).rejects.toThrow('retain');
    expect(onExit).not.toHaveBeenCalled();
    expect(item.port.observations()[0]?.teardownConfirmed).toBe(false);
    expect((await fs.stat(path.join(item.port.root, '.fate-retained-owned-work.json'))).isFile()).toBe(true);
  });

  it('bounds shutdown, kills only the owned driver object, and rejects an unconfirmed join', async () => {
    const item = await fixture(), d = driver();
    vi.useFakeTimers();
    item.pty.spawn(item.port.shell, [], { cwd: item.cwd, cols: 80, rows: 24 });
    await started(d.child); await item.port.waitForStarts();
    const disposal = item.port.dispose(); const rejected = expect(disposal).rejects.toThrow('retain');
    vi.advanceTimersByTime(5_000); expect(d.child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    vi.advanceTimersByTime(2_000); await rejected;
    expect(item.port.observations()[0]).toMatchObject({ driverClosed: false, driverForceKillRequested: true, teardownConfirmed: false });
    expect((await fs.stat(path.join(item.port.root, '.fate-retained-owned-work.json'))).isFile()).toBe(true);
  });

  it('keeps driver success after native exit, output drain, final ledger and exit-frame send completion (source invariant)', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'tests/v2/helpers/nativePtyDriver.mjs'), 'utf8');
    const stop = source.slice(source.indexOf('function requestStop()'), source.indexOf('function fail(code)'));
    const finish = source.slice(source.indexOf('function finishWhenDrained()'), source.indexOf('function verifyOwner()'));
    expect(source.match(/terminal\.kill\(\)/gu)).toHaveLength(1);
    expect(stop).toContain('if (terminal && !nativeExit && owner.killCalls === 0)');
    expect(finish).not.toContain('terminal.kill');
    expect(finish).toContain('if (completed || !nativeExit || !closing && (buffered.length || pending.size)) return;');
    expect(finish).toContain('try { publish(); }');
    expect(finish.indexOf('publish();')).toBeLessThan(finish.indexOf("send({ type: 'exit'"));
    expect(finish).toContain('}, () => process.exit(0));');
    expect(finish).toContain('catch { process.exit(1); }');
    expect(source.match(/process\.exit\(0\)/gu)).toHaveLength(1);
  });

  it('parses only bounded JSON replies with strict shapes', () => {
    expect(() => parseNativePtyReply({ type: 'data' })).toThrow('JSON frame');
    expect(() => parseNativePtyReply('x'.repeat(128 * 1024 + 1))).toThrow('JSON frame');
    expect(() => parseNativePtyReply(JSON.stringify({ type: 'data', id: '10000000-0000-4000-8000-000000000001', sequence: 0, data: 'x' }))).toThrow();
    expect(() => parseNativePtyReply(JSON.stringify({ type: 'started', id: '10000000-0000-4000-8000-000000000001', driverPid: 1, ptyPid: 2, secret: 'extra' }))).toThrow();
  });
});
