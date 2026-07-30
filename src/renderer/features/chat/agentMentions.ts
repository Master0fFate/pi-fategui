import type { SubagentRun } from '../../../shared/contracts/ipc';
import { subagentDisplayName, subagentHandle } from '../../../shared/subagentIdentity';

export interface AgentMentionContext {
  query: string;
  start: number;
  end: number;
}

export interface AgentStopCommand {
  target: string;
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
  const match = /(^|\s)@([a-z0-9-]*)$/iu.exec(beforeCaret);
  if (!match) return null;
  const before = match[2] ?? '';
  const start = boundedCaret - before.length - 1;
  const after = /^[a-z0-9-]*/iu.exec(draft.slice(boundedCaret))?.[0] ?? '';
  return { query: `${before}${after}`.toLocaleLowerCase(), start, end: boundedCaret + after.length };
}

export function findAgentMentions(runs: readonly SubagentRun[], query: string, limit = 8): SubagentRun[] {
  const normalized = query.trim().replace(/^@/u, '').toLocaleLowerCase();
  return runs
    .map((run, index) => {
      const handle = subagentHandle(run);
      const name = subagentDisplayName(run).toLocaleLowerCase();
      const task = run.task.toLocaleLowerCase();
      const score = !normalized
        ? 1
        : handle === normalized ? 100
          : handle.startsWith(normalized) ? 90
            : name.startsWith(normalized) ? 80
              : handle.includes(normalized) ? 70
                : name.includes(normalized) ? 60
                  : task.includes(normalized) ? 30
                    : -1;
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

export function parseAgentStopCommand(text: string): AgentStopCommand | null {
  const normalized = text.trim();
  const stopFirst = /^@stop\s+(all|@[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/iu.exec(normalized);
  if (stopFirst?.[1]) return { target: stopFirst[1].toLocaleLowerCase() };
  const targetFirst = /^(@[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\s+stop$/iu.exec(normalized);
  return targetFirst?.[1] ? { target: targetFirst[1].toLocaleLowerCase() } : null;
}
