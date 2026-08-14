import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  MUTATION_ATTESTATION_SCHEMA_VERSION,
  mutationAttestationSchema,
  type MutationAttestation,
} from '../../../shared/contracts/mutationAttestation';
import type { PermissionLevel } from '../../../shared/contracts/ipc';
import type { ToolActor } from '../../../shared/contracts/provenance';

/** Bound for in-memory pre-hashing; larger prior state is recorded as oversize (never read unbounded). */
export const MAX_PRE_HASH_BYTES = 8 * 1024 * 1024;

/** Stable per-project hash, mirroring SessionPermissionStore's platform-aware keying. */
export function projectPathHash(projectPath: string): string {
  const normalized = path.normalize(path.resolve(projectPath));
  const platformProject = process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
  return createHash('sha256').update(platformProject).digest('hex');
}

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * True when target resolves strictly inside projectRoot, so a project-relative
 * path can truthfully represent it. Rejects the project root itself (a file path
 * is required), exact parent traversal (`..`), `..`-segment descendants, and
 * absolute paths. A safe in-project filename such as `..foo` is permitted: it is
 * not `..` and not a `..` segment.
 */
export function isInsideProject(projectRoot: string, targetPath: string): boolean {
  const relative = path.relative(projectRoot, targetPath);
  if (relative === '' || path.isAbsolute(relative)) return false;
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) return false;
  return true;
}

export function projectRelativePath(projectRoot: string, targetPath: string): string {
  return path.relative(projectRoot, targetPath).split(path.sep).join('/');
}

export interface AttestationContext {
  actor: ToolActor;
  /** Null only when genuinely unavailable; never inferred. */
  sessionId: string | null;
  /** Null only when genuinely unavailable; never inferred. */
  permissionLevel: PermissionLevel | null;
}

export interface DirectWriteFacts {
  operation: 'write' | 'edit';
  projectRoot: string;
  targetPath: string;
  /** Content actually written; hashed for postHash and never persisted. */
  content: string;
  preHash: string | null;
  preState: 'missing' | 'hashed' | 'oversize';
}

export type AttestationRecordInput = DirectWriteFacts & AttestationContext;

/**
 * Build a validated v1 attestation. Returns null when the target is outside the
 * project (no truthful project-relative path) or the constructed row is invalid.
 */
export function buildAttestation(input: AttestationRecordInput, recordedAt: number = Date.now()): MutationAttestation | null {
  if (!isInsideProject(input.projectRoot, input.targetPath)) return null;
  const parsed = mutationAttestationSchema.safeParse({
    id: randomUUID(),
    schemaVersion: MUTATION_ATTESTATION_SCHEMA_VERSION,
    recordedAt,
    projectPathHash: projectPathHash(input.projectRoot),
    sessionId: input.sessionId,
    actor: input.actor,
    permissionLevel: input.permissionLevel,
    operation: input.operation,
    path: projectRelativePath(input.projectRoot, input.targetPath),
    preHash: input.preHash,
    postHash: sha256Hex(input.content),
    preState: input.preState,
    captureKind: 'direct-file-tool',
  });
  return parsed.success ? parsed.data : null;
}

/** Sink injected into the controlled write choke point. No-op when absent (preserves existing callers). */
export interface AttestationSink {
  /** Current actor/session/permission at write time, or null to skip this write. */
  resolveContext: () => AttestationContext | null;
  /** Record a successful direct write/edit (facts merged with the resolved context). */
  record: (input: AttestationRecordInput) => void;
}

export interface AttestationPruneOptions {
  maxRecords: number;
  maxBytes: number;
  maxAgeMs: number;
}

/**
 * Pure retention policy. Records are assumed already in chronological (append)
 * order, so the newest are at the end. The policy is applied in one pass:
 *
 * - keep only the most recent `maxRecords` rows;
 * - drop rows older than the age cutoff;
 * - trim oldest rows first until the serialized JSONL byte size (each row plus
 *   its trailing newline, matching on-disk format) fits `maxBytes`.
 *
 * The single newest record is always retained, even if it alone exceeds
 * `maxBytes`. This is O(n): each row is serialized once and the trim advances a
 * drop index instead of repeatedly mapping/stringifying/shifting.
 */
export function pruneAttestations(rows: readonly MutationAttestation[], now: number, options: AttestationPruneOptions): MutationAttestation[] {
  const cutoff = now - options.maxAgeMs;
  const start = Math.max(0, rows.length - options.maxRecords);
  const kept: MutationAttestation[] = [];
  const rowBytes: number[] = [];
  let totalBytes = 0;
  for (let index = start; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.recordedAt < cutoff) continue;
    const bytes = Buffer.byteLength(`${JSON.stringify(row)}\n`, 'utf8');
    kept.push(row);
    rowBytes.push(bytes);
    totalBytes += bytes;
  }
  // Drop oldest rows first until the JSONL fits the byte cap. Always keep the
  // single newest record even if it alone exceeds the cap.
  let drop = 0;
  while (kept.length - drop > 1 && totalBytes > options.maxBytes) {
    totalBytes -= rowBytes[drop]!;
    drop += 1;
  }
  return drop === 0 ? kept : kept.slice(drop);
}
