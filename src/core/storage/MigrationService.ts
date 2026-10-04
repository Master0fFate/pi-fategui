import { constants, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { FatePaths } from '../FatePaths';
import { OwnerLock, lockName, ownerRecordPath } from '../ownership/OwnerLock';
import { hostCheckoutLockRoot } from '../ownership/CheckoutOwnership';
import { withPrivateWindowsAclScope } from './WindowsPrivateAcl';
import { openFateDurableStore, verifyCompletedDurableImport, type FateDurableStore } from '../durable/FateDurableStore';
import { MIGRATED_NAMESPACES, readMigrationSource, type MigrationSource } from './MigrationSource';
import { assertMigrationPath, assertPrivateMigrationPath, exists, fingerprintMigrationFile, listMigrationFiles, migrationHash,
  overlaps, privateMigrationDirectory, readMigrationJson, syncMigrationDirectory, writeMigrationRecord, type MigrationFile } from './MigrationFiles';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const readySchema = z.object({ id: z.string().uuid(), digest }).strict();
const version = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/u).max(100);
const fileSchema = z.object({ name: z.string().min(1).max(32768), bytes: z.number().int().nonnegative().safe(), sha256: digest,
  device: z.string().max(100), inode: z.string().max(100), modified: z.number().finite() }).strict();
const planSchema = z.object({ format: z.literal(1), id: z.string().uuid(), host: z.string().min(1).max(500),
  sourceVersion: version, targetVersion: version, dataRoot: z.string().min(1).max(32768), sessionsRoot: z.string().min(1).max(32768),
  profileResource: z.string().min(1).max(32768), profileDevice: z.string().max(100), profileInode: z.string().max(100),
  backupRoot: z.string().min(1).max(32768), sourceDigest: digest,
  files: z.array(fileSchema).max(10_000), references: z.array(fileSchema).max(10_000),
  projects: z.array(z.object({ path: z.string().min(1).max(32768), device: z.string().max(100), inode: z.string().max(100) }).strict()).max(10_000),
  sessions: z.array(z.object({ key: digest, digest }).strict()).max(1_000), requiredBytes: z.number().int().nonnegative().safe(),
}).strict();
export type MigrationPlan = z.infer<typeof planSchema>;
export interface MigrationDryRun { readonly plan: MigrationPlan | null; readonly errors: readonly string[]; readonly notices: readonly string[] }
export type MigrationPhase = 'locked' | 'backup-complete' | 'session-imported' | 'import-finished' | 'staged' | 'before-activation' | 'activated' | 'before-rollback';
export interface MigrationOptions {
  /** Host composition only; this service must not be exposed as a generic remote-path RPC. */
  readonly paths: FatePaths;
  /** Explicit existing private directory, disjoint from all original and target data. */
  readonly backupRoot: string;
  readonly sourceVersion: string;
  readonly targetVersion: string;
  /** Trusted fault injection/diagnostic hook. Never supplied by a renderer or protocol request. */
  readonly checkpoint?: (phase: MigrationPhase) => void | Promise<void>;
}
export interface MigrationResult { readonly id: string; readonly status: 'activated'; readonly backup: string; readonly importedSessions: number; readonly sourceDigest: string }
const notices = [
  'Only queue, task and goal state is converted. Original session JSONL, Teams, worktrees and history remain unchanged.',
  'No credentials, project trust or permission grants are copied. Imported goals require fresh host authorization and review.',
  'Pending drafts are recovered for review; no Harness, scheduler, provider or tool is started by migration.',
  'Legacy queue slot 0 maps to primary slot 1, before existing slot 1 drafts. ID collisions or merged queue overflow block migration.',
  'Ownership locks exclude cooperating Fate v2 writers only. Stop Pi Terminal, older Fate and external writers separately.',
  'Rollback is refused after source or candidate changes; external effects cannot be undone by restoring application data.',
] as const;

/** Offline, same-host namespace conversion. Original data is never rewritten, removed, or restored over a writer. */
export class MigrationService {
  constructor(private readonly options: MigrationOptions) {
    if (!(options.paths instanceof FatePaths)) throw new Error('Migration requires host-created FatePaths.');
    version.parse(options.sourceVersion); version.parse(options.targetVersion);
  }
  private resource(): string { return this.options.paths.profileKind === 'server' ? path.dirname(this.options.paths.dataRoot) : this.options.paths.dataRoot; }
  private profileLock(): string { return path.join(this.options.paths.lockRoot, `profile-${lockName(this.resource())}.lock`); }
  private checkoutLock(project: string): string { return path.join(hostCheckoutLockRoot(), `checkout-${lockName(project)}.lock`); }
  private async locations(): Promise<void> {
    const { paths, backupRoot } = this.options;
    for (const target of [paths.dataRoot, this.resource(), backupRoot]) await assertPrivateMigrationPath(target, true);
    for (const target of [paths.sessionsRoot, paths.piAgentDir, paths.lockRoot, hostCheckoutLockRoot()]) await assertMigrationPath(target, true);
    if ([this.resource(), paths.piAgentDir, paths.sessionsRoot, paths.lockRoot, hostCheckoutLockRoot()].some((root) => overlaps(root, backupRoot))) throw new Error('Backup location overlaps source, target or ownership storage.');
    if (overlaps(paths.dataRoot, paths.sessionsRoot) || overlaps(this.resource(), paths.lockRoot)) throw new Error('Migration data and session/lock roots must be disjoint.');
    if (await exists(path.join(paths.dataRoot, 'session-permissions.intent.json'))) throw new Error('An unresolved permission transaction must be reviewed before migration.');
    await fs.access(backupRoot, constants.W_OK | constants.X_OK);
    await fs.access(paths.dataRoot, constants.W_OK | constants.X_OK);
  }
  private async preserved(source: MigrationSource): Promise<void> {
    // Record these untouched namespaces so applying or rolling back cannot discard
    // newer command uncertainty, permission writes or Team changes.
    for (const name of ['commands', 'lifecycle', 'agent-teams']) {
      for (const target of await listMigrationFiles(path.join(this.options.paths.dataRoot, name), true)) {
        source.references.push(await fingerprintMigrationFile(target, target));
      }
    }
    for (const name of ['session-permissions.json']) {
      const target = path.join(this.options.paths.dataRoot, name);
      if (await exists(target)) source.references.push(await fingerprintMigrationFile(target, target));
    }
    if (source.references.length > 10_000) throw new Error('Preserved namespace inventory exceeds its bound.');
    source.references.sort((a, b) => a.name.localeCompare(b.name));
  }
  private async observe(): Promise<MigrationSource & { combinedDigest: string }> {
    const source = await readMigrationSource(this.options.paths); await this.preserved(source);
    return { ...source, combinedDigest: migrationHash(JSON.stringify({ files: source.files, references: source.references, projects: source.projects, sessions: source.sessions })) };
  }
  private async space(bytes: number): Promise<void> {
    for (const target of [this.options.backupRoot, this.options.paths.dataRoot]) {
      const stat = await fs.statfs(target, { bigint: true });
      if (stat.bavail * stat.bsize < BigInt(bytes)) throw new Error('Insufficient free space for verified backup and staged native state.');
    }
  }
  async dryRun(): Promise<MigrationDryRun> {
    try {
      return await withPrivateWindowsAclScope(() => this.observeDryRun());
    } catch (error) { return { plan: null, errors: [error instanceof Error ? error.message : 'Migration preflight failed.'], notices }; }
  }
  private async observeDryRun(): Promise<MigrationDryRun> {
    await this.locations();
    if (await exists(this.profileLock())) throw new Error('Profile already in use or ownership is uncertain. Stop all owners; no stale lock is reclaimed.');
    if (await exists(path.join(this.options.paths.dataRoot, 'durable'))) throw new Error('A native namespace already exists; inspect its migration rather than overwriting it.');
    const source = await this.observe(); const errors = [...source.errors];
    for (const project of source.projects) {
      if (overlaps(project.path, this.options.backupRoot) || overlaps(project.path, this.options.paths.dataRoot)) errors.push('Migration storage must not overlap a project/worktree.');
      if (await exists(this.checkoutLock(project.path))) errors.push('A referenced checkout is owned or uncertain. Stop every owner before migration.');
    }
    if (errors.length) return { plan: null, errors, notices };
    const requiredBytes = source.files.reduce((sum, file) => sum + file.bytes, 0) * 4 + 32 * 1024 * 1024; await this.space(requiredBytes);
    const stat = await fs.stat(this.resource());
    const plan = planSchema.parse({ format: 1, id: randomUUID(), host: os.hostname(), sourceVersion: this.options.sourceVersion,
      targetVersion: this.options.targetVersion, dataRoot: this.options.paths.dataRoot, sessionsRoot: this.options.paths.sessionsRoot,
      profileResource: this.resource(), profileDevice: String(stat.dev), profileInode: String(stat.ino), backupRoot: this.options.backupRoot,
      sourceDigest: source.combinedDigest, files: source.files, references: source.references, projects: source.projects, sessions: source.sessions, requiredBytes });
    return { plan, errors: [], notices };
  }
  private validate(input: MigrationPlan): MigrationPlan {
    const plan = planSchema.parse(input);
    if (plan.host !== os.hostname() || plan.sourceVersion !== this.options.sourceVersion || plan.targetVersion !== this.options.targetVersion
      || plan.dataRoot !== this.options.paths.dataRoot || plan.sessionsRoot !== this.options.paths.sessionsRoot
      || plan.profileResource !== this.resource() || plan.backupRoot !== this.options.backupRoot) throw new Error('Migration plan belongs to another host, profile, path or application version.');
    return plan;
  }
  private async recheck(plan: MigrationPlan): Promise<MigrationSource> {
    await this.locations(); const stat = await fs.stat(this.resource());
    if (String(stat.dev) !== plan.profileDevice || String(stat.ino) !== plan.profileInode) throw new Error('Profile identity changed after dry run.');
    const source = await this.observe();
    if (source.errors.length || source.combinedDigest !== plan.sourceDigest
      || JSON.stringify(source.files) !== JSON.stringify(plan.files) || JSON.stringify(source.references) !== JSON.stringify(plan.references)
      || JSON.stringify(source.projects) !== JSON.stringify(plan.projects) || JSON.stringify(source.sessions) !== JSON.stringify(plan.sessions)) throw new Error('Migration source changed or is invalid; perform a fresh dry run.');
    return source;
  }
  private async own<T>(plan: MigrationPlan, operation: (owner: OwnerLock) => Promise<T>): Promise<T> {
    await this.locations();
    const owner = await OwnerLock.acquire(this.options.paths.lockRoot, 'profile', this.resource());
    const checkouts: OwnerLock[] = []; let retain = false;
    try {
      for (const project of plan.projects) {
        await assertMigrationPath(project.path); const stat = await fs.stat(project.path);
        if (!stat.isDirectory() || String(stat.dev) !== project.device || String(stat.ino) !== project.inode) throw new Error('Referenced checkout identity changed.');
        checkouts.push(await OwnerLock.acquire(hostCheckoutLockRoot(), 'checkout', project.path));
      }
      return await operation(owner);
    } catch (error) {
      // A failed native close may still own SQLite. Never admit another writer.
      retain = error instanceof MigrationCloseUncertain;
      throw error;
    } finally {
      // An unconfirmed native close keeps every lock for an operator, also after this process stops.
      if (retain) await Promise.allSettled([owner, ...checkouts].map((lock) => lock.requireOperatorReview()));
      if (!retain) {
        const results = await Promise.allSettled(checkouts.reverse().map((lock) => lock.release()));
        if (results.some((result) => result.status === 'rejected')) throw new Error('Migration checkout release is uncertain; profile ownership retained.');
        await owner.release();
      }
    }
  }
  private async assertOwner(owner: OwnerLock): Promise<void> {
    const record = z.object({ token: z.string(), resource: z.string() }).passthrough().parse(
      await readMigrationJson(ownerRecordPath(owner.lockPath, owner.record.token), 4096));
    if (record.token !== owner.record.token || record.resource !== owner.record.resource) throw new Error('Migration profile owner changed; mutation is fenced.');
  }
  private backup(plan: MigrationPlan): string { return path.join(plan.backupRoot, plan.id); }
  private staging(plan: MigrationPlan): string { return path.join(plan.dataRoot, 'migrations', plan.id); }
  private async ensureBackup(plan: MigrationPlan): Promise<void> {
    const backup = this.backup(plan); const manifest = path.join(backup, 'manifest.json');
    if (await exists(backup)) {
      if (!await exists(manifest)) throw new Error('An incomplete backup is retained; select a new dry-run migration ID after review.');
      if (JSON.stringify(await readMigrationJson(manifest, 8 * 1024 * 1024)) !== JSON.stringify(plan)) throw new Error('Backup manifest does not match this exact migration.');
    } else {
      await privateMigrationDirectory(backup);
      for (const file of plan.files) {
        const source = path.join(plan.dataRoot, file.name); const destination = path.join(backup, file.name);
        let directory = backup;
        for (const part of file.name.split('/').slice(0, -1)) {
          directory = path.join(directory, part);
          if (!await exists(directory)) await privateMigrationDirectory(directory);
        }
        await assertPrivateMigrationPath(source, false);
        await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
        await fs.chmod(destination, 0o600); await assertPrivateMigrationPath(destination, false);
        // Windows FlushFileBuffers requires write access. O_RDWR does not
        // truncate or alter the copy; keep the required durability barrier.
        const handle = await fs.open(destination, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
        try { await handle.sync(); } finally { await handle.close(); }
        const actual = await fingerprintMigrationFile(destination, file.name);
        if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) throw new Error('Private backup verification failed; original data is unchanged.');
        await syncMigrationDirectory(path.dirname(destination));
      }
      await writeMigrationRecord(manifest, plan);
    }
    const found = (await listMigrationFiles(backup)).map((target) => path.relative(backup, target).split(path.sep).join('/')).filter((name) => name !== 'manifest.json').sort();
    if (JSON.stringify(found) !== JSON.stringify(plan.files.map((file) => file.name).sort())) throw new Error('Backup file counts or namespace contents changed.');
    for (const file of plan.files) {
      const actual = await fingerprintMigrationFile(path.join(backup, file.name), file.name);
      if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new Error('Backup contents failed digest verification.');
    }
  }
  private async namespaceDigest(root: string): Promise<string> {
    const files: Array<Pick<MigrationFile, 'name' | 'bytes' | 'sha256'>> = [];
    for (const target of await listMigrationFiles(root)) {
      const file = await fingerprintMigrationFile(target, path.relative(root, target).split(path.sep).join('/'));
      files.push({ name: file.name, bytes: file.bytes, sha256: file.sha256 });
    }
    return migrationHash(JSON.stringify(files));
  }
  async apply(input: MigrationPlan): Promise<MigrationResult> {
    const plan = this.validate(input);
    return withPrivateWindowsAclScope(() => this.own(plan, async (owner) => {
      const source = await this.recheck(plan); await this.space(plan.requiredBytes); await this.options.checkpoint?.('locked'); await this.assertOwner(owner);
      await this.ensureBackup(plan); await this.options.checkpoint?.('backup-complete');
      const migrations = path.dirname(this.staging(plan));
      if (!await exists(migrations)) await privateMigrationDirectory(migrations); else await assertPrivateMigrationPath(migrations, true);
      const staging = this.staging(plan); const active = path.join(plan.dataRoot, 'durable');
      if (await exists(active)) {
        const marker = await readMigrationJson(path.join(active, 'migration.json'));
        if (JSON.stringify(marker) !== JSON.stringify(plan)) throw new Error('Existing native state belongs to another migration.');
        const ready = await readMigrationJson(path.join(staging, 'ready.json'));
        const parsed = z.object({ id: z.string().uuid(), digest }).strict().parse(ready);
        if (parsed.id !== plan.id || parsed.digest !== await this.namespaceDigest(active)) throw new Error('Activated native state changed; do not replay migration.');
        return { id: plan.id, status: 'activated', backup: this.backup(plan), importedSessions: plan.sessions.length, sourceDigest: plan.sourceDigest };
      }
      if (!await exists(staging)) await privateMigrationDirectory(staging); else await assertPrivateMigrationPath(staging, true);
      const stagedPlan = path.join(staging, 'plan.json');
      if (await exists(stagedPlan)) { if (JSON.stringify(await readMigrationJson(stagedPlan)) !== JSON.stringify(plan)) throw new Error('Staging belongs to another migration plan.'); }
      else await writeMigrationRecord(stagedPlan, plan);
      const stagedNative = path.join(staging, 'durable');
      const readyPath = path.join(staging, 'ready.json');
      const ready = await exists(readyPath) ? readySchema.parse(await readMigrationJson(readyPath)) : undefined;
      // Check the previously sealed bytes before opening SQLite. A retry must
      // never re-bless a changed candidate by replacing its original digest.
      if (ready && (ready.id !== plan.id || ready.digest !== await this.namespaceDigest(stagedNative))) throw new Error('Staged native state changed after sealing; candidate retained for review.');
      const importPlan = { requestId: plan.id, sourceDigest: plan.sourceDigest, sessions: plan.sessions };
      const verify = async (): Promise<boolean> => {
        try { return await verifyCompletedDurableImport({ dataRoot: staging, profileOwner: owner, importPlan, snapshots: source.snapshots }); }
        catch (cause) {
          if (cause instanceof AggregateError) throw new MigrationCloseUncertain('Native verification cleanup is uncertain; retain profile and checkout ownership.', { cause });
          throw cause;
        }
      };
      let store: FateDurableStore | undefined;
      try {
        let finished = false;
        try {
          if (await exists(path.join(staging, 'durable', 'v1', 'state.sqlite'))) {
            finished = await verify();
          }
          if (ready && !finished) throw new Error('Sealed native import is incomplete; candidate retained for review.');
          if (!finished) store = await openFateDurableStore({ dataRoot: staging, profileOwner: owner, mode: 'import', importPlan });
        } catch (cause) {
          if (cause instanceof AggregateError) throw new MigrationCloseUncertain('Native startup cleanup is uncertain; retain profile and checkout ownership.', { cause });
          throw cause;
        }
        if (store) {
          for (const snapshot of source.snapshots) { await store.importSessionSnapshot(plan.id, snapshot); await this.options.checkpoint?.('session-imported'); }
          await store.finishImport({ requestId: plan.id, sourceDigest: plan.sourceDigest, expectedSessions: plan.sessions.length });
          await this.options.checkpoint?.('import-finished');
        }
      } finally {
        if (store) try { await store.close(); } catch (cause) { throw new MigrationCloseUncertain('Native store close is uncertain; profile and checkout ownership retained.', { cause }); }
      }
      if (!await verify()) throw new Error('Native import is incomplete; candidate retained for review.');
      const marker = path.join(stagedNative, 'migration.json');
      if (await exists(marker)) {
        if (JSON.stringify(await readMigrationJson(marker)) !== JSON.stringify(plan)) throw new Error('Staged candidate migration identity mismatch.');
      } else await writeMigrationRecord(marker, plan);
      const stagedDigest = await this.namespaceDigest(stagedNative);
      if (ready) {
        if (ready.digest !== stagedDigest) throw new Error('Staged native state changed after sealing; candidate retained for review.');
      } else await writeMigrationRecord(readyPath, { id: plan.id, digest: stagedDigest });
      await this.options.checkpoint?.('staged'); await this.recheck(plan); await this.ensureBackup(plan);
      await this.options.checkpoint?.('before-activation');
      await this.recheck(plan); await assertPrivateMigrationPath(staging, true); await this.assertOwner(owner);
      const sealed = readySchema.parse(await readMigrationJson(readyPath));
      if (sealed.id !== plan.id || sealed.digest !== stagedDigest || stagedDigest !== await this.namespaceDigest(stagedNative)) throw new Error('Staged native state changed before activation; candidate retained for review.');
      if (await exists(active)) throw new Error('Native destination appeared before activation.');
      await fs.rename(path.join(staging, 'durable'), active); await syncMigrationDirectory(plan.dataRoot); await syncMigrationDirectory(staging);
      await this.options.checkpoint?.('activated');
      return { id: plan.id, status: 'activated', backup: this.backup(plan), importedSessions: plan.sessions.length, sourceDigest: plan.sourceDigest };
    }));
  }
  /** Conservative rollback: preserve candidate, expose untouched legacy namespaces, never restore over new work. */
  async rollback(input: MigrationPlan, matchedSourceVersion: string): Promise<{ status: 'rolled-back'; retainedNative: string }> {
    const plan = this.validate(input);
    if (matchedSourceVersion !== plan.sourceVersion) throw new Error('Rollback requires the exact original application version.');
    return withPrivateWindowsAclScope(() => this.own(plan, async (owner) => {
      await this.recheck(plan); await this.ensureBackup(plan);
      const active = path.join(plan.dataRoot, 'durable'); const retainedNative = path.join(this.staging(plan), 'rolled-back-durable');
      if (await exists(retainedNative) && !await exists(active)) {
        const marker = await readMigrationJson(path.join(retainedNative, 'migration.json'));
        if (JSON.stringify(marker) !== JSON.stringify(plan)) throw new Error('Retained candidate identity mismatch.');
        return { status: 'rolled-back', retainedNative };
      }
      if (JSON.stringify(await readMigrationJson(path.join(active, 'migration.json'))) !== JSON.stringify(plan)) throw new Error('Candidate migration identity mismatch.');
      const ready = z.object({ id: z.string().uuid(), digest }).strict().parse(await readMigrationJson(path.join(this.staging(plan), 'ready.json')));
      if (ready.id !== plan.id || ready.digest !== await this.namespaceDigest(active)) throw new Error('Candidate changed after activation; reconcile outcomes before rollback.');
      await this.options.checkpoint?.('before-rollback');
      await this.recheck(plan); await this.assertOwner(owner);
      if (ready.digest !== await this.namespaceDigest(active)) throw new Error('Candidate changed before rollback.');
      if (await exists(retainedNative)) throw new Error('A retained candidate already exists; no overwrite is permitted.');
      await fs.rename(active, retainedNative); await syncMigrationDirectory(plan.dataRoot); await syncMigrationDirectory(this.staging(plan));
      return { status: 'rolled-back', retainedNative };
    }));
  }
}
class MigrationCloseUncertain extends Error {}

/** Documents the only source namespaces selected by this version. No arbitrary glob or whole-home copy. */
export const nativeMigrationNamespaces: readonly string[] = MIGRATED_NAMESPACES;
