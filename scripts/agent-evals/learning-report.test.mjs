import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluate } from './run.mjs';
import { learningRunMetadataSchema, recordLearningRun } from './learning-report.mjs';

let directory;
afterEach(async () => { if (directory) await fs.rm(directory, { recursive: true, force: true }); });
const metadata = () => ({ condition: 'A-no-learning', repeatIndex: 0, projectKey: 'a'.repeat(64), provider: 'not-run', model: 'not-run', initialCodeHash: 'b'.repeat(64), taskPromptHash: 'c'.repeat(64), frozenContextHash: 'd'.repeat(64), permissions: 'edit', freshSessionId: 'offline-fixture', revisionIds: [], manifestDispatchId: null, provenance: 'Deterministic harness validation only, not a model run.' });
describe('Learning evaluation infrastructure', () => {
  it.each([
    ['learning-process-boundary', `export async function loadProjectFile(bridge, value) { if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes(':') || value.includes('\\\\') || value.split('/').some(part => part === '..')) throw new Error('Invalid path'); return bridge.readFile(value); }`],
    ['learning-scope-isolation', `export function eligible(records, projectKey) { return records.filter(record => record.projectKey === projectKey && record.enabled === true && record.approved === true && record.freshness === 'current' && record.conflict === false); }`],
  ])('accepts a corrected deterministic %s fixture', async (caseId, source) => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'learning-eval-'));
    await fs.writeFile(path.join(directory, 'solution.mjs'), source);
    const result = await evaluate({ caseId, workspace: directory });
    expect(result).toMatchObject({ success: true, checksPassed: 3, checksObserved: 3 });
  });
  it('keeps unknown metrics null, pins context hashes, and refuses overwritten reports', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'learning-report-'));
    const grade = path.join(directory, 'grade.json'); const meta = path.join(directory, 'metadata.json'); const output = path.join(directory, 'result.json');
    await fs.writeFile(grade, JSON.stringify({ version: 1, caseId: 'learning-scope-isolation', caseVersion: 1, candidateHash: 'a'.repeat(64), suiteHash: 'b'.repeat(64), evaluatorHash: 'c'.repeat(64), success: false, checksPassed: 0, checksObserved: 3, candidateUnchanged: true, exitCode: 1, terminationReason: null }));
    await fs.writeFile(meta, JSON.stringify(metadata()));
    expect(await recordLearningRun(grade, meta, output)).toMatchObject({ providerCostUsd: null, agentExecutionMs: null, benefit: 'unmeasured by this report command' });
    await expect(recordLearningRun(grade, meta, output)).rejects.toThrow();
    expect(learningRunMetadataSchema.safeParse({ ...metadata(), manifestDispatchId: '00000000-0000-4000-8000-000000000001' }).success).toBe(false);
  });
});
