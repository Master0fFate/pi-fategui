import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluate } from './run.mjs';
import { cases } from './cases.mjs';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function workspace(source) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-eval-test-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'solution.mjs'), source);
  return root;
}
const corrected = `export function recoverMessages(records) {
  if (!Array.isArray(records)) throw new Error('array required');
  const seen = new Set();
  return records.filter(record => {
    if (!record || typeof record.id !== 'string' || !record.id || !['pending','dispatching','acknowledged','cancelled'].includes(record.status)) throw new Error('invalid');
    if (record.status !== 'pending' || seen.has(record.id)) return false;
    seen.add(record.id); return true;
  });
}`;

describe('offline agent task grader', () => {
  it.each(Object.keys(cases))('fails the known-buggy %s seed', async (caseId) => {
    const root = await workspace(cases[caseId].seed);
    const result = await evaluate({ caseId, workspace: root });
    expect(result.success).toBe(false);
    expect(result.checksFailed).toBeGreaterThan(0);
    expect(result.reported).toBeNull();
  });

  it('recognizes a repair, retains evidence, and detects a baseline regression', async () => {
    const root = await workspace(corrected);
    const baseline = await evaluate({ caseId: 'delivery-recovery', workspace: root });
    expect(baseline, baseline.output).toMatchObject({ success: true, checksPassed: 3, regression: null });
    expect(baseline.gradingWallTimeMs).toBeGreaterThan(0);
    const baselineFile = path.join(root, 'baseline.json');
    await fs.writeFile(baselineFile, JSON.stringify(baseline));
    await fs.writeFile(path.join(root, 'solution.mjs'), cases['delivery-recovery'].seed);
    const result = await evaluate({ caseId: 'delivery-recovery', workspace: root, baselineFile });
    expect(result).toMatchObject({ success: false, regression: true });
    expect(result.output).toContain('test:fail');
  });

  it('retains CLI evidence without overwriting an earlier result', async () => {
    const root = await workspace(corrected);
    const out = path.join(root, 'result.json');
    const command = [fileURLToPath(new URL('./run.mjs', import.meta.url)), 'grade', '--case', 'delivery-recovery', '--workspace', root, '--out', out];
    await promisify(execFile)(process.execPath, command);
    const saved = await fs.readFile(out, 'utf8');
    expect(JSON.parse(saved)).toMatchObject({ success: true, candidateHash: expect.stringMatching(/^[a-f0-9]{64}$/u), suiteHash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    await expect(promisify(execFile)(process.execPath, command)).rejects.toMatchObject({ code: 1 });
    expect(await fs.readFile(out, 'utf8')).toBe(saved);
  });

  it('rejects printed success summaries and premature process exits', async () => {
    const root = await workspace(`export function recoverMessages() {}\nconsole.log('# pass 3\\n# fail 0'); process.exit(0);`);
    const result = await evaluate({ caseId: 'delivery-recovery', workspace: root });
    expect(result).toMatchObject({ success: false, checksPassed: 0 });
  });

  it('accepts a correct explicit routing implementation', async () => {
    const root = await workspace(`export function selectModel(available, requested, inherited) {
      const target = requested === undefined ? inherited : requested;
      if (!target || typeof target.provider !== 'string' || !target.provider || typeof target.id !== 'string' || !target.id) throw new Error('invalid');
      const selected = available.find(model => model.provider === target.provider && model.id === target.id && !model.disabled);
      if (!selected) throw new Error('unavailable');
      return selected;
    }`);
    expect(await evaluate({ caseId: 'explicit-routing', workspace: root })).toMatchObject({ success: true, checksPassed: 3 });
  });

  it('times out stalled candidate code rather than hanging the evaluation', async () => {
    const root = await workspace('export function recoverMessages() {}\nprocess.on("SIGTERM", () => {}); while (true) {}');
    const result = await evaluate({ caseId: 'delivery-recovery', workspace: root, timeout: 200 });
    expect(result).toMatchObject({ success: false, timedOut: true });
  });

  it('validates reported metrics and rejects incompatible baselines', async () => {
    const root = await workspace(corrected);
    const metricsFile = path.join(root, 'metrics.json');
    await fs.writeFile(metricsFile, JSON.stringify({ model: 'test/model', source: 'runtime export', taskWallTimeMs: 200, costUsd: 0.01 }));
    const result = await evaluate({ caseId: 'delivery-recovery', workspace: root, metricsFile });
    expect(result.reported).toEqual({ model: 'test/model', source: 'runtime export', taskWallTimeMs: 200, costUsd: 0.01 });
    await fs.writeFile(metricsFile, JSON.stringify({ model: 'test/model', source: 'export', taskWallTimeMs: -1, costUsd: 0 }));
    await expect(evaluate({ caseId: 'delivery-recovery', workspace: root, metricsFile })).rejects.toThrow('nonnegative');
    await fs.writeFile(metricsFile, JSON.stringify({ version: 1, caseId: 'another', success: true }));
    await expect(evaluate({ caseId: 'delivery-recovery', workspace: root, baselineFile: metricsFile })).rejects.toThrow('different case');
    for (const invalid of [null, false, 0, { ...result, checksPassed: 0 }]) {
      await fs.writeFile(metricsFile, JSON.stringify(invalid));
      await expect(evaluate({ caseId: 'delivery-recovery', workspace: root, baselineFile: metricsFile })).rejects.toThrow('malformed');
    }
    await expect(evaluate({ caseId: 'delivery-recovery', workspace: root, timeout: -1 })).rejects.toThrow('timeout');
  });
});
