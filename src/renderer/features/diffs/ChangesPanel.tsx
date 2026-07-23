import { ExternalLink, FileDiff, FileWarning, GitBranch, RefreshCw } from 'lucide-react';
import { Virtuoso } from 'react-virtuoso';
import type { GitChange } from '../../../shared/contracts/ipc';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { LazyDiffViewer } from '../files/LazyMonaco';

function statusLabel(change: GitChange): string {
  const status = change.workTreeStatus !== ' ' ? change.workTreeStatus : change.indexStatus;
  return ({ M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', U: 'U', '?': 'U', '!': 'I' } as Record<string, string>)[status] ?? status;
}

function ChangeRow({ change, selected, onSelect }: { change: GitChange; selected: boolean; onSelect: () => void }) {
  return (
    <button className={`change-row${selected ? ' selected' : ''}`} type="button" onClick={onSelect} title={change.path}>
      <span className={`change-kind change-kind--${statusLabel(change).toLowerCase()}`}>{statusLabel(change)}</span>
      <span className="change-path">{change.oldPath && <small>{change.oldPath} → </small>}{change.path}</span>
      <span className="change-counts">
        {change.binary ? <em>binary</em> : <><b>+{change.additions ?? '—'}</b><i>−{change.deletions ?? '—'}</i></>}
      </span>
    </button>
  );
}

function DiffPreview() {
  const diff = useWorkspaceStore((state) => state.diff);
  const loading = useWorkspaceStore((state) => state.diffLoading);
  const selected = useWorkspaceStore((state) => state.selectedChange);
  const openPath = useWorkspaceStore((state) => state.openPath);
  const git = useWorkspaceStore((state) => state.git);
  const selectedStatus = git?.changes.find((change) => change.path === selected);
  const deleted = selectedStatus?.indexStatus === 'D' || selectedStatus?.workTreeStatus === 'D';
  if (loading) return <div className="preview-loading"><span className="preview-spinner" />Building bounded diff…</div>;
  if (!diff) return <div className="preview-placeholder"><FileDiff size={22} /><span>Select a changed file to inspect</span></div>;
  return (
    <div className="file-preview">
      <div className="preview-heading">
        <span title={diff.path}>{diff.path}</span>
        {!deleted && diff.state === 'text' && diff.openable && <button type="button" onClick={() => void openPath(diff.path)} title="Open in the system editor"><ExternalLink size={13} />Open</button>}
      </div>
      <div className="preview-body">
        {diff.state === 'text' && <LazyDiffViewer original={diff.original ?? ''} modified={diff.modified ?? ''} language={diff.language} path={diff.path} />}
        {diff.state !== 'text' && <div className="preview-placeholder"><FileWarning size={22} /><strong>{diff.state === 'binary' ? 'Binary change' : diff.state === 'large' ? 'Diff too large' : 'Diff unavailable'}</strong><span>{diff.message ?? 'This change cannot be displayed.'}</span></div>}
      </div>
    </div>
  );
}

export function ChangesPanel() {
  const project = useWorkspaceStore((state) => state.projectPath);
  const git = useWorkspaceStore((state) => state.git);
  const loading = useWorkspaceStore((state) => state.gitLoading);
  const selected = useWorkspaceStore((state) => state.selectedChange);
  const error = useWorkspaceStore((state) => state.error);
  const refresh = useWorkspaceStore((state) => state.refreshGit);
  const select = useWorkspaceStore((state) => state.selectChange);

  if (!project) return <div className="inspector-empty"><FileDiff size={24} /><strong>No changes</strong><p>Open a project to inspect Git changes.</p></div>;
  if (loading && !git) return <div className="preview-loading"><span className="preview-spinner" />Reading Git status…</div>;
  if (git && !git.repository) return <div className="inspector-empty"><GitBranch size={24} /><strong>Not a Git repository</strong><p>File browsing is available, but there is no Git status for this project.</p></div>;
  const changes = git?.changes ?? [];
  return (
    <div className="changes-panel">
      <div className="changes-summary">
        <span><GitBranch size={13} />{git?.branch || 'HEAD'} <strong>{changes.length} changed</strong></span>
        <span className="summary-counts"><b>+{git?.additions ?? 0}</b><i>−{git?.deletions ?? 0}</i><button type="button" aria-label="Refresh Git changes" onClick={() => void refresh()} disabled={loading}><RefreshCw size={13} /></button></span>
      </div>
      {error && <div className="workspace-error" role="alert">{error}</div>}
      {changes.length > 0 ? (
        <div className="changes-list" aria-label="Changed files">
          <Virtuoso
            data={changes}
            computeItemKey={(_index, change) => change.path}
            itemContent={(_index, change) => <ChangeRow change={change} selected={selected === change.path} onSelect={() => void select(change.path)} />}
          />
          {git?.truncated && <div className="bounded-note">Change list limited to 10,000 files</div>}
        </div>
      ) : <div className="mini-empty">Working tree clean</div>}
      <DiffPreview />
    </div>
  );
}
