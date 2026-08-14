import { describe, expect, it } from 'vitest';
import {
  attestationQueryInputSchema,
  attestationQueryRequestSchema,
  mutationAttestationSchema,
} from './mutationAttestation';

const base = {
  id: 'rec-1',
  schemaVersion: 1 as const,
  recordedAt: 1_000,
  projectPathHash: 'a'.repeat(64),
  sessionId: 'sess-1',
  actor: { kind: 'root' },
  permissionLevel: 'edit',
  operation: 'write',
  path: 'src/app.ts',
  preHash: null,
  postHash: 'b'.repeat(64),
  preState: 'missing',
  captureKind: 'direct-file-tool',
};

function validWith(overrides: Record<string, unknown>): unknown {
  return { ...base, ...overrides };
}

describe('mutationAttestationSchema (v1)', () => {
  it('accepts a truthful direct-write attestation with a null pre-state', () => {
    expect(mutationAttestationSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a hashed pre-state transition and null session/permission when unavailable', () => {
    expect(mutationAttestationSchema.safeParse(validWith({
      sessionId: null,
      permissionLevel: null,
      preHash: 'c'.repeat(64),
      preState: 'hashed',
      operation: 'edit',
    })).success).toBe(true);
  });

  it.each([
    ['traversal', { path: '../etc/passwd' }],
    ['absolute posix', { path: '/etc/passwd' }],
    ['absolute windows drive', { path: 'C:/secrets' }],
    ['backslash', { path: 'src\\app.ts' }],
    ['dot segment', { path: './src/app.ts' }],
    ['empty segment', { path: 'src//app.ts' }],
    ['overlong', { path: 'a'.repeat(4_097) }],
  ])('rejects a non-project-relative path (%s)', (_label, override) => {
    expect(mutationAttestationSchema.safeParse(validWith(override)).success).toBe(false);
  });

  it.each([
    ['short postHash', { postHash: 'xyz' }],
    ['uppercase postHash', { postHash: 'B'.repeat(64) }],
    ['short preHash', { preHash: 'xyz', preState: 'hashed' }],
    ['uppercase preHash', { preHash: 'B'.repeat(64), preState: 'hashed' }],
  ])('rejects malformed hashes (%s)', (_label, override) => {
    expect(mutationAttestationSchema.safeParse(validWith(override)).success).toBe(false);
  });

  it.each([
    ['content', { content: 'the file body' }],
    ['diff', { diff: '@@ -1 +1 @@' }],
    ['command', { command: 'rm -rf /' }],
    ['toolCallId', { toolCallId: 'call-9' }],
    ['commit', { commit: 'deadbeef' }],
    ['goal', { goalId: 'g1' }],
    ['criterion', { criterionId: 'c1' }],
    ['unknown extra', { note: 'extra' }],
  ])('rejects unknown / causal fields (%s)', (_label, override) => {
    expect(mutationAttestationSchema.safeParse(validWith(override)).success).toBe(false);
  });

  it.each([
    ['wrong schemaVersion', { schemaVersion: 2 }],
    ['bad operation', { operation: 'bash' }],
    ['bad captureKind', { captureKind: 'shell' }],
    ['bad preState', { preState: 'unknown' }],
    ['unknown actor kind', { actor: { kind: 'mystery' } }],
    ['missing postHash', { postHash: undefined }],
    ['empty session id', { sessionId: '' }],
  ])('rejects invalid enum/version/shape (%s)', (_label, override) => {
    expect(mutationAttestationSchema.safeParse(validWith(override)).success).toBe(false);
  });
});

describe('attestationQueryInputSchema', () => {
  it('applies a bounded default limit and accepts an optional path prefix', () => {
    const parsed = attestationQueryInputSchema.parse({ projectPath: '/project' });
    expect(parsed.limit).toBe(256);
    expect(parsed.pathPrefix).toBeUndefined();
  });

  it('rejects an over-large limit', () => {
    expect(attestationQueryInputSchema.safeParse({ projectPath: '/project', limit: 100_000 }).success).toBe(false);
  });
});

describe('mutationAttestationSchema preState/preHash consistency', () => {
  it('rejects a hashed preState without a preHash', () => {
    expect(mutationAttestationSchema.safeParse(validWith({ preState: 'hashed', preHash: null })).success).toBe(false);
  });

  it('rejects a missing preState with a non-null preHash', () => {
    expect(mutationAttestationSchema.safeParse(validWith({ preState: 'missing', preHash: 'd'.repeat(64) })).success).toBe(false);
  });

  it('rejects an oversize preState with a non-null preHash', () => {
    expect(mutationAttestationSchema.safeParse(validWith({ preState: 'oversize', preHash: 'd'.repeat(64) })).success).toBe(false);
  });

  it('accepts a hashed preState with a valid preHash', () => {
    expect(mutationAttestationSchema.safeParse(validWith({ preState: 'hashed', preHash: 'd'.repeat(64), operation: 'edit' })).success).toBe(true);
  });
});

describe('attestationQueryInputSchema pathPrefix safety', () => {
  it.each([
    ['traversal', '../x'],
    ['absolute posix', '/etc'],
    ['absolute windows drive', 'C:/x'],
    ['backslash', 'src\\x'],
    ['dot segment', 'src/./x'],
    ['traversal segment', 'src/../x'],
    ['empty segment', 'src//x'],
  ])('rejects an unsafe prefix (%s)', (_label, pathPrefix) => {
    expect(attestationQueryInputSchema.safeParse({ projectPath: '/p', pathPrefix }).success).toBe(false);
  });

  it.each([
    ['simple', 'src'],
    ['nested', 'src/app'],
    ['trailing slash', 'src/'],
  ])('accepts a safe prefix (%s)', (_label, pathPrefix) => {
    expect(attestationQueryInputSchema.safeParse({ projectPath: '/p', pathPrefix }).success).toBe(true);
  });

  it('normalizes a trailing slash in the parsed prefix so query semantics match', () => {
    expect(attestationQueryInputSchema.parse({ projectPath: '/p', pathPrefix: 'src/' }).pathPrefix).toBe('src');
  });
});

describe('attestationQueryRequestSchema (renderer request, no projectPath)', () => {
  it('applies a bounded default limit and accepts an optional safe prefix', () => {
    const parsed = attestationQueryRequestSchema.parse({});
    expect(parsed.limit).toBe(256);
    expect(parsed.pathPrefix).toBeUndefined();
  });

  it('rejects a projectPath so the renderer can never select another ledger', () => {
    expect(attestationQueryRequestSchema.safeParse({ projectPath: '/project' }).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(attestationQueryRequestSchema.safeParse({ sessionId: 's1' }).success).toBe(false);
  });

  it.each([
    ['traversal', '../x'],
    ['absolute posix', '/etc'],
    ['absolute windows drive', 'C:/x'],
    ['backslash', 'src\\x'],
    ['dot segment', 'src/./x'],
    ['traversal segment', 'src/../x'],
    ['empty segment', 'src//x'],
  ])('rejects an unsafe prefix (%s)', (_label, pathPrefix) => {
    expect(attestationQueryRequestSchema.safeParse({ pathPrefix }).success).toBe(false);
  });

  it('rejects a limit above the maximum', () => {
    expect(attestationQueryRequestSchema.safeParse({ limit: 1_001 }).success).toBe(false);
  });

  it('accepts the maximum limit and a safe prefix', () => {
    expect(attestationQueryRequestSchema.safeParse({ limit: 1_000, pathPrefix: 'src/app' }).success).toBe(true);
  });
});
