import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli/main';
import { parseCliArgs } from '../../src/cli/args';
import { createDesktopFatePaths } from '../../src/core/FatePaths';
import { OwnerLock } from '../../src/core/ownership/OwnerLock';
import { SessionQueueRepository } from '../../src/main/pi/SessionQueueRepository';
import { initializeHostProfile } from '../../src/cli/profile';
import { nativeMigrationFormat } from '../../src/cli/migration';
import { privateTestRoot } from './helpers/isolatedEnvironment';
import { assertPrivateWindowsAcl } from '../../src/core/storage/WindowsPrivateAcl';
import { setOtherLocalUsersRead } from './helpers/windowsAcl';
import { linkFileOrJunction } from './helpers/platformLinks';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function fixture(server = false) {
  const root = await fs.mkdtemp(path.join(privateTestRoot(), 'migration-cli-')); roots.push(root);
  const project = path.join(root, 'project'); const backup = path.join(root, 'backups'); const plans = path.join(root, 'plans');
  for (const target of [project, backup, plans]) await fs.mkdir(target, { mode: 0o700 });
  vi.stubEnv('FATE_GUI_DATA_DIR', path.join(root, 'data')); vi.stubEnv('PI_CODING_AGENT_DIR', path.join(root, 'pi'));
  const profile = `migration-${randomUUID()}`;
  const paths = server ? (await initializeHostProfile({ profileId: profile, workspace: project, trustAccepted: true })).paths : createDesktopFatePaths();
  if (server) roots.push(path.dirname(paths.dataRoot));
  await fs.mkdir(paths.dataRoot, { mode: 0o700 });
  const sessionId = randomUUID();
  const directory = path.join(paths.sessionsRoot, `--${project.replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const transcript = path.join(directory, `fixture_${sessionId}.jsonl`);
  await fs.writeFile(transcript, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: project, timestamp: new Date(0).toISOString() }) + '\n', { mode: 0o600 });
  const message = { id: randomUUID(), text: 'PRIVATE DRAFT CONTENT NEVER PRINTED', behavior: 'followUp' as const, createdAt: 1 };
  await new SessionQueueRepository(path.join(paths.dataRoot, 'session-queues', 'v1')).save(project, sessionId, [message]);
  const base = [...(server ? ['--profile', profile] : ['--desktop']), '--backup-root', backup, '--source-version', '1.1.0'];
  const output: string[] = []; vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true; });
  const invoke = async (verb: string | null, rest: string[] = []) => {
    output.length = 0; await runCli(['migrate', ...(verb ? [verb] : []), ...base, ...rest]);
    expect(output).toHaveLength(1); expect(output.join('')).not.toContain(message.text);
    return JSON.parse(output[0]!) as Record<string, unknown>;
  };
  const planFile = path.join(plans, 'exact-plan.json');
  const prepare = () => invoke('prepare', ['--out-file', planFile]);
  const execute = (verb: 'apply' | 'rollback', digest: string) => invoke(verb, ['--plan-file', planFile, '--plan-digest', digest, `--confirm-${verb}`]);
  return { root, project, backup, plans, paths, sessionId, transcript, message, base, output, invoke, planFile, prepare, execute };
}

describe('host-local native migration CLI', () => {
  it('defaults to a write-free summary-only preview and requires explicit narrow grammar', async () => {
    const f = await fixture(); const before = await fs.readdir(f.paths.dataRoot);
    expect(await f.invoke(null)).toMatchObject({ operation: 'dry-run', eligible: true, sessions: 1, nativeFormat: nativeMigrationFormat });
    expect(await fs.readdir(f.paths.dataRoot)).toEqual(before); expect(await fs.readdir(f.backup)).toEqual([]); expect(await fs.readdir(f.plans)).toEqual([]);
    for (const args of [
      ['migrate', ...f.base, '--out-file', f.planFile], ['migrate', 'apply', ...f.base],
      ['migrate', ...f.base, '--profile', 'also-a-server'], ['migrate', 'unknown', ...f.base],
      ['migrate', 'prepare', ...f.base], ['migrate', 'rollback', ...f.base, '--confirm-apply'],
      ['migrate', ...f.base, '--confirm-apply'], ['migrate', 'apply', ...f.base, '--plan-file', f.planFile, '--plan-digest', 'a'.repeat(64), '--confirm-apply', '--confirm-rollback'],
    ]) expect(() => parseCliArgs(args, 'server')).toThrow();
  });
  it.each([false, true])('exports a private exact plan, activates and rolls back through actual %s profile CLI entry', async (server) => {
    const f = await fixture(server); const original = await fs.readFile(f.transcript);
    const summary = await f.prepare(); const bytes = await fs.readFile(f.planFile);
    expect(summary.planDigest).toBe(hash(bytes));
    // Windows mode bits say nothing about the NTFS DACL; check the live ACL there.
    if (process.platform === 'win32') await expect(assertPrivateWindowsAcl(f.planFile)).resolves.toBeUndefined();
    else expect((await fs.stat(f.planFile)).mode & 0o077).toBe(0);
    const envelope = JSON.parse(bytes.toString()); expect(envelope).toMatchObject({ nativeFormat: nativeMigrationFormat, nativeSdkVersion: '1.0.0', selector: { kind: server ? 'server' : 'desktop' } });
    expect(summary).not.toHaveProperty('plan'); expect(summary).not.toHaveProperty('projects');
    expect(await f.execute('apply', String(summary.planDigest))).toMatchObject({ status: 'activated', workResumed: false, restart: 'ordinary-host-startup' });
    expect(await f.execute('apply', String(summary.planDigest))).toMatchObject({ status: 'activated' });
    expect(await fs.readFile(f.transcript)).toEqual(original);
    expect(await f.execute('rollback', String(summary.planDigest))).toMatchObject({ status: 'rolled-back', candidateRetained: true, oldBinaryStarted: false });
    expect(await fs.readFile(f.transcript)).toEqual(original);
    await expect(fs.stat(path.join(f.paths.dataRoot, 'durable'))).rejects.toMatchObject({ code: 'ENOENT' });
    // A SQLite read may create WAL sidecars, so inspect the retained candidate
    // only after rollback rather than invalidating its conservative byte seal.
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(path.join(f.paths.dataRoot, 'migrations', envelope.plan.id, 'rolled-back-durable', 'v1', 'state.sqlite'), { readOnly: true });
    try { expect(database.prepare('SELECT count(*) AS n FROM tasks').get()?.n).toBe(0); expect(database.prepare('SELECT count(*) AS n FROM submissions').get()?.n).toBe(0); }
    finally { database.close(); }
  });
  it('refuses wrong byte digest, foreign profile, altered path and incompatible native format before writes', async () => {
    const f = await fixture(); const summary = await f.prepare(); const original = await fs.readFile(f.planFile);
    await expect(f.execute('apply', '0'.repeat(64))).rejects.toThrow('plan');
    for (const edit of [
      (record: any) => { record.selector.profileId = 'foreign'; },
      (record: any) => { record.nativeFormat = 'fate-durable-state/v2'; },
      (record: any) => { record.plan.dataRoot = path.join(f.root, 'foreign'); },
      (record: any) => { record.plan.backupRoot = path.join(f.root, 'foreign'); },
      (record: any) => { record.plan.host = 'another-host'; },
    ]) {
      const record = JSON.parse(original.toString()); edit(record); const changed = JSON.stringify(record);
      await fs.writeFile(f.planFile, changed); await expect(f.execute('apply', hash(changed))).rejects.toThrow();
      expect(await fs.readdir(f.backup)).toEqual([]);
      await expect(fs.stat(path.join(f.paths.dataRoot, 'durable'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await fs.writeFile(f.planFile, original);
    expect(await f.execute('apply', String(summary.planDigest))).toMatchObject({ status: 'activated' });
    const wrongVersion = f.base.map((item) => item === '1.1.0' ? '0.9.0' : item);
    await expect(runCli(['migrate', 'rollback', ...wrongVersion, '--plan-file', f.planFile, '--plan-digest', String(summary.planDigest), '--confirm-rollback'])).rejects.toThrow();
  });
  it('never overwrites plan output or follows linked/nonprivate/oversized plan storage', async () => {
    const f = await fixture(); const summary = await f.prepare(); const original = await fs.readFile(f.planFile);
    await expect(f.prepare()).rejects.toThrow('plan'); expect(await fs.readFile(f.planFile)).toEqual(original);
    // A real other-user read grant: an NTFS allow rule on Windows, mode bits elsewhere.
    if (process.platform === 'win32') await setOtherLocalUsersRead(f.planFile, true); else await fs.chmod(f.planFile, 0o644);
    await expect(f.execute('apply', String(summary.planDigest))).rejects.toThrow('plan');
    if (process.platform === 'win32') await setOtherLocalUsersRead(f.planFile, false); else await fs.chmod(f.planFile, 0o600);
    const link = path.join(f.plans, 'linked-plan'); await linkFileOrJunction(f.planFile, f.plans, link);
    await expect(f.invoke('apply', ['--plan-file', link, '--plan-digest', String(summary.planDigest), '--confirm-apply'])).rejects.toThrow('plan');
    const parentLink = path.join(f.root, 'linked-parent'); await fs.symlink(f.plans, parentLink, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.invoke('prepare', ['--out-file', path.join(parentLink, 'unsafe.json')])).rejects.toThrow('plan');
    await expect(f.invoke('prepare', ['--out-file', path.join(f.paths.dataRoot, 'unsafe.json')])).rejects.toThrow('plan');
    await fs.truncate(f.planFile, 8 * 1024 * 1024 + 1); await expect(f.execute('apply', String(summary.planDigest))).rejects.toThrow('plan');
    expect(await fs.readdir(f.backup)).toEqual([]);
  });
  it('refuses active owners and changed sources with no admin-RPC or fallback runtime', async () => {
    const f = await fixture(); const summary = await f.prepare();
    const owner = await OwnerLock.acquire(f.paths.lockRoot, 'profile', f.paths.dataRoot);
    try {
      await expect(f.execute('apply', String(summary.planDigest))).rejects.toThrow('did not complete');
      await expect(f.invoke('dry-run')).rejects.toThrow('preflight');
      expect(f.output.join('')).toContain('ownership-not-clear');
      expect(JSON.parse(await fs.readFile(owner.recordPath, 'utf8')).token).toBe(owner.record.token);
    } finally { await owner.release(); }
    await fs.appendFile(f.transcript, JSON.stringify({ type: 'custom', data: 'changed' }) + '\n');
    await expect(f.execute('apply', String(summary.planDigest))).rejects.toThrow('did not complete');
    expect(await fs.readdir(f.backup)).toEqual([]);
  });
  it.each(['apply', 'rollback'] as const)('refuses a relocated %s plan inside a referenced project before ownership or mutation', async (operation) => {
    const f = await fixture(); const summary = await f.prepare(); const bytes = await fs.readFile(f.planFile);
    if (operation === 'rollback') await f.execute('apply', String(summary.planDigest));
    const before = await fs.readdir(f.paths.dataRoot); const backups = await fs.readdir(f.backup);
    const relocated = path.join(f.project, 'exact-plan.json'); await fs.rename(f.planFile, relocated);
    const acquire = vi.spyOn(OwnerLock, 'acquire');
    await expect(f.invoke(operation, ['--plan-file', relocated, '--plan-digest', String(summary.planDigest), `--confirm-${operation}`])).rejects.toThrow('plan');
    expect(acquire).not.toHaveBeenCalled(); expect(f.output).toEqual([]);
    expect(await fs.readdir(f.paths.dataRoot)).toEqual(before); expect(await fs.readdir(f.backup)).toEqual(backups);
    expect(await fs.readFile(relocated)).toEqual(bytes);
    if (operation === 'apply') await expect(fs.stat(path.join(f.paths.dataRoot, 'durable'))).rejects.toMatchObject({ code: 'ENOENT' });
    else expect((await fs.stat(path.join(f.paths.dataRoot, 'durable'))).isDirectory()).toBe(true);
  });
});
