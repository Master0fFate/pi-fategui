import type { SessionSummary, SubagentRun } from '../../../shared/contracts/ipc';
import type { AgentTeam, AgentTeamNode } from '../../../shared/contracts/multiAgent';
import { subagentDisplayName, subagentHandle } from '../../../shared/subagentIdentity';

export interface AgentMentionContext {
  symbol: '@' | '~';
  query: string;
  start: number;
  end: number;
}

export interface AgentStopCommand {
  target: string;
}

export type LiveAgentMention =
  | { kind: 'subagent'; id: string; handle: string; displayName: string; status: SubagentRun['status']; task: string; active: boolean; canReceive: boolean }
  | { kind: 'team-node'; id: string; teamId: string; handle: string; displayName: string; status: AgentTeamNode['status']; task: string; active: boolean; canReceive: boolean }
  | { kind: 'session'; id: string; handle: string; displayName: string; status: string; task: string; active: boolean; canReceive: boolean };

/** Handle for a live session mention, derived from its title. */
export function sessionMentionHandle(title: string, sessionId: string): string {
  const slug = title.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 28);
  return slug || `session-${sessionId.slice(0, 8)}`;
}

const activeRank: Record<SubagentRun['status'], number> = {
  running: 0,
  queued: 1,
  blocked: 2,
  completed: 3,
  error: 4,
  'timed-out': 5,
  'budget-exceeded': 6,
  cancelled: 7,
  skipped: 8,
  interrupted: 9,
};

export function agentMentionContext(draft: string, caret: number): AgentMentionContext | null {
  const boundedCaret = Math.max(0, Math.min(draft.length, caret));
  const beforeCaret = draft.slice(0, boundedCaret);
  const match = /(^|\s)([@~])([a-z0-9-]*)$/iu.exec(beforeCaret);
  if (!match || (match[2] !== '@' && match[2] !== '~')) return null;
  const before = match[3] ?? '';
  const start = boundedCaret - before.length - 1;
  const after = /^[a-z0-9-]*/iu.exec(draft.slice(boundedCaret))?.[0] ?? '';
  return { symbol: match[2], query: `${before}${after}`.toLocaleLowerCase(), start, end: boundedCaret + after.length };
}

export function findAgentMentions(runs: readonly SubagentRun[], query: string, limit = 8): SubagentRun[] {
  const normalized = query.trim().replace(/^@/u, '').toLocaleLowerCase();
  return runs
    .map((run, index) => {
      const handle = subagentHandle(run);
      const name = subagentDisplayName(run).toLocaleLowerCase();
      const task = run.task.toLocaleLowerCase();
      const score = mentionScore(normalized, handle, name, task);
      return { run, index, score };
    })
    .filter((candidate) => candidate.score >= 0)
    .sort((left, right) => left.run.parentSessionId.localeCompare(right.run.parentSessionId)
      || activeRank[left.run.status] - activeRank[right.run.status]
      || right.score - left.score
      || right.run.updatedAt - left.run.updatedAt
      || left.index - right.index)
    .slice(0, Math.max(0, limit))
    .map(({ run }) => run);
}

function mentionScore(query: string, handle: string, name: string, task: string): number {
  if (!query) return 1;
  if (handle === query) return 100;
  if (handle.startsWith(query)) return 90;
  if (name.startsWith(query)) return 80;
  if (handle.includes(query)) return 70;
  if (name.includes(query)) return 60;
  return task.includes(query) ? 30 : -1;
}

function teamNodeTask(team: AgentTeam, node: AgentTeamNode): string {
  return node.currentTaskId ? team.tasks.find((task) => task.id === node.currentTaskId)?.summary ?? node.path : node.path;
}

export function findLiveAgentMentions(
  runs: readonly SubagentRun[],
  teams: readonly AgentTeam[],
  sessions: readonly SessionSummary[],
  activeSessionId: string | null,
  query: string,
  limit = 8,
  symbol?: '@' | '~',
): LiveAgentMention[] {
  const normalized = query.trim().replace(/^[@~]/u, '').toLocaleLowerCase();
  const candidates: Array<LiveAgentMention & { score: number; index: number }> = [];
  if (symbol !== '~') {
    for (const [index, run] of runs.entries()) {
      const handle = subagentHandle(run);
      const displayName = subagentDisplayName(run);
      const active = run.status === 'running' || run.status === 'queued';
      const canReceive = run.status === 'running' || run.mailbox.state === 'available';
      const score = mentionScore(normalized, handle, displayName.toLocaleLowerCase(), run.task.toLocaleLowerCase());
      if (score >= 0 && canReceive) candidates.push({ kind: 'subagent', id: run.id, handle, displayName, status: run.status, task: run.task, active, canReceive, score, index });
    }
  }
  let index = runs.length;
  if (symbol !== '~') {
    for (const team of teams) {
      if (team.status === 'closed' || team.status === 'released') continue;
      for (const node of team.nodes) {
        if (node.depth === 0 || node.status === 'closed' || node.status === 'released' || node.status === 'failed' || node.status === 'interrupted') continue;
        const task = teamNodeTask(team, node);
        const active = node.status === 'active' || node.status === 'creating';
        const score = mentionScore(normalized, node.handle.toLocaleLowerCase(), node.displayName.toLocaleLowerCase(), task.toLocaleLowerCase());
        if (score >= 0) candidates.push({ kind: 'team-node', id: node.id, teamId: team.id, handle: node.handle, displayName: node.displayName, status: node.status, task, active, canReceive: true, score, index: index++ });
      }
    }
  }
  // Saved main sessions can receive a direct message. A cold session is
  // resumed in a background Pi runtime when the message is sent.
  // The active session is excluded — the composer already sends to it directly.
  if (symbol !== '@') for (const session of sessions) {
    if (session.id === activeSessionId || session.path.startsWith('live:')) continue;
    const displayName = session.title || 'Untitled session';
    const handle = sessionMentionHandle(displayName, session.id);
    const active = session.attention === 'running';
    const score = mentionScore(normalized, handle, displayName.toLocaleLowerCase(), (session.firstMessage ?? '').toLocaleLowerCase());
    if (score >= 0) candidates.push({ kind: 'session', id: session.id, handle, displayName, status: session.attention ?? 'saved', task: session.firstMessage ?? 'Saved session', active, canReceive: true, score, index: index++ });
  }
  return candidates
    .sort((left, right) => Number(right.active) - Number(left.active) || right.score - left.score || left.displayName.localeCompare(right.displayName) || left.index - right.index)
    .slice(0, Math.max(0, limit))
    .map(({ score: _score, index: _index, ...mention }) => mention);
}

export function parseAgentStopCommand(text: string): AgentStopCommand | null {
  const normalized = text.trim();
  const stopFirst = /^@stop\s+(all|@[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/iu.exec(normalized);
  if (stopFirst?.[1]) return { target: stopFirst[1].toLocaleLowerCase() };
  const targetFirst = /^(@[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\s+stop$/iu.exec(normalized);
  return targetFirst?.[1] ? { target: targetFirst[1].toLocaleLowerCase() } : null;
}
