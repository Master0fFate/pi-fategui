import { randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assertPrivateWindowsAcl, assertPrivateWindowsTree } from '../storage/WindowsPrivateAcl';
import {
  attachmentScopeSchema, textAttachmentIdSchema, textAttachmentInputSchema, textAttachmentReceiptSchema,
  TEXT_ATTACHMENT_BYTES, TEXT_ATTACHMENT_COUNT, TEXT_ATTACHMENT_REQUEST_BYTES,
  TEXT_ATTACHMENT_TOTAL_BYTES, TEXT_ATTACHMENT_TTL_MS,
  type AttachmentScope, type TextAttachmentReceipt,
} from '../../shared/protocol/attachments';

type Entry = { readonly scope: string; readonly length: number; readonly expiresAt: number; readonly dev: number; readonly ino: number };
const unavailable = () => new Error('Private attachment storage is unavailable.');
const invalid = () => new Error('Invalid or unavailable text attachment.');

const activeRoots = new Set<string>();
const rootKey = (root: string) => `path:${process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root)}`;
const MAX_ABANDONED_DIRECTORIES = 32;

async function privateDirectory(directory: string, verifyAcl = true): Promise<Stats> {
  const stat = await fs.lstat(directory).catch(() => { throw unavailable(); });
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw unavailable();
  // Check NTFS DACL at creation. Subsequent operations recheck path type and
  // file identity; invoking PowerShell for every read is not an authority check
  // against a malicious process running as the same user.
  if (verifyAcl) await assertPrivateWindowsAcl(directory).catch(() => { throw unavailable(); });
  return stat;
}

async function sameDirectory(directory: string, expected: Stats): Promise<void> {
  const current = await privateDirectory(directory, false);
  if (current.dev !== expected.dev || current.ino !== expected.ino) throw unavailable();
}
function privateFile(stat: Stats): boolean {
  // A process can die after exclusive creation but before writing all bytes.
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= TEXT_ATTACHMENT_BYTES
    && (process.platform === 'win32' || (stat.mode & 0o177) === 0);
}
function sameFile(current: Stats, expected: Stats): boolean {
  return privateFile(current) && current.dev === expected.dev && current.ino === expected.ino && current.size === expected.size;
}

/** The caller already holds the sole profile-owner lock. Attachment IDs and
 * drafts are instance-only, so bytes from a dead owner must not survive restart.
 * Inventory first, with finite limits; never recursively remove unknown paths. */
async function reclaimAbandoned(root: string): Promise<void> {
  const rootIdentity = await privateDirectory(root, false);
  const abandoned: { directory: string; identity: Stats; files: { target: string; identity: Stats }[] }[] = [];
  for await (const entry of await fs.opendir(root)) {
    if (abandoned.length >= MAX_ABANDONED_DIRECTORIES || !/^text-[A-Za-z0-9]{6}$/u.test(entry.name)
      || !entry.isDirectory() || entry.isSymbolicLink()) throw unavailable();
    const directory = path.join(root, entry.name);
    const identity = await privateDirectory(directory, false);
    const files: { target: string; identity: Stats }[] = [];
    let bytes = 0;
    for await (const file of await fs.opendir(directory)) {
      if (files.length >= TEXT_ATTACHMENT_COUNT || !textAttachmentIdSchema.safeParse(file.name).success
        || !file.isFile() || file.isSymbolicLink()) throw unavailable();
      const target = path.join(directory, file.name);
      const fileIdentity = await fs.lstat(target).catch(() => { throw unavailable(); });
      if (!privateFile(fileIdentity)) throw unavailable();
      bytes += fileIdentity.size;
      if (bytes > TEXT_ATTACHMENT_TOTAL_BYTES) throw unavailable();
      files.push({ target, identity: fileIdentity });
    }
    abandoned.push({ directory, identity, files });
  }
  // Existing descendants can have explicit DACLs. Validate them before deleting
  // any inventory member, not only the inherited private parent.
  if (abandoned.length) await assertPrivateWindowsTree(root).catch(() => { throw unavailable(); });
  for (const old of abandoned) {
    for (const file of old.files) {
      await sameDirectory(root, rootIdentity); await sameDirectory(old.directory, old.identity);
      const handle = await fs.open(file.target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => { throw unavailable(); });
      try { if (!sameFile(await handle.stat(), file.identity)) throw unavailable(); }
      finally { await handle.close(); }
      await sameDirectory(root, rootIdentity); await sameDirectory(old.directory, old.identity);
      if (!sameFile(await fs.lstat(file.target).catch(() => { throw unavailable(); }), file.identity)) throw unavailable();
      await fs.unlink(file.target); // Fixed opaque basename, not a recursive target.
    }
    await sameDirectory(root, rootIdentity); await sameDirectory(old.directory, old.identity);
    await fs.rmdir(old.directory); // New/unexpected entries refuse removal.
  }
}

/** In-memory, host-only temporary text. No file path or text enters a network receipt.
 * The caller holds sole cross-process profile ownership and passes its own private
 * attachmentRoot (never a request field). Duplicate in-process owners are refused.
 * Startup reclaims only validated dead-owner text; project files are never targets. */
export class TextAttachmentStore {
  private readonly entries = new Map<string, Entry>();
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  private highWater = 0;

  private constructor(readonly directory: string, private readonly root: string, private readonly clock: () => number,
    private readonly ownershipKeys: readonly string[]) {}

  static async open(attachmentRoot: string, clock: () => number = Date.now): Promise<TextAttachmentStore> {
    if (!path.isAbsolute(attachmentRoot) || path.normalize(attachmentRoot) !== attachmentRoot || attachmentRoot.includes('\0')) throw unavailable();
    const key = rootKey(attachmentRoot);
    if (activeRoots.has(key)) throw unavailable();
    activeRoots.add(key);
    const ownershipKeys = [key];
    let opened = false;
    try {
      const parent = path.dirname(attachmentRoot);
      await privateDirectory(parent);
      // Reject any symlink in the host-supplied parent path, not just its leaf.
      const canonical = await fs.realpath(parent).catch(() => { throw unavailable(); });
      const equal = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
      if (!equal(path.resolve(canonical), path.resolve(parent))) throw unavailable();
      let existingRoot = false;
      try { await fs.mkdir(attachmentRoot, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable(); existingRoot = true; }
      // A newly created child inherits the ACL of the verified private parent.
      // Verify an existing child because it may have an independent explicit DACL.
      await privateDirectory(attachmentRoot, existingRoot);
      // Physical identity also fences accepted filesystem aliases (for example
      // a Windows short-name spelling). Reserve synchronously after the await.
      const physical = await fs.lstat(attachmentRoot, { bigint: true });
      if (!physical.isDirectory() || physical.isSymbolicLink()) throw unavailable();
      const physicalKey = `inode:${physical.dev}:${physical.ino}`;
      if (activeRoots.has(physicalKey)) throw unavailable();
      activeRoots.add(physicalKey); ownershipKeys.push(physicalKey);
      await reclaimAbandoned(attachmentRoot);
      const directory = await fs.mkdtemp(path.join(attachmentRoot, 'text-')).catch(() => { throw unavailable(); });
      try {
        await privateDirectory(directory, false);
        opened = true;
        return new TextAttachmentStore(directory, attachmentRoot, clock, Object.freeze(ownershipKeys));
      } catch (error) { await fs.rmdir(directory).catch(() => undefined); throw error; }
    } finally { if (!opened) for (const captured of ownershipKeys) activeRoots.delete(captured); }
  }

  private at(): number {
    const time = this.clock();
    if (!Number.isSafeInteger(time) || time < 0) throw unavailable();
    this.highWater = Math.max(this.highWater, time); // A clock rollback cannot extend a prior expiry.
    return this.highWater;
  }

  private async guard(): Promise<void> {
    await privateDirectory(this.root, false);
    await privateDirectory(this.directory, false);
  }

  /** Serialize quota, writes, reads, and cleanup. A failed operation does not poison the queue. */
  private locked<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(async () => {
      if (this.closed) throw unavailable();
      await this.guard();
      return action();
    });
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private file(id: string): string { return path.join(this.directory, id); }
  private async checked(id: string, entry: Entry): Promise<import('node:fs/promises').FileHandle> {
    const target = this.file(id);
    const before = await fs.lstat(target).catch(() => { throw unavailable(); });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== entry.length
      || before.dev !== entry.dev || before.ino !== entry.ino
      || (process.platform !== 'win32' && (before.mode & 0o177) !== 0)) throw unavailable();
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => { throw unavailable(); });
    try {
      const live = await handle.stat();
      if (!live.isFile() || live.nlink !== 1 || live.size !== entry.length || live.dev !== entry.dev || live.ino !== entry.ino) throw unavailable();
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }

  private async remove(id: string, entry: Entry): Promise<void> {
    const handle = await this.checked(id, entry);
    await handle.close();
    // Unlink the fixed, random basename only. Never recurse into an attacker path.
    await fs.unlink(this.file(id));
    this.entries.delete(id);
  }

  private async expire(now: number): Promise<void> {
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) await this.remove(id, entry);
  }

  async upload(scope: AttachmentScope, input: unknown): Promise<TextAttachmentReceipt> {
    const owner = JSON.stringify(attachmentScopeSchema.parse(scope));
    const parsed = textAttachmentInputSchema.parse(input);
    if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') >= TEXT_ATTACHMENT_REQUEST_BYTES) throw invalid();
    const bytes = Buffer.from(parsed.data, 'base64');
    if (!bytes.length || bytes.length > TEXT_ATTACHMENT_BYTES || bytes.toString('base64') !== parsed.data) throw invalid();
    // Fatal decoding rejects malformed UTF-8, including unpaired continuation bytes.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw invalid();
    return this.locked(async () => {
      const now = this.at();
      await this.expire(now);
      const total = [...this.entries.values()].reduce((size, item) => size + item.length, 0);
      if (this.entries.size >= TEXT_ATTACHMENT_COUNT || total + bytes.length > TEXT_ATTACHMENT_TOTAL_BYTES) throw invalid();
      const expiresAt = now + TEXT_ATTACHMENT_TTL_MS;
      if (!Number.isSafeInteger(expiresAt)) throw invalid();
      const id = `ta1_${randomBytes(32).toString('base64url')}`;
      const target = this.file(id);
      const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
        .catch(() => { throw unavailable(); });
      try {
        await handle.writeFile(bytes);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== bytes.length || (process.platform !== 'win32' && (stat.mode & 0o177) !== 0)) throw unavailable();
        // This exclusively created file inherits the private directory's ACL.
        // The inode and nlink are pinned for every later read or deletion.
        const receipt = textAttachmentReceiptSchema.parse({ attachmentId: id, byteLength: bytes.length, expiresAt });
        this.entries.set(id, { scope: owner, length: bytes.length, expiresAt, dev: stat.dev, ino: stat.ino });
        return receipt;
      } catch (error) { await fs.unlink(target).catch(() => undefined); throw error; }
      finally { await handle.close(); }
    });
  }

  private async readEntry(id: string, entry: Entry): Promise<string> {
    const handle = await this.checked(id, entry);
    try {
      const bytes = Buffer.alloc(entry.length + 1);
      let position = 0;
      // FileHandle.read can return short reads. Never silently truncate context.
      while (position < bytes.length) {
        const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position);
        if (bytesRead === 0) break;
        position += bytesRead;
      }
      if (position !== entry.length) throw unavailable();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, position));
      if (text.includes('\0')) throw invalid();
      return text;
    } finally { await handle.close(); }
  }

  private async batch(scope: AttachmentScope, attachmentIds: readonly string[], consume: boolean): Promise<readonly string[]> {
    const owner = JSON.stringify(attachmentScopeSchema.parse(scope));
    if (attachmentIds.length > TEXT_ATTACHMENT_COUNT || new Set(attachmentIds).size !== attachmentIds.length) throw invalid();
    const ids = attachmentIds.map((id) => textAttachmentIdSchema.parse(id));
    return this.locked(async () => {
      await this.expire(this.at());
      // Validate every owner before reading or deleting any member of the batch.
      const entries = ids.map((id) => {
        const entry = this.entries.get(id);
        if (!entry || entry.scope !== owner) throw invalid();
        return { id, entry };
      });
      const texts: string[] = [];
      for (const { id, entry } of entries) texts.push(await this.readEntry(id, entry));
      if (consume) for (const { id, entry } of entries) await this.remove(id, entry);
      return texts;
    });
  }

  /** Hold draft ownership across admission. The callback must not call this store recursively.
   * assertCurrent belongs at the final SDK effect seam alongside the host's authority check.
   * Rejection/throw preserves every ID; only confirmed acceptance consumes the batch. */
  async withPrepared<T extends { accepted: boolean }>(scope: AttachmentScope, attachmentIds: readonly string[],
    run: (texts: readonly string[], assertCurrent: () => void) => Promise<T>): Promise<T> {
    const owner = JSON.stringify(attachmentScopeSchema.parse(scope));
    if (attachmentIds.length > TEXT_ATTACHMENT_COUNT || new Set(attachmentIds).size !== attachmentIds.length) throw invalid();
    const ids = attachmentIds.map((id) => textAttachmentIdSchema.parse(id));
    return this.locked(async () => {
      await this.expire(this.at());
      const entries = ids.map((id) => {
        const entry = this.entries.get(id);
        if (!entry || entry.scope !== owner) throw invalid();
        return { id, entry };
      });
      let active = true;
      const assertCurrent = () => {
        if (!active || this.closed) throw invalid();
        const now = this.at();
        for (const { id, entry } of entries) {
          if (this.entries.get(id) !== entry || entry.scope !== owner || entry.expiresAt <= now) throw invalid();
        }
      };
      try {
        const texts: string[] = [];
        for (const { id, entry } of entries) texts.push(await this.readEntry(id, entry));
        assertCurrent();
        const result = await run(Object.freeze(texts), assertCurrent);
        if (result.accepted === true) for (const { id, entry } of entries) await this.remove(id, entry);
        return result;
      } finally { active = false; }
    });
  }

  /** Admission preparation never destroys the draft. The caller must reauthorize after this await. */
  prepare(scope: AttachmentScope, attachmentIds: readonly string[]): Promise<readonly string[]> {
    return this.batch(scope, attachmentIds, false);
  }

  /** Validate/read the entire batch before consuming any entry. Filesystem failure still fails closed. */
  consumeMany(scope: AttachmentScope, attachmentIds: readonly string[]): Promise<readonly string[]> {
    return this.batch(scope, attachmentIds, true);
  }

  /** One-use host read; recheck admission before consuming. */
  async consume(scope: AttachmentScope, attachmentId: string): Promise<string> {
    return (await this.consumeMany(scope, [attachmentId]))[0]!;
  }

  async cancel(scope: AttachmentScope, attachmentId: string): Promise<void> {
    const owner = JSON.stringify(attachmentScopeSchema.parse(scope));
    const id = textAttachmentIdSchema.parse(attachmentId);
    await this.locked(async () => {
      await this.expire(this.at());
      const entry = this.entries.get(id);
      if (!entry || entry.scope !== owner) throw invalid();
      await this.remove(id, entry);
    });
  }

  /** Cancel a draft without knowing each ID. Other principals and sessions remain untouched. */
  async cancelDraft(scope: AttachmentScope): Promise<void> {
    const owner = JSON.stringify(attachmentScopeSchema.parse(scope));
    await this.locked(async () => {
      await this.expire(this.at());
      for (const [id, entry] of this.entries) if (entry.scope === owner) await this.remove(id, entry);
    });
  }

  async sweepExpired(): Promise<void> { await this.locked(async () => { await this.expire(this.at()); }); }

  async close(): Promise<void> {
    await this.locked(async () => {
      for (const [id, entry] of this.entries) await this.remove(id, entry);
      await fs.rmdir(this.directory); // Unexpected files block cleanup instead of recursive deletion.
      this.closed = true;
      for (const captured of this.ownershipKeys) activeRoots.delete(captured);
    });
  }
}
