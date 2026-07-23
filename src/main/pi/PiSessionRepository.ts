import {
  SessionManager,
  type AgentSession,
  type SessionInfo,
  type SessionTreeNode,
} from '@earendil-works/pi-coding-agent';
import type { SessionBranch, SessionSummary } from '../../shared/contracts/ipc';
import { messageText } from './PiEventNormalizer';

export interface SessionRepositorySource {
  list(cwd: string): Promise<SessionInfo[]>;
}

const sdkSource: SessionRepositorySource = {
  list: (cwd) => SessionManager.list(cwd),
};

/** Project-scoped, read-only projection of Pi's persistent JSONL session store. */
export class PiSessionRepository {
  constructor(private readonly source: SessionRepositorySource = sdkSource) {}

  async list(cwd: string, activeSessionId: string | null, query = ''): Promise<SessionSummary[]> {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const sessions = await this.source.list(cwd);
    return sessions
      .filter((session) => !normalizedQuery || [session.name, session.firstMessage, session.allMessagesText]
        .some((value) => value?.toLocaleLowerCase().includes(normalizedQuery)))
      .sort((left, right) => right.modified.getTime() - left.modified.getTime())
      .map((session) => ({
        id: session.id,
        title: session.name?.trim() || session.firstMessage.trim() || 'Untitled session',
        firstMessage: session.firstMessage,
        path: session.path,
        createdAt: session.created.toISOString(),
        modifiedAt: session.modified.toISOString(),
        messageCount: session.messageCount,
        ...(session.parentSessionPath ? { parentSessionPath: session.parentSessionPath } : {}),
        active: session.id === activeSessionId,
      }));
  }

  async resolve(cwd: string, sessionId: string): Promise<SessionSummary | undefined> {
    return (await this.list(cwd, null)).find((session) => session.id === sessionId);
  }

  branches(session: AgentSession): SessionBranch[] {
    const manager = session.sessionManager;
    if (!manager || typeof manager.getTree !== 'function') return [];
    const activePath = new Set(manager.getBranch().map((entry) => entry.id));
    const result: SessionBranch[] = [];
    const visit = (node: SessionTreeNode, depth: number) => {
      const entry = node.entry;
      const preview = entry.type === 'message'
        ? messageText(entry.message).replace(/\s+/g, ' ').trim().slice(0, 100)
        : entry.type === 'branch_summary'
          ? entry.summary.replace(/\s+/g, ' ').trim().slice(0, 100)
          : '';
      // A linear conversation is not a useful branch list. Project only
      // branch points, labeled checkpoints, and leaves while still traversing
      // the complete tree to preserve their true depth.
      if (node.children.length !== 1 || node.label) {
        result.push({
          id: entry.id,
          parentId: entry.parentId,
          depth,
          ...(node.label ? { label: node.label } : {}),
          preview,
          kind: entry.type,
          active: activePath.has(entry.id),
        });
      }
      for (const child of node.children) visit(child, depth + 1);
    };
    for (const root of manager.getTree()) visit(root, 0);
    return result;
  }
}
