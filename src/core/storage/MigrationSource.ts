import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { FatePaths } from '../FatePaths';
import { durableImportDigest, durableSessionKey, type DurableSessionImport } from '../durable/FateDurableStore';
import { QUEUE_MAX_BYTES, assertBytes } from '../durable/StateDocuments';
import { queuedMessageSchema } from '../../shared/contracts/ipc';
import { taskListSchema } from '../../shared/contracts/tasks';
import { goalMaxStateSchema, type GoalMaxState } from '../../shared/contracts/goalmaxxing';
import { migrateGoalMaxSnapshot } from '../../main/pi/goalmaxxing/GoalMaxMigrations';
import { agentTeamSchema } from '../../shared/contracts/multiAgent';
import { readSessionSnapshot } from '../../main/pi/SessionSnapshotReader';
import { assertMigrationPath, fingerprintMigrationFile, listMigrationFiles, migrationHash, readMigrationJson, type MigrationFile } from './MigrationFiles';

export const MIGRATED_NAMESPACES = ['session-queues', 'tasks', 'goalmaxxing'] as const;
const canonical = (value: string): string => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const queueSchema = z.object({ version: z.literal(1), projectPath: z.string().min(1).max(32768), sessionId: z.string().min(1).max(500), messages: z.array(queuedMessageSchema.strict()).max(100) }).strict();
const eventSchema = z.object({ goalId: z.string().min(1).max(160), revision: z.number().int().nonnegative().safe(), status: z.string().min(1).max(100), phase: z.string().max(100).optional(), timestamp: z.number().int().nonnegative().safe() }).strict();
const sessionHeader = z.object({ type: z.literal('session'), id: z.string().min(1).max(500), version: z.union([z.literal(1), z.literal(2), z.literal(3)]), cwd: z.string().min(1).max(32768) }).passthrough();
type MutableImport = { -readonly [K in keyof DurableSessionImport]: DurableSessionImport[K] };
export interface MigrationSource {
  readonly files: MigrationFile[];
  readonly references: MigrationFile[];
  readonly projects: Array<{ path: string; device: string; inode: string }>;
  readonly snapshots: DurableSessionImport[];
  readonly sessions: Array<{ key: string; digest: string }>;
  readonly errors: string[];
  readonly sourceDigest: string;
}

function recoverGoal(original: GoalMaxState): GoalMaxState {
  // An archived completion remains in the source/backup. The new execution view
  // must not certify old effects or carry an old authority snapshot into a run.
  return goalMaxStateSchema.parse({ ...original, status: 'paused', executionState: 'idle',
    permission: { ...original.permission, permissionLevel: 'read-only', projectTrusted: false },
    continuation: { ...original.continuation, pending: false }, completedAt: null,
    childAssignments: original.childAssignments.map((child) => ({ ...child, status: child.status === 'running' || child.status === 'pending' ? 'blocked' : child.status })),
    evidence: original.evidence.map((evidence) => ({ ...evidence, current: false })),
    blockedReason: 'UNKNOWN: Imported historical state requires explicit host review. No execution or draft was resumed.' });
}

/** Reads only selected namespaces and referenced transcripts. Never opens SDK sessions or a Harness. */
export async function readMigrationSource(paths: FatePaths): Promise<MigrationSource> {
  const files: MigrationFile[] = []; const references: MigrationFile[] = []; const errors: string[] = [];
  const snapshots = new Map<string, MutableImport>(); const directories = new Map<string, MutableImport>();
  const pendingFiles: string[] = []; let total = 0;
  const acquire = (projectPath: string, sessionId: string): MutableImport => {
    if (!path.isAbsolute(projectPath) || path.normalize(projectPath) !== projectPath || /[\u0000\r\n]/u.test(projectPath)) throw new Error('Source project identity is not canonical.');
    const normalizedProject = canonical(projectPath);
    const key = durableSessionKey(normalizedProject, sessionId); let snapshot = snapshots.get(key);
    if (!snapshot) {
      if (snapshots.size >= 1_000) throw new Error('Migration exceeds the session bound.');
      snapshot = { projectPath: normalizedProject, sessionId, queues: [], tasks: null, goal: null, briefs: {}, archives: [], goalEvents: [] }; snapshots.set(key, snapshot);
    }
    return snapshot;
  };
  for (const namespace of MIGRATED_NAMESPACES) {
    try {
      const root = path.join(paths.dataRoot, namespace);
      for (const target of await listMigrationFiles(root, true)) {
        const name = path.relative(paths.dataRoot, target).split(path.sep).join('/');
        const fingerprint = await fingerprintMigrationFile(target, name); files.push(fingerprint); total += fingerprint.bytes;
        if (total > 128 * 1024 * 1024) throw new Error('Imported state exceeds the bounded migration budget (transcripts are separate).');
        const parts = name.split('/');
        if (parts[1] !== 'v1') throw new Error(`Unsupported ${namespace} namespace version.`);
        if (namespace === 'session-queues') {
          if (parts.length !== 4 || !/^instance-(0|[1-9][0-9]{0,4})$/u.test(parts[2]!) || !/^[a-f0-9]{64}\.json$/u.test(parts[3]!)) throw new Error('Unsupported queue record path.');
          const value = queueSchema.parse(await readMigrationJson(target));
          if (parts[3] !== `${migrationHash(`${canonical(value.projectPath).normalize('NFC')}\0${value.sessionId}`)}.json`) throw new Error('Queue filename does not match its identity.');
          const snapshot = acquire(value.projectPath, value.sessionId); const instanceSlot = Number(parts[2]!.slice(9));
          if (snapshot.queues.some((item) => item.instanceSlot === instanceSlot)) throw new Error('Duplicate queue slot.');
          snapshot.queues.push({ instanceSlot, messages: value.messages });
        } else if (namespace === 'tasks') {
          if (parts.length !== 5 || parts[4] !== 'current.json') throw new Error('Unsupported task record path.');
          const value = taskListSchema.parse(await readMigrationJson(target, 1024 * 1024));
          if (parts[2] !== migrationHash(canonical(value.projectPath)).slice(0, 32) || parts[3] !== migrationHash(value.sessionId).slice(0, 32)) throw new Error('Task directory does not match its identity.');
          const snapshot = acquire(value.projectPath, value.sessionId); if (snapshot.tasks) throw new Error('Duplicate task snapshot.');
          snapshot.tasks = taskListSchema.parse({ ...value, tasks: value.tasks.map((item) => ({ ...item, status: item.status === 'in-progress' ? 'blocked' : item.status, verified: false, verifiedAt: null })) });
        } else if (parts.length === 5 && parts[4] === 'current.json' || parts.length === 6 && parts[4] === 'archive' && /^[a-f0-9]{24}-[1-9][0-9]*\.json$/u.test(parts[5]!)) {
          const value = migrateGoalMaxSnapshot(await readMigrationJson(target, 4 * 1024 * 1024));
          if (parts[2] !== migrationHash(canonical(value.projectPath)).slice(0, 32) || parts[3] !== migrationHash(value.sessionId).slice(0, 32)) throw new Error('Goal directory does not match its identity.');
          if (parts.length === 6 && parts[5] !== `${migrationHash(value.id).slice(0, 24)}-${value.revision}.json`) throw new Error('Archived goal filename does not match its identity.');
          const snapshot = acquire(value.projectPath, value.sessionId); directories.set(parts.slice(0, 4).join('/'), snapshot);
          if (parts.length === 5) { if (snapshot.goal) throw new Error('Duplicate current goal.'); snapshot.goal = recoverGoal(value); }
          else snapshot.archives.push({ state: recoverGoal(value), briefs: {} });
        } else pendingFiles.push(target);
      }
    } catch (error) { errors.push(`${namespace}: ${error instanceof Error ? error.message : 'Unreadable source.'}`); }
  }
  // A complete namespace backup includes every brief/archive/event, never merely current.json.
  const archiveBriefs = new Map<MutableImport, Record<string, string>>();
  for (const target of pendingFiles) {
    try {
      const parts = path.relative(paths.dataRoot, target).split(path.sep); const snapshot = directories.get(parts.slice(0, 4).join('/'));
      if (!snapshot) throw new Error('Goal metadata has no validated current or archived owner.');
      const name = parts.at(-1)!;
      if ((parts.length === 5 || parts.length === 6 && parts[4] === 'archive') && /^brief-[a-f0-9]{16}-[a-f0-9]{16}\.txt$/u.test(name)) {
        const stat = await fs.stat(target); if (stat.size > 800_000) throw new Error('Goal brief exceeds its bound.');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(target));
        if (parts.length === 5) snapshot.briefs[name] = text;
        else { const briefs = archiveBriefs.get(snapshot) ?? {}; briefs[name] = text; archiveBriefs.set(snapshot, briefs); }
      } else if (parts.length === 5 && name === 'events.jsonl') {
        if ((await fs.stat(target)).size > 2 * 1024 * 1024) throw new Error('Goal event journal exceeds its bound.');
        const events: NonNullable<DurableSessionImport['goalEvents']> = [];
        await fingerprintMigrationFile(target, name, (value) => { if (events.length >= 10_000) throw new Error('Goal event count exceeds its bound.'); events.push(eventSchema.parse(value)); });
        snapshot.goalEvents = events;
      } else throw new Error('Unsupported goal file; it was not silently discarded.');
    } catch (error) { errors.push(`goalmaxxing: ${error instanceof Error ? error.message : 'Unreadable metadata.'}`); }
  }
  for (const snapshot of snapshots.values()) {
    try {
      // Legacy's default slot was 0; ordinary v2 core's primary slot is 1.
      // Preserve order within each source, with slot 0 preceding slot 1. No
      // UUID de-duplication is safe, even when the payloads happen to match.
      const legacy = snapshot.queues.find((queue) => queue.instanceSlot === 0);
      if (legacy) {
        const primary = snapshot.queues.find((queue) => queue.instanceSlot === 1);
        const messages = [...legacy.messages, ...(primary?.messages ?? [])];
        if (messages.length > 100) throw new Error('Merged primary queue exceeds 100 drafts.');
        if (new Set(messages.map((message) => message.id)).size !== messages.length) throw new Error('Merged primary queue contains colliding draft IDs.');
        assertBytes({ projectPath: snapshot.projectPath, sessionId: snapshot.sessionId, schemaVersion: 1, instanceSlot: 1, messages }, QUEUE_MAX_BYTES, 'Merged primary queue');
        snapshot.queues = [...snapshot.queues.filter((queue) => queue.instanceSlot !== 0 && queue.instanceSlot !== 1), { instanceSlot: 1, messages }];
      }
      for (const archive of snapshot.archives) Object.assign(archive.briefs, archiveBriefs.get(snapshot));
      if (archiveBriefs.has(snapshot) && !snapshot.archives.length) throw new Error('Archived briefs have no retained goal snapshot.');
      for (const item of [{ state: snapshot.goal, briefs: snapshot.briefs }, ...snapshot.archives]) {
        if (!item.state?.originalBriefRef) continue;
        const ref = item.state.originalBriefRef;
        if (path.basename(ref) !== ref || !item.briefs[ref] || migrationHash(item.briefs[ref]!) !== item.state.originalBriefHash) throw new Error('Goal source brief reference or digest is invalid.');
      }
      const goals = new Set([snapshot.goal?.id, ...snapshot.archives.map((item) => item.state.id)].filter(Boolean));
      if (snapshot.tasks?.goalId && !goals.has(snapshot.tasks.goalId)) throw new Error('Task list references an absent goal.');
      const retainedGoals = [...(snapshot.goal ? [snapshot.goal] : []), ...snapshot.archives.map((item) => item.state)];
      for (const task of snapshot.tasks?.tasks ?? []) {
        if (task.source !== 'goalmax') continue;
        const matches = retainedGoals.filter((goal) => goal.id === task.goalId);
        if (!matches.length || task.goalCriterionId && !matches.some((goal) => goal.criteria.some((criterion) => criterion.id === task.goalCriterionId))) {
          throw new Error('Task item references an absent goal or criterion.');
        }
      }
      for (const goal of retainedGoals) if (goal.childAssignments.some((child) => child.criterionIds.some((id) => !goal.criteria.some((criterion) => criterion.id === id)))) {
        throw new Error('Goal child assignment references an absent criterion.');
      }
      if (snapshot.goalEvents?.some((event) => !goals.has(event.goalId))) throw new Error('Goal journal references an absent retained goal.');
      snapshot.queues.sort((a, b) => a.instanceSlot - b.instanceSlot);
      snapshot.archives.sort((a, b) => a.state.id.localeCompare(b.state.id) || a.state.revision - b.state.revision);
    } catch (error) { errors.push(`references: ${error instanceof Error ? error.message : 'Invalid reference.'}`); }
  }
  const projectPaths = new Set([...snapshots.values()].map((item) => item.projectPath));
  for (const project of [...projectPaths].sort()) {
    try {
      await assertMigrationPath(project); if (!(await fs.stat(project)).isDirectory()) throw new Error('Referenced project is unavailable.');
      const wanted = new Map([...snapshots.values()].filter((snapshot) => snapshot.projectPath === project).map((snapshot) => [snapshot.sessionId, snapshot]));
      const directory = path.join(paths.sessionsRoot, `--${project.replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`);
      const found = new Set<string>();
      for (const target of await listMigrationFiles(directory)) {
        if (path.dirname(target) !== directory || !target.endsWith('.jsonl')) throw new Error('Unsupported transcript directory content.');
        const handle = await fs.open(target, 'r'); let header: z.infer<typeof sessionHeader>;
        try { const buffer = Buffer.alloc(65536); const read = await handle.read(buffer, 0, buffer.length, 0); const newline = buffer.subarray(0, read.bytesRead).indexOf(10); if (newline < 0) throw new Error('Session header is missing or oversized.'); header = sessionHeader.parse(JSON.parse(buffer.subarray(0, newline).toString('utf8'))); }
        finally { await handle.close(); }
        if (!wanted.has(header.id)) continue;
        if (canonical(header.cwd) !== project || found.has(header.id)) throw new Error('Session identity is mismatched or duplicated.');
        found.add(header.id); let count = 0; let hasTeams = false;
        const fingerprint = await fingerprintMigrationFile(target, target, (raw) => {
          if (++count > 2_000_000) throw new Error('Transcript record count exceeds its supported bound.');
          if (count === 1) { sessionHeader.parse(raw); return; }
          const record = z.object({ type: z.string().min(1) }).passthrough().parse(raw);
          if (record.type === 'custom' && record.customType === 'fate-agent-team-event') hasTeams = true;
        }); references.push(fingerprint);
        if (hasTeams) {
          // Reuse the established bounded active-branch reader. An old branch's
          // worktree, or a later deletion, cannot be resurrected from file order.
          const preview = await readSessionSnapshot(target, header.id);
          if (!preview || preview.previewNotice?.includes('child-agent state')) throw new Error('Retained Team references cannot be read completely within their bounded preview.');
          const teams = new Map<string, z.infer<typeof agentTeamSchema> | null>();
          for (const record of preview.branch) {
            if (record.type !== 'custom' || record.customType !== 'fate-agent-team-event' || record.data === undefined) continue;
            const data = z.object({ kind: z.literal('fate-agent-team-event'), version: z.literal(1), teamId: z.string().min(1),
              type: z.string().min(1), payload: z.object({ team: z.unknown().optional() }).passthrough() }).passthrough().parse(record.data);
            const team = data.type === 'team.deleted' ? null : agentTeamSchema.parse(data.payload.team);
            if (team && (team.id !== data.teamId || team.rootSessionId !== header.id || canonical(team.projectPath) !== project)) throw new Error('Retained Team identity is inconsistent.');
            teams.set(data.teamId, team);
          }
          for (const team of teams.values()) if (team) for (const node of team.nodes) {
            if (node.workspace?.mode === 'worktree' && node.workspace.state !== 'removed') projectPaths.add(canonical(node.workspace.path));
          }
        }
      }
      if ([...wanted.keys()].some((id) => !found.has(id))) throw new Error('A migrated record has no original session transcript.');
    } catch (error) { errors.push(`sessions: ${error instanceof Error ? error.message : 'Unreadable transcript.'}`); }
  }
  const projects: MigrationSource['projects'] = [];
  for (const project of [...projectPaths].sort()) {
    try { await assertMigrationPath(project); const stat = await fs.stat(project); if (!stat.isDirectory()) throw new Error('Missing retained project/worktree.'); projects.push({ path: project, device: String(stat.dev), inode: String(stat.ino) }); }
    catch (error) { errors.push(`workspaces: ${error instanceof Error ? error.message : 'Missing retained project/worktree.'}`); }
  }
  const ordered = [...snapshots.values()].sort((a, b) => durableSessionKey(a.projectPath, a.sessionId).localeCompare(durableSessionKey(b.projectPath, b.sessionId)));
  const sessions: MigrationSource['sessions'] = [];
  for (const snapshot of ordered) { try { sessions.push({ key: durableSessionKey(snapshot.projectPath, snapshot.sessionId), digest: durableImportDigest(snapshot) }); } catch (error) { errors.push(`import: ${error instanceof Error ? error.message : 'Invalid snapshot.'}`); } }
  files.sort((a, b) => a.name.localeCompare(b.name)); references.sort((a, b) => a.name.localeCompare(b.name));
  return { files, references, projects, snapshots: ordered, sessions, errors,
    sourceDigest: migrationHash(JSON.stringify({ files, references, projects, sessions })) };
}
