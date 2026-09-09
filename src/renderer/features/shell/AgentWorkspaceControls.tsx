import * as Dialog from '@radix-ui/react-dialog';
import { ArrowUpRight, GitBranch, GitMerge, GitPullRequest, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AgentTeam, AgentTeamControlInput, AgentTeamNode } from '../../../shared/contracts/multiAgent';
import { InlineConfirm } from '../../components/InlineConfirm';
import { useRuntimeStore } from '../../stores/runtimeStore';

function useWorkspaceControl() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const control = async (input: AgentTeamControlInput): Promise<boolean> => {
    if (pendingRef.current) return false;
    const origin = useRuntimeStore.getState().runtime;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const state = await window.piDesktop.controlAgentTeam({ ...input, operationId: crypto.randomUUID() });
      const current = useRuntimeStore.getState().runtime;
      if (current.sessionId !== origin.sessionId || current.project?.path !== origin.project?.path) return false;
      useRuntimeStore.getState().setRuntime(state);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Workspace action failed. Your files have been retained.');
      return false;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  return { control, pending, error };
}

type Confirmation = 'checkpoint' | 'integrate' | 'cleanup' | null;

export function AgentWorkspaceDetails({ team, node }: { team: AgentTeam; node: AgentTeamNode }) {
  const workspace = node.workspace;
  const { control, pending, error } = useWorkspaceControl();
  const rootStreaming = useRuntimeStore((state) => state.runtime.streaming);
  const permission = useRuntimeStore((state) => state.runtime.permissionLevel);
  const [message, setMessage] = useState('');
  const [strategy, setStrategy] = useState<'ff-only' | 'cherry-pick'>('ff-only');
  const [commits, setCommits] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const review = workspace?.review;
  useEffect(() => { setCommits([]); setConfirmation(null); }, [review?.sourceHead, review?.targetHead, review?.reviewedAt]);
  const owned = workspace?.mode === 'worktree';
  const removed = workspace?.state === 'removed';
  const active = node.status === 'active' || node.status === 'creating' || node.status === 'closing';
  const readOnly = (permission ?? team.nodes.find((candidate) => candidate.id === team.rootNodeId)?.permissionLevel) === 'read-only';
  const cannotMutate = pending || active || rootStreaming || readOnly || removed;
  const targetNode = team.nodes.find((candidate) => candidate.id === node.parentNodeId);
  const directChild = node.parentNodeId === team.rootNodeId;
  const canIntegrate = directChild && !cannotMutate && Boolean(review?.targetBranch && !review.dirty && !review.targetDirty && !review.truncated && review.commits.length > 0 && (strategy === 'ff-only' || commits.length > 0));
  const act = async (operation: 'review' | 'checkpoint' | 'integrate' | 'cleanup') => {
    setNotice(null);
    const ok = await control({
      action: 'workspace', teamId: team.id, target: node.id, operation,
      ...(operation === 'checkpoint' ? { message: message.trim() } : {}),
      ...(operation === 'integrate' && review ? {
        strategy, expectedSourceHead: review.sourceHead, expectedTargetHead: review.targetHead,
        ...(strategy === 'cherry-pick' ? { commits } : {}),
      } : {}),
    });
    if (ok) {
      setConfirmation(null);
      if (operation === 'checkpoint') { setMessage(''); setNotice('Checkpoint committed in the agent worktree. Review again before integrating.'); }
      if (operation === 'integrate') setNotice('Changes integrated into the parent checkout. The agent worktree is retained.');
      if (operation === 'cleanup') setNotice('Worktree removed. Its Git branch is retained.');
    }
  };
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button type="button" className="agent-workspace-trigger" aria-label={`Workspace for ${node.displayName}`}>
          <GitBranch size={12} /><span>{owned ? removed ? 'Removed worktree' : 'Isolated worktree' : 'Shared workspace'}</span>
          {owned && workspace.branch ? <small title={workspace.branch}>{workspace.branch}</small> : null}
          <ArrowUpRight size={11} aria-hidden="true" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="agent-workspace-overlay" />
        <Dialog.Content className="agent-workspace-dialog" aria-describedby={undefined}>
          <header className="agent-workspace-dialog-header">
            <div><Dialog.Title>{node.displayName} workspace</Dialog.Title><span>{owned ? removed ? 'Removed worktree' : 'Isolated Git worktree' : 'Shared checkout'} · {node.status}</span></div>
            <Dialog.Close aria-label="Close workspace"><X size={16} /></Dialog.Close>
          </header>
      <div className="agent-workspace-body" role="region" aria-label={`${node.displayName} workspace`}>
        <dl className="agent-workspace-facts">
          <dt>Checkout</dt><dd><code>{workspace?.path ?? team.projectPath}</code></dd>
          {owned ? <><dt>Branch</dt><dd><code>{workspace.branch}</code></dd><dt>Base</dt><dd><code title={workspace.baseCommit}>{workspace.baseRef ?? 'HEAD'} · {workspace.baseCommit?.slice(0, 12)}</code></dd><dt>Integrate into</dt><dd><code>{workspace.parentPath}</code> · {targetNode?.displayName ?? 'Parent'}</dd></> : null}
        </dl>
        <p>{owned ? 'Separate checkout, not a security sandbox. Edit files stays confined here; Full access can reach other host paths and services.' : 'Files are shared with the direct parent. A child that needs isolation must be spawned in a new worktree.'}</p>
        {owned && !removed ? <>
          <div className="agent-workspace-actions">
            <button type="button" disabled={pending || active} onClick={() => void act('review')}><RefreshCw size={12} className={pending ? 'tool-spinner' : undefined} />{review ? 'Refresh review' : 'Review changes'}</button>
            <button type="button" disabled={cannotMutate || (node.status !== 'closed' && node.status !== 'released')} title="Close or release the agent first. Dirty worktrees cannot be removed." onClick={() => setConfirmation('cleanup')}><Trash2 size={12} />Remove worktree</button>
          </div>
          {active ? <p>Stop this agent and any agents sharing its checkout before reviewing or changing the workspace.</p> : null}
          {rootStreaming ? <p>Integration and cleanup are unavailable while the parent is running.</p> : null}
          {!directChild ? <p>Only this agent’s direct parent can checkpoint or integrate its work. You can review it here and remove the checkout after closing it.</p> : null}
          {review ? <div className="agent-workspace-review">
            <strong>{review.truncated ? 'Incomplete review' : review.dirty ? 'Uncommitted work' : `${review.commits.length} commit${review.commits.length === 1 ? '' : 's'} to review`}</strong>
            <dl className="agent-workspace-facts"><dt>Source HEAD</dt><dd><code>{review.sourceHead.slice(0, 12)}</code></dd><dt>Parent HEAD</dt><dd><code>{review.targetBranch ?? 'Detached HEAD'} · {review.targetHead.slice(0, 12)}</code></dd></dl>
            {review.targetDirty ? <p className="agent-workspace-warning">Parent checkout has uncommitted changes. Commit or stash them before integration.</p> : null}
            {review.truncated ? <p className="agent-workspace-warning">This review is incomplete or exceeds the display limit. Inspect the listed files locally, or checkpoint uncommitted work and refresh. Integration is disabled.</p> : null}
            <pre aria-label="Workspace diff" tabIndex={0}>{review.diff || 'No text diff. Check commit and file status before integrating.'}</pre>
            {review.dirty ? <>
              <label>Checkpoint message<input value={message} maxLength={500} placeholder="Describe the agent’s changes" disabled={cannotMutate} onChange={(event) => setMessage(event.target.value)} /></label>
              <p>A checkpoint commits the worktree’s changes locally. It does not modify the parent checkout.</p>
              <div className="agent-workspace-actions"><button type="button" disabled={cannotMutate || !directChild || !message.trim()} onClick={() => setConfirmation('checkpoint')}><Save size={12} />Commit checkpoint</button></div>
            </> : null}
            {review.commits.length ? <>
              <label>Integration method<select value={strategy} disabled={cannotMutate} onChange={(event) => { setStrategy(event.target.value as 'ff-only' | 'cherry-pick'); setConfirmation(null); }}><option value="ff-only">Fast-forward only</option><option value="cherry-pick">Cherry-pick selected commits</option></select></label>
              <div className="agent-workspace-commits" aria-label="Workspace commits">{review.commits.map((commit) => <label key={commit.hash}>
                {strategy === 'cherry-pick' ? <input type="checkbox" aria-label={`Select commit ${commit.hash.slice(0, 12)}`} checked={commits.includes(commit.hash)} disabled={cannotMutate} onChange={(event) => setCommits((current) => event.target.checked ? [...current, commit.hash] : current.filter((hash) => hash !== commit.hash))} /> : <GitPullRequest size={12} />}
                <span><code>{commit.hash.slice(0, 8)}</code> {commit.subject}</span>
              </label>)}</div>
              <p>{strategy === 'ff-only' ? 'Advance the parent only if its history has not diverged. No merge commit is created.' : 'Apply only selected commits, in source history order. Conflicts stop integration.'} Both HEADs are checked again before changing files.</p>
              <div className="agent-workspace-actions"><button type="button" className="agent-workspace-primary" disabled={!canIntegrate} onClick={() => setConfirmation('integrate')}><GitMerge size={12} />Integrate changes</button></div>
            </> : null}
          </div> : null}
        </> : null}
        {notice ? <p role="status" className="agent-workspace-success">{notice}</p> : null}
        {error ? <p className="agent-workspace-error" role="alert">{error}</p> : null}
        {confirmation ? <InlineConfirm
          title={confirmation === 'cleanup' ? `Remove ${node.displayName} worktree?` : confirmation === 'checkpoint' ? 'Commit agent changes?' : `Integrate into ${targetNode?.displayName ?? 'parent'}?`}
          message={confirmation === 'cleanup' ? 'Removes only this clean, inactive checkout. The branch and agent history stay available. This cannot be undone.' : confirmation === 'checkpoint' ? 'All current worktree changes will be committed locally with your message. The parent checkout stays untouched.' : `Apply the reviewed ${strategy === 'ff-only' ? 'branch' : `${commits.length} selected commit(s)`} to ${workspace?.parentPath}. Stale reviews and dirty checkouts are refused.`}
          confirmLabel={confirmation === 'cleanup' ? 'Remove worktree' : confirmation === 'checkpoint' ? 'Commit checkpoint' : 'Integrate'}
          busy={pending || (confirmation === 'integrate' ? !canIntegrate : cannotMutate)}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => void act(confirmation)}
        /> : null}
      </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
