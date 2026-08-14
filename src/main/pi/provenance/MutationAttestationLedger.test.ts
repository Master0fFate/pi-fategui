import { AppLogService } from '../../logging/AppLogService';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MutationAttestation } from '../../../shared/contracts/mutationAttestation';
import { buildAttestation, projectPathHash, sha256Hex } from './attestationRecord';
import { MutationAttestationLedger } from './MutationAttestationLedger';

const PROJECT_ROOT = path.sep === '/' ? '/project' : 'C:\\project';

function makeRecord(projectRoot: string, relPath: string, content: string, recordedAt = Date.now()): MutationAttestation {
  const targetPath = path.join(projectRoot, ...relPath.split('/'));
  const record = buildAttestation({
    operation: 'write',
    projectRoot,
    targetPath,
    content,
    preHash: null,
    preState: 'missing',
    actor: { kind: 'root' },
    sessionId: 'sess-1',
    permissionLevel: 'edit',
  }, recordedAt);
  if (!record) throw new Error(`buildAttestation returned null for ${relPath}`);
  return record;
}

describe('MutationAttestationLedger', () => {
  let root: string;
  let logs: AppLogService;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'attest-'));
    logs = new AppLogService();
    writeSpy = vi.spyOn(logs, 'write');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('appends attestations in order and returns them chronologically', async () => {
    const ledger = new MutationAttestationLedger(logs, root);
    await ledger.record(makeRecord(PROJECT_ROOT, 'src/a.ts', 'a'));
    await ledger.record(makeRecord(PROJECT_ROOT, 'src/b.ts', 'b'));
    await ledger.record(makeRecord(PROJECT_ROOT, 'src/c.ts', 'c'));

    const result = await ledger.query({ projectPath: PROJECT_ROOT, limit: 256 });
    expect(result.rows.map((row) => row.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(result.truncated).toBe(false);
  });

  it('survives restart through a new ledger instance over the same data root', async () => {
    await new MutationAttestationLedger(logs, root).record(makeRecord(PROJECT_ROOT, 'README.md', 'hello'));
    const reopened = new MutationAttestationLedger(logs, root);
    const result = await reopened.query({ projectPath: PROJECT_ROOT, limit: 256 });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.path).toBe('README.md');
    expect(result.rows[0]?.postHash).toBe(sha256Hex('hello'));
  });

  it('skips corrupt lines with a warning instead of throwing', async () => {
    const ledger = new MutationAttestationLedger(logs, root);
    await ledger.record(makeRecord(PROJECT_ROOT, 'src/ok.ts', 'ok'));
    const file = path.join(root, 'attestations', `${projectPathHash(PROJECT_ROOT)}.jsonl`);
    await fs.appendFile(file, '{ this is not json\n{"broken":true}\n');

    const result = await ledger.query({ projectPath: PROJECT_ROOT, limit: 256 });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.path).toBe('src/ok.ts');
    expect(writeSpy).toHaveBeenCalledWith('warn', 'attestations', expect.any(String));
  });

  it('filters by path prefix and reports truncation past the limit', async () => {
    const ledger = new MutationAttestationLedger(logs, root);
    await ledger.record(makeRecord(PROJECT_ROOT, 'src/a.ts', 'a'));
    await ledger.record(makeRecord(PROJECT_ROOT, 'docs/b.md', 'b'));
    await ledger.record(makeRecord(PROJECT_ROOT, 'src/c.ts', 'c'));

    const src = await ledger.query({ projectPath: PROJECT_ROOT, limit: 256, pathPrefix: 'src' });
    expect(src.rows.map((row) => row.path)).toEqual(['src/a.ts', 'src/c.ts']);

    const capped = await ledger.query({ projectPath: PROJECT_ROOT, limit: 1 });
    expect(capped.rows.map((row) => row.path)).toEqual(['src/c.ts']);
    expect(capped.truncated).toBe(true);
  });

  it('enforces byte/record bounds through atomic compaction', async () => {
    const longPath = 'a'.repeat(3_900);
    const record = makeRecord(PROJECT_ROOT, longPath, 'x', Date.now());
    const file = path.join(root, 'attestations', `${projectPathHash(PROJECT_ROOT)}.jsonl`);
    // Seed a file just past the 16 MiB byte bound with recent, valid records.
    const line = JSON.stringify(record);
    const blob = Array.from({ length: 4_400 }, () => line).join('\n') + '\n';
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, blob);
    expect((await fs.stat(file)).size).toBeGreaterThan(16 * 1024 * 1024);

    const ledger = new MutationAttestationLedger(logs, root);
    await ledger.record(makeRecord(PROJECT_ROOT, 'src/new.ts', 'new', Date.now()));
    await ledger.flush();

    const after = (await fs.readFile(file, 'utf8')).split('\n').filter((entry) => entry.trim()).length;
    expect(after).toBeLessThanOrEqual(4_096);
    expect((await fs.stat(file)).size).toBeLessThanOrEqual(16 * 1024 * 1024);
    const result = await ledger.query({ projectPath: PROJECT_ROOT, limit: 1_000 });
    expect(result.rows.some((row) => row.path === 'src/new.ts')).toBe(true);
  }, 60_000);

  it('uses safe file and directory permissions on POSIX', async () => {
    if (process.platform === 'win32') return; // Mode bits are not meaningful on Windows.
    const ledger = new MutationAttestationLedger(logs, root);
    await ledger.record(makeRecord(PROJECT_ROOT, 'src/a.ts', 'a'));
    const file = path.join(root, 'attestations', `${projectPathHash(PROJECT_ROOT)}.jsonl`);
    const fileMode = (await fs.stat(file)).mode & 0o777;
    const dirMode = ((await fs.stat(path.dirname(file))).mode & 0o777);
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  it('tightens pre-existing permissive ledger file and directory modes on POSIX', async () => {
    if (process.platform === 'win32') return; // Mode bits are not meaningful on Windows.
    const dir = path.join(root, 'attestations');
    await fs.mkdir(dir, { recursive: true });
    await fs.chmod(dir, 0o777); // pre-created permissive directory
    const file = path.join(dir, `${projectPathHash(PROJECT_ROOT)}.jsonl`);
    await fs.writeFile(file, 'pre-existing permissive line\n', { mode: 0o644 });
    await fs.chmod(file, 0o644); // pre-created permissive file

    const ledger = new MutationAttestationLedger(logs, root);
    await ledger.record(makeRecord(PROJECT_ROOT, 'src/a.ts', 'a'));
    await ledger.flush();

    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
  });

  it('persists no file content, diffs, commands, or absolute project paths', async () => {
    const ledger = new MutationAttestationLedger(logs, root);
    await ledger.record(makeRecord(PROJECT_ROOT, 'src/secret.ts', 'TOPSECRET-CONTENT-XYZ'));
    const file = path.join(root, 'attestations', `${projectPathHash(PROJECT_ROOT)}.jsonl`);
    const stored = await fs.readFile(file, 'utf8');
    expect(stored).not.toContain('TOPSECRET-CONTENT-XYZ');
    expect(stored).not.toContain(PROJECT_ROOT);
    expect(stored).not.toMatch(/"(content|diff|command|toolCallId|commit|goalId|criterionId)"/);
  });

  it('enforces the record-count bound independently of the byte trigger', async () => {
    const ledger = new MutationAttestationLedger(logs, root, { maxRecords: 3 });
    for (const relPath of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']) {
      await ledger.record(makeRecord(PROJECT_ROOT, relPath, relPath));
    }
    await ledger.flush();
    const result = await ledger.query({ projectPath: PROJECT_ROOT, limit: 256 });
    expect(result.rows.map((row) => row.path)).toEqual(['c.ts', 'd.ts', 'e.ts']);
  });

  it('prunes records older than the age bound on sweep', async () => {
    const ledger = new MutationAttestationLedger(logs, root, { maxAgeMs: 1_000, sweepIntervalMs: 0 });
    await ledger.record(makeRecord(PROJECT_ROOT, 'old.ts', 'old', Date.now() - 10_000));
    await ledger.record(makeRecord(PROJECT_ROOT, 'new.ts', 'new', Date.now()));
    await ledger.flush();
    const result = await ledger.query({ projectPath: PROJECT_ROOT, limit: 256 });
    expect(result.rows.map((row) => row.path)).toEqual(['new.ts']);
  });

  it('awaits queued writes before querying', async () => {
    const ledger = new MutationAttestationLedger(logs, root);
    const pending = ledger.record(makeRecord(PROJECT_ROOT, 'queued.ts', 'q'));
    const result = await ledger.query({ projectPath: PROJECT_ROOT, limit: 256 });
    expect(result.rows.map((row) => row.path)).toContain('queued.ts');
    await pending;
  });

  it('does not drop records already queued when disposed', async () => {
    const ledger = new MutationAttestationLedger(logs, root);
    const pending = ledger.record(makeRecord(PROJECT_ROOT, 'queued.ts', 'q'));
    ledger.dispose();
    await pending;
    const result = await new MutationAttestationLedger(logs, root).query({ projectPath: PROJECT_ROOT, limit: 256 });
    expect(result.rows.map((row) => row.path)).toContain('queued.ts');
  });

  it('rejects new records after disposal without throwing', async () => {
    const ledger = new MutationAttestationLedger(logs, root);
    ledger.dispose();
    await expect(ledger.record(makeRecord(PROJECT_ROOT, 'after.ts', 'a'))).resolves.toBeUndefined();
    const result = await new MutationAttestationLedger(logs, root).query({ projectPath: PROJECT_ROOT, limit: 256 });
    expect(result.rows).toHaveLength(0);
  });

  it('excludes age-old rows on a read-only query after restart', async () => {
    const writer = new MutationAttestationLedger(logs, root, { maxAgeMs: 90 * 24 * 60 * 60 * 1000 });
    await writer.record(makeRecord(PROJECT_ROOT, 'old.ts', 'old', Date.now() - 10_000));
    await writer.record(makeRecord(PROJECT_ROOT, 'new.ts', 'new', Date.now()));
    await writer.flush();
    // Fresh, read-only ledger with a short age bound and no intervening write.
    const readonly = new MutationAttestationLedger(logs, root, { maxAgeMs: 1_000 });
    const result = await readonly.query({ projectPath: PROJECT_ROOT, limit: 256 });
    expect(result.rows.map((row) => row.path)).toEqual(['new.ts']);
  });

  it('treats a trailing-slash path prefix the same as no trailing slash', async () => {
    const ledger = new MutationAttestationLedger(logs, root);
    await ledger.record(makeRecord(PROJECT_ROOT, 'src/a.ts', 'a'));
    await ledger.record(makeRecord(PROJECT_ROOT, 'docs/b.md', 'b'));
    await ledger.flush();
    const withSlash = await ledger.query({ projectPath: PROJECT_ROOT, limit: 256, pathPrefix: 'src/' });
    const withoutSlash = await ledger.query({ projectPath: PROJECT_ROOT, limit: 256, pathPrefix: 'src' });
    expect(withSlash.rows.map((row) => row.path)).toEqual(['src/a.ts']);
    expect(withoutSlash.rows.map((row) => row.path)).toEqual(['src/a.ts']);
  });

  it('isolates ledger files by instance slot so concurrent processes never share or compact each other', async () => {
    const slot1 = new MutationAttestationLedger(logs, root, { instanceSlot: 1 });
    const slot2 = new MutationAttestationLedger(logs, root, { instanceSlot: 2 });
    await slot1.record(makeRecord(PROJECT_ROOT, 'src/a.ts', 'a'));
    await slot2.record(makeRecord(PROJECT_ROOT, 'src/b.ts', 'b'));
    await slot1.flush();
    await slot2.flush();

    const from1 = await slot1.query({ projectPath: PROJECT_ROOT, limit: 256 });
    const from2 = await slot2.query({ projectPath: PROJECT_ROOT, limit: 256 });
    expect(from1.rows.map((row) => row.path)).toEqual(['src/a.ts']);
    expect(from2.rows.map((row) => row.path)).toEqual(['src/b.ts']);

    // Slot 1 keeps the unsuffixed file (migration compatibility); slot 2 uses .slot-2.
    const hash = projectPathHash(PROJECT_ROOT);
    await expect(fs.stat(path.join(root, 'attestations', `${hash}.jsonl`))).resolves.toBeDefined();
    await expect(fs.stat(path.join(root, 'attestations', `${hash}.slot-2.jsonl`))).resolves.toBeDefined();
  });

  it('rejects an invalid instance slot', () => {
    expect(() => new MutationAttestationLedger(logs, root, { instanceSlot: 0 })).toThrow();
    expect(() => new MutationAttestationLedger(logs, root, { instanceSlot: 1.5 })).toThrow();
    expect(() => new MutationAttestationLedger(logs, root)).not.toThrow();
  });
});
