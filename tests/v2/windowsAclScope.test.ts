import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertPrivateWindowsAcl, assertPrivateWindowsAcls, assertPrivateWindowsTree, withPrivateWindowsAclScope } from '../../src/core/storage/WindowsPrivateAcl';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: mocks.spawn }));
interface Request { id: string; kind: string; target: string }
class QueryProcess extends EventEmitter {
  readonly requests: Request[] = [];
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new Writable({ write: (chunk: Buffer, _encoding, callback) => { this.requests.push(JSON.parse(chunk.toString()) as Request); callback(); } });
  settleOnEnd = true;
  settleOnKill = true;
  closed = false;
  readonly kill = vi.fn(() => { if (this.settleOnKill) queueMicrotask(() => this.close(null)); return true; });
  constructor() {
    super();
    this.stdin.on('finish', () => { if (this.settleOnEnd) queueMicrotask(() => this.close(0)); });
  }
  reply(id = this.requests.at(-1)!.id): void { this.stdout.write(`PRIVATE ${id}\r\n`); }
  close(code: number | null): void { if (!this.closed) { this.closed = true; this.emit('close', code); } }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
let children: QueryProcess[] = [];
beforeEach(() => {
  children = [];
  mocks.spawn.mockImplementation(() => { const child = new QueryProcess(); children.push(child); return child; });
});
afterEach(() => { vi.useRealTimers(); mocks.spawn.mockReset(); });

describe.skipIf(process.platform !== 'win32')('operation-scoped Windows ACL transport', () => {
  it('reuses only transport: every single, batch and tree assertion has a fresh ordered request', async () => {
    const target = 'C:\\fixture\\literal [é中] $name.txt';
    const operation = withPrivateWindowsAclScope(async () => {
      await assertPrivateWindowsAcl(target);
      await assertPrivateWindowsAcl(target);
      await withPrivateWindowsAclScope(() => assertPrivateWindowsAcls([target, 'C:\\fixture']));
      await assertPrivateWindowsTree('C:\\fixture');
      return 'verified';
    });
    const child = children[0]!;
    for (let index = 0; index < 4; index++) { expect(child.requests).toHaveLength(index + 1); child.reply(); await tick(); }
    await expect(operation).resolves.toBe('verified');
    expect(child.requests).toEqual([
      { id: '1', kind: 'single', target }, { id: '2', kind: 'single', target },
      { id: '3', kind: 'batch', target: JSON.stringify([target, 'C:\\fixture']) }, { id: '4', kind: 'tree', target: 'C:\\fixture' },
    ]);
    expect(mocks.spawn).toHaveBeenCalledTimes(1); expect(child.closed).toBe(true);
    expect(mocks.spawn.mock.calls[0]![2]).toMatchObject({ shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  });

  it('starts lazily and never shares a process between independent operations', async () => {
    await withPrivateWindowsAclScope(async () => undefined); expect(children).toHaveLength(0);
    for (let index = 0; index < 2; index++) {
      const operation = withPrivateWindowsAclScope(() => assertPrivateWindowsAcl('C:\\fixture'));
      children[index]!.reply(); await operation; expect(children[index]!.closed).toBe(true);
    }
    expect(children).toHaveLength(2);
  });

  it('waits for actual close after the last good response, not merely stdin end', async () => {
    let settled = false;
    const operation = withPrivateWindowsAclScope(() => assertPrivateWindowsAcl('C:\\fixture')).then(() => { settled = true; });
    const child = children[0]!; child.settleOnEnd = false;
    child.reply(); await tick(); expect(child.stdin.writableFinished).toBe(true); expect(settled).toBe(false);
    child.close(0); await operation; expect(settled).toBe(true);
  });

  it.each(['corrupt', 'oversized', 'unknown-id', 'stderr', 'exit', 'stdin-error'] as const)('fails closed and joins after %s output or failure', async (failure) => {
    const operation = withPrivateWindowsAclScope(() => assertPrivateWindowsAcl('C:\\fixture'));
    const rejected = expect(operation).rejects.toThrow('cannot be verified');
    const child = children[0]!;
    switch (failure) {
      case 'corrupt': child.stdout.write('NOT_PRIVATE\n'); break;
      case 'oversized': child.stdout.write('x'.repeat(4097)); break;
      case 'unknown-id': child.reply('99'); break;
      case 'stderr': child.stderr.write('untrusted diagnostic'); break;
      case 'exit': child.close(0); break;
      case 'stdin-error': child.stdin.emit('error', new Error('pipe failed')); break;
    }
    await rejected; expect(child.closed).toBe(true);
  });

  it.each(['out-of-order', 'duplicate'] as const)('rejects %s replies without accepting another query', async (failure) => {
    const operation = withPrivateWindowsAclScope(() => Promise.all([assertPrivateWindowsAcl('C:\\one'), assertPrivateWindowsAcl('C:\\two')]));
    const rejected = expect(operation).rejects.toThrow('cannot be verified');
    const child = children[0]!;
    if (failure === 'duplicate') { child.reply('1'); child.reply('1'); } else child.reply('2');
    await rejected; expect(child.kill).toHaveBeenCalledTimes(1); expect(child.closed).toBe(true);
  });

  it('uses the original 30s request deadline, rejects late replies, and still joins after kill', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const operation = withPrivateWindowsAclScope(() => assertPrivateWindowsAcl('C:\\fixture'));
    const outcome = operation.then(() => { settled = true; return 'unexpected success'; }, (error: unknown) => { settled = true; return String(error); });
    const child = children[0]!; child.settleOnKill = false; child.settleOnEnd = false;
    await vi.advanceTimersByTimeAsync(29_999); expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(child.kill).toHaveBeenCalledTimes(1);
    child.reply('1'); await tick(); expect(settled).toBe(false);
    child.close(null); expect(await outcome).toContain('cannot be verified');
  });

  it('fails if graceful helper shutdown stalls and waits for confirmed termination', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const operation = withPrivateWindowsAclScope(() => assertPrivateWindowsAcl('C:\\fixture'));
    const rejected = expect(operation).rejects.toThrow('cannot be verified');
    const child = children[0]!; child.settleOnEnd = false;
    child.reply(); await tick();
    await vi.advanceTimersByTimeAsync(30_000); await rejected;
    expect(child.kill).toHaveBeenCalledTimes(1); expect(child.closed).toBe(true);
  });

  it.each(['count', 'bytes'] as const)('bounds pending request %s and settles every admitted check on overflow', async (bound) => {
    const targets = bound === 'count' ? Array.from({ length: 33 }, () => 'C:\\fixture') : Array.from({ length: 6 }, () => `C:\\${'x'.repeat(24_000)}`);
    const operation = withPrivateWindowsAclScope(() => Promise.all(targets.map((target) => assertPrivateWindowsAcl(target))));
    await expect(operation).rejects.toThrow('cannot be verified');
    expect(children[0]!.requests.length).toBe(bound === 'count' ? 32 : 5); expect(children[0]!.closed).toBe(true);
  });

  it.each(['empty', 'nul', 'bytes'] as const)('rejects %s input before process creation', async (kind) => {
    const target = kind === 'empty' ? '' : kind === 'nul' ? 'C:\\nul\0' : `C:\\${'中'.repeat(30_000)}`;
    await expect(withPrivateWindowsAclScope(() => assertPrivateWindowsAcl(target))).rejects.toThrow('cannot be verified');
    expect(children).toHaveLength(0);
  });

  it('fences escaped async work even when the scope had no queries', async () => {
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let escaped!: Promise<void>;
    await withPrivateWindowsAclScope(async () => { escaped = gate.then(() => assertPrivateWindowsAcl('C:\\fixture')); });
    resume(); await expect(escaped).rejects.toThrow('cannot be verified'); expect(children).toHaveLength(0);
  });

  it('rejects an unawaited query, joins it, and cannot hide a swallowed transport failure', async () => {
    let query!: Promise<void>;
    const operation = withPrivateWindowsAclScope(async () => { query = assertPrivateWindowsAcl('C:\\fixture').catch(() => undefined); });
    await expect(operation).rejects.toThrow('cannot be verified'); await query; expect(children[0]!.closed).toBe(true);
    const swallowed = withPrivateWindowsAclScope(async () => { await assertPrivateWindowsAcl('C:\\fixture').catch(() => undefined); });
    children[1]!.stdout.write('BAD\n');
    await expect(swallowed).rejects.toThrow('cannot be verified'); expect(children[1]!.closed).toBe(true);
  });

  it('preserves the operation error only after joining its helper', async () => {
    const original = new Error('source changed');
    const operation = withPrivateWindowsAclScope(async () => { await assertPrivateWindowsAcl('C:\\fixture'); throw original; });
    const rejected = expect(operation).rejects.toBe(original); children[0]!.reply();
    await rejected; expect(children[0]!.closed).toBe(true);
  });

  it('fails closed on spawn failure without retry or fallback', async () => {
    mocks.spawn.mockImplementationOnce(() => { throw new Error('cannot start helper'); });
    await expect(withPrivateWindowsAclScope(() => assertPrivateWindowsAcl('C:\\fixture'))).rejects.toThrow('cannot be verified');
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
});
