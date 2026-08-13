import { Copy, GitBranchPlus, GitFork, LoaderCircle, MoreHorizontal, Pencil, Shrink, Trash2 } from 'lucide-react';
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

export type ForkAction = 'fork' | 'worktree' | 'clone' | 'compact' | 'rename' | 'delete';

interface ConversationPathsProps {
  branches: readonly SessionBranch[];
  busy: boolean;
  pendingId: string | null;
  onSelect: (branch: SessionBranch) => void;
  /** Per-fork actions. The Sidebar navigates to a fork before actions that need its live runtime. */
  onAction?: (branch: SessionBranch, action: ForkAction) => void;
  actionDisabled?: boolean;
  confirmingDeleteId?: string | null;
  onCancelDelete?: () => void;
  compact?: boolean;
}

export function ConversationPaths({ branches, busy, pendingId, onSelect, onAction, actionDisabled, confirmingDeleteId, onCancelDelete, compact = false }: ConversationPathsProps) {
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
            {onAction && (confirmingDeleteId === branch.id ? (
              <div className="session-path-delete-confirm" role="group" aria-label={`Confirm deleting fork: ${name}`}>
                <span>Delete fork?</span>
                <button type="button" className="session-path-delete-confirm-danger" disabled={busy || actionDisabled === true} onClick={() => onAction(branch, 'delete')}>Delete</button>
                <button type="button" disabled={busy || actionDisabled === true} onClick={onCancelDelete}>Cancel</button>
              </div>
            ) : (
              <SessionPathMenu branch={branch} name={name} disabled={busy || actionDisabled === true} onAction={onAction} />
            ))}
          </div>
        );
      })}
      {totalForks > paths.length && <small className="session-path-overflow">Showing {paths.length} of {totalForks} forks</small>}
    </div>
  );
}

function SessionPathMenu({ branch, name, disabled, onAction }: { branch: SessionBranch; name: string; disabled: boolean; onAction: (branch: SessionBranch, action: ForkAction) => void }) {
  const actions: Array<{ key: ForkAction; label: string; icon: typeof GitFork; danger?: boolean }> = [
    { key: 'fork', label: 'Branch from latest prompt', icon: GitFork },
    { key: 'worktree', label: 'Create isolated Git worktree', icon: GitBranchPlus },
    { key: 'clone', label: 'Clone session', icon: Copy },
    { key: 'compact', label: 'Compact session context', icon: Shrink },
    { key: 'rename', label: 'Rename session', icon: Pencil },
    { key: 'delete', label: 'Delete fork', icon: Trash2, danger: true },
  ];
  return (
    <Popover.Root>
      <AppTooltip content="Session actions">
        <Popover.Trigger asChild>
          <button className="session-menu-trigger" type="button" aria-label={`Actions for ${name}`} disabled={disabled}><MoreHorizontal size={14} /></button>
        </Popover.Trigger>
      </AppTooltip>
      <Popover.Portal>
        <Popover.Content className="session-action-menu session-action-menu--fork" role="menu" aria-label={`Actions for fork: ${name}`} side="top" align="end" sideOffset={6} onOpenAutoFocus={(event) => event.preventDefault()}>
          <div className="session-row-actions session-row-actions--menu" role="none">
            {actions.map((action) => {
              const Icon = action.icon;
              return (
                <AppTooltip key={action.key} content={action.label} wrapTrigger>
                  <button type="button" role="menuitem" className={action.danger ? 'session-delete-button' : undefined} aria-label={`${action.label} for ${name}`} disabled={disabled} onClick={() => onAction(branch, action.key)}><Icon size={12} /></button>
                </AppTooltip>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
