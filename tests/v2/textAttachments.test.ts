import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TextAttachmentStore } from '../../src/core/attachments/TextAttachmentStore';
import {
  TEXT_ATTACHMENT_BYTES, TEXT_ATTACHMENT_COUNT, TEXT_ATTACHMENT_REQUEST_BYTES,
  textAttachmentInputSchema, textAttachmentReceiptSchema, type AttachmentScope,
} from '../../src/shared/protocol/attachments';

const scope: AttachmentScope = {
  principalId: 'alice', clientId: 'browser-tab-1',
  workspaceId: '11111111-1111-4111-8111-111111111111', workspaceGeneration: 2,
  sessionId: '22222222-2222-4222-8222-222222222222', serverEpoch: '33333333-3333-4333-8333-333333333333',
};
const upload = (text: string) => ({ contentType: 'text/plain' as const, encoding: 'base64' as const,
  data: Buffer.from(text).toString('base64') });
const roots: string[] = [];
const stores: TextAttachmentStore[] = [];
async function fixture(clock?: () => number) {
  const root = await mkdtemp(path.join(tmpdir(), 'fate-text-'));
  roots.push(root);
  const store = await TextAttachmentStore.open(path.join(root, 'attachments'), clock);
  stores.push(store);
  return { root, store };
}
async function abandonedFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'fate-abandoned-text-'));
  roots.push(root);
  const attachmentRoot = path.join(root, 'attachments');
  const directory = path.join(attachmentRoot, 'text-A1b2C3');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = `ta1_${'a'.repeat(43)}`;
  const file = path.join(directory, id);
  await writeFile(file, 'abandoned text', { mode: 0o600 });
  const project = path.join(root, 'project-sentinel.txt');
  await writeFile(project, 'project is not temporary context');
  return { root, attachmentRoot, directory, file, id, project };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('host-only text attachment store (host adapter owns network admission)', () => {
  it('reclaims an actual terminated process upload on reopen without retaining its ID or deleting sibling project files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fate-text-crash-'));
    roots.push(root);
    const attachmentRoot = path.join(root, 'attachments');
    const project = path.join(root, 'project-sentinel.txt');
    await writeFile(project, 'outside the attachment namespace');
    const bundle = path.join(root, 'attachment-store.mjs');
    // esbuild is Vite's existing private dependency, not a new direct package.
    // Use the same installed resolution seam as the process-ownership fixture.
    const require = createRequire(import.meta.url);
    const esbuild = require(require.resolve('esbuild', { paths: [require.resolve('vite')] })) as {
      build(options: { entryPoints: string[]; outfile: string; bundle: boolean; platform: 'node';
        format: 'esm'; target: string; logLevel: 'silent' }): Promise<unknown>;
    };
    await esbuild.build({ entryPoints: [path.resolve('src/core/attachments/TextAttachmentStore.ts')], outfile: bundle,
      bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
    const code = `import {TextAttachmentStore} from ${JSON.stringify(pathToFileURL(bundle).href)};
      const store = await TextAttachmentStore.open(${JSON.stringify(attachmentRoot)});
      const receipt = await store.upload(${JSON.stringify(scope)}, ${JSON.stringify(upload('actual uploaded crash sentinel'))});
      process.stdout.write(JSON.stringify(receipt), () => process.exit(23));`;
    const child = spawn(process.execPath, ['--import', pathToFileURL(path.resolve('tests/v2/helpers/nodeGuard.mjs')).href,
      '--input-type=module', '--eval', code], { env: process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (bytes: Buffer) => { stdout = `${stdout}${bytes.toString('utf8')}`.slice(-8192); });
    child.stderr.on('data', (bytes: Buffer) => { stderr = `${stderr}${bytes.toString('utf8')}`.slice(-8192); });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 30_000);
    let exit: number | null;
    try { exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
    finally { clearTimeout(deadline); }
    expect(exit, stderr).toBe(23); // Real process ended without calling store.close().
    const receipt = textAttachmentReceiptSchema.parse(JSON.parse(stdout) as unknown);
    const oldDirectories = await readdir(attachmentRoot);
    expect(oldDirectories).toHaveLength(1);
    expect(await readFile(path.join(attachmentRoot, oldDirectories[0]!, receipt.attachmentId), 'utf8')).toBe('actual uploaded crash sentinel');
    const reopened = await TextAttachmentStore.open(attachmentRoot);
    stores.push(reopened);
    expect(await readdir(attachmentRoot)).toEqual([path.basename(reopened.directory)]);
    expect(await readdir(reopened.directory)).toEqual([]);
    await expect(reopened.consume(scope, receipt.attachmentId)).rejects.toThrow();
    expect(await readFile(project, 'utf8')).toBe('outside the attachment namespace');
    expect((await stat(bundle)).isFile()).toBe(true);
  });

  it('refuses a duplicate live store without reclaiming its uploaded context', async () => {
    const { root, store } = await fixture();
    const receipt = await store.upload(scope, upload('still live'));
    const attachmentRoot = path.join(root, 'attachments');
    for (const spelling of [attachmentRoot, `${attachmentRoot}${path.sep}`,
      ...(process.platform === 'win32' ? [attachmentRoot.toUpperCase()] : [])]) {
      await expect(TextAttachmentStore.open(spelling)).rejects.toThrow('Private attachment storage is unavailable.');
    }
    expect(await store.consume(scope, receipt.attachmentId)).toBe('still live');
  });

  it('admits only one concurrent owner across equivalent root spellings', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fate-text-owners-'));
    roots.push(root);
    const attachmentRoot = path.join(root, 'attachments');
    const opened = await Promise.allSettled([TextAttachmentStore.open(attachmentRoot), TextAttachmentStore.open(`${attachmentRoot}${path.sep}`)]);
    const winners = opened.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    stores.push(...winners);
    expect(winners).toHaveLength(1);
    expect(opened.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const owner = winners[0];
    if (!owner) throw new Error('No attachment owner was admitted.');
    const receipt = await owner.upload(scope, upload('one live owner'));
    expect(await owner.consume(scope, receipt.attachmentId)).toBe('one live owner');
    expect(await readdir(attachmentRoot)).toEqual([path.basename(owner.directory)]);
  });

  it.each(['root-file', 'unknown-directory', 'unknown-file'] as const)('refuses %s before deleting any validated abandoned text', async (kind) => {
    const { attachmentRoot, directory, file, project } = await abandonedFixture();
    if (kind === 'root-file') await writeFile(path.join(attachmentRoot, 'not-store-owned'), 'preserve');
    else if (kind === 'unknown-directory') await mkdir(path.join(attachmentRoot, 'project-directory'));
    else await writeFile(path.join(directory, 'not-an-attachment'), 'preserve');
    await expect(TextAttachmentStore.open(attachmentRoot)).rejects.toThrow('Private attachment storage is unavailable.');
    expect(await readFile(file, 'utf8')).toBe('abandoned text');
    expect(await readFile(project, 'utf8')).toBe('project is not temporary context');
  });

  it.each(['file-count', 'file-size', 'directory-count'] as const)('fails closed at the abandoned %s bound without removing its sentinels', async (kind) => {
    const { attachmentRoot, directory, file, project } = await abandonedFixture();
    if (kind === 'file-count') {
      for (let index = 0; index < TEXT_ATTACHMENT_COUNT; index++) {
        await writeFile(path.join(directory, `ta1_${String(index).padStart(43, '0')}`), 'bounded', { mode: 0o600 });
      }
    } else if (kind === 'file-size') await writeFile(file, 'x'.repeat(TEXT_ATTACHMENT_BYTES + 1));
    else for (let index = 0; index < 32; index++) await mkdir(path.join(attachmentRoot, `text-${String(index).padStart(6, '0')}`), { mode: 0o700 });
    await expect(TextAttachmentStore.open(attachmentRoot)).rejects.toThrow('Private attachment storage is unavailable.');
    expect((await stat(file)).isFile()).toBe(true);
    expect(await readFile(project, 'utf8')).toBe('project is not temporary context');
  });

  it('rejects a replaced abandoned directory even when its open file still has the captured identity', async () => {
    const { root, attachmentRoot, directory, file, id, project } = await abandonedFixture();
    const moved = path.join(root, 'moved-original');
    const realOpen = fs.open.bind(fs);
    let replaced = false;
    const intercepted = vi.spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
      if (target === file && !replaced) {
        // Replace after the store's directory check but before its file open.
        // Windows cannot rename a parent with an already open child handle.
        // Opening through the new ancestor link still yields the original
        // real file identity; the post-open directory guard must refuse it.
        await rename(directory, moved);
        try {
          await symlink(moved, directory, process.platform === 'win32' ? 'junction' : 'dir');
          replaced = true;
        } catch (error) { await rename(moved, directory); throw error; }
      }
      return realOpen(target, flags, mode);
    });
    try {
      await expect(TextAttachmentStore.open(attachmentRoot)).rejects.toThrow('Private attachment storage is unavailable.');
      expect(replaced).toBe(true);
      expect(await readFile(path.join(moved, id), 'utf8')).toBe('abandoned text');
      expect(await readFile(project, 'utf8')).toBe('project is not temporary context');
    } finally {
      intercepted.mockRestore();
      if (replaced) {
        // Remove the junction/link itself, never recurse into its target.
        if (process.platform === 'win32') await fs.rmdir(directory); else await fs.unlink(directory);
        await rename(moved, directory);
      }
    }
  });

  it('rejects an abandoned-directory symlink without deleting its target', async () => {
    const { root, attachmentRoot, directory, file, project } = await abandonedFixture();
    const outside = path.join(root, 'outside');
    await mkdir(outside, { mode: 0o700 });
    const sentinel = path.join(outside, `ta1_${'b'.repeat(43)}`);
    await writeFile(sentinel, 'outside sentinel', { mode: 0o600 });
    await symlink(outside, path.join(attachmentRoot, 'text-D4e5F6'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(TextAttachmentStore.open(attachmentRoot)).rejects.toThrow('Private attachment storage is unavailable.');
    expect(await readFile(file, 'utf8')).toBe('abandoned text');
    expect(await readFile(sentinel, 'utf8')).toBe('outside sentinel');
    expect(await readFile(project, 'utf8')).toBe('project is not temporary context');
    expect((await stat(directory)).isDirectory()).toBe(true);
  });

  it('accepts 256 KiB of UTF-8 at the byte boundary, returns only an opaque scoped receipt, and consumes once', async () => {
    const { store } = await fixture();
    const data = 'é'.repeat(TEXT_ATTACHMENT_BYTES / 2);
    const receipt = await store.upload(scope, upload(data));
    expect(Buffer.byteLength(JSON.stringify(upload(data)))).toBeLessThan(TEXT_ATTACHMENT_REQUEST_BYTES);
    expect(receipt).toEqual({ attachmentId: expect.stringMatching(/^ta1_[A-Za-z0-9_-]{43}$/u),
      byteLength: TEXT_ATTACHMENT_BYTES, expiresAt: expect.any(Number) });
    expect(JSON.stringify(receipt)).not.toContain(data.slice(0, 12));
    const stored = await stat(path.join(store.directory, receipt.attachmentId));
    if (process.platform !== 'win32') {
      expect(stored.mode & 0o177).toBe(0); // no execute bits or group/other access
      expect((await stat(store.directory)).mode & 0o077).toBe(0);
    }
    expect(await store.consume(scope, receipt.attachmentId)).toBe(data);
    await expect(store.consume(scope, receipt.attachmentId)).rejects.toThrow();
  });

  it('prepares without consuming and validates the entire batch before deleting any draft', async () => {
    const { store } = await fixture();
    const first = await store.upload(scope, upload('first'));
    const second = await store.upload(scope, upload('second'));
    const foreign = await store.upload({ ...scope, clientId: 'other-tab' }, upload('foreign'));
    expect(await store.prepare(scope, [first.attachmentId, second.attachmentId])).toEqual(['first', 'second']);
    expect(await store.prepare(scope, [first.attachmentId])).toEqual(['first']);
    await expect(store.consumeMany(scope, [first.attachmentId, foreign.attachmentId])).rejects.toThrow();
    await expect(store.consumeMany(scope, [first.attachmentId, first.attachmentId])).rejects.toThrow();
    expect(await readdir(store.directory)).toHaveLength(3);
    expect(await store.consumeMany(scope, [first.attachmentId, second.attachmentId])).toEqual(['first', 'second']);
    expect(await store.consume({ ...scope, clientId: 'other-tab' }, foreign.attachmentId)).toBe('foreign');
  });

  it('holds a prepared batch through admission and consumes only confirmed acceptance', async () => {
    const { store } = await fixture();
    const first = await store.upload(scope, upload('first'));
    const second = await store.upload(scope, upload('second'));
    const ids = [first.attachmentId, second.attachmentId];
    let savedAssertion: () => void = () => { throw new Error('not prepared'); };
    const refusal = await store.withPrepared(scope, ids, async (texts, assertCurrent) => {
      expect(texts).toEqual(['first', 'second']); assertCurrent(); savedAssertion = assertCurrent;
      return { accepted: false, reason: 'combined prompt oversized' };
    });
    expect(refusal.accepted).toBe(false);
    expect(() => savedAssertion()).toThrow(); // A finished preparation is not a reusable capability.
    expect(await store.prepare(scope, ids)).toEqual(['first', 'second']);
    await expect(store.withPrepared(scope, ids, async (_texts, assertCurrent) => {
      assertCurrent(); throw new Error('admission rejected');
    })).rejects.toThrow('admission rejected');
    expect(await readdir(store.directory)).toHaveLength(2);
    const accepted = await store.withPrepared(scope, ids, async (texts, assertCurrent) => {
      expect(texts).toEqual(['first', 'second']); assertCurrent(); return { accepted: true };
    });
    expect(accepted.accepted).toBe(true);
    expect(await readdir(store.directory)).toEqual([]);
  });

  it('rejects duplicates and mixed-owner preparation before calling the admission callback', async () => {
    const { store } = await fixture();
    const first = await store.upload(scope, upload('first'));
    const foreign = await store.upload({ ...scope, clientId: 'foreign-tab' }, upload('foreign'));
    const run = vi.fn(async () => ({ accepted: true }));
    await expect(store.withPrepared(scope, [first.attachmentId, first.attachmentId], run)).rejects.toThrow();
    await expect(store.withPrepared(scope, [first.attachmentId, foreign.attachmentId], run)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    expect(await readdir(store.directory)).toHaveLength(2);
  });

  it('rechecks expiry synchronously at the final effect seam without destroying a refused draft', async () => {
    let now = 1_000;
    const { store } = await fixture(() => now);
    const receipt = await store.upload(scope, upload('draft'));
    let effects = 0;
    await expect(store.withPrepared(scope, [receipt.attachmentId], async (_texts, assertCurrent) => {
      now = receipt.expiresAt;
      assertCurrent(); // expiry reached while asynchronous admission was preparing
      effects += 1; return { accepted: true };
    })).rejects.toThrow();
    expect(effects).toBe(0);
    expect(await readdir(store.directory)).toHaveLength(1);
    await store.sweepExpired();
    expect(await readdir(store.directory)).toEqual([]);
  });

  it('serializes cancellation behind a held preparation without deleting its in-flight context', async () => {
    const { store } = await fixture();
    const receipt = await store.upload(scope, upload('draft'));
    let entered!: () => void;
    const running = new Promise<void>((resolve) => { entered = resolve; });
    let release!: (result: { accepted: boolean }) => void;
    const pending = store.withPrepared(scope, [receipt.attachmentId], async (_texts, assertCurrent) => {
      assertCurrent(); entered();
      return new Promise<{ accepted: boolean }>((resolve) => { release = resolve; });
    });
    await running;
    let canceled = false;
    const cancellation = store.cancel(scope, receipt.attachmentId).then(() => { canceled = true; });
    await Promise.resolve();
    expect(canceled).toBe(false);
    expect(await readdir(store.directory)).toHaveLength(1);
    release({ accepted: false });
    await pending; await cancellation;
    expect(canceled).toBe(true);
    expect(await readdir(store.directory)).toEqual([]);
  });

  it('refuses expired preparation and cleans only private temporary entries', async () => {
    let now = 1_000;
    const { root, store } = await fixture(() => now);
    const projectFile = path.join(root, 'project.txt');
    await writeFile(projectFile, 'project sentinel');
    const receipt = await store.upload(scope, upload('temporary'));
    now = receipt.expiresAt;
    await expect(store.prepare(scope, [receipt.attachmentId])).rejects.toThrow();
    expect(await readdir(store.directory)).toEqual([]);
    expect(await readFile(projectFile, 'utf8')).toBe('project sentinel');
  });

  it('rejects corrupted UTF-8 after upload without consuming any other batch member', async () => {
    const { store } = await fixture();
    const first = await store.upload(scope, upload('valid'));
    const second = await store.upload(scope, upload('a'));
    await writeFile(path.join(store.directory, second.attachmentId), Buffer.from([0xff]));
    await expect(store.consumeMany(scope, [first.attachmentId, second.attachmentId])).rejects.toThrow();
    expect(await store.consume(scope, first.attachmentId)).toBe('valid');
    // Cleanup can remove the fixed inode even though its untrusted contents are invalid.
    await store.cancel(scope, second.attachmentId);
  });

  it('rejects foreign client, principal, workspace, generation, session, and epoch without consuming the owner entry', async () => {
    const { store } = await fixture();
    const { attachmentId } = await store.upload(scope, upload('private context'));
    for (const foreign of [
      { principalId: 'bob' }, { clientId: 'browser-tab-2' },
      { workspaceId: '44444444-4444-4444-8444-444444444444' }, { workspaceGeneration: 3 },
      { sessionId: '55555555-5555-4555-8555-555555555555' },
      { serverEpoch: '66666666-6666-4666-8666-666666666666' },
    ]) {
      await expect(store.consume({ ...scope, ...foreign }, attachmentId)).rejects.toThrow();
      await expect(store.cancel({ ...scope, ...foreign }, attachmentId)).rejects.toThrow();
    }
    expect(await store.consume(scope, attachmentId)).toBe('private context');
  });

  it('rejects invalid UTF-8, oversized bytes, alternate base64, media, and client paths before storage', async () => {
    const { store } = await fixture();
    for (const input of [
      { contentType: 'text/plain', encoding: 'base64', data: Buffer.from([0xff]).toString('base64') },
      { contentType: 'text/plain', encoding: 'base64', data: Buffer.from([0xc3]).toString('base64') },
      upload('x'.repeat(TEXT_ATTACHMENT_BYTES + 1)),
      { contentType: 'text/plain', encoding: 'base64', data: 'YR==' },
      { contentType: 'image/png', encoding: 'base64', data: 'eA==' },
      { ...upload('hello'), path: '/etc/passwd' },
      { ...upload('hello'), path: 'C:\\Users\\victim\\secret.txt' },
      { ...upload('hello'), url: 'https://example.test/' },
      upload('\0'),
    ]) await expect(store.upload(scope, input)).rejects.toThrow();
    expect(textAttachmentInputSchema.safeParse({ ...upload('ok'), archive: true }).success).toBe(false);
    expect(await readdir(store.directory)).toEqual([]);
  });

  it('enforces count under concurrent writes and expires entries even if the clock goes backward', async () => {
    let now = 10_000;
    const { store } = await fixture(() => now);
    const settled = await Promise.allSettled(Array.from({ length: TEXT_ATTACHMENT_COUNT + 1 }, () => store.upload(scope, upload('a'))));
    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(TEXT_ATTACHMENT_COUNT);
    expect(await readdir(store.directory)).toHaveLength(TEXT_ATTACHMENT_COUNT);
    now += 300_001;
    await store.sweepExpired();
    expect(await readdir(store.directory)).toEqual([]);
    now = 1; // rollback cannot revive expired IDs
    const id = (settled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof store.upload>>>).value.attachmentId;
    await expect(store.consume(scope, id)).rejects.toThrow();
    const next = await store.upload(scope, upload('new'));
    expect(next.expiresAt).toBeGreaterThan(310_000);
  });

  it('cancels only the scoped draft, never project files or another draft', async () => {
    const { root, store } = await fixture();
    const project = path.join(root, 'project');
    await mkdir(project);
    const projectFile = path.join(project, 'notes.txt');
    await writeFile(projectFile, 'leave me alone');
    const first = await store.upload(scope, upload('draft 1'));
    await store.upload(scope, upload('draft 2'));
    const other = { ...scope, clientId: 'browser-tab-2' };
    const retained = await store.upload(other, upload('other'));
    await store.cancelDraft(scope);
    expect(await readdir(store.directory)).toHaveLength(1);
    await expect(store.consume(scope, first.attachmentId)).rejects.toThrow();
    expect(await store.consume(other, retained.attachmentId)).toBe('other');
    expect(await readFile(projectFile, 'utf8')).toBe('leave me alone');
  });

  it('refuses a symlink attachment root or replaced file, without reading or deleting its target', async () => {
    const { root, store } = await fixture();
    const receipt = await store.upload(scope, upload('safe'));
    const target = path.join(root, 'project-secret');
    await writeFile(target, 'SECRET');
    const staged = path.join(root, 'staged-original');
    await rename(path.join(store.directory, receipt.attachmentId), staged);
    try {
      try { await symlink(target, path.join(store.directory, receipt.attachmentId)); }
      catch (error) {
        // Some Windows runners lack file-symlink privilege. Replace the inode
        // with a regular file there; POSIX still exercises the symlink case.
        if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        await writeFile(path.join(store.directory, receipt.attachmentId), 'replacement');
      }
      await expect(store.consume(scope, receipt.attachmentId)).rejects.toThrow();
      await expect(store.cancelDraft(scope)).rejects.toThrow();
      expect(await readFile(target, 'utf8')).toBe('SECRET');
    } finally {
      await rm(path.join(store.directory, receipt.attachmentId), { force: true });
      await rename(staged, path.join(store.directory, receipt.attachmentId));
    }
    const linked = path.join(root, 'linked-attachments');
    await symlink(store.directory, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(TextAttachmentStore.open(linked)).rejects.toThrow();
    expect((await stat(target)).isFile()).toBe(true);
  }, 10_000); // Windows junction and private-DACL verification add two OS round trips.
});
