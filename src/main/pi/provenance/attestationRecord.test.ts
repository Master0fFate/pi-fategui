import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildAttestation,
  isInsideProject,
  pruneAttestations,
  type AttestationPruneOptions,
} from './attestationRecord';
import type { MutationAttestation } from '../../../shared/contracts/mutationAttestation';

const PROJECT_ROOT = path.sep === '/' ? '/project' : 'C:\\project';

function record(relPath: string, recordedAt: number, content = 'x'): MutationAttestation {
  const targetPath = path.join(PROJECT_ROOT, ...relPath.split('/'));
  const built = buildAttestation({
    operation: 'write',
    projectRoot: PROJECT_ROOT,
    targetPath,
    content,
    preHash: null,
    preState: 'missing',
    actor: { kind: 'root' },
    sessionId: 'sess-1',
    permissionLevel: 'edit',
  }, recordedAt);
  if (!built) throw new Error(`buildAttestation returned null for ${relPath}`);
  return built;
}

/** Exact on-disk JSONL byte size the pruner must respect (each row + trailing newline). */
function jsonlBytes(rows: readonly MutationAttestation[]): number {
  return Buffer.byteLength(rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

describe('isInsideProject', () => {
  it('permits a safe in-project filename such as "..foo"', () => {
    expect(isInsideProject(PROJECT_ROOT, path.join(PROJECT_ROOT, '..foo'))).toBe(true);
    expect(isInsideProject(PROJECT_ROOT, path.join(PROJECT_ROOT, 'src', '..bar.ts'))).toBe(true);
  });

  it('rejects the exact parent, parent-segment descendants, the root, and nested project files otherwise', () => {
    expect(isInsideProject(PROJECT_ROOT, path.join(PROJECT_ROOT, '..'))).toBe(false);
    expect(isInsideProject(PROJECT_ROOT, path.join(PROJECT_ROOT, '..', 'sibling'))).toBe(false);
    expect(isInsideProject(PROJECT_ROOT, PROJECT_ROOT)).toBe(false);
    expect(isInsideProject(PROJECT_ROOT, path.join(PROJECT_ROOT, 'src', 'a.ts'))).toBe(true);
  });

  it('rejects an absolute path outside the project root', () => {
    const outsideRoot = path.sep === '/' ? '/elsewhere' : 'D:\\elsewhere';
    expect(isInsideProject(PROJECT_ROOT, path.join(outsideRoot, 'escape.ts'))).toBe(false);
  });
});

describe('pruneAttestations', () => {
  const baseOptions = (overrides: Partial<AttestationPruneOptions> = {}): AttestationPruneOptions => ({
    maxRecords: 4_096,
    maxBytes: 16 * 1024 * 1024,
    maxAgeMs: 90 * 24 * 60 * 60 * 1000,
    ...overrides,
  });

  it('preserves the newest rows up to the record cap', () => {
    const rows = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map((rel, index) => record(rel, 1_000 + index));
    const kept = pruneAttestations(rows, 10_000, baseOptions({ maxRecords: 3 }));
    expect(kept.map((row) => row.path)).toEqual(['c.ts', 'd.ts', 'e.ts']);
  });

  it('drops rows older than the age cutoff while keeping recent rows', () => {
    const rows = [record('old.ts', 0), record('mid.ts', 5_000), record('new.ts', 9_000)];
    const kept = pruneAttestations(rows, 10_000, baseOptions({ maxAgeMs: 5_000 }));
    expect(kept.map((row) => row.path)).toEqual(['mid.ts', 'new.ts']);
  });

  it('trims oldest rows first until the actual JSONL byte size fits the cap', () => {
    const rows = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((rel, index) => record(rel, 1_000 + index));
    // Allow only the newest two rows by their exact on-disk JSONL byte size.
    const cap = jsonlBytes(rows.slice(-2));
    const kept = pruneAttestations(rows, 10_000, baseOptions({ maxBytes: cap }));
    expect(kept.map((row) => row.path)).toEqual(['c.ts', 'd.ts']);
    expect(jsonlBytes(kept)).toBeLessThanOrEqual(cap);
  });

  it('counts each row plus its trailing newline toward the byte cap', () => {
    const rows = [record('a.ts', 1_000), record('b.ts', 2_000)];
    // The cap equals exactly the two newest rows' JSONL size; both are retained.
    const cap = jsonlBytes(rows);
    const kept = pruneAttestations(rows, 10_000, baseOptions({ maxBytes: cap }));
    expect(kept.map((row) => row.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('retains the single newest record even if it alone exceeds maxBytes', () => {
    const rows = [record('a.ts', 1_000), record('b.ts', 2_000), record('newest.ts', 3_000)];
    const kept = pruneAttestations(rows, 10_000, baseOptions({ maxBytes: 1 }));
    expect(kept).toHaveLength(1);
    expect(kept[0]?.path).toBe('newest.ts');
  });

  it('applies age, record, and byte caps together in a single pass', () => {
    const rows = [
      record('aged.ts', 0),             // dropped by age
      record('old.ts', 1_000),          // dropped by age
      record('mid.ts', 2_000),
      record('new.ts', 3_000),
    ];
    const cap = jsonlBytes([rows[2]!, rows[3]!]);
    const kept = pruneAttestations(rows, 4_000, baseOptions({ maxRecords: 3, maxBytes: cap, maxAgeMs: 2_000 }));
    expect(kept.map((row) => row.path)).toEqual(['mid.ts', 'new.ts']);
  });
});
