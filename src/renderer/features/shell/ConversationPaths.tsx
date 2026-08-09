import { ArrowRight, Check, GitBranchPlus, GitFork, LoaderCircle } from 'lucide-react';
import type { SessionBranch } from '../../../shared/contracts/ipc';

const genericLabels = new Set(['branch', 'current', 'custom', 'message']);

export interface ConversationPathView {
  branch: SessionBranch;
  title: string;
  description: string;
}

function meaningfulLabel(label: string | undefined): string | null {
  const normalized = label?.replace(/\s+/gu, ' ').trim();
  if (!normalized || genericLabels.has(normalized.toLocaleLowerCase())) return null;
  return normalized;
}

export function conversationPathViews(branches: readonly SessionBranch[], limit = 20): ConversationPathView[] {
  const active = branches.find((branch) => branch.active);
  const inactive = branches.filter((branch) => !branch.active);
  const visible = active
    ? [active, ...inactive.slice(-(Math.max(1, limit) - 1))]
    : inactive.slice(-Math.max(1, limit));
  let alternate = 0;
  return visible.map((branch) => {
    if (branch.active) {
      return {
        branch,
        title: 'Current path',
        description: branch.preview || meaningfulLabel(branch.label) || 'The conversation shown in the workspace',
      };
    }
    alternate += 1;
    return {
      branch,
      title: meaningfulLabel(branch.label) || `Alternate path ${alternate}`,
      description: branch.preview || 'Saved conversation checkpoint',
    };
  });
}

function isWorktreePath(branch: SessionBranch): boolean {
  const kind = branch.kind.toLocaleLowerCase();
  return kind.includes('worktree') || kind.includes('isolated');
}

interface ConversationPathsProps {
  branches: readonly SessionBranch[];
  busy: boolean;
  pendingId: string | null;
  onSelect: (branch: SessionBranch) => void;
  compact?: boolean;
}

export function ConversationPaths({ branches, busy, pendingId, onSelect, compact = false }: ConversationPathsProps) {
  const paths = conversationPathViews(branches);
  return (
    <div className={`session-path-list${compact ? ' session-path-list--compact' : ''}`} role="list" aria-label="Conversation paths">
      {paths.map(({ branch, title, description }) => {
        const worktree = isWorktreePath(branch);
        const Icon = branch.active ? Check : worktree ? GitBranchPlus : GitFork;
        const kindLabel = branch.active ? 'Active' : worktree ? 'Worktree' : 'Fork';
        const content = (
          <>
            <span className="session-path-icon"><Icon size={branch.active ? 11 : 12} aria-hidden="true" /></span>
            <span className="session-path-copy">
              <strong>{title}</strong>
              <small>{description}</small>
            </span>
            <span className="session-path-kind">{kindLabel}</span>
            {!branch.active && (
              <span className="session-path-action">
                {pendingId === branch.id ? <LoaderCircle className="tool-spinner" size={13} aria-hidden="true" /> : <ArrowRight size={13} aria-hidden="true" />}
              </span>
            )}
          </>
        );
        return branch.active ? (
          <div key={branch.id} className="session-row session-row--path active" role="listitem" aria-current="true" title={`${title}: ${description}`}>
            {content}
          </div>
        ) : (
          <div key={branch.id} role="listitem">
            <button
              className="session-row session-row--path"
              type="button"
              disabled={busy}
              aria-label={`Switch to ${title}: ${description}`}
              title={`Switch to ${title}. Your current path stays saved.`}
              onClick={() => onSelect(branch)}
            >
              {content}
            </button>
          </div>
        );
      })}
      {branches.length > paths.length && <small className="session-path-overflow">Showing {paths.length} of {branches.length} conversation paths</small>}
    </div>
  );
}
