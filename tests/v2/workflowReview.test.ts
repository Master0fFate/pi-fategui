import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSession, defineDoc, defineTask, Harness } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createDesktopFatePaths } from '../../src/core/FatePaths';
import { OwnerLock } from '../../src/core/ownership/OwnerLock';
import { openOwnedDurableStorage } from '../../src/core/durable/OwnedDurableStorage';
import { NativeWorkflowReviewService, inspectOwnedNativeWorkflowReview, assertNativeWorkflowIdentityNotRetired,
  NativeWorkflowPermanentlyRetiredError } from '../../src/core/recovery/NativeWorkflowReview';
import { migrationHash } from '../../src/core/storage/MigrationFiles';
import { runCli } from '../../src/cli/main';
import { parseCliArgs } from '../../src/cli/args';
import { privateTestRoot } from './helpers/isolatedEnvironment';

const Identity = defineDoc({ kind: 'fate.workflow.identity', scope: 'session', version: 1, initial: () => ({ workflowId: '', parentSessionId: '', cwd: '' }) });
const Fence = defineDoc<{ state: 'idle' | 'active' | 'UNKNOWN' }>({ kind: 'fate.execution.fence', scope: 'session', version: 1, initial: () => ({ state: 'idle' }) });
const NeverRun = defineTask<null, { phase: 'pending' }, null>({ name: 'review.never-run', version: 1, initial: () => ({ phase: 'pending' }),
  phases: { pending: async () => { throw new Error('Review must never execute a task.'); } }, abort: async () => { throw new Error('Review must never abort a task.'); } });
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(privateTestRoot(), 'workflow-review-')); roots.push(root);
  vi.stubEnv('FATE_GUI_DATA_DIR', path.join(root, 'data')); vi.stubEnv('PI_CODING_AGENT_DIR', path.join(root, 'pi'));
  const paths = createDesktopFatePaths(); const cwd = path.join(root, 'project'); const plans = path.join(root, 'plans');
  for (const directory of [paths.dataRoot, cwd, plans]) await fs.mkdir(directory, { mode: 0o700 });
  const withOwner = async <T,>(run: (profileOwner: OwnerLock) => Promise<T>) => {
    const owner = await OwnerLock.acquire(paths.lockRoot, 'profile', paths.dataRoot);
    try { return await run(owner); } finally { await owner.release(); }
  };
  const create = async (options: { id?: string; parent?: string; fence?: 'idle' | 'active' | 'UNKNOWN'; pending?: boolean | number; missingIdentity?: boolean } = {}) => withOwner(async (profileOwner) => {
    const identity = { workflowId: options.id ?? randomUUID(), parentSessionId: options.parent ?? randomUUID(), cwd };
    const filename = `workflow-${migrationHash(`${cwd}\0${identity.parentSessionId}\0${identity.workflowId}`)}.sqlite`;
    const owned = await openOwnedDurableStorage({ dataRoot: paths.dataRoot, profileOwner, filename }); const session = createSession(owned.storage);
    try {
      await session.commit(async (tx) => {
        if (!options.missingIdentity) Object.assign(await tx.doc(Identity), identity);
        (await tx.doc(Fence)).state = options.fence ?? 'UNKNOWN';
        if (options.pending) {
          const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
          for (let index = 0; index < (typeof options.pending === 'number' ? options.pending : 1); index++) await tx.createTask(NeverRun, null, { ownership: { kind: 'conversation' }, conversationId: conversation.id });
        }
      }, BACKGROUND_CONTEXT);
    } finally { await session.close(BACKGROUND_CONTEXT); }
    return { ...identity, name: filename, file: owned.filename };
  });
  const fingerprints = async () => {
    const directory = path.join(paths.dataRoot, 'durable', 'v1');
    return Object.fromEntries(await Promise.all((await fs.readdir(directory)).sort().map(async (name) => [name, migrationHash(await fs.readFile(path.join(directory, name)))])));
  };
  const service = new NativeWorkflowReviewService({ paths });
  const inspect = () => withOwner((profileOwner) => inspectOwnedNativeWorkflowReview({ paths, profileOwner }));
  const admit = (name: string) => withOwner((profileOwner) => assertNativeWorkflowIdentityNotRetired({ paths, profileOwner }, name));
  const recordRoot = path.join(paths.dataRoot, 'workflow-reviews', 'v1');
  return { root, paths, cwd, plans, service, create, fingerprints, inspect, admit, withOwner, recordRoot };
}

describe('explicit native UNKNOWN workflow review', () => {
  it('acknowledges UNKNOWN without completing or replaying work, retains exact bytes, and permanently refuses the original graph', async () => {
    const f = await fixture(); const old = await f.create({ pending: true }); const before = await f.fingerprints();
    const harness = vi.spyOn(Harness, 'open').mockRejectedValue(new Error('Harness construction forbidden'));
    const model = vi.spyOn(ModelRuntime, 'create').mockRejectedValue(new Error('Provider initialization forbidden'));
    expect(await f.inspect()).toMatchObject({ eligibleForAcknowledgment: true, acknowledgedGraphs: 0 });
    const plan = await f.service.prepare(); expect(await fs.readdir(f.paths.dataRoot)).not.toContain('workflow-reviews');
    expect(await f.service.acknowledge(plan)).toEqual({ status: 'acknowledged-unknown', retiredGraphs: 1, explicitWorkOnly: true });
    expect(await f.fingerprints()).toEqual(before);
    expect(await f.inspect()).toMatchObject({ blocked: [], uncertainProfile: false, acknowledgedGraphs: 1, explicitWorkOnly: true });
    const record = JSON.parse(await fs.readFile(path.join(f.recordRoot, `review-${plan.id}.json`), 'utf8'));
    expect(record).toMatchObject({ outcome: 'UNKNOWN', decision: 'permanently-retired; explicit-new-work-only' });
    await expect(f.admit(old.name)).rejects.toBeInstanceOf(NativeWorkflowPermanentlyRetiredError);
    await expect(f.admit(`workflow-${'f'.repeat(64)}.sqlite`)).resolves.toBeUndefined();
    await expect(f.service.acknowledge(plan)).resolves.toMatchObject({ status: 'acknowledged-unknown' });
    expect(await fs.readdir(f.recordRoot)).toEqual([`review-${plan.id}.json`]);
    expect(harness).not.toHaveBeenCalled(); expect(model).not.toHaveBeenCalled();
  });
  it('keeps retirement after missing or freshly recreated same-ID history and blocks new work on missing evidence', async () => {
    const f = await fixture(); const old = await f.create(); const plan = await f.service.prepare(); await f.service.acknowledge(plan);
    await fs.unlink(old.file);
    await expect(f.admit(old.name)).rejects.toBeInstanceOf(NativeWorkflowPermanentlyRetiredError);
    await expect(f.admit(`workflow-${'f'.repeat(64)}.sqlite`)).rejects.toThrow();
    expect(await f.inspect()).toMatchObject({ uncertainProfile: true, reviewHealth: 'invalid', explicitWorkOnly: true });
    await f.create({ id: old.workflowId, parent: old.parentSessionId, fence: 'idle' });
    await expect(f.admit(old.name)).rejects.toBeInstanceOf(NativeWorkflowPermanentlyRetiredError);
    expect(await f.inspect()).toMatchObject({ uncertainProfile: true, reviewHealth: 'invalid' });
  });
  it.each(['malformed', 'sidecar', 'missing-identity'] as const)('keeps %s evidence unchanged and diagnosis-only', async (kind) => {
    const f = await fixture(); const old = await f.create({ missingIdentity: kind === 'missing-identity' });
    if (kind === 'malformed') { const db = new DatabaseSync(old.file); try { db.exec('UPDATE durable_schema SET version=99'); } finally { db.close(); } }
    if (kind === 'sidecar') await fs.writeFile(`${old.file}-wal`, 'retained opaque sidecar bytes', { mode: 0o600 });
    const before = await f.fingerprints();
    expect(await f.inspect()).toMatchObject({ eligibleForAcknowledgment: false });
    await expect(f.service.prepare()).rejects.toThrow('diagnosis-only');
    expect(await f.fingerprints()).toEqual(before);
    await expect(fs.stat(f.recordRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['UNKNOWN', 'active', 'idle'] as const)('does not let a %s fence or earlier pending task hide malformed later task metadata', async (fence) => {
    const f = await fixture(); const old = await f.create({ pending: 2, fence });
    const db = new DatabaseSync(old.file);
    try { db.exec(`UPDATE tasks SET record='{"unexpected":true}' WHERE id=(SELECT max(id) FROM tasks)`); } finally { db.close(); }
    const before = await f.fingerprints(); expect(await f.inspect()).toMatchObject({ eligibleForAcknowledgment: false });
    await expect(f.service.prepare()).rejects.toThrow(); expect(await f.fingerprints()).toEqual(before);
  });
  it('rejects changed inventory and host/profile/version/digest edits before recording review', async () => {
    const f = await fixture(); const old = await f.create(); const plan = await f.service.prepare();
    for (const altered of [{ ...plan, sourceDigest: '0'.repeat(64) }, { ...plan, applicationVersion: '999.0.0' },
      { ...plan, profile: { ...plan.profile, host: 'foreign-host' } }]) await expect(f.service.acknowledge(altered)).rejects.toThrow();
    await f.create({ fence: 'active' }); await expect(f.service.acknowledge(plan)).rejects.toThrow('changed');
    expect(await fs.stat(old.file)).toBeDefined(); await expect(fs.stat(f.recordRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects receipt tampering and later sidecars rather than clearing uncertainty', async () => {
    const f = await fixture(); const old = await f.create(); const plan = await f.service.prepare(); await f.service.acknowledge(plan);
    const target = path.join(f.recordRoot, `review-${plan.id}.json`); const original = await fs.readFile(target);
    const record = JSON.parse(original.toString()); record.outcome = 'completed'; await fs.writeFile(target, JSON.stringify(record));
    expect(await f.inspect()).toMatchObject({ reviewHealth: 'invalid', uncertainProfile: true });
    await expect(f.admit(`workflow-${'f'.repeat(64)}.sqlite`)).rejects.toThrow();
    await fs.writeFile(target, original); await fs.writeFile(`${old.file}-journal`, 'retained journal', { mode: 0o600 });
    const before = await f.fingerprints(); expect(await f.inspect()).toMatchObject({ reviewHealth: 'invalid', uncertainProfile: true });
    expect(await f.fingerprints()).toEqual(before);
  });
  it('retains partial acknowledgment records as startup and admission blockers without overwriting on retry', async () => {
    const f = await fixture(); await f.create(); const plan = await f.service.prepare(); const before = await f.fingerprints();
    const open = fs.open.bind(fs);
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (target, ...rest) => {
      const handle = await open(target, ...rest);
      if (String(target) === path.join(f.recordRoot, `review-${plan.id}.json`)) {
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementation(async () => { await write('{"partial":'); throw new Error('injected write interruption'); });
      }
      return handle;
    });
    await expect(f.service.acknowledge(plan)).rejects.toThrow('injected'); spy.mockRestore();
    const target = path.join(f.recordRoot, `review-${plan.id}.json`); expect(await fs.readFile(target, 'utf8')).toBe('{"partial":');
    expect(await f.inspect()).toMatchObject({ reviewHealth: 'invalid', uncertainProfile: true });
    await expect(f.service.acknowledge(plan)).rejects.toThrow();
    expect(await fs.readFile(target, 'utf8')).toBe('{"partial":'); expect(await f.fingerprints()).toEqual(before);
  });
  it('treats a retained empty review namespace as missing authority, never as an unreviewed fresh profile', async () => {
    const f = await fixture(); const old = await f.create(); const plan = await f.service.prepare(); await f.service.acknowledge(plan);
    await fs.unlink(path.join(f.recordRoot, `review-${plan.id}.json`));
    expect(await f.inspect()).toMatchObject({ reviewHealth: 'invalid', uncertainProfile: true, explicitWorkOnly: true });
    await expect(f.admit(old.name)).rejects.toThrow('empty or incomplete');
  });
  it('retains profile ownership when acknowledgment writer close cannot be confirmed', async () => {
    const f = await fixture(); await f.create(); const plan = await f.service.prepare();
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (target, ...rest) => {
      const handle = await open(target, ...rest);
      if (String(target) === path.join(f.recordRoot, `review-${plan.id}.json`)) {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); throw new Error('synthetic unconfirmed close'); });
      }
      return handle;
    });
    await expect(f.service.acknowledge(plan)).rejects.toThrow('ownership retained');
    await expect(f.service.inspect()).rejects.toThrow('Owner already in use');
  });
  it('requires exclusive ownership and rechecks inventory after the final diagnostic boundary', async () => {
    const f = await fixture(); const old = await f.create(); const plan = await f.service.prepare();
    await f.withOwner(async (owner) => {
      await expect(f.service.inspect()).rejects.toThrow('Owner already in use'); await expect(f.service.acknowledge(plan)).rejects.toThrow('Owner already in use');
      expect(JSON.parse(await fs.readFile(path.join(owner.lockPath, 'owner.json'), 'utf8')).token).toBe(owner.record.token);
    });
    const changed = new NativeWorkflowReviewService({ paths: f.paths, checkpoint: async (phase) => { if (phase === 'before-acknowledgment') await fs.writeFile(`${old.file}-wal`, 'new sidecar', { mode: 0o600 }); } });
    await expect(changed.acknowledge(plan)).rejects.toThrow(); await expect(fs.stat(f.recordRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('exposes inspect/prepare/acknowledge through the actual CLI with private exact plans and no SDK initialization', async () => {
    const f = await fixture(); await f.create(); const before = await f.fingerprints();
    const model = vi.spyOn(ModelRuntime, 'create').mockRejectedValue(new Error('No provider initialization'));
    const harness = vi.spyOn(Harness, 'open').mockRejectedValue(new Error('No harness'));
    const output: string[] = []; vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    await runCli(['workflow-review', '--desktop']); expect(JSON.parse(output.pop()!)).toMatchObject({ eligibleForAcknowledgment: true, workResumed: false });
    const planFile = path.join(f.plans, 'review.json');
    await runCli(['workflow-review', 'prepare', '--desktop', '--out-file', planFile]);
    const prepared = JSON.parse(output.pop()!); expect(prepared.planDigest).toBe(migrationHash(await fs.readFile(planFile)));
    expect((await fs.stat(planFile)).mode & 0o077).toBe(0);
    await expect(runCli(['workflow-review', 'acknowledge', '--desktop', '--plan-file', planFile, '--plan-digest', '0'.repeat(64), '--acknowledge-unknown'])).rejects.toThrow();
    await runCli(['workflow-review', 'acknowledge', '--desktop', '--plan-file', planFile, '--plan-digest', prepared.planDigest, '--acknowledge-unknown']);
    expect(JSON.parse(output.pop()!)).toMatchObject({ outcome: 'UNKNOWN', originalGraphs: 'permanently-inadmissible', schedulesReenabled: false, workResumed: false });
    expect(await f.fingerprints()).toEqual(before); expect(model).not.toHaveBeenCalled(); expect(harness).not.toHaveBeenCalled();
  });
  it('rejects plan placement in reviewed projects, links, overwrite and missing intent before acknowledgment', async () => {
    const f = await fixture(); await f.create(); const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    await expect(runCli(['workflow-review', 'prepare', '--desktop', '--out-file', path.join(f.cwd, 'plan.json')])).rejects.toThrow();
    const file = path.join(f.plans, 'plan.json'); await runCli(['workflow-review', 'prepare', '--desktop', '--out-file', file]);
    const summary = JSON.parse(output.pop()!); const original = await fs.readFile(file);
    await expect(runCli(['workflow-review', 'prepare', '--desktop', '--out-file', file])).rejects.toThrow(); expect(await fs.readFile(file)).toEqual(original);
    const target = path.join(f.cwd, 'relocated-plan.json'); await fs.rename(file, target);
    await expect(runCli(['workflow-review', 'acknowledge', '--desktop', '--plan-file', target, '--plan-digest', summary.planDigest, '--acknowledge-unknown'])).rejects.toThrow();
    await fs.rename(target, file); const link = path.join(f.plans, 'link.json'); await fs.symlink(file, link);
    await expect(runCli(['workflow-review', 'acknowledge', '--desktop', '--plan-file', link, '--plan-digest', summary.planDigest, '--acknowledge-unknown'])).rejects.toThrow();
    expect(() => parseCliArgs(['workflow-review', 'acknowledge', '--desktop', '--plan-file', file, '--plan-digest', summary.planDigest], 'server')).toThrow();
    expect(() => parseCliArgs(['workflow-review', '--desktop', '--profile', 'another'], 'server')).toThrow();
    await expect(fs.stat(f.recordRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
