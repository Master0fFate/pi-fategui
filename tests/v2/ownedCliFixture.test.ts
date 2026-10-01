import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { acquireCliFixtureOwnership, assertPrivateCliHome, isSignaledCliReceipt, parseNativeCliReceipt } from '../network/helpers/productionCliProcess';
import { privateTestRoot } from './helpers/isolatedEnvironment';

// Controller fault tests, not replacements for the real CLI/ConPTY cases.
// No process is spawned by these metadata/receipt unit checks.
const roots: string[] = [];
const ownerships: Awaited<ReturnType<typeof acquireCliFixtureOwnership>>[] = [];
afterEach(async () => {
  for (const ownership of ownerships.splice(0)) {
    try { await ownership.release(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true, maxRetries: 3 })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(privateTestRoot(), 'cli-ledger-unit-')); roots.push(root);
  const home = path.join(root, 'home'); await fs.mkdir(home);
  const entry = path.join(root, 'main.js'); await fs.writeFile(entry, '// Metadata fixture; never executed.');
  const compiled = { entry, sha256: '1'.repeat(64) };
  return { root, home, compiled };
}
async function acquire(home: string, compiled: { entry: string; sha256: string }) {
  const ownership = await acquireCliFixtureOwnership(home, compiled); ownerships.push(ownership); return ownership;
}
const receipt = { pid: 123, exitCode: 0, signal: null, output: '', incomplete: false, teardownConfirmed: true, failure: null,
  ownershipId: '12345678-1234-1234-1234-123456789012', entrySha256: '1'.repeat(64) };

describe('actual CLI fixture controller ownership (unit fault paths)', () => {
  it('publishes pending home/build/hash before any PID, records distinct wrapper/CLI PIDs, and only explicit release removes it', async () => {
    const item = await fixture(), ownership = await acquire(item.home, item.compiled);
    expect(JSON.parse(await fs.readFile(ownership.marker, 'utf8'))).toMatchObject({ id: ownership.id, status: 'pending-cli',
      home: await fs.realpath(item.home), entry: item.compiled.entry, entrySha256: item.compiled.sha256, wrapperPid: null, actualCliPid: null });
    await ownership.update({ wrapperPid: 123, actualCliPid: 456 });
    expect(JSON.parse(await fs.readFile(ownership.marker, 'utf8'))).toMatchObject({ wrapperPid: 123, actualCliPid: 456 });
    expect(JSON.parse(await fs.readFile(path.join(ownership.guardRoot, 'state.json'), 'utf8'))).toMatchObject({ wrapperPid: 123, actualCliPid: 456 });
    await ownership.release(); await expect(fs.stat(ownership.marker)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(ownership.guardRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not overwrite a pending owner when another operation attempts to start', async () => {
    const item = await fixture(), ownership = await acquire(item.home, item.compiled);
    const before = await fs.readFile(ownership.marker);
    await expect(acquireCliFixtureOwnership(item.home, item.compiled)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(ownership.marker)).toEqual(before);
  });
  it('an atomic update failure leaves the prepublished pending marker intact', async () => {
    const item = await fixture(), ownership = await acquire(item.home, item.compiled);
    const before = await fs.readFile(ownership.marker), temporary = ownership.marker + '.' + ownership.id + '.tmp';
    // A real filesystem collision, not a stubbed write or successful replacement.
    await fs.mkdir(temporary);
    try {
      await expect(ownership.update({ wrapperPid: 123 })).rejects.toThrow();
      expect(await fs.readFile(ownership.marker)).toEqual(before);
    } finally { await fs.rm(temporary, { recursive: true }); }
  });
  it.each(['', '{', JSON.stringify({ ...receipt, pid: 0 }), JSON.stringify({ ...receipt, exitCode: null, incomplete: undefined }),
    JSON.stringify({ ...receipt, teardownConfirmed: undefined }), JSON.stringify({ ...receipt, exitCode: 1.5 })])
    ('a missing/malformed exit receipt does not clear pending ownership (%s)', async value => {
      const item = await fixture(), ownership = await acquire(item.home, item.compiled);
      expect(() => parseNativeCliReceipt(value)).toThrow();
      expect(JSON.parse(await fs.readFile(ownership.marker, 'utf8')).id).toBe(ownership.id);
      expect((await fs.stat(item.home)).isDirectory()).toBe(true); expect(await fs.readFile(item.compiled.entry, 'utf8')).toContain('never executed');
    });
  it('a valid receipt explicitly separates incomplete exit or teardown from a confirmed observation', () => {
    expect(parseNativeCliReceipt(JSON.stringify(receipt))).toMatchObject({ exitCode: 0, incomplete: false, teardownConfirmed: true });
    expect(parseNativeCliReceipt(JSON.stringify({ ...receipt, exitCode: null, incomplete: true, teardownConfirmed: false })))
      .toMatchObject({ exitCode: null, incomplete: true, teardownConfirmed: false });
  });
  it('binds a native receipt to the published operation, actual child, wrapper and entry bytes', async () => {
    const item = await fixture(), ownership = await acquire(item.home, item.compiled);
    const actual = { ...receipt, ownershipId: ownership.id };
    await expect(ownership.verifyNative(actual, 789)).rejects.toThrow('published ownership');
    await ownership.update({ wrapperPid: 789, actualCliPid: receipt.pid });
    await expect(ownership.verifyNative(actual, 789)).resolves.toBeUndefined();
    for (const changed of [{ ...actual, pid: 456 }, { ...actual, ownershipId: receipt.ownershipId },
      { ...actual, entrySha256: '2'.repeat(64) }]) {
      await expect(ownership.verifyNative(changed, 789)).rejects.toThrow('published ownership');
    }
    await expect(ownership.verifyNative(actual, 987)).rejects.toThrow('published ownership');
    await expect(ownership.verifyNative(actual, undefined)).rejects.toThrow('published ownership');
  });
  it('retains the independent guard if the mutable marker is missing; ENOENT is not a release receipt', async () => {
    const item = await fixture(), ownership = await acquire(item.home, item.compiled);
    const before = await fs.readFile(ownership.marker);
    await fs.unlink(ownership.marker);
    try {
      await expect(ownership.release()).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(ownership.update({ actualCliPid: 123 })).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await fs.stat(ownership.guardRoot)).isDirectory()).toBe(true);
      expect((await fs.stat(item.home)).isDirectory()).toBe(true);
      expect(await fs.readFile(item.compiled.entry, 'utf8')).toContain('never executed');
    } finally {
      // This unit case never spawned anything. Restore its own receipt so the
      // unit fixture can be explicitly released, not silently treated as exited.
      await fs.writeFile(ownership.marker, before, { flag: 'wx' });
    }
  });
  it.each(['{"signal":1e999}', '{"signal":1.5}', '{"signal":"UNKNOWN_SIGNAL"}'])
    ('rejects an invalid signal instead of accepting a successful exit (%s)', suffix => {
      const raw = JSON.stringify(receipt).replace('"signal":null', suffix.slice(1, -1));
      expect(() => parseNativeCliReceipt(raw)).toThrow();
    });
  it('never classifies a recognized signal plus exit zero as a normal success', () => {
    const signaled = parseNativeCliReceipt(JSON.stringify({ ...receipt, signal: 'SIGTERM' }));
    expect(signaled.exitCode).toBe(0); expect(isSignaledCliReceipt(signaled)).toBe(true);
    expect(isSignaledCliReceipt(parseNativeCliReceipt(JSON.stringify({ ...receipt, signal: 0 })))).toBe(false);
    expect(isSignaledCliReceipt(parseNativeCliReceipt(JSON.stringify(receipt)))).toBe(false);
  });
  it('rejects a home outside the canonical private root or the root itself', async () => {
    await expect(assertPrivateCliHome(path.dirname(privateTestRoot()))).rejects.toThrow('escapes');
    await expect(assertPrivateCliHome(privateTestRoot())).rejects.toThrow('escapes');
  });
  it('rejects a real symlink/junction escape without following it into another home', async () => {
    const item = await fixture(), link = path.join(item.root, 'linked-home');
    await fs.symlink(path.dirname(privateTestRoot()), link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(assertPrivateCliHome(link)).rejects.toThrow('escapes');
  });
});
