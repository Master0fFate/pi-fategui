import { ArrowRight, Check, GitFork, LoaderCircle } from 'lucide-react';
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

interface ConversationPathsProps {
  branches: readonly SessionBranch[];
  busy: boolean;
  pendingId: string | null;
  onSelect: (branch: SessionBranch) => void;
  height: number;
}

export function ConversationPaths({ branches, busy, pendingId, onSelect, height }: ConversationPathsProps) {
  const paths = conversationPathViews(branches);
  return (
    <section className="conversation-paths" aria-label="Conversation paths" style={{ flexBasis: height }}>
      <header>
        <strong>Conversation paths</strong>
        <small>{branches.length} saved</small>
      </header>
      <div className="conversation-path-list" role="list">
        {paths.map(({ branch, title, description }) => branch.active ? (
          <div key={branch.id} className="conversation-path-row conversation-path-row--active" role="listitem" aria-current="true" title={`${title}: ${description}`}>
            <span className="conversation-path-icon"><Check size={12} aria-hidden="true" /></span>
            <span className="conversation-path-copy"><strong>{title}</strong><small>{description}</small></span>
            <span className="conversation-path-state">Active</span>
          </div>
        ) : (
          <div key={branch.id} role="listitem">
            <button
              className="conversation-path-row"
              type="button"
              disabled={busy}
              aria-label={`Switch to ${title}: ${description}`}
              title={`Switch to ${title}. Your current path stays saved.`}
              onClick={() => onSelect(branch)}
            >
              <span className="conversation-path-icon"><GitFork size={12} aria-hidden="true" /></span>
              <span className="conversation-path-copy"><strong>{title}</strong><small>{description}</small></span>
              <span className="conversation-path-action">{pendingId === branch.id ? <LoaderCircle className="tool-spinner" size={12} aria-hidden="true" /> : <ArrowRight size={12} aria-hidden="true" />}</span>
            </button>
          </div>
        ))}
      </div>
      {branches.length > paths.length ? <small className="conversation-path-overflow">Showing the current and {paths.length - 1} most recent alternatives</small> : null}
    </section>
  );
}
