import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, renameSync, writeFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { IPty, IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty';
import { z } from 'zod';
import { assertPrivateWindowsAcls } from '../../../src/core/storage/WindowsPrivateAcl';
import { isWithin, privateTestRoot } from './isolatedEnvironment';

const FRAME_BYTES = 128 * 1024;
const BUFFER_BYTES = 512 * 1024;
const FRAME_COUNT = 32;
const START_MS = 5_000;
const CLOSE_MS = 5_000;
const FORCE_JOIN_MS = 2_000;
const pid = z.number().int().positive().safe();
const recordSchema = z.object({ version: z.literal(1), id: z.string().uuid(), parentPid: pid,
  driver: z.string().max(32_768), driverSha256: z.string().regex(/^[a-f0-9]{64}$/u), driverPid: pid.nullable(),
  ptyPid: pid.nullable(), root: z.string().max(32_768), home: z.string().max(32_768), cwd: z.string().max(32_768),
  shell: z.string().max(32_768), status: z.enum(['pending', 'running', 'exited', 'failed']),
  exitCode: z.number().int().safe().nullable(), signal: z.number().int().safe().nullable(),
  killRequested: z.boolean(), killCalls: z.number().int().min(0).max(2), teardownConfirmed: z.boolean() }).strict();
type OwnershipRecord = z.infer<typeof recordSchema>;
const replySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('started'), id: z.string().uuid(), driverPid: pid, ptyPid: pid }).strict(),
  z.object({ type: z.literal('data'), id: z.string().uuid(), sequence: z.number().int().positive().safe(), data: z.string().min(1).max(16_384) }).strict(),
  z.object({ type: z.literal('exit'), id: z.string().uuid(), driverPid: pid, ptyPid: pid,
    exitCode: z.number().int().safe(), signal: z.number().int().safe().nullable(),
    killRequested: z.boolean(), killCalls: z.number().int().min(0).max(2), teardownConfirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal('fault'), id: z.string().uuid(), code: z.enum([
    'invalid-start', 'invalid-frame', 'native-failure', 'output-limit', 'ipc-failure', 'consumption-timeout', 'shutdown-unconfirmed', 'owner-lost',
  ]) }).strict(),
]);
type DriverReply = z.infer<typeof replySchema>;
type ExitReply = Extract<DriverReply, { type: 'exit' }>;
type DriverRequest = { type: 'start'; cols: number; rows: number } | { type: 'write'; data: string }
  | { type: 'resize'; cols: number; rows: number } | { type: 'consume'; sequence: number; characters: number }
  | { type: 'pause' | 'resume' | 'clear' | 'kill' };

export function parseNativePtyReply(value: unknown): DriverReply {
  if (typeof value !== 'string' || Buffer.byteLength(value) > FRAME_BYTES) throw new Error('Native PTY reply exceeds its JSON frame boundary.');
  return replySchema.parse(JSON.parse(value));
}
/** No inherited PATH, NODE_OPTIONS, provider/agent variables, shell startup hooks or credentials. */
export function nativePtyEnvironment(root: string, home: string, shell: string): NodeJS.ProcessEnv {
  const systemRoot = process.platform === 'win32' ? path.dirname(path.dirname(shell)) : null;
  return { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_STATE_HOME: path.join(home, 'state'), XDG_RUNTIME_DIR: path.join(home, 'runtime'),
    TMP: path.join(home, 'tmp'), TEMP: path.join(home, 'tmp'), TMPDIR: path.join(home, 'tmp'),
    PATH: [...new Set([path.dirname(shell), path.dirname(realpathSync(process.execPath))])].join(path.delimiter),
    LANG: 'C', LC_ALL: 'C', TERM: 'xterm-256color', TZ: 'UTC', NO_COLOR: '1', FATE_V2_TEST_ROOT: root,
    ...(systemRoot ? { SYSTEMROOT: systemRoot, WINDIR: systemRoot, COMSPEC: shell } : {}) };
}
function encodeRecord(value: OwnershipRecord): string {
  const text = JSON.stringify(recordSchema.parse(value));
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error('Native PTY ownership record exceeds its bound.');
  return text;
}
function publish(file: string, value: OwnershipRecord): void {
  const temporary = `${file}.parent.tmp`;
  writeFileSync(temporary, encodeRecord(value), { flag: 'wx', mode: 0o600 });
  renameSync(temporary, file);
}
function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function dimensions(cols: unknown, rows: unknown): { cols: number; rows: number } {
  return z.object({ cols: z.number().int().min(2).max(400), rows: z.number().int().min(1).max(200) }).parse({ cols, rows });
}
export interface NativePtyObservation {
  readonly id: string;
  readonly driverPid: number | null;
  readonly ptyPid: number | null;
  readonly nativeExitCode: number | null;
  readonly nativeSignal: number | null;
  readonly killRequested: boolean;
  readonly driverForceKillRequested: boolean;
  readonly driverClosed: boolean;
  readonly driverExitCode: number | null;
  readonly driverSignal: NodeJS.Signals | null;
  readonly teardownConfirmed: boolean;
  readonly failure: string | null;
}
export interface NativePtyPort {
  readonly root: string;
  readonly shell: string;
  /** Fits TerminalOwner's existing port. Native code is loaded only in the separate fixed driver. */
  readonly loadPty: () => Promise<typeof import('node-pty')>;
  observations(): readonly NativePtyObservation[];
  waitForStarts(): Promise<void>;
  /** Kill only owned instances; require native exit + matching ledger + actual driver close. */
  dispose(): Promise<readonly NativePtyObservation[]>;
}

class NativePtyProxy implements IPty {
  private readonly child: ChildProcess;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  private nativePid: number | null = null;
  private nextSequence = 1;
  private sentBytes = 0;
  private sentFrames = 0;
  private diagnosticBytes = 0;
  private receipt: ExitReply | null = null;
  private failure: string | null = null;
  private closing = false;
  private closed = false;
  private forceRequested = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private forceTimer: ReturnType<typeof setTimeout> | undefined;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private resolveDone!: () => void;
  private rejectDone!: (error: Error) => void;
  readonly ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
  readonly done = new Promise<void>((resolve, reject) => { this.resolveDone = resolve; this.rejectDone = reject; });
  handleFlowControl = false;
  get pid(): number { return this.nativePid ?? 0; }
  get process(): string { return path.basename(this.owner.shell); }
  constructor(private readonly file: string, private readonly owner: OwnershipRecord,
    public cols: number, public rows: number, env: NodeJS.ProcessEnv, private readonly poison: (reason: string) => void) {
    void this.ready.catch(() => undefined); void this.done.catch(() => undefined);
    writeFileSync(file, encodeRecord(owner), { flag: 'wx', mode: 0o600 }); // Before fork, not a late cleanup marker.
    this.child = fork(owner.driver, [], { cwd: owner.root, env: { ...env, FATE_NATIVE_PTY_RECORD: file },
      execArgv: [], serialization: 'json', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    this.child.on('error', () => this.fail('Native PTY driver launch/IPC failed.'));
    this.child.on('disconnect', () => { if (!this.closed && !this.receipt) this.fail('Native PTY driver disconnected before its exit receipt.'); });
    this.child.on('message', (value: unknown) => {
      try { this.accept(parseNativePtyReply(value)); }
      catch { this.fail('Invalid native PTY driver reply.'); }
    });
    this.child.once('close', (code, signal) => this.finish(code, signal));
    const diagnostic = (chunk: Buffer) => {
      this.diagnosticBytes += chunk.byteLength;
      if (this.diagnosticBytes > 64 * 1024) this.fail('Native PTY driver diagnostic output exceeded its bound.');
    };
    this.child.stdout?.on('data', diagnostic); this.child.stderr?.on('data', diagnostic);
    this.startTimer = setTimeout(() => this.fail('Native PTY start timed out.'), START_MS);
    try {
      owner.driverPid = pid.parse(this.child.pid);
      publish(file, owner);
      this.send({ type: 'start', cols, rows });
    } catch { this.fail('Native PTY ownership publication failed.'); }
  }
  private send(frame: DriverRequest): void {
    if (this.closed || !this.child.connected) throw new Error('Native PTY driver is disconnected.');
    const text = JSON.stringify(frame);
    const bytes = Buffer.byteLength(JSON.stringify(text)) + 1; // Node's JSON IPC encodes the string again, plus its delimiter.
    if (bytes > FRAME_BYTES || this.sentBytes + bytes > BUFFER_BYTES || this.sentFrames >= FRAME_COUNT) {
      throw new Error('Native PTY input IPC exceeded its bound. No retry is permitted.');
    }
    this.sentBytes += bytes; this.sentFrames++;
    this.child.send(text, (error) => {
      this.sentBytes -= bytes; this.sentFrames--;
      if (error) this.fail('Native PTY IPC delivery failed.');
    });
  }
  private command(frame: DriverRequest): void {
    if (this.closing || this.receipt || this.closed) throw new Error('Native PTY is closing or closed.');
    try { this.send(frame); } catch (error) { this.fail('Native PTY command was not delivered.'); throw error; }
  }
  write(data: string | Buffer): void {
    if (typeof data !== 'string' || data.length > 16_384) throw new Error('Native PTY fixture accepts bounded terminal text only.');
    this.command({ type: 'write', data });
  }
  resize(cols: number, rows: number): void {
    const size = dimensions(cols, rows); this.command({ type: 'resize', ...size }); this.cols = cols; this.rows = rows;
  }
  pause(): void { this.command({ type: 'pause' }); }
  resume(): void { this.command({ type: 'resume' }); }
  clear(): void { this.command({ type: 'clear' }); }
  kill(signal?: string): void {
    if (signal !== undefined) throw new Error('Native PTY fixture kill does not accept a caller-selected signal.');
    if (this.closing || this.receipt || this.closed) return;
    this.closing = true;
    try { this.send({ type: 'kill' }); } catch { this.failure ??= 'Native PTY stop delivery unconfirmed.'; this.poison(this.failure); }
    this.armClose();
  }
  readonly onData: IPty['onData'] = (listener) => {
    if (this.dataListeners.size >= 8) throw new Error('Native PTY fixture listener limit.');
    this.dataListeners.add(listener); return { dispose: () => { this.dataListeners.delete(listener); } };
  };
  readonly onExit: IPty['onExit'] = (listener) => {
    if (this.exitListeners.size >= 8) throw new Error('Native PTY fixture listener limit.');
    this.exitListeners.add(listener); return { dispose: () => { this.exitListeners.delete(listener); } };
  };
  private accept(frame: DriverReply): void {
    if (frame.id !== this.owner.id || this.closed) throw new Error('Native PTY owner changed.');
    if (frame.type === 'fault') { this.fail(`Native PTY driver fault: ${frame.code}.`); return; }
    if (frame.type === 'started') {
      if (this.nativePid !== null || frame.driverPid !== this.child.pid) throw new Error('Unexpected native PTY start.');
      const record = this.record();
      // A short-lived shell may already have published its exit by the time
      // this earlier, ordered start frame reaches the parent.
      if (!['running', 'exited'].includes(record.status) || record.ptyPid !== frame.ptyPid) throw new Error('Native PTY start ledger mismatch.');
      this.nativePid = frame.ptyPid; clearTimeout(this.startTimer); this.resolveReady(); return;
    }
    if (this.nativePid === null || this.receipt) throw new Error('Native PTY output outside its lifetime.');
    if (frame.type === 'data') {
      if (frame.sequence !== this.nextSequence++) throw new Error('Native PTY output sequence gap.');
      if (!this.closing) for (const listener of this.dataListeners) listener(frame.data);
      this.send({ type: 'consume', sequence: frame.sequence, characters: frame.data.length }); return;
    }
    this.verifyExit(frame);
    this.receipt = frame; clearTimeout(this.startTimer); this.armClose();
    for (const listener of this.exitListeners) listener({ exitCode: frame.exitCode, ...(frame.signal === null ? {} : { signal: frame.signal }) });
  }
  private record(): OwnershipRecord {
    const stat = lstatSync(this.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) throw new Error('Native PTY ledger unavailable.');
    const record = recordSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
    for (const key of ['id', 'parentPid', 'driver', 'driverSha256', 'driverPid', 'root', 'home', 'cwd', 'shell'] as const) {
      if (record[key] !== this.owner[key]) throw new Error('Native PTY ledger identity changed.');
    }
    return record;
  }
  private verifyExit(receipt: ExitReply): void {
    const record = this.record();
    if (receipt.id !== record.id || receipt.driverPid !== this.child.pid || receipt.driverPid !== record.driverPid
      || receipt.ptyPid !== this.nativePid || receipt.ptyPid !== record.ptyPid || record.status !== 'exited'
      || record.exitCode !== receipt.exitCode || record.signal !== receipt.signal
      || record.killRequested !== receipt.killRequested || record.killCalls !== receipt.killCalls
      || record.teardownConfirmed !== receipt.teardownConfirmed) {
      throw new Error('Native PTY final exit ledger does not match its receipt.');
    }
  }
  private fail(reason: string): void {
    this.failure ??= reason; this.poison(this.failure); this.rejectReady(new Error(this.failure));
    if (!this.closed) { this.kill(); this.armClose(); }
  }
  private armClose(): void {
    if (this.closeTimer || this.closed) return;
    this.closeTimer = setTimeout(() => {
      this.failure ??= 'Native PTY exit or driver join unconfirmed.'; this.poison(this.failure);
      // Signal only this still-owned ChildProcess, never a native PID after exit.
      if (!this.closed && this.child.exitCode === null && this.child.signalCode === null) {
        this.forceRequested = true;
        try { this.child.kill('SIGKILL'); } catch { this.failure = 'Native PTY owned driver stop failed.'; }
      }
      if (this.closed) return;
      this.forceTimer = setTimeout(() => {
        if (this.closed) return;
        this.rejectReady(new Error(this.failure ?? 'Native PTY start unconfirmed.'));
        this.rejectDone(new Error('Native PTY driver close unconfirmed; retain fixture roots.'));
        try { if (this.child.connected) this.child.disconnect(); } catch { /* Already reported unconfirmed; never clear the marker. */ }
        this.child.unref(); this.child.stdout?.destroy(); this.child.stderr?.destroy();
      }, FORCE_JOIN_MS);
    }, CLOSE_MS);
  }
  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    this.closed = true; this.exitCode = code; this.exitSignal = signal;
    clearTimeout(this.startTimer); clearTimeout(this.closeTimer); clearTimeout(this.forceTimer);
    try {
      const receipt = this.receipt;
      if (this.failure || !receipt || code !== 0 || signal !== null) {
        throw new Error(this.failure ?? 'Native PTY native exit/driver teardown receipt unconfirmed.');
      }
      this.verifyExit(receipt);
      this.resolveDone();
    } catch (error) {
      this.failure ??= error instanceof Error ? error.message : 'Native PTY cleanup failed.';
      this.poison(this.failure); this.rejectReady(new Error(this.failure)); this.rejectDone(new Error(this.failure));
      // IPty.onExit is native exit proof, never a wrapper-failure notification.
    } finally { this.dataListeners.clear(); this.exitListeners.clear(); }
  }
  observation(): NativePtyObservation {
    return { id: this.owner.id, driverPid: this.child.pid ?? null, ptyPid: this.nativePid,
      nativeExitCode: this.receipt?.exitCode ?? null, nativeSignal: this.receipt?.signal ?? null,
      killRequested: this.closing, driverForceKillRequested: this.forceRequested, driverClosed: this.closed,
      driverExitCode: this.exitCode, driverSignal: this.exitSignal,
      teardownConfirmed: this.closed && this.failure === null && this.receipt !== null, failure: this.failure };
  }
}

/** TEST ONLY: actual node-pty lives in a credential-free native-I/O driver without
 * inherited --import/--input-type flags. The Fate host keeps its unchanged guard.
 * This is cooperative fixture ownership, not an OS sandbox for hostile shell input. */
export async function createNativePtyPort(options: { sourceRoot: string; cwdRoots: readonly string[] }): Promise<NativePtyPort> {
  const testRoot = await fs.realpath(privateTestRoot());
  if (options.cwdRoots.length < 1 || options.cwdRoots.length > 8) throw new Error('Native PTY fixture requires 1–8 explicit private workspace roots.');
  const roots = await Promise.all(options.cwdRoots.map(async (cwd) => {
    const real = await fs.realpath(cwd);
    if (!path.isAbsolute(cwd) || real === testRoot || !isWithin(testRoot, real) || !(await fs.stat(real)).isDirectory()) {
      throw new Error('Native PTY cwd escapes private fixture workspaces.');
    }
    return real;
  }));
  if (!path.isAbsolute(options.sourceRoot)) throw new Error('Native PTY source root must be explicit and absolute.');
  const source = await fs.realpath(options.sourceRoot);
  const driver = await fs.realpath(path.join(source, 'tests/v2/helpers/nativePtyDriver.mjs'));
  if (path.relative(source, driver) !== path.join('tests', 'v2', 'helpers', 'nativePtyDriver.mjs')) throw new Error('Native PTY driver must be the fixed source helper.');
  const driverSha256 = createHash('sha256').update(await fs.readFile(driver)).digest('hex');
  const shell = await fs.realpath(process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'cmd.exe') : '/bin/sh');
  if (isWithin(testRoot, shell) || !(await fs.stat(shell)).isFile()) throw new Error('Native PTY fixture requires an installed system shell.');
  await fs.mkdir(path.join(testRoot, 'tmp'), { recursive: true, mode: 0o700 });
  const root = await fs.mkdtemp(path.join(testRoot, 'tmp', 'fate-v2-native-pty-'));
  const home = path.join(root, 'home'), guardRoot = path.join(root, '.fate-owned-cli-guard');
  let acquired = false;
  try {
    await fs.mkdir(home, { mode: 0o700 }); await fs.mkdir(guardRoot, { mode: 0o700 });
    for (const dir of ['appdata', 'localappdata', 'config', 'data', 'cache', 'state', 'runtime', 'tmp']) await fs.mkdir(path.join(home, dir), { mode: 0o700 });
    await assertPrivateWindowsAcls([testRoot, root, ...roots]);
    const portId = randomUUID(), marker = JSON.stringify({ version: 1, id: portId, status: 'pending-native-pty', roots, home, driver, driverSha256 });
    await fs.writeFile(path.join(guardRoot, 'owner.json'), marker, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(root, '.fate-retained-owned-work.json'), marker, { flag: 'wx', mode: 0o600 });
    acquired = true;
    const entries: NativePtyProxy[] = [];
    let stopped = false, failure: string | null = null, disposal: Promise<readonly NativePtyObservation[]> | null = null;
    const env = nativePtyEnvironment(testRoot, home, shell);
    const module: typeof import('node-pty') = { spawn(file: string, args: string[] | string, input: IPtyForkOptions | IWindowsPtyForkOptions): IPty {
      if (stopped || failure) throw new Error('Native PTY fixture is stopped or failed.');
      if (realpathSync(root) !== root || realpathSync(home) !== home) throw new Error('Native PTY private root changed.');
      const safeArgs = Array.isArray(args) && (args.length === 0 || process.platform === 'win32'
        && path.basename(shell).toLowerCase() === 'cmd.exe' && args.length === 1 && args[0] === '/d');
      const cwd = input.cwd ? realpathSync(input.cwd) : null;
      if (!safeArgs || !sameCanonicalPath(realpathSync(file), shell) || !cwd
        || !roots.some((root) => sameCanonicalPath(cwd, root))) {
        throw new Error('Native PTY fixture rejects arbitrary programs, arguments or working directories.');
      }
      if (entries.length >= 256 || entries.filter((entry) => !entry.observation().driverClosed).length >= 32) throw new Error('Native PTY fixture process limit reached.');
      const size = dimensions(input.cols, input.rows), id = randomUUID();
      const owner: OwnershipRecord = { version: 1, id, parentPid: process.pid, driver, driverSha256, driverPid: null, ptyPid: null,
        root, home, cwd, shell, status: 'pending', exitCode: null, signal: null,
        killRequested: false, killCalls: 0, teardownConfirmed: false };
      // Deliberately discard input.env (TerminalOwner supplies the host environment).
      try {
        const entry = new NativePtyProxy(path.join(root, `owned-${id}.json`), owner, size.cols, size.rows, env, (reason) => { failure ??= reason; });
        entries.push(entry); return entry;
      } catch (error) { failure ??= 'Native PTY driver acquisition failed; retain roots.'; throw error; }
    } };
    return { root, shell, loadPty: async () => { if (stopped) throw new Error('Native PTY fixture is closed.'); return module; },
      observations: () => entries.map((entry) => entry.observation()),
      waitForStarts: async () => { await Promise.all(entries.map((entry) => entry.ready)); },
      dispose: () => disposal ??= (async () => {
        stopped = true;
        for (const entry of entries) entry.kill();
        const joined = await Promise.allSettled(entries.map((entry) => entry.done));
        if (failure || joined.some((result) => result.status === 'rejected')) {
          throw new Error(`Native PTY ownership unconfirmed or failed; retain ${root} and workspace roots. ${failure ?? 'Join failed.'}`);
        }
        if (await fs.readFile(path.join(guardRoot, 'owner.json'), 'utf8') !== marker
          || await fs.readFile(path.join(root, '.fate-retained-owned-work.json'), 'utf8') !== marker) throw new Error(`Native PTY retention ledger changed; retain ${root}.`);
        const result = entries.map((entry) => entry.observation());
        await fs.rm(root, { recursive: true, force: false });
        return result;
      })() };
  } catch (error) {
    if (!acquired) await fs.rm(root, { recursive: true, force: true }); // No driver can have started before returning the port.
    throw error;
  }
}
