import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createDesktopFatePaths, type FatePaths } from '../core/FatePaths';
import { hostCheckoutLockRoot } from '../core/ownership/CheckoutOwnership';
import { NativeWorkflowReviewService, nativeWorkflowReviewFormat, nativeWorkflowReviewReason, type NativeWorkflowReviewPlan } from '../core/recovery/NativeWorkflowReview';
import { assertPrivateMigrationPath, migrationHash, overlaps } from '../core/storage/MigrationFiles';
import { withPrivateWindowsAclScope } from '../core/storage/WindowsPrivateAcl';
import type { CliCommand } from './args';
import { readHostProfile, writePrivateHostOutput } from './profile';
import { WorkflowReviewOperatorError } from './workflowReviewErrors';

type HostCommand = Exclude<CliCommand, { mode: 'desktop' | 'connect' }>;
const MAX_PLAN = 8 * 1024 * 1024;
function option(command: HostCommand, name: string): string {
  const value = command.options[name]; if (typeof value !== 'string' || !value) throw new WorkflowReviewOperatorError(); return value;
}
function absolute(value: string): string {
  if (!path.isAbsolute(value) || path.normalize(value) !== value || /[\u0000\r\n]/u.test(value)) throw new WorkflowReviewOperatorError(); return value;
}
async function placement(target: string, paths: FatePaths, projects: readonly string[] = []): Promise<void> {
  absolute(target);
  if ([paths.profileKind === 'server' ? path.dirname(paths.dataRoot) : paths.dataRoot, paths.piAgentDir, paths.sessionsRoot, paths.lockRoot,
    hostCheckoutLockRoot(), ...projects.map(absolute)].some((root) => overlaps(root, target))) throw new WorkflowReviewOperatorError();
  await assertPrivateMigrationPath(path.dirname(target), true);
}
async function readExactPlan(target: string, digest: string): Promise<unknown> {
  await assertPrivateMigrationPath(target, false);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat(); if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_PLAN) throw new WorkflowReviewOperatorError();
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    const after = await handle.stat(); const current = await fs.lstat(target);
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink() || current.nlink !== 1
      || migrationHash(bytes.subarray(0, length)) !== digest) throw new WorkflowReviewOperatorError();
    await assertPrivateMigrationPath(target, false);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown;
  } finally { await handle.close(); }
}
/** Offline operator command only; no server RPC, SDK initialization or automatic work. */
export async function runWorkflowReviewCommand(command: HostCommand): Promise<void> {
  try {
    if (command.mode !== 'workflow-review') throw new WorkflowReviewOperatorError();
    // One finite offline command shares one ACL helper process; every check stays
    // live. Diagnosis keeps its own queries: it reports an unsafe item as a
    // result, and one refused query would end a helper shared by the whole verb.
    // No summary is printed before the helper has been joined: a reported
    // outcome must never precede a failed verification of its own checks.
    const summaries: unknown[] = [];
    const record = (summary: unknown) => { summaries.push(summary); };
    if (command.verb === 'inspect') await review(command, record);
    else await withPrivateWindowsAclScope(() => review(command, record));
    for (const summary of summaries) process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (cause) { throw new WorkflowReviewOperatorError({ cause }); }
}
async function review(command: HostCommand, write: (summary: unknown) => void): Promise<void> {
  {
    if (command.mode !== 'workflow-review') throw new WorkflowReviewOperatorError();
    const paths = command.options.desktop === true ? createDesktopFatePaths() : (await readHostProfile(command.profile)).paths;
    const service = new NativeWorkflowReviewService({ paths });
    if (command.verb === 'inspect') {
      const result = await service.inspect();
      write({ operation: 'inspect', format: nativeWorkflowReviewFormat, profile: paths.profileId,
        outcome: result.blocked.length || result.acknowledgedGraphs || result.uncertainProfile ? 'UNKNOWN' : 'no-unresolved-history-observed',
        blocked: result.blocked.map((block) => ({ identityHash: /^workflow-([a-f0-9]{64})\.sqlite$/u.exec(path.basename(block.filename))?.[1] ?? null, reason: nativeWorkflowReviewReason(block.reason) })),
        uncertainProfile: result.uncertainProfile, reviewHealth: result.reviewHealth, eligibleForAcknowledgment: result.eligibleForAcknowledgment,
        acknowledgedGraphs: result.acknowledgedGraphs, explicitWorkOnly: result.explicitWorkOnly, workResumed: false }); return;
    }
    if (command.verb === 'prepare') {
      const plan = await service.prepare(); const target = absolute(option(command, 'out-file'));
      await placement(target, paths, plan.blocks.map((block) => block.cwd));
      const text = `${JSON.stringify(plan, null, 2)}\n`; if (Buffer.byteLength(text) > MAX_PLAN) throw new WorkflowReviewOperatorError();
      await writePrivateHostOutput(target, text); await readExactPlan(target, migrationHash(text));
      write({ operation: 'prepare', format: nativeWorkflowReviewFormat, graphs: plan.blocks.length, planFile: target, planDigest: migrationHash(text),
        outcome: 'UNKNOWN', decisionRequired: 'permanently-retire-original-graphs; explicit-new-work-only', workResumed: false }); return;
    }
    if (command.verb === 'acknowledge' && command.options['acknowledge-unknown'] === true) {
      const target = absolute(option(command, 'plan-file')); await placement(target, paths);
      const raw = await readExactPlan(target, option(command, 'plan-digest'));
      const references = z.object({ blocks: z.array(z.object({ cwd: z.string().min(1).max(32768) }).passthrough()).min(1).max(1024) }).passthrough().parse(raw);
      await placement(target, paths, references.blocks.map((block) => block.cwd));
      const result = await service.acknowledge(raw as NativeWorkflowReviewPlan);
      write({ operation: 'acknowledge', ...result, outcome: 'UNKNOWN', originalGraphs: 'permanently-inadmissible', schedulesReenabled: false, workResumed: false }); return;
    }
    throw new WorkflowReviewOperatorError();
  }
}
