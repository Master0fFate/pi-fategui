import { constants, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import packageMetadata from '../../../package.json';
import { FatePaths } from '../FatePaths';
import { OwnerLock, canonicalFuturePath, lockName } from '../ownership/OwnerLock';
import { DurableStorageCloseUncertainError } from '../durable/OwnedDurableStorage';
import { inspectOwnedNativeWorkflowRecovery, type NativeWorkflowRecoveryInspection } from './NativeWorkflowRecovery';
import { assertPrivateMigrationPath, exists, fingerprintMigrationFile, migrationHash, privateMigrationDirectory,
  readMigrationJson, syncMigrationDirectory, type MigrationFile } from '../storage/MigrationFiles';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const workflowName = /^workflow-([a-f0-9]{64})\.sqlite$/u;
const partName = /^workflow-([a-f0-9]{64})\.sqlite(?:-(?:wal|shm|journal))?$/u;
const recordName = /^review-([a-f0-9-]{36})\.json$/u;
const MAX_FILES = 1024;
const MAX_BYTES = 1024 * 1024 * 1024;
const fileSchema = z.object({ name: z.string().regex(partName), bytes: z.number().int().nonnegative().max(256 * 1024 * 1024), sha256: digest,
  device: z.string().max(100), inode: z.string().max(100), modified: z.number().finite() }).strict();
const profileSchema = z.object({ host: z.string().min(1).max(500), profileId: z.string().min(1).max(500), kind: z.enum(['desktop', 'server']),
  dataRoot: z.string().min(1).max(32768), resource: z.string().min(1).max(32768), device: z.string().max(100), inode: z.string().max(100) }).strict();
const reasonCodes = ['retained-unknown', 'active-at-shutdown', 'nonterminal-tasks', 'unsettled-submissions'] as const;
const blockSchema = z.object({ filename: z.string().regex(workflowName), workflowId: z.string().min(1).max(500), parentSessionId: z.string().min(1).max(500),
  cwd: z.string().min(1).max(32768), reason: z.enum(reasonCodes) }).strict();
export const nativeWorkflowReviewFormat = 'fate-native-workflow-review/v1';
const planSchema = z.object({ format: z.literal(nativeWorkflowReviewFormat), id: z.string().uuid(),
  applicationVersion: z.literal(packageMetadata.version), nativeSdkVersion: z.literal(packageMetadata.dependencies['@earendil-works/pi-durable']),
  profile: profileSchema, inventory: z.array(fileSchema).max(MAX_FILES * 4), blocks: z.array(blockSchema).min(1).max(MAX_FILES), sourceDigest: digest }).strict();
export type NativeWorkflowReviewPlan = z.infer<typeof planSchema>;
const receiptSchema = z.object({ format: z.literal(nativeWorkflowReviewFormat), outcome: z.literal('UNKNOWN'),
  decision: z.literal('permanently-retired; explicit-new-work-only'), acknowledgedAt: z.number().int().nonnegative().safe(),
  planDigest: digest, plan: planSchema }).strict();
type Receipt = z.infer<typeof receiptSchema>;
export interface OwnedWorkflowReviewOptions { readonly paths: FatePaths; readonly profileOwner: OwnerLock; readonly maxFiles?: number }
export interface NativeWorkflowReviewInspection extends NativeWorkflowRecoveryInspection {
  readonly acknowledgedGraphs: number;
  readonly explicitWorkOnly: boolean;
  readonly reviewHealth: 'ok' | 'invalid';
  readonly eligibleForAcknowledgment: boolean;
}
export class NativeWorkflowPermanentlyRetiredError extends Error {
  readonly code = 'NATIVE_WORKFLOW_PERMANENTLY_RETIRED';
  constructor() { super('This historical workflow identity is permanently retired with outcome UNKNOWN. Only a new explicit user request may create different work.'); }
}
function resource(paths: FatePaths): string { return paths.profileKind === 'server' ? path.dirname(paths.dataRoot) : paths.dataRoot; }
function recordsRoot(paths: FatePaths): string { return path.join(paths.dataRoot, 'workflow-reviews', 'v1'); }
function dataDirectory(paths: FatePaths): string { return path.join(paths.dataRoot, 'durable', 'v1'); }
function sourceDigest(plan: Pick<NativeWorkflowReviewPlan, 'profile' | 'inventory' | 'blocks'>): string { return migrationHash(JSON.stringify({ profile: plan.profile, inventory: plan.inventory, blocks: plan.blocks })); }
function reasonCode(reason: string): typeof reasonCodes[number] | undefined {
  const allowed: Readonly<Record<string, typeof reasonCodes[number] | undefined>> = {
    'Native workflow has retained UNKNOWN evidence; automatic continuation is prohibited.': 'retained-unknown',
    'Native workflow was active at shutdown; automatic continuation is prohibited.': 'active-at-shutdown',
    'Native workflow has nonterminal tasks; automatic continuation is prohibited.': 'nonterminal-tasks',
    'Native workflow has unsettled submissions; automatic continuation is prohibited.': 'unsettled-submissions',
  }; return allowed[reason];
}
export function nativeWorkflowReviewReason(reason: string): typeof reasonCodes[number] | 'diagnosis-only' { return reasonCode(reason) ?? 'diagnosis-only'; }
async function profileIdentity(paths: FatePaths): Promise<z.infer<typeof profileSchema>> {
  if (!(paths instanceof FatePaths)) throw new Error('Native workflow review requires host-created paths.');
  await assertPrivateMigrationPath(resource(paths), true); await assertPrivateMigrationPath(paths.dataRoot, true);
  const stat = await fs.stat(resource(paths));
  return { host: os.hostname(), profileId: paths.profileId, kind: paths.profileKind, dataRoot: paths.dataRoot,
    resource: await canonicalFuturePath(resource(paths)), device: String(stat.dev), inode: String(stat.ino) };
}
async function assertOwner(options: OwnedWorkflowReviewOptions): Promise<void> {
  const { paths, profileOwner: owner } = options;
  if (!(paths instanceof FatePaths) || !(owner instanceof OwnerLock)) throw new Error('Native workflow review requires the exact owning profile lock.');
  const resolved = await canonicalFuturePath(resource(paths));
  if (owner.record.resource !== resolved || owner.lockPath !== path.join(paths.lockRoot, `profile-${lockName(resolved)}.lock`)) throw new Error('Native workflow review requires the exact owning profile lock.');
  await assertPrivateMigrationPath(owner.lockPath, true);
  const record = z.object({ token: z.string(), resource: z.string() }).passthrough().parse(await readMigrationJson(path.join(owner.lockPath, 'owner.json'), 4096));
  if (record.token !== owner.record.token || record.resource !== owner.record.resource) throw new Error('Native workflow profile owner changed; review and admission are fenced.');
}
async function inventory(paths: FatePaths): Promise<MigrationFile[]> {
  const directory = dataDirectory(paths); if (!await exists(directory)) return [];
  await assertPrivateMigrationPath(directory, true);
  const found: MigrationFile[] = []; let count = 0, bytes = 0;
  for await (const entry of await fs.opendir(directory)) {
    if (++count > 10_000) throw new Error('Workflow review inventory exceeds its bound.');
    if (!entry.name.startsWith('workflow-')) continue;
    if (!partName.test(entry.name) || !entry.isFile() || found.length >= MAX_FILES * 4) throw new Error('Workflow review inventory is unsafe or unsupported.');
    const stat = await fs.lstat(path.join(directory, entry.name));
    if (stat.size > 256 * 1024 * 1024 || (bytes += stat.size) > MAX_BYTES) throw new Error('Workflow review byte quota exceeded.');
    found.push(await fingerprintMigrationFile(path.join(directory, entry.name), entry.name));
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}
function validatePlan(raw: NativeWorkflowReviewPlan): NativeWorkflowReviewPlan {
  const plan = planSchema.parse(raw);
  if (plan.sourceDigest !== sourceDigest(plan) || new Set(plan.inventory.map((item) => item.name)).size !== plan.inventory.length
    || new Set(plan.blocks.map((item) => item.filename)).size !== plan.blocks.length) throw new Error('Workflow review plan integrity is invalid.');
  for (const block of plan.blocks) {
    if (!path.isAbsolute(block.cwd) || path.normalize(block.cwd) !== block.cwd || /[\u0000\r\n]/u.test(block.cwd)
      || block.filename !== `workflow-${migrationHash(`${block.cwd}\0${block.parentSessionId}\0${block.workflowId}`)}.sqlite`
      || plan.inventory.filter((file) => file.name === block.filename || file.name.startsWith(`${block.filename}-`)).length !== 1
      || !plan.inventory.some((file) => file.name === block.filename)) throw new Error('Workflow review identity is missing, ambiguous, or has sidecars.');
  }
  return plan;
}
async function receipts(options: OwnedWorkflowReviewOptions): Promise<Receipt[]> {
  await assertOwner(options);
  const root = recordsRoot(options.paths);
  if (!await exists(root)) {
    if (await exists(path.dirname(root))) throw new Error('Workflow review record namespace is incomplete.');
    return [];
  }
  const expectedProfile = await profileIdentity(options.paths);
  await assertPrivateMigrationPath(root, true); const found: Receipt[] = []; const retired = new Set<string>(); let receiptBytes = 0, retainedBytes = 0;
  for await (const entry of await fs.opendir(root)) {
    if (found.length >= MAX_FILES || !entry.isFile() || !recordName.test(entry.name)) throw new Error('Workflow review records are incomplete, unsafe, or unsupported.');
    receiptBytes += (await fs.lstat(path.join(root, entry.name))).size;
    if (receiptBytes > 32 * 1024 * 1024) throw new Error('Workflow review record inventory exceeds its byte quota.');
    const record = receiptSchema.parse(await readMigrationJson(path.join(root, entry.name), 8 * 1024 * 1024));
    validatePlan(record.plan);
    if (entry.name !== `review-${record.plan.id}.json` || record.planDigest !== migrationHash(JSON.stringify(record.plan))
      || JSON.stringify(record.plan.profile) !== JSON.stringify(expectedProfile)) throw new Error('Workflow review receipt identity or integrity is invalid.');
    for (const block of record.plan.blocks) {
      if (retired.has(block.filename)) throw new Error('Workflow review receipts contain duplicate retired identities.'); retired.add(block.filename);
      retainedBytes += record.plan.inventory.find((file) => file.name === block.filename)!.bytes;
      if (retired.size > MAX_FILES || retainedBytes > MAX_BYTES) throw new Error('Retained workflow evidence exceeds its quota.');
    }
    found.push(record);
  }
  if (!found.length) throw new Error('Workflow review record namespace is empty or incomplete.');
  await assertOwner(options); return found;
}
async function verifyRetainedEvidence(options: OwnedWorkflowReviewOptions, records: readonly Receipt[]): Promise<void> {
  // Only acknowledged immutable graphs are pinned. Explicit future new graph
  // files may coexist; they never alter or supersede a historical tombstone.
  for (const record of records) for (const block of record.plan.blocks) {
    const expected = record.plan.inventory.find((file) => file.name === block.filename)!;
    const actual = await fingerprintMigrationFile(path.join(dataDirectory(options.paths), block.filename), block.filename);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Acknowledged workflow evidence changed or was replaced.');
    for (const suffix of ['-wal', '-shm', '-journal']) if (await exists(path.join(dataDirectory(options.paths), `${block.filename}${suffix}`))) throw new Error('Acknowledged workflow sidecars appeared.');
  }
  await assertOwner(options);
}
/** Read-only startup composition. Never modifies the frozen scanner or old databases. */
export async function inspectOwnedNativeWorkflowReview(options: OwnedWorkflowReviewOptions): Promise<NativeWorkflowReviewInspection> {
  await assertOwner(options);
  const scanned = await inspectOwnedNativeWorkflowRecovery({ dataRoot: options.paths.dataRoot, profileOwner: options.profileOwner, maxFiles: options.maxFiles ?? MAX_FILES });
  let acknowledgedGraphs = 0;
  try {
    const records = await receipts(options); acknowledgedGraphs = records.reduce((total, record) => total + record.plan.blocks.length, 0);
    await verifyRetainedEvidence(options, records);
    const retired = new Set(records.flatMap((record) => record.plan.blocks.map((block) => path.join(dataDirectory(options.paths), block.filename))));
    const blocked = scanned.blocked.filter((block) => !retired.has(block.filename));
    return { ...scanned, blocked, acknowledgedGraphs, explicitWorkOnly: acknowledgedGraphs > 0, reviewHealth: 'ok',
      eligibleForAcknowledgment: !scanned.uncertainProfile && blocked.length > 0 && blocked.every((block) => Boolean(block.workflowId && block.parentSessionId && block.cwd && reasonCode(block.reason))) };
  } catch (error) {
    // A lost owner must not be converted to a benign inspection result.
    await assertOwner(options);
    return { blocked: [...scanned.blocked, { filename: recordsRoot(options.paths), reason: 'Workflow review evidence is invalid, changed, or incomplete; stopped-owner review is required.' }],
      uncertainProfile: true, acknowledgedGraphs, explicitWorkOnly: true, reviewHealth: 'invalid', eligibleForAcknowledgment: false };
  }
}
/** Must run before opening/creating native workflow storage, including same-ID retries. */
export async function assertNativeWorkflowIdentityNotRetired(options: OwnedWorkflowReviewOptions, filename: string): Promise<void> {
  if (!workflowName.test(filename)) throw new Error('Workflow admission requires an exact host-generated identity.');
  const records = await receipts(options);
  if (records.some((record) => record.plan.blocks.some((block) => block.filename === filename))) throw new NativeWorkflowPermanentlyRetiredError();
  await verifyRetainedEvidence(options, records);
}
export interface NativeWorkflowReviewOptions {
  readonly paths: FatePaths;
  /** Trusted test/diagnostic seam only; never accepted from a CLI plan. */
  readonly checkpoint?: (phase: 'before-acknowledgment' | 'acknowledged') => void | Promise<void>;
}
class WorkflowReviewCloseUncertainError extends Error {}
export class NativeWorkflowReviewService {
  constructor(private readonly options: NativeWorkflowReviewOptions) { if (!(options.paths instanceof FatePaths)) throw new Error('Workflow review requires host-created paths.'); }
  private async own<T>(run: (owned: OwnedWorkflowReviewOptions) => Promise<T>): Promise<T> {
    await profileIdentity(this.options.paths);
    const owner = await OwnerLock.acquire(this.options.paths.lockRoot, 'profile', await canonicalFuturePath(resource(this.options.paths))); let retain = false;
    try { return await run({ paths: this.options.paths, profileOwner: owner }); }
    catch (error) { retain = error instanceof DurableStorageCloseUncertainError || error instanceof WorkflowReviewCloseUncertainError; throw error; }
    finally { if (!retain) await owner.release(); }
  }
  inspect(): Promise<NativeWorkflowReviewInspection> { return this.own(inspectOwnedNativeWorkflowReview); }
  private async observe(owned: OwnedWorkflowReviewOptions): Promise<Omit<NativeWorkflowReviewPlan, 'id' | 'sourceDigest'>> {
    const before = await inventory(owned.paths); const inspected = await inspectOwnedNativeWorkflowReview(owned); const after = await inventory(owned.paths);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Workflow history changed during inspection.');
    if (inspected.uncertainProfile || inspected.reviewHealth !== 'ok' || !inspected.blocked.length) throw new Error('History is opaque, malformed, already reviewed, or has no eligible workflow. This is diagnosis-only.');
    const blocks = inspected.blocked.map((block) => blockSchema.parse({ filename: path.basename(block.filename), workflowId: block.workflowId,
      parentSessionId: block.parentSessionId, cwd: block.cwd, reason: reasonCode(block.reason) })).sort((a, b) => a.filename.localeCompare(b.filename));
    const result: Omit<NativeWorkflowReviewPlan, 'id' | 'sourceDigest'> = { format: nativeWorkflowReviewFormat, applicationVersion: packageMetadata.version,
      nativeSdkVersion: packageMetadata.dependencies['@earendil-works/pi-durable'], profile: await profileIdentity(owned.paths), inventory: after, blocks };
    await assertOwner(owned); return result;
  }
  prepare(): Promise<NativeWorkflowReviewPlan> { return this.own(async (owned) => {
    const observed = await this.observe(owned); return validatePlan({ ...observed, id: randomUUID(), sourceDigest: sourceDigest(observed) });
  }); }
  async acknowledge(raw: NativeWorkflowReviewPlan): Promise<{ status: 'acknowledged-unknown'; retiredGraphs: number; explicitWorkOnly: true }> {
    const plan = validatePlan(raw);
    if (JSON.stringify(plan.profile) !== JSON.stringify(await profileIdentity(this.options.paths))) throw new Error('Workflow review belongs to another host or profile.');
    return this.own(async (owned) => {
      const existing = await receipts(owned); const same = existing.find((record) => record.plan.id === plan.id);
      if (same) {
        if (JSON.stringify(same.plan) !== JSON.stringify(plan)) throw new Error('Workflow review ID belongs to a different plan.');
        await verifyRetainedEvidence(owned, existing);
        return { status: 'acknowledged-unknown', retiredGraphs: plan.blocks.length, explicitWorkOnly: true };
      }
      const observed = await this.observe(owned);
      if (sourceDigest(observed) !== plan.sourceDigest) throw new Error('Workflow history changed; prepare a fresh stopped-owner review.');
      await this.options.checkpoint?.('before-acknowledgment');
      if (sourceDigest(await this.observe(owned)) !== plan.sourceDigest) throw new Error('Workflow history changed before acknowledgment.');
      const parent = path.dirname(recordsRoot(owned.paths));
      if (!await exists(parent)) await privateMigrationDirectory(parent); else await assertPrivateMigrationPath(parent, true);
      if (!await exists(recordsRoot(owned.paths))) await privateMigrationDirectory(recordsRoot(owned.paths));
      const record = receiptSchema.parse({ format: nativeWorkflowReviewFormat, outcome: 'UNKNOWN', decision: 'permanently-retired; explicit-new-work-only',
        acknowledgedAt: Date.now(), planDigest: migrationHash(JSON.stringify(plan)), plan });
      const text = JSON.stringify(record); if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Workflow review receipt exceeds its bound.');
      await assertOwner(owned);
      // O_EXCL retains an incomplete write as a startup blocker. There is no
      // overwrite, cleanup, deletion, success inference, or stale-record repair.
      const target = path.join(recordsRoot(owned.paths), `review-${plan.id}.json`);
      const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await handle.writeFile(text); await handle.sync(); }
      finally { try { await handle.close(); } catch (cause) { throw new WorkflowReviewCloseUncertainError('Workflow review record close is uncertain; profile ownership retained.', { cause }); } }
      await syncMigrationDirectory(recordsRoot(owned.paths));
      await assertPrivateMigrationPath(target, false); await assertOwner(owned);
      await receipts(owned); await verifyRetainedEvidence(owned, [record]);
      await this.options.checkpoint?.('acknowledged');
      return { status: 'acknowledged-unknown', retiredGraphs: plan.blocks.length, explicitWorkOnly: true };
    });
  }
}
