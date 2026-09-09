import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const metric = z.number().finite().nonnegative().nullable().default(null);
export const learningRunMetadataSchema = z.object({
  condition: z.enum(['A-no-learning', 'B-manual-notes', 'C-managed-learning']),
  repeatIndex: z.number().int().nonnegative(), projectKey: hash,
  provider: z.string().min(1).max(500), model: z.string().min(1).max(500),
  initialCodeHash: hash, taskPromptHash: hash, frozenContextHash: hash,
  permissions: z.enum(['read-only', 'edit', 'full-access']), freshSessionId: z.string().min(1).max(500),
  revisionIds: z.array(z.string().uuid()).max(3), manifestDispatchId: z.string().uuid().nullable(),
  provenance: z.string().min(1).max(2000),
  repeatedCorrections: metric, humanReviewMs: metric, agentExecutionMs: metric,
  inputTokens: metric, outputTokens: metric, cacheTokens: metric, providerCostUsd: metric,
  draftGenerationCostUsd: metric, preparationMs: metric,
}).strict().superRefine((value, ctx) => {
  if (value.condition !== 'C-managed-learning' && (value.revisionIds.length || value.manifestDispatchId)) ctx.addIssue({ code: 'custom', message: 'A/B runs cannot claim managed-learning attachments' });
});
export async function recordLearningRun(gradeFile, metadataFile, output) {
  const bounded = async (file) => { if ((await fs.stat(file)).size > 256 * 1024) throw new Error('Input exceeds 256 KiB'); return fs.readFile(file, 'utf8'); };
  const gradeBytes = await bounded(gradeFile);
  const grade = z.object({ version: z.literal(1), caseId: z.enum(['learning-process-boundary', 'learning-scope-isolation']), caseVersion: z.literal(1), candidateHash: hash, suiteHash: hash, evaluatorHash: hash, success: z.boolean(), checksPassed: z.number().int().min(0).max(3), checksObserved: z.number().int().min(0).max(3), candidateUnchanged: z.boolean(), exitCode: z.number().int().nullable(), terminationReason: z.string().nullable() }).passthrough().parse(JSON.parse(gradeBytes));
  if (grade.success !== (grade.checksPassed === 3 && grade.checksObserved === 3 && grade.candidateUnchanged && grade.exitCode === 0 && grade.terminationReason === null)) throw new Error('Inconsistent acceptance result');
  const metadata = learningRunMetadataSchema.parse(JSON.parse(await bounded(metadataFile)));
  const result = { schemaVersion: 1, kind: 'externally-reported-learning-run', gradeFileHash: createHash('sha256').update(gradeBytes).digest('hex'), acceptance: grade, ...metadata, benefit: 'unmeasured by this report command' };
  await fs.writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [, , grade, metadata, output] = process.argv;
  if (!grade || !metadata || !output) throw new Error('Usage: node scripts/agent-evals/learning-report.mjs <grade.json> <metadata.json> <new-result.json>');
  await recordLearningRun(grade, metadata, output);
}
