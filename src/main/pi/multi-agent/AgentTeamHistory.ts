import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentTeam } from '../../../shared/contracts/multiAgent';
import { addUsage, emptyUsage } from '../SubagentSessionFactory';

export type ColdChildHealth = 'ok' | 'missing' | 'unknown';

/** Strict recovery-only health check. Unlike display reconciliation, an unreadable
 * directory or transcript cannot certify a saved Team task. No mutation/replay. */
export async function inspectAgentTeamChildStorage(team: AgentTeam, roots: readonly string[]): Promise<ColdChildHealth> {
  for (const node of team.nodes.filter((entry) => entry.depth > 0)) {
    const relative = path.join(safeDirectoryKey(team.rootSessionId), safeDirectoryKey(team.id), safeDirectoryKey(node.id));
    let found = false;
    for (const root of roots) {
      let directory: Awaited<ReturnType<typeof fs.opendir>>;
      try { directory = await fs.opendir(path.join(root, relative)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        return 'unknown';
      }
      try {
        const candidates: string[] = [];
        let count = 0;
        for await (const entry of directory) {
          if (++count > 256) return 'unknown';
          if (!entry.name.endsWith('.jsonl')) continue;
          if (!entry.isFile()) return 'unknown';
          candidates.push(entry.name);
        }
        // Match ensureNodeSession: sorted last file in the first root that has
        // transcripts. A valid decoy must not hide a corrupt selected file.
        if (!candidates.length) continue;
        const selected = candidates.sort().at(-1)!;
        const file = await fs.open(path.join(root, relative, selected), 'r');
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size < 1 || stat.size > 8 * 1024 * 1024) return 'unknown';
          const bytes = Buffer.alloc(stat.size + 1);
          const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
          if (bytesRead !== stat.size || (await file.stat()).size !== stat.size) return 'unknown';
          const text = bytes.subarray(0, bytesRead).toString('utf8');
          if (!text.endsWith('\n')) return 'unknown';
          const entries = text.trimEnd().split('\n');
          const seen = new Set<string>();
          for (let index = 0; index < entries.length; index++) {
            const value: unknown = JSON.parse(entries[index]!);
            if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown';
            if (index === 0) {
              if (!('type' in value) || value.type !== 'session' || !('id' in value) || typeof value.id !== 'string'
                || !value.id || !selected.endsWith(`_${value.id}.jsonl`) || !('cwd' in value) || typeof value.cwd !== 'string'
                || canonical(value.cwd) !== canonical(node.workspace?.path ?? team.projectPath)) return 'unknown';
            } else {
              if (!('id' in value) || typeof value.id !== 'string' || !value.id || seen.has(value.id)
                || !('parentId' in value) || value.parentId !== null && (typeof value.parentId !== 'string' || !seen.has(value.parentId))) return 'unknown';
              seen.add(value.id);
            }
          }
        } finally { await file.close(); }
        found = true;
      } catch { return 'unknown'; }
      finally { await directory.close().catch(() => undefined); }
      if (found) break;
    }
    if (!found) return 'missing';
  }
  return 'ok';
}

function canonical(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function safeDirectoryKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export function agentTeamStorageRoots(dataRoot?: string): string[] {
  const legacy = path.join(os.homedir(), '.pi', 'fateGUI', 'agent-teams');
  const configured = process.env.FATE_GUI_DATA_DIR?.trim();
  const primary = dataRoot ?? (configured ? path.join(path.resolve(configured), 'agent-teams') : legacy);
  return dataRoot === undefined && configured ? [...new Set([primary, legacy])] : [primary];
}

/** A missing child transcript is not recoverable from the parent's metadata snapshot.
 * Keep history if storage cannot be inspected (for example, access is denied).
 * Only use this for inactive/cold sessions: live child sessions can own open files.
 */
export async function reconcileAgentTeamHistory(team: AgentTeam, roots: readonly string[]): Promise<AgentTeam | null> {
  const children = team.nodes.filter((node) => node.depth > 0);
  if (!children.length) return team;
  const missing = new Set<string>();
  for (const node of children) {
    const relative = path.join(safeDirectoryKey(team.rootSessionId), safeDirectoryKey(team.id), safeDirectoryKey(node.id));
    let found = false;
    let unknown = false;
    for (const root of roots) {
      try {
        if ((await fs.readdir(path.join(root, relative))).some((file) => file.endsWith('.jsonl'))) { found = true; break; }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unknown = true;
      }
    }
    if (!found && !unknown) missing.add(node.id);
  }
  if (!missing.size) return team;
  // A descendant without its parent is not an actionable agent either.
  for (const node of children.sort((a, b) => a.depth - b.depth)) {
    if (node.parentNodeId && missing.has(node.parentNodeId)) missing.add(node.id);
  }
  const tasks = team.tasks.filter((task) => !missing.has(task.assigneeNodeId) && !missing.has(task.requesterNodeId));
  const taskIds = new Set(tasks.map((task) => task.id));
  const nodes = team.nodes.filter((node) => !missing.has(node.id)).map((node) => ({
    ...node, childIds: node.childIds.filter((id) => !missing.has(id)),
    ...(node.currentTaskId && !taskIds.has(node.currentTaskId) ? { currentTaskId: undefined } : {}),
  }));
  if (nodes.length === 1) return null;
  const envelopes = team.envelopes.filter((envelope) => !missing.has(envelope.authorNodeId) && !missing.has(envelope.recipientNodeId) && (!envelope.taskId || taskIds.has(envelope.taskId)));
  const envelopeIds = new Set(envelopes.map((envelope) => envelope.id));
  const retainedIds = new Set([...nodes.map((node) => node.id), ...taskIds, ...envelopeIds, team.id]);
  return {
    ...team, nodes, tasks, envelopes,
    operationReceipts: team.operationReceipts.filter((receipt) => retainedIds.has(receipt.entityId)),
    timeline: team.timeline.filter((event) => (!event.nodeId || !missing.has(event.nodeId)) && (!event.taskId || taskIds.has(event.taskId)) && (!event.envelopeId || envelopeIds.has(event.envelopeId))),
    usage: nodes.reduce((usage, node) => addUsage(usage, node.usage), emptyUsage()),
  };
}
