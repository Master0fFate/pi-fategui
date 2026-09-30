import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { FatePaths } from '../../core/FatePaths';
import { assertPrivateWindowsAcl, assertPrivateWindowsTree } from '../../core/storage/WindowsPrivateAcl';
import { ProtocolFault } from '../../shared/protocol/errors';

const hex = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().uuid();
const time = z.number().int().safe().nonnegative();
const clientSchema = z.object({ id, digest: hex, scope: z.array(hex).min(1).max(8), issuedAt: time, expiresAt: time }).strict()
  .refine((value) => value.expiresAt > value.issuedAt);
const codeSchema = z.object({ digest: hex, scope: z.array(hex).min(1).max(8), issuedAt: time, expiresAt: time }).strict()
  .refine((value) => value.expiresAt > value.issuedAt);
const sessionSchema = z.object({ id, digest: hex, scope: z.array(hex).min(1).max(8), issuedAt: time, expiresAt: time }).strict()
  .refine((value) => value.expiresAt > value.issuedAt);
const failureSchema = z.object({ peer: hex, at: z.array(time).max(5) }).strict();
const stateSchema = z.object({ version: z.literal(1), ownerDigest: hex, highWater: time,
  clients: z.array(clientSchema).max(128), codes: z.array(codeSchema).max(64), sessions: z.array(sessionSchema).max(32),
  failures: z.array(failureSchema).max(64),
}).strict().superRefine((state, context) => {
  const unique = (items: readonly string[]): boolean => new Set(items).size === items.length;
  if (!unique(state.clients.map((item) => item.id)) || !unique(state.clients.map((item) => item.digest))
    || !unique(state.codes.map((item) => item.digest)) || !unique(state.sessions.map((item) => item.id))
    || !unique(state.sessions.map((item) => item.digest)) || !unique(state.failures.map((item) => item.peer))
    || state.clients.some((item) => item.issuedAt > state.highWater || !unique(item.scope))
    || state.codes.some((item) => item.issuedAt > state.highWater || !unique(item.scope))
    || state.sessions.some((item) => item.issuedAt > state.highWater || !unique(item.scope))
    || state.failures.some((item) => item.at.some((at) => at > state.highWater))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid authentication record.' });
  }
});
export type AuthState = z.infer<typeof stateSchema>;

const MAX_STATE_BYTES = 128 * 1024;
const MAX_OWNER_BYTES = 96;
const tokenPattern = /^fo1_[A-Za-z0-9_-]{43}$/u;
const fail = (): ProtocolFault => new ProtocolFault('STORAGE_UNAVAILABLE');

/** Domain-separated digests; a token from one credential kind cannot match another kind. */
export function credentialDigest(kind: 'owner' | 'client' | 'code' | 'session' | 'workspace' | 'peer', value: string): string {
  return createHash('sha256').update(`fate-auth-v1:${kind}:`).update(value).digest('hex');
}
export function freshCredential(prefix: 'fo1' | 'fc1' | 'fb1' | 'fs1'): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}
function equalsHex(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
function filePath(paths: FatePaths): string {
  if (paths.profileKind !== 'server' || path.basename(paths.dataRoot) !== 'data') throw fail();
  return path.join(path.dirname(paths.dataRoot), 'credentials', 'v1');
}
/** Host-local owner-key location; never include this path in status, capabilities or errors. */
export function ownerCredentialPath(paths: FatePaths): string { return path.join(filePath(paths), 'owner.key'); }

/** CLI-only read of the existing host key. It never creates a profile or runtime. */
export async function readHostOwnerCredential(paths: FatePaths): Promise<string> {
  const root = filePath(paths);
  const dir = await fs.lstat(root).catch(() => { throw fail(); });
  if (!dir.isDirectory() || dir.isSymbolicLink() || (process.platform !== 'win32' && (dir.mode & 0o077) !== 0)) throw fail();
  await assertPrivateWindowsTree(root).catch(() => { throw fail(); });
  const owner = await checkedFile(path.join(root, 'owner.key'), MAX_OWNER_BYTES, false);
  const raw = await checkedFile(path.join(root, 'auth.json'), MAX_STATE_BYTES, false);
  if (owner === null || raw === null || !tokenPattern.test(owner)) throw fail();
  let parsed: ReturnType<typeof stateSchema.safeParse>;
  try { parsed = stateSchema.safeParse(JSON.parse(raw)); } catch { throw fail(); }
  if (!parsed.success || !equalsHex(parsed.data.ownerDigest, credentialDigest('owner', owner))) throw fail();
  return owner;
}

/** Desktop main alone supplies this approved reference path. Never accept it from
 * the renderer or an API body. Explicit import only; no automatic Pi/Home copy. */
export async function writeClientCredentialReference(approvedPath: string, credential: string): Promise<void> {
  if (!path.isAbsolute(approvedPath) || path.normalize(approvedPath) !== approvedPath
    || !/^fc1_[A-Za-z0-9_-]{43}$/u.test(credential)) throw new ProtocolFault('INVALID_REQUEST');
  const parent = path.dirname(approvedPath);
  const stat = await fs.lstat(parent).catch(() => { throw fail(); });
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw fail();
  await assertPrivateWindowsAcl(parent).catch(() => { throw fail(); });
  await writePrivate(approvedPath, credential, true);
}
export async function readClientCredentialReference(approvedPath: string): Promise<string> {
  if (!path.isAbsolute(approvedPath) || path.normalize(approvedPath) !== approvedPath) throw new ProtocolFault('INVALID_REQUEST');
  const parent = await fs.lstat(path.dirname(approvedPath)).catch(() => { throw fail(); });
  if (!parent.isDirectory() || parent.isSymbolicLink() || (process.platform !== 'win32' && (parent.mode & 0o077) !== 0)) throw fail();
  await assertPrivateWindowsAcl(path.dirname(approvedPath)).catch(() => { throw fail(); });
  const credential = await checkedFile(approvedPath, MAX_OWNER_BYTES);
  if (!credential || !/^fc1_[A-Za-z0-9_-]{43}$/u.test(credential)) throw fail();
  return credential;
}

async function checkedDirectory(directory: string): Promise<void> {
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw fail(); }
  const stat = await fs.lstat(directory).catch(() => { throw fail(); });
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw fail();
}
async function checkedFile(target: string, maxBytes: number, verifyAcl = true): Promise<string | null> {
  let before;
  try { before = await fs.lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw fail(); }
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maxBytes
    || (process.platform !== 'win32' && (before.mode & 0o077) !== 0)) throw fail();
  if (verifyAcl) await assertPrivateWindowsAcl(target).catch(() => { throw fail(); });
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => { throw fail(); });
  try {
    const live = await handle.stat();
    if (!live.isFile() || live.size !== before.size || (process.platform !== 'win32' && (live.dev !== before.dev || live.ino !== before.ino))) throw fail();
    const bytes = Buffer.alloc(maxBytes + 1);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== before.size) throw fail();
    return bytes.toString('utf8', 0, read.bytesRead);
  } catch { throw fail(); }
  finally { await handle.close(); }
}
async function syncDirectory(directory: string): Promise<void> {
  try { const handle = await fs.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
  catch (error) {
    // Windows does not expose directory fsync. A same-filesystem rename remains atomic,
    // but a power cut can still lose a recently acknowledged directory entry.
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw fail();
  }
}
async function writePrivate(target: string, text: string, exclusive: boolean): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    // Never replace an existing symlink, directory or non-private file.
    if (!exclusive && await checkedFile(target, MAX_STATE_BYTES, false) === null) throw fail();
    if (exclusive) { await fs.link(temporary, target); await fs.unlink(temporary); }
    else await fs.rename(temporary, target);
    await syncDirectory(path.dirname(target));
  } catch { throw fail(); }
  finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
}

/**
 * Profile-owner-lock protected store. Call open only after the host core owns its
 * profile lock; neither this store nor the path constructor creates provider dataRoot.
 * All persistent exchanges are serialized and replaced before a result is issued.
 */
export class AuthStore {
  private state: AuthState;
  private owner: string;
  private tail: Promise<void> = Promise.resolve();
  private latestNow: number;
  private blocked = false;
  private readonly blockedListeners = new Set<() => void>();

  private constructor(private readonly root: string, state: AuthState, owner: string, private readonly clock: () => number) {
    this.state = state;
    this.owner = owner;
    this.latestNow = state.highWater;
  }

  static async open(paths: FatePaths, options: { readonly now?: () => number } = {}): Promise<AuthStore> {
    const root = filePath(paths);
    // The core's profile lock precedes this creation. Do not create dataRoot here.
    await checkedDirectory(path.dirname(paths.dataRoot));
    await checkedDirectory(path.dirname(root));
    await checkedDirectory(root);
    // New files inherit this verified credential-directory DACL. Existing
    // secret files are checked separately before any credential is issued.
    await assertPrivateWindowsTree(root).catch(() => { throw fail(); });
    const ownerPath = path.join(root, 'owner.key');
    const statePath = path.join(root, 'auth.json');
    const now = options.now ?? Date.now;
    let owner = await checkedFile(ownerPath, MAX_OWNER_BYTES, false);
    let rawState = await checkedFile(statePath, MAX_STATE_BYTES, false);
    if (owner === null && rawState === null) {
      const initial = now();
      if (!Number.isSafeInteger(initial) || initial < 0) throw new ProtocolFault('CLOCK_SKEW');
      owner = freshCredential('fo1');
      const state: AuthState = { version: 1, ownerDigest: credentialDigest('owner', owner), highWater: initial,
        clients: [], codes: [], sessions: [], failures: [] };
      // Partial creation is retained and refuses the next startup. Never
      // silently regenerate a secret after a crash or ambiguous write.
      await writePrivate(ownerPath, owner, true);
      await writePrivate(statePath, JSON.stringify(state), true);
      await assertPrivateWindowsTree(root).catch(() => { throw fail(); });
      await checkedFile(ownerPath, MAX_OWNER_BYTES, false);
      await checkedFile(statePath, MAX_STATE_BYTES, false);
      rawState = JSON.stringify(state);
    }
    if (owner === null || rawState === null || !tokenPattern.test(owner)) throw fail();
    let state: ReturnType<typeof stateSchema.safeParse>;
    try { state = stateSchema.safeParse(JSON.parse(rawState)); } catch { throw fail(); }
    if (!state.success || !equalsHex(state.data.ownerDigest, credentialDigest('owner', owner))) throw fail();
    return new AuthStore(root, state.data, owner, now);
  }

  onBlocked(listener: () => void): () => void {
    this.blockedListeners.add(listener);
    return () => { this.blockedListeners.delete(listener); };
  }
  /** Shut down authentication before releasing the profile lock. */
  close(): void { this.block(); }
  private block(): void {
    if (this.blocked) return;
    this.blocked = true;
    for (const listener of this.blockedListeners) { try { listener(); } catch { /* Never let a transport callback reopen admissions. */ } }
  }
  private tick(): number {
    if (this.blocked) throw fail();
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0 || now < this.latestNow) throw new ProtocolFault('CLOCK_SKEW');
    this.latestNow = now;
    return now;
  }
  now(): number { return this.tick(); }
  snapshot(): Readonly<AuthState> { this.tick(); return structuredClone(this.state); }
  ownerMatches(secret: string): boolean {
    this.tick();
    return typeof secret === 'string' && tokenPattern.test(secret)
      && equalsHex(this.state.ownerDigest, credentialDigest('owner', secret));
  }
  csrfFor(sessionDigest: string): string {
    this.tick();
    return `fx1_${createHmac('sha256', this.owner).update('fate-auth-v1:csrf:').update(sessionDigest).digest('base64url')}`;
  }
  /** Queued write; even two simultaneous exchanges see the new state in order. */
  transaction<T>(work: (draft: AuthState, now: number) => T): Promise<T> {
    const operation = this.tail.then(async () => {
      const now = this.tick();
      const draft = structuredClone(this.state);
      const value = work(draft, now);
      draft.highWater = this.latestNow;
      const parsed = stateSchema.safeParse(draft);
      if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > MAX_STATE_BYTES) throw fail();
      try { await writePrivate(path.join(this.root, 'auth.json'), JSON.stringify(parsed.data), false); }
      catch { this.block(); throw fail(); }
      this.state = parsed.data;
      return value;
    });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
  /** Owner rotation is two durable writes; disagreement after a crash blocks all auth on restart. */
  rotateOwner(newOwner: string, currentOwner: string): Promise<void> {
    const operation = this.tail.then(async () => {
      const now = this.tick();
      if (!this.ownerMatches(currentOwner)) throw new ProtocolFault('UNAUTHENTICATED');
      if (!tokenPattern.test(newOwner)) throw new ProtocolFault('INVALID_REQUEST');
      const replacement: AuthState = { version: 1, ownerDigest: credentialDigest('owner', newOwner),
        highWater: now, clients: [], codes: [], sessions: [], failures: [] };
      try {
        await writePrivate(path.join(this.root, 'auth.json'), JSON.stringify(replacement), false);
        // Existing owner file is checked before replacement, and the new file is
        // synced. A crash between writes leaves a mismatch: fail closed.
        const target = path.join(this.root, 'owner.key');
        if (await checkedFile(target, MAX_OWNER_BYTES) === null) throw fail();
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
          const handle = await fs.open(temporary, 'wx', 0o600);
          try { await handle.writeFile(newOwner); await handle.sync(); } finally { await handle.close(); }
          await fs.rename(temporary, target);
          await syncDirectory(this.root);
        } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
        this.owner = newOwner;
        this.state = replacement;
      } catch { this.block(); throw fail(); }
    });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
