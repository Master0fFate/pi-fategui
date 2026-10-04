import { constants, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import packageMetadata from '../../package.json';
import { createDesktopFatePaths, type FatePaths } from '../core/FatePaths';
import { MigrationService, type MigrationPlan } from '../core/storage/MigrationService';
import { assertPrivateMigrationPath, overlaps } from '../core/storage/MigrationFiles';
import { withPrivateWindowsAclScope } from '../core/storage/WindowsPrivateAcl';
import { hostCheckoutLockRoot } from '../core/ownership/CheckoutOwnership';
import type { CliCommand } from './args';
import { readHostProfile, writePrivateHostOutput } from './profile';
import { MigrationOperatorError } from './migrationErrors';

type HostCommand = Exclude<CliCommand, { mode: 'desktop' | 'connect' }>;
const MAX_PLAN_BYTES = 8 * 1024 * 1024;
export const nativeMigrationFormat = 'fate-durable-state/v1';
const envelopeSchema = z.object({ format: z.literal('fate-native-migration-plan'), version: z.literal(1),
  nativeFormat: z.literal(nativeMigrationFormat), nativeSdkVersion: z.literal(packageMetadata.dependencies['@earendil-works/pi-durable']),
  applicationVersion: z.literal(packageMetadata.version),
  selector: z.object({ kind: z.enum(['desktop', 'server']), profileId: z.string().min(1).max(64) }).strict(),
  plan: z.unknown(),
}).strict();
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function value(command: HostCommand, name: string): string {
  const option = command.options[name]; if (typeof option !== 'string' || !option) throw new MigrationOperatorError('plan'); return option;
}
function absolute(value: string): string {
  if (!path.isAbsolute(value) || path.normalize(value) !== value || /[\u0000\r\n]/u.test(value)) throw new MigrationOperatorError('plan');
  return value;
}
/** Fixed categories only: source contents, local paths and SDK error text never reach stdout. */
function blocker(message: string): string {
  if (/owner|checkout.*uncertain|checkout.*owned/iu.test(message)) return 'ownership-not-clear';
  if (/space/iu.test(message)) return 'insufficient-space';
  if (/colliding draft|queue.*100|queue.*size limit/iu.test(message)) return 'queue-merge-conflict-or-limit';
  if (/private|symbolic|overlap|absolute|directory|path/iu.test(message)) return 'unsafe-or-unavailable-path';
  if (/native namespace/iu.test(message)) return 'native-state-already-present';
  return 'unsupported-corrupt-or-unresolved-source';
}
async function planLocation(target: string, paths: FatePaths, projects: readonly { path: string }[] = []): Promise<void> {
  absolute(target);
  const root = paths.profileKind === 'server' ? path.dirname(paths.dataRoot) : paths.dataRoot;
  if ([root, paths.piAgentDir, paths.sessionsRoot, paths.lockRoot, hostCheckoutLockRoot(), ...projects.map((project) => project.path)]
    .some((source) => overlaps(source, target))) throw new MigrationOperatorError('plan');
  await assertPrivateMigrationPath(path.dirname(target), true);
}
/** One no-follow file handle, bounded allocation, stable identity and exact byte digest. */
async function readPlan(target: string, expectedDigest: string): Promise<z.infer<typeof envelopeSchema>> {
  await assertPrivateMigrationPath(target, false);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_PLAN_BYTES) throw new MigrationOperatorError('plan');
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    const after = await handle.stat(); const current = await fs.lstat(target);
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || current.isSymbolicLink()
      || current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1 || hash(bytes.subarray(0, length)) !== expectedDigest) throw new MigrationOperatorError('plan');
    await assertPrivateMigrationPath(target, false);
    return envelopeSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))));
  } finally { await handle.close(); }
}

/** Offline local command; deliberately bypasses server startup and host-admin RPC. */
export async function runMigrationCommand(command: HostCommand): Promise<void> {
  // One finite offline command shares one ACL helper process; every check stays live.
  const summaries: unknown[] = [];
  const print = () => { for (const summary of summaries.splice(0)) process.stdout.write(`${JSON.stringify(summary)}\n`); };
  try { await withPrivateWindowsAclScope(() => migrateWithinScope(command, (summary) => { summaries.push(summary); })); }
  catch (error) {
    // A typed refusal (a blocked preflight, for example) keeps its summary. A
    // helper that cannot be joined is not a verified outcome: print no success
    // line, and keep the fixed operator error instead of a raw failure.
    if (error instanceof MigrationOperatorError) { print(); throw error; }
    throw new MigrationOperatorError('operation', { cause: error });
  }
  print();
}
async function migrateWithinScope(command: HostCommand, write: (summary: unknown) => void): Promise<void> {
  if (command.mode !== 'migrate') throw new MigrationOperatorError('plan');
  let paths: FatePaths;
  try { paths = command.options.desktop === true ? createDesktopFatePaths() : (await readHostProfile(command.profile)).paths; }
  catch (cause) { throw new MigrationOperatorError('plan', { cause }); }
  const selector = { kind: paths.profileKind, profileId: paths.profileId };
  const backupRoot = absolute(value(command, 'backup-root'));
  const sourceVersion = value(command, 'source-version');
  const service = new MigrationService({ paths, backupRoot, sourceVersion, targetVersion: packageMetadata.version });
  if (command.verb === 'dry-run' || command.verb === 'prepare') {
    const report = await service.dryRun();
    const summary = { operation: command.verb, profile: selector, nativeFormat: nativeMigrationFormat,
      applicationVersion: packageMetadata.version, eligible: report.plan !== null,
      blockers: [...new Set(report.errors.map(blocker))], notices: report.notices,
      ...(report.plan ? { sessions: report.plan.sessions.length, sourceFiles: report.plan.files.length,
        requiredBytes: report.plan.requiredBytes, sourceDigest: report.plan.sourceDigest } : {}) };
    if (!report.plan) { write(summary); throw new MigrationOperatorError('blocked'); }
    if (command.verb === 'dry-run') { write(summary); return; }
    try {
      const output = absolute(value(command, 'out-file')); await planLocation(output, paths, report.plan.projects);
      const envelope = envelopeSchema.parse({ format: 'fate-native-migration-plan', version: 1, nativeFormat: nativeMigrationFormat,
        nativeSdkVersion: packageMetadata.dependencies['@earendil-works/pi-durable'], applicationVersion: packageMetadata.version, selector, plan: report.plan });
      const text = `${JSON.stringify(envelope, null, 2)}\n`;
      if (Buffer.byteLength(text) > MAX_PLAN_BYTES) throw new MigrationOperatorError('plan');
      await writePrivateHostOutput(output, text);
      // Verify the artifact actually persisted as the exact bounded private plan.
      await readPlan(output, hash(text));
      write({ ...summary, planFile: output, planDigest: hash(text) }); return;
    } catch (cause) { throw new MigrationOperatorError('plan', { cause }); }
  }
  let plan: MigrationPlan;
  try {
    const input = absolute(value(command, 'plan-file')); await planLocation(input, paths);
    const envelope = await readPlan(input, value(command, 'plan-digest'));
    if (envelope.selector.kind !== selector.kind || envelope.selector.profileId !== selector.profileId) throw new MigrationOperatorError('plan');
    // Apply the same disjoint-storage rule to an input moved after prepare.
    // This bounded projection is only a placement check. Pass the untouched
    // original plan to the service for its full strict schema/source validation.
    const placement = z.object({ projects: z.array(z.object({ path: z.string().min(1).max(32768) }).passthrough()).max(10_000) }).passthrough().parse(envelope.plan);
    for (const project of placement.projects) absolute(project.path);
    await planLocation(input, paths, placement.projects);
    // The service validates its full exact schema and compares paths against the
    // host-created FatePaths and operator-selected backup root before mutation.
    plan = envelope.plan as MigrationPlan;
  } catch (cause) { throw new MigrationOperatorError('plan', { cause }); }
  try {
    if (command.verb === 'apply' && command.options['confirm-apply'] === true) {
      const result = await service.apply(plan);
      write({ operation: 'apply', status: result.status, migrationId: result.id, importedSessions: result.importedSessions,
        nativeFormat: nativeMigrationFormat, restart: 'ordinary-host-startup', workResumed: false }); return;
    }
    if (command.verb === 'rollback' && command.options['confirm-rollback'] === true) {
      const result = await service.rollback(plan, sourceVersion);
      write({ operation: 'rollback', status: result.status, candidateRetained: true, legacySourceUnchanged: true,
        oldBinaryStarted: false, versionMatchIsNotBinaryCompatibilityProof: true }); return;
    }
    throw new MigrationOperatorError('plan');
  } catch (cause) { throw new MigrationOperatorError('operation', { cause }); }
}
