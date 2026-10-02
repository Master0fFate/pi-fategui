import { createHash } from 'node:crypto';
import { promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { apply, assertValidOp, type Op } from '@earendil-works/chord/delta';
import { z } from 'zod';
import { OwnerLock, canonicalFuturePath } from '../ownership/OwnerLock';
import { DurableStorageCloseUncertainError } from '../durable/OwnedDurableStorage';
import { assertPrivateWindowsAcl } from '../storage/WindowsPrivateAcl';

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 10_000;
const MAX_ROWS = 10_000;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_RECORD_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_REVISIONS = 2048;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const namePattern = /^workflow-([a-f0-9]{64})\.sqlite$/u;
const identitySchema = z.object({ workflowId: z.string().min(1).max(500), parentSessionId: z.string().min(1).max(500), cwd: z.string().min(1).max(32768) }).strict();
const fenceSchema = z.object({ state: z.enum(['idle', 'active', 'UNKNOWN']), reason: z.string().max(16000).optional(), taskIds: z.array(z.number().int().positive().safe()).max(MAX_ROWS).optional(), submissionIds: z.array(z.number().int().positive().safe()).max(MAX_ROWS).optional() }).strict();
type Identity = z.infer<typeof identitySchema>;
type DocumentRow = { id: number; kind: string; family: number; key_value: string; scope_kind: string; owner_id: number; created_at: number; retired_at: number | null; record: string };
type Revision = { seq: number; kind: 'base' | 'delta'; version: number; content: string };
export interface NativeWorkflowRecoveryBlock { readonly filename: string; readonly workflowId?: string; readonly parentSessionId?: string; readonly cwd?: string; readonly reason: string }
export interface NativeWorkflowRecoveryInspection { readonly blocked: readonly NativeWorkflowRecoveryBlock[]; readonly uncertainProfile: boolean }
export interface InspectOwnedNativeWorkflowRecoveryOptions { readonly dataRoot: string; readonly profileOwner: OwnerLock; readonly maxFiles: number }
class WorkflowOwnerLost extends Error {}

function sameFile(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs; }
function regular(stat: BigIntStats): boolean { return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && (process.platform === 'win32' || (stat.mode & 0o077n) === 0n); }
function inside(parent: string, child: string): boolean { const r = path.relative(parent, child); return r === '' || r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); }
function rows<T>(db: DatabaseSync, sql: string, ...params: Array<string | number>): T[] { return db.prepare(sql).all(...params) as T[]; }
function one<T>(db: DatabaseSync, sql: string, ...params: Array<string | number>): T { const result = rows<T>(db, sql, ...params); if (result.length !== 1) throw new Error('Native workflow metadata is missing or ambiguous.'); return result[0]!; }
function assertBound(db: DatabaseSync, table: 'tasks' | 'submissions' | 'documents'): void {
  const count = one<{ n: number; bytes: number; largest: number }>(db, `SELECT count(*) AS n, coalesce(sum(length(CAST(record AS BLOB))),0) AS bytes, coalesce(max(length(CAST(record AS BLOB))),0) AS largest FROM ${table}`);
  if (count.n > MAX_ROWS || count.bytes > MAX_RECORD_TOTAL_BYTES || count.largest > MAX_RECORD_BYTES) throw new Error('Native workflow record inspection exceeds its quota.');
}

function validateSqlite(db: DatabaseSync): void {
  const expected = new Set(['durable_schema', 'durable_metadata', 'record_ids', 'conversations', 'entries', 'tasks', 'submissions', 'documents', 'document_revisions']);
  const tables = rows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  if (tables.length !== expected.size || tables.some((row) => !expected.has(row.name))) throw new Error('Native workflow schema is unsupported.');
  if (one<{ version: number }>(db, 'SELECT version FROM durable_schema WHERE singleton=1').version !== 1) throw new Error('Native workflow schema version is unsupported.');
  const integrity = rows<{ quick_check: string }>(db, 'SELECT * FROM pragma_quick_check');
  if (integrity.length !== 1 || integrity[0]?.quick_check !== 'ok') throw new Error('Native workflow database integrity is uncertain.');
  const metadata = one<{ next_id: string; next_seq: number }>(db, 'SELECT next_id,next_seq FROM durable_metadata');
  const max = one<{ id: number | null; seq: number | null }>(db, `SELECT
    (SELECT max(id) FROM (SELECT id FROM record_ids UNION ALL SELECT id FROM conversations UNION ALL SELECT id FROM entries UNION ALL SELECT id FROM tasks UNION ALL SELECT id FROM submissions UNION ALL SELECT id FROM documents)) AS id,
    (SELECT max(seq) FROM (SELECT seq FROM document_revisions UNION ALL SELECT commit_seq AS seq FROM entries UNION ALL SELECT created_at AS seq FROM documents UNION ALL SELECT retired_at AS seq FROM documents)) AS seq`);
  const nextId = Number(metadata.next_id);
  if (!Number.isSafeInteger(nextId) || nextId < 2 || String(nextId) !== metadata.next_id || nextId <= (max.id ?? 1)
    || !Number.isSafeInteger(metadata.next_seq) || metadata.next_seq < 1 || metadata.next_seq <= (max.seq ?? 0)) throw new Error('Native workflow allocation metadata is corrupt.');
  const invalid = one<{ n: number }>(db, `SELECT count(*) AS n FROM (
    SELECT seq FROM document_revisions WHERE seq<1 UNION ALL SELECT commit_seq FROM entries WHERE commit_seq<1
    UNION ALL SELECT created_at FROM documents WHERE created_at<1 OR retired_at<created_at
      OR json_extract(record,'$.createdAt') IS NOT created_at OR json_extract(record,'$.retiredAt') IS NOT retired_at)`);
  if (invalid.n) throw new Error('Native workflow lifecycle metadata is corrupt.');
  for (const table of ['tasks', 'submissions', 'documents'] as const) assertBound(db, table);
}

/** Materialize only bounded native document revisions using Chord's public delta semantics. */
function document(db: DatabaseSync, kind: string, inspect?: (value: unknown) => void): unknown {
  const records = rows<DocumentRow>(db, 'SELECT id,kind,family,key_value,scope_kind,owner_id,created_at,retired_at,record FROM documents WHERE kind=? ORDER BY id LIMIT 3', JSON.stringify(kind));
  // Retired/replaced incarnations cannot prove a previous UNKNOWN was cleared legitimately.
  if (records.length !== 1 || records[0]!.retired_at !== null) throw new Error(`Native workflow ${kind} is missing, retired, or ambiguous.`);
  const record = records[0]!;
  const parsed = z.object({ id: z.number().int().positive().safe(), kind: z.literal(kind), scope: z.object({ kind: z.literal('session') }).strict(), createdAt: z.number().int().positive().safe() }).strict().parse(JSON.parse(record.record));
  if (record.id !== parsed.id || record.scope_kind !== 'session' || record.owner_id !== 0 || record.family !== 0 || record.key_value !== JSON.stringify('') || record.created_at !== parsed.createdAt) throw new Error('Native workflow document address is inconsistent.');
  const quota = one<{ n: number; bytes: number; largest: number }>(db, 'SELECT count(*) AS n,coalesce(sum(length(CAST(content AS BLOB))),0) AS bytes,coalesce(max(length(CAST(content AS BLOB))),0) AS largest FROM document_revisions WHERE document_id=?', record.id);
  if (!quota.n || quota.n > MAX_REVISIONS || quota.bytes > 4 * 1024 * 1024 || quota.largest > MAX_DOCUMENT_BYTES) throw new Error('Native workflow document revision quota exceeded or content missing.');
  let value: unknown;
  let previous = 0;
  for (const revision of rows<Revision>(db, 'SELECT seq,kind,version,content FROM document_revisions WHERE document_id=? ORDER BY seq', record.id)) {
    if (revision.version !== 1 || !Number.isSafeInteger(revision.seq) || revision.seq <= previous || revision.seq < record.created_at) throw new Error('Native workflow document revision is unsupported.');
    previous = revision.seq;
    const content: unknown = JSON.parse(revision.content);
    if (revision.kind === 'base') value = content;
    else {
      if (value === undefined || revision.kind !== 'delta' || !Array.isArray(content)) throw new Error('Native workflow delta has no valid base.');
      for (const op of content) assertValidOp(op);
      value = apply(value, content as Op[]);
    }
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_DOCUMENT_BYTES) throw new Error('Native workflow materialized document exceeds its quota.');
    inspect?.(value);
  }
  return value;
}

function executionReason(db: DatabaseSync): string | null {
  let reason: string | null = null;
  const tasks = rows<{ id: number; conversation_id: number; status: string; record: string }>(db, 'SELECT id,conversation_id,status,record FROM tasks ORDER BY id LIMIT ?', MAX_ROWS + 1);
  for (const row of tasks) {
    const task = z.object({ id: z.number().int().positive().safe(), conversationId: z.number().int().positive().safe(), state: z.object({ status: z.enum(['pending', 'running', 'waiting', 'completing', 'terminal']), outcome: z.unknown().optional() }).passthrough() }).passthrough().parse(JSON.parse(row.record));
    if (task.id !== row.id || task.conversationId !== row.conversation_id || task.state.status !== row.status) throw new Error('Native workflow task indexes disagree with committed records.');
    if (task.state.status !== 'terminal') reason ??= 'Native workflow has nonterminal tasks; automatic continuation is prohibited.';
    else z.object({ status: z.enum(['completed', 'failed', 'aborted', 'orphaned', 'faulted']) }).passthrough().parse(task.state.outcome);
  }
  for (const row of rows<{ id: number; conversation_id: number; status: string; record: string }>(db, 'SELECT id,conversation_id,status,record FROM submissions ORDER BY id LIMIT ?', MAX_ROWS + 1)) {
    const submission = z.object({ id: z.number().int().positive().safe(), conversationId: z.number().int().positive().safe(), status: z.enum(['queued', 'placed', 'done', 'unanswered']) }).passthrough().parse(JSON.parse(row.record));
    if (submission.id !== row.id || submission.conversationId !== row.conversation_id || submission.status !== row.status) throw new Error('Native workflow submission indexes disagree with committed records.');
    if (submission.status === 'queued' || submission.status === 'placed') reason ??= 'Native workflow has unsettled submissions; automatic continuation is prohibited.';
  }
  return reason;
}

/**
 * Startup inspection only. No Harness/Session/Storage construction, migration,
 * mintId, task reconciliation or writes. Immutable read-only SQLite suppresses
 * even WAL/SHM creation. Existing sidecars are retained and treated as uncertain
 * instead of being ignored by immutable mode or checkpointed during inspection.
 */
export async function inspectOwnedNativeWorkflowRecovery(options: InspectOwnedNativeWorkflowRecoveryOptions): Promise<NativeWorkflowRecoveryInspection> {
  if (!(options.profileOwner instanceof OwnerLock) || !path.isAbsolute(options.dataRoot) || !Number.isSafeInteger(options.maxFiles) || options.maxFiles < 1 || options.maxFiles > 1024) throw new Error('Workflow inspection requires a real profile owner and a bounded file count.');
  const dataRoot = await canonicalFuturePath(options.dataRoot);
  if (!inside(await canonicalFuturePath(options.profileOwner.record.resource), dataRoot) || !path.basename(options.profileOwner.lockPath).startsWith('profile-')) throw new Error('Workflow inspection is outside profile ownership.');
  const assertOwner = async () => {
    try {
      const directory = await fs.lstat(options.profileOwner.lockPath, { bigint: true });
      if (!directory.isDirectory() || directory.isSymbolicLink() || process.platform !== 'win32' && (directory.mode & 0o077n) !== 0n) throw new Error('Invalid owner directory.');
      const ownerFile = path.join(options.profileOwner.lockPath, 'owner.json');
      const stat = await fs.lstat(ownerFile, { bigint: true });
      if (!regular(stat) || stat.size > 4096n) throw new Error('Invalid owner record.');
      const owner: unknown = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
      if (!owner || typeof owner !== 'object' || !('token' in owner) || !('resource' in owner) || owner.token !== options.profileOwner.record.token || owner.resource !== options.profileOwner.record.resource) throw new Error('Changed owner token.');
    } catch (cause) { throw new WorkflowOwnerLost('Workflow profile ownership was lost or cannot be verified.', { cause }); }
  };
  await assertOwner();
  await assertPrivateWindowsAcl(options.profileOwner.lockPath);
  const blocked: NativeWorkflowRecoveryBlock[] = [];
  let uncertainProfile = false;
  const directory = path.join(dataRoot, 'durable', 'v1');
  for (const target of [...new Set([options.dataRoot, dataRoot, path.dirname(directory), directory])]) {
    try {
      const stat = await fs.lstat(target, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32' && (stat.mode & 0o077n) !== 0n) throw new Error('unsafe');
      await assertPrivateWindowsAcl(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { blocked, uncertainProfile };
      return { blocked: [{ filename: target, reason: 'Native workflow namespace is unsafe or cannot be inspected.' }], uncertainProfile: true };
    }
  }
  const files = new Map<string, string[]>();
  let entries = 0;
  for await (const entry of await fs.opendir(directory)) {
    if (++entries > MAX_DIRECTORY_ENTRIES) return { blocked: [{ filename: directory, reason: 'Native workflow directory inventory exceeds its quota.' }], uncertainProfile: true };
    if (!entry.name.startsWith('workflow-')) continue;
    const basename = entry.name.replace(/-(?:wal|shm|journal)$/u, '');
    if (!namePattern.test(basename)) {
      blocked.push({ filename: path.join(directory, entry.name), reason: 'Native workflow filename is ambiguous or unsupported.' }); uncertainProfile = true;
      if (blocked.length > options.maxFiles) return { blocked: [{ filename: directory, reason: 'Native workflow ambiguous-file inventory exceeds its quota.' }], uncertainProfile: true };
      continue;
    }
    const parts = files.get(basename) ?? []; parts.push(entry.name); files.set(basename, parts);
    if (files.size > options.maxFiles) return { blocked: [{ filename: directory, reason: 'Native workflow file inventory exceeds its quota.' }], uncertainProfile: true };
  }
  let totalBytes = 0n;
  for (const [name, parts] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const filename = path.join(directory, name);
    let identity: Identity | undefined;
    let db: DatabaseSync | undefined;
    let inspectionError: unknown;
    try {
      await assertOwner();
      if (parts.length !== 1 || parts[0] !== name) throw new Error('Native workflow has retained SQLite sidecars; stopped-owner recovery is required.');
      const before = await fs.lstat(filename, { bigint: true });
      if (!regular(before) || before.size < 1n || before.size > BigInt(MAX_FILE_BYTES)) throw new Error('Native workflow file is unsafe, empty, or exceeds its quota.');
      totalBytes += before.size;
      if (totalBytes > BigInt(MAX_TOTAL_BYTES)) throw new Error('Native workflow aggregate size quota exceeded.');
      await assertPrivateWindowsAcl(filename);
      const sqlite = await import('node:sqlite');
      const uri = pathToFileURL(filename); uri.searchParams.set('mode', 'ro'); uri.searchParams.set('immutable', '1');
      db = new sqlite.DatabaseSync(uri.href, { readOnly: true });
      validateSqlite(db);
      identity = identitySchema.parse(document(db, 'fate.workflow.identity'));
      if (!path.isAbsolute(identity.cwd) || path.normalize(identity.cwd) !== identity.cwd || Object.values(identity).some((value) => value.includes('\0'))
        || `workflow-${createHash('sha256').update(`${identity.cwd}\0${identity.parentSessionId}\0${identity.workflowId}`).digest('hex')}.sqlite` !== name) { identity = undefined; throw new Error('Native workflow identity does not match its storage address.'); }
      let historicalUnknown = false;
      const fence = fenceSchema.parse(document(db, 'fate.execution.fence', (value) => { if (fenceSchema.parse(value).state === 'UNKNOWN') historicalUnknown = true; }));
      // Review eligibility requires every bounded execution record to validate,
      // even when a retained UNKNOWN/active fence already blocks ordinary startup.
      const execution = executionReason(db);
      const reason = historicalUnknown ? 'Native workflow has retained UNKNOWN evidence; automatic continuation is prohibited.'
        : fence.state !== 'idle' ? 'Native workflow was active at shutdown; automatic continuation is prohibited.' : execution;
      if (reason) blocked.push({ filename, ...identity, reason });
      if (!sameFile(before, await fs.lstat(filename, { bigint: true }))) throw new Error('Native workflow file changed during read-only inspection.');
      for (const suffix of ['-wal', '-shm', '-journal']) {
        try { await fs.lstat(`${filename}${suffix}`); throw new Error('Native workflow sidecars appeared during inspection.'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      await assertOwner();
    } catch (error) {
      inspectionError = error;
      if (error instanceof WorkflowOwnerLost) throw error;
      blocked.push({ filename, ...(identity ?? {}), reason: error instanceof Error && !('issues' in error) ? error.message.slice(0, 500) : 'Native workflow committed metadata is corrupt or unsupported.' });
      if (!identity) uncertainProfile = true;
    } finally {
      if (db) try { db.close(); }
      catch (closeError) { throw new DurableStorageCloseUncertainError([...(inspectionError ? [inspectionError] : []), closeError], 'Read-only workflow database close is uncertain; retain profile ownership.'); }
    }
  }
  return { blocked, uncertainProfile };
}
