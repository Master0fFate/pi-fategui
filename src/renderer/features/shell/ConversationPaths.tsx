import { GitBranchPlus, GitFork, LoaderCircle, MoreHorizontal } from 'lucide-react';
import * as Popover from '@radix-ui/react-popover';
import { AppTooltip } from '../../components/AppTooltip';
import type { SessionBranch } from '../../../shared/contracts/ipc';

const genericLabels = new Set(['branch', 'current', 'custom', 'message']);

export interface ConversationPathView {
  branch: SessionBranch;
  /** A meaningful user/authored label, or null if the branch only has a generic one. */
  label: string | null;
  /** The fork's own content (last message / checkpoint preview). */
  description: string;
}

function meaningfulLabel(label: string | undefined): string | null {
  const normalized = label?.replace(/\s+/gu, ' ').trim();
  if (!normalized || genericLabels.has(normalized.toLocaleLowerCase())) return null;
  return normalized;
}

function isWorktreePath(branch: SessionBranch): boolean {
  const kind = branch.kind.toLocaleLowerCase();
  return kind.includes('worktree') || kind.includes('isolated');
}

/**
 * Forks only. The active branch IS the main session and is already rendered as
 * the session row above — it is never duplicated here. Generic labels are never
 * surfaced as fake "Alternate path N" titles.
 */
export function conversationPathViews(branches: readonly SessionBranch[], limit = 20): ConversationPathView[] {
  return branches
    .filter((branch) => !branch.active)
    .slice(-limit)
    .map((branch) => ({
      branch,
      label: meaningfulLabel(branch.label),
      description: branch.preview || 'Saved fork',
    }));
}

export type ForkAction = 'rename' | 'compact';

interface ConversationPathsProps {
  branches: readonly SessionBranch[];
  busy: boolean;
  pendingId: string | null;
  onSelect: (branch: SessionBranch) => void;
  /** Per-fork actions. The Sidebar navigates to the fork first, then runs the action. */
  onAction?: (branch: SessionBranch, action: ForkAction) => void;
  actionDisabled?: boolean;
  compact?: boolean;
}

export function ConversationPaths({ branches, busy, pendingId, onSelect, onAction, actionDisabled, compact = false }: ConversationPathsProps) {
  const paths = conversationPathViews(branches);
  const totalForks = branches.filter((branch) => !branch.active).length;
  if (paths.length === 0) return null;
  return (
    <div className={`session-path-list${compact ? ' session-path-list--compact' : ''}`} role="list" aria-label="Conversation paths">
      {paths.map(({ branch, label, description }) => {
        const worktree = isWorktreePath(branch);
        const Icon = worktree ? GitBranchPlus : GitFork;
        const name = label ?? description;
        const pending = pendingId === branch.id;
        return (
          <div key={branch.id} role="listitem" className="session-row session-row--path">
            <button
              className="session-path-open"
              type="button"
              disabled={busy}
              aria-label={`Switch to fork: ${name}`}
              title="Switch to this fork. Your current session stays saved."
              onClick={() => onSelect(branch)}
            >
              <span className="session-path-icon">{pending ? <LoaderCircle className="tool-spinner" size={12} aria-hidden="true" /> : <Icon size={12} aria-hidden="true" />}</span>
              <span className="session-path-copy">
                <span className="session-path-name">{name}</span>
                {label ? <small>{description}</small> : null}
              </span>
            </button>
            {onAction && (
              <SessionPathMenu branch={branch} name={name} disabled={busy || actionDisabled === true} onAction={onAction} />
            )}
          </div>
        );
      })}
      {totalForks > paths.length && <small className="session-path-overflow">Showing {paths.length} of {totalForks} forks</small>}
    </div>
  );
}

function SessionPathMenu({ branch, name, disabled, onAction }: { branch: SessionBranch; name: string; disabled: boolean; onAction: (branch: SessionBranch, action: ForkAction) => void }) {
  // Forks are in-session branches: only rename + compact apply. Clone / fork /
  // isolated-worktree are intentionally omitted (no infinite nesting), and
  // delete is omitted because removing a branch would delete the whole session.
  return (
    <Popover.Root>
      <AppTooltip content="Session actions">
        <Popover.Trigger asChild>
          <button className="session-menu-trigger" type="button" aria-label={`Actions for ${name}`} disabled={disabled}><MoreHorizontal size={14} /></button>
        </Popover.Trigger>
      </AppTooltip>
      <Popover.Portal>
        <Popover.Content className="session-action-menu" side="top" align="end" sideOffset={6} onOpenAutoFocus={(event) => event.preventDefault()}>
          <button type="button" role="menuitem" className="folder-action-item" disabled={disabled} onClick={() => onAction(branch, 'rename')}>Rename fork</button>
          <button type="button" role="menuitem" className="folder-action-item" disabled={disabled} onClick={() => onAction(branch, 'compact')}>Compact fork context</button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
